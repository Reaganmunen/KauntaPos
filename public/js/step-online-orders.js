/* Online orders: queue (GET /online-orders), counts (GET /online-orders/counts), details (GET /online-orders/:id),
   status changes (PUT /online-orders/:id/status) and cash payments (POST /sales/:id/payments). */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var POLL_MS = 30000, LIMIT = 25;
  var PAY_PATH = function (saleId) { return '/sales/' + encodeURIComponent(saleId) + '/payments'; }; /* POST { method, amount } - change if your route differs */

  var LABEL = { awaiting_payment: 'Awaiting payment', paid: 'Paid', processing: 'Preparing', ready: 'Ready', out_for_delivery: 'Out for delivery', completed: 'Completed', cancelled: 'Cancelled' };
  var TONE = { awaiting_payment: 'warn', paid: 'info', processing: 'info', ready: 'ok', out_for_delivery: 'info', completed: 'ok', cancelled: 'bad' };
  var TABS = [['', 'All']].concat(Object.keys(LABEL).map(function (k) { return [k, LABEL[k]]; }));
  var S = { status: '', q: '', branch: '', page: 1, pages: 1, counts: {}, cur: null, busy: false };

  function hdr() { return S.branch ? { 'X-Branch-Id': S.branch } : undefined; }
  function branchQs() { return S.branch ? 'branch_id=' + encodeURIComponent(S.branch) : ''; }
  function tag(status) { return K.el('span', LABEL[status] || status, 'tag dot ' + (TONE[status] || '')); }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }

  /* ---------- tabs ---------- */
  function renderTabs() {
    var box = $('#tabs'); box.textContent = '';
    var total = Object.keys(S.counts).reduce(function (a, k) { return a + (S.counts[k] || 0); }, 0);
    TABS.forEach(function (t) {
      var n = t[0] ? S.counts[t[0]] || 0 : total;
      var b = K.el('button', t[1] + (n ? ' ' + n : ''), 'btn sm'); b.type = 'button'; b.setAttribute('aria-pressed', String(S.status === t[0]));
      b.addEventListener('click', function () { S.status = t[0]; S.page = 1; renderTabs(); load(); });
      box.appendChild(b);
    });
  }
  async function loadCounts() {
    try { S.counts = (await K.api('GET', '/online-orders/counts' + (S.branch ? '?' + branchQs() : ''), undefined, hdr())) || {}; } catch (e) { /* badges are a bonus */ }
    renderTabs();
  }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('shopping-bag')); e.appendChild(ic);
    e.appendChild(K.el('b', S.q || S.status ? 'No orders match' : 'No online orders yet'));
    e.appendChild(K.el('p', S.q || S.status ? 'Try another word or pick a different status.' : 'Orders placed on your online store will show up here by themselves.'));
    return e;
  }
  function render(rows) {
    var box = $('#list'); box.textContent = '';
    if (!rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var tb = K.el('table'), tr = K.el('tr');
    ['Order', 'Customer', 'Type', 'Total', 'Payment', 'Status', 'Placed'].forEach(function (h) { tr.appendChild(K.el('th', h, h === 'Total' ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th);
    var body = K.el('tbody');
    rows.forEach(function (o) {
      var r = K.el('tr', undefined, 'go'), c = K.el('td');
      c.appendChild(K.el('b', o.sale_number || '')); r.appendChild(c);
      var cu = K.el('td'); cu.appendChild(K.el('b', o.customer_name || '')); var ph = K.el('small', o.customer_phone || '', 'muted'); ph.style.display = 'block'; cu.appendChild(ph); r.appendChild(cu);
      r.appendChild(K.el('td', o.fulfilment_type === 'delivery' ? 'Delivery' : 'Collect'));
      r.appendChild(K.el('td', K.money(o.total), 'r num nw'));
      r.appendChild(K.el('td', (o.payment_status || '').replace(/_/g, ' '), 'muted'));
      var st = K.el('td'); st.appendChild(tag(o.fulfilment_status)); r.appendChild(st);
      r.appendChild(K.el('td', when(o.created_at), 'nw muted'));
      r.addEventListener('click', function () { openDetail(o); });
      body.appendChild(r);
    });
    tb.appendChild(body); box.appendChild(tb);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.status ? '&status=' + encodeURIComponent(S.status) : '') + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.branch ? '&' + branchQs() : '');
      var res = await K.apiFull('GET', '/online-orders' + qs, undefined, hdr());
      var rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || [];
      S.pages = (res.meta && res.meta.pages) || 1;
      render(rows);
    } catch (ex) { $('#list').textContent = ''; if (ex.message) K.notice(err, ex.status === 403 ? 'Your role does not include online orders. Ask the shop owner for access.' : ex.message, 'err'); }
  }
  function refresh() { loadCounts(); return load(true); }

  /* ---------- details ---------- */
  function amountDue(o) {
    var s = o.sale || {}, paid = (s.payments || []).reduce(function (a, p) { return a + (Number(p.amount) || 0); }, 0);
    return Math.max(0, (Number(s.total) || 0) - paid);
  }
  function actions(o) {
    var s = o.fulfilment_status, del = o.fulfilment_type === 'delivery', out = [];
    if (s === 'awaiting_payment') out.push({ k: 'pay', t: 'Record cash payment', primary: true });
    if (s === 'paid') out.push({ k: 'to', to: 'processing', t: 'Start preparing', primary: true });
    if (s === 'processing') out.push({ k: 'to', to: 'ready', t: 'Mark ready', primary: true });
    if (s === 'ready') out.push(del ? { k: 'to', to: 'out_for_delivery', t: 'Out for delivery', primary: true } : { k: 'to', to: 'completed', t: 'Mark collected', primary: true });
    if (s === 'out_for_delivery') out.push({ k: 'to', to: 'completed', t: 'Mark delivered', primary: true });
    if (s !== 'completed' && s !== 'cancelled') out.push({ k: 'cancel', t: 'Cancel order', danger: true });
    return out;
  }
  function paintDetail(o) {
    var s = o.sale || {}, del = o.fulfilment_type === 'delivery', body = $('#dBody'), foot = $('#dFoot');
    body.textContent = ''; foot.textContent = '';
    $('#dTitle').textContent = 'Order ' + (s.sale_number || '');
    var top = K.el('div', undefined, 'row'); top.appendChild(tag(o.fulfilment_status)); top.appendChild(K.el('span', 'Placed ' + when(o.created_at), 'muted')); body.appendChild(top);
    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('Customer', o.customer_name || '-')); facts.appendChild(fact('Phone', o.customer_phone || '-'));
    facts.appendChild(fact(del ? 'Deliver to' : 'Collection', del ? o.delivery_address || '-' : 'Collect in store')); facts.appendChild(fact('Total', K.money(s.total)));
    body.appendChild(facts);
    if (o.delivery_notes) body.appendChild(K.el('p', 'Delivery notes: ' + o.delivery_notes, 'muted'));
    if (o.customer_note) body.appendChild(K.el('p', 'Customer note: ' + o.customer_note, 'muted'));
    if (o.cancel_reason) body.appendChild(K.el('p', 'Cancelled: ' + o.cancel_reason, 'note err'));

    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
    ['Item', 'Qty', 'Price', 'Total'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i ? 'r' : '')); });
    var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
    (s.items || s.lines || []).forEach(function (i) {
      var r = K.el('tr'), c = K.el('td'); c.appendChild(K.el('b', i.product_name || ''));
      if (i.variant_name && i.variant_name !== 'Default') { var v = K.el('small', i.variant_name, 'muted'); v.style.display = 'block'; c.appendChild(v); }
      r.appendChild(c); r.appendChild(K.el('td', String(i.quantity), 'r num')); r.appendChild(K.el('td', K.money(i.unit_price), 'r num nw')); r.appendChild(K.el('td', K.money(i.line_total), 'r num nw')); tbody.appendChild(r);
    });
    if (Number(o.delivery_fee)) { var fr = K.el('tr'); var fc = K.el('td', 'Delivery fee'); fc.colSpan = 3; fr.appendChild(fc); fr.appendChild(K.el('td', K.money(o.delivery_fee), 'r num nw')); tbody.appendChild(fr); }
    tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);

    var pays = s.payments || [];
    body.appendChild(K.el('b', 'Payments'));
    if (!pays.length) body.appendChild(K.el('p', 'No payment recorded yet.', 'muted'));
    else { var ul = K.el('ul'); pays.forEach(function (p) { ul.appendChild(K.el('li', (p.method || p.payment_method || 'Payment') + ': ' + K.money(p.amount) + (p.status ? ' (' + p.status + ')' : ''))); }); body.appendChild(ul); }

    actions(o).forEach(function (a) {
      var b = K.el('button', a.t, 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '')); b.type = 'button';
      b.addEventListener('click', function () { act(a, b); }); foot.appendChild(b);
    });
  }
  async function openDetail(row) {
    var d = $('#detail'), body = $('#dBody'); body.textContent = ''; $('#dFoot').textContent = ''; $('#dTitle').textContent = 'Order ' + (row.sale_number || '');
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try { S.cur = await K.api('GET', '/online-orders/' + encodeURIComponent(row.id)); paintDetail(S.cur); }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', ex.message || 'We could not load that order.', 'note err')); }
  }
  async function reloadCur() { S.cur = await K.api('GET', '/online-orders/' + encodeURIComponent(S.cur.id)); paintDetail(S.cur); }
  async function setStatus(to, reason) {
    await K.api('PUT', '/online-orders/' + encodeURIComponent(S.cur.id) + '/status', reason ? { status: to, reason: reason } : { status: to });
    await reloadCur(); refresh();
  }
  async function act(a, btn) {
    if (S.busy) return;
    if (a.k === 'pay') return openPay();
    if (a.k === 'cancel') { $('#xWhy').value = ''; K.notice($('#xErr'), ''); $('#cancelDlg').showModal(); return; }
    S.busy = true; btn.disabled = true;
    try { await setStatus(a.to); K.toast('Order updated'); }
    catch (ex) { K.notice($('#listErr'), ex.message, 'err'); btn.disabled = false; }
    S.busy = false;
  }

  /* ---------- cash payment ---------- */
  function openPay() {
    var due = amountDue(S.cur); K.notice($('#pErr'), '');
    $('#pDue').textContent = K.money(due); $('#pChange').textContent = K.money(0); $('#pGot').value = due || '';
    $('#payDlg').showModal(); setTimeout(function () { $('#pGot').select(); }, 60);
  }
  $('#pGot').addEventListener('input', function () { $('#pChange').textContent = K.money(Math.max(0, K.num(this.value) - amountDue(S.cur))); });
  $('#payForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#pErr'), btn = $('#pGo'), due = amountDue(S.cur), got = K.num($('#pGot').value); K.notice(err, '');
    if (!(got > 0)) return K.notice(err, 'Enter the cash received.', 'err');
    if (got < due) return K.notice(err, 'Cash received is less than the amount due (' + K.money(due) + ').', 'err');
    K.busy(btn, true, 'Saving...');
    try {
      await K.api('POST', PAY_PATH(S.cur.sale_id), { method: 'cash', amount: due, tendered: got }, S.cur.branch_id ? { 'X-Branch-Id': S.cur.branch_id } : undefined);
      $('#payDlg').close(); K.toast('Payment recorded'); await reloadCur(); refresh();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- cancel ---------- */
  $('#cancelForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#xErr'), btn = $('#xGo'), why = $('#xWhy').value.trim(); K.notice(err, '');
    if (!why) return K.notice(err, 'Please give a reason.', 'err');
    K.busy(btn, true, 'Cancelling...');
    try { await setStatus('cancelled', why); $('#cancelDlg').close(); K.toast('Order cancelled'); }
    catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- controls ---------- */
  var t = null;
  $('#q').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { refresh(); });
  $('#branch').addEventListener('change', function () { S.branch = this.value; S.page = 1; loadCounts(); load(); });
  async function loadBranches() {
    try {
      var list = await K.branches(); if (!list || list.length < 2) return;
      var sel = $('#branch'); sel.textContent = '';
      var all = K.el('option', 'All branches'); all.value = ''; sel.appendChild(all);
      list.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
      sel.hidden = false;
    } catch (e) { /* optional */ }
  }

  /* New orders appear by themselves: poll while the page is visible and nothing is open. */
  setInterval(function () { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); });

  renderTabs(); loadBranches(); loadCounts(); load();
})();