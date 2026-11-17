/* The customer-facing storefront. Talks only to the public API (/api/store/...), no login.
   Which shop: the address you open it on (acme.kaunta.co.ke or a custom domain). While developing on
   localhost, open  store.html?shop=<your-shop-slug>  and the slug is sent as the X-Tenant header.
   The cart lives on the server; this page keeps only its token in localStorage. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var base = ((window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api').replace(/\/$/, '') + '/store';
  var kes = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var money = function (n) { return kes.format(Number(n) || 0); };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } return null; }

  var params = new URLSearchParams(location.search);
  var slug = (params.get('shop') || '').trim().toLowerCase();
  if (slug) store('kaunta.shop', slug); else slug = store('kaunta.shop') || '';
  var onShopHost = false; // set when the bundle loads without a slug (real subdomain)
  var CART_KEY = function () { return 'kaunta.cart.' + (slug || location.host); };

  var S = { settings: {}, zones: [], cats: [], cat: '', q: '', page: 1, pages: 1, cart: { items: [], total: 0 }, token: store(CART_KEY()) || '' };
  var polling = 0; // incremented to cancel a payment poll

  /* ---------- api ---------- */
  async function raw(method, path, body) {
    var h = { Accept: 'application/json' };
    if (slug) h['X-Tenant'] = slug;
    if (S.token && /^\/(cart|checkout)/.test(path)) h['X-Cart-Token'] = S.token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    var res;
    try { res = await fetch(base + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw fail('We could not reach the shop. Check your connection and try again.'); }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      var err = (j && j.error) || {};
      var e2 = fail(res.status === 429 ? 'Too many requests. Please wait a moment and try again.' : err.message || 'Something went wrong. Please try again.');
      e2.status = res.status; e2.code = err.code; throw e2;
    }
    return j;
  }
  function fail(msg) { return new Error(msg); }
  async function api(method, path, body) { return (await raw(method, path, body)).data; }

  /* A dead or expired cart token: start a new cart and try once more. */
  async function newCart() { var c = await api('POST', '/cart'); S.token = c.token; store(CART_KEY(), S.token); }
  async function cartApi(method, path, body) {
    if (!S.token) await newCart();
    try { return await api(method, path, body); }
    catch (e) {
      if (e.status === 404 && /cart/i.test(e.message)) { await newCart(); return api(method, path, body); }
      throw e;
    }
  }
  async function refreshCart() {
    if (!S.token) { S.cart = { items: [], total: 0 }; paintCount(); return; }
    try { S.cart = await cartApi('GET', '/cart'); } catch (e) { S.cart = { items: [], total: 0 }; }
    paintCount();
  }
  function paintCount() {
    var n = S.cart.items.reduce(function (s, i) { return s + Number(i.quantity); }, 0), c = $('#count');
    c.hidden = n <= 0; c.textContent = String(n > 99 ? '99+' : n);
  }

  var toastTimer;
  function toast(text) { var t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600); }

  /* ---------- modal ---------- */
  var modal = $('#modal');
  function open(title, build) {
    polling++; $('#mTitle').textContent = title; var b = $('#mBody'); b.textContent = ''; build(b);
    if (!modal.open) modal.showModal(); b.scrollTop = 0;
  }
  $('#mClose').addEventListener('click', function () { modal.close(); });
  modal.addEventListener('close', function () { polling++; });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.close(); });
  function note(text, kind) { return el('p', text, 'note' + (kind ? ' ' + kind : '')); }
  function field(label, input, hint) { var l = el('label', undefined, 'fld'); l.appendChild(el('span', label)); l.appendChild(input); if (hint) l.appendChild(el('small', hint)); return l; }
  function input(type, attrs) { var i = el('input'); i.type = type; Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); }); return i; }
  function pic(url, name, cls) {
    var box = el('div', undefined, cls || 'pic');
    function none() { box.textContent = ''; box.appendChild(el('span', (name || '?').trim().charAt(0).toUpperCase(), 'none')); }
    if (url) { var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.src = url; im.addEventListener('error', none); box.appendChild(im); } else none();
    return box;
  }

  /* ---------- page shell ---------- */
  function applySettings(s) {
    S.settings = s || {};
    var name = s.store_name || 'Online store';
    $('#shopName').textContent = name; $('#fName').textContent = name; document.title = s.seo_title || name;
    if (s.seo_description) $('meta[name=description]').setAttribute('content', s.seo_description);
    if (s.favicon_url) $('#favicon').setAttribute('href', s.favicon_url);
    var logo = $('#logo'); if (s.logo_url) { logo.src = s.logo_url; logo.hidden = false; logo.addEventListener('error', function () { logo.hidden = true; }); }
    if (s.announcement) { $('#announce').textContent = s.announcement; $('#announce').hidden = false; }
    if (s.tagline) { $('#tagline').textContent = s.tagline; $('#hello').hidden = false; }
    var t = s.theme || {}, brand = t.primary_color || t.primary || t.brand_color || t.accent_color;
    if (typeof brand === 'string' && /^#[0-9a-f]{3,8}$/i.test(brand)) document.documentElement.style.setProperty('--brand', brand);
    $('#fAddr').textContent = s.address || '';
    var ul = $('#fContact'); ul.textContent = '';
    function link(text, href) { var li = el('li'), a = el('a', text); a.href = href; li.appendChild(a); ul.appendChild(li); }
    if (s.contact_phone) link('Call ' + s.contact_phone, 'tel:' + String(s.contact_phone).replace(/[^\d+]/g, ''));
    if (s.whatsapp_number) link('WhatsApp us', 'https://wa.me/' + String(s.whatsapp_number).replace(/\D/g, ''));
    if (s.contact_email) link(s.contact_email, 'mailto:' + s.contact_email);
    var soc = s.social_links && typeof s.social_links === 'object' ? s.social_links : {};
    Object.keys(soc).forEach(function (k) { if (/^https?:\/\//i.test(String(soc[k]))) link(k.charAt(0).toUpperCase() + k.slice(1), soc[k]); });
  }
  function banners(list) {
    var hero = $('#hero'); hero.textContent = '';
    (list || []).forEach(function (b) {
      var a = el(b.link_url && /^(https?:\/\/|\/)/.test(b.link_url) ? 'a' : 'div', undefined, 'slide'); if (a.tagName === 'A') a.href = b.link_url;
      if (b.image_url) { var im = el('img'); im.alt = ''; im.src = b.image_url; a.appendChild(im); }
      var d = el('div'); if (b.title) d.appendChild(el('h2', b.title)); if (b.subtitle) d.appendChild(el('p', b.subtitle)); a.appendChild(d); hero.appendChild(a);
    });
    hero.hidden = !(list && list.length);
  }
  function pagesFooter(list) {
    var ul = $('#fPages'); ul.textContent = '';
    (list || []).forEach(function (p) { var li = el('li'), b = el('a', p.title); b.href = '#'; b.addEventListener('click', function (e) { e.preventDefault(); openPage(p.slug, p.title); }); li.appendChild(b); ul.appendChild(li); });
  }
  function categories(tree) {
    var flat = []; (function walk(list, depth) { (list || []).forEach(function (c) { flat.push({ id: c.id, name: c.name, depth: depth }); walk(c.children, depth + 1); }); })(tree, 0);
    S.cats = flat;
    var nav = $('#cats'); nav.textContent = '';
    if (!flat.length) { nav.hidden = true; return; }
    [{ id: '', name: 'All' }].concat(flat).forEach(function (c) {
      var b = el('button', c.name, 'chip'); b.type = 'button'; b.setAttribute('aria-pressed', String(S.cat === c.id));
      b.addEventListener('click', function () { S.cat = c.id; categories(tree); loadProducts(true); });
      nav.appendChild(b);
    });
    nav.hidden = false;
  }

  /* ---------- products ---------- */
  function range(p) { var lo = Number(p.min_price), hi = Number(p.max_price); return lo === hi || !isFinite(hi) ? money(lo) : 'From ' + money(lo); }
  async function loadProducts(reset) {
    var grid = $('#grid'), msg = $('#msg'), more = $('#more');
    if (reset) { S.page = 1; grid.textContent = ''; for (var i = 0; i < 8; i++) grid.appendChild(el('div', undefined, 'sk')); }
    msg.hidden = true; more.hidden = true;
    try {
      var qs = '?page=' + S.page + '&limit=24' + (S.cat ? '&category_id=' + encodeURIComponent(S.cat) : '') + (S.q ? '&q=' + encodeURIComponent(S.q) : '');
      var res = await raw('GET', '/products' + qs), rows = res.data || [], meta = res.meta || {};
      if (reset) grid.textContent = '';
      rows.forEach(function (p) {
        var c = el('button', undefined, 'card'); c.type = 'button';
        var box = pic(p.image_url, p.name); if (p.in_stock === false) box.appendChild(el('span', 'Sold out', 'badge')); c.appendChild(box);
        var info = el('div', undefined, 'info'); info.appendChild(el('b', p.name)); info.appendChild(el('span', range(p), 'price')); c.appendChild(info);
        c.addEventListener('click', function () { openProduct(p.slug); });
        grid.appendChild(c);
      });
      S.pages = meta.pages || 1; more.hidden = S.page >= S.pages;
      if (!grid.children.length) { msg.textContent = S.q || S.cat ? 'Nothing found. Try a different search or category.' : 'No products are listed yet. Check back soon.'; msg.className = 'msg'; msg.hidden = false; }
    } catch (e) { if (reset) grid.textContent = ''; msg.textContent = e.message; msg.className = 'msg err'; msg.hidden = false; }
  }
  $('#more').addEventListener('click', function () { S.page++; loadProducts(false); });
  $('#find').addEventListener('submit', function (e) { e.preventDefault(); S.q = $('#q').value.trim(); loadProducts(true); });
  $('#q').addEventListener('input', function () { if (!this.value && S.q) { S.q = ''; loadProducts(true); } });

  async function openProduct(pslug) {
    open('Loading...', function (b) { b.appendChild(el('div', undefined, 'spin')); });
    try {
      var p = await api('GET', '/products/' + encodeURIComponent(pslug));
      open(p.name, function (b) {
        var gal = el('div', undefined, 'gal'), main = el('img', undefined, 'main'); main.alt = p.name;
        var imgs = (p.images || []).filter(function (i) { return i.url; });
        if (imgs.length) {
          main.src = imgs[0].url; gal.appendChild(main);
          if (imgs.length > 1) { var th = el('div', undefined, 'thumbs'); imgs.forEach(function (i, n) { var t = el('img'); t.src = i.url; t.alt = ''; t.setAttribute('aria-current', String(n === 0)); t.addEventListener('click', function () { main.src = i.url; th.querySelectorAll('img').forEach(function (x) { x.setAttribute('aria-current', 'false'); }); t.setAttribute('aria-current', 'true'); }); th.appendChild(t); }); gal.appendChild(th); }
          b.appendChild(gal);
        }
        var vs = p.variants || [], sel = el('select');
        vs.forEach(function (v) { var o = el('option', (v.name && v.name !== 'Default' ? v.name + ' - ' : '') + money(v.price) + (v.in_stock ? '' : ' (sold out)')); o.value = v.id; o.disabled = !v.in_stock; sel.appendChild(o); });
        var firstOk = vs.filter(function (v) { return v.in_stock; })[0]; if (firstOk) sel.value = firstOk.id;
        var price = el('div', undefined, 'price'), stock = el('small', undefined, 'muted'), qty = input('number', { min: '1', step: '1', value: '1', inputmode: 'numeric' }), add = el('button', 'Add to cart', 'btn primary full'); add.type = 'button';
        function cur() { return vs.filter(function (v) { return v.id === sel.value; })[0]; }
        function paint() { var v = cur(); price.textContent = v ? money(v.price) : ''; add.disabled = !v || !v.in_stock; stock.textContent = v && v.available != null && v.in_stock ? v.available + ' available' : v && !v.in_stock ? 'Sold out' : ''; if (v && v.available != null) qty.max = String(v.available); }
        sel.addEventListener('change', paint); paint();
        price.style.fontSize = '1.4rem';
        b.appendChild(price); if (p.description) b.appendChild(el('p', p.description, 'desc'));
        if (vs.length > 1 || (vs[0] && vs[0].name !== 'Default')) b.appendChild(field('Choose an option', sel));
        b.appendChild(stock); b.appendChild(field('Quantity', qty));
        var err = note('', 'err'); err.hidden = true; b.appendChild(err); b.appendChild(add);
        add.addEventListener('click', async function () {
          var v = cur(), n = Math.max(1, Math.floor(Number(qty.value) || 1)); err.hidden = true; if (!v) return;
          add.disabled = true;
          try { S.cart = await cartApi('POST', '/cart/items', { variant_id: v.id, quantity: n }); paintCount(); modal.close(); toast('Added to your cart'); }
          catch (e) { err.textContent = e.message; err.hidden = false; add.disabled = false; }
        });
      });
    } catch (e) { open('Product', function (b) { b.appendChild(note(e.message, 'err')); }); }
  }

  /* ---------- cart ---------- */
  async function openCart() {
    await refreshCart();
    open('Your cart', function (b) {
      var items = S.cart.items || [];
      if (!items.length) { b.appendChild(el('p', 'Your cart is empty.', 'msg')); var c = el('button', 'Keep shopping', 'btn full'); c.type = 'button'; c.addEventListener('click', function () { modal.close(); }); b.appendChild(c); return; }
      var ul = el('ul', undefined, 'lines');
      items.forEach(function (i) {
        var li = el('li'); li.appendChild(i.image_url ? pic(i.image_url, i.product_name, 'th') : el('div', (i.product_name || '?').charAt(0).toUpperCase(), 'th'));
        var nm = el('div', i.product_name, 'nm'); if (i.variant_name && i.variant_name !== 'Default') nm.appendChild(el('small', i.variant_name)); nm.appendChild(el('small', money(i.selling_price) + ' each'));
        var q = el('span', undefined, 'qty'), minus = el('button', '-'), plus = el('button', '+'), n = el('span', String(Number(i.quantity)));
        minus.type = 'button'; plus.type = 'button'; minus.setAttribute('aria-label', 'One less'); plus.setAttribute('aria-label', 'One more');
        minus.addEventListener('click', function () { setQty(i.variant_id, Number(i.quantity) - 1); }); plus.addEventListener('click', function () { setQty(i.variant_id, Number(i.quantity) + 1); });
        q.appendChild(minus); q.appendChild(n); q.appendChild(plus); nm.appendChild(q); li.appendChild(nm);
        var right = el('div'); right.appendChild(el('div', money(i.line_total), 'lt')); var rm = el('button', 'Remove', 'rm'); rm.type = 'button'; rm.addEventListener('click', function () { setQty(i.variant_id, 0); }); right.appendChild(rm); li.appendChild(right);
        ul.appendChild(li);
      });
      b.appendChild(ul);
      var sum = el('div', undefined, 'sum'), tot = el('div', undefined, 'tot'); tot.appendChild(el('span', 'Subtotal')); tot.appendChild(el('span', money(S.cart.total))); sum.appendChild(tot);
      var min = Number(S.settings.min_order_amount) || 0; if (min && S.cart.total < min) sum.appendChild(note('The minimum order is ' + money(min) + '.'));
      b.appendChild(sum);
      var go = el('button', 'Checkout', 'btn primary full'); go.type = 'button'; go.disabled = Boolean(min && S.cart.total + 0.005 < min); go.addEventListener('click', openCheckout); b.appendChild(go);
    });
  }
  async function setQty(variantId, q) {
    try { S.cart = q > 0 ? await cartApi('PATCH', '/cart/items/' + encodeURIComponent(variantId), { quantity: q }) : await cartApi('DELETE', '/cart/items/' + encodeURIComponent(variantId)); paintCount(); openCart(); }
    catch (e) { toast(e.message); }
  }
  $('#cartBtn').addEventListener('click', openCart);

  /* ---------- checkout ---------- */
  function openCheckout() {
    var s = S.settings, zones = S.zones || [];
    open('Checkout', function (b) {
      var canDel = s.enable_delivery !== false && (zones.length > 0 || true), canPick = s.enable_pickup !== false;
      if (s.enable_delivery === false && s.enable_pickup === false) { b.appendChild(note('This shop is not taking orders right now.', 'err')); return; }
      var f = el('form', undefined, 'fld'); f.noValidate = true; f.style.gap = '.9rem'; f.style.display = 'grid';
      var name = input('text', { autocomplete: 'name', required: '' }), phone = input('tel', { autocomplete: 'tel', inputmode: 'tel', placeholder: '0712 345 678', required: '' }), email = input('email', { autocomplete: 'email' });
      var row = el('div', undefined, 'row2'); row.appendChild(field('Your name', name)); row.appendChild(field('Phone (M-Pesa)', phone, 'You will pay on this phone.')); f.appendChild(row);
      f.appendChild(field('Email (optional)', email));
      var pick = el('div', undefined, 'pick'), rD = input('radio', { name: 'ft', value: 'delivery' }), rP = input('radio', { name: 'ft', value: 'pickup' });
      var lD = el('label'), lP = el('label'); lD.appendChild(rD); lD.appendChild(el('span', 'Delivery')); lP.appendChild(rP); lP.appendChild(el('span', 'Pickup'));
      if (s.enable_delivery !== false) pick.appendChild(lD); if (canPick) pick.appendChild(lP);
      (s.enable_delivery !== false ? rD : rP).checked = true;
      var fw = el('div', undefined, 'fld'); fw.appendChild(el('span', 'How do you want your order?')); fw.appendChild(pick); f.appendChild(fw);
      var zone = el('select'); zones.forEach(function (z) { var o = el('option', z.name + ' - ' + money(z.fee)); o.value = z.id; zone.appendChild(o); });
      var addr = el('textarea'), dnote = input('text'), dBox = el('div'); dBox.style.display = 'grid'; dBox.style.gap = '.9rem';
      if (zones.length) dBox.appendChild(field('Delivery area', zone)); dBox.appendChild(field('Delivery address', addr, 'Building, street, landmark.')); dBox.appendChild(field('Directions (optional)', dnote)); f.appendChild(dBox);
      var cnote = el('textarea'); f.appendChild(field('Note to the shop (optional)', cnote));
      var sum = el('div', undefined, 'sum'); f.appendChild(sum);
      var err = note('', 'err'); err.hidden = true; f.appendChild(err);
      var go = el('button', 'Place order and pay with M-Pesa', 'btn primary full'); go.type = 'submit'; f.appendChild(go);
      function ft() { return rP.checked ? 'pickup' : 'delivery'; }
      function fee() { if (ft() !== 'delivery') return 0; var z = zones.filter(function (x) { return x.id === zone.value; })[0]; return z ? Number(z.fee) || 0 : 0; }
      function paint() {
        dBox.hidden = ft() !== 'delivery'; sum.textContent = '';
        function line(a, c, cls) { var d = el('div', undefined, cls); d.appendChild(el('span', a)); d.appendChild(el('span', c)); sum.appendChild(d); }
        line('Items', money(S.cart.total)); if (ft() === 'delivery') line('Delivery', money(fee())); line('Total', money(S.cart.total + fee()), 'tot');
      }
      [rD, rP, zone].forEach(function (x) { x.addEventListener('change', paint); }); paint();
      f.addEventListener('submit', async function (e) {
        e.preventDefault(); err.hidden = true;
        if (!name.value.trim() || !phone.value.trim()) { err.textContent = 'Enter your name and phone number.'; err.hidden = false; return; }
        if (ft() === 'delivery' && !addr.value.trim()) { err.textContent = 'Enter the delivery address.'; err.hidden = false; return; }
        go.disabled = true; go.textContent = 'Placing your order...';
        var body = { customer_name: name.value.trim(), customer_phone: phone.value.trim(), customer_email: email.value.trim() || undefined, fulfilment_type: ft(), customer_note: cnote.value.trim() || undefined };
        if (ft() === 'delivery') { body.delivery_address = addr.value.trim(); body.delivery_notes = dnote.value.trim() || undefined; if (zones.length) body.delivery_zone_id = zone.value; }
        try {
          var order = await cartApi('POST', '/checkout', body); S.cart = { items: [], total: 0 }; paintCount();
          store('kaunta.order.' + (slug || location.host), order.tracking_token);
          payOrder(order, phone.value.trim());
        } catch (ex) { err.textContent = ex.message; err.hidden = false; go.disabled = false; go.textContent = 'Place order and pay with M-Pesa'; }
      });
      b.appendChild(f);
    });
  }

  /* ---------- payment and tracking ---------- */
  function trackLink(token) { return location.origin + location.pathname + '?' + (slug ? 'shop=' + encodeURIComponent(slug) + '&' : '') + 'order=' + encodeURIComponent(token); }
  async function payOrder(order, phone) {
    open('Pay with M-Pesa', function (b) {
      var c = el('div', undefined, 'center'); c.appendChild(el('div', undefined, 'spin')); c.appendChild(el('b', 'Order ' + order.order_number + ' placed'));
      var status = el('p', 'Sending the payment request to your phone...', 'note'); c.appendChild(status);
      var retry = el('button', 'Send the request again', 'btn'); retry.type = 'button'; retry.hidden = true; c.appendChild(retry);
      var keep = el('p', 'Your items are held for ' + (order.hold_minutes || 15) + ' minutes. Order link: ', 'note'), a = el('a', 'track this order'); a.href = trackLink(order.tracking_token); keep.appendChild(a); c.appendChild(keep);
      b.appendChild(c);
      var me = polling;
      async function send() {
        retry.hidden = true;
        try { var r = await api('POST', '/orders/' + encodeURIComponent(order.tracking_token) + '/pay', { phone: phone }); status.className = 'note'; status.textContent = r.message || 'Check your phone and enter your M-Pesa PIN.'; watch(); }
        catch (e) { status.className = 'note err'; status.textContent = e.message; retry.hidden = false; }
      }
      async function watch() {
        for (var n = 0; n < 45; n++) {
          await new Promise(function (r) { setTimeout(r, 4000); }); if (me !== polling) return;
          try { var o = await api('GET', '/orders/' + encodeURIComponent(order.tracking_token)); if (me !== polling) return;
            if (paid(o)) return showOrder(o, true);
            if (o.fulfilment_status === 'cancelled') { status.className = 'note err'; status.textContent = 'The order was cancelled.'; return; }
          } catch (e) { /* keep waiting */ }
        }
        if (me === polling) { status.className = 'note err'; status.textContent = 'We have not received the payment yet. If you paid, it can take a minute to appear. Otherwise send the request again.'; retry.hidden = false; }
      }
      retry.addEventListener('click', send); send();
    });
  }
  function paid(o) { return o.payment_status === 'paid' || (o.fulfilment_status && ['awaiting_payment', 'cancelled'].indexOf(o.fulfilment_status) < 0); }
  function showOrder(o, justPaid) {
    open('Order ' + (o.sale_number || ''), function (b) {
      var c = el('div', undefined, 'center');
      if (justPaid) { c.appendChild(el('div', '✓', 'tick')); c.appendChild(el('b', 'Thank you, ' + (o.customer_name || '') + '! Your payment is received.')); }
      c.appendChild(el('p', 'Status: ' + String(o.fulfilment_status || '').replace(/_/g, ' ') + (paid(o) ? '' : ' (not paid yet)'), 'note' + (paid(o) ? ' ok' : '')));
      b.appendChild(c);
      var ul = el('ul', undefined, 'lines'); (o.items || []).forEach(function (i) { var li = el('li'); li.style.gridTemplateColumns = 'minmax(0,1fr) auto'; li.appendChild(el('div', Number(i.quantity) + ' x ' + i.product_name + (i.variant_name && i.variant_name !== 'Default' ? ' - ' + i.variant_name : ''), 'nm')); li.appendChild(el('div', money(i.line_total), 'lt')); ul.appendChild(li); });
      b.appendChild(ul);
      var sum = el('div', undefined, 'sum'), tot = el('div', undefined, 'tot'); tot.appendChild(el('span', 'Total')); tot.appendChild(el('span', money(o.total))); sum.appendChild(tot); b.appendChild(sum);
      if (o.fulfilment_type === 'delivery' && o.delivery_address) b.appendChild(el('p', 'Delivering to: ' + o.delivery_address, 'desc'));
      var done = el('button', 'Continue shopping', 'btn full'); done.type = 'button'; done.addEventListener('click', function () { modal.close(); }); b.appendChild(done);
    });
  }
  async function openTracked(token) {
    open('Your order', function (b) { b.appendChild(el('div', undefined, 'spin')); });
    try { showOrder(await api('GET', '/orders/' + encodeURIComponent(token)), false); }
    catch (e) { open('Your order', function (b) { b.appendChild(note(e.message, 'err')); }); }
  }

  /* ---------- info pages ---------- */
  async function openPage(pslug, title) {
    open(title || 'Page', function (b) { b.appendChild(el('div', undefined, 'spin')); });
    try { var p = await api('GET', '/pages/' + encodeURIComponent(pslug)); open(p.title, function (b) { b.appendChild(el('p', p.content || '', 'desc')); }); }
    catch (e) { open(title || 'Page', function (b) { b.appendChild(note(e.message, 'err')); }); }
  }

  /* ---------- start ---------- */
  function unavailable(text) {
    $('#main').hidden = true; $('.bar').hidden = true; $('#foot').hidden = true; $('#gone').hidden = false;
    if (text) $('#goneText').textContent = text;
  }
  (async function () {
    try {
      var d = await api('GET', '');
      applySettings(d.settings || {}); banners(d.banners); pagesFooter(d.pages); S.zones = d.delivery_zones || []; $('#foot').hidden = false;
      onShopHost = !slug;
      api('GET', '/categories').then(categories).catch(function () { /* the grid still works */ });
      refreshCart(); loadProducts(true);
      var tok = params.get('order'); if (tok) openTracked(tok);
    } catch (e) {
      if (e.status === 404 && !slug && /^(localhost|127\.|\[)/.test(location.hostname)) unavailable('To preview a shop on localhost, open this page as store.html?shop=your-shop-name. The shop must also be published.');
      else if (e.status === 404 || e.status === 400) unavailable(slug ? 'That shop was not found, or it is not published yet. Publish it from the Online store page in your dashboard.' : undefined);
      else unavailable(e.message);
    }
  })();
})();