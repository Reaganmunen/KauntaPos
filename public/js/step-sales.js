/* Sales: browse (GET /sales), open one (GET /sales/:id/receipt), print and WhatsApp the receipt (receipt.js),
   prompt the payer on their phone (POST /mpesa/stk-push, polled with GET /mpesa/transactions/:id),
   and void a sale (POST /sales/:id/void) for people who may. */
(function () {
  'use strict';
  var K = window.KApp, R = window.KReceipt; if (!K || !R) return;
  var $ = function (s) { return document.querySelector(s); };
  var S = { page: 1, pages: 1, rows: [], cur: null, user: null, poll: null, q: '' };

  var PAY = { paid: ['Paid', 'ok'], partial: ['Part paid', 'warn'], unpaid: ['Unpaid', 'bad'] };
  function payTag(s) {
    if (s.status === 'void') return K.el('span', 'Void', 'tag void');
    if (s.status === 'open') return K.el('span', 'Open tab', 'tag info');
    if (s.sale_type === 'credit_note') return K.el('span', 'Credit note', 'tag info');
    var p = PAY[s.payment_status] || [s.payment_status || 'Unknown', '']; return K.el('span', p[0], 'tag dot ' + p[1]);
  }
  function when(d, long) { var x = new Date(d); if (isNaN(x)) return ''; return x.toLocaleString('en-KE', long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function owed(s) { return s.status === 'void' || s.sale_type !== 'sale' ? 0 : Math.max(0, K.num(s.total) - K.num(s.amount_paid)); }
  function iconBtn(name, label, fn) { var b = K.el('button', undefined, 'icon-btn sm'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(K.icon(name)); b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); }); return b; }

  /* ---------- filters ---------- */
  function dayStart(v, plus) { if (!v) return ''; var d = new Date(v + 'T00:00:00+03:00'); d.setDate(d.getDate() + (plus || 0)); return d.toISOString(); }
  function filters() {
    var o = { q: S.q, from: dayStart($('#sFrom').value), to: dayStart($('#sTo').value, 1), payment_status: $('#sPay').value, sale_type: $('#sKind').value, channel: $('#sChan').value };
    return o;
  }
  function anyFilter() { var f = filters(); return Boolean(f.q || f.from || f.to || f.payment_status || f.sale_type || f.channel); }

  async function load() {
    var err = $('#listErr'); K.notice(err, '');
    var box = $('#list'); box.textContent = ''; $('#sum').hidden = true;
    for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row'));
    var f = filters(), qs = '?page=' + S.page + '&limit=25';
    Object.keys(f).forEach(function (k) { if (f[k]) qs += '&' + k + '=' + encodeURIComponent(f[k]); });
    $('#sClear').hidden = !anyFilter();
    try {
      var res = await K.apiFull('GET', '/sales' + qs);
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { box.textContent = ''; if (ex.message) K.notice(err, ex.status === 403 ? 'Your role does not include sales. Ask the shop owner for access.' : ex.message, 'err'); }
  }

  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('receipt')); e.appendChild(ic);
    if (anyFilter()) { e.appendChild(K.el('b', 'No sales match')); e.appendChild(K.el('p', 'Try other dates or clear the filters.')); }
    else { e.appendChild(K.el('b', 'No sales yet')); e.appendChild(K.el('p', 'Sales you make at the till show up here, with their receipts.')); var a = K.el('a', 'Open the till', 'btn primary'); a.href = 'pos.html'; e.appendChild(a); }
    return e;
  }

  function actionsFor(s) {
    var wrap = K.el('div', undefined, 'row-acts');
    wrap.appendChild(iconBtn('printer', 'Print receipt', function () { quick(s, 'print'); }));
    wrap.appendChild(iconBtn('whatsapp-logo', 'Share on WhatsApp', function () { quick(s, 'wa'); }));
    return wrap;
  }
  async function quick(s, what) {
    try {
      var d = await R.load(s.id);
      if (what === 'print') R.print(d); else R.whatsapp(d, s.customer_phone);
    } catch (ex) { K.toast(ex.message || 'Could not load that receipt', 'err'); }
  }

  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }

    var live = S.rows.filter(function (s) { return s.status !== 'void' && s.sale_type === 'sale'; });
    var value = live.reduce(function (a, s) { return a + K.num(s.total); }, 0), due = live.reduce(function (a, s) { return a + owed(s); }, 0);
    var sum = $('#sum'); sum.textContent = '';
    [['Sales on this page', String(live.length)], ['Value', K.money(value)], ['Still owed', K.money(due)]].forEach(function (x) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', x[0])); f.appendChild(K.el('b', x[1])); sum.appendChild(f); });
    sum.hidden = false;

    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Receipt', 'Customer', 'Served by', 'Total', 'Payment', ''].forEach(function (h) { tr.appendChild(K.el('th', h, h === 'Total' ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    var cards = K.el('div', undefined, 'sale-list');
    S.rows.forEach(function (s) {
      var r = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('span', s.sale_number, 'sale-no')); c1.appendChild(K.el('span', when(s.sold_at) + (s.channel === 'online' ? ' · Online' : ''), 'sale-sub')); r.appendChild(c1);
      var c2 = K.el('td'); c2.appendChild(K.el('span', s.customer_name || 'Walk-in', s.customer_name ? '' : 'muted')); if (s.customer_phone) c2.appendChild(K.el('span', s.customer_phone, 'sale-sub')); r.appendChild(c2);
      r.appendChild(K.el('td', s.cashier_name || '', s.cashier_name ? '' : 'muted'));
      var total = K.money(s.sale_type === 'credit_note' ? -Math.abs(K.num(s.total)) : s.total); r.appendChild(K.el('td', total, 'r num nw'));
      var c5 = K.el('td'); c5.appendChild(payTag(s)); var o = owed(s); if (o > 0 && s.payment_status !== 'unpaid') c5.appendChild(K.el('span', K.money(o) + ' due', 'sale-sub')); r.appendChild(c5);
      var c6 = K.el('td', undefined, 'r'); c6.appendChild(actionsFor(s)); r.appendChild(c6);
      r.addEventListener('click', function () { openDetail(s.id); }); body.appendChild(r);

      var c = K.el('div', undefined, 'sale-card'); c.tabIndex = 0; c.setAttribute('role', 'button');
      var top = K.el('div', undefined, 'top'); top.appendChild(K.el('span', s.sale_number, 'sale-no')); top.appendChild(K.el('b', total, 'num')); c.appendChild(top);
      c.appendChild(K.el('span', (s.customer_name || 'Walk-in') + ' · ' + when(s.sold_at), 'sale-sub'));
      var bot = K.el('div', undefined, 'row'); bot.appendChild(payTag(s)); bot.appendChild(K.el('span', undefined, 'grow')); bot.appendChild(actionsFor(s)); c.appendChild(bot);
      c.addEventListener('click', function () { openDetail(s.id); }); c.addEventListener('keydown', function (e) { if (e.key === 'Enter') openDetail(s.id); });
      cards.appendChild(c);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card); box.appendChild(cards);
    var pg = $('#pager'); pg.hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }

  var t = null;
  $('#sq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  ['#sFrom', '#sTo', '#sPay', '#sKind', '#sChan'].forEach(function (id) { $(id).addEventListener('change', function () { S.page = 1; load(); }); });
  $('#sClear').addEventListener('click', function () { $('#sq').value = ''; S.q = ''; ['#sFrom', '#sTo', '#sPay', '#sKind', '#sChan'].forEach(function (id) { $(id).value = ''; }); S.page = 1; load(); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });

  /* ---------- one sale ---------- */
  function can(key) { return Boolean(S.user) && K.can(S.user, key); }

  async function openDetail(id, keepOpen) {
    var d = $('#detail'), body = $('#dBody'); body.textContent = '';
    $('#dTitle').textContent = 'Sale'; $('#dSub').textContent = '';
    $('#dPrompt').hidden = true; $('#dPrint').disabled = true; $('#dWa').disabled = true;
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!keepOpen && !d.open) d.showModal();
    try {
      if (!S.user) { var me = await K.identity(); S.user = me && me.user; }
      S.cur = await R.load(id, true); paintDetail();
    } catch (ex) { body.textContent = ''; body.appendChild(K.el('p', ex.message || 'We could not load that sale.', 'note err')); }
  }

  function totalsRow(label, value, cls) { var r = K.el('div', undefined, cls || ''); r.appendChild(K.el('span', label)); r.appendChild(K.el('b', value, 'num')); return r; }

  function paintDetail() {
    var s = S.cur.sale, body = $('#dBody'); body.textContent = '';
    var credit = s.sale_type === 'credit_note';
    $('#dTitle').textContent = (credit ? 'Credit note ' : 'Sale ') + s.sale_number; $('#dSub').textContent = when(s.sold_at, true);

    var tags = K.el('div', undefined, 'row'); tags.style.flexWrap = 'wrap'; tags.appendChild(payTag(s));
    tags.appendChild(K.el('span', s.channel === 'online' ? 'Online order' : 'Till', 'tag'));
    if (s.etims_status) tags.appendChild(K.el('span', 'eTIMS ' + String(s.etims_status).replace(/_/g, ' '), 'tag ' + (s.etims_status === 'submitted' || s.etims_status === 'accepted' ? 'ok' : 'warn')));
    body.appendChild(tags);
    if (s.status === 'void') body.appendChild(K.el('p', 'Voided' + (s.void_reason ? ': ' + s.void_reason : '.'), 'note err'));

    var facts = K.el('div', undefined, 'facts');
    [['Customer', s.customer_name || 'Walk-in'], ['Phone', s.customer_phone || 'Not given'], ['Served by', s.cashier_name || 'Unknown'], ['Branch', s.branch_name || '']].forEach(function (x) { if (!x[1]) return; var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', x[0])); f.appendChild(K.el('b', x[1])); facts.appendChild(f); });
    body.appendChild(facts);

    var card = K.el('div', undefined, 'card flush d-lines'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
    ['Item', 'Qty', 'Price', 'Total'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i ? 'r' : '')); });
    var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
    (s.items || []).forEach(function (it) {
      var r = K.el('tr'), c = K.el('td'); c.appendChild(K.el('b', it.product_name));
      if (it.variant_name && it.variant_name !== 'Default') c.appendChild(K.el('span', it.variant_name, 'sale-sub'));
      (it.modifiers || []).forEach(function (x) { c.appendChild(K.el('span', '+ ' + x.name, 'sale-sub')); });
      r.appendChild(c); r.appendChild(K.el('td', String(K.num(it.quantity)), 'r qty')); r.appendChild(K.el('td', K.money(it.unit_price), 'r num nw')); r.appendChild(K.el('td', K.money(it.line_total), 'r num nw')); tbody.appendChild(r);
    });
    tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);

    var tot = K.el('div', undefined, 'd-tot');
    if (K.num(s.discount_total) > 0) tot.appendChild(totalsRow('Discount', '-' + K.money(s.discount_total)));
    if (K.num(s.tax_total) > 0) tot.appendChild(totalsRow('VAT included', K.money(s.tax_total)));
    tot.appendChild(totalsRow('Total', K.money(s.total), 'big'));
    (s.payments || []).filter(function (p) { return !p.status || p.status === 'completed'; }).forEach(function (p) { tot.appendChild(totalsRow(R.method(p.method) + (p.reference ? ' · ' + p.reference : ''), K.money(p.amount))); });
    if (K.num(s.change_due) > 0.005) tot.appendChild(totalsRow('Change given', K.money(s.change_due)));
    var due = R.due(s); if (due > 0 && s.status !== 'void') tot.appendChild(totalsRow('Balance due', K.money(due), 'due'));
    body.appendChild(tot);
    if (s.notes) body.appendChild(K.el('p', 'Note: ' + s.notes, 'muted'));

    /* share */
    var sh = K.el('div', undefined, 'share-row'); sh.appendChild(K.el('b', 'Send or print this receipt'));
    var row = K.el('div', undefined, 'row'), inp = K.el('input'); inp.type = 'tel'; inp.id = 'shPhone'; inp.inputMode = 'tel'; inp.placeholder = 'Customer WhatsApp number, e.g. 0712 345 678'; inp.value = s.customer_phone || ''; inp.setAttribute('aria-label', 'Customer phone number');
    row.appendChild(inp); sh.appendChild(row); sh.appendChild(K.el('small', 'Leave the number empty to choose the person inside WhatsApp.', 'muted')); body.appendChild(sh);

    if (!credit && s.status !== 'void' && can('pos.void')) {
      var v = K.el('button', 'Void this sale', 'btn danger sm'); v.type = 'button'; v.style.justifySelf = 'start'; v.addEventListener('click', openVoid); body.appendChild(v);
    }

    $('#dPrint').disabled = false; $('#dWa').disabled = false;
    $('#dPrompt').hidden = !(due > 0 && s.status !== 'void' && !credit && can('pos.sell'));
  }

  $('#dPrint').addEventListener('click', function () { if (S.cur) R.print(S.cur); });
  $('#dWa').addEventListener('click', function () {
    if (!S.cur) return; var raw = ($('#shPhone') && $('#shPhone').value) || '';
    if (raw.trim() && !R.phone(raw)) return K.toast('Enter a Kenyan number like 0712 345 678', 'err');
    R.whatsapp(S.cur, raw);
  });

  /* ---------- prompt the payer (M-Pesa STK push) ---------- */
  function pmShow(waiting) { $('#pmForm').hidden = waiting; $('#pmWait').hidden = !waiting; }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
  $('#dPrompt').addEventListener('click', function () {
    if (!S.cur) return; var s = S.cur.sale, shp = $('#shPhone');
    K.notice($('#pmErr'), ''); pmShow(false);
    $('#pmPhone').value = (shp && shp.value) || s.customer_phone || '';
    $('#pmAmount').value = String(Math.ceil(R.due(s) - 0.0001)); $('#pmAmount').max = String(Math.ceil(R.due(s) - 0.0001));
    $('#pmText').textContent = 'An M-Pesa window opens on the customer\'s phone asking for their PIN. Balance due on ' + s.sale_number + ': ' + K.money(R.due(s)) + '.';
    $('#promptModal').showModal(); setTimeout(function () { $('#pmPhone').focus(); }, 60);
  });
  $('#promptModal').addEventListener('close', stopPoll);
  $('#pmCancel').addEventListener('click', function () { stopPoll(); pmShow(false); K.notice($('#pmErr'), 'Stopped waiting. If the customer still pays, the payment will be attached to the sale once Safaricom confirms it.', 'warn'); });

  $('#pmSend').addEventListener('click', async function () {
    var btn = this, err = $('#pmErr'); K.notice(err, '');
    var s = S.cur.sale, phone = R.phone($('#pmPhone').value), amt = K.num($('#pmAmount').value);
    if (!phone) return K.notice(err, 'Enter a valid Safaricom number, e.g. 0712 345 678.', 'err');
    if (amt < 1) return K.notice(err, 'Enter the amount to ask for.', 'err');
    K.busy(btn, true, 'Sending...');
    try {
      var tx = await K.api('POST', '/mpesa/stk-push', { sale_id: s.id, phone: phone, amount: amt }, { 'X-Branch-Id': s.branch_id });
      pmShow(true); $('#pmWaitTitle').textContent = 'Waiting for ' + $('#pmPhone').value.trim();
      $('#pmWaitText').textContent = 'Ask them to check their phone and enter their M-Pesa PIN. This page updates by itself.';
      watch(tx.id);
    } catch (ex) {
      var msg = ex.message;
      if (ex.code === 'mpesa_not_configured') msg = 'M-Pesa is not set up for this shop yet. Connect your till or paybill on the M-Pesa page first.';
      K.notice(err, msg, 'err');
    }
    K.busy(btn, false);
  });

  function watch(txId) {
    stopPoll(); var tries = 0;
    S.poll = setInterval(async function () {
      tries++;
      try {
        var tx = await K.api('GET', '/mpesa/transactions/' + encodeURIComponent(txId));
        if (tx.status === 'success') {
          stopPoll(); $('#promptModal').close(); K.toast('Paid' + (tx.mpesa_receipt ? ' · ' + tx.mpesa_receipt : ''));
          if (S.cur) { R.load(S.cur.sale.id, true).then(function (d) { S.cur = d; paintDetail(); }); } load(); return;
        }
        if (tx.status === 'failed' || tx.status === 'cancelled' || tx.status === 'timeout') {
          stopPoll(); pmShow(false); K.notice($('#pmErr'), (tx.result_desc || 'The customer did not complete the payment.') + ' You can send the prompt again.', 'err'); return;
        }
      } catch (ex) { /* keep trying: a dropped connection should not end the wait */ }
      if (tries >= 40) { stopPoll(); pmShow(false); K.notice($('#pmErr'), 'We did not get an answer from the customer\'s phone. Check the sale later; if they paid, it will be attached once Safaricom confirms.', 'warn'); }
    }, 3000);
  }

  /* ---------- void ---------- */
  function openVoid() { K.notice($('#vmErr'), ''); $('#vmReason').value = ''; $('#voidModal').showModal(); setTimeout(function () { $('#vmReason').focus(); }, 60); }
  $('#vmGo').addEventListener('click', async function () {
    var btn = this, err = $('#vmErr'), reason = $('#vmReason').value.trim(); K.notice(err, '');
    if (!reason) return K.notice(err, 'Give a reason so there is a record of why.', 'err');
    K.busy(btn, true, 'Voiding...');
    try {
      await K.api('POST', '/sales/' + encodeURIComponent(S.cur.sale.id) + '/void', { reason: reason });
      $('#voidModal').close(); K.toast('Sale voided'); S.cur = await R.load(S.cur.sale.id, true); paintDetail(); load();
    } catch (ex) { K.notice(err, ex.status === 403 ? 'Your role cannot void sales.' : ex.message, 'err'); }
    K.busy(btn, false);
  });

  load();
  var open = (location.search.match(/[?&]open=([^&]+)/) || [])[1]; if (open) openDetail(decodeURIComponent(open));
})();
