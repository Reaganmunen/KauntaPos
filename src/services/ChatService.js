'use strict';

/**
 * Customer <-> shop chat. A shopper starts a thread from the storefront (no account); the browser
 * keeps a secret token, and only its sha256 is stored. Staff reply from the Customer chats page.
 * All queries run inside run(req, ...) so Row Level Security keeps every shop's chats apart.
 */
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const MpesaService = require('./MpesaService');

const MAX_BODY = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const preview = (body) => body.replace(/\s+/g, ' ').slice(0, 120);

/** Trims, strips control characters, and enforces length. Returns the clean text. */
function cleanBody(value) {
  const body = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!body) throw ApiError.unprocessable('Type a message first', undefined, 'empty_message');
  if (body.length > MAX_BODY) throw ApiError.unprocessable(`Messages can be up to ${MAX_BODY} characters`, undefined, 'message_too_long');
  return body;
}

const publicMessage = (m) => ({
  seq: m.seq,
  sender: m.sender,
  staff_name: m.sender === 'staff' ? m.staff_name || null : null,
  body: m.body,
  product_slug: m.product_slug,
  product_name: m.product_name,
  created_at: m.created_at,
});

// A product the shopper is asking about: only a real, online product's name is stored (never trusted from the browser).
async function productContext(db, slug) {
  if (!slug || typeof slug !== 'string' || slug.length > 200) return { product_slug: null, product_name: null };
  const { rows } = await db.query(
    'SELECT slug, name FROM products WHERE slug = $1 AND deleted_at IS NULL AND is_active AND is_online LIMIT 1',
    [slug]
  );
  return rows[0] ? { product_slug: rows[0].slug, product_name: rows[0].name } : { product_slug: null, product_name: null };
}

