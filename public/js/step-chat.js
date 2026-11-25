/* Customer chats inbox:
     GET  /chat/threads?status=&q=&page=      list (unread first)
     GET  /chat/threads/:id?after=<seq>       open one (marks it read) / fetch only what is new
     POST /chat/threads/:id/messages { body } reply
     PUT  /chat/threads/:id/status { status } close or reopen */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var LIST_MS = 15000, OPEN_MS = 4000;
  var TABS = [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];
  var S = { status: 'open', q: '', cur: null, last: 0, sending: false, timer: 0, listTimer: 0 };

  function when(d) {
    if (!d) return '';
    var t = new Date(d), now = new Date();
    return t.toDateString() === now.toDateString()
      ? t.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })
      : t.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }
  function hhmm(d) { return new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); }

  /* ---------- tabs ---------- */
  function renderTabs() {
    var box = $('#tabs'); box.textContent = '';
    TABS.forEach(function (t) {
      var b = K.el('button', t[1], 'btn sm'); b.type = 'button'; b.setAttribute('aria-pressed', String(S.status === t[0]));
      b.addEventListener('click', function () { S.status = t[0]; renderTabs(); loadList(); });
      box.appendChild(b);
    });
  }

  /* ---------- list ---------- */
  function renderList(rows) {
    var box = $('#threads'); box.textContent = '';
    if (!rows.length) {
      var e = K.el('div', undefined, 'empty'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('chats-circle')); e.appendChild(ic);
      e.appendChild(K.el('b', S.q || S.status !== 'open' ? 'No chats here' : 'No chats yet'));
      e.appendChild(K.el('p', S.q || S.status !== 'open' ? 'Try another word or tab.' : 'When a shopper asks a question on your store, it shows up here.'));
      e.style.padding = '30px 20px'; e.style.textAlign = 'center'; box.appendChild(e); return;
    }
    rows.forEach(function (t) {
      var b = K.el('button', undefined, 'th' + (t.unread ? ' unread' : '')); b.type = 'button';
      b.setAttribute('aria-current', String(Boolean(S.cur && S.cur.id === t.id)));
      b.appendChild(K.el('span', (t.customer_name || '?').trim().charAt(0).toUpperCase(), 'av'));
      var tx = K.el('span', undefined, 'tx'), top = K.el('b');
      top.appendChild(K.el('span', t.customer_name)); top.appendChild(K.el('time', when(t.last_message_at)));
      tx.appendChild(top);
      tx.appendChild(K.el('small', (t.last_sender === 'staff' ? 'You: ' : '') + (t.last_message_preview || '')));
      b.appendChild(tx);
      if (t.unread) b.appendChild(K.el('span', t.unread > 9 ? '9+' : String(t.unread), 'dot'));
      b.addEventListener('click', function () { openThread(t.id); });
      box.appendChild(b);
    });
  }
  async function loadList() {
    try {
      var qs = '?status=' + S.status + (S.q ? '&q=' + encodeURIComponent(S.q) : '');
      var rows = await K.api('GET', '/chat/threads' + qs);
      K.notice($('#listErr'), ''); renderList(rows || []);
    } catch (e) {
      if (e.code === 'feature_disabled') K.notice($('#listErr'), 'The online store is not switched on for your shop, so there are no chats.', 'err');
      else K.notice($('#listErr'), e.message, 'err');
    }
  }

  /* ---------- one conversation ---------- */
  function paintHead(t) {
    var h = $('#convHead'); h.textContent = '';
    var back = K.el('button', undefined, 'btn sm back-btn'); back.type = 'button'; back.appendChild(K.icon('arrow-left')); back.appendChild(document.createTextNode('Chats'));
    back.addEventListener('click', function () { $('#inbox').classList.remove('open-conv'); S.cur = null; stop(); loadList(); });
    var who = K.el('div', undefined, 'who'); who.appendChild(K.el('b', t.customer_name));
    who.appendChild(K.el('small', [t.customer_phone ? '+' + t.customer_phone : '', t.customer_email || ''].filter(Boolean).join(' · ') || 'No contact details'));
    var acts = K.el('div', undefined, 'acts');
    if (t.customer_phone) {
      var call = K.el('a', 'Call', 'btn sm'); call.href = 'tel:+' + t.customer_phone; acts.appendChild(call);
      var wa = K.el('a', 'WhatsApp', 'btn sm'); wa.href = 'https://wa.me/' + t.customer_phone; wa.target = '_blank'; wa.rel = 'noopener'; acts.appendChild(wa);
    }
    var st = K.el('button', t.status === 'open' ? 'Close chat' : 'Reopen', 'btn sm'); st.type = 'button';
    st.addEventListener('click', async function () {
      st.disabled = true;
      try { var u = await K.api('PUT', '/chat/threads/' + t.id + '/status', { status: t.status === 'open' ? 'closed' : 'open' }); S.cur = u; paintHead(u); loadList(); }
      catch (e) { K.toast(e.message, 'err'); st.disabled = false; }
    });
    acts.appendChild(st);
    h.appendChild(back); h.appendChild(who); h.appendChild(acts);
  }

  function addMessages(messages) {
    var b = $('#convBody'); if (!b || !messages) return;
    var stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80 || !S.last;
    messages.forEach(function (m) {
      if (m.seq <= S.last) return;
      S.last = m.seq;
      var mine = m.sender === 'staff';
      if (m.product_name) b.appendChild(K.el('span', 'About: ' + m.product_name, 'bub-ref' + (mine ? ' staff' : '')));
      var d = K.el('div', m.body, 'bub ' + (mine ? 'staff' : 'cust'));
      d.appendChild(K.el('small', (mine && m.staff_name ? m.staff_name + ' · ' : '') + hhmm(m.created_at)));
      b.appendChild(d);
    });
    if (stick) b.scrollTop = b.scrollHeight;
  }

  function buildConv() {
    var c = $('#conv'); c.textContent = '';
    var head = K.el('div', undefined, 'conv-h'); head.id = 'convHead';
    var body = K.el('div', undefined, 'conv-b'); body.id = 'convBody';
    var form = K.el('form', undefined, 'reply'); form.noValidate = true;
    var ta = K.el('textarea'); ta.rows = 1; ta.maxLength = 1000; ta.placeholder = 'Write a reply'; ta.setAttribute('aria-label', 'Reply');
    var send = K.el('button', undefined, 'btn primary'); send.type = 'submit'; send.appendChild(K.icon('paper-plane-right')); send.appendChild(document.createTextNode('Send'));
    var err = K.el('p', '', 'note err'); err.hidden = true;
    form.appendChild(ta); form.appendChild(send);
    c.appendChild(head); c.appendChild(body); c.appendChild(err); c.appendChild(form);
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); var text = ta.value.trim(); if (!text || S.sending || !S.cur) return;
      S.sending = true; send.disabled = true; err.hidden = true;
      try {
        var m = await K.api('POST', '/chat/threads/' + S.cur.id + '/messages', { body: text });
        ta.value = ''; ta.style.height = 'auto'; addMessages([m]); loadList();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      S.sending = false; send.disabled = false; ta.focus();
    });
    return ta;
  }

  function stop() { clearInterval(S.timer); S.timer = 0; }

  async function openThread(id) {
    stop();
    try {
      var d = await K.api('GET', '/chat/threads/' + id + '?after=0');
      S.cur = d.thread; S.last = 0;
      var ta = buildConv(); paintHead(d.thread); addMessages(d.messages);
      $('#inbox').classList.add('open-conv');
      loadList(); if (window.matchMedia('(min-width: 861px)').matches) ta.focus();
      S.timer = setInterval(pollOpen, OPEN_MS);
    } catch (e) { K.notice($('#listErr'), e.message, 'err'); }
  }
  async function pollOpen() {
    if (!S.cur || document.hidden) return;
    try {
      var d = await K.api('GET', '/chat/threads/' + S.cur.id + '?after=' + S.last);
      if (d.messages && d.messages.length) { addMessages(d.messages); loadList(); }
      if (d.thread.status !== S.cur.status) { S.cur = d.thread; paintHead(d.thread); }
    } catch (e) { /* keep trying */ }
  }

  /* ---------- alerts when Kaunta is closed (Web Push) ----------
     GET  /chat/push/key?endpoint=   -> { enabled, public_key, subscribed }     enabled is false until VAPID keys are set on the server
     POST /chat/push/subscribe   { subscription }      POST /chat/push/unsubscribe { endpoint }                         */
  var P = { reg: null, sub: null, key: '', busy: false };
  var canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var onIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function keyBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4), raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function paintPush() {
    var btn = $('#pushBtn'), label = btn.querySelector('span'), note = $('#pushNote');
    var on = Boolean(P.sub) && Notification.permission === 'granted';
    label.textContent = on ? 'Alerts on' : 'Turn on alerts';
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'You get a notification on this device when a customer writes. Tap to turn off.' : 'Get a notification on this device when a customer writes, even when Kaunta is closed.';
    if (Notification.permission === 'denied') K.notice(note, 'Alerts are blocked for this site. Allow notifications in your browser settings, then tap Turn on alerts again.', 'err');
    else K.notice(note, '');
  }
  async function saveSub(sub) { await K.api('POST', '/chat/push/subscribe', { subscription: sub.toJSON() }); }
  async function pushInit() {
    var info; try { info = await K.api('GET', '/chat/push/key'); } catch (e) { return; }
    if (!info || !info.enabled) return;                       /* not set up on the server: show nothing */
    if (!canPush) {
      if (onIOS && !standalone) K.notice($('#pushNote'), 'To get alerts on an iPhone: tap Share, then Add to Home Screen, open Kaunta from your home screen and turn alerts on here.', 'ok');
      return;
    }
    P.key = info.public_key; $('#pushBtn').hidden = false;
    try {
      P.reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready;
      P.sub = await P.reg.pushManager.getSubscription();
      if (P.sub && Notification.permission === 'granted') saveSub(P.sub).catch(function () { /* keeps working, re-synced next visit */ });
      else P.sub = null;
    } catch (e) { $('#pushBtn').hidden = true; return; }
    paintPush();
  }
  $('#pushBtn').addEventListener('click', async function () {
    if (P.busy || !P.reg) return; P.busy = true; var btn = this; btn.disabled = true;
    try {
      if (P.sub) {                                             /* turn off */
        var endpoint = P.sub.endpoint;
        await K.api('POST', '/chat/push/unsubscribe', { endpoint: endpoint }).catch(function () {});
        await P.sub.unsubscribe(); P.sub = null;
        K.toast('Alerts are off on this device');
      } else {                                                 /* turn on: must happen from this tap */
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') { paintPush(); return; }
        P.sub = await P.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(P.key) });
        await saveSub(P.sub);
        try { await P.reg.showNotification('Alerts are on', { body: 'You will be notified here when a customer sends a message.', icon: '/img/icon-192.png', tag: 'kaunta-test' }); } catch (e) { /* the toast below is enough */ }
        K.toast('Alerts are on for this device');
      }
    } catch (e) { K.toast(e.message || 'Could not change alerts. Please try again.', 'err'); }
    finally { P.busy = false; btn.disabled = false; paintPush(); }
  });

  /* ---------- go ---------- */
  var searchT;
  $('#q').addEventListener('input', function () { clearTimeout(searchT); var v = this.value.trim(); searchT = setTimeout(function () { S.q = v; loadList(); }, 300); });
  $('#refresh').addEventListener('click', function () { loadList(); pollOpen(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { loadList(); pollOpen(); } });
  renderTabs(); loadList(); pushInit();
  document.addEventListener('chat:new', function () { loadList(); pollOpen(); });
  S.listTimer = setInterval(function () { if (!document.hidden) loadList(); }, LIST_MS);
  var want = new URLSearchParams(location.search).get('open'); if (want) openThread(want);
})();
