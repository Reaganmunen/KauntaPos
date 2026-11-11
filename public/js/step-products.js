/* Add products one at a time, or import a CSV. POST /products and POST /products/import. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };

  /* ---------- tabs ---------- */
  function tab(which) {
    var one = which === 'one';
    $('#tabOne').setAttribute('aria-selected', String(one)); $('#tabMany').setAttribute('aria-selected', String(!one));
    $('#paneOne').hidden = !one; $('#paneMany').hidden = one;
  }
  $('#tabOne').addEventListener('click', function () { tab('one'); });
  $('#tabMany').addEventListener('click', function () { tab('many'); });

  /* The branch opening stock is booked to (main branch). */
  async function stockBranchHeader(needed) {
    if (!needed) return {};
    var list = await K.branches();
    if (!list.length) throw new Error('Your shop has no active branch to book stock into.');
    return { 'X-Branch-Id': list[0].id };
  }
  function listAdded(text) {
    $('#added').hidden = false;
    var li = K.el('li'); li.appendChild(K.el('span', text)); li.appendChild(K.el('span', 'Saved', 'tag'));
    $('#addedList').insertBefore(li, $('#addedList').firstChild);
  }

  /* ---------- add one ---------- */
  $('#oneForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#oneErr'), btn = $('#oneSave'); K.notice(err, '');
    var name = $('#pName').value.trim(), price = $('#pPrice').value, qty = K.num($('#pQty').value);
    if (!name) return K.notice(err, 'Enter the product name.', 'err');
    if (price === '' || K.num(price) < 0) return K.notice(err, 'Enter the selling price.', 'err');
    var body = { name: name, selling_price: K.num(price) };
    if ($('#pCost').value !== '') body.cost_price = K.num($('#pCost').value);
    if (qty > 0) body.opening_quantity = qty;
    if ($('#pSku').value.trim()) body.sku = $('#pSku').value.trim();
    K.busy(btn, true, 'Saving...');
    try {
      var headers = await stockBranchHeader(qty > 0);
      await K.api('POST', '/products', body, headers);
      listAdded(name + ' at ' + K.money(price) + (qty > 0 ? ', ' + qty + ' in stock' : ''));
      $('#oneForm').reset(); $('#pName').focus();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- import ---------- */
  var ALIAS = { price: 'selling_price', selling: 'selling_price', sellingprice: 'selling_price', buying_price: 'cost_price', cost: 'cost_price', buyingprice: 'cost_price',
    qty: 'opening_quantity', quantity: 'opening_quantity', stock: 'opening_quantity', opening_stock: 'opening_quantity', product: 'name', product_name: 'name', item: 'name',
    reorder: 'reorder_level', tax: 'tax_code' };
  var rows = [];

  function parseCsv(text) {
    var out = [], row = [], cur = '', q = false, i = 0;
    text = text.replace(/^﻿/, '');
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; out.push(row); row = []; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); out.push(row); }
    return out.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }
  function toRows(table) {
    var head = table[0].map(function (h) { var k = String(h).trim().toLowerCase().replace(/[\s-]+/g, '_'); return ALIAS[k] || k; });
    return table.slice(1).map(function (r) { var o = {}; head.forEach(function (h, i) { var v = (r[i] || '').trim(); if (h && v !== '') o[h] = v; }); return o; });
  }

  $('#file').addEventListener('change', function () {
    var f = this.files && this.files[0], info = $('#manyInfo'), err = $('#manyErr'), btn = $('#manySave');
    K.notice(info, ''); K.notice(err, ''); $('#manyErrors').hidden = true; rows = []; btn.disabled = true;
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var table = parseCsv(String(rd.result || ''));
      if (table.length < 2) return K.notice(err, 'That file has no product rows. Check that the first row holds the column names.', 'err');
      if (table[0].map(function (h) { return String(h).trim().toLowerCase(); }).indexOf('name') < 0 && !toRows(table).some(function (r) { return r.name; })) return K.notice(err, 'The file needs a "name" column.', 'err');
      rows = toRows(table);
      K.notice(info, rows.length + ' product' + (rows.length === 1 ? '' : 's') + ' ready to import.', 'ok'); btn.disabled = false;
    };
    rd.onerror = function () { K.notice(err, 'We could not read that file.', 'err'); };
    rd.readAsText(f);
  });

  $('#tpl').addEventListener('click', function () {
    var csv = 'name,selling_price,cost_price,opening_quantity,sku,category\r\nMaize flour 2kg,180,150,24,MF-2KG,Flour\r\nCooking oil 1L,320,280,12,OIL-1L,Oils\r\n';
    this.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  });

  $('#manySave').addEventListener('click', async function () {
    var btn = this, err = $('#manyErr'), info = $('#manyInfo'), list = $('#manyErrors');
    K.notice(err, ''); list.hidden = true; list.textContent = '';
    if (!rows.length) return;
    K.busy(btn, true, 'Importing...');
    var imported = 0, failed = [];
    try {
      var headers = await stockBranchHeader(rows.some(function (r) { return K.num(r.opening_quantity) > 0; }));
      for (var i = 0; i < rows.length; i += 500) {
        var res = await K.api('POST', '/products/import', { rows: rows.slice(i, i + 500) }, headers);
        imported += res.imported || 0;
        (res.errors || []).forEach(function (x) { failed.push({ row: x.row + i + 1, name: x.name, error: x.error }); }); /* +1: row 1 of the file is the header */
      }
    } catch (ex) { K.notice(err, (imported ? imported + ' imported before it stopped. ' : '') + ex.message, 'err'); }
    if (imported) { K.notice(info, imported + ' product' + (imported === 1 ? '' : 's') + ' imported.' + (failed.length ? ' ' + failed.length + ' could not be imported (below).' : ''), 'ok'); listAdded(imported + ' imported from your file'); rows = []; $('#file').value = ''; btn.disabled = true; }
    failed.slice(0, 50).forEach(function (f) { var li = K.el('li'); li.appendChild(K.el('span', 'Row ' + f.row + (f.name ? ' (' + f.name + ')' : '') + ': ' + f.error)); list.appendChild(li); });
    list.hidden = !failed.length;
    K.busy(btn, false); if (!imported) btn.disabled = false;
  });
})();