async function addMessage(db, thread, { sender, body, staff, ctx = {} }) {
  const { rows: [msg] } = await db.query(
    `INSERT INTO chat_messages (tenant_id, thread_id, sender, staff_user_id, staff_name, body, product_slug, product_name)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [thread.id, sender, staff ? staff.id : null, staff ? staff.name : null, body, ctx.product_slug || null, ctx.product_name || null]
  );
  await db.query(
    `UPDATE chat_threads
        SET last_message_at = now(), last_message_preview = $2, last_sender = $3, updated_at = now(),
            status = 'open',
            unread_staff    = unread_staff    + CASE WHEN $3 = 'customer' THEN 1 ELSE 0 END,
            unread_customer = unread_customer + CASE WHEN $3 = 'staff'    THEN 1 ELSE 0 END
      WHERE id = $1`,
    [thread.id, preview(body), sender]
  );
  return msg;
}

// ---------------- shopper side ----------------

async function threadByToken(db, token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const { rows } = await db.query('SELECT * FROM chat_threads WHERE token_hash = $1', [hash(token)]);
  return rows[0] || null;
}

/** input: { name, phone, email, message, product_slug } -> { token, thread, messages } */
async function startThread(db, input) {
  const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (name.length < 2) throw ApiError.unprocessable('Please tell us your name', undefined, 'name_required');

  let phone = null;
  if (input.phone) {
    phone = MpesaService.normalisePhone(input.phone);
    if (!phone) throw ApiError.unprocessable('Enter a valid phone number, e.g. 0712 345 678', undefined, 'invalid_phone');
  }
  const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 160) : null;
  if (email && !EMAIL_RE.test(email)) throw ApiError.unprocessable('Enter a valid email address', undefined, 'invalid_email');
  if (!phone && !email) throw ApiError.unprocessable('Add a phone number so the shop can reach you', undefined, 'contact_required');

  const body = cleanBody(input.message);
  const ctx = await productContext(db, input.product_slug);

  const token = crypto.randomBytes(24).toString('hex');
  const { rows: [thread] } = await db.query(
    `INSERT INTO chat_threads (tenant_id, token_hash, customer_name, customer_phone, customer_email)
     VALUES (current_tenant_id(), $1, $2, $3, $4) RETURNING *`,
    [hash(token), name, phone, email]
  );
  await addMessage(db, thread, { sender: 'customer', body, ctx });
  const out = { token, ...(await shopperView(db, thread.id, 0)) };
  return withNotify(out, thread, body);
}

async function shopperView(db, threadId, afterSeq) {
  const { rows: [thread] } = await db.query('SELECT id, customer_name, status FROM chat_threads WHERE id = $1', [threadId]);
  const { rows } = await db.query(
    'SELECT * FROM chat_messages WHERE thread_id = $1 AND seq > $2 ORDER BY seq LIMIT 200',
    [threadId, Number(afterSeq) || 0]
  );
  return { thread: { customer_name: thread.customer_name, status: thread.status }, messages: rows.map(publicMessage) };
}

/** Everything new since afterSeq; marks the shop's replies as seen. */
async function pollForShopper(db, token, afterSeq) {
  const thread = await threadByToken(db, token);
  if (!thread) throw ApiError.notFound('Chat not found', undefined, 'chat_not_found');
  const view = await shopperView(db, thread.id, afterSeq);
  if (thread.unread_customer > 0) await db.query('UPDATE chat_threads SET unread_customer = 0 WHERE id = $1', [thread.id]);
  return { ...view, unread: thread.unread_customer };
}

/** Just the unread count (for the badge while the chat window is closed). */
async function unreadForShopper(db, token) {
  const thread = await threadByToken(db, token);
  if (!thread) throw ApiError.notFound('Chat not found', undefined, 'chat_not_found');
  return { unread: thread.unread_customer };
}

async function shopperSend(db, token, input) {
  const thread = await threadByToken(db, token);
  if (!thread) throw ApiError.notFound('Chat not found', undefined, 'chat_not_found');
  const body = cleanBody(input.body);
  const ctx = await productContext(db, input.product_slug);
  const msg = await addMessage(db, thread, { sender: 'customer', body, ctx });
  return withNotify(publicMessage(msg), thread, body);
}

/** Attaches what the staff alert needs, invisible to JSON so it never reaches the shopper. */
function withNotify(obj, thread, body) {
  Object.defineProperty(obj, 'notify', { value: { threadId: thread.id, name: thread.customer_name, preview: body }, enumerable: false });
  return obj;
}

// ---------------- shop side ----------------

const threadOut = (t) => ({
  id: t.id,
  customer_name: t.customer_name,
  customer_phone: t.customer_phone,
  customer_email: t.customer_email,
  status: t.status,
  unread: t.unread_staff,
  last_message_at: t.last_message_at,
  last_message_preview: t.last_message_preview,
  last_sender: t.last_sender,
  created_at: t.created_at,
});

/** How many chats wait for an answer, plus the newest one (for the pop-up on every page). */
async function unreadCount(db) {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM chat_threads WHERE unread_staff > 0 AND status = 'open'");
  const { rows: [t] } = await db.query(
    "SELECT id, customer_name, last_message_preview, last_message_at FROM chat_threads WHERE unread_staff > 0 AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
  );
  return {
    count: rows[0].n,
    latest: t ? { id: t.id, name: t.customer_name, preview: t.last_message_preview, at: t.last_message_at } : null,
  };
}

async function list(db, { status = 'open', q, page = 1, limit = 30 }) {
  const where = [];
  const values = [];
  if (status === 'open' || status === 'closed') { values.push(status); where.push(`status = $${values.length}`); }
  if (q) {
    values.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(customer_name ILIKE $${values.length} OR customer_phone ILIKE $${values.length} OR last_message_preview ILIKE $${values.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await db.query(`SELECT COUNT(*)::int AS total FROM chat_threads ${clause}`, values);
  values.push(limit, (page - 1) * limit);
  const { rows } = await db.query(
    `SELECT * FROM chat_threads ${clause} ORDER BY (unread_staff > 0) DESC, last_message_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return { rows: rows.map(threadOut), total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
}

async function staffGet(db, id, afterSeq) {
  const { rows: [thread] } = await db.query('SELECT * FROM chat_threads WHERE id = $1', [id]);
  if (!thread) throw ApiError.notFound('Conversation not found');
  const { rows } = await db.query(
    'SELECT * FROM chat_messages WHERE thread_id = $1 AND seq > $2 ORDER BY seq LIMIT 300',
    [id, Number(afterSeq) || 0]
  );
  if (thread.unread_staff > 0) await db.query('UPDATE chat_threads SET unread_staff = 0 WHERE id = $1', [id]);
  return { thread: threadOut({ ...thread, unread_staff: 0 }), messages: rows.map(publicMessage) };
}

async function staffSend(db, id, user, input) {
  const { rows: [thread] } = await db.query('SELECT * FROM chat_threads WHERE id = $1', [id]);
  if (!thread) throw ApiError.notFound('Conversation not found');
  const body = cleanBody(input.body);
  const msg = await addMessage(db, thread, { sender: 'staff', body, staff: { id: user.id, name: user.full_name || user.name || 'Shop' } });
  return publicMessage(msg);
}

async function setStatus(db, id, status) {
  const { rows: [t] } = await db.query(
    'UPDATE chat_threads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status]
  );
  if (!t) throw ApiError.notFound('Conversation not found');
  return threadOut(t);
}

module.exports = {
  startThread, pollForShopper, unreadForShopper, shopperSend,
  unreadCount, list, staffGet, staffSend, setStatus,
};
