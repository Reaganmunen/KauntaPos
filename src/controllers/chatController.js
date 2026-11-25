'use strict';

/** Customer chat. `shopper*` is public (storefront, no login); `staff*` is the shop's inbox. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { run, pageParams } = require('../utils/context');
const Chat = require('../services/ChatService');
const Push = require('../services/PushService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenOf = (req) => String(req.get('x-chat-token') || '');
const afterOf = (req) => Math.max(parseInt(req.query.after, 10) || 0, 0);
const idOf = (req) => {
  if (!UUID_RE.test(req.params.id)) throw ApiError.notFound('Conversation not found');
  return req.params.id;
};

// ---------- shopper (mounted under /store, shop comes from the host) ----------

// POST /store/chat/threads  { name, phone, email, message, product_slug }
exports.shopperStart = asyncHandler(async (req, res) => {
  const out = await run(req, (db) => Chat.startThread(db, req.body || {}));
  if (out.notify) Push.notifyShop(req.tenantId, out.notify); // not awaited: alerts never slow or fail the shopper
  return created(res, out);
});

// GET /store/chat/thread?after=<seq>   header X-Chat-Token
exports.shopperPoll = asyncHandler(async (req, res) => {
  return ok(res, await run(req, (db) => Chat.pollForShopper(db, tokenOf(req), afterOf(req))));
});

// GET /store/chat/unread
exports.shopperUnread = asyncHandler(async (req, res) => {
  return ok(res, await run(req, (db) => Chat.unreadForShopper(db, tokenOf(req))));
});

// POST /store/chat/messages  { body, product_slug }
exports.shopperSend = asyncHandler(async (req, res) => {
  const out = await run(req, (db) => Chat.shopperSend(db, tokenOf(req), req.body || {}));
  if (out.notify) Push.notifyShop(req.tenantId, out.notify);
  return created(res, out);
});

// ---------- staff ----------

exports.staffUnread = asyncHandler(async (req, res) => ok(res, await run(req, (db) => Chat.unreadCount(db))));

// ---------- staff alerts on phone / desktop (Web Push) ----------

// GET /chat/push/key?endpoint=<this device's endpoint>   -> { enabled, public_key, subscribed }
exports.pushKey = asyncHandler(async (req, res) => {
  const key = Push.publicKey();
  const subscribed = key && req.query.endpoint ? await Push.isSubscribed(req.tenantId, req.user, String(req.query.endpoint)) : false;
  return ok(res, { enabled: Boolean(key), public_key: key, subscribed });
});
// POST /chat/push/subscribe  { subscription }
exports.pushSubscribe = asyncHandler(async (req, res) => {
  await Push.subscribe(req.tenantId, req.user, req.body && req.body.subscription, req.get('user-agent'));
  return ok(res, { subscribed: true });
});
// POST /chat/push/unsubscribe  { endpoint }
exports.pushUnsubscribe = asyncHandler(async (req, res) => {
  await Push.unsubscribe(req.tenantId, req.user, req.body && req.body.endpoint);
  return ok(res, { subscribed: false });
});

// GET /chat/threads?status=open|closed|all&q=&page=
exports.staffList = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) => Chat.list(db, { status: req.query.status || 'open', q: req.query.q, page, limit: Math.min(limit, 50) }));
  return paginated(res, result);
});

// GET /chat/threads/:id?after=<seq>   (opening it marks it read)
exports.staffGet = asyncHandler(async (req, res) => ok(res, await run(req, (db) => Chat.staffGet(db, idOf(req), afterOf(req)))));

// POST /chat/threads/:id/messages  { body }
exports.staffSend = asyncHandler(async (req, res) =>
  created(res, await run(req, (db) => Chat.staffSend(db, idOf(req), req.user, req.body || {}))));

// PUT /chat/threads/:id/status  { status: 'open' | 'closed' }
exports.staffStatus = asyncHandler(async (req, res) => {
  const status = req.body && req.body.status;
  if (!['open', 'closed'].includes(status)) throw ApiError.unprocessable('status must be open or closed');
  return ok(res, await run(req, (db) => Chat.setStatus(db, idOf(req), status)));
});
