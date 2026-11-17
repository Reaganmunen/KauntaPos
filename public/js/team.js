/* Team: staff (/users), roles (/roles) and branches with their tills (/branches, /terminals).
   Staff: list, details, add/edit, reset password, set PIN, deactivate.
   Roles: list, add/edit/delete with a permission picker (GET /roles/permissions).
   Branches: list, add/edit, make main, and manage the tills of each branch. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('team.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }
  console.info('team.js: loaded');
  var $ = function (s) { return document.querySelector(s); };
  var LIMIT = 25;
  var S = {
    tab: 'staff', page: 1, pages: 1, q: '', view: 'active', roleFilter: '',
    users: [], roles: [], branches: [], catalog: null,
    cur: null, editing: null, editingRole: null, editingBranch: null, termBranch: null
  };

  /* ---------- helpers ---------- */
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function failText(ex, fallback) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || fallback; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function fact(label, value) { var f = K.el('div', undefined, 'fact'); f.appendChild(K.el('small', label)); f.appendChild(K.el('b', value)); return f; }
  function sectionTitle(t) { var h = K.el('b', t); h.style.display = 'block'; h.style.marginTop = '8px'; return h; }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join(''); }
  function permsOf(r) {
    var p = r && r.permissions;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = []; } }
    return Array.isArray(p) ? p : [];
  }
  function empty(icon, title, text) {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon(icon)); e.appendChild(ic);
    e.appendChild(K.el('b', title)); e.appendChild(K.el('p', text)); return e;
  }
  function tableCard(headers, rightCols) {
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    headers.forEach(function (h, i) { tr.appendChild(K.el('th', h, rightCols && rightCols.indexOf(i) >= 0 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th);
    var body = K.el('tbody'); tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc);
    return { card: card, body: body };
  }
  function iconButton(icon, label, fn) {
    var b = K.el('button', undefined, 'icon-btn sm'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    b.appendChild(K.icon(icon));
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }
  function closeDlg(sel) { var d = $(sel); if (d.open) d.close(); }

  /* ---------- reference data ---------- */
  async function loadRoles() {
    try { S.roles = rowsOf(await K.api('GET', '/roles')); } catch (ex) { S.roles = []; }
    var sel = $('#uRoleFilter'), keep = S.roleFilter;
    sel.textContent = ''; var all = K.el('option', 'All roles'); all.value = ''; sel.appendChild(all);
    S.roles.forEach(function (r) { var o = K.el('option', r.name || ''); o.value = r.id; sel.appendChild(o); });
    sel.value = keep;
  }
  async function loadBranches() {
    try { S.branches = rowsOf(await K.api('GET', '/branches')); } catch (ex) { S.branches = []; }
  }

  /* ---------- tabs ---------- */
  function setTab(t) {
    S.tab = t; S.page = 1;
    $('#tabs').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === t)); });
    $('#staffBar').hidden = t !== 'staff';
    $('#pager').hidden = true;
    $('#openAddLabel').textContent = t === 'staff' ? 'Add staff member' : t === 'roles' ? 'Add role' : 'Add branch';
    refresh();
  }
  function refresh(quiet) {
    if (S.tab === 'staff') return loadUsers(quiet);
    if (S.tab === 'roles') return loadRolesTab(quiet);
    return loadBranchesTab(quiet);
  }
  function skeleton() { var box = $('#list'); box.textContent = ''; for (var i = 0; i < 5; i++) box.appendChild(K.el('div', undefined, 'sk-row')); }

  /* =====================================================
     STAFF
     ===================================================== */
  function renderUsers() {
    var box = $('#list'); box.textContent = '';
    if (!S.users.length) {
      box.appendChild(S.q || S.roleFilter ? empty('users', 'No staff match', 'Try a different name, phone number or role.')
        : empty('users', S.view === 'inactive' ? 'No inactive staff' : 'No staff yet', S.view === 'inactive' ? 'Everyone is active.' : 'Add the people who work in your shop.'));
      $('#pager').hidden = true; return;
    }
    var t = tableCard(['Name', 'Role', 'Phone', 'Last sign-in', 'Status']);
    S.users.forEach(function (u) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'), who = K.el('div', undefined, 'tm-person'), av = K.el('span', undefined, 'tm-av');
      if (u.avatar_url) { var im = document.createElement('img'); im.src = u.avatar_url; im.alt = ''; av.appendChild(im); } else av.textContent = initials(u.full_name);
      who.appendChild(av);
      var nm = K.el('div'); nm.appendChild(K.el('b', u.full_name || '')); if (u.email) nm.appendChild(K.el('small', u.email)); who.appendChild(nm);
      c1.appendChild(who); row.appendChild(c1);
      var rc = K.el('td'); rc.appendChild(document.createTextNode(u.role_name || '')); if (u.is_owner) rc.appendChild(K.el('span', 'Owner', 'tag dot ok')); row.appendChild(rc);
      row.appendChild(K.el('td', u.phone || '', 'mono'));
      row.appendChild(K.el('td', u.last_login_at ? when(u.last_login_at) : 'Never', 'nw muted'));
      var st = K.el('td'); st.appendChild(u.is_active === false ? K.el('span', 'Inactive', 'tag dot') : K.el('span', 'Active', 'tag dot ok')); row.appendChild(st);
      row.addEventListener('click', function () { openDetail(u.id); });
      t.body.appendChild(row);
    });
    box.appendChild(t.card);
    $('#pager').hidden = S.pages <= 1; $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages; $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function loadUsers(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) skeleton();
    try {
      var qs = '?page=' + S.page + '&limit=' + LIMIT + (S.q ? '&q=' + encodeURIComponent(S.q) : '') +
        (S.roleFilter ? '&role_id=' + encodeURIComponent(S.roleFilter) : '') +
        (S.view === 'active' ? '&is_active=true' : S.view === 'inactive' ? '&is_active=false' : '');
      var res = await K.apiFull('GET', '/users' + qs);
      S.users = rowsOf(res.data); S.pages = (res.meta && res.meta.pages) || 1;
      renderUsers();
    } catch (ex) { $('#list').textContent = ''; $('#pager').hidden = true; K.notice(err, failText(ex, 'We could not load your staff.'), 'err'); }
  }

  /* ---- details ---- */
  function branchNames(u) {
    if (u.all_branches) return 'Every branch';
    var ids = u.branch_ids || [];
    var names = ids.map(function (id) { var b = S.branches.filter(function (x) { return x.id === id; })[0]; return b ? b.name : null; }).filter(Boolean);
    return names.length ? names.join(', ') : 'None assigned';
  }
  function paintDetail() {
    var u = S.cur, body = $('#dBody'); body.textContent = ''; $('#dTitle').textContent = u.full_name || 'Staff member';
    var facts = K.el('div', undefined, 'facts');
    facts.appendChild(fact('Role', (u.role_name || 'No role') + (u.is_owner ? ' (owner)' : '')));
    facts.appendChild(fact('Status', u.is_active === false ? 'Inactive' : 'Active'));
    if (u.email) facts.appendChild(fact('Email', u.email));
    if (u.phone) facts.appendChild(fact('Phone', u.phone));
    facts.appendChild(fact('Branches', branchNames(u)));
    facts.appendChild(fact('Last sign-in', u.last_login_at ? when(u.last_login_at) : 'Never'));
    body.appendChild(facts);
    $('#dOff').hidden = u.is_owner || u.is_active === false;
  }
  async function openDetail(id) {
    var d = $('#detail'), body = $('#dBody'); S.cur = null; body.textContent = ''; $('#dTitle').textContent = 'Staff member';
    body.appendChild(K.el('div', undefined, 'sk-row')); body.appendChild(K.el('div', undefined, 'sk-row'));
    if (!d.open) d.showModal();
    try { S.cur = await K.api('GET', '/users/' + encodeURIComponent(id)); }
    catch (ex) { body.textContent = ''; body.appendChild(K.el('p', failText(ex, 'We could not load this person.'), 'note err')); return; }
    paintDetail();
  }

  /* ---- add / edit ---- */
  function paintRoleOptions(selected) {
    var sel = $('#fRole'); sel.textContent = '';
    var ph = K.el('option', 'Choose a role'); ph.value = ''; sel.appendChild(ph);
    S.roles.forEach(function (r) { var o = K.el('option', r.name || ''); o.value = r.id; sel.appendChild(o); });
    sel.value = selected || '';
  }
  function paintBranchChecks(ids) {
    var box = $('#fBranches'); box.textContent = '';
    if (!S.branches.length) { box.appendChild(K.el('small', 'No branches yet.', 'muted')); return; }
    S.branches.forEach(function (b) {
      var l = K.el('label'), c = document.createElement('input'); c.type = 'checkbox'; c.value = b.id; c.checked = ids.indexOf(b.id) >= 0;
      l.appendChild(c); l.appendChild(K.el('span', b.name || '')); box.appendChild(l);
    });
  }
  function syncAllBranches() { $('#fBranches').classList.toggle('off', $('#fAll').checked); }
  function openForm(u) {
    S.editing = u || null; K.notice($('#fErr'), '');
    $('#fTitle').textContent = u ? 'Edit staff member' : 'Add a staff member';
    $('#fName').value = u ? u.full_name || '' : ''; $('#fPhone').value = u ? u.phone || '' : ''; $('#fEmail').value = u ? u.email || '' : '';
    paintRoleOptions(u ? u.role_id : '');
    $('#fRole').disabled = !!(u && u.is_owner);
    $('#fRoleHint').textContent = u && u.is_owner ? 'The owner role cannot be changed.' : '';
    $('#fPassword').value = ''; $('#fPinNew').value = '';
    $('#fSecrets').hidden = !!u;
    $('#fAll').checked = u ? !!u.all_branches : false;
    paintBranchChecks(u ? u.branch_ids || [] : []); syncAllBranches();
    $('#fActive').checked = u ? u.is_active !== false : true;
    $('#fActiveBox').hidden = !u || !!u.is_owner;
    if ($('#detail').open) $('#detail').close();
    $('#formSheet').showModal(); setTimeout(function () { $('#fName').focus(); }, 60);
  }
  $('#fAll').addEventListener('change', syncAllBranches);
  $('#userForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#fErr'), btn = $('#fSave'); K.notice(err, '');
    var name = $('#fName').value.trim(); if (!name) return K.notice(err, 'Enter the staff member\'s name.', 'err');
    var email = blank($('#fEmail').value), phone = blank($('#fPhone').value);
    if (!email && !phone) return K.notice(err, 'Enter an email or a phone number.', 'err');
    var role = $('#fRole').value; if (!role) return K.notice(err, 'Choose a role.', 'err');
    var branchIds = Array.prototype.map.call($('#fBranches').querySelectorAll('input:checked'), function (c) { return c.value; });
    var all = $('#fAll').checked;
    var body = { full_name: name, email: email, phone: phone, role_id: role, all_branches: all, branch_ids: all ? [] : branchIds };
    if (S.editing) {
      if (S.editing.is_owner) delete body.role_id;
      else body.is_active = $('#fActive').checked;
    } else {
      var pw = $('#fPassword').value; if (pw.length < 8) return K.notice(err, 'The password must be at least 8 characters.', 'err');
      body.password = pw;
      var pin = $('#fPinNew').value.trim();
      if (pin) { if (!/^\d{4,8}$/.test(pin)) return K.notice(err, 'The PIN must be 4 to 8 digits.', 'err'); body.pin = pin; }
    }
    K.busy(btn, true, 'Saving...');
    try {
      var saved = S.editing ? await K.api('PATCH', '/users/' + encodeURIComponent(S.editing.id), body) : await K.api('POST', '/users', body);
      $('#formSheet').close(); K.toast('Staff member saved'); S.page = 1; await loadUsers(true);
      if (saved && saved.id) openDetail(saved.id);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save this staff member.'), 'err'); }
    K.busy(btn, false);
  });

  /* ---- reset password / PIN / deactivate ---- */
  $('#dEdit').addEventListener('click', function () { if (S.cur) openForm(S.cur); });
  $('#dPw').addEventListener('click', function () {
    if (!S.cur) return; K.notice($('#pwErr'), ''); $('#pwNew').value = '';
    $('#pwInfo').textContent = 'Set a new password for ' + (S.cur.full_name || 'this person') + '.';
    $('#pwDlg').showModal(); setTimeout(function () { $('#pwNew').focus(); }, 60);
  });
  $('#pwForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#pwErr'), btn = $('#pwGo'); K.notice(err, '');
    var pw = $('#pwNew').value; if (pw.length < 8) return K.notice(err, 'The password must be at least 8 characters.', 'err');
    K.busy(btn, true, 'Saving...');
    try { await K.api('POST', '/users/' + encodeURIComponent(S.cur.id) + '/reset-password', { password: pw }); $('#pwDlg').close(); K.toast('Password reset'); }
    catch (ex) { K.notice(err, failText(ex, 'We could not reset the password.'), 'err'); }
    K.busy(btn, false);
  });
  $('#dPin').addEventListener('click', function () {
    if (!S.cur) return; K.notice($('#pnErr'), ''); $('#pnNew').value = '';
    $('#pnInfo').textContent = 'Set the till PIN for ' + (S.cur.full_name || 'this person') + '.';
    $('#pinDlg').showModal(); setTimeout(function () { $('#pnNew').focus(); }, 60);
  });
  $('#pinForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#pnErr'), btn = $('#pnGo'); K.notice(err, '');
    var pin = $('#pnNew').value.trim(); if (!/^\d{4,8}$/.test(pin)) return K.notice(err, 'The PIN must be 4 to 8 digits.', 'err');
    K.busy(btn, true, 'Saving...');
    try { await K.api('PUT', '/users/' + encodeURIComponent(S.cur.id) + '/pin', { pin: pin }); $('#pinDlg').close(); K.toast('PIN updated'); }
    catch (ex) { K.notice(err, failText(ex, 'We could not save the PIN.'), 'err'); }
    K.busy(btn, false);
  });
  $('#dOff').addEventListener('click', async function () {
    var u = S.cur; if (!u) return;
    if (!window.confirm('Deactivate ' + (u.full_name || 'this person') + '? They will be signed out everywhere and can no longer sign in.')) return;
    var btn = this; K.busy(btn, true, 'Working...');
    try { await K.api('POST', '/users/' + encodeURIComponent(u.id) + '/deactivate'); K.toast('Staff member deactivated'); await openDetail(u.id); await loadUsers(true); }
    catch (ex) { K.toast(failText(ex, 'We could not deactivate this person.')); }
    K.busy(btn, false);
  });

  /* =====================================================
     ROLES
     ===================================================== */
  function renderRoles() {
    var box = $('#list'); box.textContent = '';
    if (!S.roles.length) { box.appendChild(empty('shield-check', 'No roles yet', 'Add roles such as Manager or Cashier, then give them to your staff.')); return; }
    var t = tableCard(['Role', 'Description', 'Permissions', '']);
    S.roles.forEach(function (r) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', r.name || '')); row.appendChild(c1);
      row.appendChild(K.el('td', r.description || '', 'muted'));
      var n = permsOf(r).length; row.appendChild(K.el('td', n ? n + (n === 1 ? ' permission' : ' permissions') : 'None', 'muted'));
      var a = K.el('td'), wrap = K.el('div', undefined, 'tm-actions'); wrap.appendChild(iconButton('pencil-simple', 'Edit role', function () { openRoleForm(r.id); })); a.appendChild(wrap); row.appendChild(a);
      row.addEventListener('click', function () { openRoleForm(r.id); });
      t.body.appendChild(row);
    });
    box.appendChild(t.card);
  }
  async function loadRolesTab(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) skeleton();
    try { S.roles = rowsOf(await K.api('GET', '/roles')); renderRoles(); await loadRoles(); }
    catch (ex) { $('#list').textContent = ''; K.notice(err, failText(ex, 'We could not load the roles.'), 'err'); }
  }

  // The catalog may come as ["a.b", ...], [{key,label,group}], or {group: [...]}
  function normalizeCatalog(c) {
    var groups = {}, order = [];
    function add(g, key, label) { g = g || 'General'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push({ key: key, label: label || key }); }
    if (Array.isArray(c)) {
      c.forEach(function (p) {
        if (typeof p === 'string') add(p.split('.')[0], p, p);
        else if (p) add(p.group || String(p.key || p.code || p.name || '').split('.')[0], p.key || p.code || p.name, p.label || p.description || p.key || p.name);
      });
    } else if (c && typeof c === 'object') {
      Object.keys(c).forEach(function (g) {
        var items = c[g]; if (!Array.isArray(items)) return;
        items.forEach(function (p) { if (typeof p === 'string') add(g, p, p); else if (p) add(g, p.key || p.code || p.name, p.label || p.description || p.key || p.name); });
      });
    }
    return order.map(function (g) { return { name: g, items: groups[g] }; });
  }
  async function ensureCatalog() {
    if (S.catalog) return;
    var raw = await K.api('GET', '/roles/permissions');
    if (raw && !Array.isArray(raw) && (raw.permissions || raw.catalog)) raw = raw.permissions || raw.catalog;
    S.catalog = normalizeCatalog(raw);
  }
  function paintPerms(selected) {
    var box = $('#rPerms'); box.textContent = '';
    if (!S.catalog || !S.catalog.length) { box.appendChild(K.el('p', 'No permissions are available to choose from.', 'muted')); return; }
    S.catalog.forEach(function (g) {
      var grp = K.el('div', undefined, 'tm-group'); grp.appendChild(K.el('b', g.name.replace(/[_-]/g, ' ')));
      var list = K.el('div', undefined, 'tm-checks');
      g.items.forEach(function (p) {
        var l = K.el('label'), c = document.createElement('input'); c.type = 'checkbox'; c.value = p.key; c.checked = selected.indexOf(p.key) >= 0;
        l.appendChild(c); l.appendChild(K.el('span', p.label)); list.appendChild(l);
      });
      grp.appendChild(list); box.appendChild(grp);
    });
  }
  async function openRoleForm(id) {
    S.editingRole = null; K.notice($('#rErr'), '');
    $('#rTitle').textContent = id ? 'Edit role' : 'Add a role'; $('#rName').value = ''; $('#rDesc').value = ''; $('#rDelete').hidden = !id;
    $('#rPerms').textContent = ''; $('#rPerms').appendChild(K.el('div', undefined, 'sk-row'));
    $('#roleSheet').showModal();
    try {
      await ensureCatalog();
      var role = null;
      if (id) { role = await K.api('GET', '/roles/' + encodeURIComponent(id)); S.editingRole = role; }
      $('#rName').value = role ? role.name || '' : ''; $('#rDesc').value = role ? role.description || '' : '';
      paintPerms(role ? permsOf(role) : []);
      if (role && role.name === 'Owner') $('#rDelete').hidden = true;
      setTimeout(function () { $('#rName').focus(); }, 60);
    } catch (ex) { $('#rPerms').textContent = ''; K.notice($('#rErr'), failText(ex, 'We could not load this role.'), 'err'); }
  }
  $('#roleForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#rErr'), btn = $('#rSave'); K.notice(err, '');
    var name = $('#rName').value.trim(); if (!name) return K.notice(err, 'Enter a name for the role.', 'err');
    var perms = Array.prototype.map.call($('#rPerms').querySelectorAll('input:checked'), function (c) { return c.value; });
    var body = { name: name, description: blank($('#rDesc').value), permissions: perms };
    K.busy(btn, true, 'Saving...');
    try {
      if (S.editingRole) await K.api('PATCH', '/roles/' + encodeURIComponent(S.editingRole.id), body); else await K.api('POST', '/roles', body);
      $('#roleSheet').close(); K.toast('Role saved'); await loadRolesTab(true);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the role.'), 'err'); }
    K.busy(btn, false);
  });
  $('#rDelete').addEventListener('click', async function () {
    var r = S.editingRole; if (!r) return;
    if (!window.confirm('Delete the role "' + (r.name || '') + '"? This only works if no staff member has it.')) return;
    var btn = this; K.busy(btn, true, 'Deleting...');
    try { await K.api('DELETE', '/roles/' + encodeURIComponent(r.id)); $('#roleSheet').close(); K.toast('Role deleted'); await loadRolesTab(true); }
    catch (ex) { K.notice($('#rErr'), failText(ex, 'We could not delete the role.'), 'err'); }
    K.busy(btn, false);
  });

  /* =====================================================
     BRANCHES + TERMINALS
     ===================================================== */
  function renderBranches() {
    var box = $('#list'); box.textContent = '';
    if (!S.branches.length) { box.appendChild(empty('storefront', 'No branches yet', 'Add your shop or each place you sell from.')); return; }
    var t = tableCard(['Branch', 'Phone', 'Address', 'Status', '']);
    S.branches.forEach(function (b) {
      var row = K.el('tr', undefined, 'go'), c1 = K.el('td'); c1.appendChild(K.el('b', b.name || ''));
      if (b.is_main) c1.appendChild(K.el('span', 'Main', 'tag dot ok'));
      row.appendChild(c1);
      row.appendChild(K.el('td', b.phone || '', 'mono'));
      row.appendChild(K.el('td', b.address || '', 'muted'));
      var st = K.el('td'); st.appendChild(b.is_active === false ? K.el('span', 'Inactive', 'tag dot') : K.el('span', 'Active', 'tag dot ok')); row.appendChild(st);
      var a = K.el('td'), wrap = K.el('div', undefined, 'tm-actions');
      wrap.appendChild(iconButton('cash-register', 'Tills', function () { openTerminals(b); }));
      if (!b.is_main) wrap.appendChild(iconButton('star', 'Make main branch', function () { makeMain(b); }));
      wrap.appendChild(iconButton('pencil-simple', 'Edit branch', function () { openBranchForm(b); }));
      a.appendChild(wrap); row.appendChild(a);
      row.addEventListener('click', function () { openBranchForm(b); });
      t.body.appendChild(row);
    });
    box.appendChild(t.card);
  }
  async function loadBranchesTab(quiet) {
    var err = $('#listErr'); K.notice(err, '');
    if (!quiet) skeleton();
    try { S.branches = rowsOf(await K.api('GET', '/branches')); renderBranches(); }
    catch (ex) { $('#list').textContent = ''; K.notice(err, failText(ex, 'We could not load the branches.'), 'err'); }
  }
  function openBranchForm(b) {
    S.editingBranch = b || null; K.notice($('#bErr'), '');
    $('#bTitle').textContent = b ? 'Edit branch' : 'Add a branch';
    $('#bName').value = b ? b.name || '' : ''; $('#bPhone').value = b ? b.phone || '' : ''; $('#bCode').value = b ? b.code || '' : ''; $('#bAddress').value = b ? b.address || '' : '';
    $('#bActive').checked = b ? b.is_active !== false : true; $('#bActiveBox').hidden = !b || !!b.is_main;
    $('#branchSheet').showModal(); setTimeout(function () { $('#bName').focus(); }, 60);
  }
  $('#branchForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#bErr'), btn = $('#bSave'); K.notice(err, '');
    var name = $('#bName').value.trim(); if (!name) return K.notice(err, 'Enter the branch name.', 'err');
    var body = { name: name, phone: blank($('#bPhone').value), code: blank($('#bCode').value), address: blank($('#bAddress').value) };
    if (S.editingBranch && !S.editingBranch.is_main) body.is_active = $('#bActive').checked;
    K.busy(btn, true, 'Saving...');
    try {
      if (S.editingBranch) await K.api('PATCH', '/branches/' + encodeURIComponent(S.editingBranch.id), body); else await K.api('POST', '/branches', body);
      $('#branchSheet').close(); K.toast('Branch saved'); await loadBranchesTab(true);
    } catch (ex) { K.notice(err, failText(ex, 'We could not save the branch.'), 'err'); }
    K.busy(btn, false);
  });
  async function makeMain(b) {
    if (!window.confirm('Make ' + (b.name || 'this branch') + ' your main branch?')) return;
    try { await K.api('POST', '/branches/' + encodeURIComponent(b.id) + '/main'); K.toast('Main branch updated'); await loadBranchesTab(true); }
    catch (ex) { K.notice($('#listErr'), failText(ex, 'We could not change the main branch.'), 'err'); }
  }

  /* ---- terminals ---- */
  function paintTerminals(list) {
    var box = $('#tList'); box.textContent = '';
    if (!list.length) { box.appendChild(K.el('p', 'No tills at this branch yet.', 'muted')); return; }
    list.forEach(function (t) {
      var row = K.el('div', undefined, 'tm-term'), info = K.el('div', undefined, 'grow');
      info.appendChild(K.el('b', t.name || 'Till'));
      info.appendChild(K.el('small', t.last_seen_at ? 'Last seen ' + when(t.last_seen_at) : 'Not used yet'));
      row.appendChild(info);
      row.appendChild(t.is_active === false ? K.el('span', 'Inactive', 'tag dot') : K.el('span', 'Active', 'tag dot ok'));
      row.appendChild(iconButton('pencil-simple', 'Rename till', function () { renameTerminal(t); }));
      row.appendChild(iconButton(t.is_active === false ? 'play' : 'pause', t.is_active === false ? 'Switch on' : 'Switch off', function () { toggleTerminal(t); }));
      box.appendChild(row);
    });
  }
  async function loadTerminals() {
    var box = $('#tList'); box.textContent = ''; box.appendChild(K.el('div', undefined, 'sk-row'));
    try { paintTerminals(rowsOf(await K.api('GET', '/branches/' + encodeURIComponent(S.termBranch.id) + '/terminals'))); }
    catch (ex) { box.textContent = ''; K.notice($('#tErr'), failText(ex, 'We could not load the tills.'), 'err'); }
  }
  function openTerminals(b) {
    S.termBranch = b; K.notice($('#tErr'), ''); $('#tName').value = '';
    $('#tTitle').textContent = 'Tills at ' + (b.name || 'this branch');
    $('#termSheet').showModal(); loadTerminals();
  }
  $('#termForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var err = $('#tErr'), btn = $('#tAdd'); K.notice(err, '');
    var name = $('#tName').value.trim(); if (!name) return K.notice(err, 'Enter a name for the till.', 'err');
    K.busy(btn, true, 'Adding...');
    try { await K.api('POST', '/branches/' + encodeURIComponent(S.termBranch.id) + '/terminals', { name: name }); $('#tName').value = ''; K.toast('Till added'); await loadTerminals(); }
    catch (ex) { K.notice(err, failText(ex, 'We could not add the till.'), 'err'); }
    K.busy(btn, false);
  });
  async function renameTerminal(t) {
    var name = window.prompt('Till name', t.name || ''); if (name === null) return;
    name = name.trim(); if (!name) return K.notice($('#tErr'), 'The till name cannot be empty.', 'err');
    try { await K.api('PATCH', '/terminals/' + encodeURIComponent(t.id), { name: name }); K.notice($('#tErr'), ''); await loadTerminals(); }
    catch (ex) { K.notice($('#tErr'), failText(ex, 'We could not rename the till.'), 'err'); }
  }
  async function toggleTerminal(t) {
    try { await K.api('PATCH', '/terminals/' + encodeURIComponent(t.id), { is_active: t.is_active === false }); K.notice($('#tErr'), ''); await loadTerminals(); }
    catch (ex) { K.notice($('#tErr'), failText(ex, 'We could not update the till.'), 'err'); }
  }

  /* ---------- controls ---------- */
  $('#openAdd').addEventListener('click', function () {
    if (S.tab === 'staff') openForm(null); else if (S.tab === 'roles') openRoleForm(null); else openBranchForm(null);
  });
  $('#tabs').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { if (S.tab !== b.dataset.t) setTab(b.dataset.t); }); });
  var t = null;
  $('#uq').addEventListener('input', function () { clearTimeout(t); var v = this.value.trim(); t = setTimeout(function () { S.q = v; S.page = 1; loadUsers(); }, 260); });
  $('#uRoleFilter').addEventListener('change', function () { S.roleFilter = this.value; S.page = 1; loadUsers(); });
  $('#uview').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { S.view = b.dataset.v; S.page = 1; $('#uview').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); loadUsers(); });
  });
  $('#prev').addEventListener('click', function () { S.page--; loadUsers(); window.scrollTo({ top: 0 }); });
  $('#next').addEventListener('click', function () { S.page++; loadUsers(); window.scrollTo({ top: 0 }); });
  $('#refresh').addEventListener('click', function () { refresh(); });
  document.querySelectorAll('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { var d = b.closest('dialog'); if (d && d.open) d.close(); }); });

  /* ---------- start ---------- */
  Promise.all([loadRoles(), loadBranches()]).then(function () { loadUsers(); });
})();