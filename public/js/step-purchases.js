/* Purchases: list (GET /purchases), details (GET /purchases/:id), create (POST /purchases), mark ordered (POST /purchases/:id/order),
   receive goods (POST /purchases/:id/receive), supplier payments (POST /purchases/:id/payments) and cancel (POST /purchases/:id/cancel).
   Stock is booked into the order's branch. Product search uses GET /inventory so every result already carries its variant id. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var S = { page: 1, pages: 1, branch: '', branchName: '', status: '', supplier: '', rows: [], cur: null, suppliers: [], lines: [], branches: [] };

  var STATUS = {
    draft: ['Draft', 'tag dot'],
    ordered: ['Ordered', 'tag dot warn'],
    partially_received: ['Partly received', 'tag dot warn'],
    received: ['Received', 'tag dot ok'],
    cancelled: ['Cancelled', 'tag dot bad']
  };
  var PAY = {
    unpaid: ['Unpaid', 'tag dot bad'],
    partial: ['Part paid', 'tag dot warn'],
    paid: ['Paid', 'tag dot ok']
  };

  function hdr() { return S.branch ? { 'X-Branch-Id': S.branch } : undefined; }
  function n(v) { return Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 }); }
  function day(d) { return d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function tag(map, key) { var m = map[key] || [key || '', 'tag dot']; return K.el('span', m[0], m[1]); }
  function itemName(r) { var v = r.variant_name && r.variant_name !== 'Default' ? ' - ' + r.variant_name : ''; return (r.product_name || r.name || 'Product') + v; }
  function sectionTitle(t) { var h = K.el('b', t); h.style.display = 'block'; h.style.marginTop = '8px'; return h; }
  function owedOf(o) { return Math.max(0, r2(Number(o.total) - Number(o.amount_paid))); }
  function asList(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data)) || []; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('package')); e.appendChild(ic);
    if (S.status || S.supplier) { e.appendChild(K.el('b', 'No purchase orders match')); e.appendChild(K.el('p', 'Try a different status or supplier.')); }
    else { e.appendChild(K.el('b', 'No purchase orders yet')); e.appendChild(K.el('p', 'Create one when you order stock from a supplier.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Order', 'Supplier', 'Date', 'Total', 'Owed', 'Status', 'Payment'].forEach(function (h, i) { tr.appendChild(K.el('th', h, i === 3 || i === 4 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    S.rows.forEach(function (o) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', o.po_number || '')); row.appendChild(c1);
      row.appendChild(K.el('td', o.supplier_name || ''));
      row.appendChild(K.el('td', day(o.order_date || o.created_at), 'nw muted'));
      row.appendChild(K.el('td', K.money(o.total), 'r num'));
      row.appendChild(K.el('td', o.status === 'cancelled' ? '' : K.money(owedOf(o)), 'r num'));
      var st = K.el('td'); st.appendChild(tag(STATUS, o.status)); row.appendChild(st);
      var pt = K.el('td'); if (o.status !== 'cancelled') pt.appendChild(tag(PAY, o.payment_status)); row.appendChild(pt);
      row.addEventListener('click', function () { openDetail(o.id); }); body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!S.branch) return;
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.status ? '&status=' + encodeURIComponent(S.status) : '') + (S.supplier ? '&supplier_id=' + encodeURIComponent(S.supplier) : '');
      var res = await K.apiFull('GET', '/purchases' + qs, undefined, hdr());
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; K.notice(err, failText(ex, 'We could not load your purchase orders.'), 'err'); }
  }

  /* ---------- details ---------- */
  function paintActions() {
    var o = S.cur || {}, st = o.status;
    $('#dOrder').hidden = st !== 'draft';
    $('#dReceive').hidden = !(st === 'ordered' || st === 'partially_received');
    $('#dPay').hidden = !(st && st !== 'cancelled' && owedOf(o) > 0);
    $('#dCancel').hidden = !(st === 'draft' || st === 'ordered');
  }
  function paintDetail() {
    var o = S.cur, body = $('#dBody'); body.textContent = '';
    $('#dTitle').textContent = o.po_number || 'Purchase order';
    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('Supplier', o.supplier_name || ''));
    facts.appendChild(fact('Branch', o.branch_name || ''));
    facts.appendChild(fact('Total', K.money(o.total)));
    facts.appendChild(fact('Paid', K.money(o.amount_paid)));
    if (o.status !== 'cancelled') facts.appendChild(fact('Still owed', K.money(owedOf(o))));
    if (o.expected_date) facts.appendChild(fact('Expected', day(o.expected_date)));
    if (o.supplier_invoice_no) facts.appendChild(fact('Supplier invoice', o.supplier_invoice_no));
    body.appendChild(facts);
    var tags = K.el('div'); tags.appendChild(tag(STATUS, o.status)); tags.appendChild(document.createTextNode(' '));
    if (o.status !== 'cancelled') tags.appendChild(tag(PAY, o.payment_status));
    body.appendChild(tags);

    body.appendChild(sectionTitle('Items'));
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
    ['Item', 'Ordered', 'Received', 'Cost', 'Tax %', 'Total'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i >= 1 ? 'r' : '')); });
    var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
    (o.items || []).forEach(function (it) {
      var r = K.el('tr'), c = K.el('td'); c.appendChild(K.el('b', itemName(it)));
      if (it.sku) c.appendChild(K.el('small', ' ' + it.sku, 'mono muted'));
      r.appendChild(c);
      r.appendChild(K.el('td', n(it.quantity_ordered), 'r num'));
      r.appendChild(K.el('td', n(it.quantity_received), 'r num'));
      r.appendChild(K.el('td', K.money(it.unit_cost), 'r num'));
      r.appendChild(K.el('td', n(it.tax_rate), 'r num muted'));
      r.appendChild(K.el('td', K.money(it.line_total), 'r num')); tbody.appendChild(r);
    });
    tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);

    var sum = K.el('div', undefined, 'facts');
    sum.appendChild(fact('Subtotal', K.money(o.subtotal))); sum.appendChild(fact('Tax', K.money(o.tax_total))); sum.appendChild(fact('Total', K.money(o.total)));
    body.appendChild(sum);
    if (o.notes) { body.appendChild(sectionTitle('Notes')); body.appendChild(K.el('p', o.notes, 'muted')); }
    paintActions();
  }
  async function openDetail(id) {
    var d = $('#detail'), body = $('#dBody'); S.cur = null; body.textContent = ''; $('#dTitle').textContent = 'Purchase order';
    ['#dOrder', '#dReceive', '#dPay', '#dCancel'].forEach(function (s) { $(s).hidden = true; });
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try { S.cur = await K.api('GET', '/purchases/' + encodeURIComponent(id), undefined, hdr()); }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', failText(ex, 'We could not load this order.'), 'note err')); return; }
    paintDetail();
  }
  async function afterChange(order) {
    if (order && order.id) await openDetail(order.id);
    await load(true);
  }

  $('#dOrder').addEventListener('click', async function () {
    var btn = this; K.busy(btn, true, 'Saving...');
    try { var o = await K.api('POST', '/purchases/' + encodeURIComponent(S.cur.id) + '/order', {}, hdr()); K.toast('Marked as ordered'); await afterChange(o); }
    catch (ex) { K.toast(failText(ex, 'We could not update the order.')); }
    K.busy(btn, false);
  });
  $('#dCancel').addEventListener('click', async function () {
    if (!window.confirm('Cancel purchase order ' + (S.cur.po_number || '') + '? This cannot be undone.')) return;
    var btn = this; K.busy(btn, true, 'Cancelling...');
    try { var o = await K.api('POST', '/purchases/' + encodeURIComponent(S.cur.id) + '/cancel', {}, hdr()); K.toast('Order cancelled'); await afterChange(o); }
    catch (ex) { K.toast(failText(ex, 'We could not cancel the order.')); }
    K.busy(btn, false);
  });

  /* ---------- receive goods ---------- */
  function openReceive() {
    var o = S.cur; if (!o) return;
    var box = $('#rBody'); box.textContent = ''; K.notice($('#rErr'), '');
    $('#rTitle').textContent = 'Receive goods - ' + (o.po_number || '');
    var any = false;
    (o.items || []).forEach(function (it) {
      var left = Number(it.quantity_ordered) - Number(it.quantity_received);
      if (!(left > 0)) return; any = true;
      var wrap = K.el('div', undefined, 'card'); wrap.dataset.item = it.id; wrap.dataset.left = String(left);
      wrap.appendChild(K.el('b', itemName(it)));
      wrap.appendChild(K.el('p', n(it.quantity_received) + ' of ' + n(it.quantity_ordered) + ' received - ' + n(left) + ' still to come', 'muted'));
      var r1 = K.el('div', undefined, 'row2');
      var l1 = K.el('label', undefined, 'fld'); l1.appendChild(K.el('span', 'Quantity received now'));
      var q = document.createElement('input'); q.type = 'number'; q.min = '0'; q.step = 'any'; q.inputMode = 'decimal'; q.className = 'rq'; q.value = String(left); l1.appendChild(q); r1.appendChild(l1);
      var l2 = K.el('label', undefined, 'fld'); l2.appendChild(K.el('span', 'Batch number'));
      var b = document.createElement('input'); b.type = 'text'; b.className = 'rb'; b.autocomplete = 'off'; b.value = it.batch_no || ''; l2.appendChild(b); r1.appendChild(l2);
      wrap.appendChild(r1);
      var l3 = K.el('label', undefined, 'fld'); l3.appendChild(K.el('span', 'Expiry date'));
      var x = document.createElement('input'); x.type = 'date'; x.className = 're'; x.value = it.expiry_date ? String(it.expiry_date).slice(0, 10) : ''; l3.appendChild(x);
      wrap.appendChild(l3);
      box.appendChild(wrap);
    });
    if (!any) { box.appendChild(K.el('p', 'Everything on this order has already been received.', 'muted')); }
    $('#rGo').disabled = !any;
    $('#detail').close(); $('#recvDlg').showModal();
  }
  $('#dReceive').addEventListener('click', openReceive);
  $('#recvForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#rErr'), btn = $('#rGo'); K.notice(err, '');
    var receipts = [], bad = false;
    $('#rBody').querySelectorAll('[data-item]').forEach(function (w) {
      var raw = w.querySelector('.rq').value; if (raw === '') return;
      var q = K.num(raw); if (!(q >= 0)) { bad = true; return; } if (q === 0) return;
      var rec = { item_id: w.dataset.item, quantity: q };
      var bn = w.querySelector('.rb').value.trim(), ex = w.querySelector('.re').value;
      if (bn) rec.batch_no = bn; if (ex) rec.expiry_date = ex;
      receipts.push(rec);
    });
    if (bad) return K.notice(err, 'Quantities cannot be negative.', 'err');
    if (!receipts.length) return K.notice(err, 'Enter the quantity that arrived for at least one item.', 'err');
    K.busy(btn, true, 'Saving...');
    try {
      var o = await K.api('POST', '/purchases/' + encodeURIComponent(S.cur.id) + '/receive', { receipts: receipts }, hdr());
      $('#recvDlg').close(); K.toast('Stock received'); await afterChange(o || S.cur);
    } catch (ex) { K.notice(err, failText(ex, 'We could not receive these goods.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- payment ---------- */
  function openPay() {
    var o = S.cur; if (!o) return; var owed = owedOf(o);
    K.notice($('#yErr'), '');
    $('#yInfo').textContent = (o.po_number || '') + ' - ' + (o.supplier_name || '') + '. Still owed: ' + K.money(owed) + '.';
    $('#yAmount').value = owed.toFixed(2); $('#yAmount').max = String(owed);
    $('#detail').close(); $('#payDlg').showModal(); setTimeout(function () { $('#yAmount').focus(); $('#yAmount').select(); }, 60);
  }
  $('#dPay').addEventListener('click', openPay);
  $('#payForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#yErr'), btn = $('#yGo'), amt = K.num($('#yAmount').value); K.notice(err, '');
    if (!(amt > 0)) return K.notice(err, 'Enter an amount more than zero.', 'err');
    if (amt > owedOf(S.cur) + 0.001) return K.notice(err, 'Only ' + K.money(owedOf(S.cur)) + ' is still owed on this order.', 'err');
    K.busy(btn, true, 'Saving...');
    try {
      var o = await K.api('POST', '/purchases/' + encodeURIComponent(S.cur.id) + '/payments', { amount: amt }, hdr());
      $('#payDlg').close(); K.toast('Payment recorded'); await afterChange(o || S.cur);
    } catch (ex) { K.notice(err, failText(ex, 'We could not record the payment.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- new order ---------- */
  function totals() {
    var sub = 0, tax = 0;
    S.lines.forEach(function (l) { var t = r2((Number(l.qty) || 0) * (Number(l.cost) || 0)); sub += t; tax += t * (Number(l.tax) || 0) / 100; });
    sub = r2(sub); tax = r2(tax);
    var box = $('#nTotals'); box.textContent = '';
    box.appendChild(fact('Subtotal', K.money(sub))); box.appendChild(fact('Tax', K.money(tax))); box.appendChild(fact('Total', K.money(r2(sub + tax))));
  }
  function lineInput(label, type, value, onInput, step) {
    var l = K.el('label', undefined, 'fld'); l.appendChild(K.el('span', label));
    var i = document.createElement('input'); i.type = type; i.min = '0'; i.step = step || 'any'; i.inputMode = 'decimal'; i.value = value; i.addEventListener('input', function () { onInput(i.value); totals(); }); l.appendChild(i); return l;
  }
  function paintLines() {
    var box = $('#nLines'); box.textContent = ''; $('#nNoLines').hidden = S.lines.length > 0;
    S.lines.forEach(function (l, idx) {
      var card = K.el('div', undefined, 'card'), top = K.el('div', undefined, 'row');
      var t = K.el('b', l.label, 'grow'); top.appendChild(t);
      var rm = K.el('button', undefined, 'icon-btn sm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + l.label); rm.appendChild(K.icon('trash'));
      rm.addEventListener('click', function () { S.lines.splice(idx, 1); paintLines(); }); top.appendChild(rm);
      card.appendChild(top);
      var g = K.el('div', undefined, 'row2');
      g.appendChild(lineInput('Quantity', 'number', l.qty, function (v) { l.qty = v; }));
      g.appendChild(lineInput('Cost each (KES)', 'number', l.cost, function (v) { l.cost = v; }, '0.01'));
      card.appendChild(g);
      card.appendChild(lineInput('Tax rate (%)', 'number', l.tax, function (v) { l.tax = v; }));
      box.appendChild(card);
    });
    totals();
  }
  function addLine(r) {
    var existing = S.lines.filter(function (l) { return l.variant_id === r.variant_id; })[0];
    if (existing) { existing.qty = String((Number(existing.qty) || 0) + 1); }
    else S.lines.push({ variant_id: r.variant_id, label: itemName(r), qty: '1', cost: r.cost_price != null ? String(r.cost_price) : '', tax: '0' });
    $('#nSearch').value = ''; $('#nResults').hidden = true; $('#nResults').textContent = '';
    paintLines();
  }
  var st = null;
  $('#nSearch').addEventListener('input', function () {
    clearTimeout(st); var v = this.value.trim(), res = $('#nResults');
    if (!v) { res.hidden = true; res.textContent = ''; return; }
    st = setTimeout(async function () {
      try {
        var r = await K.apiFull('GET', '/inventory?branch_id=' + encodeURIComponent(S.branch) + '&page=1&limit=8&q=' + encodeURIComponent(v), undefined, hdr());
        var rows = asList(r.data); res.textContent = '';
        if (!rows.length) { var li0 = K.el('li', 'No products match.', 'muted'); res.appendChild(li0); res.hidden = false; return; }
        rows.forEach(function (row) {
          var li = K.el('li'), b = K.el('button', undefined, 'link'); b.type = 'button';
          b.textContent = itemName(row) + (row.sku ? ' (' + row.sku + ')' : '');
          b.addEventListener('click', function () { addLine(row); }); li.appendChild(b); res.appendChild(li);
        });
        res.hidden = false;
      } catch (ex) { res.textContent = ''; res.appendChild(K.el('li', failText(ex, 'Search failed.'), 'note err')); res.hidden = false; }
    }, 260);
  });
  function openNew() {
    S.lines = []; K.notice($('#nErr'), '');
    $('#nSupplier').value = ''; $('#nExpected').value = ''; $('#nInvoice').value = ''; $('#nNotes').value = ''; $('#nOrdered').checked = false;
    $('#nSearch').value = ''; $('#nResults').hidden = true; $('#nResults').textContent = '';
    $('#nBranchName').value = S.branchName;
    paintLines(); $('#newSheet').showModal();
  }
  $('#openNew').addEventListener('click', openNew);
  $('#newForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#nErr'), btn = $('#nSave'); K.notice(err, '');
    if (!$('#nSupplier').value) return K.notice(err, 'Choose a supplier.', 'err');
    if (!S.lines.length) return K.notice(err, 'Add at least one item.', 'err');
    var items = [];
    for (var i = 0; i < S.lines.length; i++) {
      var l = S.lines[i], q = K.num(l.qty), c = K.num(l.cost), t = K.num(l.tax || 0);
      if (!(q > 0)) return K.notice(err, 'Enter a quantity for ' + l.label + '.', 'err');
      if (l.cost === '' || !(c >= 0)) return K.notice(err, 'Enter the cost for ' + l.label + '.', 'err');
      if (!(t >= 0)) return K.notice(err, 'The tax rate for ' + l.label + ' cannot be negative.', 'err');
      items.push({ variant_id: l.variant_id, quantity_ordered: q, unit_cost: c, tax_rate: t });
    }
    var body = {
      supplier_id: $('#nSupplier').value, branch_id: S.branch,
      expected_date: $('#nExpected').value || undefined, supplier_invoice_no: $('#nInvoice').value.trim() || undefined,
      notes: $('#nNotes').value.trim() || undefined, status: $('#nOrdered').checked ? 'ordered' : 'draft', items: items
    };
    K.busy(btn, true, 'Saving...');
    try {
      var o = await K.api('POST', '/purchases', body, hdr());
      $('#newSheet').close(); K.toast('Purchase order saved'); S.page = 1; await load(true);
      if (o && o.id) openDetail(o.id);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the order.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- controls ---------- */
  $('#pstatus').addEventListener('change', function () { S.status = this.value; S.page = 1; load(); });
  $('#psupplier').addEventListener('change', function () { S.supplier = this.value; S.page = 1; load(); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { load(); });
  $('#branch').addEventListener('change', function () {
    S.branch = this.value; S.branchName = this.options[this.selectedIndex].textContent; S.page = 1; load();
  });

  async function loadSuppliers() {
    try {
      S.suppliers = asList(await K.api('GET', '/suppliers?limit=200', undefined, hdr()));
      ['#psupplier', '#nSupplier'].forEach(function (s) {
        var sel = $(s), keep = sel.firstElementChild; sel.textContent = ''; sel.appendChild(keep);
        S.suppliers.forEach(function (x) { var o = K.el('option', x.name); o.value = x.id; sel.appendChild(o); });
      });
    } catch (e) { /* the supplier filter is optional; the new-order form will show an empty list */ }
  }

  async function start() {
    var list = [];
    try { list = (await K.branches()) || []; } catch (e) { /* handled below */ }
    if (!list.length) { K.notice($('#listErr'), 'Your shop has no branch you can view purchases for.', 'err'); return; }
    var sel = $('#branch'); sel.textContent = '';
    list.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
    sel.hidden = list.length < 2; S.branch = list[0].id; S.branchName = list[0].name || '';
    loadSuppliers(); load();
  }
  start();
})();