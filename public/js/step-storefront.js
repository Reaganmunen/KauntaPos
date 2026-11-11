/* Online store: GET/PUT /storefront/settings, POST /storefront/publish and /unpublish.
   Publishing needs a fulfilment branch and M-Pesa set up first; the server's message is shown if not. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var live = false;

  function paint(s, branches) {
    s = s || {};
    $('#sName').value = s.store_name || (K.session.tenant && K.session.tenant.name) || ''; $('#sTag').value = s.tagline || ''; $('#sLogo').value = s.logo_url || '';
    $('#sPhone').value = s.contact_phone || ''; $('#sWa').value = s.whatsapp_number || ''; $('#sAddr').value = s.address || ''; $('#sAnn').value = s.announcement || '';
    $('#sDel').checked = s.enable_delivery !== false; $('#sPick').checked = s.enable_pickup !== false;
    var sel = $('#sBranch'); sel.textContent = '';
    branches.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
    sel.value = s.fulfilment_branch_id || (branches[0] && branches[0].id) || '';
    live = Boolean(s.is_published); $('#sUnpub').hidden = !live; $('#sPub').hidden = live;
    $('#sLive').hidden = !live; $('#sLive').textContent = live ? 'Your store is live.' : '';
  }
  function body() {
    function v(id) { var x = $(id).value.trim(); return x === '' ? null : x; }
    return { store_name: v('#sName'), tagline: v('#sTag'), logo_url: v('#sLogo'), contact_phone: v('#sPhone'), whatsapp_number: v('#sWa'), address: v('#sAddr'),
      announcement: v('#sAnn'), enable_delivery: $('#sDel').checked, enable_pickup: $('#sPick').checked, fulfilment_branch_id: $('#sBranch').value || null };
  }
  async function save(andPublish) {
    var err = $('#sErr'), ok = $('#sOk'); K.notice(err, ''); K.notice(ok, '');
    var btns = [$('#sSave'), $('#sPub'), $('#sUnpub')]; btns.forEach(function (b) { b.disabled = true; });
    try {
      var s = await K.api('PUT', '/storefront/settings', body());
      if (andPublish) s = await K.api('POST', '/storefront/publish');
      paint(s, await K.branches());
      K.notice(ok, andPublish ? 'Saved and published. Your store is live.' : 'Saved.', 'ok');
    } catch (ex) { K.notice(err, (andPublish ? 'Saved, but the store could not go live: ' : '') + ex.message, 'err'); }
    btns.forEach(function (b) { b.disabled = false; });
  }
  $('#sfForm').addEventListener('submit', function (e) { e.preventDefault(); save(false); });
  $('#sPub').addEventListener('click', function () { save(true); });
  $('#sUnpub').addEventListener('click', async function () {
    K.notice($('#sErr'), ''); try { paint(await K.api('POST', '/storefront/unpublish'), await K.branches()); K.notice($('#sOk'), 'Your store is offline.', 'ok'); } catch (ex) { K.notice($('#sErr'), ex.message, 'err'); }
  });

  (async function () {
    try { paint(await K.api('GET', '/storefront/settings'), await K.branches()); }
    catch (ex) { K.notice($('#sErr'), ex.code === 'feature_disabled' ? 'The online store is not switched on for your shop.' : ex.message, 'err'); }
  })();
})();
