/* Dashboard overview. Calls GET /reports/dashboard (numbers), GET /tenant/onboarding (setup card),
   GET /storefront/settings (store link) and GET /branches (branch picker, only when there is more than one). */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var el = K.el, money = K.money0;
  var user = K.session.user || {}, branchId = '';
  var shopTitle = (K.session.tenant && K.session.tenant.name) || 'your shop';
  var hour = new Date().getHours();

  function hello(name) { return (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + String(name).split(' ')[0] : ''); }
  function paintHello(name, shop) { $('#greet').textContent = hello(name); $('#lede').textContent = 'Here is how ' + (shop || shopTitle) + ' is doing today.'; }
  paintHello(user.name || user.full_name);
  document.addEventListener('kaunta:identity', function (e) { var d = e.detail || {}; paintHello(d.user && d.user.full_name, d.tenant && d.tenant.name); });

  function friendly(e) {
    if (e.status === 403) return 'Your role does not include reports. Ask the shop owner for access.';
    if (e.status === 402 || e.code === 'subscription_inactive') return e.message;
    return 'We could not load your numbers right now. Please try again in a few minutes.';
  }

  /* ---------- the sales card ---------- */
  function chart(trend) {
    var box = $('#chart'), days = $('#days'); box.textContent = ''; days.textContent = '';
    if (!trend.length) { box.appendChild(el('p', 'Sales for the week will draw here.', 'hs-empty')); return; }
    var W = 600, H = 150, P = 18, n = trend.length;
    var vals = trend.map(function (d) { return Number(d.net_sales) || 0; }), max = Math.max.apply(null, vals.concat([1]));
    var pts = vals.map(function (v, i) { return { x: (i + 0.5) * (W / n), y: H - P - (v / max) * (H - 2 * P) }; });
    var d = 'M' + pts[0].x + ' ' + pts[0].y;
    for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], b = pts[i], mx = (a.x + b.x) / 2; d += ' C' + mx + ' ' + a.y + ' ' + mx + ' ' + b.y + ' ' + b.x + ' ' + b.y; }
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<defs><linearGradient id="hsfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3b63a" stop-opacity=".4"/><stop offset="1" stop-color="#f3b63a" stop-opacity="0"/></linearGradient></defs>' +
      '<path class="area" d="' + d + ' L' + pts[n - 1].x + ' ' + H + ' L' + pts[0].x + ' ' + H + ' Z" fill="url(#hsfill)"/>' +
      '<path class="line" pathLength="1" d="' + d + '" fill="none" stroke="#f3b63a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    box.appendChild(svg);
    trend.forEach(function (t, i) {
      var dot = el('span', undefined, 'dot' + (i === n - 1 ? ' today' : '')), day = new Date(t.bucket + 'T00:00');
      dot.style.left = (pts[i].x / W * 100) + '%'; dot.style.top = (pts[i].y / H * 100) + '%';
      dot.title = day.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'short' }) + ': ' + money(t.net_sales);
      box.appendChild(dot);
      days.appendChild(el('span', day.toLocaleDateString('en-KE', { weekday: 'short' }), i === n - 1 ? 'today' : ''));
    });
  }
  function delta(trend) {
    var tag = $('#delta'); tag.hidden = true;
    if (trend.length < 2) return;
    var t = Number(trend[trend.length - 1].net_sales) || 0, y = Number(trend[trend.length - 2].net_sales) || 0;
    if (y <= 0 || t <= 0) return;
    var pct = Math.round(Math.abs(t - y) / y * 100);
    tag.textContent = pct === 0 ? 'Same as yesterday' : pct + '% ' + (t > y ? 'above' : 'below') + ' yesterday';
    tag.className = 'hs-delta' + (t < y ? ' down' : ''); tag.hidden = false;
  }

  /* ---------- the rest ---------- */
  function attention(a) {
    var items = [
      ['Products running low', a.low_stock_count, 'warn', 'package', 'products.html'],
      ['Batches expiring in 30 days', a.expiring_30_days, 'warn', 'hourglass', null],
      ['Open tabs', a.open_tabs, 'info', 'notebook', null],
      ['M-Pesa payments not matched to a sale', a.unmatched_mpesa_payments, 'bad', 'device-mobile', 'mpesa.html'],
      ['eTIMS receipts that failed', a.etims && a.etims.failed, 'bad', 'seal-warning', 'etims.html'],
      ['eTIMS receipts waiting', a.etims && a.etims.pending, 'info', 'seal-check', 'etims.html']
    ].filter(function (r) { return Number(r[1]) > 0; });
    if (Number(a.customers_owe) > 0) items.push(['Owed by customers', money(a.customers_owe), 'info', 'hand-coins', null]);
    var ul = $('#attn'); ul.textContent = '';
    if (!items.length) { var li0 = el('li'); var c = el('p', undefined, 'clear'); c.appendChild(el('span', undefined, 'ic sm')).appendChild(K.icon('check')); c.appendChild(el('span', 'All clear. Nothing needs you right now.')); li0.appendChild(c); ul.appendChild(li0); return; }
    items.forEach(function (r) {
      var li = el('li'), tile = el('span', undefined, 'ic sm ' + (r[2] === 'bad' ? 'red' : r[2] === 'warn' ? 'gold' : 'blue')); tile.appendChild(K.icon(r[3]));
      var label;
      if (r[4]) { label = el('a', r[0], 't'); label.href = r[4]; label.style.fontWeight = '500'; } else label = el('span', r[0], 't');
      li.appendChild(tile); li.appendChild(label); li.appendChild(el('span', String(r[1]), 'tag ' + r[2])); ul.appendChild(li);
    });
  }
  var COLORS = { cash: '#0f5c44', mpesa: '#f3b63a', 'm-pesa': '#f3b63a', card: '#2c62c9', credit: '#8a5fd6', other: '#7a8a82' };
  function payments(list) {
    var box = $('#pay'); box.textContent = '';
    list = (list || []).filter(function (m) { return Number(m.total || m.amount) > 0; });
    if (!list.length) { box.appendChild(el('p', 'No payments yet today. They show up here the moment you ring up a sale.', 'muted')); return; }
    var sum = list.reduce(function (s, m) { return s + Number(m.total || m.amount); }, 0), acc = 0, stops = [], leg = el('ul', undefined, 'legend');
    list.forEach(function (m, i) {
      var raw = String(m.method || m.payment_method || m.name || 'Other'), key = raw.toLowerCase().replace(/_/g, ' '), amt = Number(m.total || m.amount);
      var color = COLORS[key] || ['#0f5c44', '#f3b63a', '#2c62c9', '#8a5fd6', '#7a8a82'][i % 5], from = acc / sum * 100; acc += amt;
      stops.push(color + ' ' + from + '% ' + (acc / sum * 100) + '%');
      var li = el('li'), sw = el('i'); sw.style.background = color; li.appendChild(sw);
      var name = key === 'mpesa' ? 'M-Pesa' : key.charAt(0).toUpperCase() + key.slice(1); li.appendChild(el('span', name));
      var v = el('b', money(amt)); v.appendChild(el('small', Math.round(amt / sum * 100) + '%')); li.appendChild(v); leg.appendChild(li);
    });
    var donut = el('div', undefined, 'donut'); donut.style.background = 'conic-gradient(' + stops.join(',') + ')';
    var mid = el('div'); mid.appendChild(el('b', money(sum))); mid.appendChild(el('small', 'collected')); donut.appendChild(mid);
    box.appendChild(donut); box.appendChild(leg);
  }
  function lowStock(rows) {
    var tb = $('#low'); tb.textContent = '';
    if (!rows || !rows.length) { var tr = el('tr'), td = el('td'); td.colSpan = 4; var p = el('p', undefined, 'clear'); p.appendChild(el('span', undefined, 'ic sm')).appendChild(K.icon('check')); p.appendChild(el('span', 'Every product is above its reorder level.')); td.appendChild(p); tr.appendChild(td); tb.appendChild(tr); return; }
    rows.forEach(function (p) {
      var tr = el('tr'), n = p.product_name || p.name || '', qty = Number(p.quantity_on_hand) || 0, re = Number(p.reorder_level) || 0;
      var c1 = el('td'); c1.appendChild(el('b', n)); if (p.variant_name && p.variant_name !== n && p.variant_name !== 'Default') { var s = el('span', ' ' + p.variant_name, 'muted'); c1.appendChild(s); } tr.appendChild(c1);
      tr.appendChild(el('td', p.sku || '', 'mono'));
      var c3 = el('td'), cell = el('div', undefined, 'stockcell'), bar = el('div', undefined, 'bar ' + (qty <= 0 ? 'bad' : 'warn')), fill = el('i');
      fill.style.width = (re > 0 ? Math.max(4, Math.min(100, qty / re * 100)) : (qty > 0 ? 100 : 4)) + '%'; bar.appendChild(fill); cell.appendChild(bar); cell.appendChild(el('b', String(qty), 'num')); c3.appendChild(cell); tr.appendChild(c3);
      tr.appendChild(el('td', p.reorder_level == null ? '' : String(p.reorder_level), 'r num')); tb.appendChild(tr);
    });
  }
  function render(d) {
    var t = d.today || {}, trend = d.trend || [];
    K.countUp($('#net'), Number(t.net_sales) || 0, money);
    $('#netSub').textContent = Number(t.refunds) ? 'After ' + money(Math.abs(t.refunds)) + ' in refunds' : 'No refunds today';
    K.countUp($('#cnt'), Number(t.sales_count) || 0, function (n) { return String(Math.round(n)); });
    K.countUp($('#avg'), Number(t.average_sale) || 0, money); K.countUp($('#gp'), Number(t.gross_profit) || 0, money);
    chart(trend); delta(trend); attention(d.attention || {}); payments(t.payment_methods); lowStock((d.attention || {}).low_stock);
  }
  async function load() {
    var box = $('#err'); box.hidden = true;
    try { render(await K.api('GET', '/reports/dashboard' + (branchId ? '?branch_id=' + encodeURIComponent(branchId) : ''))); }
    catch (e) { if (e.message) { $('#errText').textContent = friendly(e); box.hidden = false; } }
  }
  $('#retry').addEventListener('click', load);

  async function loadBranches() {
    try {
      var list = await K.branches(), allowed = user.branch_ids || [];
      list = list.filter(function (b) { return !allowed.length || allowed.indexOf(b.id) > -1; });
      if (list.length < 2) return;
      var sel = $('#branch'); sel.appendChild(el('option', 'All branches')).value = '';
      list.forEach(function (b) { sel.appendChild(el('option', b.name)).value = b.id; });
      sel.hidden = false; sel.addEventListener('change', function () { branchId = sel.value; load(); });
    } catch (e) { /* the overview still works for all branches */ }
  }

  /* ---------- "Get your shop ready" card ----------
     GET /tenant/onboarding works every step out from real data, so there is nothing to tick by hand.
     Hidden when every step is done, when the owner dismissed it, or when the person may not manage settings. */
  function started(d) {
    var box = $('#gs');
    if (!d || d.dismissed || d.complete || !d.steps || !d.steps.length) { box.hidden = true; return; }
    var pct = Math.round((d.done / d.total) * 100), ring = $('#gsRing');
    $('#gsSub').textContent = d.done + ' of ' + d.total + ' steps done. Each one takes a few minutes.';
    ring.style.setProperty('--p', String(pct)); ring.setAttribute('aria-valuenow', String(pct)); $('#gsPct').textContent = pct + '%';
    var list = $('#gsList'); list.textContent = '';
    var next = d.steps.filter(function (s) { return !s.done; })[0];
    d.steps.forEach(function (s, i) {
      var li = el('li', undefined, (s.done ? 'done' : '') + (s === next ? ' next' : '')), mark = el('span', undefined, 'mark');
      if (s.done) mark.appendChild(K.icon('check')); else mark.textContent = String(i + 1);
      var body = el('div', undefined, 'gs-t'), title = el('b', s.title);
      if (s.optional) title.appendChild(el('span', 'Optional', 'tag'));
      body.appendChild(title); body.appendChild(el('p', s.hint, 'muted'));
      var a = el('a', s.done ? 'Review' : s.cta, 'btn sm' + (s === next ? ' primary' : '')); a.href = s.href;
      li.appendChild(mark); li.appendChild(body); li.appendChild(a); list.appendChild(li);
    });
    $('#gsFoot').hidden = !d.etims_hidden;
    box.hidden = false;
  }
  async function loadStarted() { try { started(await K.api('GET', '/tenant/onboarding')); } catch (e) { $('#gs').hidden = true; } }
  $('#gsDismiss').addEventListener('click', async function () { $('#gs').hidden = true; try { await K.api('POST', '/tenant/onboarding/dismiss'); } catch (e) { loadStarted(); } });
  $('#gsVat').addEventListener('click', async function () { try { await K.api('PATCH', '/tenant', { vat_registered: true }); } catch (e) { /* shown again below */ } loadStarted(); });

  /* ---------- link to the online store ----------
     Live: opens the customer page in a new tab. Not published yet: goes to the Online store settings, where Publish is.
     Hidden when the shop has the store module switched off, or the person may not manage it. */
  async function loadStoreLink() {
    var a = $('#viewStore'), slug = K.session.tenant && K.session.tenant.slug;
    try {
      var s = await K.api('GET', '/storefront/settings'), live = Boolean(s && s.is_published);
      a.hidden = false;
      if (live) { a.href = 'store.html?shop=' + encodeURIComponent(slug || ''); a.target = '_blank'; a.rel = 'noopener'; a.title = 'See your store as customers see it'; $('#viewStoreText').textContent = 'View store'; }
      else { a.href = 'storefront.html'; a.removeAttribute('target'); a.title = 'Your store is not published yet'; $('#viewStoreText').textContent = 'Set up your store'; }
    } catch (e) { a.hidden = true; }
  }

  loadBranches(); load(); loadStarted(); loadStoreLink();
})();
