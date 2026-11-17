/* Suppliers: list (GET /suppliers), details with what you still owe (GET /suppliers/:id),
   add/edit/delete (POST, PATCH, DELETE /suppliers) and recent orders (GET /purchases?supplier_id=).
   A supplier with purchase or expense history is deactivated by the server instead of deleted. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var S = { page: 1, pages: 1, q: '', view: 'active', rows: [], cur: null, editing: null };

  var PO_STATUS = { draft: 'Draft', ordered: 'Ordered', partially_received: 'Partly received', received: 'Received', cancelled: 'Cancelled' };

  function day(d) { return d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function sectionTitle(t) { var h = K.el('b', t); h.style.display = 'block'; h.style.marginTop = '8px'; return h; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function terms(d) { var v = Number(d) || 0; return v > 0 ? v + (v === 1 ? ' day' : ' days') : 'On delivery'; }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('truck')); e.appendChild(ic);
    if (S.q) { e.appendChild(K.el('b', 'No suppliers match')); e.appendChild(K.el('p', 'Try a different name or phone number.')); }
    else if (S.view !== 'active') { e.appendChild(K.el('b', S.view === 'inactive' ? 'No inactive suppliers' : 'No suppliers yet')); e.appendChild(K.el('p', S.view === 'inactive' ? 'Every supplier is active.' : 'Add the suppliers you buy stock from.')); }
    else { e.appendChild(K.el('b', 'No suppliers yet')); e.appendChild(K.el('p', 'Add the suppliers you buy stock from, then raise purchase orders against them.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Supplier', 'Contact', 'Phone', 'Pays within', 'Status'].forEach(function (h) { tr.appendChild(K.el('th', h)); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    S.rows.forEach(function (s) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', s.name || '')); row.appendChild(c1);
      row.appendChild(K.el('td', s.contact_person || '', 'muted'));
      row.appendChild(K.el('td', s.phone || '', 'mono'));
      row.appendChild(K.el('td', terms(s.payment_terms_days), 'muted'));
      var st = K.el('td'); st.appendChild(s.is_active === false ? K.el('span', 'Inactive', 'tag dot') : K.el('span', 'Active', 'tag dot ok')); row.appendChild(st);
      row.addEventListener('click', function () { openDetail(s.id); }); body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.view === 'active' ? '&is_active=true' : S.view === 'inactive' ? '&is_active=false' : '');
      var res = await K.apiFull('GET', '/suppliers' + qs);
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; K.notice(err, failText(ex, 'We could not load your suppliers.'), 'err'); }
  }

  /* ---------- details ---------- */
  function paintDetail(orders) {
    var s = S.cur, body = $('#dBody'); body.textContent = ''; $('#dTitle').textContent = s.name || 'Supplier';
    var facts = K.el('div', undefined, 'facts'), owed = Number(s.outstanding) || 0;
    facts.appendChild(fact('You owe them', K.money(owed)));
    facts.appendChild(fact('Pays within', terms(s.payment_terms_days)));
    if (s.contact_person) facts.appendChild(fact('Contact', s.contact_person));
    if (s.phone) facts.appendChild(fact('Phone', s.phone));
    if (s.email) facts.appendChild(fact('Email', s.email));
    if (s.kra_pin) facts.appendChild(fact('KRA PIN', s.kra_pin));
    body.appendChild(facts);
    if (s.is_active === false) body.appendChild(K.el('p', 'This supplier is inactive.', 'muted'));
    if (s.address) body.appendChild(K.el('p', s.address, 'muted'));
    if (s.notes) body.appendChild(K.el('p', s.notes, 'muted'));

    if (orders && orders.length) {
      body.appendChild(sectionTitle('Recent purchase orders'));
      var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
      ['Order', 'Date', 'Total', 'Paid', 'Status'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i === 2 || i === 3 ? 'r' : '')); });
      var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
      orders.forEach(function (o) {
        var r = K.el('tr'), c = K.el('td'); c.appendChild(K.el('b', o.po_number || '')); r.appendChild(c);
        r.appendChild(K.el('td', day(o.order_date || o.created_at), 'nw muted'));
        r.appendChild(K.el('td', K.money(o.total), 'r num'));
        r.appendChild(K.el('td', K.money(o.amount_paid), 'r num'));
        r.appendChild(K.el('td', PO_STATUS[o.status] || o.status || '')); tbody.appendChild(r);
      });
      tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);
    }
  }
  async function openDetail(id) {
    var d = $('#detail'), body = $('#dBody'); S.cur = null; body.textContent = ''; $('#dTitle').textContent = 'Supplier';
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try { S.cur = await K.api('GET', '/suppliers/' + encodeURIComponent(id)); }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', failText(ex, 'We could not load this supplier.'), 'note err')); return; }
    paintDetail([]);
    var orders = [];
    try { orders = await K.api('GET', '/purchases?supplier_id=' + encodeURIComponent(id) + '&limit=10'); orders = Array.isArray(orders) ? orders : (orders && orders.rows) || []; }
    catch (e) { /* orders are optional: needs purchase access */ }
    if (S.cur && S.cur.id === id) paintDetail(orders);
  }

  /* ---------- add / edit ---------- */
  function openForm(s) {
    S.editing = s || null; K.notice($('#fErr'), '');
    $('#fTitle').textContent = s ? 'Edit supplier' : 'Add a supplier';
    $('#fName').value = s ? s.name || '' : ''; $('#fContact').value = s ? s.contact_person || '' : ''; $('#fPhone').value = s ? s.phone || '' : '';
    $('#fEmail').value = s ? s.email || '' : ''; $('#fPin').value = s ? s.kra_pin || '' : ''; $('#fAddress').value = s ? s.address || '' : '';
    $('#fTerms').value = s && Number(s.payment_terms_days) ? String(s.payment_terms_days) : ''; $('#fNotes').value = s ? s.notes || '' : '';
    $('#fActive').checked = s ? s.is_active !== false : true;
    $('#fActiveBox').hidden = !s; $('#fDelete').hidden = !s;
    if ($('#detail').open) $('#detail').close();
    $('#formSheet').showModal(); setTimeout(function () { $('#fName').focus(); }, 60);
  }
  $('#openAdd').addEventListener('click', function () { openForm(null); });
  $('#dEdit').addEventListener('click', function () { if (S.cur) openForm(S.cur); });
  $('#supForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#fErr'), btn = $('#fSave'); K.notice(err, '');
    var name = $('#fName').value.trim(); if (!name) return K.notice(err, 'Enter the supplier name.', 'err');
    var days = $('#fTerms').value === '' ? 0 : K.num($('#fTerms').value);
    if (!(days >= 0)) return K.notice(err, 'Payment terms cannot be negative.', 'err');
    var body = {
      name: name, contact_person: blank($('#fContact').value), phone: blank($('#fPhone').value), email: blank($('#fEmail').value),
      kra_pin: blank($('#fPin').value), address: blank($('#fAddress').value), notes: blank($('#fNotes').value), payment_terms_days: Math.round(days)
    };
    if (S.editing) body.is_active = $('#fActive').checked;
    K.busy(btn, true, 'Saving...');
    try {
      var saved = S.editing ? await K.api('PATCH', '/suppliers/' + encodeURIComponent(S.editing.id), body) : await K.api('POST', '/suppliers', body);
      $('#formSheet').close(); K.toast('Supplier saved'); S.page = 1; await load(true);
      if (saved && saved.id) openDetail(saved.id);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the supplier.'), 'err'); }
    K.busy(btn, false);
  });
  $('#fDelete').addEventListener('click', async function () {
    var s = S.editing; if (!s) return;
    if (!window.confirm('Delete ' + (s.name || 'this supplier') + '? If you have bought from them before, they will be made inactive instead so your records stay intact.')) return;
    var btn = this; K.busy(btn, true, 'Deleting...');
    try {
      var r = await K.api('DELETE', '/suppliers/' + encodeURIComponent(s.id));
      $('#formSheet').close(); S.cur = null;
      K.toast(r && r.deactivated ? 'Supplier has history, so it was made inactive' : 'Supplier deleted'); await load(true);
    } catch (ex) { K.notice($('#fErr'), failText(ex, 'We could not delete the supplier.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- controls ---------- */
  var t = null;
  $('#sq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#sview').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { S.view = b.dataset.v; S.page = 1; $('#sview').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); load(); });
  });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { load(); });

  load();
})();