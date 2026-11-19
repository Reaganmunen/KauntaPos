/* Shop directory: lists shops with a live online store (GET /api/directory, no login).
   Each card opens that shop's store at store.html?shop=<slug>. All text is set with textContent. */
(function () {
  'use strict';
  var CFG = window.KAUNTA_CONFIG || {};
  var API = (CFG.API || '/api').replace(/\/$/, '');
  var $ = function (s) { return document.querySelector(s); };
  var TYPES = { retail: 'Retail and wholesale', restaurant: 'Restaurant', pharmacy: 'Pharmacy', general: 'General shop' };
  function typeLabel(t) { return TYPES[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : 'Shop'); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

  var q = $('#q'), type = $('#type'), county = $('#county'), grid = $('#grid');
  var filled = false, timer = null, seq = 0;

  var year = $('#year'); if (year) year.textContent = new Date().getFullYear();

  var qs = new URLSearchParams(location.search);
  q.value = (qs.get('q') || '').slice(0, 60);

  function fillSelect(sel, values, label) {
    var keep = sel.value;
    sel.textContent = '';
    var all = el('option', label); all.value = ''; sel.appendChild(all);
    values.forEach(function (v) { var o = el('option', label === 'All counties' ? v : typeLabel(v)); o.value = v; sel.appendChild(o); });
    sel.value = keep;
  }
  function skeleton() {
    grid.textContent = ''; grid.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 6; i++) { var s = el('div', null, 'shop-sk'); s.setAttribute('aria-hidden', 'true'); grid.appendChild(s); }
  }
  function card(s) {
    var a = el('a', null, 'shop-card');
    a.href = 'store.html?shop=' + encodeURIComponent(s.slug);
    var top = el('div', null, 'shop-top'), logo = el('span', null, 'shop-logo');
    var letter = (s.name || '?').trim().charAt(0).toUpperCase();
    if (s.logo_url) {
      var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.src = s.logo_url;
      im.addEventListener('error', function () { logo.textContent = letter; });
      logo.appendChild(im);
    } else { logo.textContent = letter; }
    top.appendChild(logo); top.appendChild(el('h2', s.name));
    a.appendChild(top);
    a.appendChild(el('p', s.tagline || 'Shop online with ' + s.name + '.', 'shop-tag'));
    var meta = el('div', null, 'shop-meta');
    meta.appendChild(el('span', typeLabel(s.business_type), 'chip'));
    if (s.county) meta.appendChild(el('span', s.county, 'chip'));
    meta.appendChild(el('span', 'Visit store', 'shop-go'));
    a.appendChild(meta);
    return a;
  }

  async function load() {
    var mine = ++seq;
    $('#empty').hidden = true; $('#error').hidden = true;
    skeleton();
    var params = new URLSearchParams();
    if (q.value.trim()) params.set('q', q.value.trim());
    if (type.value) params.set('type', type.value);
    if (county.value) params.set('county', county.value);
    var res;
    try {
      var r = await fetch(API + '/directory' + (params.toString() ? '?' + params : ''), { headers: { Accept: 'application/json' } });
      res = await r.json();
      if (!r.ok || !res || res.success === false) throw new Error('bad');
    } catch (e) {
      if (mine !== seq) return;
      grid.textContent = ''; grid.removeAttribute('aria-busy'); $('#count').textContent = ''; $('#error').hidden = false; return;
    }
    if (mine !== seq) return; /* a newer search is already running */
    var shops = res.data || [], meta = res.meta || {};
    if (!filled) { fillSelect(type, meta.types || [], 'All kinds of shop'); fillSelect(county, meta.counties || [], 'All counties'); filled = true; }
    grid.textContent = ''; grid.removeAttribute('aria-busy');
    shops.forEach(function (s) { grid.appendChild(card(s)); });
    var total = meta.total != null ? meta.total : shops.length;
    $('#count').textContent = total === 0 ? '' : total === 1 ? '1 shop' : total + ' shops' + (total > shops.length ? ', showing ' + shops.length : '');
    var filtered = Boolean(q.value.trim() || type.value || county.value);
    $('#empty').hidden = shops.length > 0;
    $('#emptyText').textContent = filtered ? 'Try a different name or clear the filters.' : 'No shops have opened an online store yet. Check back soon.';
    $('#clear').hidden = !filtered;
    var next = new URLSearchParams(); if (q.value.trim()) next.set('q', q.value.trim());
    history.replaceState(null, '', location.pathname + (next.toString() ? '?' + next : ''));
  }

  $('#filter').addEventListener('submit', function (e) { e.preventDefault(); load(); });
  q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
  type.addEventListener('change', load);
  county.addEventListener('change', load);
  $('#clear').addEventListener('click', function () { q.value = ''; type.value = ''; county.value = ''; load(); });
  $('#retry').addEventListener('click', load);
  load();
})();
