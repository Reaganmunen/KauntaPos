/* Shared helpers for every signed-in page (dashboard, till, products, settings).
   Reads the session saved at sign-in ("kaunta.session"), refreshes the token when it expires,
   and exposes window.KApp. Load order on a page: config.js, app.js, shell.js, then the page's own script. */
(function () {
  'use strict';
  var API = (window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api';
  var KEY = 'kaunta.session';
  var kes = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });
  var kes0 = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 });

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ } }
  var session = read();
  function toLogin() { location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'dashboard.html')); }
  if (!session || !session.access_token) { toLogin(); return; }

  function slug() { return session.tenant && session.tenant.slug; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function icon(name, cls) { var i = document.createElement('i'); i.className = 'ph ph-' + name + (cls ? ' ' + cls : ''); i.setAttribute('aria-hidden', 'true'); return i; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

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

  /* apiFull('GET', '/products?page=2') returns { data, meta }. Throws an Error with a message safe to show, plus .code and .status. */
  async function apiFull(method, path, body, headers) {
    var res;
    try { res = await send(method, path, body, headers); } catch (e) { throw new Error('We could not reach the server. Check your connection and try again.'); }
    if (res.status === 401) { if (await refresh()) res = await send(method, path, body, headers); }
    if (res.status === 401) { toLogin(); throw new Error(''); }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      var err = (j && j.error) || {};
      var msg = err.message || 'Something went wrong. Please try again.';
      /* 402 = the shop can look but not change (trial ended, plan expired). The server words the reason. */
      if ((res.status === 402 || err.code === 'subscription_inactive') && !err.message) msg = 'Your subscription is not active. Renew it to continue.';
      /* 403 account_suspended = locked by Kaunta: the only page that still works is Plan and billing. */
      if (err.code === 'account_suspended' && !/subscription\.html$/.test(location.pathname)) { location.replace('subscription.html?locked=1'); }
      var e = new Error(msg); e.status = res.status; e.code = err.code; e.details = err.details; throw e;
    }
    return j;
  }
  /* api('GET', '/products') returns data */
  async function api(method, path, body, headers) { return (await apiFull(method, path, body, headers)).data; }

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

  /* toast('Saved'), toast('Could not save', 'err') */
  var toasts = null;
  function toast(text, kind) {
    if (!toasts) { toasts = el('div', undefined, 'toasts'); toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite'); document.body.appendChild(toasts); }
    var t = el('div', undefined, 'toast' + (kind === 'err' ? ' err' : '')); t.appendChild(icon(kind === 'err' ? 'warning-circle' : 'check-circle')); t.appendChild(el('span', text));
    toasts.appendChild(t); setTimeout(function () { t.remove(); }, 2800);
  }

  /* countUp(node, 48920, fn) eases a number up once. fn formats each step. */
  function countUp(node, to, fmt) {
    to = Number(to) || 0; fmt = fmt || String;
    if (!to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 900;
    (function tick(now) {
      var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(to * e); if (p < 1) requestAnimationFrame(tick); else node.textContent = fmt(to);
    })(t0);
  }

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
  /* upload(dataUrl) returns the link to save (POST /media) */
  async function upload(dataUrl) { return (await api('POST', '/media', { data: dataUrl })).url; }

  /* identity() calls GET /auth/me once per page: { user, tenant, branches, features }, or null if it fails. */
  var idPromise = null;
  function identity() { if (!idPromise) idPromise = api('GET', '/auth/me').catch(function () { return null; }); return idPromise; }

  /* avatar(node, url, name): puts the picture in the round (or rounded) box, or the first letter when there is none. */
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
  async function logout() {
    try { await send('POST', '/auth/logout', { refresh_token: session.refresh_token }); } catch (e) { /* signing out anyway */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    location.replace('login.html');
  }

  /* Every <dialog> on a page closes on a backdrop click, and any [data-close] inside it closes it. */
  function wireDialogs() {
    document.querySelectorAll('dialog').forEach(function (d) {
      if (d.dataset.wired) return; d.dataset.wired = '1';
      d.addEventListener('click', function (e) { if (e.target === d && !d.hasAttribute('data-sticky')) d.close(); });
      d.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireDialogs); else wireDialogs();

  window.KApp = {
    api: api, apiFull: apiFull, branches: branches, el: el, icon: icon, esc: esc, notice: notice, busy: busy, num: num,
    toast: toast, countUp: countUp, wireDialogs: wireDialogs, logout: logout,
    photo: photo, upload: upload, identity: identity, avatar: avatar, patchSession: patchSession, can: can,
    money: function (n) { return kes.format(Number(n) || 0); },
    money0: function (n) { return kes0.format(Number(n) || 0); },
    uuid: function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
    session: session
  };
})();
