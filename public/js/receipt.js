/* Receipts, shared by any page: window.KReceipt
   load(id)               GET /sales/:id/receipt, returns { sale, business }
   print(data)            prints a narrow (80 mm) receipt through a hidden frame; "Save as PDF" is in the print window
   text(data)             plain-text receipt, with WhatsApp bold markers
   whatsapp(data, phone)  opens WhatsApp with the receipt typed in (phone optional: WhatsApp then asks who to send to)
   phone(raw)             0712 345 678 / +254712345678 / 712345678 -> 254712345678, or '' when it is not a phone number */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var cache = {};

  function num(v) { return K.num(v); }
  function m(v) { return K.money(v); }
  function when(d) { var x = new Date(d); return isNaN(x) ? '' : x.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  var METHODS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', credit: 'On account', cheque: 'Cheque', other: 'Other' };
  function method(x) { return METHODS[x] || (x ? String(x).charAt(0).toUpperCase() + String(x).slice(1) : 'Payment'); }
  function title(s) { return s.sale_type === 'credit_note' ? 'Credit note' : 'Receipt'; }
  function lineName(it) { return it.product_name + (it.variant_name && it.variant_name !== 'Default' ? ' (' + it.variant_name + ')' : ''); }
  function paidPayments(s) { return (s.payments || []).filter(function (p) { return !p.status || p.status === 'completed'; }); }
  function due(s) { var b = s.balance_due != null ? num(s.balance_due) : num(s.total) - num(s.amount_paid); return b > 0.005 ? b : 0; }

  async function load(id, fresh) {
    if (!fresh && cache[id]) return cache[id];
    var d = await K.api('GET', '/sales/' + encodeURIComponent(id) + '/receipt');
    cache[id] = d; return d;
  }

  function phone(raw) {
    var d = String(raw || '').replace(/[^\d]/g, '');
    if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
    if (/^[17]\d{8}$/.test(d)) return '254' + d;
    if (/^254[17]\d{8}$/.test(d)) return d;
    return '';
  }

  function text(data) {
    var s = data.sale, b = data.business || {}, L = [];
    L.push('*' + (b.name || 'Receipt') + '*');
    if (b.phone) L.push(b.phone);
    L.push('');
    L.push(title(s) + ' ' + s.sale_number);
    L.push(when(s.sold_at));
    if (s.customer_name) L.push('Customer: ' + s.customer_name);
    L.push('');
    (s.items || []).forEach(function (it) { L.push(num(it.quantity) + (it.unit_abbr ? ' ' + it.unit_abbr : '') + ' x ' + lineName(it) + ' - ' + m(it.line_total)); });
    L.push('');
    if (num(s.discount_total) > 0) L.push('Discount: -' + m(s.discount_total));
    if (num(s.tax_total) > 0) L.push('VAT: ' + m(s.tax_total));
    L.push('*Total: ' + m(s.total) + '*');
    paidPayments(s).forEach(function (p) { L.push(method(p.method) + ': ' + m(p.amount)); });
    if (num(s.change_due) > 0.005) L.push('Change: ' + m(s.change_due));
    if (due(s) > 0) L.push('*Balance due: ' + m(due(s)) + '*');
    if (s.kra_invoice_no) L.push('', 'KRA invoice no: ' + s.kra_invoice_no);
    L.push('', b.receipt_footer || 'Thank you for shopping with us.');
    return L.join('\n');
  }

  function whatsapp(data, raw) {
    var p = phone(raw), url = 'https://wa.me/' + (p || '') + '?text=' + encodeURIComponent(text(data));
    window.open(url, '_blank', 'noopener');
  }

  function html(data) {
    var s = data.sale, b = data.business || {}, e = K.esc;
    var lines = (s.items || []).map(function (it) {
      var mods = (it.modifiers || []).map(function (x) { return '<div class="sm">+ ' + e(x.name) + '</div>'; }).join('');
      return '<tr><td colspan="2">' + e(lineName(it)) + mods + '</td></tr>' +
        '<tr><td class="sm">' + num(it.quantity) + (it.unit_abbr ? ' ' + e(it.unit_abbr) : '') + ' x ' + e(m(it.unit_price)) + (it.unit_abbr ? ' / ' + e(it.unit_abbr) : '') + (num(it.discount_amount) > 0 ? ' (-' + e(m(it.discount_amount)) + ')' : '') + '</td><td class="r">' + e(m(it.line_total)) + '</td></tr>';
    }).join('');
    var pays = paidPayments(s).map(function (p) { return '<tr><td>' + e(method(p.method)) + (p.reference ? ' <span class="sm">' + e(p.reference) + '</span>' : '') + '</td><td class="r">' + e(m(p.amount)) + '</td></tr>'; }).join('');
    var legal = [b.legal_name && b.legal_name !== b.name ? e(b.legal_name) : '', b.kra_pin ? 'PIN: ' + e(b.kra_pin) : '', b.address ? e(b.address) : '', b.phone ? 'Tel: ' + e(b.phone) : ''].filter(Boolean).join('<br>');
    var kra = s.kra_invoice_no || s.cu_serial_no ? '<hr><div class="sm c">' + (s.kra_invoice_no ? 'KRA invoice no: ' + e(s.kra_invoice_no) + '<br>' : '') + (s.cu_serial_no ? 'CU serial: ' + e(s.cu_serial_no) + '<br>' : '') + (s.cu_invoice_no ? 'CU invoice: ' + e(s.cu_invoice_no) : '') + '</div>' : '';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + e(title(s) + ' ' + s.sale_number) + '</title><style>' +
      '@page{size:80mm auto;margin:4mm}*{box-sizing:border-box}body{margin:0;font:12.5px/1.35 "Courier New",ui-monospace,monospace;color:#000;width:72mm}' +
      'h1{font-size:16px;margin:0 0 2px;text-align:center}.c{text-align:center}.sm{font-size:11px;color:#333}.r{text-align:right;white-space:nowrap}' +
      'table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}hr{border:0;border-top:1px dashed #000;margin:6px 0}' +
      '.big td{font-size:15px;font-weight:bold;padding-top:3px}.logo{display:block;margin:0 auto 4px;max-width:36mm;max-height:18mm}' +
      '</style></head><body>' +
      (b.logo_url && /^https?:|^data:image\//.test(b.logo_url) ? '<img class="logo" src="' + e(b.logo_url) + '" alt="">' : '') +
      '<h1>' + e(b.name || '') + '</h1><div class="c sm">' + legal + '</div><hr>' +
      '<div class="c"><b>' + e(title(s).toUpperCase()) + '</b></div>' +
      '<table><tr><td>No:</td><td class="r">' + e(s.sale_number) + '</td></tr><tr><td>Date:</td><td class="r">' + e(when(s.sold_at)) + '</td></tr>' +
      (s.cashier_name ? '<tr><td>Served by:</td><td class="r">' + e(s.cashier_name) + '</td></tr>' : '') +
      (s.customer_name ? '<tr><td>Customer:</td><td class="r">' + e(s.customer_name) + '</td></tr>' : '') +
      (s.table_name ? '<tr><td>Table:</td><td class="r">' + e(s.table_name) + '</td></tr>' : '') + '</table><hr>' +
      '<table>' + lines + '</table><hr><table>' +
      (num(s.discount_total) > 0 ? '<tr><td>Discount</td><td class="r">-' + e(m(s.discount_total)) + '</td></tr>' : '') +
      (num(s.tax_total) > 0 ? '<tr><td>VAT included</td><td class="r">' + e(m(s.tax_total)) + '</td></tr>' : '') +
      '<tr class="big"><td>TOTAL</td><td class="r">' + e(m(s.total)) + '</td></tr></table><hr><table>' + pays +
      (num(s.change_due) > 0.005 ? '<tr><td>Change</td><td class="r">' + e(m(s.change_due)) + '</td></tr>' : '') +
      (due(s) > 0 ? '<tr class="big"><td>BALANCE DUE</td><td class="r">' + e(m(due(s))) + '</td></tr>' : '') + '</table>' + kra +
      (s.status === 'void' ? '<hr><div class="c"><b>*** VOID ***</b></div>' : '') +
      '<hr><div class="c sm">' + e(b.receipt_footer || 'Thank you for shopping with us.') + '</div><div class="c sm">Powered by Kaunta</div></body></html>';
  }

  function print(data) {
    var f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    var d = f.contentWindow.document; d.open(); d.write(html(data)); d.close();
    var go = function () { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (x) { /* blocked */ } setTimeout(function () { f.remove(); }, 60000); };
    var imgs = d.images, wait = imgs.length ? Promise.all(Array.prototype.map.call(imgs, function (i) { return i.complete ? 0 : new Promise(function (r) { i.onload = i.onerror = r; }); })) : Promise.resolve();
    wait.then(function () { setTimeout(go, 150); });
  }

  window.KReceipt = { load: load, print: print, text: text, whatsapp: whatsapp, phone: phone, html: html, method: method, due: due };
})();
