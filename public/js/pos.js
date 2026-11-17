/* The till. Loads the branch's catalogue once (GET /sync/catalog), searches it on the device, keeps the
   cart in memory, and sends ONE request per sale (POST /sales) with the payment already attached.
   The server prices the sale (price lists, tax, discounts), so the total shown here is a preview;
   if the server's total differs, the cashier is told before anything is recorded.
   M-Pesa is taken by receipt code (the customer's SMS). Pay-on-phone (STK push) needs the sale to
   exist before it is paid, which this screen does not do yet. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };

  var catalog = [], cart = [], branchId = null, shift = null, shiftKnown = false;
  var saleUuid = null, lastSaleId = null, method = 'cash', due = 0;

  function hdr() { return branchId ? { 'X-Branch-Id': branchId } : {}; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function label(it) { var v = it.variant_name; return it.product_name + (v && v !== 'Default' ? ' - ' + v : ''); }
  function tracked(it) { return it.track_stock !== false && it.product_type !== 'service'; }
  function total() { return round2(cart.reduce(function (s, l) { return s + l.qty * l.price; }, 0)); }

  /* ---------- catalogue ---------- */
  async function loadCatalog() {
    var err = $('#loadErr'); K.notice(err, '');
    if (!branchId) { K.notice(err, 'Your shop has no active branch to sell from.', 'err'); return; }
    try {
      var d = await K.api('GET', '/sync/catalog', undefined, hdr());
      catalog = ((d && d.items) || []).filter(function (i) { return !i.removed; });
      catalog.sort(function (a, b) { return label(a).localeCompare(label(b)); });
      if (d && d.truncated) K.notice(err, 'You have a very large catalogue, so only the first products are loaded. Use search to find the rest.', 'ok');
    } catch (ex) { catalog = []; K.notice(err, ex.message, 'err'); }
    renderGrid();
  }

  /* The product photo, or a letter on a grey square when it has none (or the link is broken). */
  function initial(it) { var d = K.el('span', (it.product_name || '?').trim().charAt(0).toUpperCase(), 'thumb none'); d.setAttribute('aria-hidden', 'true'); return d; }
  function thumb(it) {
    if (!it.image_url) return initial(it);
    var im = K.el('img', undefined, 'thumb'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = it.image_url;
    im.addEventListener('error', function () { im.replaceWith(initial(it)); });
    return im;
  }

  function renderGrid() {
    var q = $('#q').value.trim().toLowerCase(), grid = $('#grid'), empty = $('#empty');
    var list = catalog.filter(function (i) {
      return !q || label(i).toLowerCase().indexOf(q) > -1 || (i.sku && String(i.sku).toLowerCase().indexOf(q) > -1) || (i.barcode && String(i.barcode).toLowerCase() === q);
    });
    grid.textContent = '';
    list.slice(0, 80).forEach(function (it) {
      var qty = Number(it.quantity_on_hand) || 0, t = tracked(it);
      var b = K.el('button', undefined, 'tile' + (t && qty <= 0 ? ' out' : t && qty <= 5 ? ' low' : '')); b.type = 'button'; b.setAttribute('role', 'listitem');
      b.appendChild(thumb(it));
      b.appendChild(K.el('b', it.product_name));
      if (it.variant_name && it.variant_name !== 'Default') b.appendChild(K.el('small', it.variant_name));
      b.appendChild(K.el('span', K.money(it.selling_price), 'price'));
      if (t) b.appendChild(K.el('span', qty > 0 ? qty + ' in stock' : 'Out of stock', 'stock'));
      b.addEventListener('click', function () { add(it); });
      grid.appendChild(b);
    });
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = catalog.length ? 'Nothing matches "' + $('#q').value.trim() + '".' : 'No products to sell yet. Add some on the products page.';
    $('#grid').dataset.count = String(list.length);
    return list;
  }

  $('#q').addEventListener('input', renderGrid);
  $('#q').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var q = this.value.trim().toLowerCase(); if (!q) return;
    var exact = catalog.filter(function (i) { return i.barcode && String(i.barcode).toLowerCase() === q; });
    var hit = exact[0] || (renderGrid().length === 1 ? catalog.filter(function (i) { return label(i).toLowerCase().indexOf(q) > -1 || (i.sku && String(i.sku).toLowerCase().indexOf(q) > -1); })[0] : null);
    if (hit) { add(hit); this.value = ''; renderGrid(); }
  });

  /* ---------- cart ---------- */
  function add(it) {
    var line = cart.filter(function (l) { return l.variant_id === it.variant_id; })[0];
    if (line) line.qty = round2(line.qty + 1);
    else cart.push({ variant_id: it.variant_id, name: it.product_name, variant: it.variant_name !== 'Default' ? it.variant_name : '', price: Number(it.selling_price) || 0, qty: 1 });
    saleUuid = null; K.notice($('#saleErr'), ''); renderCart();
  }
  function renderCart() {
    var ul = $('#lines'); ul.textContent = '';
    cart.forEach(function (l, i) {
      var li = K.el('li'), nm = K.el('div', l.name, 'nm');
      nm.appendChild(K.el('small', (l.variant ? l.variant + ' - ' : '') + K.money(l.price) + ' each'));
      li.appendChild(nm); li.appendChild(K.el('span', K.money(l.qty * l.price), 'lt'));
      var st = K.el('span', undefined, 'stepper'), minus = K.el('button', '-'), plus = K.el('button', '+'), inp = K.el('input');
      minus.type = 'button'; plus.type = 'button'; minus.setAttribute('aria-label', 'One less'); plus.setAttribute('aria-label', 'One more');
      inp.type = 'number'; inp.min = '0'; inp.step = 'any'; inp.value = String(l.qty); inp.setAttribute('aria-label', 'Quantity of ' + l.name);
      minus.addEventListener('click', function () { setQty(i, l.qty - 1); });
      plus.addEventListener('click', function () { setQty(i, l.qty + 1); });
      inp.addEventListener('change', function () { setQty(i, Number(inp.value)); });
      st.appendChild(minus); st.appendChild(inp); st.appendChild(plus);
      var rm = K.el('button', undefined, 'rm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + l.name); rm.innerHTML = '<i class="ph ph-trash"></i>';
      rm.addEventListener('click', function () { setQty(i, 0); });
      li.appendChild(st); li.appendChild(rm); ul.appendChild(li);
    });
    var t = total();
    $('#total').textContent = K.money(t);
    $('#cartEmpty').hidden = cart.length > 0; $('#clear').hidden = !cart.length; $('#charge').disabled = !cart.length || t <= 0;
    $('#charge').textContent = cart.length ? 'Charge ' + K.money(t) : 'Charge';
  }
  function setQty(i, q) {
    q = round2(q);
    if (!(q > 0)) cart.splice(i, 1); else cart[i].qty = q;
    saleUuid = null; renderCart();
  }
  $('#clear').addEventListener('click', function () { cart = []; saleUuid = null; K.notice($('#saleErr'), ''); renderCart(); });

  /* ---------- payment ---------- */
  function setMethod(m) {
    method = m;
    document.querySelectorAll('#methods button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.m === m)); });
    $('#paneCash').hidden = m !== 'cash'; $('#paneMpesa').hidden = m !== 'mpesa'; $('#paneCard').hidden = m !== 'card';
    K.notice($('#payErr'), '');
    var f = m === 'cash' ? $('#tendered') : m === 'mpesa' ? $('#mpRef') : $('#cardRef'); if (f) f.focus();
  }
  document.querySelectorAll('#methods button').forEach(function (b) { b.addEventListener('click', function () { setMethod(b.dataset.m); }); });

  function paintChange() { var c = K.num($('#tendered').value) - due; $('#change').textContent = K.money(c > 0 ? c : 0); }
  function paintDue() {
    $('#dueAmt').textContent = K.money(due);
    var q = $('#quick'); q.textContent = '';
    var picks = [due];
    [50, 100, 200, 500, 1000, 2000, 5000].forEach(function (n) { if (n > due && picks.length < 4) picks.push(n); });
    var up = Math.ceil(due / 100) * 100; if (up > due && picks.indexOf(up) < 0 && picks.length < 5) picks.splice(1, 0, up);
    picks.forEach(function (n, i) {
      var b = K.el('button', i === 0 ? 'Exact' : String(n), 'btn'); b.type = 'button';
      b.addEventListener('click', function () { $('#tendered').value = String(n); paintChange(); });
      q.appendChild(b);
    });
    paintChange();
  }
  $('#tendered').addEventListener('input', paintChange);

  $('#charge').addEventListener('click', function () {
    if (!cart.length) return;
    due = total(); saleUuid = saleUuid || K.uuid();
    $('#tendered').value = String(due); $('#mpRef').value = ''; $('#cardRef').value = '';
    paintDue(); setMethod('cash'); $('#payGo').disabled = false;
    $('#payDlg').showModal(); $('#tendered').select();
  });
  $('#payClose').addEventListener('click', function () { $('#payDlg').close(); });

  $('#payForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#payErr'), btn = $('#payGo'); K.notice(err, '');
    var pay = { method: method, amount: due };
    if (method === 'cash') {
      var given = K.num($('#tendered').value);
      if (given + 0.005 < due) return K.notice(err, 'The cash received is less than the amount due.', 'err');
      pay.tendered = given;
    } else if (method === 'mpesa') {
      var ref = $('#mpRef').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{8,12}$/.test(ref)) return K.notice(err, 'Enter the M-Pesa receipt code from the customer\'s message (8 to 12 letters and numbers).', 'err');
      pay.reference = ref;
    } else if ($('#cardRef').value.trim()) pay.reference = $('#cardRef').value.trim();

    btn.disabled = true; btn.textContent = 'Completing...';
    try {
      var sale = await K.api('POST', '/sales', {
        client_uuid: saleUuid || (saleUuid = K.uuid()),
        items: cart.map(function (l) { return { variant_id: l.variant_id, quantity: l.qty }; }),
        payments: [pay]
      }, hdr());
      finish(sale, pay);
    } catch (ex) {
      if (ex.code === 'payment_required' && ex.details && Number(ex.details.total) > 0) {
        due = round2(ex.details.total); paintDue(); if (method === 'cash') $('#tendered').value = String(due); paintChange();
        K.notice(err, 'The total is ' + K.money(due) + ' once tax is added. Check the amount and complete the sale again.', 'err');
      } else if (ex.code === 'shift_required') {
        $('#payDlg').close(); openShiftDialog('Your shop requires an open shift before selling.');
      } else {
        K.notice(err, ex.message + (ex.code === 'insufficient_stock' ? ' Remove it from the sale, or add stock first.' : ''), 'err');
      }
    }
    btn.disabled = false; btn.textContent = 'Complete sale';
  });

  function finish(sale, pay) {
    lastSaleId = sale.id;
    cart.forEach(function (l) { catalog.forEach(function (it) { if (it.variant_id === l.variant_id && tracked(it)) it.quantity_on_hand = (Number(it.quantity_on_hand) || 0) - l.qty; }); });
    var paid = Number(sale.total) || due, change = pay.method === 'cash' ? Math.max(K.num(pay.tendered) - paid, 0) : 0;
    $('#doneTitle').textContent = 'Sale ' + (sale.sale_number || '') + ' complete';
    $('#doneText').textContent = K.money(paid) + ' paid by ' + (pay.method === 'mpesa' ? 'M-Pesa' : pay.method) + (change > 0.005 ? '. Give change: ' + K.money(change) : '.');
    K.notice($('#doneErr'), '');
    cart = []; saleUuid = null; renderCart(); renderGrid();
    $('#payDlg').close(); $('#doneDlg').showModal(); $('#newSale').focus();
  }
  $('#newSale').addEventListener('click', function () { $('#doneDlg').close(); });
  $('#doneDlg').addEventListener('close', function () { $('#q').focus(); });

  /* ---------- receipt ---------- */
  $('#print').addEventListener('click', async function () {
    var err = $('#doneErr'); K.notice(err, '');
    try {
      var r = await K.api('GET', '/sales/' + lastSaleId + '/receipt'), s = r.sale || {}, b = r.business || {};
      var rows = (s.items || []).map(function (i) {
        return '<tr><td>' + esc(i.product_name + (i.variant_name && i.variant_name !== 'Default' ? ' - ' + i.variant_name : '')) + '<br><small>' + esc(i.quantity) + ' x ' + esc(K.money(i.unit_price)) + '</small></td><td class="r">' + esc(K.money(i.line_total)) + '</td></tr>';
      }).join('');
      var pays = (s.payments || []).map(function (p) { return '<tr><td>' + esc(String(p.method).replace(/_/g, ' ')) + '</td><td class="r">' + esc(K.money(p.tendered || p.amount)) + '</td></tr>'; }).join('');
      var html = '<!doctype html><meta charset="utf-8"><title>Receipt ' + esc(s.sale_number) + '</title><style>body{font:13px/1.4 monospace;width:72mm;margin:0 auto;padding:6px}h1{font-size:16px;text-align:center;margin:0}p{margin:2px 0;text-align:center}table{width:100%;border-collapse:collapse;margin:6px 0}td{padding:2px 0;vertical-align:top}.r{text-align:right}hr{border:0;border-top:1px dashed #000}.b{font-weight:bold;font-size:15px}</style>' +
        (b.logo_url ? '<p><img src="' + esc(b.logo_url) + '" alt="" style="max-width:50%;max-height:64px"></p>' : '') + '<h1>' + esc(b.name || '') + '</h1>' + (b.address ? '<p>' + esc(b.address) + '</p>' : '') + (b.phone ? '<p>Tel ' + esc(b.phone) + '</p>' : '') + (b.kra_pin ? '<p>PIN ' + esc(b.kra_pin) + '</p>' : '') +
        '<hr><p>Receipt ' + esc(s.sale_number) + '</p><p>' + esc(new Date(s.sold_at || Date.now()).toLocaleString('en-KE')) + '</p>' + (s.cashier_name ? '<p>Served by ' + esc(s.cashier_name) + '</p>' : '') + '<hr>' +
        '<table>' + rows + '</table><hr><table>' +
        (Number(s.discount_total) > 0 ? '<tr><td>Discount</td><td class="r">-' + esc(K.money(s.discount_total)) + '</td></tr>' : '') +
        (Number(s.tax_total) > 0 ? '<tr><td>' + (s.prices_include_tax === false ? 'Tax' : 'Includes tax') + '</td><td class="r">' + esc(K.money(s.tax_total)) + '</td></tr>' : '') +
        '<tr class="b"><td>TOTAL</td><td class="r">' + esc(K.money(s.total)) + '</td></tr>' + pays +
        (Number(s.change_due) > 0 ? '<tr><td>Change</td><td class="r">' + esc(K.money(s.change_due)) + '</td></tr>' : '') + '</table>' +
        (s.kra_invoice_no ? '<hr><p>KRA invoice ' + esc(s.kra_invoice_no) + '</p>' : '') + (b.receipt_footer ? '<hr><p>' + esc(b.receipt_footer) + '</p>' : '<hr><p>Thank you!</p>');
      var f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'; document.body.appendChild(f);
      f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
      // wait for the logo to load (at most 2 seconds) so it is on the paper
      var imgs = Array.prototype.slice.call(f.contentDocument.images);
      await Promise.race([Promise.all(imgs.map(function (im) { return im.complete ? 1 : new Promise(function (r) { im.onload = im.onerror = r; }); })), new Promise(function (r) { setTimeout(r, 2000); })]);
      f.contentWindow.focus(); f.contentWindow.print(); setTimeout(function () { f.remove(); }, 2000);
    } catch (ex) { K.notice(err, ex.message, 'err'); }
  });

  /* ---------- shift ---------- */
  function paintShift() {
    var btn = $('#shiftBtn'); btn.hidden = !shiftKnown;
    if (!shiftKnown) return;
    var at = shift && (shift.opened_at || shift.created_at);
    $('#shiftText').textContent = shift ? 'Shift open' + (at ? ' since ' + new Date(at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '') : 'Open shift';
  }
  async function loadShift() {
    try { shift = await K.api('GET', '/shifts/current'); shiftKnown = true; } catch (ex) { shiftKnown = false; /* no shift permission: sell without the chip */ }
    paintShift();
  }
  function openShiftDialog(why) {
    $('#shiftWhy').textContent = why || 'Count the cash in the drawer and enter it as your opening float.';
    K.notice($('#shiftErr'), ''); $('#shiftDlg').showModal(); $('#float').select();
  }
  $('#shiftBtn').addEventListener('click', function () { if (!shift) openShiftDialog(); });
  $('#shiftClose').addEventListener('click', function () { $('#shiftDlg').close(); });
  $('#shiftForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#shiftErr'), btn = $('#shiftGo'); K.notice(err, ''); btn.disabled = true;
    try {
      shift = await K.api('POST', '/shifts/open', { opening_float: K.num($('#float').value) }, hdr()); shiftKnown = true; paintShift();
      $('#shiftDlg').close();
      if (cart.length) $('#charge').click();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- start ---------- */
  document.addEventListener('keydown', function (e) { if (e.key === 'F2' && !$('#charge').disabled && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#charge').click(); } });
  $('#reload').addEventListener('click', loadCatalog);

  (async function () {
    renderCart();
    try {
      var list = await K.branches(), sel = $('#branch');
      branchId = list[0] ? list[0].id : null;
      if (list.length > 1) {
        list.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
        sel.value = branchId; sel.hidden = false;
        sel.addEventListener('change', function () {
          if (cart.length && !confirm('Changing branch clears the current sale. Continue?')) { sel.value = branchId; return; }
          branchId = sel.value; cart = []; saleUuid = null; renderCart(); loadCatalog();
        });
      }
    } catch (ex) { K.notice($('#loadErr'), ex.message, 'err'); }
    K.avatar($('#shopAv'), null, K.session.tenant && K.session.tenant.name); K.avatar($('#meAv'), null, K.session.user && K.session.user.name);
    K.identity().then(function (d) {
      if (!d) return;
      K.avatar($('#shopAv'), d.tenant && d.tenant.logo_url, d.tenant && d.tenant.name); if (d.tenant && d.tenant.name) $('#shopName').textContent = d.tenant.name;
      K.avatar($('#meAv'), d.user && d.user.avatar_url, d.user && d.user.full_name); $('#meName').textContent = (d.user && d.user.full_name) || '';
    });
    loadShift(); await loadCatalog(); $('#q').focus();
  })();
})();