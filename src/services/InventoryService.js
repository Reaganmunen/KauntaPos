'use strict';

/**
 * Everything that changes stock. Quantities are never written directly: every change is a row in
 * stock_movements and the database trigger applies it to stock_levels / stock_batches.
 * All methods run inside the caller's tenant transaction (db) and take the acting user (may be null
 * for system actions such as an online payment arriving).
 *
 * quantity_change is positive for stock in and negative for stock out.
 */
const ApiError = require('../utils/ApiError');
const { round3 } = require('../utils/money');
const { isRestricted } = require('../utils/context');
const {
  StockLevel, StockBatch, StockMovement, StockTransfer, StockCount, PurchaseOrder, ProductVariant,
} = require('../models');

/**
 * movement_type values written to stock_movements. If your database CHECK constraint uses other
 * names, change them here and nowhere else.
 */
const TYPES = {
  opening: 'opening',
  purchase: 'purchase',
  sale: 'sale',
  return: 'return',            // customer return AND the reversal of a voided sale
  adjustment: 'adjustment',
  damage: 'damage',
  expiry: 'expiry',
  transferIn: 'transfer_in',
  transferOut: 'transfer_out',
};

const EPS = 0.0005;

// ---------- small helpers ----------

const uniq = (list) => [...new Set(list)];

function assertBranchAccess(user, branchId) {
  if (isRestricted(user) && !(user.branch_ids || []).map(String).includes(String(branchId))) {
    throw ApiError.forbidden('You do not have access to that branch');
  }
}

async function allowNegativeStock(db) {
  const { rows } = await db.query('SELECT settings FROM tenants WHERE id = current_tenant_id()');
  return Boolean(rows[0] && rows[0].settings && rows[0].settings.allow_negative_stock);
}

function move(db, user, data) {
  return StockMovement.record(db, { ...data, created_by: user ? user.id : null });
}

