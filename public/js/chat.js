/* Storefront chat: shoppers ask the shop a question and get answers in the same window, no account needed.
   store.js calls KChat.init({ name }) once the shop has loaded, and KChat.open({ product }) from a product page.
   API (public, same host rules as the rest of the store):
     POST /store/chat/threads   { name, phone, email, message, product_slug }  -> { token, thread, messages }
     GET  /store/chat/thread?after=<seq>   X-Chat-Token                         -> { thread, messages }
     GET  /store/chat/unread               X-Chat-Token                         -> { unread }
     POST /store/chat/messages  { body, product_slug }  X-Chat-Token
   The secret token stays in this browser (localStorage); the shop only stores its hash. */
(function () {
  'use strict';
  var base = ((window.KAUNTA_CONFIG && window.KAUNTA_CONFIG.API) || '/api').replace(/\/$/, '') + '/store';
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } return null; }
  var params = new URLSearchParams(location.search);
  var slug = (params.get('shop') || '').trim().toLowerCase() || store('kaunta.shop') || '';
  var KEY = 'kaunta.chat.' + (slug || location.host);

  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function icon(n) { var i = document.createElement('i'); i.className = 'ph ph-' + n; i.setAttribute('aria-hidden', 'true'); return i; }
  function hhmm(d) { return new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); }

  var S = { token: '', name: '', last: 0, shop: '', product: null, openNow: false, timer: 0, badgeTimer: 0, sending: false, ui: null };
  try { var saved = JSON.parse(store(KEY) || 'null'); if (saved && saved.token) { S.token = saved.token; S.name = saved.name || ''; } } catch (e) { /* ignore */ }

  async function call(method, path, body) {
    var h = { Accept: 'application/json' };
    if (slug) h['X-Tenant'] = slug;
    if (S.token) h['X-Chat-Token'] = S.token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    var res;
    try { res = await fetch(base + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { var n = new Error('You seem to be offline. Check your connection and try again.'); n.network = true; throw n; }
    var j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !j || j.success === false) {
      var err = (j && j.error) || {};
      var x = new Error(res.status === 429 ? 'Too many messages. Please wait a moment.' : err.message || 'Something went wrong. Please try again.');
      x.status = res.status; x.code = err.code; throw x;
    }
    return j.data;
  }

  /* ---------- UI ---------- */
  function build() {
    var btn = el('button', undefined, 'kc-btn'); btn.type = 'button'; btn.appendChild(icon('chat-circle-text')); btn.appendChild(el('span', 'Chat')); btn.setAttribute('aria-label', 'Chat with the shop');
    var badge = el('span', '', 'kc-n'); badge.hidden = true; btn.appendChild(badge);
    var panel = el('section', undefined, 'kc-panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with the shop');
    var head = el('div', undefined, 'kc-head'), av = el('span', '', 'kc-av'), mid = el('div'), title = el('b', ''), sub = el('small', 'Ask us anything, we reply here');
    mid.appendChild(title); mid.appendChild(sub);
    var close = el('button'); close.type = 'button'; close.setAttribute('aria-label', 'Close chat'); close.appendChild(icon('x'));
    head.appendChild(av); head.appendChild(mid); head.appendChild(close);
    var main = el('div', undefined, 'kc-main'); main.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
    panel.appendChild(head); panel.appendChild(main);
    document.body.appendChild(btn); document.body.appendChild(panel);
    btn.addEventListener('click', function () { openPanel(); });
    close.addEventListener('click', function () { closePanel(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.openNow) closePanel(); });
    S.ui = { btn: btn, badge: badge, panel: panel, title: title, av: av, main: main };
  }

  function setBadge(n) { S.ui.badge.hidden = !(n > 0); S.ui.badge.textContent = n > 9 ? '9+' : String(n); }

  function showStart() {
    var m = S.ui.main; m.textContent = '';
    var f = el('form', undefined, 'kc-form'); f.noValidate = true;
    f.appendChild(el('p', 'Send your question and ' + (S.shop || 'the shop') + ' will answer here. Leave your number in case you close this page.'));
    function field(label, input) { var l = el('label'); l.appendChild(el('span', label)); l.appendChild(input); f.appendChild(l); return input; }
    var name = el('input'); name.type = 'text'; name.maxLength = 80; name.autocomplete = 'name'; name.value = S.name || ''; field('Your name', name);
    var phone = el('input'); phone.type = 'tel'; phone.inputMode = 'tel'; phone.autocomplete = 'tel'; phone.placeholder = '0712 345 678'; field('Phone number', phone);
    var msg = el('textarea'); msg.maxLength = 1000; msg.placeholder = S.product ? 'e.g. Is this still available?' : 'Type your question'; field('Your message', msg);
    if (S.product) { var chip = el('div', undefined, 'kc-ref'); chip.appendChild(icon('tag')); chip.appendChild(el('span', 'About: ' + S.product.name)); chip.style.alignSelf = 'flex-start'; f.insertBefore(chip, f.children[1]); }
    var err = el('p', '', 'kc-err'); err.hidden = true; f.appendChild(err);
    var go = el('button', 'Send message', 'kc-go'); go.type = 'submit'; f.appendChild(go);
    f.addEventListener('submit', async function (e) {
      e.preventDefault(); err.hidden = true; go.disabled = true; go.textContent = 'Sending...';
      try {
        var out = await call('POST', '/chat/threads', { name: name.value, phone: phone.value, message: msg.value, product_slug: S.product ? S.product.slug : undefined });
        S.token = out.token; S.name = name.value.trim(); S.last = 0; store(KEY, JSON.stringify({ token: S.token, name: S.name })); S.product = null;
        showThread(); render(out.messages);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; go.disabled = false; go.textContent = 'Send message'; }
    });
    m.appendChild(f); setTimeout(function () { (name.value ? msg : name).focus(); }, 50);
  }

  function showThread() {
    var m = S.ui.main; m.textContent = '';
    var body = el('div', undefined, 'kc-body'); body.setAttribute('aria-live', 'polite'); body.id = 'kcBody';
    var form = el('form', undefined, 'kc-compose'); form.noValidate = true;
    var ta = el('textarea'); ta.rows = 1; ta.maxLength = 1000; ta.placeholder = 'Type a message'; ta.setAttribute('aria-label', 'Message');
    var send = el('button'); send.type = 'submit'; send.setAttribute('aria-label', 'Send'); send.appendChild(icon('paper-plane-right'));
    form.appendChild(ta); form.appendChild(send);
    m.appendChild(body); m.appendChild(form);
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); var text = ta.value.trim(); if (!text || S.sending) return;
      S.sending = true; send.disabled = true;
      try {
        var sent = await call('POST', '/chat/messages', { body: text, product_slug: S.product ? S.product.slug : undefined });
        ta.value = ''; ta.style.height = 'auto'; S.product = null; render([sent]);
      } catch (ex) {
        if (ex.status === 404) { forget(); showStart(); return; }
        note(ex.message);
      }
      S.sending = false; send.disabled = false; ta.focus();
    });
    if (S.product) { var chip = el('div', undefined, 'kc-ref'); chip.appendChild(icon('tag')); chip.appendChild(el('span', 'Asking about: ' + S.product.name)); body.appendChild(chip); }
    setTimeout(function () { ta.focus(); }, 50);
  }

  function note(text) { var b = document.getElementById('kcBody'); if (!b) return; b.appendChild(el('div', text, 'kc-sys')); b.scrollTop = b.scrollHeight; }

  function render(messages) {
    var b = document.getElementById('kcBody'); if (!b || !messages || !messages.length) return;
    var stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80 || !S.last;
    messages.forEach(function (m) {
      if (m.seq <= S.last) return;
      S.last = m.seq;
      if (m.product_name) { var r = el('div', undefined, 'kc-ref'); r.appendChild(icon('tag')); r.appendChild(el('span', 'About: ' + m.product_name)); r.style.alignSelf = m.sender === 'customer' ? 'flex-end' : 'flex-start'; b.appendChild(r); }
      var d = el('div', m.body, 'kc-msg ' + (m.sender === 'customer' ? 'me' : 'shop'));
      d.appendChild(el('small', (m.sender === 'staff' && m.staff_name ? m.staff_name + ' · ' : '') + hhmm(m.created_at)));
      b.appendChild(d);
    });
    if (stick) b.scrollTop = b.scrollHeight;
  }

  function forget() { S.token = ''; S.last = 0; store(KEY, null); stopPolling(); setBadge(0); }

  /* ---------- polling ---------- */
  async function poll() {
    if (!S.token || document.hidden) return;
    try {
      var d = await call('GET', '/chat/thread?after=' + S.last);
      render(d.messages);
    } catch (e) {
      if (e.status === 404 || e.status === 401) { forget(); if (S.openNow) showStart(); }
    }
  }
  function stopPolling() { clearInterval(S.timer); S.timer = 0; }
  async function badgeCheck() {
    if (!S.token || S.openNow || document.hidden) return;
    try { var d = await call('GET', '/chat/unread'); setBadge(d.unread); }
    catch (e) { if (e.status === 404 || e.status === 401) forget(); }
  }

  /* ---------- open / close ---------- */
  async function openPanel(opts) {
    if (!S.ui) return;
    if (opts && opts.product) S.product = opts.product;
    S.openNow = true; S.ui.panel.hidden = false; S.ui.btn.hidden = true; setBadge(0);
    if (S.token) {
      showThread(); S.last = 0;
      await poll();
      stopPolling(); S.timer = setInterval(poll, 4000);
    } else showStart();
  }
  function closePanel() { S.openNow = false; S.ui.panel.hidden = true; S.ui.btn.hidden = false; stopPolling(); }

  window.KChat = {
    /* store.js calls this once the shop is known to be open */
    init: function (shop) {
      if (S.ui) return;
      S.shop = (shop && shop.name) || '';
      build();
      S.ui.title.textContent = S.shop || 'Chat with us';
      S.ui.av.textContent = (S.shop || '?').trim().charAt(0).toUpperCase();
      clearInterval(S.badgeTimer); S.badgeTimer = setInterval(badgeCheck, 20000); badgeCheck();
      if (params.get('chat') === '1') openPanel();
    },
    open: function (opts) { openPanel(opts); }
  };
})();
