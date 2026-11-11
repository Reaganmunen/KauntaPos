/* Kaunta sign in and sign up. Plain JS. Settings come from js/config.js.
 *
 * API used (all return { success, data } or { success:false, error:{ message, code } }):
 *   POST /auth/login             { shop, identifier, password }
 *   POST /auth/register          { slug, name, business_type, owner_name, owner_email|owner_phone, password }
 *   POST /auth/forgot-password   { shop, identifier }
 *   POST /auth/google/login      { shop, access_token }                                (needs adding to the backend)
 *   POST /auth/google/register   { slug, name, business_type, access_token }           (needs adding to the backend)
 * A successful login or register returns { access_token, refresh_token, user, tenant }.
 */
(function () {
  'use strict';

  var CFG = window.KAUNTA_CONFIG || {};
  var API = (CFG.API || '/api').replace(/\/$/, '');
  var DASHBOARD = CFG.DASHBOARD || 'dashboard.html';
  var KEY_SESSION = 'kaunta.session';
  var KEY_LAST = 'kaunta.lastAuth';   // { method: 'google' | 'password', shop, identifier }

  var $ = function (s) { return document.querySelector(s); };
  var page = document.body.getAttribute('data-page');

  /* ---------- small helpers ---------- */
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: skip */ } }

  async function post(path, body) {
    var res;
    try {
      res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw fail('We could not reach the server. Check your connection and try again.', 'network');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || (data && data.success === false)) {
      var err = data && data.error;
      /* Server-side faults (status 500 and up) never show technical wording to the person; the server logs the real cause. */
      var friendly = res.status >= 500 ? 'We could not complete that right now. Please try again in a few minutes.' : (err && err.message);
      throw fail(friendly || 'Something went wrong. Please try again.', err && err.code, res.status);
    }
    return data && data.data;
  }
  function fail(message, code, status) { var e = new Error(message); e.code = code; e.status = status; return e; }

  function say(el, kind, text) { el.className = 'msg ' + kind; el.textContent = text; }
  function clear(el) { el.className = 'msg'; el.textContent = ''; }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; if (label) btn.textContent = label; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  // accept "mama-njeri" or "mama-njeri.kaunta.co.ke"
  function cleanShop(s) { return String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }

  function nextUrl() {
    var n = new URLSearchParams(location.search).get('next');
    return n && /^[a-z0-9_\-\/]+\.html?$/i.test(n) && n.indexOf('//') < 0 ? n : DASHBOARD;
  }
  function finish(session, method, identifier) {
    lsSet(KEY_SESSION, session);
    lsSet(KEY_LAST, { method: method, shop: session && session.tenant && session.tenant.slug, identifier: method === 'password' ? identifier : undefined });
    location.href = nextUrl();
  }

  /* ---------- show/hide password ---------- */
  var pwToggle = $('#pwToggle');
  if (pwToggle) pwToggle.addEventListener('click', function () {
    var f = $('#password'), show = f.type === 'password';
    f.type = show ? 'text' : 'password'; pwToggle.textContent = show ? 'Hide' : 'Show';
    pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  /* ---------- "Last used" tag ---------- */
  var last = lsGet(KEY_LAST);
  function tag(el) {
    if (!el || el.querySelector('.last-badge')) return;
    var b = document.createElement('span'); b.className = 'last-badge'; b.textContent = 'Last used'; el.appendChild(b);
  }
  if (last && last.method) tag(last.method === 'google' ? $('#googleBtn') : $('#submitBtn'));

  /* ---------- Google (popup, no redirect) ----------
     Returns a Google access token. The backend checks it with Google and finds or creates the user. */
  function googleToken() {
    return new Promise(function (resolve, reject) {
      if (!CFG.GOOGLE_CLIENT_ID) return reject(fail('Google sign-in is not switched on yet. Use your phone or email for now.', 'not_configured'));
      if (!(window.google && google.accounts && google.accounts.oauth2)) return reject(fail('Google did not load. Check your connection and try again.', 'not_loaded'));
      var client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID,
        scope: 'openid email profile',
        callback: function (r) { r && r.access_token ? resolve(r.access_token) : reject(fail('Google did not sign you in. Try again.', 'google_error')); },
        error_callback: function (e) { reject(fail(e && e.type === 'popup_closed' ? '' : 'Google sign-in was blocked. Allow pop-ups for this site and try again.', 'popup')); }
      });
      client.requestAccessToken();
    });
  }

  /* =====================================================================
     SIGN IN
  ===================================================================== */
  if (page === 'login') {
    var shopIn = $('#shop'), idIn = $('#identifier'), pwIn = $('#password');
    var msg = $('#msg'), submit = $('#submitBtn'), gBtn = $('#googleBtn');

    var qs = new URLSearchParams(location.search).get('shop');
    if (qs) shopIn.value = cleanShop(qs);
    else if (last && last.shop) shopIn.value = last.shop;
    if (last && last.method === 'password' && last.identifier) { idIn.value = last.identifier; }
    (shopIn.value ? (idIn.value ? pwIn : idIn) : shopIn).focus();

    function needShop() {
      var s = cleanShop(shopIn.value);
      if (!s) { say(msg, 'err', 'Enter your shop address first. It is the one you chose when you signed up.'); shopIn.focus(); }
      return s;
    }

    $('#loginForm').addEventListener('submit', async function (e) {
      e.preventDefault(); clear(msg);
      var shop = needShop(); if (!shop) return;
      var id = idIn.value.trim(), pw = pwIn.value;
      if (!id || !pw) return say(msg, 'err', 'Enter your phone or email and your password.');
      busy(submit, true, 'Signing in...');
      try {
        var session = await post('/auth/login', { shop: shop, identifier: id, password: pw });
        finish(session, 'password', id);
      } catch (err) { say(msg, 'err', err.message); busy(submit, false); }
    });

    gBtn.addEventListener('click', async function () {
      clear(msg);
      var shop = needShop(); if (!shop) return;
      busy(gBtn, true);
      try {
        var token = await googleToken();
        var session = await post('/auth/google/login', { shop: shop, access_token: token });
        finish(session, 'google');
      } catch (err) { if (err.message) say(msg, 'err', err.message); busy(gBtn, false); }
    });

    // forgot password
    var loginView = $('#loginView'), forgotView = $('#forgotView'), fMsg = $('#fMsg');
    $('#forgotLink').addEventListener('click', function () {
      $('#fShop').value = shopIn.value; $('#fId').value = idIn.value;
      loginView.hidden = true; forgotView.hidden = false; ($('#fShop').value ? $('#fId') : $('#fShop')).focus();
    });
    $('#backToLogin').addEventListener('click', function () { forgotView.hidden = true; loginView.hidden = false; clear(fMsg); });
    $('#forgotForm').addEventListener('submit', async function (e) {
      e.preventDefault(); clear(fMsg);
      var shop = cleanShop($('#fShop').value), id = $('#fId').value.trim();
      if (!shop || !id) return say(fMsg, 'err', 'Enter your shop address and your phone or email.');
      var btn = $('#forgotBtn'); busy(btn, true, 'Sending...');
      try {
        var d = await post('/auth/forgot-password', { shop: shop, identifier: id });
        say(fMsg, 'ok', (d && d.message) || 'If that account exists, a reset link has been sent.');
      } catch (err) { say(fMsg, 'err', err.message); }
      busy(btn, false);
    });
  }

  /* =====================================================================
     SIGN UP  (step 1: the shop, step 2: the owner)
  ===================================================================== */
  if (page === 'signup') {
    var nameIn = $('#shopName'), slugIn = $('#slug'), typeIn = $('#bizType');
    var msg1 = $('#msg1'), msg2 = $('#msg'), sub = $('#submitBtn'), gb = $('#googleBtn');
    var touched = false, shop = null;

    nameIn.addEventListener('input', function () { if (!touched) slugIn.value = slugify(nameIn.value); });
    slugIn.addEventListener('input', function () { touched = true; slugIn.value = slugify(slugIn.value); });

    function goStep(n) {
      $('#pane1').classList.toggle('on', n === 1); $('#pane2').classList.toggle('on', n === 2);
      $('#bar2').classList.toggle('on', n === 2);
      window.scrollTo({ top: 0 });
      (n === 1 ? nameIn : $('#ownerName')).focus();
    }

    $('#shopForm').addEventListener('submit', function (e) {
      e.preventDefault(); clear(msg1);
      var n = nameIn.value.trim(), s = slugify(slugIn.value);
      if (!n) return say(msg1, 'err', 'Enter your shop name.');
      if (s.length < 3) return say(msg1, 'err', 'The shop address needs at least 3 letters or numbers.');
      shop = { name: n, slug: s, business_type: typeIn.value };
      $('#shopLabel').textContent = n;
      goStep(2);
    });
    $('#backBtn').addEventListener('click', function () { clear(msg2); goStep(1); });

    $('#ownerForm').addEventListener('submit', async function (e) {
      e.preventDefault(); clear(msg2);
      var d = { owner_name: $('#ownerName').value.trim(), owner_email: $('#ownerEmail').value.trim(), owner_phone: $('#ownerPhone').value.trim(), password: $('#password').value };
      if (!d.owner_name) return say(msg2, 'err', 'Enter your name.');
      if (!d.owner_email && !d.owner_phone) return say(msg2, 'err', 'Add a phone number or an email so you can sign in later.');
      if (d.password.length < 8) return say(msg2, 'err', 'Use a password of at least 8 characters.');
      if (!d.owner_email) delete d.owner_email;
      if (!d.owner_phone) delete d.owner_phone;
      busy(sub, true, 'Creating your shop...');
      try {
        var session = await post('/auth/register', Object.assign({}, shop, d));
        finish(session, 'password', d.owner_email || d.owner_phone);
      } catch (err) {
        say(msg2, 'err', err.code === 'already_exists' ? 'That shop address or login is already taken. Go back and pick another address, or sign in.' : err.message);
        busy(sub, false);
      }
    });

    gb.addEventListener('click', async function () {
      clear(msg2); busy(gb, true);
      try {
        var token = await googleToken();
        var session = await post('/auth/google/register', Object.assign({}, shop, { access_token: token }));
        finish(session, 'google');
      } catch (err) { if (err.message) say(msg2, 'err', err.message); busy(gb, false); }
    });
  }
})();