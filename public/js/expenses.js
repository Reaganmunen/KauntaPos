/* Expenses: list (GET /expenses), totals by category (GET /expenses/summary),
   add/edit/delete (POST, PATCH, DELETE /expenses) and categories (see CATEGORY_PATH below). */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('expenses.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }

  // The categories CRUD route is not in the files I was given. Change this if your router mounts it elsewhere.
  var CATEGORY_PATH = '/expense-categories';

  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var METHODS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };
  var S = { page: 1, pages: 1, q: '', cat: '', from: '', to: '', rows: [], cats: [], suppliers: [], cur: null, editing: null };

  /* ---------- helpers ---------- */
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function iso(d) { return d ? String(d).slice(0, 10) : ''; }
  function day(d) { return d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function iconButton(icon, label, fn) {
    var b = K.el('button', undefined, 'icon-btn sm'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    b.appendChild(K.icon(icon)); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); return b;
  }
  function option(value, text) { var o = K.el('option', text); o.value = value; return o; }
  function safeUrl(u) { return /^(\/|https?:\/\/)/i.test(u || ''); }

  /* ---------- categories & suppliers (reference data) ---------- */
  function paintCatSelects() {
    var f = $('#eCat'), keep = S.cat; f.textContent = ''; f.appendChild(option('', 'All categories'));
    S.cats.forEach(function (c) { f.appendChild(option(c.id, c.name || '')); }); f.value = keep;
    var s = $('#fCat'), cur = s.value; s.textContent = ''; s.appendChild(option('', 'No category'));
    S.cats.forEach(function (c) { s.appendChild(option(c.id, c.name || '')); }); s.value = cur;
  }
  async function loadCats() {
    try { S.cats = rowsOf(await K.api('GET', CATEGORY_PATH)); } catch (ex) { S.cats = []; }
    paintCatSelects();
  }
  async function loadSuppliers() {
    try { S.suppliers = rowsOf(await K.api('GET', '/suppliers?limit=100&is_active=true')); } catch (ex) { S.suppliers = []; }
    var s = $('#fSupplier'), cur = s.value; s.textContent = ''; s.appendChild(option('', 'None'));
    S.suppliers.forEach(function (x) { s.appendChild(option(x.id, x.name || '')); }); s.value = cur;
  }

  /* ---------- totals ---------- */
  function rangeQuery() {
    if (S.from || S.to) return (S.from ? '&from=' + S.from : '') + (S.to ? '&to=' + S.to : '');
    return '&period=month';
  }
  function statCard(label, value, sub, main) {
    var c = K.el('div', undefined, 'ex-stat' + (main ? ' main' : '')); c.appendChild(K.el('small', label)); c.appendChild(K.el('b', value));
    if (sub) c.appendChild(K.el('span', sub, 'sub')); return c;
  }
  async function loadStats() {
    var box = $('#stats');
    try {
      var d = await K.api('GET', '/expenses/summary?' + rangeQuery().slice(1));
      var cats = (d && d.categories) || [];
      box.textContent = '';
      var label = S.from || S.to ? 'Spent in this range' : 'Spent this month';
      box.appendChild(statCard(label, K.money(Number(d && d.total) || 0), cats.reduce(function (n, c) { return n + (Number(c.count) || 0); }, 0) + ' expenses', true));
      cats.slice(0, 3).forEach(function (c) { box.appendChild(statCard(c.category || 'Uncategorised', K.money(Number(c.total) || 0), (Number(c.count) || 0) + (Number(c.count) === 1 ? ' expense' : ' expenses'))); });
      box.hidden = false;
    } catch (ex) { box.hidden = true; /* totals are optional */ }
  }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('receipt')); e.appendChild(ic);
    if (S.q || S.cat || S.from || S.to) { e.appendChild(K.el('b', 'No expenses match')); e.appendChild(K.el('p', 'Try a different search, category or date range.')); }
    else { e.appendChild(K.el('b', 'No expenses yet')); e.appendChild(K.el('p', 'Record what you spend so you can see where the money goes.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Date', 'Expense', 'Category', 'Paid by', 'Amount', ''].forEach(function (h, i) { tr.appendChild(K.el('th', h, i === 4 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    S.rows.forEach(function (x) {
      var row = K.el('tr', undefined, 'go');
      row.appendChild(K.el('td', day(x.expense_date), 'nw muted'));
      var c2 = K.el('td', undefined, 'ex-cell'); c2.appendChild(K.el('b', x.description || x.reference || 'Expense'));
      var sub = [x.supplier_name, x.description && x.reference ? x.reference : ''].filter(Boolean).join(' · '); if (sub) c2.appendChild(K.el('small', sub));
      row.appendChild(c2);
      row.appendChild(K.el('td', x.category_name || 'Uncategorised', 'muted'));
      row.appendChild(K.el('td', METHODS[x.payment_method] || x.payment_method || '', 'muted'));
      row.appendChild(K.el('td', K.money(x.amount), 'r num'));
      var a = K.el('td'), w = K.el('div', undefined, 'ex-actions'); w.appendChild(iconButton('pencil-simple', 'Edit expense', function () { openForm(x); })); a.appendChild(w); row.appendChild(a);
      row.addEventListener('click', function () { openDetail(x); });
      body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.cat ? '&category_id=' + encodeURIComponent(S.cat) : '') +
        (S.from ? '&from=' + S.from : '') + (S.to ? '&to=' + S.to : '');
      var res = await K.apiFull('GET', '/expenses' + qs);
      S.rows = rowsOf(res.data); S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; $('#pager').hidden = true; K.notice(err, failText(ex, 'We could not load your expenses.'), 'err'); }
    loadStats();
  }

  /* ---------- details ---------- */
  function openDetail(x) {
    S.cur = x; var body = $('#dBody'); body.textContent = '';
    $('#dTitle').textContent = x.description || x.reference || 'Expense';
    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('Amount', K.money(x.amount)));
    facts.appendChild(fact('Date', day(x.expense_date)));
    facts.appendChild(fact('Category', x.category_name || 'Uncategorised'));
    facts.appendChild(fact('Paid by', METHODS[x.payment_method] || x.payment_method || 'Not set'));
    if (x.supplier_name) facts.appendChild(fact('Supplier', x.supplier_name));
    if (x.reference) facts.appendChild(fact('Reference', x.reference));
    if (x.supplier_etims_invoice_no) facts.appendChild(fact('eTIMS invoice no.', x.supplier_etims_invoice_no));
    body.appendChild(facts);
    if (x.receipt_url && safeUrl(x.receipt_url)) {
      var p = K.el('p'), a = K.el('a', 'View receipt'); a.href = x.receipt_url; a.target = '_blank'; a.rel = 'noopener'; p.appendChild(a); body.appendChild(p);
    }
    if (!$('#detail').open) $('#detail').showModal();
  }

  /* ---------- add / edit ---------- */
  function openForm(x) {
    S.editing = x || null; K.notice($('#fErr'), '');
    $('#fTitle').textContent = x ? 'Edit expense' : 'Add an expense';
    $('#fAmount').value = x ? x.amount : ''; $('#fDate').value = x ? iso(x.expense_date) : today();
    paintCatSelects(); $('#fCat').value = x && x.category_id ? x.category_id : '';
    $('#fMethod').value = x && x.payment_method ? x.payment_method : 'cash';
    $('#fDesc').value = x ? x.description || '' : ''; $('#fRef').value = x ? x.reference || '' : '';
    $('#fSupplier').value = x && x.supplier_id ? x.supplier_id : '';
    $('#fEtims').value = x ? x.supplier_etims_invoice_no || '' : ''; $('#fReceipt').value = x ? x.receipt_url || '' : '';
    if ($('#detail').open) $('#detail').close();
    $('#formSheet').showModal(); setTimeout(function () { $('#fAmount').focus(); }, 60);
  }
  $('#openAdd').addEventListener('click', function () { openForm(null); });
  $('#dEdit').addEventListener('click', function () { if (S.cur) openForm(S.cur); });
  $('#expForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#fErr'), btn = $('#fSave'); K.notice(err, '');
    var amount = K.num($('#fAmount').value); if (!(amount > 0)) return K.notice(err, 'Enter an amount greater than zero.', 'err');
    var date = $('#fDate').value; if (!date) return K.notice(err, 'Choose the date of the expense.', 'err');
    var receipt = blank($('#fReceipt').value); if (receipt && !safeUrl(receipt)) return K.notice(err, 'The receipt link is not valid. It should start with https://', 'err');
    var body = {
      amount: amount, expense_date: date, category_id: $('#fCat').value || null, payment_method: $('#fMethod').value,
      description: blank($('#fDesc').value), reference: blank($('#fRef').value), supplier_id: $('#fSupplier').value || null,
      supplier_etims_invoice_no: blank($('#fEtims').value), receipt_url: receipt
    };
    K.busy(btn, true, 'Saving...');
    try {
      if (S.editing) await K.api('PATCH', '/expenses/' + encodeURIComponent(S.editing.id), body); else await K.api('POST', '/expenses', body);
      $('#formSheet').close(); K.toast('Expense saved'); if (!S.editing) S.page = 1; await load(true);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the expense.'), 'err'); }
    K.busy(btn, false);
  });
  $('#dDelete').addEventListener('click', async function () {
    var x = S.cur; if (!x) return;
    if (!window.confirm('Delete this expense of ' + K.money(x.amount) + '? This cannot be undone.')) return;
    var btn = this; K.busy(btn, true, 'Deleting...');
    try { await K.api('DELETE', '/expenses/' + encodeURIComponent(x.id)); $('#detail').close(); S.cur = null; K.toast('Expense deleted'); await load(true); }
    catch (ex) { K.toast(failText(ex, 'We could not delete the expense.')); }
    K.busy(btn, false);
  });

  /* ---------- categories manager ---------- */
  function paintCatList() {
    var box = $('#cList'); box.textContent = '';
    if (!S.cats.length) { box.appendChild(K.el('p', 'No categories yet. Add one below, for example Rent or Transport.', 'muted')); return; }
    S.cats.forEach(function (c) {
      var row = K.el('div', undefined, 'ex-cat'); row.appendChild(K.el('span', c.name || '', 'grow'));
      row.appendChild(iconButton('pencil-simple', 'Rename category', function () { renameCat(c); }));
      row.appendChild(iconButton('trash', 'Delete category', function () { removeCat(c); }));
      box.appendChild(row);
    });
  }
  $('#openCats').addEventListener('click', async function () {
    K.notice($('#cErr'), ''); $('#cName').value = ''; $('#catSheet').showModal(); await loadCats(); paintCatList();
  });
  $('#catForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#cErr'), btn = $('#cAdd'); K.notice(err, '');
    var name = $('#cName').value.trim(); if (!name) return K.notice(err, 'Enter a category name.', 'err');
    K.busy(btn, true, 'Adding...');
    try { await K.api('POST', CATEGORY_PATH, { name: name }); $('#cName').value = ''; await loadCats(); paintCatList(); }
    catch (ex) { K.notice(err, failText(ex, 'We could not add the category.'), 'err'); }
    K.busy(btn, false);
  });
  async function renameCat(c) {
    var name = window.prompt('Category name', c.name || ''); if (name === null) return;
    name = name.trim(); if (!name) return K.notice($('#cErr'), 'The category name cannot be empty.', 'err');
    try { await K.api('PATCH', CATEGORY_PATH + '/' + encodeURIComponent(c.id), { name: name }); K.notice($('#cErr'), ''); await loadCats(); paintCatList(); load(true); }
    catch (ex) { K.notice($('#cErr'), failText(ex, 'We could not rename the category.'), 'err'); }
  }
  async function removeCat(c) {
    if (!window.confirm('Delete the category "' + (c.name || '') + '"?')) return;
    try { await K.api('DELETE', CATEGORY_PATH + '/' + encodeURIComponent(c.id)); K.notice($('#cErr'), ''); if (S.cat === c.id) S.cat = ''; await loadCats(); paintCatList(); load(true); }
    catch (ex) { K.notice($('#cErr'), failText(ex, 'We could not delete the category.'), 'err'); }
  }

  /* ---------- controls ---------- */
  function syncClear() { $('#eClear').hidden = !(S.from || S.to); }
  var t = null;
  $('#eq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#eCat').addEventListener('change', function () { S.cat = this.value; S.page = 1; load(); });
  $('#eFrom').addEventListener('change', function () { S.from = this.value; S.page = 1; syncClear(); load(); });
  $('#eTo').addEventListener('change', function () { S.to = this.value; S.page = 1; syncClear(); load(); });
  $('#eClear').addEventListener('click', function () { S.from = ''; S.to = ''; $('#eFrom').value = ''; $('#eTo').value = ''; S.page = 1; syncClear(); load(); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { load(); });
  document.querySelectorAll('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { var d = b.closest('dialog'); if (d && d.open) d.close(); }); });

  /* ---------- start ---------- */
  console.info('expenses.js: loaded');
  Promise.all([loadCats(), loadSuppliers()]).then(function () { load(); });
})();