/** variant_id -> { track_stock, product_type, cost_price, has_pharma, product_name, variant_name } */
async function variantFlags(db, variantIds) {
  if (!variantIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT v.id, v.cost_price, v.name AS variant_name, p.name AS product_name, p.track_stock, p.product_type,
            EXISTS (SELECT 1 FROM product_pharma pp WHERE pp.product_id = p.id) AS has_pharma
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL`,
    [variantIds]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function requireStockedVariant(db, variantId) {
  const flags = (await variantFlags(db, [variantId])).get(variantId);
  if (!flags) throw ApiError.notFound('Product variant not found');
  if (!flags.track_stock || flags.product_type === 'service') {
    throw ApiError.unprocessable('This product does not track stock');
  }
  return flags;
}

/** Does this variant keep batches (expiry dates) at the branch? Pharmacy products always do. */
async function isBatchTracked(db, branchId, variantId, { hasPharma = false } = {}) {
  if (hasPharma) return true;
  const { rows } = await db.query(
    'SELECT 1 FROM stock_batches WHERE branch_id = $1 AND variant_id = $2 AND is_active LIMIT 1',
    [branchId, variantId]
  );
  return rows.length > 0;
}

async function lockBatch(db, batchId) {
  const { rows } = await db.query('SELECT * FROM stock_batches WHERE id = $1 FOR UPDATE', [batchId]);
  return rows[0] || null;
}

// ---------- outflow for sales (used by SaleService) ----------

/**
 * Decides where stock for a set of sale lines comes from, locking the stock rows first so two
 * cashiers cannot sell the last item. Does NOT write anything: call applyOutflow() afterwards.
 *
 * lines: [{ key, variant_id, quantity, name }]
 * Returns Map(key -> [{ batch_id, quantity }]). Batch-tracked variants are allocated first-expiry-first-out.
 *
 * allowNegative        let stock go below zero (offline sales, online orders already paid, ingredients)
 * respectReservations  compare with stock available after online holds (v_stock_available)
 */
async function planOutflow(db, { branch_id, lines, allowNegative = false, respectReservations = false }) {
  const plan = new Map();
  if (!lines.length) return plan;

  const variantIds = uniq(lines.map((l) => l.variant_id)).sort();
  const locked = await StockLevel.lockForUpdate(db, branch_id, variantIds);
  const onHand = new Map(locked.map((r) => [r.variant_id, Number(r.quantity_on_hand)]));
  let available = onHand;
  if (respectReservations) {
    const rows = await StockLevel.availability(db, branch_id, variantIds);
    available = new Map(rows.map((r) => [r.variant_id, Number(r.quantity_available)]));
  }

  const wanted = new Map();
  for (const l of lines) wanted.set(l.variant_id, round3((wanted.get(l.variant_id) || 0) + Number(l.quantity)));

  if (!allowNegative) {
    const short = [];
    for (const [variantId, qty] of wanted) {
      const have = available.get(variantId) || 0;
      if (qty > have + EPS) {
        const line = lines.find((l) => l.variant_id === variantId);
        short.push({ variant_id: variantId, name: line.name || null, requested: qty, available: Math.max(have, 0) });
      }
    }
    if (short.length) {
      const first = short[0];
      throw ApiError.conflict(
        `Not enough stock${first.name ? ` for ${first.name}` : ''} (available ${first.available}, needed ${first.requested})`,
        { items: short },
        'insufficient_stock'
      );
    }
  }

  const { rows: batchRows } = await db.query(
    `SELECT DISTINCT variant_id FROM stock_batches
      WHERE branch_id = $1 AND variant_id = ANY($2::uuid[]) AND is_active`,
    [branch_id, variantIds]
  );
  const batched = new Set(batchRows.map((r) => r.variant_id));

  // one allocation per variant, then handed out to its lines in order
  const pools = new Map(); // variant_id -> [{ batch_id, quantity }] still unassigned
  for (const [variantId, qty] of wanted) {
    if (!batched.has(variantId)) {
      pools.set(variantId, [{ batch_id: null, quantity: qty }]);
      continue;
    }
    const { allocations, shortfall } = await StockBatch.allocateFefo(db, branch_id, variantId, qty);
    const pool = allocations.map((a) => ({ batch_id: a.batch_id, quantity: Number(a.quantity) }));
    if (shortfall > EPS) {
      if (!allowNegative) {
        const line = lines.find((l) => l.variant_id === variantId);
        throw ApiError.conflict(
          `Not enough in-date stock${line && line.name ? ` for ${line.name}` : ''} (expired batches cannot be sold)`,
          { items: [{ variant_id: variantId, requested: qty, shortfall }] },
          'insufficient_stock'
        );
      }
      pool.push({ batch_id: null, quantity: round3(shortfall) });
    }
    pools.set(variantId, pool);
  }

  for (const l of lines) {
    const pool = pools.get(l.variant_id);
    let need = Number(l.quantity);
    const parts = [];
    while (need > EPS && pool.length) {
      const head = pool[0];
      const take = Math.min(need, head.quantity);
      parts.push({ batch_id: head.batch_id, quantity: round3(take) });
      head.quantity = round3(head.quantity - take);
      need = round3(need - take);
      if (head.quantity <= EPS) pool.shift();
    }
    plan.set(l.key, parts);
  }
  return plan;
}

/** Records the movements decided by planOutflow(). lines need { key, variant_id, unit_cost }. */
async function applyOutflow(db, user, plan, lines, { branch_id, reference_type, reference_id, type = TYPES.sale, note = null }) {
  const out = [];
  for (const l of lines) {
    for (const part of plan.get(l.key) || []) {
      out.push(
        await move(db, user, {
          branch_id,
          variant_id: l.variant_id,
          batch_id: part.batch_id,
          movement_type: type,
          quantity_change: -Math.abs(part.quantity),
          unit_cost: l.unit_cost ?? null,
          reference_type,
          reference_id,
          note,
        })
      );
    }
  }
  return out;
}

/**
 * Puts stock back. With a source reference (the original sale) the quantity goes back into the same
 * batches it came from; anything left over is booked without a batch.
 */
async function returnToStock(db, user, {
  branch_id, variant_id, quantity, unit_cost = null, reference_type, reference_id,
  source_reference_type = null, source_reference_id = null, note = null, type = TYPES.return,
}) {
  let remaining = round3(quantity);
  const booked = [];

  if (source_reference_type) {
    const sources = (await StockMovement.forReference(db, source_reference_type, source_reference_id)).filter(
      (m) => m.variant_id === variant_id && Number(m.quantity_change) < 0
    );
    for (const src of sources) {
      if (remaining <= EPS) break;
      const take = Math.min(remaining, Math.abs(Number(src.quantity_change)));
      booked.push(
        await move(db, user, {
          branch_id, variant_id, batch_id: src.batch_id, movement_type: type, quantity_change: take,
          unit_cost: src.unit_cost ?? unit_cost, reference_type, reference_id, note,
        })
      );
      remaining = round3(remaining - take);
    }
  }
  if (remaining > EPS) {
    booked.push(
      await move(db, user, {
        branch_id, variant_id, batch_id: null, movement_type: type, quantity_change: remaining,
        unit_cost, reference_type, reference_id, note,
      })
    );
  }
  return booked;
}

/** Cancels every movement booked for a document by booking the opposite movements. */
async function reverseMovements(db, user, { reference_type, reference_id, type = TYPES.return, note = null }) {
  const originals = await StockMovement.forReference(db, reference_type, reference_id);
  const out = [];
  for (const m of originals) {
    out.push(
      await move(db, user, {
        branch_id: m.branch_id,
        variant_id: m.variant_id,
        batch_id: m.batch_id,
        movement_type: type,
        quantity_change: -Number(m.quantity_change),
        unit_cost: m.unit_cost,
        reference_type,
        reference_id,
        note,
      })
    );
  }
  return out;
}

// ---------- adjustments and opening stock ----------

/**
 * input: { branch_id, variant_id, type: 'adjustment'|'damage'|'expiry', note,
 *          quantity_change (+/-) OR new_quantity, batch_id | batch_no (+ expiry_date), unit_cost }
 */
async function adjust(db, user, input) {
  const { branch_id, variant_id } = input;
  assertBranchAccess(user, branch_id);
  const flags = await requireStockedVariant(db, variant_id);
  await StockLevel.lockForUpdate(db, branch_id, [variant_id]);

  const type = input.type || 'adjustment';
  const batchTracked = await isBatchTracked(db, branch_id, variant_id, { hasPharma: flags.has_pharma });

  let batch = null;
  if (input.batch_id) {
    batch = await lockBatch(db, input.batch_id);
    if (!batch || batch.branch_id !== branch_id || batch.variant_id !== variant_id) {
      throw ApiError.unprocessable('That batch does not belong to this product and branch');
    }
  }

  const useNewQuantity = input.quantity_change === undefined || input.quantity_change === null;
  const current = batch ? Number(batch.quantity_on_hand) : Number(await StockLevel.getQuantity(db, branch_id, variant_id));
  let delta;
  if (useNewQuantity) {
    const target = Number(input.new_quantity);
    if (!Number.isFinite(target) || target < 0) throw ApiError.unprocessable('new_quantity must be 0 or more');
    if (batchTracked && !batch) {
      throw ApiError.unprocessable('Choose the batch to count', undefined, 'batch_required');
    }
    delta = round3(target - current);
  } else {
    delta = round3(Number(input.quantity_change));
    if (!Number.isFinite(delta)) throw ApiError.unprocessable('quantity_change must be a number');
  }
  if (Math.abs(delta) < EPS) throw ApiError.unprocessable('That would not change the stock');
  if ((type === 'damage' || type === 'expiry') && delta > 0) {
    throw ApiError.unprocessable(`A ${type} entry must reduce stock`);
  }

  if (delta > 0 && !batch && batchTracked) {
    if (!input.batch_no) throw ApiError.unprocessable('batch_no is required for this product', undefined, 'batch_required');
    batch = await StockBatch.findOrCreate(db, {
      branch_id, variant_id, batch_no: input.batch_no, expiry_date: input.expiry_date,
      cost_price: input.unit_cost,
    });
  }
  if (delta < 0 && batchTracked && !batch) {
    throw ApiError.unprocessable('Choose the batch to take stock from', undefined, 'batch_required');
  }
  if (delta < 0 && current + delta < -EPS && !(await allowNegativeStock(db))) {
    throw ApiError.conflict(`Only ${current} in stock`, undefined, 'insufficient_stock');
  }

  const movement = await move(db, user, {
    branch_id,
    variant_id,
    batch_id: batch ? batch.id : null,
    movement_type: TYPES[type] || type,
    quantity_change: delta,
    unit_cost: input.unit_cost ?? flags.cost_price,
    reference_type: 'adjustment',
    reference_id: null,
    note: input.note || null,
  });
  return { ...movement, quantity_on_hand: round3(current + delta) };
}

/** First stock of a product at a branch. */
async function openingStock(db, user, { branch_id, variant_id, quantity, unit_cost }) {
  assertBranchAccess(user, branch_id);
  const flags = await requireStockedVariant(db, variant_id);
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw ApiError.unprocessable('quantity must be greater than 0');

  await StockLevel.lockForUpdate(db, branch_id, [variant_id]);
  const movement = await move(db, user, {
    branch_id,
    variant_id,
    batch_id: null,
    movement_type: TYPES.opening,
    quantity_change: qty,
    unit_cost: unit_cost ?? flags.cost_price,
    reference_type: 'opening',
    reference_id: null,
    note: 'Opening stock',
  });
  return movement;
}

// ---------- purchases ----------

/**
 * Books goods received against a purchase order.
 * receipts: [{ item_id, quantity, batch_no, expiry_date }]; none = everything still outstanding.
 * Stock goes into the order's branch. The variant's cost price follows the latest purchase cost.
 */
async function receivePurchase(db, user, purchaseOrderId, receipts) {
  const { rows } = await db.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [purchaseOrderId]);
  const po = rows[0];
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (!['draft', 'ordered', 'partially_received'].includes(po.status)) {
    throw ApiError.conflict(`A ${po.status.replace('_', ' ')} order cannot receive goods`);
  }
  assertBranchAccess(user, po.branch_id);

  const items = await PurchaseOrder.getItems(db, po.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const outstanding = (i) => round3(Number(i.quantity_ordered) - Number(i.quantity_received));

  const lines = Array.isArray(receipts) && receipts.length
    ? receipts
    : items.filter((i) => outstanding(i) > EPS).map((i) => ({ item_id: i.id, quantity: outstanding(i) }));
  if (!lines.length) throw ApiError.conflict('Everything on this order has already been received');

  const normalised = [];
  const seen = new Set();
  for (const r of lines) {
    const item = byId.get(r.item_id);
    if (!item) throw ApiError.unprocessable('A receipt line does not belong to this order');
    if (seen.has(item.id)) throw ApiError.unprocessable('Each order line can appear only once per receipt');
    seen.add(item.id);
    const quantity = Number(r.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw ApiError.unprocessable('Received quantity must be greater than 0');
    if (quantity > outstanding(item) + EPS) {
      throw ApiError.unprocessable(`${item.product_name}: only ${outstanding(item)} still expected`);
    }
    normalised.push({
      item,
      quantity,
      batch_no: r.batch_no || item.batch_no || null,
      expiry_date: r.expiry_date || item.expiry_date || null,
    });
  }

  const flags = await variantFlags(db, uniq(normalised.map((n) => n.item.variant_id)));
  await StockLevel.lockForUpdate(db, po.branch_id, uniq(normalised.map((n) => n.item.variant_id)).sort());

  for (const n of normalised) {
    const f = flags.get(n.item.variant_id);
    if (!f || !f.track_stock || f.product_type === 'service') continue;

    let batchId = null;
    const batchTracked = await isBatchTracked(db, po.branch_id, n.item.variant_id, { hasPharma: f.has_pharma });
    if (n.batch_no) {
      const batch = await StockBatch.findOrCreate(db, {
        branch_id: po.branch_id, variant_id: n.item.variant_id, batch_no: n.batch_no,
        expiry_date: n.expiry_date, cost_price: n.item.unit_cost, supplier_id: po.supplier_id,
      });
      batchId = batch.id;
    } else if (batchTracked) {
      throw ApiError.unprocessable(`${n.item.product_name}: enter the batch number and expiry date`, undefined, 'batch_required');
    }

    await move(db, user, {
      branch_id: po.branch_id,
      variant_id: n.item.variant_id,
      batch_id: batchId,
      movement_type: TYPES.purchase,
      quantity_change: n.quantity,
      unit_cost: n.item.unit_cost,
      reference_type: 'purchase_order',
      reference_id: po.id,
      note: po.po_number,
    });
    if (Number(f.cost_price) !== Number(n.item.unit_cost)) {
      await ProductVariant.update(db, n.item.variant_id, { cost_price: n.item.unit_cost });
    }
  }

  return PurchaseOrder.applyReceipt(
    db,
    po.id,
    normalised.map((n) => ({ item_id: n.item.id, quantity: n.quantity }))
  );
}

// ---------- transfers between branches ----------

async function lockTransfer(db, id) {
  const { rows } = await db.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw ApiError.notFound('Transfer not found');
  return rows[0];
}

/** Stock leaves the source branch (draft -> in transit). */
async function sendTransfer(db, user, transferId) {
  const transfer = await lockTransfer(db, transferId);
  if (transfer.status !== 'draft') throw ApiError.conflict('Only a draft transfer can be sent');
  assertBranchAccess(user, transfer.from_branch_id);

  const items = await StockTransfer.getItems(db, transfer.id);
  const flags = await variantFlags(db, uniq(items.map((i) => i.variant_id)));
  for (const i of items) {
    const f = flags.get(i.variant_id);
    if (!f || !f.track_stock || f.product_type === 'service') {
      throw ApiError.unprocessable(`${i.product_name} does not track stock and cannot be transferred`);
    }
  }

  // Items that name a batch use it; the rest are allocated first-expiry-first-out when batched.
  const lines = items.map((i) => ({ key: i.id, variant_id: i.variant_id, quantity: Number(i.quantity_sent), name: i.product_name, item: i }));
  const free = lines.filter((l) => !l.item.batch_id);
  const plan = await planOutflow(db, { branch_id: transfer.from_branch_id, lines: free });

  // explicit batches: lock and check
  for (const l of lines.filter((x) => x.item.batch_id)) {
    const batch = await lockBatch(db, l.item.batch_id);
    if (!batch || batch.branch_id !== transfer.from_branch_id || batch.variant_id !== l.variant_id) {
      throw ApiError.unprocessable(`${l.name}: that batch is not at the sending branch`);
    }
    if (Number(batch.quantity_on_hand) + EPS < l.quantity) {
      throw ApiError.conflict(`${l.name}: batch ${batch.batch_no} only has ${batch.quantity_on_hand}`, undefined, 'insufficient_stock');
    }
    plan.set(l.key, [{ batch_id: batch.id, quantity: l.quantity }]);
  }

  for (const l of lines) {
    const parts = plan.get(l.key);
    // a line that spans several batches becomes several transfer lines (one batch each)
    if (parts.length > 1 || (parts[0] && parts[0].batch_id !== l.item.batch_id)) {
      await db.query('UPDATE stock_transfer_items SET batch_id = $2, quantity_sent = $3 WHERE id = $1', [
        l.item.id, parts[0].batch_id, parts[0].quantity,
      ]);
      if (parts.length > 1) {
        await StockTransfer.addItems(
          db, transfer.id,
          parts.slice(1).map((p) => ({ variant_id: l.variant_id, batch_id: p.batch_id, quantity_sent: p.quantity }))
        );
      }
    }
    for (const p of parts) {
      await move(db, user, {
        branch_id: transfer.from_branch_id,
        variant_id: l.variant_id,
        batch_id: p.batch_id,
        movement_type: TYPES.transferOut,
        quantity_change: -p.quantity,
        unit_cost: flags.get(l.variant_id).cost_price,
        reference_type: 'stock_transfer',
        reference_id: transfer.id,
        note: transfer.transfer_number,
      });
    }
  }

  const sent = await StockTransfer.markSent(db, transfer.id);
  if (!sent) throw ApiError.conflict('The transfer was changed by someone else. Try again.');
  return sent;
}

/** Stock arrives at the destination. items: [{ item_id, quantity_received }]; none = everything sent. */
async function receiveTransfer(db, user, transferId, items) {
  const transfer = await lockTransfer(db, transferId);
  if (transfer.status !== 'in_transit') throw ApiError.conflict('Only a transfer that is on its way can be received');
  assertBranchAccess(user, transfer.to_branch_id);

  const lines = await StockTransfer.getItems(db, transfer.id);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const wanted = Array.isArray(items) && items.length
    ? items.map((i) => ({ item_id: i.item_id, quantity: Number(i.quantity_received) }))
    : lines.map((l) => ({ item_id: l.id, quantity: Number(l.quantity_sent) }));

  const received = new Map();
  for (const w of wanted) {
    const line = byId.get(w.item_id);
    if (!line) throw ApiError.unprocessable('A line does not belong to this transfer');
    if (!Number.isFinite(w.quantity) || w.quantity < 0) throw ApiError.unprocessable('quantity_received must be 0 or more');
    if (w.quantity > Number(line.quantity_sent) + EPS) {
      throw ApiError.unprocessable(`${line.product_name}: only ${line.quantity_sent} were sent`);
    }
    received.set(line.id, w.quantity);
  }

  for (const line of lines) {
    // lines not mentioned when receiving a partial list are taken as fully received
    const qty = received.has(line.id) ? received.get(line.id) : Number(line.quantity_sent);
    await StockTransfer.setItemReceived(db, line.id, qty);
    if (qty <= 0) continue;

    let batchId = null;
    if (line.batch_id) {
      const { rows } = await db.query('SELECT * FROM stock_batches WHERE id = $1', [line.batch_id]);
      const src = rows[0];
      if (src) {
        const dest = await StockBatch.findOrCreate(db, {
          branch_id: transfer.to_branch_id, variant_id: line.variant_id, batch_no: src.batch_no,
          expiry_date: src.expiry_date, manufactured_date: src.manufactured_date,
          cost_price: src.cost_price, supplier_id: src.supplier_id,
        });
        batchId = dest.id;
      }
    }
    await move(db, user, {
      branch_id: transfer.to_branch_id,
      variant_id: line.variant_id,
      batch_id: batchId,
      movement_type: TYPES.transferIn,
      quantity_change: qty,
      unit_cost: null,
      reference_type: 'stock_transfer',
      reference_id: transfer.id,
      note: transfer.transfer_number,
    });
  }

  const done = await StockTransfer.markReceived(db, transfer.id, user ? user.id : null);
  if (!done) throw ApiError.conflict('The transfer was changed by someone else. Try again.');
  return done;
}

/** A draft is simply cancelled; one already sent has its stock returned to the source branch. */
async function cancelTransfer(db, user, transferId) {
  const transfer = await lockTransfer(db, transferId);
  if (!['draft', 'in_transit'].includes(transfer.status)) {
    throw ApiError.conflict('Only a draft or in-transit transfer can be cancelled');
  }
  assertBranchAccess(user, transfer.from_branch_id);

  if (transfer.status === 'in_transit') {
    await reverseMovements(db, user, {
      reference_type: 'stock_transfer',
      reference_id: transfer.id,
      type: TYPES.transferIn,
      note: `${transfer.transfer_number} cancelled`,
    });
  }
  const cancelled = await StockTransfer.cancel(db, transfer.id);
  if (!cancelled) throw ApiError.conflict('The transfer was changed by someone else. Try again.');
  return cancelled;
}

// ---------- stocktake ----------

/**
 * Books an adjustment for every counted item whose count differs from the snapshot taken when the
 * count started (so sales made during the count are not wiped out). Items nobody counted are left alone.
 */
async function completeCount(db, user, countId) {
  const { rows } = await db.query('SELECT * FROM stock_counts WHERE id = $1 FOR UPDATE', [countId]);
  const count = rows[0];
  if (!count) throw ApiError.notFound('Stock count not found');
  if (count.status !== 'open') throw ApiError.conflict('This count is already closed');
  assertBranchAccess(user, count.branch_id);

  const variances = await StockCount.variances(db, count.id);
  await StockLevel.lockForUpdate(db, count.branch_id, uniq(variances.map((v) => v.variant_id)).sort());

  let increases = 0;
  let decreases = 0;
  let valueChange = 0;
  for (const v of variances) {
    const delta = round3(Number(v.variance));
    valueChange += delta * Number(v.cost_price || 0);

    if (delta > 0) {
      increases += 1;
      await move(db, user, {
        branch_id: count.branch_id, variant_id: v.variant_id, batch_id: null,
        movement_type: TYPES.adjustment, quantity_change: delta, unit_cost: v.cost_price,
        reference_type: 'stock_count', reference_id: count.id, note: `Stocktake ${count.count_number}`,
      });
      continue;
    }

    decreases += 1;
    const need = Math.abs(delta);
    const batched = await isBatchTracked(db, count.branch_id, v.variant_id);
    let remaining = need;
    if (batched) {
      const { allocations, shortfall } = await StockBatch.allocateFefo(db, count.branch_id, v.variant_id, need);
      for (const a of allocations) {
        await move(db, user, {
          branch_id: count.branch_id, variant_id: v.variant_id, batch_id: a.batch_id,
          movement_type: TYPES.adjustment, quantity_change: -Number(a.quantity), unit_cost: v.cost_price,
          reference_type: 'stock_count', reference_id: count.id, note: `Stocktake ${count.count_number}`,
        });
      }
      remaining = shortfall;
    }
    if (remaining > EPS) {
      await move(db, user, {
        branch_id: count.branch_id, variant_id: v.variant_id, batch_id: null,
        movement_type: TYPES.adjustment, quantity_change: -round3(remaining), unit_cost: v.cost_price,
        reference_type: 'stock_count', reference_id: count.id, note: `Stocktake ${count.count_number}`,
      });
    }
  }

  const completed = await StockCount.complete(db, count.id);
  if (!completed) throw ApiError.conflict('The count was changed by someone else. Try again.');
  return {
    count: completed,
    adjusted: variances.length,
    increases,
    decreases,
    value_change: Math.round((valueChange + Number.EPSILON) * 100) / 100,
  };
}

// ---------- pharmacy ----------

/** Removes expired batches from stock (booked as 'expiry' movements). Batches not yet expired are skipped. */
async function writeOffExpired(db, user, { batch_ids, note }) {
  const { rows } = await db.query(
    'SELECT * FROM stock_batches WHERE id = ANY($1::uuid[]) FOR UPDATE',
    [batch_ids]
  );
  const found = new Map(rows.map((b) => [b.id, b]));
  const today = new Date().toISOString().slice(0, 10);

  const written = [];
  const skipped = [];
  let totalCost = 0;
  for (const id of batch_ids) {
    const batch = found.get(id);
    if (!batch) {
      skipped.push({ batch_id: id, reason: 'Batch not found' });
      continue;
    }
    try {
      assertBranchAccess(user, batch.branch_id);
    } catch (err) {
      skipped.push({ batch_id: id, reason: err.message });
      continue;
    }
    if (!batch.expiry_date || String(batch.expiry_date) >= today) {
      skipped.push({ batch_id: id, reason: 'Not expired yet' });
      continue;
    }
    const qty = Number(batch.quantity_on_hand);
    if (qty <= 0) {
      skipped.push({ batch_id: id, reason: 'No stock left in this batch' });
      continue;
    }
    await StockLevel.lockForUpdate(db, batch.branch_id, [batch.variant_id]);
    await move(db, user, {
      branch_id: batch.branch_id,
      variant_id: batch.variant_id,
      batch_id: batch.id,
      movement_type: TYPES.expiry,
      quantity_change: -qty,
      unit_cost: batch.cost_price,
      reference_type: 'expiry_write_off',
      reference_id: batch.id,
      note: note || `Expired batch ${batch.batch_no}`,
    });
    totalCost += qty * Number(batch.cost_price || 0);
    written.push({ batch_id: batch.id, batch_no: batch.batch_no, quantity: qty });
  }

  return {
    written_off: written.length,
    batches: written,
    skipped,
    total_cost: Math.round((totalCost + Number.EPSILON) * 100) / 100,
  };
}

module.exports = {
  TYPES,
  // used by the sale flow
  planOutflow,
  applyOutflow,
  returnToStock,
  reverseMovements,
  allowNegativeStock,
  variantFlags,
  // used by controllers
  adjust,
  openingStock,
  receivePurchase,
  sendTransfer,
  receiveTransfer,
  cancelTransfer,
  completeCount,
  writeOffExpired,
};
