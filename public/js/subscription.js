/* Plan and billing: where the subscription stands, what is used, which modules the plan includes,
   the plans on offer, and paying by M-Pesa. Data comes from GET /tenant/subscription, /tenant/plans
   and /tenant/subscription/payments. All text from the server is set with textContent. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var el = K.el;
  function $(s) { return document.querySelector(s); }

  var STATE = {
    trial: { label: 'Free trial', tone: 'info' },
    active: { label: 'Active', tone: 'ok' },
    grace: { label: 'Payment due', tone: 'warn' },
    trial_expired: { label: 'Trial ended', tone: 'bad' },
    expired: { label: 'Expired', tone: 'bad' },
    cancelled: { label: 'Cancelled', tone: 'bad' },
    suspended: { label: 'Suspended', tone: 'bad' },
    inactive: { label: 'Not active', tone: 'bad' }
  };
  var MODULES = [
    ['storefront', 'Online store'], ['multi_branch', 'Several branches'], ['credit_sales', 'Credit sales'],
    ['variants', 'Product variants'], ['batch_expiry', 'Batches and expiry'], ['prescriptions', 'Prescriptions'],
    ['restaurant', 'Restaurant tables'], ['modifiers', 'Modifiers'], ['recipes', 'Recipes']
  ];
  var USES = [['branches', 'Branches'], ['users', 'Team members'], ['products', 'Products']];

  var sub = null, plans = [], owner = false;

  /* ---------- small helpers ---------- */
  function fmtDate(v, lastDay) {
    var t = v ? new Date(v).getTime() : NaN;
    if (isNaN(t)) return '-';
    /* a period "ends" at the start of the next day, so show the day before as the last day */
    return new Date(lastDay ? t - 1 : t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function daysText(n) { return n + (n === 1 ? ' day' : ' days'); }
  function count(n) { return Number(n).toLocaleString('en-KE'); }
  function price(p, v) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '-';
    var cur = p && p.currency;
    return !cur || cur === 'KES' ? K.money0(n) : cur + ' ' + count(n);
  }
  function limitText(v) { return v === null || v === undefined ? 'No limit' : count(v); }
  function planById(id) { for (var i = 0; i < plans.length; i++) if (plans[i].id === id) return plans[i]; return null; }

  function setRows(ul, rows) {
    ul.textContent = '';
    rows.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('span', r[0], 'muted'));
      li.appendChild(r[1] instanceof Node ? r[1] : el('b', r[1], 'num'));
      ul.appendChild(li);
    });
    ul.removeAttribute('aria-busy');
  }
  function skeleton(ul, n) {
    ul.textContent = '';
    for (var i = 0; i < n; i++) { var li = el('li', null, 'bl-sk-row'); li.setAttribute('aria-hidden', 'true'); ul.appendChild(li); }
  }
  function showError(box, text, retry) {
    box.textContent = ''; box.hidden = false;
    box.appendChild(K.icon('warning-circle'));
    box.appendChild(el('span', text));
    var b = el('button', 'Try again', 'link'); b.type = 'button';
    b.addEventListener('click', function () { box.hidden = true; retry(); });
    box.appendChild(b);
  }
  function tag(text, tone) { return el('span', text, 'tag' + (tone ? ' ' + tone : '')); }

  /* ---------- plan, usage, modules ---------- */
  var OFF = 'You can still look at and export your records. Selling and editing are off until your payment is confirmed.';
  function statusNote(a, s) {
    var left = a.days_left;
    switch (a.state) {
      case 'trial': return left !== null && left <= 7 ? { text: 'Your free trial ends soon. Pay below to keep selling.' } : null;
      case 'active': return left !== null && left <= 5 ? { text: 'Your plan ends soon. Pay below to carry on without a break.' } : null;
      case 'grace': return { text: 'Your payment is due. Everything works until ' + fmtDate(a.grace_ends_at, true) + ', then you can only look at your records.' };
      case 'suspended': return { text: 'This account is suspended. If you have already paid, Kaunta will confirm it shortly. Otherwise contact Kaunta support.', kind: 'err' };
      default: return { text: OFF };
    }
  }
  function renderStatus(s) {
    var a = s.access || {}, st = STATE[a.state] || STATE.inactive;
    var t = $('#stTag'); t.hidden = false; t.className = 'tag dot ' + st.tone; t.textContent = st.label;

    var rows = [['Plan', s.plan ? s.plan.name : 'None yet']];
    if (s.status === 'trial') rows.push([a.state === 'trial' ? 'Trial ends' : 'Trial ended', fmtDate(s.trial_ends_at, true)]);
    else if (s.current_period_end) rows.push([a.days_left > 0 ? 'Paid until' : 'Ended on', fmtDate(s.current_period_end, true)]);
    if (a.days_left > 0) rows.push(['Time left', daysText(a.days_left)]);
    if (a.state === 'grace' && a.grace_ends_at) rows.push(['Full access until', fmtDate(a.grace_ends_at, true)]);
    setRows($('#stFacts'), rows);

    var n = statusNote(a, s), box = $('#stNote');
    K.notice(box, n ? n.text : '', n && n.kind === 'err' ? 'err' : 'warn');
    $('#lockedNote').hidden = !(a.state === 'suspended' && new URLSearchParams(location.search).get('locked'));
  }

  function renderUsage(u) {
    var ul = $('#usList'); ul.textContent = '';
    USES.forEach(function (p) {
      var r = (u && u[p[0]]) || { used: 0, limit: null };
      var li = el('li', null, 'bl-use'), h = el('div', null, 'bl-use-h');
      h.appendChild(el('span', p[1]));
      h.appendChild(el('span', r.limit === null ? count(r.used) + ' used, no limit' : count(r.used) + ' of ' + count(r.limit), 'num'));
      li.appendChild(h);
      if (r.limit !== null) {
        var pct = r.limit > 0 ? Math.min(100, Math.round(r.used / r.limit * 100)) : 100;
        var bar = el('div', null, 'bar' + (pct >= 100 ? ' bad' : pct >= 80 ? ' warn' : ''));
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', p[1]);
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(r.limit)); bar.setAttribute('aria-valuenow', String(r.used));
        var fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill);
        li.appendChild(bar);
        if (pct >= 100) li.appendChild(el('small', 'Limit reached. Choose a bigger plan to add more.', 'muted'));
      }
      ul.appendChild(li);
    });
    ul.removeAttribute('aria-busy');
  }

  function renderModules(s) {
    var rows = [], blocked = false;
    MODULES.forEach(function (m) {
      var x = (s.modules && s.modules[m[0]]) || { enabled: false, allowed: true };
      if (!x.allowed) blocked = true;
      rows.push([m[1], x.allowed ? tag(x.enabled ? 'On' : 'Off', x.enabled ? 'ok' : '') : tag('Not in your plan', 'warn')]);
    });
    rows.push(['Custom domain', s.custom_domain ? tag('Included', 'ok') : tag('Not in your plan', 'warn')]);
    if (!s.custom_domain) blocked = true;
    setRows($('#mdList'), rows);
    $('#mdHint').hidden = !blocked;
  }

  async function loadSub() {
    var err = $('#stErr'); err.hidden = true;
    try {
      sub = await K.api('GET', '/tenant/subscription');
    } catch (ex) {
      $('#stFacts').textContent = ''; $('#usList').textContent = ''; $('#mdList').textContent = '';
      showError(err, 'Could not load your plan. ' + (ex.message || ''), loadSub);
      return false;
    }
    renderStatus(sub); renderUsage(sub.usage); renderModules(sub);
    if (owner) { renderSteps(); renderPending(); renderResult(); }
    return true;
  }

  /* ---------- plans ---------- */
  function renderPlans() {
    var body = $('#plBody'); body.textContent = '';
    var cur = sub && sub.plan && sub.plan.id;
    plans.forEach(function (p) {
      var tr = el('tr'), name = el('td'), isCur = p.id === cur;
      name.appendChild(el('b', p.name));
      if (isCur) name.appendChild(tag('Current', 'ok'));
      tr.appendChild(name);
      tr.appendChild(el('td', price(p, p.price_monthly), 'r'));
      tr.appendChild(el('td', price(p, p.price_yearly), 'r'));
      tr.appendChild(el('td', limitText(p.max_branches), 'r'));
      tr.appendChild(el('td', limitText(p.max_users), 'r'));
      tr.appendChild(el('td', limitText(p.max_products), 'r'));
      var act = el('td', null, 'r');
      if (owner && !isCur) {
        var b = el('button', 'Pay for this plan', 'btn sm'); b.type = 'button';
        b.addEventListener('click', function () { choosePlan(p.id); });
        act.appendChild(b);
      }
      tr.appendChild(act);
      body.appendChild(tr);
    });
  }
  async function loadPlans() {
    var err = $('#plErr'); err.hidden = true;
    $('#plBody').textContent = '';
    try { plans = await K.api('GET', '/tenant/plans'); if (!Array.isArray(plans)) plans = []; }
    catch (ex) { plans = []; showError(err, 'Could not load the plans. ' + (ex.message || ''), function () { loadPlans().then(afterPlans); }); return false; }
    renderPlans();
    return true;
  }
  function afterPlans() { if (owner) fillPay(); }

  /* ---------- paying ---------- */
  function choosePlan(id) {
    $('#pyPlan').value = id; syncAmount(); renderResult();
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#payCard').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    $('#pyCode').focus({ preventScroll: true });
  }
  function syncAmount() {
    var p = planById($('#pyPlan').value);
    if (p && Number(p.price_monthly) > 0) $('#pyAmount').value = Number(p.price_monthly);
    $('#pyHint').textContent = p ? 'Monthly price: ' + price(p, p.price_monthly) : '';
  }
  function fillPay() {
    var sel = $('#pyPlan'); sel.textContent = '';
    if (!plans.length) { var o = el('option', 'Current plan'); o.value = ''; sel.appendChild(o); }
    plans.forEach(function (p) { var o = el('option', p.name + ' - ' + price(p, p.price_monthly) + ' a month'); o.value = p.id; sel.appendChild(o); });
    var cur = sub && sub.plan && sub.plan.id;
    if (cur && planById(cur)) sel.value = cur;
    syncAmount(); renderSteps(); renderPending(); renderResult();
  }
  function renderSteps() {
    var ol = $('#pySteps'); ol.textContent = '';
    var pi = sub && sub.payment_instructions, lines = [];
    if (pi && pi.paybill) lines.push('Open M-Pesa, choose Lipa na M-Pesa, then Paybill. Business number ' + pi.paybill + ', account number ' + pi.account + '.');
    if (pi && pi.till) lines.push('Open M-Pesa, choose Lipa na M-Pesa, then Buy Goods and Services. Till number ' + pi.till + '.');
    if (!lines.length) lines.push('Ask Kaunta support for the M-Pesa number to pay.');
    lines.push('Enter the amount for your plan and pay.');
    lines.push('Type the code from the confirmation SMS in the box below.');
    lines.forEach(function (t) { ol.appendChild(el('li', t)); });
    var extra = $('#pyExtra'); extra.textContent = (pi && pi.note) || ''; extra.hidden = !(pi && pi.note);
  }
  function renderPending() {
    var n = sub ? sub.pending_payments : 0;
    K.notice($('#pyPending'), n > 0 ? (n === 1 ? '1 payment is' : n + ' payments are') + ' waiting for Kaunta to confirm. Your plan updates as soon as it is confirmed.' : '', 'warn');
  }
  /* what a confirmed payment produces: the same arithmetic as the staff panel (extends from the current end) */
  function renderResult() {
    var box = $('#pyResult');
    if (!sub) { box.hidden = true; return; }
    var today = new Date().toISOString().slice(0, 10);
    var cpe = sub.current_period_end ? new Date(sub.current_period_end).toISOString().slice(0, 10) : null;
    var d = new Date((cpe && cpe > today ? cpe : today) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (sub.period_days || 30));
    box.textContent = 'A confirmed payment normally adds ' + daysText(sub.period_days || 30) + ', so your plan would run until ' +
      d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) + '.';
    box.hidden = false;
  }

  var PAY = { pending: ['Waiting for Kaunta', 'warn'], confirmed: ['Confirmed', 'ok'], failed: ['Not accepted', 'bad'] };
  async function loadHistory() {
    var err = $('#hiErr'); err.hidden = true;
    var rows;
    try { rows = await K.api('GET', '/tenant/subscription/payments?limit=10'); }
    catch (ex) { showError(err, 'Could not load your payments. ' + (ex.message || ''), loadHistory); return; }
    if (!Array.isArray(rows)) rows = [];
    var body = $('#hiBody'); body.textContent = '';
    $('#hiEmpty').hidden = rows.length > 0;
    rows.forEach(function (r) {
      var tr = el('tr'), p = planById(r.plan_id), st = PAY[r.status] || [r.status || '-', ''];
      tr.appendChild(el('td', fmtDate(r.created_at)));
      tr.appendChild(el('td', p ? p.name : '-'));
      tr.appendChild(el('td', r.mpesa_receipt || '-', 'mono'));
      tr.appendChild(el('td', K.money0(r.amount), 'r'));
      var s = el('td'); s.appendChild(tag(st[0], st[1])); tr.appendChild(s);
      body.appendChild(tr);
    });
  }

  function wireForm() {
    $('#pyPlan').addEventListener('change', function () { syncAmount(); });
    $('#pyCode').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
    $('#mdJump').addEventListener('click', function () { $('#plCard').scrollIntoView({ block: 'start' }); });
    $('#pyForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('#pyErr'), ok = $('#pyOk'), btn = $('#pySend');
      K.notice(err, ''); K.notice(ok, '');
      var code = $('#pyCode').value.trim(), amount = Number($('#pyAmount').value);
      if (!(amount > 0)) { K.notice(err, 'Enter the amount you paid.', 'err'); return; }
      if (!/^[A-Z0-9]{10}$/.test(code)) { K.notice(err, 'The M-Pesa code has 10 letters and numbers, for example SJK1A2B3C4.', 'err'); return; }
      K.busy(btn, true, 'Sending...');
      try {
        await K.api('POST', '/tenant/subscription/payments', {
          plan_id: $('#pyPlan').value || undefined, amount: amount, mpesa_receipt: code, notes: $('#pyNote').value.trim() || undefined
        });
        $('#pyCode').value = ''; $('#pyNote').value = '';
        K.notice(ok, 'Sent. Kaunta will confirm your payment shortly, and your plan updates as soon as it is confirmed.', 'ok');
        loadSub(); loadHistory();
      } catch (ex) { K.notice(err, ex.message, 'err'); }
      K.busy(btn, false);
    });
  }

  async function init() {
    skeleton($('#stFacts'), 3); skeleton($('#usList'), 3); skeleton($('#mdList'), 4);
    var id = await K.identity();
    owner = Boolean(id && id.user && id.user.is_owner);
    if (owner) { $('#payCard').hidden = false; $('#hiCard').hidden = false; wireForm(); } else { $('#ownerOnly').hidden = false; }
    await Promise.all([loadSub(), loadPlans()]);
    renderPlans(); /* again: "Current" needs the plan from loadSub */
    afterPlans();
    if (owner) loadHistory();
  }
  init();
})();
