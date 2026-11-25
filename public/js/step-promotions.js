/* Promotions: list (GET /promotions), edit (GET /promotions/:id), save (POST / PATCH), delete.
   The items picker searches the branch catalogue (GET /sync/catalog), the same list the till sells from.
   Pricing rules live in promo-engine.js, shared with the till and the server. */
(function () {
  'use strict';
  var K = window.KApp, P = window.KPromo; if (!K || !P) return;
  var $ = function (s) { return document.querySelector(s); };
  var S = { rows: [], filter: 'all', variants: [], loaded: false, editing: null, type: 'multi_buy', chosen: {} };

  /* ---------- status and wording ---------- */
  function status(p) {
    var now = Date.now();
    if (!p.is_active) return 'off';
    if (p.ends_at && new Date(p.ends_at).getTime() < now) return 'ended';
    if (p.starts_at && new Date(p.starts_at).getTime() > now) return 'scheduled';
    return 'live';
  }
  var STATUS = { live: ['Live', 'tag ok dot'], scheduled: ['Scheduled', 'tag info'], ended: ['Ended', 'tag'], off: ['Off', 'tag'] };
  function day(v) { return new Date(v).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }); }
  function when(p) {
    if (p.starts_at && p.ends_at) return day(p.starts_at) + ' to ' + day(p.ends_at);
    if (p.ends_at) return 'Until ' + day(p.ends_at);
    if (p.starts_at) return 'From ' + day(p.starts_at);
    return 'No end date';
  }
  function covers(p) {
    var names = p.sample_items || [], n = p.item_count || 0;
    if (!n) return 'No items';
    return names.slice(0, 2).join(', ') + (n > 2 ? ' and ' + (n - 2) + ' more' : '');
  }

  /* ---------- list ---------- */
  async function load() {
    var err = $('#listErr'); K.notice(err, '');
    var box = $('#list'); box.textContent = '';
    for (var i = 0; i < 4; i++) box.appendChild(K.el('div', undefined, 'sk-row'));
    try { S.rows = (await K.api('GET', '/promotions')) || []; render(); }
    catch (ex) { box.textContent = ''; K.notice(err, ex.status === 403 ? 'Your role does not include promotions. Ask the shop owner for access.' : ex.message, 'err'); }
  }
  function emptyState(filtered) {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon('seal-percent')); e.appendChild(ic);
    if (filtered) { e.appendChild(K.el('b', 'Nothing here')); e.appendChild(K.el('p', 'No promotions are ' + S.filter + ' right now.')); return e; }
    e.appendChild(K.el('b', 'No promotions yet'));
    e.appendChild(K.el('p', 'Start small: buy 2 get 1 on something slow, or a weekend discount on your best seller. The till applies it by itself.'));
    var b = K.el('button', 'New promotion', 'btn primary'); b.type = 'button'; b.addEventListener('click', function () { openForm(null); }); e.appendChild(b);
    return e;
  }
  function render() {
    var box = $('#list'); box.textContent = '';
    var rows = S.rows.filter(function (p) { return S.filter === 'all' || status(p) === S.filter; });
    if (!rows.length) { box.appendChild(emptyState(S.rows.length > 0)); return; }
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), hr = K.el('tr');
    ['Offer', 'On', 'When', 'Status'].forEach(function (h) { hr.appendChild(K.el('th', h)); });
    var th = K.el('thead'); th.appendChild(hr); tb.appendChild(th);
    var body = K.el('tbody');
    rows.forEach(function (p) {
      var r = K.el('tr', undefined, 'go'), c1 = K.el('td'), st = STATUS[status(p)];
      c1.appendChild(K.el('b', p.name)); var sm = K.el('small', P.describe(p, K.money), 'muted'); sm.style.display = 'block'; c1.appendChild(sm); r.appendChild(c1);
      r.appendChild(K.el('td', covers(p), p.item_count ? '' : 'muted'));
      r.appendChild(K.el('td', when(p), 'num nw'));
      var c4 = K.el('td'); c4.appendChild(K.el('span', st[0], st[1])); r.appendChild(c4);
      r.addEventListener('click', function () { openForm(p.id); });
      body.appendChild(r);
    });
    tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc); box.appendChild(card);
  }
  $('#pfilter').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.filter = b.dataset.f;
      $('#pfilter').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      render();
    });
  });

  /* ---------- the items picker ---------- */
  async function loadVariants() {
    if (S.loaded) return;
    try {
      var b = await K.branches(); if (!b[0]) return;
      var d = await K.api('GET', '/sync/catalog', undefined, { 'X-Branch-Id': b[0].id });
      S.variants = ((d && d.items) || []).filter(function (i) { return !i.removed; }).map(function (i) {
        return { id: i.variant_id, label: i.product_name + (i.variant_name && i.variant_name !== 'Default' ? ' - ' + i.variant_name : ''), price: Number(i.selling_price) || 0, weighed: Boolean(i.sold_by_weight) };
      });
      S.loaded = true;
    } catch (e) { $('#pFindNote').textContent = 'Your role cannot search products here, so items already on an offer stay as they are.'; }
  }
  function paintResults() {
    var q = $('#pFind').value.trim().toLowerCase(), ul = $('#pResults'); ul.textContent = '';
    if (!q) { ul.hidden = true; return; }
    var hits = S.variants.filter(function (v) { return !S.chosen[v.id] && v.label.toLowerCase().indexOf(q) > -1; }).slice(0, 8);
    ul.hidden = false;
    if (!hits.length) { var li0 = K.el('li'); li0.appendChild(K.el('span', 'No product matches "' + $('#pFind').value.trim() + '".', 'muted')); ul.appendChild(li0); return; }
    hits.forEach(function (v) {
      var li = K.el('li'), b = K.el('button'); b.type = 'button';
      b.appendChild(K.el('span', v.label, 'grow')); b.appendChild(K.el('span', K.money(v.price) + (v.weighed ? ' / unit' : ''), 'num muted'));
      b.addEventListener('click', function () { S.chosen[v.id] = v.label + (v.weighed ? ' (by weight)' : ''); $('#pFind').value = ''; paintResults(); paintChosen(); $('#pFind').focus(); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function paintChosen() {
    var box = $('#pChosen'); box.textContent = '';
    Object.keys(S.chosen).forEach(function (id) {
      var c = K.el('span', undefined, 'chipx'); c.appendChild(K.el('span', S.chosen[id]));
      var x = K.el('button'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + S.chosen[id]); x.appendChild(K.icon('x'));
      x.addEventListener('click', function () { delete S.chosen[id]; paintChosen(); paintPreview(); }); c.appendChild(x); box.appendChild(c);
    });
    paintPreview();
  }
  $('#pFind').addEventListener('input', paintResults);

  /* ---------- the form ---------- */
  function readOffer() {
    var o = { type: S.type };
    if (S.type === 'multi_buy') { o.buy_qty = $('#fBuy').value; o.get_qty = $('#fGet').value; o.limit_per_sale = $('#fLimit').value; }
    else if (S.type === 'bundle') { o.bundle_qty = $('#fBq').value; o.bundle_price = $('#fBp').value; }
    else if (S.type === 'percent') o.percent_off = $('#fPct').value;
    else o.amount_off = $('#fAmt').value;
    o.starts_at = $('#pStart').value ? new Date($('#pStart').value).toISOString() : null;
    o.ends_at = $('#pEnd').value ? new Date($('#pEnd').value).toISOString() : null;
    return o;
  }
  function paintPreview() {
    var o = readOffer(), why = P.problem(o), n = Object.keys(S.chosen).length, el = $('#pPreview');
    if (why) { el.textContent = why; el.className = 'offer-preview muted'; return; }
    el.className = 'offer-preview'; el.textContent = '';
    el.appendChild(K.el('b', P.describe(o, K.money)));
    el.appendChild(document.createTextNode(n ? ' on ' + n + (n === 1 ? ' item' : ' items') : ' on the items you choose below'));
  }
  function setType(t) {
    S.type = t;
    $('#pType').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === t)); });
    document.querySelectorAll('#pForm [data-for]').forEach(function (n) { n.hidden = n.dataset['for'] !== t; });
    paintPreview();
  }
  $('#pType').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { setType(b.dataset.t); }); });
  ['#fBuy', '#fGet', '#fLimit', '#fBq', '#fBp', '#fPct', '#fAmt', '#pStart', '#pEnd'].forEach(function (s) { $(s).addEventListener('input', paintPreview); });

  function localInput(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    var z = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes());
  }
  async function openForm(id) {
    K.notice($('#pErr'), ''); S.editing = id; S.chosen = {};
    $('#pForm').reset(); $('#pTitle').textContent = id ? 'Edit promotion' : 'New promotion'; $('#pDelete').hidden = !id;
    $('#pResults').hidden = true; paintChosen(); setType('multi_buy'); $('#pSheet').showModal();
    loadVariants();
    if (!id) { setTimeout(function () { $('#pName').focus(); }, 60); return; }
    try {
      var p = await K.api('GET', '/promotions/' + encodeURIComponent(id));
      $('#pName').value = p.name; setType(p.type); $('#pActive').checked = p.is_active !== false;
      $('#fBuy').value = p.buy_qty || 2; $('#fGet').value = p.get_qty || 1; $('#fLimit').value = p.limit_per_sale || '';
      $('#fBq').value = p.bundle_qty || 3; $('#fBp').value = p.bundle_price != null ? Number(p.bundle_price) : '';
      $('#fPct').value = p.percent_off != null ? Number(p.percent_off) : ''; $('#fAmt').value = p.amount_off != null ? Number(p.amount_off) : '';
      $('#pStart').value = localInput(p.starts_at); $('#pEnd').value = localInput(p.ends_at);
      (p.items || []).forEach(function (i) { S.chosen[i.variant_id] = i.product_name + (i.variant_name && i.variant_name !== 'Default' ? ' - ' + i.variant_name : ''); });
      paintChosen();
    } catch (ex) { K.notice($('#pErr'), ex.message, 'err'); }
  }
  $('#openNew').addEventListener('click', function () { openForm(null); });

  $('#pForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#pErr'), btn = $('#pSave'); K.notice(err, '');
    var name = $('#pName').value.trim(), o = readOffer(), ids = Object.keys(S.chosen);
    if (!name) return K.notice(err, 'Give the offer a name.', 'err');
    var why = P.problem(o); if (why) return K.notice(err, why, 'err');
    if (!ids.length) return K.notice(err, 'Add at least one item to this offer.', 'err');
    var body = Object.assign({ name: name, is_active: $('#pActive').checked, variant_ids: ids }, o);
    K.busy(btn, true, 'Saving...');
    try {
      if (S.editing) await K.api('PATCH', '/promotions/' + encodeURIComponent(S.editing), body); else await K.api('POST', '/promotions', body);
      $('#pSheet').close(); K.toast(name + ' saved'); load();
    } catch (ex) { K.notice(err, ex.message, 'err'); }
    K.busy(btn, false);
  });
  $('#pDelete').addEventListener('click', async function () {
    if (!S.editing || !window.confirm('Delete "' + $('#pName').value.trim() + '"? Receipts already printed keep its name.')) return;
    var btn = this; btn.disabled = true;
    try { await K.api('DELETE', '/promotions/' + encodeURIComponent(S.editing)); $('#pSheet').close(); K.toast('Promotion deleted'); load(); }
    catch (ex) { K.notice($('#pErr'), ex.message, 'err'); }
    btn.disabled = false;
  });

  load();
})();
