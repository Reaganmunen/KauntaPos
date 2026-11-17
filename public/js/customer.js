/* Customers: list (GET /customers), total owed (GET /customers/owing/total), account (GET /customers/:id/statement),
   add/edit/delete (POST, PATCH, DELETE /customers), payments (POST /customers/:id/payments) and
   balance adjustments (POST /customers/:id/adjustments). The balance is never edited directly: every change is a ledger entry. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var S = { page: 1, pages: 1, q: '', owing: false, rows: [], cur: null, entries: [], editing: null, mode: 'more' };

  var TYPE = { credit_sale: 'Sold on credit', payment: 'Payment', refund: 'Refund', adjustment: 'Adjustment' };

  function n(v) { return Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 }); }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function sectionTitle(t) { var h = K.el('b', t); h.style.display = 'block'; h.style.marginTop = '8px'; return h; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function owes(c) { return Math.max(0, Number(c && c.balance) || 0); }
  function balanceTag(c) {
    var b = Number(c.balance) || 0;
    if (b > 0) return K.el('span', K.money(b), 'cu-owes');
    if (b < 0) return K.el('span', K.money(Math.abs(b)) + ' in credit', 'cu-credit');
    return K.el('span', 'Settled', 'muted');
  }

  /* ---------- total owed ---------- */
  async function loadStats() {
    var box = $('#stats'); box.hidden = true;
    try {
      var d = await K.api('GET', '/customers/owing/total');
      box.textContent = ''; box.appendChild(fact('Total owed to you', K.money(d && d.total))); box.hidden = false;
    } catch (e) { /* not every role can see this: just hide it */ }
  }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('users')); e.appendChild(ic);
    if (S.q || S.owing) { e.appendChild(K.el('b', S.owing && !S.q ? 'Nobody owes you anything' : 'No customers match')); e.appendChild(K.el('p', S.owing && !S.q ? 'Every account is settled.' : 'Try a different name or phone number.')); }
    else { e.appendChild(K.el('b', 'No customers yet')); e.appendChild(K.el('p', 'Add your regular customers so you can sell to them on credit and keep track of what they owe.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Customer', 'Phone', 'Balance', 'Credit limit', 'Status'].forEach(function (h, i) { tr.appendChild(K.el('th', h, i === 2 || i === 3 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    S.rows.forEach(function (c) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', c.name || '')); row.appendChild(c1);
      row.appendChild(K.el('td', c.phone || '', 'mono'));
      var bt = K.el('td', undefined, 'r num'); bt.appendChild(balanceTag(c)); row.appendChild(bt);
      row.appendChild(K.el('td', Number(c.credit_limit) ? K.money(c.credit_limit) : '', 'r num muted'));
      var st = K.el('td'); st.appendChild(c.is_active === false ? K.el('span', 'Inactive', 'tag dot') : K.el('span', 'Active', 'tag dot ok')); row.appendChild(st);
      row.addEventListener('click', function () { openDetail(c.id); }); body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.owing ? '&only_owing=true' : '');
      var res = await K.apiFull('GET', '/customers' + qs);
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; K.notice(err, failText(ex, 'We could not load your customers.'), 'err'); }
  }
  function refresh() { loadStats(); return load(true); }

  /* ---------- account ---------- */
  function paintDetail() {
    var c = S.cur, body = $('#dBody'); body.textContent = ''; $('#dTitle').textContent = c.name || 'Customer';
    var facts = K.el('div', undefined, 'facts'), bal = Number(c.balance) || 0;
    facts.appendChild(fact(bal < 0 ? 'In credit' : 'Owes you', K.money(Math.abs(bal))));
    if (Number(c.credit_limit)) facts.appendChild(fact('Credit limit', K.money(c.credit_limit)));
    if (c.phone) facts.appendChild(fact('Phone', c.phone));
    if (c.email) facts.appendChild(fact('Email', c.email));
    if (c.kra_pin) facts.appendChild(fact('KRA PIN', c.kra_pin));
    if (Number(c.loyalty_points)) facts.appendChild(fact('Loyalty points', n(c.loyalty_points)));
    body.appendChild(facts);
    if (c.address) body.appendChild(K.el('p', c.address, 'muted'));
    if (c.notes) body.appendChild(K.el('p', c.notes, 'muted'));

    body.appendChild(sectionTitle('Account history'));
    if (!S.entries.length) { body.appendChild(K.el('p', 'No entries yet. Credit sales and payments will show here.', 'muted')); }
    else {
      var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
      ['When', 'What', 'Amount', 'Balance after', 'Note'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i === 2 || i === 3 ? 'r' : '')); });
      var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
      S.entries.forEach(function (m) {
        var r = K.el('tr'), amt = Number(m.amount) || 0, what = TYPE[m.entry_type] || m.entry_type || '';
        if (m.sale_number) what += ' ' + m.sale_number;
        r.appendChild(K.el('td', when(m.created_at), 'nw muted')); r.appendChild(K.el('td', what));
        r.appendChild(K.el('td', (amt > 0 ? '+' : '-') + K.money(Math.abs(amt)), 'r num ' + (amt > 0 ? 'bad' : 'cu-in')));
        r.appendChild(K.el('td', m.running_balance != null ? K.money(m.running_balance) : '', 'r num'));
        r.appendChild(K.el('td', m.note || '', 'muted')); tbody.appendChild(r);
      });
      tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);
    }
    $('#dPay').hidden = owes(c) <= 0;
  }
  async function openDetail(id) {
    var d = $('#detail'), body = $('#dBody'); S.cur = null; S.entries = []; body.textContent = ''; $('#dTitle').textContent = 'Customer';
    $('#dPay').hidden = true;
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try {
      var data = await K.api('GET', '/customers/' + encodeURIComponent(id) + '/statement?limit=100');
      S.cur = data.customer; S.entries = data.entries || [];
    } catch (ex) { body.textContent = ''; body.appendChild(K.el('p', failText(ex, 'We could not load this account.'), 'note err')); return; }
    paintDetail();
  }
  async function afterChange() { if (S.cur) await openDetail(S.cur.id); await refresh(); }

  /* ---------- add / edit ---------- */
  function openForm(c) {
    S.editing = c || null; K.notice($('#fErr'), '');
    $('#fTitle').textContent = c ? 'Edit customer' : 'Add a customer';
    $('#fName').value = c ? c.name || '' : ''; $('#fPhone').value = c ? c.phone || '' : ''; $('#fEmail').value = c ? c.email || '' : '';
    $('#fPin').value = c ? c.kra_pin || '' : ''; $('#fAddress').value = c ? c.address || '' : ''; $('#fNotes').value = c ? c.notes || '' : '';
    $('#fLimit').value = c && Number(c.credit_limit) ? String(c.credit_limit) : '';
    $('#fActive').checked = c ? c.is_active !== false : true;
    $('#fActiveBox').hidden = !c; $('#fDelete').hidden = !c;
    if ($('#detail').open) $('#detail').close();
    $('#formSheet').showModal(); setTimeout(function () { $('#fName').focus(); }, 60);
  }
  $('#openAdd').addEventListener('click', function () { openForm(null); });
  $('#dEdit').addEventListener('click', function () { if (S.cur) openForm(S.cur); });
  $('#custForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#fErr'), btn = $('#fSave'); K.notice(err, '');
    var name = $('#fName').value.trim(); if (!name) return K.notice(err, 'Enter the customer name.', 'err');
    var limit = $('#fLimit').value === '' ? 0 : K.num($('#fLimit').value);
    if (!(limit >= 0)) return K.notice(err, 'The credit limit cannot be negative.', 'err');
    var body = { name: name, phone: blank($('#fPhone').value), email: blank($('#fEmail').value), kra_pin: blank($('#fPin').value), address: blank($('#fAddress').value), notes: blank($('#fNotes').value), credit_limit: limit };
    if (S.editing) body.is_active = $('#fActive').checked;
    K.busy(btn, true, 'Saving...');
    try {
      var saved = S.editing ? await K.api('PATCH', '/customers/' + encodeURIComponent(S.editing.id), body) : await K.api('POST', '/customers', body);
      $('#formSheet').close(); K.toast('Customer saved'); S.page = 1; await refresh();
      if (saved && saved.id) openDetail(saved.id);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the customer.'), 'err'); }
    K.busy(btn, false);
  });
  $('#fDelete').addEventListener('click', async function () {
    var c = S.editing; if (!c) return;
    var msg = 'Delete ' + (c.name || 'this customer') + '?' + (owes(c) > 0 ? ' They still owe ' + K.money(owes(c)) + '.' : '') + ' This cannot be undone.';
    if (!window.confirm(msg)) return;
    var btn = this; K.busy(btn, true, 'Deleting...');
    try { await K.api('DELETE', '/customers/' + encodeURIComponent(c.id)); $('#formSheet').close(); S.cur = null; K.toast('Customer deleted'); await refresh(); }
    catch (ex) { K.notice($('#fErr'), failText(ex, 'We could not delete the customer.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- receive payment ---------- */
  $('#dPay').addEventListener('click', function () {
    var c = S.cur; if (!c) return; var owed = owes(c);
    K.notice($('#yErr'), '');
    $('#yInfo').textContent = (c.name || '') + ' owes ' + K.money(owed) + '.';
    $('#yAmount').value = owed.toFixed(2); $('#yAmount').max = String(owed); $('#yMethod').value = 'cash'; $('#yRef').value = ''; $('#yNote').value = '';
    $('#detail').close(); $('#payDlg').showModal(); setTimeout(function () { $('#yAmount').focus(); $('#yAmount').select(); }, 60);
  });
  $('#payForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#yErr'), btn = $('#yGo'), amt = K.num($('#yAmount').value); K.notice(err, '');
    if (!(amt > 0)) return K.notice(err, 'Enter an amount more than zero.', 'err');
    if (amt > owes(S.cur) + 0.001) return K.notice(err, 'This customer only owes ' + K.money(owes(S.cur)) + '.', 'err');
    var body = { amount: amt, method: $('#yMethod').value };
    if ($('#yRef').value.trim()) body.reference = $('#yRef').value.trim();
    if ($('#yNote').value.trim()) body.note = $('#yNote').value.trim();
    K.busy(btn, true, 'Saving...');
    try { await K.api('POST', '/customers/' + encodeURIComponent(S.cur.id) + '/payments', body); $('#payDlg').close(); K.toast('Payment recorded'); await afterChange(); }
    catch (ex) { K.notice(err, failText(ex, 'We could not record the payment.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- adjust balance ---------- */
  function paintAdjust() {
    $('#jMode').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === S.mode)); });
    var raw = $('#jAmount').value, el = $('#jPreview');
    if (raw === '' || !S.cur) { el.textContent = ''; return; }
    var q = K.num(raw) || 0, cur = Number(S.cur.balance) || 0, next = r2(S.mode === 'more' ? cur + q : cur - q);
    el.textContent = 'Balance: ' + K.money(cur) + ' to ' + K.money(next);
  }
  $('#dAdjust').addEventListener('click', function () {
    var c = S.cur; if (!c) return;
    S.mode = 'more'; K.notice($('#jErr'), ''); $('#jAmount').value = ''; $('#jNote').value = '';
    $('#jInfo').textContent = (c.name || '') + ' - current balance ' + K.money(c.balance) + '.';
    paintAdjust(); $('#detail').close(); $('#adjDlg').showModal(); setTimeout(function () { $('#jAmount').focus(); }, 60);
  });
  $('#jMode').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { S.mode = b.dataset.m; paintAdjust(); }); });
  $('#jAmount').addEventListener('input', paintAdjust);
  $('#adjForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#jErr'), btn = $('#jGo'), q = K.num($('#jAmount').value), note = $('#jNote').value.trim(); K.notice(err, '');
    if (!(q > 0)) return K.notice(err, 'Enter an amount more than zero.', 'err');
    if (!note) return K.notice(err, 'Add a reason so the change can be traced later.', 'err');
    K.busy(btn, true, 'Saving...');
    try { await K.api('POST', '/customers/' + encodeURIComponent(S.cur.id) + '/adjustments', { amount: S.mode === 'more' ? q : -q, note: note }); $('#adjDlg').close(); K.toast('Balance adjusted'); await afterChange(); }
    catch (ex) { K.notice(err, failText(ex, 'We could not adjust the balance.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- controls ---------- */
  var t = null;
  $('#cq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#cview').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { S.owing = b.dataset.v === 'owing'; S.page = 1; $('#cview').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); load(); });
  });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { refresh(); });

  refresh();
})();