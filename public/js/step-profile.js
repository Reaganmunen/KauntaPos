/* Profile and shop: your picture and details (PATCH /profile), the shop logo and details (PATCH /tenant,
   plus PUT /storefront/settings to reuse the logo on the online store), and your password.
   Pictures are shrunk in the browser (KApp.photo), uploaded to POST /media when you press Save, and the
   returned link is what gets stored. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };

  var me = { url: null, pending: null, changed: false };     // pending = data URL chosen but not saved yet
  var logo = { url: null, pending: null, changed: false };

  function paint(state, avId, txtId, rmId, name, word) {
    var shown = state.changed ? state.pending : state.url;       // null after Remove
    K.avatar($(avId), shown, name);
    $(txtId).textContent = shown ? 'Change ' + word : 'Add ' + word;
    $(rmId).hidden = !shown;
  }
  function wire(state, fileId, rmId, repaint, opts, errBox) {
    $(fileId).addEventListener('change', async function () {
      var f = this.files && this.files[0]; K.notice(errBox, ''); if (!f) return;
      try { state.pending = await K.photo(f, opts); state.changed = true; } catch (ex) { K.notice(errBox, ex.message, 'err'); }
      this.value = ''; repaint();
    });
    $(rmId).addEventListener('click', function () { state.pending = null; state.changed = true; repaint(); });
  }
  function repaintMe() { paint(me, '#meAv', '#meFileTxt', '#meRemove', $('#meName').value, 'picture'); }
  function repaintLogo() { paint(logo, '#logoAv', '#logoFileTxt', '#logoRemove', $('#sName').value, 'logo'); $('#sfRow').hidden = !(logo.changed ? logo.pending : logo.url) && !logo.changed; }
  wire(me, '#meFile', '#meRemove', repaintMe, { max: 256, square: true }, $('#meErr'));
  wire(logo, '#logoFile', '#logoRemove', repaintLogo, { max: 512, png: true }, $('#shErr'));
  $('#meName').addEventListener('input', function () { if (!(me.changed ? me.pending : me.url)) repaintMe(); });
  $('#sName').addEventListener('input', function () { if (!(logo.changed ? logo.pending : logo.url)) repaintLogo(); });

  /* ---------- your profile ---------- */
  $('#meForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#meErr'), ok = $('#meOk'), btn = $('#meSave'); K.notice(err, ''); K.notice(ok, '');
    var name = $('#meName').value.trim(); if (!name) return K.notice(err, 'Enter your name.', 'err');
    K.busy(btn, true, 'Saving...');
    try {
      var body = { full_name: name, phone: $('#mePhone').value.trim() };
      if (me.changed) body.avatar_url = me.pending ? await K.upload(me.pending) : null;
      var u = await K.api('PATCH', '/profile', body);
      me.url = u.avatar_url || null; me.pending = null; me.changed = false; repaintMe();
      K.patchSession(function (s) { if (s.user) { s.user.name = u.full_name; s.user.full_name = u.full_name; } });
      K.notice(ok, 'Saved.', 'ok');
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- shop profile ---------- */
  $('#shopForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#shErr'), ok = $('#shOk'), btn = $('#shSave'); K.notice(err, ''); K.notice(ok, '');
    var name = $('#sName').value.trim(); if (!name) return K.notice(err, 'Enter the shop name.', 'err');
    function v(id) { var x = $(id).value.trim(); return x === '' ? null : x; }
    K.busy(btn, true, 'Saving...');
    try {
      var body = { name: name, phone: v('#sPhone'), email: v('#sEmail'), address: v('#sAddr'), county: v('#sCounty'), kra_pin: v('#sPin') ? v('#sPin').toUpperCase() : null, vat_registered: $('#sVat').checked };
      if (logo.changed) body.logo_url = logo.pending ? await K.upload(logo.pending) : null;
      var t = await K.api('PATCH', '/tenant', body);
      var note = 'Saved.';
      if (logo.changed && $('#sfLogo').checked) {
        try { await K.api('PUT', '/storefront/settings', { logo_url: t.logo_url || null }); note = 'Saved. The logo is on your online store too.'; }
        catch (ex2) { note = 'Saved. The online store logo was not changed (' + ex2.message + ')'; }
      }
      logo.url = t.logo_url || null; logo.pending = null; logo.changed = false; repaintLogo();
      K.patchSession(function (s) { if (s.tenant) s.tenant.name = t.name; });
      K.notice(ok, note, 'ok');
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- password ---------- */
  $('#pwForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#pwErr'), ok = $('#pwOk'), btn = $('#pwSave'); K.notice(err, ''); K.notice(ok, '');
    var a = $('#pwOld').value, b = $('#pwNew').value;
    if (!a || !b) return K.notice(err, 'Enter your current and new password.', 'err');
    if (b.length < 8) return K.notice(err, 'Use at least 8 characters for the new password.', 'err');
    if (b !== $('#pwNew2').value) return K.notice(err, 'The two new passwords do not match.', 'err');
    K.busy(btn, true, 'Changing...');
    try { await K.api('POST', '/auth/change-password', { current_password: a, new_password: b }); ['#pwOld', '#pwNew', '#pwNew2'].forEach(function (s) { $(s).value = ''; }); K.notice(ok, 'Password changed.', 'ok'); }
    catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });

  /* ---------- load ---------- */
  (async function () {
    var d = await K.identity();
    if (!d) { K.notice($('#meErr'), 'We could not load your profile. Refresh the page.', 'err'); return; }
    var u = d.user || {}, t = d.tenant || {};
    $('#meName').value = u.full_name || ''; $('#mePhone').value = u.phone || ''; $('#meEmail').textContent = u.email ? 'Sign-in email: ' + u.email : '';
    me.url = u.avatar_url || null; repaintMe();
    if (K.can(u, 'settings.manage')) {
      $('#shopCard').hidden = false;
      $('#sName').value = t.name || ''; $('#sPhone').value = t.phone || ''; $('#sEmail').value = t.email || ''; $('#sAddr').value = t.address || ''; $('#sCounty').value = t.county || '';
      $('#sPin').value = t.kra_pin || ''; $('#sVat').checked = Boolean(t.vat_registered);
      logo.url = t.logo_url || null; repaintLogo();
      if (d.features && d.features.storefront === false) { $('#sfLogo').checked = false; }
    }
  })();
})();