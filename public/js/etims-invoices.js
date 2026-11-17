/* eTIMS receipts: queue and history of everything sent to KRA.
   GET /etims/status, GET /etims/invoices, GET /etims/invoices/:id,
   POST /etims/invoices/:id/retry, POST /etims/invoices/:id/submit,
   POST /etims/retry-all, POST /etims/sync-items. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('etims-invoices.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }

  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var STATUS = {
    pending: 'Waiting', submitting: 'Sending', submitted: 'Sent', failed: 'Will retry', rejected: 'Needs fixing', skipped: 'Not sent'
  };
  var TAG = { submitted: 'tag dot ok', failed: 'tag dot bad', rejected: 'tag dot bad', pending: 'tag dot wait', submitting: 'tag dot wait', skipped: 'tag dot wait' };
  var HELP = {
    pending: 'Waiting in the queue. It is sent automatically within a minute or so.',
    submitting: 'Being sent to KRA right now.',
    failed: 'KRA or Digitax could not be reached or had a problem. It will be tried again by itself.',
    rejected: 'KRA or Digitax refused this receipt. Fix the problem below, then put it back in the queue.',
    skipped: 'eTIMS was not connected when this sale was made, so nothing was sent.'
  };
  var CARDS = [
    { k: '', label: 'All', cls: '' },
    { k: 'submitted', label: 'Sent', cls: 'good' },
    { k: 'pending', label: 'Waiting', cls: '' },
    { k: 'failed', label: 'Will retry', cls: 'bad' },
    { k: 'rejected', label: 'Needs fixing', cls: 'bad' },
    { k: 'skipped', label: 'Not sent', cls: '' }
  ];
  // view: '' (all), a status, or 'problems' (failed + rejected, filtered on this page)
  var S = { page: 1, pages: 1, view: '', from: '', to: '', rows: [], counts: {}, cur: null };

  /* ---------- helpers ---------- */
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { return Number(v) || 0; }
  function nextDay(s) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function typeLabel(t) { return t === 'credit_note' ? 'Credit note' : 'Invoice'; }
  function tag(status) { return K.el('span', STATUS[status] || status || '', TAG[status] || 'tag dot'); }
  function pretty(v) { try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2); } catch (e) { return String(v); } }
  function iconButton(icon, label, fn) {
    var b = K.el('button', undefined, 'icon-btn sm'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    b.appendChild(K.icon(icon)); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); return b;
  }
  function flash(msg, kind) { K.notice($('#listErr'), kind === 'err' ? msg : '', 'err'); K.notice($('#listOk'), kind === 'ok' ? msg : '', 'ok'); }

  /* ---------- status cards ---------- */
  function paintStats() {
    var box = $('#stats'); box.textContent = '';
    var total = 0; Object.keys(S.counts).forEach(function (k) { total += num(S.counts[k]); });
    CARDS.forEach(function (c) {
      var n = c.k === '' ? total : num(S.counts[c.k]);
      var b = K.el('button', undefined, 'ei-stat ' + c.cls + (n === 0 && c.cls === 'bad' ? '' : ''));
      b.type = 'button'; b.appendChild(K.el('small', c.label)); b.appendChild(K.el('b', String(n)));
      b.setAttribute('aria-pressed', String(S.view === c.k));
      b.addEventListener('click', function () { setView(c.k); });
      box.appendChild(b);
    });
    var stuck = num(S.counts.failed) + num(S.counts.rejected);
    $('#retryAll').hidden = stuck === 0;
    $('#retryAllLabel').textContent = 'Retry all problems (' + stuck + ')';
  }
  async function loadStats() {
    try { S.counts = (await K.api('GET', '/etims/status')) || {}; } catch (ex) { S.counts = {}; }
    paintStats();
  }
  function setView(v) {
    S.view = v; S.page = 1;
    $('#sview').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === v)); });
    paintStats(); load();
  }

  /* ---------- list ---------- */
  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('seal-check')); e.appendChild(ic);
    if (S.view || S.from || S.to) { e.appendChild(K.el('b', 'Nothing matches')); e.appendChild(K.el('p', 'Try a different status or date range.')); }
    else { e.appendChild(K.el('b', 'No eTIMS receipts yet')); e.appendChild(K.el('p', 'Once eTIMS is connected, every sale shows up here after it is sent to KRA.')); }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    var rows = S.view === 'problems' ? S.rows.filter(function (r) { return r.status === 'failed' || r.status === 'rejected'; }) : S.rows;
    if (!rows.length) { box.appendChild(empty()); $('#pager').hidden = S.pages <= 1 && true; return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    ['Sale', 'Type', 'Status', 'KRA invoice no.', 'Total', 'Created', ''].forEach(function (h, i) { tr.appendChild(K.el('th', h, i === 4 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
    rows.forEach(function (x) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td', undefined, 'ei-cell'); c1.appendChild(K.el('b', x.sale_number || ''));
      if (x.last_error && x.status !== 'submitted') c1.appendChild(K.el('small', x.last_error, 'err'));
      row.appendChild(c1);
      row.appendChild(K.el('td', typeLabel(x.invoice_type), 'muted'));
      var st = K.el('td'); st.appendChild(tag(x.status));
      if (x.status === 'failed' && x.attempts) st.appendChild(K.el('small', ' try ' + x.attempts, 'muted')); row.appendChild(st);
      row.appendChild(K.el('td', x.kra_invoice_no || '', 'mono'));
      row.appendChild(K.el('td', K.money(x.total), 'r num'));
      row.appendChild(K.el('td', when(x.created_at), 'nw muted'));
      var a = K.el('td'), w = K.el('div', undefined, 'ei-actions');
      if (x.status === 'submitted') w.appendChild(iconButton('receipt', 'View receipt', function () { openReceiptFor(x.id); }));
      else if (x.status !== 'submitting') w.appendChild(iconButton('paper-plane-tilt', 'Send to KRA now', function () { quickSubmit(x); }));
      a.appendChild(w); row.appendChild(a);
      row.addEventListener('click', function () { openDetail(x.id); });
      body.appendChild(row);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function load(quiet) {
    flash('', '');
    if (!quiet) { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.view && S.view !== 'problems' ? '&status=' + encodeURIComponent(S.view) : '') +
        (S.from ? '&from=' + S.from : '') + (S.to ? '&to=' + nextDay(S.to) : '');
      var res = await K.apiFull('GET', '/etims/invoices' + qs);
      S.rows = rowsOf(res.data); S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { $('#list').textContent = ''; $('#pager').hidden = true; flash(failText(ex, 'We could not load your eTIMS receipts.'), 'err'); }
  }
  function reloadAll(quiet) { return Promise.all([loadStats(), load(quiet)]); }

  /* ---------- details ---------- */
  function paintDetail() {
    var x = S.cur, body = $('#dBody'); body.textContent = '';
    $('#dTitle').textContent = typeLabel(x.invoice_type) + ' ' + (x.sale_number || '');
    var head = K.el('p'); head.appendChild(tag(x.status)); head.appendChild(document.createTextNode(' ' + (HELP[x.status] || (x.status === 'submitted' ? 'Accepted by KRA.' : '')))); body.appendChild(head);

    if (x.last_error && x.status !== 'submitted') {
      var e = K.el('div', undefined, 'ei-err'); e.appendChild(K.el('b', x.status === 'rejected' ? 'Why it was refused' : 'Last problem')); e.appendChild(K.el('p', x.last_error)); body.appendChild(e);
    }

    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('Sale', x.sale_number || ''));
    facts.appendChild(fact('Total', K.money(x.total)));
    facts.appendChild(fact('Sold', when(x.sold_at)));
    if (x.customer_name) facts.appendChild(fact('Customer', x.customer_name));
    if (x.customer_kra_pin) facts.appendChild(fact('Customer KRA PIN', x.customer_kra_pin));
    if (x.invoice_type === 'credit_note' && x.original_sale_number) facts.appendChild(fact('Refund of', x.original_sale_number));
    if (x.refund_reason) facts.appendChild(fact('Refund reason', x.refund_reason));
    facts.appendChild(fact('Attempts', String(num(x.attempts))));
    if (x.status === 'failed' && x.next_attempt_at) facts.appendChild(fact('Next try', when(x.next_attempt_at)));
    if (x.submitted_at) facts.appendChild(fact('Sent to KRA', when(x.submitted_at)));
    if (x.kra_invoice_no) facts.appendChild(fact('KRA invoice no.', x.kra_invoice_no));
    if (x.cu_serial_no) facts.appendChild(fact('CU serial no.', x.cu_serial_no));
    if (x.cu_invoice_no) facts.appendChild(fact('CU invoice no.', x.cu_invoice_no));
    if (x.provider_reference) facts.appendChild(fact('Digitax reference', x.provider_reference));
    body.appendChild(facts);

    var items = x.items || [];
    if (items.length) {
      var t = K.el('b', 'Items'); t.style.display = 'block'; t.style.marginTop = '12px'; body.appendChild(t);
      var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
      ['Item', 'Qty', 'Price', 'Tax', 'Total'].forEach(function (h, i) { hr.appendChild(K.el('th', h, i > 0 ? 'r' : '')); });
      var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
      items.forEach(function (i) {
        var r = K.el('tr'); r.appendChild(K.el('td', i.product_name || ''));
        r.appendChild(K.el('td', String(num(i.quantity)), 'r num')); r.appendChild(K.el('td', K.money(i.unit_price), 'r num'));
        r.appendChild(K.el('td', K.money(i.tax_amount), 'r num')); r.appendChild(K.el('td', K.money(i.line_total), 'r num')); tbody.appendChild(r);
      });
      tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);
    }

    [['What we sent to KRA', x.request_payload], ['What KRA answered', x.response_payload]].forEach(function (p) {
      if (!p[1]) return;
      var d = document.createElement('details'); d.className = 'ei-json'; var s = document.createElement('summary'); s.textContent = p[0]; d.appendChild(s);
      var pre = document.createElement('pre'); pre.textContent = pretty(p[1]); d.appendChild(pre); body.appendChild(d);
    });

    $('#dReceipt').hidden = x.status !== 'submitted';
    $('#dRetry').hidden = !(x.status === 'failed' || x.status === 'rejected' || x.status === 'skipped');
    $('#dSubmit').hidden = !(x.status === 'pending' || x.status === 'failed' || x.status === 'rejected' || x.status === 'skipped');
  }
  async function openDetail(id) {
    var d = $('#detail'), body = $('#dBody'); S.cur = null; body.textContent = ''; $('#dTitle').textContent = 'eTIMS invoice';
    ['#dReceipt', '#dRetry', '#dSubmit'].forEach(function (s) { $(s).hidden = true; });
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try { S.cur = await K.api('GET', '/etims/invoices/' + encodeURIComponent(id)); }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', failText(ex, 'We could not load this invoice.'), 'note err')); return; }
    paintDetail();
  }

  /* ---------- actions ---------- */
  async function doSubmit(id, btn) {
    if (btn) K.busy(btn, true, 'Sending...');
    try {
      var r = await K.api('POST', '/etims/invoices/' + encodeURIComponent(id) + '/submit');
      var st = r && r.status;
      if (st === 'submitted') K.toast('Sent to KRA');
      else if (st === 'rejected') K.toast('KRA refused it. Open it to see why.');
      else if (st === 'failed') K.toast('Could not send yet. It will be retried.');
      else K.toast('Status: ' + (STATUS[st] || st));
      await reloadAll(true);
      if ($('#detail').open) await openDetail(id);
    } catch (ex) { K.toast(failText(ex, 'We could not send this receipt.')); }
    if (btn) K.busy(btn, false);
  }
  function quickSubmit(x) { doSubmit(x.id, null); }
  $('#dSubmit').addEventListener('click', function () { if (S.cur) doSubmit(S.cur.id, this); });
  $('#dRetry').addEventListener('click', async function () {
    if (!S.cur) return; var btn = this, id = S.cur.id; K.busy(btn, true, 'Working...');
    try { await K.api('POST', '/etims/invoices/' + encodeURIComponent(id) + '/retry'); K.toast('Put back in the queue'); await reloadAll(true); await openDetail(id); }
    catch (ex) { K.toast(failText(ex, 'We could not requeue this receipt.')); }
    K.busy(btn, false);
  });
  $('#retryAll').addEventListener('click', async function () {
    var stuck = num(S.counts.failed) + num(S.counts.rejected);
    if (!window.confirm('Put ' + stuck + ' problem receipts back in the queue? Receipts KRA refused because of bad data will fail again until the data is fixed.')) return;
    var btn = this; K.busy(btn, true, 'Working...');
    try { var r = await K.api('POST', '/etims/retry-all'); flash((r && r.requeued || 0) + ' receipts put back in the queue.', 'ok'); await reloadAll(true); }
    catch (ex) { flash(failText(ex, 'We could not retry them.'), 'err'); }
    K.busy(btn, false);
  });
  $('#syncItems').addEventListener('click', async function () {
    if (!window.confirm('Register your products with KRA now? Products must be registered before they can appear on a receipt.')) return;
    var btn = this; K.busy(btn, true, 'Registering...');
    try {
      var r = await K.api('POST', '/etims/sync-items') || {};
      if (r.failed) flash(r.synced + ' registered, ' + r.failed + ' failed. First problem: ' + ((r.errors && r.errors[0] && (r.errors[0].sku ? r.errors[0].sku + ': ' : '') + r.errors[0].error) || 'unknown') + '. Run it again to continue (200 products at a time).', 'err');
      else flash(r.synced + ' products registered with KRA.' + (r.synced >= 200 ? ' There may be more. Run it again.' : ''), 'ok');
    } catch (ex) { flash(failText(ex, 'We could not register products.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- receipt ---------- */
  function qrSvg(data) {
    try {
      if (!data || typeof window.qrcode !== 'function') return '';
      var q = window.qrcode(0, 'M'); q.addData(String(data)); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { return ''; }
  }
  function receiptHtml(x) {
    var h = '<div class="rc">';
    h += '<h3>' + (x.invoice_type === 'credit_note' ? 'CREDIT NOTE' : 'TAX INVOICE') + '</h3>';
    h += '<div class="c k">KRA eTIMS receipt</div>';
    if (x.status !== 'submitted') h += '<p class="warn">Not yet accepted by KRA. This is not a valid tax receipt.</p>';
    h += '<hr><table>';
    h += '<tr><td class="k">Sale</td><td class="r">' + esc(x.sale_number) + '</td></tr>';
    h += '<tr><td class="k">Date</td><td class="r">' + esc(when(x.sold_at)) + '</td></tr>';
    if (x.customer_name) h += '<tr><td class="k">Customer</td><td class="r">' + esc(x.customer_name) + '</td></tr>';
    if (x.customer_kra_pin) h += '<tr><td class="k">Customer PIN</td><td class="r">' + esc(x.customer_kra_pin) + '</td></tr>';
    if (x.invoice_type === 'credit_note' && x.original_sale_number) h += '<tr><td class="k">Refund of</td><td class="r">' + esc(x.original_sale_number) + '</td></tr>';
    h += '</table><hr><table>';
    (x.items || []).forEach(function (i) {
      h += '<tr><td colspan="2">' + esc(i.product_name) + '</td></tr>';
      h += '<tr><td class="k">' + esc(num(i.quantity)) + ' x ' + esc(K.money(i.unit_price)) + (num(i.discount_amount) ? ' (disc ' + esc(K.money(i.discount_amount)) + ')' : '') + '</td><td class="r">' + esc(K.money(i.line_total)) + '</td></tr>';
    });
    h += '</table><hr><table>';
    h += '<tr><td class="k">Subtotal</td><td class="r">' + esc(K.money(x.subtotal)) + '</td></tr>';
    if (num(x.discount_total)) h += '<tr><td class="k">Discount</td><td class="r">' + esc(K.money(x.discount_total)) + '</td></tr>';
    h += '<tr><td class="k">Tax</td><td class="r">' + esc(K.money(x.tax_total)) + '</td></tr>';
    h += '<tr class="t"><td>TOTAL</td><td class="r">' + esc(K.money(x.total)) + '</td></tr>';
    h += '</table><hr><table>';
    [['KRA invoice no.', x.kra_invoice_no], ['CU serial no.', x.cu_serial_no], ['CU invoice no.', x.cu_invoice_no], ['Sent to KRA', x.submitted_at ? when(x.submitted_at) : '']].forEach(function (p) {
      if (p[1]) h += '<tr><td class="k">' + esc(p[0]) + '</td><td class="r">' + esc(p[1]) + '</td></tr>';
    });
    h += '</table>';
    if (x.receipt_signature) h += '<hr><div class="k">Signature</div><div class="brk">' + esc(x.receipt_signature) + '</div>';
    var qr = qrSvg(x.qr_code_data);
    if (qr) h += '<div class="qr">' + qr + '</div>';
    else if (x.qr_code_data) h += '<hr><div class="k">Verify</div><div class="brk">' + esc(x.qr_code_data) + '</div>';
    h += '</div>';
    return h;
  }
  async function showReceipt(x) {
    S.rc = x; $('#rTitle').textContent = 'Receipt ' + (x.sale_number || '');
    $('#rcpt').innerHTML = receiptHtml(x);
    if ($('#detail').open) $('#detail').close();
    if (!$('#rcptDlg').open) $('#rcptDlg').showModal();
  }
  async function openReceiptFor(id) {
    try { await showReceipt(await K.api('GET', '/etims/invoices/' + encodeURIComponent(id))); }
    catch (ex) { K.toast(failText(ex, 'We could not load this receipt.')); }
  }
  $('#dReceipt').addEventListener('click', function () { if (S.cur) showReceipt(S.cur); });
  $('#rPrint').addEventListener('click', function () {
    if (!S.rc) return;
    var w = window.open('', '_blank', 'width=420,height=700');
    if (!w) return K.toast('Allow pop-ups for this site to print.');
    var css = 'body{margin:16px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#000}.rc{max-width:320px;margin:0 auto}.rc h3{margin:0 0 2px;font:700 15px/1.3 sans-serif;text-align:center}.c{text-align:center}hr{border:0;border-top:1px dashed #666;margin:10px 0}table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top;text-align:left}.r{text-align:right;white-space:nowrap}.t td{font-weight:700}.k{color:#444}.brk{word-break:break-all}.qr{display:flex;justify-content:center;margin:12px 0}.qr svg{width:150px;height:150px}.warn{padding:8px;border:1px solid #000;text-align:center}';
    w.document.open();
    w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ' + esc(S.rc.sale_number) + '</title><style>' + css + '</style></head><body>' + receiptHtml(S.rc) + '</body></html>');
    w.document.close(); w.focus();
    setTimeout(function () { w.print(); }, 250);
  });

  /* ---------- controls ---------- */
  function syncClear() { $('#eClear').hidden = !(S.from || S.to); }
  $('#sview').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.v); }); });
  $('#eFrom').addEventListener('change', function () { S.from = this.value; S.page = 1; syncClear(); load(); });
  $('#eTo').addEventListener('change', function () { S.to = this.value; S.page = 1; syncClear(); load(); });
  $('#eClear').addEventListener('click', function () { S.from = ''; S.to = ''; $('#eFrom').value = ''; $('#eTo').value = ''; S.page = 1; syncClear(); load(); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { reloadAll(); });
  document.querySelectorAll('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { var d = b.closest('dialog'); if (d && d.open) d.close(); }); });

  /* ---------- start ---------- */
  console.info('etims-invoices.js: loaded');
  reloadAll();
})();