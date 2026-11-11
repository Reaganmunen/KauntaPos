/* M-Pesa: GET/POST/PATCH /mpesa/configs, then /test and /register-c2b. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var cfg = null;

  function msg(text, kind) { K.notice($('#exMsg'), text, kind); }
  function show(c) {
    cfg = c; if (!c) return;
    $('#existing').hidden = false; $('#exEnv').textContent = c.environment === 'sandbox' ? 'Sandbox' : 'Live';
    var ul = $('#exRows'); ul.textContent = '';
    [['Number', c.shortcode + ' (' + (c.shortcode_type === 'paybill' ? 'paybill' : 'till') + ')'], ['Consumer key', c.has_consumer_key ? 'Saved' : 'Missing'],
     ['Consumer secret', c.has_consumer_secret ? 'Saved' : 'Missing'], ['Passkey', c.has_passkey ? 'Saved' : 'Not added'],
     ['Payment URLs', c.c2b_registered_at ? 'Registered' : 'Not registered yet']].forEach(function (r) { var li = K.el('li'); li.appendChild(K.el('span', r[0])); li.appendChild(K.el('b', r[1])); ul.appendChild(li); });
    $('#mType').value = c.shortcode_type || 'till'; $('#mCode').value = c.shortcode || ''; $('#mEnv').value = c.environment || 'live'; $('#mLabel').value = c.label || '';
    $('#hKey').textContent = c.has_consumer_key ? 'Saved. Leave blank to keep it.' : ''; $('#hSecret').textContent = c.has_consumer_secret ? 'Saved. Leave blank to keep it.' : '';
    $('#hPass').textContent = c.has_passkey ? 'Saved. Leave blank to keep it.' : 'Needed for the "pay on phone" prompt (STK push).';
    $('#formTitle').textContent = 'Change your Daraja details'; $('#mSave').textContent = 'Save changes and test'; $('#mSave').dataset.label = '';
    var u = c.callback_urls; if (u) {
      var ul2 = $('#urlRows'); ul2.textContent = '';
      [['Confirmation', u.c2b_confirmation], ['Validation', u.c2b_validation], ['STK callback', u.stk_callback]].forEach(function (r) { var li = K.el('li'); li.appendChild(K.el('span', r[0])); li.appendChild(K.el('span', r[1], 'mono')); ul2.appendChild(li); });
      $('#urls').hidden = false;
    }
  }

  async function test() {
    msg('Testing the connection...', 'ok');
    try { var r = await K.api('POST', '/mpesa/configs/' + cfg.id + '/test'); msg(r.message || (r.ok ? 'Connected to Safaricom.' : 'The connection failed.'), r.ok ? 'ok' : 'err'); return r.ok; }
    catch (ex) { msg(ex.message, 'err'); return false; }
  }
  async function c2b() {
    msg('Registering with Safaricom...', 'ok');
    try { var r = await K.api('POST', '/mpesa/configs/' + cfg.id + '/register-c2b'); msg((r && r.message) || 'Payment URLs registered.', r && r.ok === false ? 'err' : 'ok'); show(await K.api('GET', '/mpesa/configs').then(function (l) { return (l || []).filter(function (x) { return x.id === cfg.id; })[0] || cfg; })); }
    catch (ex) { msg(ex.message, 'err'); }
  }
  $('#exTest').addEventListener('click', test);
  $('#exC2b').addEventListener('click', c2b);

  $('#mpForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#mErr'), btn = $('#mSave'); K.notice(err, ''); msg('');
    var code = $('#mCode').value.trim();
    if (!/^\d{4,9}$/.test(code)) return K.notice(err, 'Enter your till or paybill number (digits only).', 'err');
    var body = { shortcode: code, shortcode_type: $('#mType').value, environment: $('#mEnv').value, label: $('#mLabel').value.trim() || 'Main till' };
    if ($('#mKey').value.trim()) body.consumer_key = $('#mKey').value.trim();
    if ($('#mSecret').value.trim()) body.consumer_secret = $('#mSecret').value.trim();
    if ($('#mPass').value.trim()) body.passkey = $('#mPass').value.trim();
    if (!cfg) { if (!body.consumer_key || !body.consumer_secret) return K.notice(err, 'Enter the consumer key and consumer secret from your Daraja app.', 'err'); body.is_default = true; }
    K.busy(btn, true, 'Saving...');
    try {
      show(cfg ? await K.api('PATCH', '/mpesa/configs/' + cfg.id, body) : await K.api('POST', '/mpesa/configs', body));
      ['#mKey', '#mSecret', '#mPass'].forEach(function (s) { $(s).value = ''; });
      var ok = await test();
      if (ok) msg('Saved and connected to Safaricom. Next, press "Register payment URLs" so payments reach Kaunta.', 'ok');
      else msg('Saved, but the connection test failed. Check the keys and the environment, then save again.', 'err');
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  (async function () {
    try { var list = await K.api('GET', '/mpesa/configs'); var active = (list || []).filter(function (c) { return c.is_active; }); show(active.filter(function (c) { return c.is_default; })[0] || active[0] || null); } catch (ex) { K.notice($('#mErr'), ex.message, 'err'); }
  })();
})();
