/* Shared helpers for the setup pages (products, test-sale, mpesa, etims, storefront).
   Reads the session saved at sign-in ("kaunta.session"), refreshes the token when it expires,
   and exposes window.KApp. The dashboard has its own copy of this logic in dashboard.js. */
(function () {
  'use strict';
  var API = (window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api';
  var KEY = 'kaunta.session';
  var kes = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ } }
  var session = read();
  function toLogin() { location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'dashboard.html')); }
  if (!session || !session.access_token) { toLogin(); return; }

  function slug() { return session.tenant && session.tenant.slug; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

  async function refresh() {
    try {
      var r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': slug() || '' }, body: JSON.stringify({ refresh_token: session.refresh_token, shop: slug() }) });
      var j = await r.json(); var d = j && j.data; var s = d && (d.session || d);
      if (!r.ok || !s || !s.access_token) return false;
      session.access_token = s.access_token; if (s.refresh_token) session.refresh_token = s.refresh_token; save(); return true;
    } catch (e) { return false; }
  }
  function send(method, path, body, headers) {
    var h = Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + session.access_token }, headers || {});
    if (slug()) h['X-Tenant'] = slug();
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /* api('GET', '/products') -> data. Throws an Error with a message safe to show, plus .code and .status. */
  async function api(method, path, body, headers) {
    var res;
    try { res = await send(method, path, body, headers); } catch (e) { throw new Error('We could not reach the server. Check your connection and try again.'); }
    if (res.status === 401) { if (await refresh()) res = await send(method, path, body, headers); }
    if (res.status === 401) { toLogin(); throw new Error(''); }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      var err = (j && j.error) || {};
      var msg = err.message || 'Something went wrong. Please try again.';
      if (res.status === 402 || err.code === 'subscription_inactive') msg = 'Your subscription is not active. Renew it to continue.';
      var e = new Error(msg); e.status = res.status; e.code = err.code; e.details = err.details; throw e;
    }
    return j.data;
  }

  /* The branch stock and sales are booked to: the main branch, or the only one. */
  var branchCache = null;
  async function branches() {
    if (!branchCache) {
      var d = await api('GET', '/branches');
      var list = Array.isArray(d) ? d : (d && (d.branches || d.items)) || [];
      branchCache = list.filter(function (b) { return b.is_active !== false; });
      branchCache.sort(function (a, b) { return (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0); });
    }
    return branchCache;
  }

  /* notice(box, 'text', 'ok' | 'err') */
  function notice(box, text, kind) { box.textContent = text || ''; box.className = 'note ' + (kind || 'ok'); box.hidden = !text; }
  function busy(btn, on, label) { btn.disabled = on; if (label !== undefined) btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = on ? (label || 'Working...') : (btn.dataset.label || btn.textContent); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* Shrinks a chosen image in the browser and returns a data URL of at most about 380 KB (the server's cap is 400 KB).
     o.max     longest side in pixels (default 512)
     o.square  crop the middle to a square first (profile pictures)
     o.png     try PNG first so a logo keeps its transparent background; falls back to JPEG when too big */
  var MAX_CHARS = 520000;
  function photo(file, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var sw = img.width, sh = img.height, sx = 0, sy = 0;
        if (o.square) { var m = Math.min(sw, sh); sx = (sw - m) / 2; sy = (sh - m) / 2; sw = sh = m; }
        var scale = Math.min(1, (o.max || 512) / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var g = c.getContext('2d'), out = null;
        if (o.png) { g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h); out = c.toDataURL('image/png'); if (out.length <= MAX_CHARS) return resolve(out); }
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        [0.85, 0.7, 0.55].some(function (q) { out = c.toDataURL('image/jpeg', q); return out.length <= MAX_CHARS; });
        out.length <= MAX_CHARS ? resolve(out) : reject(new Error('That picture is too detailed to shrink enough. Try another one.'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('We could not read that picture. Use a JPEG, PNG or WebP image.')); };
      img.src = url;
    });
  }
  /* upload(dataUrl) -> the link to save (POST /media) */
  async function upload(dataUrl) { return (await api('POST', '/media', { data: dataUrl })).url; }

  /* identity() -> GET /auth/me once per page: { user, tenant, branches, features }, or null if it fails. */
  var idPromise = null;
  function identity() { if (!idPromise) idPromise = api('GET', '/auth/me').catch(function () { return null; }); return idPromise; }

  /* avatar(node, url, name): puts the picture in a round (or rounded) box, or the first letter when there is none. */
  function avatar(node, url, name) {
    if (!node) return;
    node.textContent = '';
    var letter = (name || '?').trim().charAt(0).toUpperCase();
    if (!url) { node.textContent = letter; return; }
    var im = document.createElement('img'); im.alt = ''; im.src = url; im.addEventListener('error', function () { node.textContent = letter; });
    node.appendChild(im);
  }
  /* patchSession(fn): change what the pages remember about who is signed in (shop name, person's name). */
  function patchSession(fn) { try { fn(session); } catch (e) { /* ignore */ } save(); }
  function can(user, key) {
    var p = (user && user.permissions) || [];
    return Boolean(user && user.is_owner) || (Array.isArray(p) && (p.indexOf('*') > -1 || p.indexOf(key) > -1 || p.indexOf(key.split('.')[0] + '.*') > -1));
  }

  function init() {
    var shop = document.getElementById('shopName'); if (shop) shop.textContent = (session.tenant && session.tenant.name) || 'Your shop';
    var av = document.querySelector('.step-top .av');
    if (av) { avatar(av, null, (session.tenant && session.tenant.name) || 'K'); identity().then(function (d) { if (d && d.tenant) { avatar(av, d.tenant.logo_url, d.tenant.name); if (shop) shop.textContent = d.tenant.name || shop.textContent; } }); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.KApp = {
    api: api, branches: branches, el: el, notice: notice, busy: busy, num: num,
    photo: photo, upload: upload, identity: identity, avatar: avatar, patchSession: patchSession, can: can,
    money: function (n) { return kes.format(Number(n) || 0); },
    uuid: function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
    session: session
  };
})();