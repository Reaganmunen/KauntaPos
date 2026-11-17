/* Inventory: stock levels (GET /inventory), value (GET /inventory/valuation), history (GET /inventory/variants/:id/movements),
   batches (GET /inventory/variants/:id/batches) and corrections (POST /inventory/adjust). Everything works on one branch at a time. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var S = { page: 1, pages: 1, q: '', low: false, branch: '', rows: [], cur: null, batches: [], mode: 'set', canAdjust: false, forceBatch: false };

  var TYPE = { opening: 'Opening stock', purchase: 'Purchase received', sale: 'Sale', return: 'Return', adjustment: 'Adjustment', damage: 'Damaged', expiry: 'Expired', transfer_in: 'Transfer in', transfer_out: 'Transfer out' };

  function hdr() { return S.branch ? { 'X-Branch-Id': S.branch } : undefined; }
  function bq() { return 'branch_id=' + encodeURIComponent(S.branch); }
  function n(v) { return Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 }); }
  function day(d) { return d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function name(r) { var v = r.variant_name && r.variant_name !== 'Default' ? ' - ' + r.variant_name : ''; return (r.product_name || r.name || 'Product') + v; }
  function qtyOf(r) { return Number(r.quantity_on_hand != null ? r.quantity_on_hand : r.quantity) || 0; }
  function stockTag(r) {
    var q = qtyOf(r), re = Number(r.reorder_level) || 0;
    if (q <= 0) return K.el('span', 'Out of stock', 'tag dot bad');
    if (r.is_low || (re > 0 && q <= re)) return K.el('span', 'Low', 'tag dot warn');
    return K.el('span', 'In stock', 'tag dot ok');
  }

  /* ---------- value of stock ---------- */
  async function loadStats() {
    var box = $('#stats'); box.hidden = true;
    try {
      var d = await K.api('GET', '/inventory/valuation?' + bq(), undefined, hdr());
      var b = d && d.branches && d.branches[0]; if (!b) return;
      box.textContent = ''; box.appendChild(fact('Stock value at cost', K.money(b.cost_value))); box.appendChild(fact('Stock value at selling price', K.money(b.retail_value))); box.hidden = false;
    } catch (e) { /* needs reports or adjust permission: just hide it */ }
  }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('package')); e.appendChild(ic);
    if (S.q || S.low) { e.appendChild(K.el('b', S.low && !S.q ? 'Nothing is running low' : 'No stock matches')); e.appendChild(K.el('p', S.low && !S.q ? 'Every product is above its reorder level.' : 'Try a different word.')); }
    else { e.appendChild(K.el('b', 'No stock yet')); e.appendChild(K.el('p', 'Add products with a starting quantity on the Products page and they will appear here.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Product', 'SKU', 'On hand', 'Available', 'Reorder at', 'Status'].forEach(function (h, i) { tr.appendChild(K.el('th', h, i >= 2 && i <= 4 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    S.rows.forEach(function (r) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', name(r))); row.appendChild(c1);
      row.appendChild(K.el('td', r.sku || '', 'mono'));
      row.appendChild(K.el('td', n(qtyOf(r)), 'r num'));
      var av = r.quantity_available != null ? r.quantity_available : (Number(r.quantity_on_hand) || 0) - (Number(r.quantity_reserved) || 0);
      row.appendChild(K.el('td', n(av), 'r num'));
      row.appendChild(K.el('td', Number(r.reorder_level) ? n(r.reorder_level) : '', 'r num muted'));
      var st = K.el('td'); st.appendChild(stockTag(r)); row.appendChild(st);
      row.addEventListener('click', function () { openDetail(r); }); body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!S.branch) return;
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?' + bq() + '&page=' + S.page + '&limit=' + LIMIT + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.low ? '&low_only=true' : '');
      var res = await K.apiFull('GET', '/inventory' + qs, undefined, hdr());
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; if (ex.message) K.notice(err, ex.status === 403 ? 'Your role does not include stock levels. Ask the shop owner for access.' : ex.message, 'err'); }
  }
  function refresh() { loadStats(); return load(); }

  /* ---------- details ---------- */
  function sectionTitle(t) { var h = K.el('b', t); h.style.display = 'block'; h.style.marginTop = '8px'; return h; }
  async function openDetail(row) {
    var d = $('#detail'), body = $('#dBody'); S.cur = row; body.textContent = ''; $('#dTitle').textContent = name(row);
    $('#dAdjust').hidden = !S.canAdjust;
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row')); d.showModal();
    var movements = [], batches = [];
    try { movements = (await K.api('GET', '/inventory/variants/' + encodeURIComponent(row.variant_id) + '/movements?' + bq() + '&limit=50', undefined, hdr())) || []; }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', ex.message || 'We could not load the history.', 'note err')); return; }
    try { batches = (await K.api('GET', '/inventory/variants/' + encodeURIComponent(row.variant_id) + '/batches?' + bq(), undefined, hdr())) || []; } catch (e) { /* batches are optional */ }
    body.textContent = '';
    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('On hand', n(qtyOf(row)))); if (row.quantity_reserved != null) facts.appendChild(fact('Held for online orders', n(row.quantity_reserved)));
    if (Number(row.reorder_level)) facts.appendChild(fact('Reorder at', n(row.reorder_level)));
    body.appendChild(facts);

    if (batches.length) {
      body.appendChild(sectionTitle('Batches'));
      var bc = K.el('div', undefined, 'card flush'), bs = K.el('div', undefined, 'scroll'), bt = K.el('table'), bh = K.el('tr');
      ['Batch', 'Expires', 'On hand'].forEach(function (h, i) { bh.appendChild(K.el('th', h, i === 2 ? 'r' : '')); });
      var bth = K.el('thead'); bth.appendChild(bh); bt.appendChild(bth); var bb = K.el('tbody');
      batches.forEach(function (b) { var r = K.el('tr'); r.appendChild(K.el('td', b.batch_no || '', 'mono')); r.appendChild(K.el('td', day(b.expiry_date))); r.appendChild(K.el('td', n(b.quantity_on_hand), 'r num')); bb.appendChild(r); });
      bt.appendChild(bb); bs.appendChild(bt); bc.appendChild(bs); body.appendChild(bc);
    }

    body.appendChild(sectionTitle('Recent movements'));
    if (!movements.length) { body.appendChild(K.el('p', 'No movements yet.', 'muted')); return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
    ['When', 'What', 'Change', 'Note'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i === 2 ? 'r' : '')); });
    var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
    movements.forEach(function (m) {
      var r = K.el('tr'), ch = Number(m.quantity_change) || 0;
      r.appendChild(K.el('td', when(m.created_at), 'nw muted')); r.appendChild(K.el('td', TYPE[m.movement_type] || m.movement_type || ''));
      r.appendChild(K.el('td', (ch > 0 ? '+' : '') + n(ch), 'r num ' + (ch < 0 ? 'bad' : ''))); r.appendChild(K.el('td', m.note || '', 'muted')); tbody.appendChild(r);
    });
    tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);
  }

  /* ---------- adjust ---------- */
  var NEW = '__new';
  function selectedBatch() { var v = $('#aBatch').value; return S.batches.filter(function (b) { return b.id === v; })[0] || null; }
  function paintMode() {
    $('#aMode').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === S.mode)); });
    $('#aQtyLabel').textContent = S.mode === 'set' ? 'Counted quantity' : S.mode === 'add' ? 'Quantity to add' : 'Quantity to remove';
    var reason = $('#aReason'); if (S.mode === 'add') reason.value = 'adjustment';
    reason.disabled = S.mode === 'add'; if (S.mode === 'remove' && reason.value === '') reason.value = 'adjustment';
    paintBatch(); paintPreview();
  }
  function paintBatch() {
    var box = $('#aBatchBox'), sel = $('#aBatch'), keep = sel.value; sel.textContent = '';
    box.hidden = !(S.batches.length || S.forceBatch);
    S.batches.forEach(function (b) { var o = K.el('option', (b.batch_no || 'Batch') + (b.expiry_date ? ' - expires ' + day(b.expiry_date) : '') + ' - ' + n(b.quantity_on_hand) + ' left'); o.value = b.id; sel.appendChild(o); });
    if (S.mode !== 'remove') { var o2 = K.el('option', 'A new batch'); o2.value = NEW; sel.appendChild(o2); }
    if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep;
    else if (!S.batches.length && S.mode !== 'remove') sel.value = NEW;
    $('#aNewBatch').hidden = box.hidden || sel.value !== NEW;
  }
  function paintPreview() {
    var el = $('#aPreview'), raw = $('#aQty').value; if (raw === '' || !S.cur) { el.textContent = ''; return; }
    var q = K.num(raw), b = $('#aBatch').value && $('#aBatch').value !== NEW ? selectedBatch() : null, cur = b ? Number(b.quantity_on_hand) || 0 : qtyOf(S.cur);
    var next = S.mode === 'set' ? q : S.mode === 'add' ? cur + q : cur - q;
    el.textContent = (b ? 'This batch: ' : 'Stock: ') + n(cur) + ' to ' + n(next);
  }
  async function openAdjust() {
    var row = S.cur; if (!row) return;
    S.mode = 'set'; S.forceBatch = false; S.batches = []; K.notice($('#aErr'), '');
    $('#aWho').textContent = name(row) + ' - ' + n(qtyOf(row)) + ' in stock now';
    $('#aQty').value = ''; $('#aNote').value = ''; $('#aReason').value = 'adjustment'; $('#aBatchNo').value = ''; $('#aExpiry').value = '';
    try { S.batches = ((await K.api('GET', '/inventory/variants/' + encodeURIComponent(row.variant_id) + '/batches?' + bq(), undefined, hdr())) || []).filter(function (b) { return b.is_active !== false; }); } catch (e) { S.batches = []; }
    paintMode(); $('#detail').close(); $('#adjDlg').showModal(); setTimeout(function () { $('#aQty').focus(); }, 60);
  }
  $('#dAdjust').addEventListener('click', openAdjust);
  $('#aMode').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { S.mode = b.dataset.m; paintMode(); }); });
  $('#aQty').addEventListener('input', paintPreview);
  $('#aBatch').addEventListener('change', function () { $('#aNewBatch').hidden = this.value !== NEW; paintPreview(); });

  $('#adjForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#aErr'), btn = $('#aGo'), raw = $('#aQty').value, note = $('#aNote').value.trim(); K.notice(err, '');
    if (raw === '' || K.num(raw) < 0) return K.notice(err, 'Enter the quantity.', 'err');
    if (S.mode !== 'set' && !(K.num(raw) > 0)) return K.notice(err, 'The quantity must be more than zero.', 'err');
    if (!note) return K.notice(err, 'Add a short note so the change can be traced later.', 'err');
    var q = K.num(raw), body = { variant_id: S.cur.variant_id, type: $('#aReason').value, note: note };
    if (S.mode === 'set') body.new_quantity = q; else body.quantity_change = S.mode === 'add' ? q : -q;
    if (!$('#aBatchBox').hidden) {
      var bv = $('#aBatch').value;
      if (bv === NEW) {
        if (!$('#aBatchNo').value.trim()) return K.notice(err, 'Enter the batch number.', 'err');
        body.batch_no = $('#aBatchNo').value.trim(); if ($('#aExpiry').value) body.expiry_date = $('#aExpiry').value;
      } else if (bv) body.batch_id = bv;
    }
    K.busy(btn, true, 'Saving...');
    try {
      await K.api('POST', '/inventory/adjust', body, hdr());
      $('#adjDlg').close(); K.toast('Stock updated'); await refresh();
    } catch (ex) {
      if (ex.code === 'batch_required' || /batch/i.test(ex.message || '')) { S.forceBatch = true; paintBatch(); }
      K.notice(err, ex.message, 'err');
    }
    K.busy(btn, false);
  });

  /* ---------- controls ---------- */
  var t = null;
  $('#iq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#iview').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { S.low = b.dataset.v === 'low'; S.page = 1; $('#iview').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); load(); });
  });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { refresh(); });
  $('#branch').addEventListener('change', function () { S.branch = this.value; S.page = 1; refresh(); });

  async function start() {
    K.identity().then(function (d) { var me = d && d.user; S.canAdjust = Boolean(me && K.can(me, 'inventory.adjust')); });
    var list = [];
    try { list = (await K.branches()) || []; } catch (e) { /* handled below */ }
    if (!list.length) { K.notice($('#listErr'), 'Your shop has no branch you can view stock for.', 'err'); return; }
    var sel = $('#branch'); sel.textContent = '';
    list.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
    sel.hidden = list.length < 2; S.branch = list[0].id;
    refresh();
  }
  start();
})();