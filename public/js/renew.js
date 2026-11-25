/* Pay screen for a shop whose trial or plan has ended (renew.html).
 *
 * This is the ONLY page a locked shop can use; the server refuses everything else (402 subscription_expired).
 * It talks to the few endpoints that stay open while locked:
 *   GET  /auth/me                                   who is signed in and where the subscription stands
 *   GET  /tenant/plans                              the plans and prices
 *   GET  /tenant/subscription                       whether Paystack is switched on
 *   POST /tenant/subscription/paystack/initialize   { plan_id, cycle } -> { authorization_url }   (owner only)
 *   GET  /tenant/subscription/paystack/verify       ?reference=...                               (owner only)
 * The price is read by the server from its own plan table; nothing the browser sends can change what is charged.
 */
(function () {
  'use strict';
  var API = ((window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api').replace(/\/$/, '');
  var DASHBOARD = (window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.DASHBOARD) || 'dashboard.html';
  var KEY = 'kaunta.session';
  var $ = function (s) { return document.querySelector(s); };

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ } }
  var session = read();
  function toLogin() { location.replace('login.html'); }
  if (!session || !session.access_token) { toLogin(); return; }

  var slug = session.tenant && session.tenant.slug;
  var plans = [], cycle = 'monthly', chosen = null, isOwner = false, paystackOn = false, access = null;

  function show(id) { ['vLoading', 'vConfirm', 'vPay'].forEach(function (v) { $('#' + v).hidden = v !== id; }); }
  function say(kind, text) { var m = $('#msg'); m.className = 'msg' + (kind ? ' ' + kind : ''); m.textContent = text || ''; }

  /* ---------- API ---------- */
  async function refresh() {
    try {
      var r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': slug || '' }, body: JSON.stringify({ refresh_token: session.refresh_token, shop: slug }) });
      var j = await r.json(); var d = j && j.data; var s = d && (d.session || d);
      if (!r.ok || !s || !s.access_token) return false;
      session.access_token = s.access_token; if (s.refresh_token) session.refresh_token = s.refresh_token; save(); return true;
    } catch (e) { return false; }
  }
  function send(method, path, body) {
    var h = { Accept: 'application/json', Authorization: 'Bearer ' + session.access_token };
    if (slug) h['X-Tenant'] = slug;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function api(method, path, body) {
    var res;
    try { res = await send(method, path, body); } catch (e) { throw fail('We could not reach the server. Check your connection and try again.'); }
    if (res.status === 401 && (await refresh())) res = await send(method, path, body);
    if (res.status === 401) { toLogin(); throw fail(''); }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      var err = (j && j.error) || {};
      throw fail(res.status >= 500 && res.status !== 502 && res.status !== 503 ? 'Something went wrong on our side. Please try again in a moment.' : (err.message || 'Something went wrong. Please try again.'), err.code, res.status);
    }
    return j.data;
  }
  function fail(message, code, status) { var e = new Error(message); e.code = code; e.status = status; return e; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- helpers ---------- */
  function money(n, cur) {
    try { return new Intl.NumberFormat('en-KE', { style: 'currency', currency: cur || 'KES', maximumFractionDigits: 0 }).format(Number(n) || 0); }
    catch (e) { return (cur || 'KES') + ' ' + Math.round(Number(n) || 0); }
  }
  function day(iso) { var t = iso ? new Date(iso) : null; return t && !isNaN(t) ? t.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function priceOf(p) { return Number(cycle === 'yearly' ? p.price_yearly : p.price_monthly); }

  /* Sign-in response is saved at login; after paying, refresh what the pages remember and head to the dashboard. */
  function unlockAndGo(me) {
    if (me && me.tenant) { session.tenant = Object.assign({}, session.tenant || {}, me.tenant); save(); }
    location.replace(DASHBOARD);
  }

  /* ---------- wording by state ---------- */
  function words(a, endsAt) {
    var d = day(endsAt);
    switch (a && a.state) {
      case 'trial_expired': return { t: 'Your free trial has ended', l: 'Choose a plan to open your shop again. Your products, sales and customers are safe and will be waiting.' };
      case 'cancelled': return { t: 'Your subscription is cancelled', l: 'Choose a plan to start again. Your records are safe and will be waiting.' };
      case 'suspended': return { t: 'This account is suspended', l: 'Contact Kaunta support to have it reopened. Your records are safe.' };
      default: return { t: 'Your subscription has ended', l: (d ? 'Your plan ran out on ' + d + '. ' : '') + 'Pay to open your shop again. Your records are safe and will be waiting.' };
    }
  }

  /* ---------- plans ---------- */
  function renderPlans() {
    var box = $('#plans'); box.textContent = '';
    var ok = plans.filter(function (p) { return priceOf(p) > 0; });
    ok.forEach(function (p) {
      var lab = document.createElement('label'); lab.className = 'rn-plan';
      var inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'plan'; inp.value = p.id; inp.checked = chosen === p.id;
      inp.addEventListener('change', function () { chosen = p.id; $('#payBtn').disabled = false; });
      var dot = document.createElement('span'); dot.className = 'dot';
      var nm = document.createElement('span'); nm.className = 'nm';
      var b = document.createElement('b'); b.textContent = p.name;
      var sm = document.createElement('small');
      var bits = [];
      if (p.max_branches) bits.push(p.max_branches + (p.max_branches === 1 ? ' branch' : ' branches'));
      if (p.max_users) bits.push(p.max_users + ' staff');
      sm.textContent = bits.join(', ');
      nm.appendChild(b); if (bits.length) nm.appendChild(sm);
      var pr = document.createElement('span'); pr.className = 'pr';
      pr.appendChild(document.createTextNode(money(priceOf(p), p.currency)));
      var per = document.createElement('small'); per.textContent = cycle === 'yearly' ? 'a year' : 'a month'; pr.appendChild(per);
      lab.appendChild(inp); lab.appendChild(dot); lab.appendChild(nm); lab.appendChild(pr);
      box.appendChild(lab);
    });
    if (!ok.length) { say('err', 'No plans are available to pay for right now. Please contact Kaunta support.'); }
    if (chosen && !ok.some(function (p) { return p.id === chosen; })) chosen = null;
    $('#payBtn').disabled = !chosen || !paystackOn;
  }

  document.querySelectorAll('input[name=cycle]').forEach(function (r) {
    r.addEventListener('change', function () { cycle = r.value; say('', ''); renderPlans(); });
  });

  $('#payBtn').addEventListener('click', async function () {
    var btn = this; say('', '');
    if (!chosen) return say('err', 'Choose a plan first.');
    btn.disabled = true; btn.textContent = 'Opening Paystack...';
    try {
      var r = await api('POST', '/tenant/subscription/paystack/initialize', { plan_id: chosen, cycle: cycle });
      if (!r || !/^https:\/\/(checkout\.paystack\.com|[a-z0-9.-]*\.paystack\.(com|co))\//i.test(r.authorization_url || '')) throw fail('Paystack did not return a payment page. Please try again.');
      location.href = r.authorization_url;
    } catch (e) {
      say('err', e.message); btn.disabled = false; btn.textContent = 'Pay with Paystack';
    }
  });

  $('#outBtn').addEventListener('click', async function () {
    try { await send('POST', '/auth/logout', { refresh_token: session.refresh_token }); } catch (e) { /* signing out anyway */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    location.replace('login.html');
  });

  /* ---------- coming back from Paystack ---------- */
  async function confirm(reference) {
    show('vConfirm');
    for (var i = 0; i < 12; i++) {
      var status = 'pending';
      try { status = (await api('GET', '/tenant/subscription/paystack/verify?reference=' + encodeURIComponent(reference))).status; }
      catch (e) { if (e.status === 404 || e.status === 400 || e.status === 403) status = 'unknown'; }
      if (status === 'confirmed') {
        var me = null; try { me = await api('GET', '/auth/me'); } catch (e) { /* the dashboard will sort it out */ }
        return unlockAndGo(me);
      }
      if (status === 'failed') return back('The payment did not go through, and you have not been charged. You can try again.', 'err');
      if (status === 'review') return back('We received your payment but the amount did not match the plan. Please contact Kaunta support with this reference: ' + reference, 'err');
      if (status === 'unknown') return back('We could not find that payment. If money left your account, contact Kaunta support with this reference: ' + reference, 'err');
      await wait(3000);
    }
    back('We have not heard back from Paystack yet. If you paid, your shop will open by itself within a few minutes. Reload this page to check.', 'ok');
  }
  function back(text, kind) { history.replaceState(null, '', 'renew.html'); show('vPay'); say(kind, text); }

  /* ---------- start ---------- */
  (async function start() {
    try {
      var me = await api('GET', '/auth/me');
      access = me.tenant && me.tenant.access;
      isOwner = !!(me.user && me.user.is_owner);
      if (me.tenant) { session.tenant = Object.assign({}, session.tenant || {}, me.tenant); save(); }

      var ref = new URLSearchParams(location.search); ref = ref.get('reference') || ref.get('trxref');
      if (access && access.can_operate && !ref) return location.replace(DASHBOARD); // nothing to pay: not locked
      if (ref && isOwner) return confirm(ref);

      var w = words(access, access && access.ends_at);
      $('#payTitle').textContent = w.t; $('#payLead').textContent = w.l;
      show('vPay');

      if (!isOwner) { $('#ownerPane').hidden = true; $('#staffPane').hidden = false; return; }

      var got = await Promise.all([api('GET', '/tenant/plans'), api('GET', '/tenant/subscription')]);
      plans = Array.isArray(got[0]) ? got[0] : [];
      paystackOn = !!(got[1] && got[1].paystack_enabled);
      chosen = (got[1] && got[1].plan && got[1].plan.id) || null;
      if (chosen && !plans.some(function (p) { return p.id === chosen; })) chosen = null;
      if (!paystackOn) say('err', 'Online payment is not switched on yet. Please contact Kaunta support to renew.');
      renderPlans();
    } catch (e) {
      show('vPay'); $('#ownerPane').hidden = true;
      $('#payTitle').textContent = 'We could not load this page';
      $('#payLead').textContent = '';
      say('err', e.message || 'Something went wrong. Please reload.');
    }
  })();
})();
