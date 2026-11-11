/* Kaunta dashboard: overview. Reads the session saved at sign-in ("kaunta.session") and calls GET /reports/dashboard. */
(function () {
  'use strict';
  var API = (window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api';
  var KEY = 'kaunta.session';
  var $ = function (s) { return document.querySelector(s); };
  var kes = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 });
  var session = read();
  if (!session || !session.access_token) return toLogin();

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ } }
  function toLogin() { location.replace('login.html?next=dashboard.html'); }
  function slug() { return session.tenant && session.tenant.slug; }
  function money(n) { return kes.format(Number(n) || 0); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

  async function raw(path, opts, token) {
    var h = { Accept: 'application/json', Authorization: 'Bearer ' + token };
    if (slug()) h['X-Tenant'] = slug();
    if (opts && opts.body) h['Content-Type'] = 'application/json';
    return fetch(API + path, Object.assign({ headers: h }, opts));
  }
  async function refresh() {
    try {
      var r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': slug() || '' }, body: JSON.stringify({ refresh_token: session.refresh_token, shop: slug() }) });
      var j = await r.json(); var d = j && j.data; var s = d && (d.session || d);
      if (!r.ok || !s || !s.access_token) return false;
      session.access_token = s.access_token; if (s.refresh_token) session.refresh_token = s.refresh_token; save(); return true;
    } catch (e) { return false; }
  }
  async function get(path) {
    var res;
    try { res = await raw(path, {}, session.access_token); } catch (e) { throw new Error('We could not reach the server. Check your connection and try again.'); }
    if (res.status === 401) { if (await refresh()) res = await raw(path, {}, session.access_token); else { toLogin(); throw new Error(''); } }
    if (res.status === 401) { toLogin(); throw new Error(''); }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      if (res.status === 402 || (j && j.error && j.error.code === 'subscription_inactive')) throw new Error('Your subscription is not active. Renew it to see your numbers.');
      if (res.status === 403) throw new Error('Your role does not include reports. Ask the shop owner for access.');
      throw new Error('We could not load your numbers right now. Please try again in a few minutes.');
    }
    return j.data;
  }

  /* ---------- header ---------- */
  var hour = new Date().getHours(), user = session.user || {};
  $('#shopName').textContent = (session.tenant && session.tenant.name) || 'Your shop';
  $('#userName').textContent = user.name || user.full_name || '';
  $('#greet').textContent = (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + (user.name ? ', ' + String(user.name).split(' ')[0] : '');
  $('#menuBtn').addEventListener('click', function () { var o = $('#side').classList.toggle('open'); this.setAttribute('aria-expanded', o); });
  $('#signOut').addEventListener('click', async function () {
    try { await raw('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) }, session.access_token); } catch (e) { /* signing out anyway */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    location.replace('login.html');
  });

  /* ---------- branches (only shown when the person can work in more than one) ---------- */
  var branchSel = $('#branch'), branchId = '';
  async function loadBranches() {
    try {
      var d = await get('/branches'); var list = Array.isArray(d) ? d : (d && (d.branches || d.items)) || [];
      var allowed = user.branch_ids || [];
      list = list.filter(function (b) { return !allowed.length || allowed.indexOf(b.id) > -1; });
      if (list.length < 2) return;
      branchSel.appendChild(el('option', 'All branches')).value = '';
      list.forEach(function (b) { branchSel.appendChild(el('option', b.name)).value = b.id; });
      branchSel.hidden = false;
      branchSel.addEventListener('change', function () { branchId = branchSel.value; load(); });
    } catch (e) { /* the overview still works for all branches */ }
  }

  /* ---------- render ---------- */
  function attention(a) {
    var items = [
      ['Products running low', a.low_stock_count, true], ['Batches expiring in 30 days', a.expiring_30_days, true],
      ['Open tabs', a.open_tabs, false], ['M-Pesa payments not matched to a sale', a.unmatched_mpesa_payments, true],
      ['eTIMS receipts that failed', a.etims && a.etims.failed, true], ['eTIMS receipts waiting', a.etims && a.etims.pending, false]
    ].filter(function (r) { return Number(r[1]) > 0; });
    var ul = $('#attn'); ul.textContent = '';
    if (Number(a.customers_owe) > 0) items.push(['Owed by customers', money(a.customers_owe), false]);
    if (!items.length) { var li = el('li'); li.appendChild(el('p', 'All clear. Nothing needs you right now.', 'clear')); ul.appendChild(li); return; }
    items.forEach(function (r) { var li = el('li'); li.appendChild(el('span', r[0])); li.appendChild(el('span', String(r[1]), 'tag' + (r[2] ? ' warn' : ''))); ul.appendChild(li); });
  }
  function payments(list) {
    var ul = $('#pay'); ul.textContent = '';
    list = (list || []).filter(function (m) { return Number(m.total || m.amount) !== 0; });
    if (!list.length) { var li = el('li'); li.appendChild(el('p', 'No payments yet today.', 'muted')); ul.appendChild(li); return; }
    list.forEach(function (m) { var li = el('li'); var name = String(m.method || m.payment_method || m.name || 'Other').replace(/_/g, ' '); li.appendChild(el('span', name.charAt(0).toUpperCase() + name.slice(1))); li.appendChild(el('b', money(m.total || m.amount))); ul.appendChild(li); });
  }
  function lowStock(rows) {
    var tb = $('#low'); tb.textContent = '';
    if (!rows || !rows.length) { var tr = el('tr'), td = el('td', 'Every product is above its reorder level.', 'clear'); td.colSpan = 4; tr.appendChild(td); tb.appendChild(tr); return; }
    rows.forEach(function (p) {
      var tr = el('tr'), n = p.product_name || p.name || '';
      tr.appendChild(el('td', p.variant_name && p.variant_name !== n ? n + ' (' + p.variant_name + ')' : n));
      tr.appendChild(el('td', p.sku || ''));
      tr.appendChild(el('td', String(p.quantity_on_hand), 'r')); tr.appendChild(el('td', String(p.reorder_level == null ? '' : p.reorder_level), 'r'));
      tb.appendChild(tr);
    });
  }
  function bars(trend) {
    var box = $('#bars'); box.textContent = '';
    var max = Math.max.apply(null, trend.map(function (d) { return Number(d.net_sales) || 0; }).concat([1]));
    trend.forEach(function (d, i) {
      var col = el('div', undefined, i === trend.length - 1 ? 'today' : ''), bar = el('i');
      bar.style.height = Math.max(2, Math.round(((Number(d.net_sales) || 0) / max) * 100)) + '%';
      bar.title = d.bucket + ': ' + money(d.net_sales);
      col.appendChild(bar); col.appendChild(el('span', new Date(d.bucket + 'T00:00').toLocaleDateString('en-KE', { weekday: 'short' }).slice(0, 3)));
      box.appendChild(col);
    });
  }
  function render(d) {
    var t = d.today || {};
    $('#net').textContent = money(t.net_sales);
    $('#netSub').textContent = Number(t.refunds) ? 'After ' + money(Math.abs(t.refunds)) + ' in refunds' : 'No refunds today';
    $('#cnt').textContent = String(t.sales_count || 0); $('#avg').textContent = money(t.average_sale); $('#gp').textContent = money(t.gross_profit);
    $('#dateLine').textContent = new Date(d.date + 'T00:00').toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' });
    bars(d.trend || []); attention(d.attention || {}); payments(t.payment_methods); lowStock((d.attention || {}).low_stock);
  }

  async function load() {
    var box = $('#err'); box.hidden = true;
    try { render(await get('/reports/dashboard' + (branchId ? '?branch_id=' + encodeURIComponent(branchId) : ''))); }
    catch (e) { if (e.message) { $('#errText').textContent = e.message; box.hidden = false; } }
  }
  $('#retry').addEventListener('click', load);
  loadBranches(); load();
})();