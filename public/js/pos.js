/* The till. Loads the branch's catalogue once (GET /sync/catalog), searches it on the device, keeps the
   cart in memory, and sends ONE request per sale (POST /sales) with the payment already attached.
   The server prices the sale (price lists, tax, discounts), so the total shown here is a preview;
   if the server's total differs, the cashier is told before anything is recorded.
   M-Pesa is taken by receipt code (the customer's SMS). Pay-on-phone (STK push) needs the sale to
   exist before it is paid, which this screen does not do yet.

   New in this version: products are grouped (one card per product, variants inside), a details sheet opens on tap,
   category filters come from GET /categories?all=true (optional), and sales can be held on this device. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };

  var catalog = [], groups = [], cats = {}, cart = [], branchId = null, shift = null, shiftKnown = false;
  var saleUuid = null, lastSaleId = null, method = 'cash', due = 0, catFilter = 'all', view = 'grid', detailToken = 0;
  try { view = localStorage.getItem('kaunta.pos.view') === 'list' ? 'list' : 'grid'; } catch (e) { /* ignore */ }

  function hdr() { return branchId ? { 'X-Branch-Id': branchId } : {}; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function esc(s) { return K.esc(s); }
  function label(it) { var v = it.variant_name; return it.product_name + (v && v !== 'Default' ? ' - ' + v : ''); }
  function vname(it) { return it.variant_name && it.variant_name !== 'Default' ? it.variant_name : ''; }
  function tracked(it) { return it.track_stock !== false && it.product_type !== 'service'; }
  function total() { return round2(cart.reduce(function (s, l) { return s + l.qty * l.price; }, 0)); }
  function count() { return round2(cart.reduce(function (s, l) { return s + l.qty; }, 0)); }

  /* ---------- catalogue ---------- */
  async function loadCatalog() {
    var err = $('#loadErr'); K.notice(err, '');
    if (!branchId) { K.notice(err, 'Your shop has no active branch to sell from.', 'err'); return; }
    try {
      var d = await K.api('GET', '/sync/catalog', undefined, hdr());
      catalog = ((d && d.items) || []).filter(function (i) { return !i.removed; });
      if (d && d.truncated) K.notice(err, 'You have a very large catalogue, so only the first products are loaded. Use search to find the rest.', 'ok');
    } catch (ex) { catalog = []; K.notice(err, ex.message, 'err'); }
    buildGroups(); renderCats(); renderGrid();
  }
  async function loadCats() {
    try { var list = await K.api('GET', '/categories?all=true'); (list || []).forEach(function (c) { cats[c.id] = c.name; }); } catch (e) { /* the till works without category names */ }
    renderCats(); renderGrid();
  }

  function buildGroups() {
    var map = {}, order = [];
    catalog.forEach(function (it) {
      var k = it.product_id || it.variant_id;
      if (!map[k]) { map[k] = { id: k, name: it.product_name, category_id: it.category_id || null, image: null, variants: [] }; order.push(k); }
      var g = map[k]; g.variants.push(it); if (!g.image && it.image_url) g.image = it.image_url;
    });
    groups = order.map(function (k) {
      var g = map[k];
      g.variants.sort(function (a, b) { return (Number(a.selling_price) || 0) - (Number(b.selling_price) || 0); });
      var open = g.variants.filter(function (v) { return !tracked(v); }).length > 0;
      g.qty = g.variants.reduce(function (s, v) { return s + (tracked(v) ? Math.max(0, Number(v.quantity_on_hand) || 0) : 0); }, 0);
      g.track = !open; g.out = g.track && g.qty <= 0; g.low = g.track && !g.out && g.qty <= 5;
      g.min = Number(g.variants[0].selling_price) || 0; g.max = Number(g.variants[g.variants.length - 1].selling_price) || 0;
      return g;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function inCart(g) { return round2(cart.reduce(function (s, l) { return s + (l.product_id === g.id ? l.qty : 0); }, 0)); }

  function renderCats() {
    var box = $('#cats'); box.textContent = '';
    if (!groups.length) return;
    var byCat = {}; groups.forEach(function (g) { if (g.category_id && cats[g.category_id]) byCat[g.category_id] = (byCat[g.category_id] || 0) + 1; });
    var lowN = groups.filter(function (g) { return g.low || g.out; }).length;
    var chips = [{ id: 'all', name: 'All products', n: groups.length, icon: 'squares-four' }];
    if (lowN) chips.push({ id: 'low', name: 'Low stock', n: lowN, icon: 'warning', gold: true });
    Object.keys(byCat).sort(function (a, b) { return cats[a].localeCompare(cats[b]); }).forEach(function (id) { chips.push({ id: id, name: cats[id], n: byCat[id], icon: 'tag' }); });
    if (chips.length < 2) return;
    chips.forEach(function (c) {
      var b = K.el('button', undefined, 'cat'); b.type = 'button'; b.setAttribute('aria-pressed', String(catFilter === c.id));
      var ic = K.el('span', undefined, 'ic' + (c.gold ? ' gold' : '')); ic.appendChild(K.icon(c.icon)); b.appendChild(ic);
      var t = K.el('span'); t.appendChild(document.createTextNode(c.name)); t.appendChild(K.el('small', c.n + (c.n === 1 ? ' item' : ' items'))); b.appendChild(t);
      b.addEventListener('click', function () { catFilter = c.id; renderCats(); renderGrid(); });
      box.appendChild(b);
    });
  }

  /* The product photo, or a letter on a soft tile when it has none (or the link is broken). */
  function initial(name, cls) { var d = K.el('span', (name || '?').trim().charAt(0).toUpperCase(), cls || 'ph'); d.setAttribute('aria-hidden', 'true'); return d; }
  function thumb(url, name, cls) {
    if (!url) return initial(name, cls || 'ph');
    var im = K.el('img', undefined, 'thumb'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = url;
    im.addEventListener('error', function () { im.replaceWith(initial(name, cls || 'ph')); });
    return im;
  }

  function matches(g, q) {
    if (!q) return true;
    if (g.name.toLowerCase().indexOf(q) > -1) return true;
    if (g.category_id && cats[g.category_id] && cats[g.category_id].toLowerCase().indexOf(q) > -1) return true;
    return g.variants.some(function (v) { return (v.variant_name || '').toLowerCase().indexOf(q) > -1 || (v.sku && String(v.sku).toLowerCase().indexOf(q) > -1) || (v.barcode && String(v.barcode).toLowerCase() === q); });
  }
  function visible() {
    var q = $('#q').value.trim().toLowerCase();
    return groups.filter(function (g) {
      if (catFilter === 'low' && !(g.low || g.out)) return false;
      if (catFilter !== 'all' && catFilter !== 'low' && g.category_id !== catFilter) return false;
      return matches(g, q);
    });
  }

  function renderGrid() {
    var grid = $('#grid'), empty = $('#empty'), list = visible();
    grid.textContent = ''; grid.className = 'pgrid2' + (view === 'list' ? ' list' : '');
    list.slice(0, 120).forEach(function (g) {
      var n = inCart(g), t = K.el('article', undefined, 'tile' + (g.out ? ' out' : '') + (n ? ' incart' : '')); t.tabIndex = 0; t.setAttribute('role', 'listitem');
      var pic = K.el('div', undefined, 'pic'); pic.appendChild(thumb(g.image, g.name));
      if (g.out) pic.appendChild(K.el('span', 'Out of stock', 'tag bad stk')); else if (g.low) pic.appendChild(K.el('span', g.qty + ' left', 'tag warn stk'));
      if (n) pic.appendChild(K.el('span', n + ' in sale', 'inc'));
      var add = K.el('button', undefined, 'add'); add.type = 'button'; add.setAttribute('aria-label', (g.variants.length > 1 ? 'Choose an option for ' : 'Add ') + g.name); add.appendChild(K.icon('plus'));
      add.addEventListener('click', function (e) { e.stopPropagation(); quick(g); }); pic.appendChild(add); t.appendChild(pic);
      var tb = K.el('div', undefined, 'tb'); tb.appendChild(K.el('b', g.name));
      var sub = g.variants.length > 1 ? g.variants.length + ' options' : (g.category_id && cats[g.category_id]) || (g.variants[0].sku || '');
      if (sub) tb.appendChild(K.el('small', sub));
      tb.appendChild(K.el('span', (g.min !== g.max ? 'From ' : '') + K.money(g.min), 'price')); t.appendChild(tb);
      t.addEventListener('click', function () { openDetail(g); });
      t.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === t) openDetail(g); });
      grid.appendChild(t);
    });
    var hasQ = $('#q').value.trim();
    $('#countLine').textContent = list.length ? 'Showing ' + Math.min(list.length, 120) + ' of ' + list.length + (list.length === 1 ? ' product' : ' products') : '';
    empty.hidden = list.length > 0;
    if (!list.length) {
      $('#emptyTitle').textContent = groups.length ? 'No match' : 'No products to sell yet';
      $('#emptyText').textContent = groups.length ? 'Nothing matches "' + hasQ + '". Check the spelling or scan the barcode.' : 'Add products on the products page and they will appear here.';
    }
    return list;
  }

  $('#q').addEventListener('input', renderGrid);
  $('#q').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { this.value = ''; renderGrid(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var q = this.value.trim().toLowerCase(); if (!q) return;
    var exact = catalog.filter(function (i) { return i.barcode && String(i.barcode).toLowerCase() === q; })[0];
    var list = renderGrid();
    var hit = exact || (list.length === 1 && list[0].variants.length === 1 ? list[0].variants[0] : null);
    if (hit) { add(hit, 1); this.value = ''; renderGrid(); }
    else if (list.length === 1) openDetail(list[0]);
  });
  $('#view').querySelectorAll('button').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.v === view));
    b.addEventListener('click', function () { view = b.dataset.v; try { localStorage.setItem('kaunta.pos.view', view); } catch (e) { /* ignore */ } $('#view').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); renderGrid(); });
  });

  /* ---------- cart ---------- */
  function quick(g) { if (g.variants.length > 1) openDetail(g); else add(g.variants[0], 1); }
  function add(it, n) {
    n = n || 1;
    var line = cart.filter(function (l) { return l.variant_id === it.variant_id; })[0];
    if (line) line.qty = round2(line.qty + n);
    else cart.push({ variant_id: it.variant_id, product_id: it.product_id, name: it.product_name, variant: vname(it), price: Number(it.selling_price) || 0, qty: n, image: it.image_url || null });
    saleUuid = null; K.notice($('#saleErr'), ''); renderCart(); renderGrid();
    var tot = $('#total'); tot.classList.remove('bump'); void tot.offsetWidth; tot.classList.add('bump');
  }
  function renderCart() {
    var ul = $('#lines'); ul.textContent = '';
    cart.forEach(function (l, i) {
      var li = K.el('li', undefined, 'cl');
      if (l.image) { var im = K.el('img'); im.alt = ''; im.src = l.image; im.addEventListener('error', function () { im.replaceWith(K.el('span', l.name.charAt(0).toUpperCase(), 'mini')); }); li.appendChild(im); } else li.appendChild(K.el('span', l.name.charAt(0).toUpperCase(), 'mini'));
      var nm = K.el('div', l.name, 'nm'); nm.appendChild(K.el('small', (l.variant ? l.variant + ', ' : '') + K.money(l.price) + ' each'));
      li.appendChild(nm); li.appendChild(K.el('span', K.money(l.qty * l.price), 'lt'));
      var ctl = K.el('div', undefined, 'ctl'), st = K.el('span', undefined, 'stepper sm'), minus = K.el('button'), plus = K.el('button'), inp = K.el('input');
      minus.type = 'button'; plus.type = 'button'; minus.appendChild(K.icon('minus')); plus.appendChild(K.icon('plus')); minus.setAttribute('aria-label', 'One less'); plus.setAttribute('aria-label', 'One more');
      inp.type = 'number'; inp.min = '0'; inp.step = 'any'; inp.value = String(l.qty); inp.setAttribute('aria-label', 'Quantity of ' + l.name);
      minus.addEventListener('click', function () { setQty(i, l.qty - 1); }); plus.addEventListener('click', function () { setQty(i, l.qty + 1); }); inp.addEventListener('change', function () { setQty(i, Number(inp.value)); });
      st.appendChild(minus); st.appendChild(inp); st.appendChild(plus); ctl.appendChild(st);
      var rm = K.el('button', undefined, 'rm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + l.name); rm.appendChild(K.icon('trash')); rm.addEventListener('click', function () { setQty(i, 0); });
      ctl.appendChild(rm); li.appendChild(ctl); ul.appendChild(li);
    });
    var t = total(), n = count();
    $('#total').textContent = K.money(t); $('#sub').textContent = K.money(t);
    $('#itemsLine').textContent = n + (n === 1 ? ' item' : ' items'); $('#cartMeta').textContent = cart.length ? n + (n === 1 ? ' item' : ' items') + ' on this sale' : 'No items yet';
    $('#cartEmpty').hidden = cart.length > 0; ul.hidden = !cart.length;
    $('#clear').disabled = !cart.length; $('#hold').disabled = !cart.length; $('#charge').disabled = !cart.length || t <= 0;
    $('#addNote').hidden = !cart.length || !$('#noteFld').hidden; if (!cart.length) { $('#noteFld').hidden = true; $('#note').value = ''; }
    var lab = $('#charge'); lab.textContent = ''; lab.appendChild(document.createTextNode(cart.length ? 'Charge ' + K.money(t) : 'Charge')); var kb = K.el('kbd', 'F2', 'hide-s'); lab.appendChild(kb);
    var fab = $('#fab'); fab.hidden = !cart.length; $('#fabText').textContent = n + (n === 1 ? ' item' : ' items') + ', ' + K.money(t);
  }
  function setQty(i, q) {
    q = round2(q);
    if (!(q > 0)) cart.splice(i, 1); else cart[i].qty = q;
    saleUuid = null; renderCart(); renderGrid();
  }
  $('#clear').addEventListener('click', function () { cart = []; saleUuid = null; K.notice($('#saleErr'), ''); renderCart(); renderGrid(); });
  $('#addNote').addEventListener('click', function () { $('#noteFld').hidden = false; $('#addNote').hidden = true; $('#note').focus(); });
  $('#fab').addEventListener('click', function () { $('#cart').scrollIntoView({ behavior: 'smooth' }); });

  /* ---------- product details ---------- */
  function stockText(it) { if (!tracked(it)) return 'Always available'; var q = Number(it.quantity_on_hand) || 0; return q > 0 ? q + ' in stock' : 'Out of stock'; }
  function openDetail(g) {
    var token = ++detailToken, d = $('#detail'), body = $('#dBody'), foot = $('#dFoot');
    body.textContent = ''; foot.textContent = ''; $('#dTitle').textContent = g.name;
    var cur = g.variants.filter(function (v) { return !tracked(v) || (Number(v.quantity_on_hand) || 0) > 0; })[0] || g.variants[0], qty = 1, extraImgs = [], desc = '';

    var gal = K.el('div', undefined, 'gal'), main = null, thumbs = K.el('div', undefined, 'thumbs');
    function showMain(url) {
      var old = gal.querySelector('.main-pic'); var node;
      if (url) { node = K.el('img', undefined, 'main-pic'); node.alt = g.name; node.src = url; node.addEventListener('error', function () { node.replaceWith(initial(g.name, 'ph main-pic')); }); } else node = initial(g.name, 'ph main-pic');
      if (old) old.replaceWith(node); else gal.insertBefore(node, gal.firstChild); main = node;
    }
    gal.appendChild(thumbs); body.appendChild(gal);
    var tags = K.el('div', undefined, 'd-tags'); body.appendChild(tags);
    var price = K.el('p', undefined, 'd-price'); body.appendChild(price);
    var pick = null;
    if (g.variants.length > 1) {
      var wrap = K.el('div', undefined, 'fld'); wrap.appendChild(K.el('span', 'Choose an option')); pick = K.el('div', undefined, 'vpick'); wrap.appendChild(pick); body.appendChild(wrap);
    }
    var facts = K.el('div', undefined, 'facts'); body.appendChild(facts);
    var warn = K.el('p', undefined, 'note warn'); warn.hidden = true; body.appendChild(warn);
    var descEl = K.el('p', undefined, 'd-desc'); descEl.hidden = true; body.appendChild(descEl);

    var st = K.el('span', undefined, 'stepper'), minus = K.el('button'), plus = K.el('button'), inp = K.el('input');
    minus.type = 'button'; plus.type = 'button'; minus.appendChild(K.icon('minus')); plus.appendChild(K.icon('plus')); minus.setAttribute('aria-label', 'One less'); plus.setAttribute('aria-label', 'One more');
    inp.type = 'number'; inp.min = '1'; inp.step = 'any'; inp.value = '1'; inp.setAttribute('aria-label', 'Quantity');
    st.appendChild(minus); st.appendChild(inp); st.appendChild(plus);
    var go = K.el('button', undefined, 'btn primary lg'); go.type = 'button'; foot.appendChild(st); foot.appendChild(go);

    function fact(k, v) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', k)); f.appendChild(K.el('b', v)); facts.appendChild(f); }
    function paint() {
      price.textContent = K.money(cur.selling_price);
      tags.textContent = '';
      if (g.category_id && cats[g.category_id]) tags.appendChild(K.el('span', cats[g.category_id], 'tag'));
      var q = Number(cur.quantity_on_hand) || 0;
      tags.appendChild(K.el('span', stockText(cur), 'tag dot ' + (!tracked(cur) ? 'ok' : q <= 0 ? 'bad' : q <= 5 ? 'warn' : 'ok')));
      facts.textContent = '';
      fact('SKU', cur.sku || 'Not set'); fact('Barcode', cur.barcode || 'Not set');
      fact('Tax', Number(cur.tax_rate) > 0 ? Number(cur.tax_rate) + '%' + (cur.tax_code ? ' (' + cur.tax_code + ')' : '') : 'No tax'); fact('Stock', tracked(cur) ? String(q) : 'Not tracked');
      warn.hidden = !(tracked(cur) && q <= 0); warn.textContent = 'This one is out of stock. The sale will be refused unless you add stock first.';
      if (pick) pick.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.id === cur.variant_id)); });
      go.textContent = 'Add to sale, ' + K.money(cur.selling_price * (Number(inp.value) || 1));
      var imgs = [cur.image_url].concat(extraImgs).filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      if (!imgs.length && g.image) imgs = [g.image];
      showMain(imgs[0]); thumbs.textContent = ''; thumbs.hidden = imgs.length < 2;
      imgs.forEach(function (u, i) { var t = K.el('img'); t.src = u; t.alt = ''; t.setAttribute('aria-current', String(i === 0)); t.addEventListener('click', function () { showMain(u); thumbs.querySelectorAll('img').forEach(function (x) { x.setAttribute('aria-current', String(x === t)); }); }); thumbs.appendChild(t); });
    }
    if (pick) g.variants.forEach(function (v) {
      var b = K.el('button'); b.type = 'button'; b.dataset.id = v.variant_id; b.appendChild(document.createTextNode(vname(v) || 'Standard')); b.appendChild(K.el('small', K.money(v.selling_price) + ', ' + stockText(v)));
      b.addEventListener('click', function () { cur = v; paint(); }); pick.appendChild(b);
    });
    minus.addEventListener('click', function () { inp.value = String(Math.max(1, round2((Number(inp.value) || 1) - 1))); paint(); });
    plus.addEventListener('click', function () { inp.value = String(round2((Number(inp.value) || 0) + 1)); paint(); });
    inp.addEventListener('input', paint);
    go.addEventListener('click', function () { var n = Math.max(0.01, round2(Number(inp.value) || 1)); add(cur, n); d.close(); K.toast(g.name + ' added to the sale'); });
    paint(); d.showModal();

    /* Description and extra photos come from the full product record. Cashiers without product rights
       cannot read it, so a failure here is fine and the sheet just stays as it is. */
    K.api('GET', '/products/' + encodeURIComponent(g.id)).then(function (p) {
      if (token !== detailToken || !p) return;
      extraImgs = (p.images || []).map(function (i) { return i.url; }).filter(Boolean);
      if (p.description) { descEl.textContent = p.description; descEl.hidden = false; }
      paint();
    }).catch(function () { /* optional */ });
  }

  /* ---------- held sales (kept on this device, per branch) ---------- */
  function heldKey() { return 'kaunta.held.' + (branchId || 'main'); }
  function readHeld() { try { return JSON.parse(localStorage.getItem(heldKey()) || '[]') || []; } catch (e) { return []; } }
  function writeHeld(list) { try { localStorage.setItem(heldKey(), JSON.stringify(list)); } catch (e) { K.toast('This browser would not keep the held sale.', 'err'); } paintHeld(); }
  function paintHeld() { var n = readHeld().length; $('#heldCount').textContent = String(n); $('#heldBtn').classList.toggle('has', n > 0); }
  function hold(silent) {
    if (!cart.length) return;
    var list = readHeld(); list.unshift({ id: K.uuid(), at: Date.now(), note: $('#note').value.trim(), lines: cart.slice() }); writeHeld(list);
    cart = []; saleUuid = null; renderCart(); renderGrid(); if (!silent) K.toast('Sale held. Find it under Held.');
  }
  $('#hold').addEventListener('click', function () { hold(false); });
  function openHeld() {
    var ul = $('#heldList'), list = readHeld(); ul.textContent = '';
    if (!list.length) { var li0 = K.el('li'); li0.style.justifyContent = 'center'; li0.appendChild(K.el('span', 'No held sales.', 'muted')); ul.appendChild(li0); }
    list.forEach(function (h) {
      var li = K.el('li'), tile = K.el('span', undefined, 'ic'); tile.appendChild(K.icon('pause')); li.appendChild(tile);
      var n = h.lines.reduce(function (s, l) { return s + l.qty; }, 0), tt = h.lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
      var t = K.el('div', undefined, 't'); t.appendChild(K.el('b', n + (n === 1 ? ' item' : ' items') + ', ' + K.money(tt)));
      t.appendChild(K.el('small', new Date(h.at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) + ' ' + h.lines.map(function (l) { return l.name; }).slice(0, 2).join(', ') + (h.lines.length > 2 ? ' and more' : '') + (h.note ? '. ' + h.note : ''))); li.appendChild(t);
      var res = K.el('button', 'Resume', 'btn sm primary'); res.type = 'button'; res.addEventListener('click', function () { resume(h.id); });
      var del = K.el('button', undefined, 'icon-btn sm'); del.type = 'button'; del.setAttribute('aria-label', 'Delete held sale'); del.appendChild(K.icon('trash')); del.addEventListener('click', function () { writeHeld(readHeld().filter(function (x) { return x.id !== h.id; })); openHeld(); });
      li.appendChild(res); li.appendChild(del); ul.appendChild(li);
    });
    if (!$('#heldDlg').open) $('#heldDlg').showModal();
  }
  function resume(id) {
    var list = readHeld(), h = list.filter(function (x) { return x.id === id; })[0]; if (!h) return;
    writeHeld(list.filter(function (x) { return x.id !== id; }));
    if (cart.length) hold(true);
    cart = h.lines; saleUuid = null; if (h.note) { $('#note').value = h.note; $('#noteFld').hidden = false; }
    renderCart(); renderGrid(); $('#heldDlg').close();
  }
  $('#heldBtn').addEventListener('click', openHeld);

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
      var b = K.el('button', i === 0 ? 'Exact' : String(n), 'btn sm'); b.type = 'button';
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
      var payload = { client_uuid: saleUuid || (saleUuid = K.uuid()), items: cart.map(function (l) { return { variant_id: l.variant_id, quantity: l.qty }; }), payments: [pay] };
      if ($('#note').value.trim()) payload.notes = $('#note').value.trim();
      var sale = await K.api('POST', '/sales', payload, hdr());
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
    $('#doneAmt').textContent = K.money(paid);
    $('#doneText').textContent = 'Paid by ' + (pay.method === 'mpesa' ? 'M-Pesa' : pay.method);
    var chg = $('#doneChange'); chg.hidden = !(change > 0.005); chg.textContent = 'Give change: ' + K.money(change);
    K.notice($('#doneErr'), '');
    cart = []; saleUuid = null; buildGroups(); renderCats(); renderCart(); renderGrid();
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
      await Promise.race([Promise.all(imgs.map(function (im) { return im.complete ? 1 : new Promise(function (r2) { im.onload = im.onerror = r2; }); })), new Promise(function (r2) { setTimeout(r2, 2000); })]);
      f.contentWindow.focus(); f.contentWindow.print(); setTimeout(function () { f.remove(); }, 2000);
    } catch (ex) { K.notice(err, ex.message, 'err'); }
  });

  /* ---------- shift ---------- */
  function paintShift() {
    var btn = $('#shiftBtn'); btn.hidden = !shiftKnown;
    if (!shiftKnown) return;
    var at = shift && (shift.opened_at || shift.created_at);
    $('#shiftText').textContent = shift ? 'Shift open' + (at ? ' since ' + new Date(at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '') : 'Open shift';
    btn.firstElementChild.className = 'ph ' + (shift ? 'ph-clock' : 'ph-warning');
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
      $('#shiftDlg').close(); K.toast('Shift opened');
      if (cart.length) $('#charge').click();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- start ---------- */
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    if (e.key === 'F2' && !$('#charge').disabled && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#charge').click(); }
    else if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#q').focus(); }
  });
  $('#reload').addEventListener('click', function () { loadCatalog().then(function () { K.toast('Products and stock refreshed'); }); });

  (async function () {
    renderCart();
    try {
      var list = await K.branches(), sel = $('#branch');
      branchId = list[0] ? list[0].id : null;
      if (list.length > 1) {
        list.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
        sel.value = branchId; sel.hidden = false;
        sel.addEventListener('change', function () {
          if (cart.length) hold(true);   /* a sale in progress is held on the old branch, never lost */
          branchId = sel.value; saleUuid = null; paintHeld(); renderCart(); loadCatalog();
        });
      }
    } catch (ex) { K.notice($('#loadErr'), ex.message, 'err'); }
    paintHeld();
    K.avatar($('#shopAv'), null, K.session.tenant && K.session.tenant.name); K.avatar($('#meAv'), null, K.session.user && K.session.user.name);
    $('#shopName').textContent = (K.session.tenant && K.session.tenant.name) || 'Your shop';
    K.identity().then(function (d) {
      if (!d) return;
      K.avatar($('#shopAv'), d.tenant && d.tenant.logo_url, d.tenant && d.tenant.name); if (d.tenant && d.tenant.name) $('#shopName').textContent = d.tenant.name;
      K.avatar($('#meAv'), d.user && d.user.avatar_url, d.user && d.user.full_name); $('#meName').textContent = (d.user && d.user.full_name) || '';
    });
    loadShift(); loadCats(); await loadCatalog(); $('#q').focus();
  })();
})();
