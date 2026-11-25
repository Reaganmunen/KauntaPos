/* Products: browse (GET /products), see details (GET /products/:id), add one (POST /products), import a CSV (POST /products/import).
   Photos and stock levels on the cards come from GET /sync/catalog when the signed-in person may read it; without it the cards simply show a letter. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var S = { units: [], page: 1, pages: 1, q: '', cat: '', view: 'grid', rows: [], info: {}, vinfo: {}, cats: {} };
  try { S.view = localStorage.getItem('kaunta.products.view') === 'table' ? 'table' : 'grid'; } catch (e) { /* ignore */ }

  function thumb(url, name, cls) {
    var ph = function () { return K.el('span', (name || '?').trim().charAt(0).toUpperCase(), cls || 'ph'); };
    if (!url) return ph();
    var im = K.el('img', undefined, 'thumb'); im.alt = ''; im.loading = 'lazy'; im.src = url; im.addEventListener('error', function () { im.replaceWith(ph()); }); return im;
  }
  function fq(n) { return String(Math.round((Number(n) || 0) * 1000) / 1000); }
  function unitName(p) { return p && p.sold_by_weight ? (p.unit_abbr || 'kg') : ''; }
  function range(p) { var lo = Number(p.min_price), hi = Number(p.max_price); if (!isFinite(lo)) return 'No price'; var per = unitName(p) ? ' / ' + unitName(p) : ''; return (lo === hi || !isFinite(hi) ? K.money(lo) : K.money(lo) + ' to ' + K.money(hi)) + per; }
  function stockTag(info) {
    if (!info) return null;
    if (!info.track) return K.el('span', 'Not tracked', 'tag');
    return K.el('span', info.qty <= 0 ? 'Out of stock' : info.qty <= 5 ? fq(info.qty) + ' left' : fq(info.qty) + ' in stock', 'tag dot ' + (info.qty <= 0 ? 'bad' : info.qty <= 5 ? 'warn' : 'ok'));
  }

  /* ---------- load ---------- */
  async function loadExtras() {
    try {
      var b = await K.branches(); if (!b[0]) return;
      var d = await K.api('GET', '/sync/catalog', undefined, { 'X-Branch-Id': b[0].id });
      ((d && d.items) || []).forEach(function (it) {
        if (it.removed) return;
        var i = S.info[it.product_id] || (S.info[it.product_id] = { image: null, qty: 0, track: false });
        if (!i.image && it.image_url) i.image = it.image_url;
        if (it.track_stock !== false && it.product_type !== 'service') { i.track = true; i.qty += Math.max(0, Number(it.quantity_on_hand) || 0); }
        S.vinfo[it.variant_id] = { qty: Number(it.quantity_on_hand) || 0, track: it.track_stock !== false && it.product_type !== 'service' };
      });
    } catch (e) { /* photos and stock are a bonus */ }
  }
  async function loadCats() {
    try {
      var list = await K.api('GET', '/categories?all=true'); (list || []).forEach(function (c) { S.cats[c.id] = c.name; });
      [$('#pcat'), $('#pCategory'), $('#eCategory')].forEach(function (sel) { (list || []).forEach(function (c) { var o = K.el('option', c.name); o.value = c.id; sel.appendChild(o); }); });
    } catch (e) { $('#pcat').hidden = true; $('#pCategory').closest('.fld').hidden = true; }
  }
  async function load() {
    var err = $('#listErr'); K.notice(err, '');
    var box = $('#list'); box.textContent = '';
    for (var i = 0; i < 6; i++) box.appendChild(K.el('div', undefined, 'sk-row'));
    try {
      var qs = '?page=' + S.page + '&limit=24&is_active=true' + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (S.cat ? '&category_id=' + encodeURIComponent(S.cat) : '');
      var res = await K.apiFull('GET', '/products' + qs);
      S.rows = Array.isArray(res.data) ? res.data : (res.data && res.data.rows) || []; S.pages = (res.meta && res.meta.pages) || 1;
      render();
    } catch (ex) { box.textContent = ''; if (ex.message) K.notice(err, ex.status === 403 ? 'Your role does not include products. Ask the shop owner for access.' : ex.message, 'err'); }
  }

  function empty() {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('package')); e.appendChild(ic);
    if (S.q || S.cat) { e.appendChild(K.el('b', 'No products match')); e.appendChild(K.el('p', 'Try a different word or clear the category.')); }
    else {
      e.appendChild(K.el('b', 'Add your first product')); e.appendChild(K.el('p', 'A name and a price is enough. Add a photo and stock when you are ready.'));
      var b = K.el('button', 'Add product', 'btn primary'); b.type = 'button'; b.addEventListener('click', openAdd); e.appendChild(b);
    }
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    if (!S.rows.length) { box.appendChild(empty()); $('#pager').hidden = true; return; }
    if (S.view === 'grid') {
      var g = K.el('div', undefined, 'pgrid');
      S.rows.forEach(function (p) {
        var info = S.info[p.id], c = K.el('button', undefined, 'pcard'); c.type = 'button';
        c.appendChild(thumb(info && info.image, p.name));
        var t = K.el('div', undefined, 't'); t.appendChild(K.el('b', p.name)); t.appendChild(K.el('span', range(p), 'p'));
        var sm = p.category_name || (p.variant_count > 1 ? p.variant_count + ' options' : ''); if (sm) t.appendChild(K.el('small', sm));
        var row = K.el('div', undefined, 'row'); row.style.flexWrap = 'wrap'; var st = stockTag(info); if (st) row.appendChild(st); if (p.is_online) row.appendChild(K.el('span', 'Online', 'tag info')); if (row.children.length) t.appendChild(row);
        c.appendChild(t); c.addEventListener('click', function () { openDetail(p); }); g.appendChild(c);
      });
      box.appendChild(g);
    } else {
      var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
      ['Product', 'Category', 'Price', 'Stock', 'Online'].forEach(function (h, i) { tr.appendChild(K.el('th', h, i === 2 ? 'r' : '')); });
      var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody');
      S.rows.forEach(function (p) {
        var info = S.info[p.id], r = K.el('tr', undefined, 'go'), c1 = K.el('td'), wrap = K.el('div', undefined, 'row');
        var tn = thumb(info && info.image, p.name, 'ph'); tn.style.width = '44px'; tn.style.height = '44px'; tn.style.fontSize = '18px'; tn.style.flex = 'none'; tn.style.aspectRatio = '1'; wrap.appendChild(tn);
        var nm = K.el('div'); nm.appendChild(K.el('b', p.name)); if (p.variant_count > 1) nm.appendChild(K.el('small', p.variant_count + ' options', 'muted')).style.display = 'block'; wrap.appendChild(nm); c1.appendChild(wrap); r.appendChild(c1);
        r.appendChild(K.el('td', p.category_name || 'None', p.category_name ? '' : 'muted')); r.appendChild(K.el('td', range(p), 'r num nw'));
        var c4 = K.el('td'), st = stockTag(info); if (st) c4.appendChild(st); else c4.appendChild(K.el('span', 'Unknown', 'muted')); r.appendChild(c4);
        r.appendChild(K.el('td')).appendChild(K.el('span', p.is_online ? 'Online' : 'Till only', 'tag' + (p.is_online ? ' info' : '')));
        r.addEventListener('click', function () { openDetail(p); }); body.appendChild(r);
      });
      tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
    }
    var pg = $('#pager'); pg.hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }

  var t = null;
  $('#pq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; load(); }, 260); });
  $('#pcat').addEventListener('change', function () { S.cat = this.value; S.page = 1; load(); });
  $('#prev').addEventListener('click', function () { S.page--; load(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; load(); window.scrollTo({ top: 0 }); });
  $('#pview').querySelectorAll('button').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.v === S.view));
    b.addEventListener('click', function () { S.view = b.dataset.v; try { localStorage.setItem('kaunta.products.view', S.view); } catch (e) { /* ignore */ } $('#pview').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); render(); });
  });

  /* ---------- details ---------- */
  async function openDetail(row) {
    var d = $('#detail'), body = $('#dBody'); body.textContent = ''; $('#dTitle').textContent = row.name;
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row')); d.showModal();
    try {
      var p = await K.api('GET', '/products/' + encodeURIComponent(row.id)); body.textContent = '';
      S.curP = p; S.curRow = row; showEdit();
      var imgs = (p.images || []).map(function (i) { return i.url; }).filter(Boolean);
      var gal = K.el('div', undefined, 'gal'), main;
      function show(u) { var n; if (u) { n = K.el('img', undefined, 'main-pic'); n.alt = p.name; n.src = u; } else n = K.el('span', (p.name || '?').charAt(0).toUpperCase(), 'ph main-pic'); if (main) main.replaceWith(n); else gal.insertBefore(n, gal.firstChild); main = n; }
      show(imgs[0] || (S.info[row.id] && S.info[row.id].image)); 
      if (imgs.length > 1) { var th = K.el('div', undefined, 'thumbs'); imgs.forEach(function (u, i) { var x = K.el('img'); x.src = u; x.alt = ''; x.setAttribute('aria-current', String(i === 0)); x.addEventListener('click', function () { show(u); th.querySelectorAll('img').forEach(function (y) { y.setAttribute('aria-current', String(y === x)); }); }); th.appendChild(x); }); gal.appendChild(th); }
      body.appendChild(gal);
      var tags = K.el('div', undefined, 'd-tags'); tags.style.display = 'flex'; tags.style.gap = '8px'; tags.style.flexWrap = 'wrap';
      if (row.category_name) tags.appendChild(K.el('span', row.category_name, 'tag'));
      if (p.sold_by_weight) tags.appendChild(K.el('span', 'Sold by ' + (row.unit_abbr || 'kg'), 'tag ok'));
      tags.appendChild(K.el('span', p.is_online ? 'Sold online' : 'Till only', 'tag' + (p.is_online ? ' info' : ''))); if (p.track_stock === false) tags.appendChild(K.el('span', 'Stock not tracked', 'tag'));
      (Array.isArray(p.tags) ? p.tags : []).forEach(function (x) { tags.appendChild(K.el('span', String(x), 'tag')); });
      body.appendChild(tags);
      if (p.description) body.appendChild(K.el('p', p.description, 'muted')).style.whiteSpace = 'pre-line';
      var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
      var showCost = (p.variants || []).some(function (v) { return v.cost_price != null; });
      var showPlu = (p.variants || []).some(function (v) { return v.scale_plu; });
      ['Option', 'SKU', 'Barcode'].concat(showPlu ? ['Scale code'] : []).concat(['Price']).concat(showCost ? ['Margin'] : []).concat(['Stock']).forEach(function (h, i) { hr.appendChild(K.el('th', h, h === 'Price' || h === 'Margin' ? 'r' : '')); });
      var thd = K.el('thead'); thd.appendChild(hr); tb.appendChild(thd); var tbody = K.el('tbody');
      (p.variants || []).forEach(function (v) {
        var r = K.el('tr'); r.appendChild(K.el('td', v.name && v.name !== 'Default' ? v.name : 'Standard')); r.appendChild(K.el('td', v.sku || '', 'mono')); var bc = K.el('td', v.barcode || '', 'mono'); if ((v.barcodes || []).length) { var more = K.el('span', '+' + v.barcodes.length, 'tag'); more.style.marginLeft = '8px'; more.title = v.barcodes.map(function (b) { return (b.label || 'Pack') + ' ' + b.barcode + (Number(b.pack_quantity) !== 1 ? ' (x' + fq(b.pack_quantity) + ')' : ''); }).join('\n'); bc.appendChild(more); } r.appendChild(bc);
        if (showPlu) r.appendChild(K.el('td', v.scale_plu || '', 'mono'));
        r.appendChild(K.el('td', K.money(v.selling_price) + (p.sold_by_weight ? ' / ' + (row.unit_abbr || 'kg') : ''), 'r num nw'));
        if (showCost) { var sp = Number(v.selling_price) || 0, cp = Number(v.cost_price); r.appendChild(K.el('td', v.cost_price != null && sp > 0 ? Math.round((sp - cp) / sp * 100) + '%' : '', 'r num')); }
        var vi = S.vinfo[v.id]; var c = K.el('td'); if (vi) { var tg = stockTag({ track: vi.track, qty: vi.qty }); c.appendChild(tg); } r.appendChild(c); tbody.appendChild(r);
      });
      tb.appendChild(tbody); sc.appendChild(tb); card.appendChild(sc); body.appendChild(card);
    } catch (ex) { body.textContent = ''; body.appendChild(K.el('p', ex.message || 'We could not load that product.', 'note err')); }
  }

  /* ---------- add one ---------- */
  var photo = null; /* data URL of the shrunk photo, or null */
  function paintPhoto() {
    var prev = $('#pPrev'); prev.hidden = !photo; if (photo) prev.src = photo;
    $('#pPhotoX').hidden = !photo; $('#pPhotoTxt').textContent = photo ? 'Change photo' : 'Add photo';
  }
  $('#pPhoto').addEventListener('change', async function () {
    var f = this.files && this.files[0]; K.notice($('#oneErr'), '');
    if (!f) return;
    try { photo = await K.photo(f, { max: 800 }); } catch (ex) { photo = null; K.notice($('#oneErr'), ex.message, 'err'); }
    this.value = ''; paintPhoto();
  });
  $('#pPhotoX').addEventListener('click', function () { photo = null; paintPhoto(); });
  function openAdd() { K.notice($('#oneErr'), ''); $('#addSheet').showModal(); setTimeout(function () { $('#pName').focus(); }, 60); }
  $('#openAdd').addEventListener('click', openAdd);

  /* The branch opening stock is booked to (main branch). */
  async function stockBranchHeader(needed) {
    if (!needed) return {};
    var list = await K.branches();
    if (!list.length) throw new Error('Your shop has no active branch to book stock into.');
    return { 'X-Branch-Id': list[0].id };
  }
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
    if ($('#pCategory').value) body.category_id = $('#pCategory').value;
    body.is_online = $('#pOnline').checked;
    if ($('#pWeighed').checked) {
      body.sold_by_weight = true;
      var plu = $('#pPlu').value.trim();
      if (plu && !/^[0-9]{1,8}$/.test(plu)) return K.notice(err, 'The scale code is digits only, up to 8 of them.', 'err');
      if (plu) body.scale_plu = plu;
    }
    K.busy(btn, true, 'Saving...');
    try {
      if (body.sold_by_weight) { var uid = await resolveUnit($('#pUnit').value); if (uid) body.unit_id = uid; }
      var headers = await stockBranchHeader(qty > 0);
      if (photo) { var up = await K.api('POST', '/media', { data: photo }); body.images = [{ url: up.url, alt_text: name }]; }
      await K.api('POST', '/products', body, headers);
      $('#oneForm').reset(); photo = null; paintPhoto(); paintWeighToggle(); $('#addSheet').close(); K.toast(name + ' saved');
      S.page = 1; await loadExtras(); load();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- import ---------- */
  var ALIAS = { price: 'selling_price', selling: 'selling_price', sellingprice: 'selling_price', buying_price: 'cost_price', cost: 'cost_price', buyingprice: 'cost_price',
    qty: 'opening_quantity', quantity: 'opening_quantity', stock: 'opening_quantity', opening_stock: 'opening_quantity', product: 'name', product_name: 'name', item: 'name',
    reorder: 'reorder_level', tax: 'tax_code', weighed: 'sold_by_weight', by_weight: 'sold_by_weight', loose: 'sold_by_weight', plu: 'scale_plu', scale_code: 'scale_plu', pack_barcode: 'carton_barcode', carton: 'carton_barcode', carton_qty: 'carton_quantity', units_per_carton: 'carton_quantity', pack_quantity: 'carton_quantity' };
  var rows = [];
  function parseCsv(text) {
    var out = [], row = [], cur = '', q = false, i = 0;
    text = text.replace(/^\uFEFF/, '');
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
  $('#openImport').addEventListener('click', function () { $('#importModal').showModal(); });
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
    var csv = 'name,selling_price,cost_price,opening_quantity,sku,category,sold_by_weight,unit,scale_plu,barcode,carton_barcode,carton_quantity\r\nMaize flour 2kg,180,150,24,MF-2KG,Flour,,,,6161100010012,6161100010098,12\r\nCooking oil 1L,320,280,12,OIL-1L,Oils,,,,,,\r\nSugar (loose),190,165,50,,Sugar,yes,kg,101,,,\r\n';
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
    if (imported) { K.notice(info, imported + ' product' + (imported === 1 ? '' : 's') + ' imported.' + (failed.length ? ' ' + failed.length + ' could not be imported (below).' : ''), 'ok'); rows = []; $('#file').value = ''; btn.disabled = true; S.page = 1; loadExtras().then(load); }
    failed.slice(0, 50).forEach(function (f) { var li = K.el('li'); li.appendChild(K.el('span', 'Row ' + f.row + (f.name ? ' (' + f.name + ')' : '') + ': ' + f.error)); list.appendChild(li); });
    list.hidden = !failed.length;
    K.busy(btn, false); if (!imported) btn.disabled = false;
  });

  /* ---------- edit one ---------- */
  var ed = { photo: null, removePhoto: false, oldImage: null, vars: [] };
  var me = null;
  function showEdit() { K.identity().then(function (d) { me = d && d.user; $('#dEdit').hidden = !(me && K.can(me, 'products.manage')); }); }
  function paintEditPhoto() {
    var url = ed.photo || (!ed.removePhoto && ed.oldImage && ed.oldImage.url) || null, prev = $('#ePrev');
    prev.hidden = !url; if (url) prev.src = url; $('#ePhotoX').hidden = !url; $('#ePhotoTxt').textContent = url ? 'Change photo' : 'Add photo';
  }
  $('#ePhoto').addEventListener('change', async function () {
    var f = this.files && this.files[0]; K.notice($('#eErr'), ''); if (!f) return;
    try { ed.photo = await K.photo(f, { max: 800 }); } catch (ex) { ed.photo = null; K.notice($('#eErr'), ex.message, 'err'); }
    this.value = ''; paintEditPhoto();
  });
  $('#ePhotoX').addEventListener('click', function () { ed.photo = null; ed.removePhoto = true; paintEditPhoto(); });

  function field(label, cls, attrs, value, hint) {
    var l = K.el('label', undefined, 'fld'); l.appendChild(K.el('span', label));
    var i = K.el('input'); Object.keys(attrs).forEach(function (k) { i.setAttribute(k, attrs[k]); }); i.className = cls; i.value = value == null ? '' : value; l.appendChild(i);
    if (hint) l.appendChild(K.el('small', hint)); return l;
  }
  function varRow(v, multi) {
    var box = K.el('div', undefined, 'card'); box.style.display = 'grid'; box.style.gap = '14px'; box.style.padding = '16px';
    var r = { id: v && v.id, box: box, removed: false };
    var head = K.el('div', undefined, 'row');
    if (multi || !v) { var nm = field('Option name', 'v-name', { type: 'text', autocomplete: 'off', placeholder: 'e.g. 500ml' }, v && v.name !== 'Default' ? v.name : ''); nm.classList.add('grow'); head.appendChild(nm); }
    else head.appendChild(K.el('b', 'Standard', 'grow'));
    if (multi || !v) { var x = K.el('button', undefined, 'icon-btn sm'); x.type = 'button'; x.title = 'Remove this option'; x.setAttribute('aria-label', 'Remove this option'); x.appendChild(K.icon('trash')); x.addEventListener('click', function () { r.removed = true; box.hidden = true; }); head.appendChild(x); }
    box.appendChild(head);
    var a = K.el('div', undefined, 'row2'); a.appendChild(field('Selling price (KES)', 'v-price', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, v && v.selling_price));
    a.appendChild(field('Buying price (KES)', 'v-cost', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, v && v.cost_price)); box.appendChild(a);
    var b = K.el('div', undefined, 'row2'); b.appendChild(field('SKU', 'v-sku', { type: 'text', autocomplete: 'off' }, v && v.sku)); b.appendChild(field('Barcode', 'v-bar', { type: 'text', autocomplete: 'off' }, v && v.barcode)); box.appendChild(b);
    box.appendChild(field('Reorder level', 'v-reorder', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' }, v && v.reorder_level, 'You are warned when stock falls to this number.'));
    var pf = field('Scale code (PLU)', 'v-plu', { type: 'text', inputmode: 'numeric', maxlength: '8', autocomplete: 'off' }, v && v.scale_plu, 'The item code your scale prints on its labels.'); pf.classList.add('plu-fld'); pf.hidden = !$('#eWeighed').checked; box.appendChild(pf);
    /* Other barcodes: a carton or multipack code that sells this same option. One scan adds "units" of it. */
    var bx = K.el('div', undefined, 'bc-box'), bh = K.el('div', undefined, 'row'), bl = K.el('div', undefined, 'bc-list');
    bh.appendChild(K.el('b', 'Other barcodes', 'grow'));
    var ba = K.el('button', undefined, 'btn sm'); ba.type = 'button'; ba.appendChild(K.icon('plus')); ba.appendChild(document.createTextNode('Add barcode')); bh.appendChild(ba);
    bx.appendChild(bh); bx.appendChild(bl); bx.appendChild(K.el('small', 'For a carton or multipack. Scanning it adds that many units at the single-unit price, and stock comes off the same item.', 'muted'));
    function bcRow(b) {
      var row = K.el('div', undefined, 'bc-row');
      function inp(cls, ph, label, attrs) { var i = K.el('input'); i.className = cls; i.placeholder = ph; i.setAttribute('aria-label', label); i.autocomplete = 'off'; Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); }); return i; }
      var code = inp('bc-code mono-in', 'Barcode', 'Barcode', { type: 'text', maxlength: '32' }), lab = inp('bc-label', 'Carton', 'Name of this pack', { type: 'text', maxlength: '30', list: 'bcLabels' });
      var units = inp('bc-units', 'Units', 'Units in this pack', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
      code.value = (b && b.barcode) || ''; lab.value = (b && b.label) || ''; units.value = b && b.pack_quantity != null ? String(Number(b.pack_quantity)) : '';
      var rm = K.el('button', undefined, 'icon-btn sm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove this barcode'); rm.appendChild(K.icon('trash')); rm.addEventListener('click', function () { row.remove(); });
      row.appendChild(code); row.appendChild(lab); row.appendChild(units); row.appendChild(rm); bl.appendChild(row); return code;
    }
    ba.addEventListener('click', function () { bcRow(null).focus(); });
    (v && v.barcodes || []).forEach(bcRow);
    r.setExtras = function (list) { bl.textContent = ''; (list || []).forEach(bcRow); };
    box.appendChild(bx);
    r.get = function () { function g(c) { return box.querySelector('.' + c); } return { name: g('v-name') ? g('v-name').value.trim() : undefined, price: g('v-price').value, cost: g('v-cost').value, sku: g('v-sku').value.trim(), bar: g('v-bar').value.trim(), reorder: g('v-reorder').value, plu: g('v-plu').value.trim(),
      extras: Array.prototype.map.call(box.querySelectorAll('.bc-row'), function (row) { return { barcode: row.querySelector('.bc-code').value.trim(), label: row.querySelector('.bc-label').value.trim(), pack_quantity: row.querySelector('.bc-units').value }; }).filter(function (x) { return x.barcode || x.pack_quantity !== '' || x.label; }) }; };
    return r;
  }
  function addVar(v, multi) { var r = varRow(v, multi); ed.vars.push(r); $('#eVars').appendChild(r.box); return r; }

  $('#dEdit').addEventListener('click', function () {
    var p = S.curP; if (!p) return; K.notice($('#eErr'), '');
    ed = { photo: null, removePhoto: false, oldImage: (p.images || [])[0] || null, vars: [] };
    $('#eName').value = p.name || ''; $('#eDesc').value = p.description || ''; $('#eCategory').value = p.category_id || '';
    $('#eOnline').checked = Boolean(p.is_online); $('#eActive').checked = p.is_active !== false;
    $('#eWeighed').checked = Boolean(p.sold_by_weight); fillUnits($('#eUnit'), p.unit_id); $('#eUnitFld').hidden = !p.sold_by_weight;
    var box = $('#eVars'); box.textContent = ''; var vs = p.variants || []; vs.forEach(function (v) { addVar(v, vs.length > 1); });
    paintEditPhoto(); $('#detail').close(); $('#editSheet').showModal();
  });
  $('#eAddVar').addEventListener('click', function () {
    var live = ed.vars.filter(function (r) { return !r.removed; });
    if (live.length === 1 && !live[0].box.querySelector('.v-name')) { /* a single standard option becomes a named one once there are two */
      var old = live[0], idx = ed.vars.indexOf(old), v = (S.curP.variants || []).filter(function (x) { return x.id === old.id; })[0];
      var vals = old.get(); var nr = varRow(v, true); nr.box.querySelector('.v-price').value = vals.price; nr.box.querySelector('.v-cost').value = vals.cost; nr.box.querySelector('.v-sku').value = vals.sku; nr.box.querySelector('.v-bar').value = vals.bar; nr.box.querySelector('.v-reorder').value = vals.reorder; nr.box.querySelector('.v-plu').value = vals.plu; nr.setExtras(vals.extras);
      nr.box.querySelector('.v-name').value = (v && v.name !== 'Default') ? v.name : 'Standard'; old.box.replaceWith(nr.box); ed.vars[idx] = nr;
    }
    var r = addVar(null, true); var n = r.box.querySelector('.v-name'); if (n) n.focus();
  });

  $('#editForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#eErr'), btn = $('#eSave'), p = S.curP; K.notice(err, '');
    var name = $('#eName').value.trim(); if (!name) return K.notice(err, 'Enter the product name.', 'err');
    var live = ed.vars.filter(function (r) { return !r.removed; });
    if (!live.length) return K.notice(err, 'A product needs at least one price. Add an option or delete the product.', 'err');
    for (var i = 0; i < live.length; i++) {
      var g = live[i].get();
      if (g.price === '' || K.num(g.price) < 0) return K.notice(err, 'Enter a selling price for every option.', 'err');
      if (g.name !== undefined && !g.name) return K.notice(err, 'Give every option a name.', 'err');
      for (var x = 0; x < g.extras.length; x++) {
        if (!g.extras[x].barcode) return K.notice(err, 'Enter the barcode for each extra pack, or remove the empty row.', 'err');
        if (!(K.num(g.extras[x].pack_quantity) > 0)) return K.notice(err, 'Enter how many units are in the pack with barcode ' + g.extras[x].barcode + '.', 'err');
      }
    }
    var weighedOn = $('#eWeighed').checked;
    for (var k = 0; k < live.length; k++) if (weighedOn && live[k].get().plu && !/^[0-9]{1,8}$/.test(live[k].get().plu)) return K.notice(err, 'A scale code is digits only, up to 8 of them.', 'err');
    K.busy(btn, true, 'Saving...');
    try {
      var id = encodeURIComponent(p.id);
      var head = { name: name, description: $('#eDesc').value.trim() || null, category_id: $('#eCategory').value || null, is_online: $('#eOnline').checked, is_active: $('#eActive').checked, sold_by_weight: weighedOn };
      if (weighedOn) { var uid = await resolveUnit($('#eUnit').value); if (uid) head.unit_id = uid; }
      await K.api('PATCH', '/products/' + id, head);
      for (var j = 0; j < ed.vars.length; j++) {
        var r = ed.vars[j], v = r.get(), body = { selling_price: K.num(v.price), cost_price: v.cost === '' ? null : K.num(v.cost), sku: v.sku || null, barcode: v.bar || null, reorder_level: v.reorder === '' ? 0 : K.num(v.reorder), scale_plu: weighedOn && v.plu ? v.plu : null,
          extra_barcodes: v.extras.map(function (x) { return { barcode: x.barcode, label: x.label, pack_quantity: K.num(x.pack_quantity) }; }) };
        if (v.name !== undefined) body.name = v.name;
        if (r.removed) { if (r.id) await K.api('DELETE', '/products/' + id + '/variants/' + encodeURIComponent(r.id)); continue; }
        if (r.id) await K.api('PATCH', '/products/' + id + '/variants/' + encodeURIComponent(r.id), body);
        else await K.api('POST', '/products/' + id + '/variants', body);
      }
      if ((ed.photo || ed.removePhoto) && ed.oldImage) await K.api('DELETE', '/products/' + id + '/images/' + encodeURIComponent(ed.oldImage.id));
      if (ed.photo) { var up = await K.api('POST', '/media', { data: ed.photo }); await K.api('POST', '/products/' + id + '/images', { url: up.url, alt_text: name, is_primary: true }); }
      $('#editSheet').close(); K.toast(name + ' updated'); await loadExtras(); await load();
      var row = S.rows.filter(function (x) { return x.id === p.id; })[0]; if (row) openDetail(row);
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  $('#eDelete').addEventListener('click', async function () {
    var p = S.curP; if (!p) return;
    if (!window.confirm('Delete "' + p.name + '"? It disappears from the till and your store. Past sales keep their receipts.')) return;
    var btn = this; btn.disabled = true; K.notice($('#eErr'), '');
    try { await K.api('DELETE', '/products/' + encodeURIComponent(p.id)); $('#editSheet').close(); K.toast(p.name + ' deleted'); await load(); }
    catch (ex) { K.notice($('#eErr'), ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- units and the weighed toggle ---------- */
  async function loadUnits() {
    try { var u = await K.api('GET', '/units?all=true'); S.units = Array.isArray(u) ? u : (u && u.rows) || []; } catch (e) { S.units = []; }
    fillUnits($('#pUnit'));
  }
  /* Lists the shop's units. When there is no kilogram yet it is offered anyway and created the first time it is used. */
  function fillUnits(sel, selectedId) {
    sel.textContent = '';
    var hasKg = S.units.some(function (u) { return String(u.abbreviation).toLowerCase() === 'kg'; });
    if (!hasKg) { var o = K.el('option', 'Kilogram (kg)'); o.value = '__kg'; sel.appendChild(o); }
    S.units.forEach(function (u) { var o2 = K.el('option', u.name + ' (' + u.abbreviation + ')'); o2.value = u.id; sel.appendChild(o2); });
    var kg = S.units.filter(function (u) { return String(u.abbreviation).toLowerCase() === 'kg'; })[0];
    sel.value = selectedId || (kg ? kg.id : '__kg');
  }
  async function resolveUnit(value) {
    if (!value) return null;
    if (value !== '__kg') return value;
    var made = await K.api('POST', '/units', { name: 'Kilogram', abbreviation: 'kg', etims_unit_code: 'KG' });
    S.units.push(made); return made.id;
  }
  function paintWeighToggle() {
    var on = $('#pWeighed').checked; $('#pWeighFields').hidden = !on;
    $('#pPriceLbl').textContent = on ? 'Price per unit (KES)' : 'Selling price (KES)';
  }
  $('#pWeighed').addEventListener('change', paintWeighToggle);
  $('#eWeighed').addEventListener('change', function () {
    var on = this.checked; $('#eUnitFld').hidden = !on;
    document.querySelectorAll('#eVars .plu-fld').forEach(function (f) { f.hidden = !on; });
  });

  /* ---------- scale labels ---------- */
  var scaleSaved = null;
  function readScale() {
    return { enabled: $('#scOn').checked, prefix: $('#scPrefix').value.trim(), plu_length: Number($('#scPlu').value), value_length: Number($('#scVal').value),
      value_type: $('#scType').value, decimals: Number($('#scDec').value), value_check_digit: $('#scKey').value === '1', verify_check_digit: true };
  }
  function paintScale() {
    var n = KScale.normalize(readScale()), type = $('#scType').value;
    $('#scPattern').textContent = n.ok ? KScale.describe(n) : '';
    $('#scDecHint').textContent = type === 'price' ? 'Usually 2: 01250 means 12.50.' : 'Usually 3: 01250 means 1.250 kg.';
    K.notice($('#scErr'), n.ok ? '' : n.error, 'err');
    var out = $('#scOut'), code = $('#scTest').value.trim(); out.className = 'scale-out';
    if (!code) { out.textContent = 'Scan a label from your scale to check these settings.'; return; }
    if (!n.ok) { out.textContent = 'Fix the settings above first.'; return; }
    var r = KScale.parse(code, n.config);
    out.textContent = '';
    if (!r) { out.classList.add('bad'); out.textContent = code.length < 13 ? 'Keep typing: a label has 13 digits.' : 'This does not look like a scale label with these settings.'; return; }
    if (!r.ok) { out.classList.add('bad'); out.textContent = 'The last digit does not check out. Scan the label again.'; return; }
    out.classList.add('good');
    out.appendChild(document.createTextNode('Item code '));
    out.appendChild(K.el('b', r.plu));
    out.appendChild(document.createTextNode(r.kind === 'price' ? ', price ' : ', weight '));
    out.appendChild(K.el('b', r.kind === 'price' ? K.money(r.amount) : fq(r.quantity) + ' kg'));
  }
  async function openScale() {
    K.notice($('#scErr'), ''); $('#scTest').value = '';
    var c = scaleSaved;
    if (!c) { try { var t = await K.api('GET', '/tenant'); var n = KScale.normalize(t && t.settings && t.settings.scale_barcode); c = n.config; } catch (e) { c = KScale.normalize({}).config; } scaleSaved = c; }
    $('#scOn').checked = c.enabled; $('#scPrefix').value = c.prefix; $('#scPlu').value = c.plu_length; $('#scVal').value = c.value_length;
    $('#scType').value = c.value_type; $('#scDec').value = c.decimals; $('#scKey').value = c.value_check_digit ? '1' : '0';
    paintScale(); $('#scaleDlg').showModal(); $('#scTest').focus();
  }
  $('#openScale').addEventListener('click', openScale);
  ['#scOn', '#scPrefix', '#scPlu', '#scVal', '#scType', '#scDec', '#scKey', '#scTest'].forEach(function (s) { $(s).addEventListener('input', paintScale); $(s).addEventListener('change', paintScale); });
  $('#scType').addEventListener('change', function () { $('#scDec').value = this.value === 'price' ? 2 : 3; paintScale(); });
  $('#scaleForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var n = KScale.normalize(readScale()), btn = $('#scSave'); if (!n.ok) return K.notice($('#scErr'), n.error, 'err');
    K.busy(btn, true, 'Saving...');
    try { var s = await K.api('PATCH', '/tenant/settings', { scale_barcode: n.config }); scaleSaved = (s && s.scale_barcode) || n.config; $('#scaleDlg').close(); K.toast('Scale label settings saved'); }
    catch (ex) { K.notice($('#scErr'), ex.status === 403 ? 'Only the shop owner or a manager can change this.' : ex.message, 'err'); }
    K.busy(btn, false);
  });

  loadUnits(); loadCats(); loadExtras().then(load);
  if (/[?&]new=1/.test(location.search)) openAdd();
})();
