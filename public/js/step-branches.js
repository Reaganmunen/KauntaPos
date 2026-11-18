/* Branches: list and manage the shop's branches and the tills (POS terminals) inside them.
   GET /branches?all=true, POST /branches, PATCH /branches/:id, POST /branches/:id/main,
   GET and POST /branches/:id/terminals, PATCH /terminals/:id.
   A branch cannot be deleted, only switched off, and the main branch cannot be switched off until
   another branch is made the main one (the server enforces both and its message is shown).
   A till counts as online when its last heartbeat is under five minutes old. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('step-branches.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }
  var $ = function (s) { return document.querySelector(s); };
  var S = { branches: [], tills: {}, editing: null, tillEdit: null, loaded: false };
  var ONLINE_MS = 5 * 60 * 1000;
  var SEEN_KEYS = ['last_seen_at', 'last_heartbeat_at', 'last_seen', 'last_seen_on'];

  /* ---------- helpers ---------- */
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function failText(ex, fb) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fb; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function seenAt(t) {
    for (var i = 0; i < SEEN_KEYS.length; i++) { var v = t[SEEN_KEYS[i]]; if (v) { var d = new Date(v); if (!isNaN(d)) return d; } }
    return null;
  }
  function tracksSeen(t) { return SEEN_KEYS.some(function (k) { return k in t; }); }
  function isOnline(t) { var d = seenAt(t); return t.is_active !== false && Boolean(d) && Date.now() - d.getTime() < ONLINE_MS; }
  function ago(d) {
    var m = Math.floor((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.floor(m / 60) + ' h ago';
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }
  function tillsOf(b) { return S.tills[b.id]; }

  /* ---------- summary ---------- */
  function cell(label, value, sub, cls) {
    var c = K.el('div', undefined, 'br-stat'), v = K.el('b', value, 'num' + (cls ? ' ' + cls : ''));
    c.appendChild(K.el('small', label)); c.appendChild(v);
    if (sub) { var s = K.el('span', sub.text, sub.on ? 'on' : ''); c.appendChild(s); }
    return c;
  }
  function stats() {
    var box = $('#stats'); box.textContent = '';
    var active = S.branches.filter(function (b) { return b.is_active !== false; }), main = S.branches.filter(function (b) { return b.is_main; })[0];
    var all = [], seen = false;
    S.branches.forEach(function (b) { (tillsOf(b) || []).forEach(function (t) { all.push(t); if (tracksSeen(t)) seen = true; }); });
    var live = all.filter(function (t) { return t.is_active !== false; }), online = live.filter(isOnline).length;
    box.appendChild(cell('Active branches', String(active.length), { text: 'of ' + plural(S.branches.length, 'branch', 'branches') }));
    box.appendChild(cell('Main branch', main ? main.name : 'Not set', main ? { text: main.code || '' } : { text: 'Choose one below' }, 'txt'));
    box.appendChild(cell('Tills', String(live.length), seen ? { text: online + ' online now', on: online > 0 } : { text: 'registered' }));
  }

  /* ---------- branch cards ---------- */
  function metaLine(icon, text, mono) {
    var li = K.el('li'); li.appendChild(K.icon(icon)); li.appendChild(K.el('span', text, mono ? 'mono' : ''));
    return li;
  }
  function dots(list) {
    var d = K.el('span', undefined, 'br-dots'); d.setAttribute('aria-hidden', 'true');
    list.slice(0, 8).forEach(function (t) { d.appendChild(K.el('i', undefined, t.is_active === false ? 'off' : isOnline(t) ? 'on' : 'idle')); });
    return d;
  }
  function card(b) {
    var off = b.is_active === false, c = K.el('article', undefined, 'br-card' + (b.is_main ? ' main' : '') + (off ? ' off' : ''));
    var top = K.el('div', undefined, 'br-top'), ic = K.el('span', undefined, 'ic' + (b.is_main ? ' gold' : '')); ic.appendChild(K.icon('storefront'));
    var nm = K.el('div', undefined, 'br-name'); nm.appendChild(K.el('b', b.name || 'Untitled branch')); if (b.code) nm.appendChild(K.el('small', b.code, 'mono'));
    top.appendChild(ic); top.appendChild(nm);
    var tags = K.el('span', undefined, 'br-tags');
    if (b.is_main) tags.appendChild(K.el('span', 'Main', 'tag warn'));
    if (off) tags.appendChild(K.el('span', 'Inactive', 'tag'));
    top.appendChild(tags); c.appendChild(top);

    var meta = K.el('ul', undefined, 'br-meta'), where = [b.address, b.county].filter(Boolean).join(', ');
    if (where) meta.appendChild(metaLine('map-pin', where));
    if (b.phone) meta.appendChild(metaLine('phone', b.phone));
    if (b.etims_branch_id) meta.appendChild(metaLine('receipt', 'eTIMS ' + b.etims_branch_id, true));
    if (!meta.children.length) meta.appendChild(K.el('li', 'No address or phone yet.', 'muted'));
    c.appendChild(meta);

    var foot = K.el('div', undefined, 'br-foot'), left = K.el('div', undefined, 'br-tl'), list = tillsOf(b);
    if (list) {
      var live = list.filter(function (t) { return t.is_active !== false; }), on = live.filter(isOnline).length, seen = list.some(tracksSeen);
      if (live.length) { left.appendChild(dots(list)); left.appendChild(K.el('span', plural(live.length, 'till', 'tills') + (seen ? ', ' + on + ' online' : ''), 'num')); }
      else left.appendChild(K.el('span', 'No tills yet', 'muted'));
    }
    foot.appendChild(left);
    var acts = K.el('div', undefined, 'br-acts');
    if (!b.is_main && !off) {
      var mk = K.el('button', 'Make main', 'btn ghost sm'); mk.type = 'button';
      mk.addEventListener('click', function (e) { e.stopPropagation(); makeMain(b, mk); }); acts.appendChild(mk);
    }
    var ed = K.el('button', 'Edit', 'btn sm'); ed.type = 'button';
    ed.addEventListener('click', function (e) { e.stopPropagation(); openBranch(b); }); acts.appendChild(ed);
    foot.appendChild(acts); c.appendChild(foot);
    c.addEventListener('click', function () { openBranch(b); });
    return c;
  }
  function renderAll() {
    stats();
    var box = $('#brList'); box.textContent = '';
    if (!S.branches.length) {
      var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('storefront'));
      e.appendChild(ic); e.appendChild(K.el('b', 'No branches yet')); e.appendChild(K.el('p', 'Add your first branch to start selling.')); box.appendChild(e); return;
    }
    S.branches.forEach(function (b) { box.appendChild(card(b)); });
  }

  async function load() {
    K.notice($('#brErr'), '');
    if (!S.loaded) {
      var box = $('#brList'); box.textContent = ''; for (var i = 0; i < 3; i++) box.appendChild(K.el('div', undefined, 'sk-row br-sk'));
      var st = $('#stats'); st.textContent = ''; for (var j = 0; j < 3; j++) st.appendChild(K.el('div', undefined, 'sk-row'));
    }
    try {
      S.branches = rowsOf(await K.api('GET', '/branches?all=true')); S.loaded = true;
      await Promise.all(S.branches.map(async function (b) {
        try { S.tills[b.id] = rowsOf(await K.api('GET', '/branches/' + encodeURIComponent(b.id) + '/terminals')); } catch (ex) { S.tills[b.id] = undefined; }
      }));
      renderAll();
    } catch (ex) { $('#brList').textContent = ''; $('#stats').textContent = ''; K.notice($('#brErr'), failText(ex, 'We could not load your branches.'), 'err'); }
  }

  async function makeMain(b, btn) {
    if (!window.confirm('Make ' + b.name + ' the main branch? The current main branch stays active.')) return;
    K.notice($('#brErr'), ''); K.busy(btn, true, 'Saving...');
    try { await K.api('POST', '/branches/' + encodeURIComponent(b.id) + '/main'); K.toast(b.name + ' is now the main branch'); await load(); }
    catch (ex) { K.notice($('#brErr'), failText(ex, 'We could not change the main branch.'), 'err'); K.busy(btn, false); }
  }

  /* ---------- branch form ---------- */
  function fill(b) {
    $('#bName').value = b.name || ''; $('#bCode').value = b.code || ''; $('#bPhone').value = b.phone || ''; $('#bCounty').value = b.county || '';
    $('#bAddr').value = b.address || ''; $('#bEtims').value = b.etims_branch_id || '';
    var main = Boolean(b.is_main), m = $('#bMain'), a = $('#bActive');
    m.checked = main; a.checked = b.is_active !== false; m.disabled = main; a.disabled = main;
    $('#bMainHelp').textContent = main ? 'This is your main branch. To change it, make another branch the main one.' : 'Your head office. Only one branch can be the main one.';
  }
  function openBranch(b) {
    S.editing = b || null; K.notice($('#brFormErr'), ''); K.notice($('#tillErr'), '');
    $('#brTitle').textContent = b ? 'Edit branch' : 'Add a branch'; fill(b || {});
    $('#brTills').hidden = !b; $('#tillHint').hidden = Boolean(b);
    var dlg = $('#brDlg'); if (!dlg.open) dlg.showModal();
    if (b) loadTills(b);
  }
  $('#addBranch').addEventListener('click', function () { openBranch(null); });

  $('#brForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#brFormErr'), btn = $('#brSave'); K.notice(err, '');
    var name = $('#bName').value.trim(), code = $('#bCode').value.trim().toUpperCase();
    if (!name) return K.notice(err, 'Enter the branch name.', 'err');
    if (!code) return K.notice(err, 'Enter a short code for the branch, like WLD.', 'err');
    if ($('#bMain').checked && !$('#bActive').checked) return K.notice(err, 'The main branch has to be active.', 'err');
    var body = { name: name, code: code, phone: blank($('#bPhone').value), county: blank($('#bCounty').value), address: blank($('#bAddr').value),
      etims_branch_id: blank($('#bEtims').value), is_active: $('#bActive').checked, is_main: $('#bMain').checked };
    K.busy(btn, true, 'Saving...');
    try {
      var editing = S.editing, res = editing ? await K.api('PATCH', '/branches/' + encodeURIComponent(editing.id), body) : await K.api('POST', '/branches', body);
      await load();
      if (editing) { $('#brDlg').close(); K.toast('Branch saved'); }
      else {
        var rec = res && res.id ? res : res && res.data;
        var fresh = rec && S.branches.filter(function (b) { return b.id === rec.id; })[0];
        if (fresh) { openBranch(fresh); K.toast('Branch added. You can add its tills now.'); } else { $('#brDlg').close(); K.toast('Branch added'); }
      }
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the branch.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---------- tills ---------- */
  function renderTills(b) {
    var ul = $('#tillList'), list = S.tills[b.id]; ul.textContent = '';
    if (list === undefined) { ul.appendChild(K.el('li', 'We could not load the tills.', 'muted')); return; }
    if (!list.length) { ul.appendChild(K.el('li', 'No tills yet. Add the devices you sell from.', 'muted br-none')); return; }
    list.forEach(function (t) {
      var li = K.el('li', undefined, 'br-till' + (t.is_active === false ? ' off' : '')), main = K.el('div', undefined, 'grow');
      main.appendChild(K.el('b', t.name || 'Till')); main.appendChild(K.el('small', t.device_id || 'No device ID', t.device_id ? 'mono muted' : 'muted'));
      li.appendChild(main);
      var seen = seenAt(t), st;
      if (t.is_active === false) st = K.el('span', 'Off', 'tag');
      else if (isOnline(t)) st = K.el('span', 'Online', 'tag dot ok');
      else if (seen) st = K.el('span', 'Seen ' + ago(seen), 'tag');
      else st = K.el('span', 'Active', 'tag');
      li.appendChild(st);
      var ed = K.el('button', undefined, 'icon-btn sm'); ed.type = 'button'; ed.setAttribute('aria-label', 'Edit ' + (t.name || 'till')); ed.appendChild(K.icon('pencil-simple'));
      li.appendChild(ed);
      li.addEventListener('click', function () { openTill(t); });
      ul.appendChild(li);
    });
  }
  async function loadTills(b) {
    var ul = $('#tillList'); ul.textContent = ''; ul.appendChild(K.el('li', undefined, 'sk-row'));
    try { S.tills[b.id] = rowsOf(await K.api('GET', '/branches/' + encodeURIComponent(b.id) + '/terminals')); }
    catch (ex) { S.tills[b.id] = undefined; K.notice($('#tillErr'), failText(ex, 'We could not load the tills.'), 'err'); }
    if (S.editing && S.editing.id === b.id) renderTills(b);
  }
  function openTill(t) {
    S.tillEdit = t || null; K.notice($('#tmErr'), '');
    $('#tmTitle').textContent = t ? 'Edit till' : 'Add a till';
    $('#tmName').value = t ? t.name || '' : ''; $('#tmDevice').value = t ? t.device_id || '' : ''; $('#tmActive').checked = !t || t.is_active !== false;
    $('#tmActiveWrap').hidden = !t; $('#tmDlg').showModal();
  }
  $('#addTill').addEventListener('click', function () { openTill(null); });
  $('#tmForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#tmErr'), btn = $('#tmSave'), b = S.editing; K.notice(err, '');
    if (!b) return;
    var name = $('#tmName').value.trim(); if (!name) return K.notice(err, 'Enter a name for the till.', 'err');
    var body = { name: name, device_id: blank($('#tmDevice').value) };
    K.busy(btn, true, 'Saving...');
    try {
      if (S.tillEdit) { body.is_active = $('#tmActive').checked; await K.api('PATCH', '/terminals/' + encodeURIComponent(S.tillEdit.id), body); }
      else await K.api('POST', '/branches/' + encodeURIComponent(b.id) + '/terminals', body);
      $('#tmDlg').close(); K.toast('Till saved');
      S.tills[b.id] = rowsOf(await K.api('GET', '/branches/' + encodeURIComponent(b.id) + '/terminals'));
      renderTills(b); renderAll();
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the till.'), 'err'); }
    K.busy(btn, false);
  });

  document.querySelectorAll('dialog [data-close]').forEach(function (x) { x.addEventListener('click', function () { var d = x.closest('dialog'); if (d && d.open) d.close(); }); });

  /* ---------- start ---------- */
  console.info('step-branches.js: loaded');
  load();
})();