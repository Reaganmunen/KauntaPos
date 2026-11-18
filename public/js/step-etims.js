/* eTIMS: GET/PUT /etims/config, POST /etims/verify, GET /etims/status (for the receipts link). */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('step-etims.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }
  var $ = function (s) { return document.querySelector(s); };
  var hasKey = false;

  function paint(c) {
    hasKey = Boolean(c && c.has_api_key);
    $('#state').textContent = c && c.is_active && hasKey ? 'Connected' : hasKey ? 'Saved, not verified' : 'Not connected';
    if (c) { if (c.environment) $('#eEnv').value = c.environment; $('#eBiz').value = c.provider_business_id || ''; $('#eAuto').checked = c.auto_submit !== false; }
    $('#hKey').textContent = hasKey ? 'Saved. Leave blank to keep it.' : '';
  }

  // Shows on the "View eTIMS receipts" button how many receipts need attention.
  async function paintReceiptsLink() {
    try {
      var counts = (await K.api('GET', '/etims/status')) || {};
      var stuck = (Number(counts.failed) || 0) + (Number(counts.rejected) || 0);
      $('#goReceiptsLabel').textContent = stuck ? 'View eTIMS receipts (' + stuck + ' need attention)' : 'View eTIMS receipts';
    } catch (ex) { /* the button still works without the count */ }
  }

  $('#etForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#eErr'), ok = $('#eOk'), btn = $('#eSave'); K.notice(err, ''); K.notice(ok, '');
    var key = $('#eKey').value.trim();
    if (!key && !hasKey) return K.notice(err, 'Paste your Digitax API key.', 'err');
    var body = { provider: 'digitax', environment: $('#eEnv').value, auto_submit: $('#eAuto').checked, provider_business_id: $('#eBiz').value.trim() || null };
    if (key) body.api_key = key;
    K.busy(btn, true, 'Verifying...');
    try {
      paint(await K.api('PUT', '/etims/config', body)); $('#eKey').value = '';
      var r = await K.api('POST', '/etims/verify');
      if (r && r.ok) {
        paint(await K.api('GET', '/etims/config'));
        K.notice(ok, 'Connected. Your sales will now be sent to KRA. You can follow them on the eTIMS receipts page.', 'ok');
        paintReceiptsLink();
      }
      else K.notice(err, 'Saved, but Digitax did not accept the key' + (r && r.message ? ': ' + r.message : '.') + ' Check it and try again.', 'err');
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  (async function () {
    try { paint(await K.api('GET', '/etims/config')); } catch (ex) { K.notice($('#eErr'), ex.message, 'err'); }
    paintReceiptsLink();
  })();
})();