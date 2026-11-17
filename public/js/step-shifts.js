/* Shifts. Uses GET /shifts/current, POST /shifts/open, POST /shifts/:id/cash, POST /shifts/:id/close,
   GET /shifts (history) and GET /shifts/:id (details), plus GET /branches/:id/terminals for the optional till.
   Cashiers see their own shifts; managers (reports.view) see everyone's. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var el = K.el, esc = K.esc, money = K.money, num = K.num;
  var user = K.session.user || {};
  var S = { branches: [], branch: '', page: 1, pages: 1, status: '', rows: [], cur: null, curKnown: false, closeId: null, closeExpected: 0, cashType: 'pay_in' };

  var METHODS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', credit: 'Credit', voucher: 'Voucher', other: 'Other' };
  var MOVES = {
    pay_in: { label: 'Pay in', tag: 'ok', sign: '+', help: 'Money you put into the drawer, for example extra change from the safe.' },
    pay_out: { label: 'Pay out', tag: 'warn', sign: '-', help: 'Cash you took out of the drawer to pay for something, for example a delivery or supplies.' },
    drop: { label: 'Cash drop', tag: 'info', sign: '-', help: 'Cash you moved to the safe so the drawer does not hold too much.' }
  };

  function dt(v) { return v ? new Date(v).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'; }
  function tm(v) { return v ? new Date(v).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function hdr(id) { return id ? { 'X-Branch-Id': id } : {}; }
  function openDialog(d) { if (!d.open) d.showModal(); }
  function varTag(v) {
    v = num(v);
    if (Math.abs(v) < 0.005) return '<span class="tag ok dot">Balanced</span>';
    return v > 0 ? '<span class="tag warn dot">Over ' + esc(money(v)) + '</span>' : '<span class="tag bad dot">Short ' + esc(money(-v)) + '</span>';
  }
  function takings(summary) {
    var list = summary || [];
    if (!list.length) return '<li class="muted">No sales on this shift yet.</li>';
    return list.map(function (r) {
      return '<li><span>' + esc(METHODS[r.method] || r.method) + '<span class="sub">' + esc(r.count) + (Number(r.count) === 1 ? ' payment' : ' payments') + '</span></span><b class="num">' + esc(money(r.total)) + '</b></li>';
    }).join('');
  }
  function movements(list) {
    list = list || [];
    if (!list.length) return '<li class="muted">No cash moved in or out.</li>';
    return list.map(function (m) {
      var t = MOVES[m.movement_type] || { label: m.movement_type, tag: '', sign: '' };
      return '<li><span><span class="tag ' + t.tag + '">' + esc(t.label) + '</span><span class="sub">' + esc(m.reason || '') + (m.created_at ? ' &middot; ' + esc(tm(m.created_at)) : '') + '</span></span>' +
        '<b class="num ' + (t.sign === '+' ? 'pos' : 'neg') + '">' + t.sign + esc(money(m.amount)) + '</b></li>';
    }).join('');
  }

  /* ---------- the shift you have open now ---------- */
  function renderCurrent() {
    var box = $('#current'); box.textContent = '';
    if (!S.curKnown) return;
    var s = S.cur, card = el('div', undefined, 'card');
    if (!s) {
      card.innerHTML = '<div class="empty"><span class="ic lg gold"><i class="ph ph-clock"></i></span><b>You have no shift open</b><p>Open a shift before you sell, so the cash in your drawer is tracked from the start.</p><button class="btn primary" id="startShift" type="button"><i class="ph ph-play"></i>Open a shift</button></div>';
      box.appendChild(card);
      $('#startShift').addEventListener('click', openOpen);
      return;
    }
    var sum = s.summary || [], cash = 0, all = 0;
    sum.forEach(function (r) { all += num(r.total); if (r.method === 'cash') cash = num(r.total); });
    card.innerHTML =
      '<div class="shift-now">' +
        '<div class="top"><span class="ic lg"><i class="ph ph-clock"></i></span>' +
          '<div class="grow"><h2>Your shift is open</h2><p>Since ' + esc(dt(s.opened_at)) + '</p></div>' +
          '<div class="actions">' +
            '<button class="btn sm" type="button" data-cash="pay_in"><i class="ph ph-arrow-down-left"></i>Pay in</button>' +
            '<button class="btn sm" type="button" data-cash="pay_out"><i class="ph ph-arrow-up-right"></i>Pay out</button>' +
            '<button class="btn sm" type="button" data-cash="drop"><i class="ph ph-vault"></i>Cash drop</button>' +
            '<button class="btn primary" type="button" id="endShift"><i class="ph ph-lock-key"></i>Close shift</button>' +
          '</div></div>' +
        '<div class="kfacts">' +
          '<div class="kfact"><small>Opening float</small><b>' + esc(money(s.opening_float)) + '</b></div>' +
          '<div class="kfact"><small>Cash sales</small><b>' + esc(money(cash)) + '</b></div>' +
          '<div class="kfact"><small>All takings</small><b>' + esc(money(all)) + '</b></div>' +
          '<div class="kfact key"><small>Should be in the drawer</small><b>' + esc(money(s.expected_cash)) + '</b></div>' +
        '</div>' +
        '<div class="two">' +
          '<div><h3>Takings by method</h3><ul class="rows">' + takings(sum) + '</ul></div>' +
          '<div><h3>Cash in and out</h3><ul class="rows">' + movements(s.cash_movements) + '</ul></div>' +
        '</div>' +
      '</div>';
    box.appendChild(card);
    card.querySelectorAll('[data-cash]').forEach(function (b) { b.addEventListener('click', function () { openCash(b.dataset.cash); }); });
    $('#endShift').addEventListener('click', function () { openClose(s.id); });
  }
  async function loadCurrent() {
    try { S.cur = await K.api('GET', '/shifts/current'); S.curKnown = true; renderCurrent(); }
    catch (e) {
      S.cur = null; S.curKnown = false; renderCurrent();
      if (e.status && e.status !== 403 && e.message) { var box = $('#current'); var n = el('p', e.message, 'note err'); box.appendChild(n); }
    }
  }

  /* ---------- history ---------- */
  function renderList() {
    var wrap = $('#histWrap'), rows = S.rows;
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty"><span class="ic lg"><i class="ph ph-clock-counter-clockwise"></i></span><b>No shifts yet</b><p>' + (S.status ? 'Nothing matches this filter.' : 'Shifts show here once someone opens one on the till.') + '</p></div>';
    } else {
      wrap.innerHTML = '<table><thead><tr><th>Cashier</th><th>Till</th><th>Opened</th><th>Closed</th><th class="r">Float</th><th class="r">Expected</th><th class="r">Counted</th><th>Result</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var closed = r.status === 'closed';
          return '<tr class="go" tabindex="0" data-id="' + esc(r.id) + '"><td><b>' + esc(r.user_name || 'Cashier') + '</b></td><td>' + esc(r.terminal_name || '-') + '</td>' +
            '<td class="nw">' + esc(dt(r.opened_at)) + '</td>' +
            '<td class="nw">' + (closed ? esc(dt(r.closed_at)) : '<span class="tag ok dot">Open</span>') + '</td>' +
            '<td class="r num">' + esc(money(r.opening_float)) + '</td>' +
            '<td class="r num">' + (closed ? esc(money(r.expected_cash)) : '-') + '</td>' +
            '<td class="r num">' + (closed ? esc(money(r.counted_cash)) : '-') + '</td>' +
            '<td>' + (closed ? varTag(r.variance) : '-') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    $('#pager').hidden = S.pages <= 1;
    $('#pageInfo').textContent = 'Page ' + S.page + ' of ' + S.pages;
    $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.pages;
  }
  async function loadList() {
    var q = '?page=' + S.page + '&limit=15' + (S.status ? '&status=' + S.status : '') + (S.branch ? '&branch_id=' + encodeURIComponent(S.branch) : '');
    $('#histWrap').innerHTML = '<ul class="rows" style="padding:0 20px 20px"><li class="sk-row"></li><li class="sk-row"></li><li class="sk-row"></li></ul>';
    K.notice($('#listErr'), '');
    try {
      var j = await K.apiFull('GET', '/shifts' + q);
      S.rows = j.data || []; S.pages = (j.meta && j.meta.pages) || 1; renderList();
    } catch (e) {
      $('#histWrap').textContent = '';
      K.notice($('#listErr'), e.status === 403 ? 'Your role does not include shifts. Ask the shop owner for access.' : (e.message || 'We could not load shifts. Please try again.'), 'err');
      $('#pager').hidden = true;
    }
  }
  function reload() { return Promise.all([loadCurrent(), loadList()]); }

  $('#histWrap').addEventListener('click', function (e) { var tr = e.target.closest('tr[data-id]'); if (tr) openDetail(tr.dataset.id); });
  $('#histWrap').addEventListener('keydown', function (e) { if (e.key !== 'Enter') return; var tr = e.target.closest('tr[data-id]'); if (tr) openDetail(tr.dataset.id); });
  $('#prev').addEventListener('click', function () { if (S.page > 1) { S.page--; loadList(); } });
  $('#next').addEventListener('click', function () { if (S.page < S.pages) { S.page++; loadList(); } });
  $('#status').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-s]'); if (!b) return;
    S.status = b.dataset.s; S.page = 1;
    $('#status').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    loadList();
  });

  /* ---------- one shift ---------- */
  async function openDetail(id) {
    $('#dBody').innerHTML = '<ul class="rows"><li class="sk-row"></li><li class="sk-row"></li><li class="sk-row"></li></ul>';
    $('#dClose').hidden = true; $('#dClose').dataset.id = id; openDialog($('#detail'));
    try { renderDetail(await K.api('GET', '/shifts/' + encodeURIComponent(id))); }
    catch (e) { $('#dBody').innerHTML = '<p class="note err">' + esc(e.message || 'We could not load this shift.') + '</p>'; }
  }
  function renderDetail(d) {
    var row = S.rows.filter(function (r) { return r.id === d.id; })[0] || {};
    var mine = S.cur && S.cur.id === d.id;
    var who = row.user_name || (mine ? (user.full_name || user.name) : '') || 'Cashier';
    var closed = d.status === 'closed';
    $('#dTitle').textContent = who + (/s$/i.test(who) ? "' shift" : "'s shift");
    $('#dBody').innerHTML =
      '<div class="vline"><span class="tag ' + (closed ? '' : 'ok dot') + '">' + (closed ? 'Closed' : 'Open') + '</span>' + (closed ? varTag(d.variance) : '') + '</div>' +
      '<div class="facts">' +
        '<div class="fact"><small>Till</small><b>' + esc(row.terminal_name || '-') + '</b></div>' +
        '<div class="fact"><small>Opened</small><b>' + esc(dt(d.opened_at)) + '</b></div>' +
        '<div class="fact"><small>Closed</small><b>' + (closed ? esc(dt(d.closed_at)) : 'Still open') + '</b></div>' +
        '<div class="fact"><small>Opening float</small><b>' + esc(money(d.opening_float)) + '</b></div>' +
        '<div class="fact"><small>' + (closed ? 'Should have been in the drawer' : 'Should be in the drawer') + '</small><b>' + esc(money(d.expected_cash)) + '</b></div>' +
        '<div class="fact"><small>Cash counted</small><b>' + (closed ? esc(money(d.counted_cash)) : '-') + '</b></div>' +
      '</div>' +
      '<div class="blk"><h3>Takings by method</h3><ul class="rows">' + takings(d.summary) + '</ul></div>' +
      '<div class="blk"><h3>Cash in and out</h3><ul class="rows">' + movements(d.cash_movements) + '</ul></div>' +
      (d.notes ? '<div class="blk"><h3>Notes</h3><p class="note">' + esc(d.notes) + '</p></div>' : '');
    $('#dClose').hidden = closed || !K.can(user, 'pos.shift');
  }
  $('#dClose').addEventListener('click', function () { openClose($('#dClose').dataset.id); });

  /* ---------- open a shift ---------- */
  function branchForOpen() { return S.branches.length > 1 ? $('#oBranch').value : (S.branches[0] && S.branches[0].id) || ''; }
  async function loadTills() {
    var sel = $('#oTerm'), id = branchForOpen(); sel.textContent = '';
    var none = el('option', 'No particular till'); none.value = ''; sel.appendChild(none); $('#oTermF').hidden = true;
    if (!id) return;
    try {
      var list = await K.api('GET', '/branches/' + encodeURIComponent(id) + '/terminals');
      list = (Array.isArray(list) ? list : []).filter(function (t) { return t.is_active !== false; });
      list.forEach(function (t) { var o = el('option', t.name || 'Till'); o.value = t.id; sel.appendChild(o); });
      $('#oTermF').hidden = !list.length;
    } catch (e) { /* the till is optional */ }
  }
  function openOpen() {
    var sel = $('#oBranch'); sel.textContent = '';
    S.branches.forEach(function (b) { var o = el('option', b.name); o.value = b.id; sel.appendChild(o); });
    if (S.branch) sel.value = S.branch;
    $('#oBranchF').hidden = S.branches.length < 2;
    $('#oFloat').value = '0'; K.notice($('#oErr'), '');
    openDialog($('#openDlg')); loadTills(); $('#oFloat').select();
  }
  $('#oBranch').addEventListener('change', loadTills);
  $('#openForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#oErr'), btn = $('#oGo'), amount = $('#oFloat').value === '' ? 0 : Number($('#oFloat').value), branch = branchForOpen();
    K.notice(err, '');
    if (!branch) return K.notice(err, 'Your shop has no active branch to open a shift in.', 'err');
    if (!isFinite(amount) || amount < 0) return K.notice(err, 'The opening float must be 0 or more.', 'err');
    var body = { opening_float: amount }; if ($('#oTerm').value) body.terminal_id = $('#oTerm').value;
    btn.disabled = true;
    try {
      await K.api('POST', '/shifts/open', body, hdr(branch));
      $('#openDlg').close(); K.toast('Shift opened'); reload();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- cash in and out ---------- */
  function setType(t) {
    S.cashType = t;
    $('#cType').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === t)); });
    $('#cHelp').textContent = MOVES[t].help;
  }
  function openCash(t) {
    setType(t); $('#cAmt').value = ''; $('#cWhy').value = ''; K.notice($('#cErr'), '');
    openDialog($('#cashDlg')); $('#cAmt').focus();
  }
  $('#cType').addEventListener('click', function (e) { var b = e.target.closest('button[data-t]'); if (b) setType(b.dataset.t); });
  $('#cashForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#cErr'), btn = $('#cGo'), amount = Number($('#cAmt').value), why = $('#cWhy').value.trim();
    K.notice(err, '');
    if (!S.cur) return K.notice(err, 'You have no open shift.', 'err');
    if (!isFinite(amount) || amount <= 0) return K.notice(err, 'Enter an amount greater than 0.', 'err');
    if (!why) return K.notice(err, 'Say what the money was for.', 'err');
    btn.disabled = true;
    try {
      await K.api('POST', '/shifts/' + encodeURIComponent(S.cur.id) + '/cash', { movement_type: S.cashType, amount: amount, reason: why });
      $('#cashDlg').close(); K.toast(MOVES[S.cashType].label + ' saved'); loadCurrent();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- close a shift ---------- */
  function paintDiff() {
    var raw = $('#xCount').value, out = $('#xDiff');
    if (raw === '' || !isFinite(Number(raw))) { out.textContent = '-'; return; }
    var d = Math.round((Number(raw) - S.closeExpected) * 100) / 100;
    out.textContent = Math.abs(d) < 0.005 ? 'Balanced' : (d > 0 ? 'Over by ' : 'Short by ') + money(Math.abs(d));
  }
  async function openClose(id) {
    S.closeId = id; K.notice($('#xErr'), '');
    $('#xCount').value = ''; $('#xNotes').value = ''; $('#xExpected').textContent = '...'; $('#xDiff').textContent = '-';
    openDialog($('#closeDlg'));
    try {
      var d = await K.api('GET', '/shifts/' + encodeURIComponent(id));
      S.closeExpected = num(d.expected_cash); $('#xExpected').textContent = money(S.closeExpected); $('#xCount').focus();
    } catch (ex) { K.notice($('#xErr'), ex.message || 'We could not load this shift.', 'err'); }
  }
  $('#xCount').addEventListener('input', paintDiff);
  $('#closeForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#xErr'), btn = $('#xGo'), raw = $('#xCount').value, counted = Number(raw);
    K.notice(err, '');
    if (raw === '' || !isFinite(counted) || counted < 0) return K.notice(err, 'Enter the cash you counted (0 or more).', 'err');
    var body = { counted_cash: counted }, notes = $('#xNotes').value.trim(); if (notes) body.notes = notes;
    btn.disabled = true;
    try {
      var r = await K.api('POST', '/shifts/' + encodeURIComponent(S.closeId) + '/close', body);
      $('#closeDlg').close();
      var v = num(r && r.variance);
      K.toast(Math.abs(v) < 0.005 ? 'Shift closed. The cash balances.' : 'Shift closed. ' + (v > 0 ? 'Over by ' : 'Short by ') + money(Math.abs(v)));
      await reload(); openDetail(S.closeId);
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    btn.disabled = false;
  });

  /* ---------- start ---------- */
  async function initBranches() {
    try {
      var list = await K.branches(), allowed = user.branch_ids || [];
      if (!user.is_owner && !user.all_branches && allowed.length) list = list.filter(function (b) { return allowed.indexOf(b.id) > -1; });
      S.branches = list;
      if (list.length > 1) {
        var sel = $('#branch'), all = el('option', 'All branches'); all.value = ''; sel.appendChild(all);
        list.forEach(function (b) { var o = el('option', b.name); o.value = b.id; sel.appendChild(o); });
        sel.hidden = false;
        sel.addEventListener('change', function () { S.branch = sel.value; S.page = 1; loadList(); });
      }
    } catch (e) { /* history still loads for every branch you may see */ }
  }
  initBranches().then(reload);
})();