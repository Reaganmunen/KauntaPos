/* Thermal receipt printers: window.KPrinter

   Two ways to print a receipt, chosen per device in the Printer settings dialog:
     browser  the normal print dialog, laid out for 58 mm or 80 mm paper. Works with any printer
              that is installed on the computer (USB, network, Bluetooth with a driver).
     direct   raw ESC/POS bytes sent straight to the printer: no dialog, no driver, and the paper
              is cut. Needs Chrome or Edge on a computer, and the printer connected by USB.

   KPrinter.get()             settings { width: 58|80, mode, transport, baud, auto, copies, cut }
   KPrinter.set(patch)        saves settings on this device (localStorage)
   KPrinter.openSettings()    opens the Printer settings dialog (built here, so any page can use it)
   KPrinter.escpos(data, cfg) receipt as ESC/POS bytes (Uint8Array)
   KPrinter.printReceipt(d)   sends a receipt { sale, business } to the connected printer
   KPrinter.printTest()       prints a short test receipt
   KPrinter.status()          { connected, label }
*/
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;

  var KEY = 'kaunta.printer';
  var DEFAULTS = { width: 80, mode: 'browser', transport: 'serial', baud: 9600, auto: false, copies: 1, cut: true };

  function get() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
    var o = {}, k;
    for (k in DEFAULTS) o[k] = saved[k] !== undefined ? saved[k] : DEFAULTS[k];
    o.width = Number(o.width) === 58 ? 58 : 80;
    o.mode = o.mode === 'direct' ? 'direct' : 'browser';
    o.transport = o.transport === 'usb' ? 'usb' : 'serial';
    o.baud = Number(o.baud) || 9600;
    o.copies = Math.min(Math.max(Math.floor(Number(o.copies)) || 1, 1), 3);
    o.auto = Boolean(o.auto); o.cut = o.cut !== false;
    return o;
  }
  function set(patch) {
    var next = get(), k;
    for (k in patch) next[k] = patch[k];
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode: not saved */ }
    return get();
  }
  var colsOf = function (cfg) { return (cfg || get()).width === 58 ? 32 : 48; };

  /* ---------- text helpers (printers speak plain ASCII) ---------- */
  function ascii(s) {
    var t = String(s == null ? '' : s);
    if (t.normalize) t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '?');
  }
  function wrap(text, width) {
    var words = ascii(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      while (w.length > width) {                       // a single word longer than the line
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, width)); w = w.slice(width);
      }
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }
  /* wrap, but keep the leading spaces of the text as an indent on every line */
  function indented(text, width) {
    var pad = (ascii(text).match(/^ */) || [''])[0].slice(0, 6);
    return wrap(text, Math.max(width - pad.length, 4)).map(function (l) { return pad + l; });
  }
  /* left text and right text on one line; the left wraps if it is long */
  function pair(left, right, cols) {
    left = ascii(left); right = ascii(right);
    var room = cols - right.length - 1;
    var parts = indented(left, Math.max(room, 8));
    var last = parts[parts.length - 1], out = parts.slice(0, -1);
    if (last.length + 1 + right.length <= cols) out.push(last + new Array(cols - last.length - right.length + 1).join(' ') + right);
    else { out.push(last); out.push(new Array(Math.max(cols - right.length, 0) + 1).join(' ') + right); }
    return out;
  }
  function fmt(n) {
    var v = Number(n) || 0, neg = v < 0, s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s;
  }
  function qty(n) { return String(Math.round((Number(n) || 0) * 1000) / 1000); }
  function when(d) {
    var x = new Date(d); if (isNaN(x)) return '';
    return x.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  var METHODS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', credit: 'On account', cheque: 'Cheque', other: 'Other' };
  var methodName = function (x) { return METHODS[x] || (x ? String(x).charAt(0).toUpperCase() + String(x).slice(1) : 'Payment'); };

  /* ---------- ESC/POS builder ---------- */
  function Out() {
    var bytes = [];
    this.raw = function () { for (var i = 0; i < arguments.length; i++) bytes.push(arguments[i] & 255); return this; };
    this.init = function () { return this.raw(0x1b, 0x40, 0x1b, 0x74, 0x00); };          // reset, code page 437
    this.align = function (n) { return this.raw(0x1b, 0x61, n); };                         // 0 left, 1 centre, 2 right
    this.bold = function (on) { return this.raw(0x1b, 0x45, on ? 1 : 0); };
    this.size = function (n) { return this.raw(0x1d, 0x21, n); };                           // 0 normal, 1 tall, 0x11 tall and wide
    this.feed = function (n) { return this.raw(0x1b, 0x64, n); };
    this.cut = function () { return this.raw(0x1d, 0x56, 0x01); };                          // partial cut
    this.line = function (s) {
      s = ascii(s);
      for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
      bytes.push(0x0a); return this;
    };
    this.done = function () { return new Uint8Array(bytes); };
  }

  function escpos(data, cfg) {
    cfg = cfg || get();
    var cols = colsOf(cfg), s = data.sale || {}, b = data.business || {}, o = new Out();
    var rule = new Array(cols + 1).join('-');
    var paid = (s.payments || []).filter(function (p) { return !p.status || p.status === 'completed'; });
    var balance = s.balance_due != null ? Number(s.balance_due) : Number(s.total) - Number(s.amount_paid);
    var isNote = s.sale_type === 'credit_note';

    o.init().align(1).bold(true);
    var name = ascii(b.name || ''), wide = name.length > 0 && name.length <= Math.floor(cols / 2);
    o.size(wide ? 0x11 : 0x01);
    wrap(name, wide ? Math.floor(cols / 2) : cols).forEach(function (l) { o.line(l); });
    o.size(0).bold(false);
    if (b.legal_name && b.legal_name !== b.name) wrap(b.legal_name, cols).forEach(function (l) { o.line(l); });
    if (b.kra_pin) o.line('PIN: ' + b.kra_pin);
    if (b.address) wrap(b.address, cols).forEach(function (l) { o.line(l); });
    if (b.phone) o.line('Tel: ' + b.phone);
    o.align(0).line(rule).align(1).bold(true).line(isNote ? 'CREDIT NOTE' : 'RECEIPT').bold(false).align(0);

    function detail(k, v) { if (v) pair(k, v, cols).forEach(function (l) { o.line(l); }); }
    detail('No:', s.sale_number); detail('Date:', when(s.sold_at));
    detail('Served by:', s.cashier_name); detail('Customer:', s.customer_name); detail('Table:', s.table_name);
    o.line(rule);

    (s.items || []).forEach(function (it) {
      var label = it.product_name + (it.variant_name && it.variant_name !== 'Default' ? ' (' + it.variant_name + ')' : '');
      wrap(label, cols).forEach(function (l) { o.line(l); });
      var left = '  ' + qty(it.quantity) + (it.unit_abbr ? ' ' + it.unit_abbr : '') + ' x ' + fmt(it.unit_price);
      pair(left, fmt(it.line_total), cols).forEach(function (l) { o.line(l); });
      (it.modifiers || []).forEach(function (m) { indented('  + ' + m.name, cols).forEach(function (l) { o.line(l); }); });
      if (it.promo_name && Number(it.promo_discount) > 0) pair('  Offer: ' + it.promo_name, '-' + fmt(it.promo_discount), cols).forEach(function (l) { o.line(l); });
    });
    o.line(rule);

    if (Number(s.discount_total) > 0) pair('Discount', '-' + fmt(s.discount_total), cols).forEach(function (l) { o.line(l); });
    if (Number(s.tax_total) > 0) pair(s.prices_include_tax === false ? 'VAT' : 'VAT included', fmt(s.tax_total), cols).forEach(function (l) { o.line(l); });
    o.bold(true).size(0x01);
    pair('TOTAL', 'KES ' + fmt(s.total), cols).forEach(function (l) { o.line(l); });
    o.size(0).bold(false).line(rule);

    paid.forEach(function (p) {
      pair(methodName(p.method), fmt(p.tendered || p.amount), cols).forEach(function (l) { o.line(l); });
      if (p.reference) wrap('  ' + p.reference, cols).forEach(function (l) { o.line(l); });
    });
    if (Number(s.change_due) > 0.005) pair('Change', fmt(s.change_due), cols).forEach(function (l) { o.line(l); });
    if (balance > 0.005) { o.bold(true); pair('BALANCE DUE', fmt(balance), cols).forEach(function (l) { o.line(l); }); o.bold(false); }

    if (s.kra_invoice_no || s.cu_serial_no || s.cu_invoice_no) {
      o.line(rule).align(1);
      if (s.kra_invoice_no) wrap('KRA invoice no: ' + s.kra_invoice_no, cols).forEach(function (l) { o.line(l); });
      if (s.cu_serial_no) o.line('CU serial: ' + s.cu_serial_no);
      if (s.cu_invoice_no) o.line('CU invoice: ' + s.cu_invoice_no);
      o.align(0);
    }
    if (s.status === 'void') o.align(1).bold(true).line('*** VOID ***').bold(false).align(0);
    o.line(rule).align(1);
    wrap(b.receipt_footer || 'Thank you for shopping with us.', cols).forEach(function (l) { o.line(l); });
    o.line('Powered by Kaunta').align(0);
    o.feed(cfg.cut ? 4 : 5);
    if (cfg.cut) o.cut();
    return o.done();
  }

  /* ---------- connections ---------- */
  var port = null, usbDev = null, usbIface = null, usbEp = null;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function openSerial() {
    if (port.readable || port.writable) return;
    await port.open({ baudRate: get().baud });
  }
  async function connectSerial() {
    if (!navigator.serial) throw new Error('This browser cannot reach serial printers. Use Chrome or Edge on a computer.');
    port = await navigator.serial.requestPort();
    await openSerial();
    set({ transport: 'serial' });
  }
  async function writeSerial(bytes) {
    await openSerial();
    var w = port.writable.getWriter();
    try { for (var i = 0; i < bytes.length; i += 512) await w.write(bytes.slice(i, i + 512)); }
    finally { w.releaseLock(); }
  }

  async function openUsb() {
    if (!usbDev.opened) await usbDev.open();
    if (usbDev.configuration === null) await usbDev.selectConfiguration(1);
    var pick = null;
    usbDev.configuration.interfaces.forEach(function (itf) {
      var alt = itf.alternates[0], ep = alt.endpoints.filter(function (e) { return e.direction === 'out' && e.type === 'bulk'; })[0];
      if (!ep) return;
      if (!pick || alt.interfaceClass === 7) pick = { n: itf.interfaceNumber, ep: ep.endpointNumber };
    });
    if (!pick) throw new Error('This USB device has no printer channel.');
    if (usbIface !== pick.n || !usbDev.configuration.interfaces.some(function (i) { return i.interfaceNumber === pick.n && i.claimed; })) {
      try { await usbDev.claimInterface(pick.n); }
      catch (e) { throw new Error('Windows is holding this printer with its own driver, so the browser cannot use it directly. Use "Print dialog" mode, or switch the printer to a WinUSB driver (the Zadig tool does this).'); }
    }
    usbIface = pick.n; usbEp = pick.ep;
  }
  async function connectUsb() {
    if (!navigator.usb) throw new Error('This browser cannot reach USB printers. Use Chrome or Edge on a computer.');
    usbDev = await navigator.usb.requestDevice({ filters: [] });
    await openUsb();
    set({ transport: 'usb' });
  }
  async function writeUsb(bytes) {
    await openUsb();
    for (var i = 0; i < bytes.length; i += 512) await usbDev.transferOut(usbEp, bytes.slice(i, i + 512));
  }

  /* pick up a printer this browser was already allowed to use, so staff do not reconnect every day */
  async function restore() {
    try { if (navigator.serial && !port) { var p = await navigator.serial.getPorts(); if (p.length) port = p[0]; } } catch (e) { /* ignore */ }
    try { if (navigator.usb && !usbDev) { var d = await navigator.usb.getDevices(); if (d.length) usbDev = d[0]; } } catch (e) { /* ignore */ }
  }

  function status() {
    var cfg = get();
    if (cfg.transport === 'usb') return usbDev ? { connected: true, label: 'USB printer: ' + (usbDev.productName || 'connected') } : { connected: false, label: 'No USB printer connected' };
    if (port) {
      var info = {}; try { info = port.getInfo() || {}; } catch (e) { /* ignore */ }
      return { connected: true, label: 'Serial printer' + (info.usbVendorId ? ' (USB ' + info.usbVendorId.toString(16) + ')' : '') };
    }
    return { connected: false, label: 'No printer connected' };
  }

  async function send(bytes) {
    var cfg = get();
    await restore();
    if (!status().connected) throw new Error('No printer connected. Open Printer settings and connect one.');
    for (var c = 0; c < cfg.copies; c++) {
      if (c) await wait(600);
      if (cfg.transport === 'usb') await writeUsb(bytes); else await writeSerial(bytes);
    }
  }
  function printReceipt(data) { return send(escpos(data, get())); }

  function sample() {
    var t = (K.session && K.session.tenant) || {};
    return {
      business: { name: t.name || 'Your shop', receipt_footer: 'Printer test. Thank you!' },
      sale: {
        sale_number: 'TEST-0001', sold_at: new Date().toISOString(), cashier_name: (K.session && K.session.user && K.session.user.name) || '',
        items: [
          { product_name: 'Test item with a rather long name to check wrapping', quantity: 2, unit_price: 150, line_total: 300 },
          { product_name: 'Chicken', quantity: 3, unit_price: 500, line_total: 1000, promo_name: 'Buy 2 get 1 free', promo_discount: 500 },
        ],
        discount_total: 500, tax_total: 0, total: 1300, amount_paid: 1500, change_due: 200,
        payments: [{ method: 'cash', amount: 1300, tendered: 1500 }],
      },
    };
  }
  function printTest() {
    var cfg = get(), data = sample();
    if (cfg.mode === 'direct') return printReceipt(data);
    if (window.KReceipt) { window.KReceipt.print(data); return Promise.resolve(); }
    return Promise.reject(new Error('Receipts are not loaded on this page.'));
  }

  /* ---------- settings dialog ---------- */
  function build() {
    var d = document.createElement('dialog'); d.className = 'modal'; d.id = 'kPrinterDlg';
    d.innerHTML =
      '<form method="dialog" class="dlg" novalidate>' +
        '<div class="row"><h2 class="grow">Receipt printer</h2><button class="icon-btn sm" type="button" data-x aria-label="Close"><i class="ph ph-x"></i></button></div>' +
        '<p class="muted">These settings are saved on this device only.</p>' +
        '<label class="fld"><span>Paper width</span><select data-k="width"><option value="80">80 mm (48 characters per line)</option><option value="58">58 mm (32 characters per line)</option></select></label>' +
        '<label class="fld"><span>How to print</span><select data-k="mode"><option value="browser">Print dialog (any installed printer)</option><option value="direct">Direct to a thermal printer (no dialog, auto-cut)</option></select></label>' +
        '<div data-direct>' +
          '<div class="actions"><button class="btn" type="button" data-conn="usb"><i class="ph ph-usb"></i>Connect USB printer</button><button class="btn" type="button" data-conn="serial"><i class="ph ph-plugs-connected"></i>Connect serial / Bluetooth port</button></div>' +
          '<p class="note" data-status></p>' +
          '<label class="fld"><span>Serial speed (baud)</span><select data-k="baud"><option>9600</option><option>19200</option><option>38400</option><option>57600</option><option>115200</option></select><small>Only for serial ports. Most printers use 9600 or 115200.</small></label>' +
          '<label class="fld"><span>Copies</span><select data-k="copies"><option value="1">1</option><option value="2">2 (customer and shop)</option><option value="3">3</option></select></label>' +
          '<label class="chk"><input type="checkbox" data-k="cut"><span><b>Cut the paper</b><small class="muted">Turn off if your printer has no cutter.</small></span></label>' +
        '</div>' +
        '<label class="chk"><input type="checkbox" data-k="auto"><span><b>Print after every sale</b><small class="muted">The receipt prints as soon as a sale is complete. With the print dialog, set your receipt printer as the default and start Chrome with --kiosk-printing to skip the dialog.</small></span></label>' +
        '<p class="note err" data-err hidden></p>' +
        '<div class="actions"><button class="btn" type="button" data-test><i class="ph ph-printer"></i>Print test receipt</button><button class="btn primary" type="button" data-x>Done</button></div>' +
      '</form>';
    document.body.appendChild(d);

    var q = function (s) { return d.querySelector(s); };
    var err = function (msg) { K.notice(q('[data-err]'), msg || '', msg ? 'err' : undefined); };
    function paint() {
      var cfg = get();
      d.querySelectorAll('[data-k]').forEach(function (el) {
        var v = cfg[el.dataset.k]; if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = String(v);
      });
      q('[data-direct]').hidden = cfg.mode !== 'direct';
      var st = status(), n = q('[data-status]'); n.hidden = false; n.textContent = st.label; n.className = 'note' + (st.connected ? '' : ' warn');
    }
    d.querySelectorAll('[data-k]').forEach(function (el) {
      el.addEventListener('change', function () {
        var patch = {}; patch[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; set(patch); err(''); paint();
      });
    });
    d.querySelectorAll('[data-x]').forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
    d.querySelectorAll('[data-conn]').forEach(function (b) {
      b.addEventListener('click', async function () {
        err('');
        try { if (b.dataset.conn === 'usb') await connectUsb(); else await connectSerial(); K.toast('Printer connected'); }
        catch (e) { if (e && e.name !== 'NotFoundError') err(e.message || 'Could not connect to the printer.'); }   // NotFoundError = the person closed the picker
        paint();
      });
    });
    q('[data-test]').addEventListener('click', async function () {
      err('');
      try { await printTest(); } catch (e) { err(e.message || 'The test receipt did not print.'); }
    });
    d._paint = paint;
    return d;
  }
  function openSettings() {
    var d = document.getElementById('kPrinterDlg') || build();
    restore().then(function () { d._paint(); });
    d._paint(); d.showModal();
  }

  window.KPrinter = { get: get, set: set, openSettings: openSettings, escpos: escpos, printReceipt: printReceipt, printTest: printTest, status: status, cols: colsOf };
})();
