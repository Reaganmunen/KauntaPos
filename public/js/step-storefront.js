/* Online store: settings (GET/PUT /storefront/settings, POST /storefront/publish and /unpublish),
   delivery areas (/storefront/delivery-zones), banners (/storefront/banners) and pages (/storefront/pages).
   Publishing needs a fulfilment branch and M-Pesa set up first; the server's message is shown if not.
   This page also stops you publishing delivery with no delivery areas, because checkout would then
   deliver anywhere for free. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('step-storefront.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }
  var $ = function (s) { return document.querySelector(s); };
  var S = { live: false, settings: {}, zones: [], banners: [], pages: [], loaded: {}, edit: {} };
  if (!window.KDrop) { console.error('step-storefront.js: window.KDrop is missing. js/dropzone.js did not load.'); return; }
  // Picture uploads. The hidden inputs #sLogo and #bnImage hold the saved picture address, so the rest of this file reads them as before.
  var DZ = {
    logo: KDrop.mount($('#dzLogo'), { kind: 'logo', input: $('#sLogo'), onChange: function () { preview(); } }),
    banner: KDrop.mount($('#dzBanner'), { kind: 'banner', input: $('#bnImage') })
  };

  /* ---------- helpers ---------- */
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function blank(v) { v = (v || '').trim(); return v === '' ? null : v; }
  function failText(ex, fb) { return ex && ex.status === 403 ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.code === 'feature_disabled' ? 'The online store is not switched on for your shop.' : (ex && ex.message) || fb); }
  function when(d) { return d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function localInput(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; function p(n) { return ('0' + n).slice(-2); } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function isoFrom(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function emptyBox(icon, title, text) {
    var e = K.el('div', undefined, 'empty card'), ic = K.el('span', undefined, 'ic lg'); ic.appendChild(K.icon(icon)); e.appendChild(ic); e.appendChild(K.el('b', title)); e.appendChild(K.el('p', text)); return e;
  }
  function tableOf(headers, rightCols) {
    var card = K.el('div', undefined, 'card flush'), sc = K.el('div', undefined, 'scroll'), tb = K.el('table'), tr = K.el('tr');
    headers.forEach(function (h, i) { tr.appendChild(K.el('th', h, rightCols && rightCols.indexOf(i) >= 0 ? 'r' : '')); });
    var th = K.el('thead'); th.appendChild(tr); tb.appendChild(th); var body = K.el('tbody'); tb.appendChild(body); sc.appendChild(tb); card.appendChild(sc);
    return { card: card, body: body };
  }
  function statusTag(text, kind) { return K.el('span', text, 'tag dot' + (kind ? ' ' + kind : '')); }
  function activeZones() { return S.zones.filter(function (z) { return z.is_active !== false; }); }

  /* ---------- tabs ---------- */
  function setTab(t) {
    $('#tabs').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === t)); });
    ['settings', 'zones', 'banners', 'pages'].forEach(function (k) { $('#tab-' + k).hidden = k !== t; });
    if (t !== 'settings' && !S.loaded[t]) loadList(t);
  }
  $('#tabs').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.t); }); });

  /* ---------- settings ---------- */
  function paint(s, branches) {
    s = s || {}; S.settings = s;
    $('#sName').value = s.store_name || (K.session && K.session.tenant && K.session.tenant.name) || ''; $('#sTag').value = s.tagline || ''; DZ.logo.set(s.logo_url);
    $('#sPhone').value = s.contact_phone || ''; $('#sWa').value = s.whatsapp_number || ''; $('#sAddr').value = s.address || ''; $('#sAnn').value = s.announcement || '';
    $('#sMin').value = s.min_order_amount && num(s.min_order_amount) > 0 ? s.min_order_amount : '';
    $('#sDel').checked = s.enable_delivery !== false; $('#sPick').checked = s.enable_pickup !== false;
    var sel = $('#sBranch'); sel.textContent = '';
    branches.forEach(function (b) { var o = K.el('option', b.name); o.value = b.id; sel.appendChild(o); });
    sel.value = s.fulfilment_branch_id || (branches[0] && branches[0].id) || '';
    S.live = Boolean(s.is_published); $('#sUnpub').hidden = !S.live; $('#sPub').hidden = S.live;
    var lt = $('#liveTag'); lt.textContent = S.live ? 'Live' : 'Offline'; lt.className = 'tag dot ' + (S.live ? 'ok' : 'warn'); preview(); checklist();
    var lv = $('#sLive'); lv.hidden = !S.live; lv.textContent = '';
    if (S.live) {
      var slug = K.session && K.session.tenant && K.session.tenant.slug, a = K.el('a', 'Open your store');
      a.href = 'store.html?shop=' + encodeURIComponent(slug || ''); a.target = '_blank'; a.rel = 'noopener'; a.className = 'link';
      lv.appendChild(document.createTextNode('Your store is live. ')); lv.appendChild(a);
    }
  }
  function preview() {
    var name = $('#sName').value.trim() || 'Your store';
    $('#pvName').textContent = name; $('#pvTag').textContent = $('#sTag').value.trim() || 'Your tagline shows here';
    var ann = $('#sAnn').value.trim(); $('#pvAnn').hidden = !ann; $('#pvAnn').textContent = ann;
    K.avatar($('#pvLogo'), $('#sLogo').value.trim() || null, name);
    var foot = $('#pvFoot'); foot.textContent = '';
    [$('#sAddr').value.trim(), $('#sPhone').value.trim() && 'Call ' + $('#sPhone').value.trim(), $('#sWa').value.trim() && 'WhatsApp ' + $('#sWa').value.trim(), $('#sDel').checked && 'Delivery', $('#sPick').checked && 'Pickup'].filter(Boolean).forEach(function (t) { foot.appendChild(K.el('span', t)); });
  }
  ['#sName', '#sTag', '#sPhone', '#sWa', '#sAddr', '#sAnn'].forEach(function (id) { $(id).addEventListener('input', preview); });
  ['#sDel', '#sPick'].forEach(function (id) { $(id).addEventListener('change', function () { preview(); checklist(); }); });
  ['#sPhone', '#sWa'].forEach(function (id) { $(id).addEventListener('input', checklist); });
  $('#sBranch').addEventListener('change', checklist);

  // What is still missing before the store can go live. M-Pesa is checked by the server when you publish.
  function checklist() {
    var items = [], del = $('#sDel').checked, pick = $('#sPick').checked;
    items.push({ ok: Boolean($('#sBranch').value), text: 'Choose the branch that fulfils orders', help: 'Online orders take stock from this branch.' });
    items.push({ ok: del || pick, text: 'Offer delivery, pickup or both' });
    if (del) items.push({ ok: !S.loaded.zones || activeZones().length > 0, text: 'Add at least one delivery area', help: 'Without one, delivery would be free to any address. Open the Delivery areas tab.', pending: !S.loaded.zones });
    items.push({ ok: Boolean($('#sPhone').value.trim() || $('#sWa').value.trim()), text: 'Add a phone or WhatsApp number', help: 'So customers can reach you about their order.' });
    items.push({ ok: true, text: 'M-Pesa is set up', help: 'Checked when you publish. If it is missing you will be told.', soft: true });
    var opt = [];
    if (S.loaded.banners) opt.push({ ok: S.banners.some(function (b) { return b.is_active !== false; }), text: 'Add a banner', help: 'Optional, but it makes the top of your store look alive.' });
    if (S.loaded.pages) opt.push({ ok: S.pages.some(function (p) { return p.is_published !== false; }), text: 'Add an About or Delivery info page', help: 'Optional.' });
    var ul = $('#checkList'); ul.textContent = '';
    var missing = items.filter(function (i) { return !i.ok; }).length;
    items.concat(opt).forEach(function (i, n) {
      var optional = n >= items.length, li = K.el('li', undefined, i.ok ? 'ok' : (optional ? '' : 'bad')), mk = K.el('span', i.ok ? '✓' : '', 'mk'), t = K.el('div'), b = K.el('b', i.text);
      if (optional) b.appendChild(K.el('span', 'Optional', 'opt'));
      t.appendChild(b); if (!i.ok && i.help) t.appendChild(K.el('small', i.help)); li.appendChild(mk); li.appendChild(t); ul.appendChild(li);
    });
    $('#checkSub').textContent = S.live ? 'Your store is live.' : missing ? missing + (missing === 1 ? ' thing needs' : ' things need') + ' doing before you can publish.' : 'You are ready to publish.';
  }

  function body() {
    function v(id) { var x = $(id).value.trim(); return x === '' ? null : x; }
    var min = $('#sMin').value.trim();
    return { store_name: v('#sName'), tagline: v('#sTag'), logo_url: v('#sLogo'), contact_phone: v('#sPhone'), whatsapp_number: v('#sWa'), address: v('#sAddr'),
      announcement: v('#sAnn'), enable_delivery: $('#sDel').checked, enable_pickup: $('#sPick').checked, fulfilment_branch_id: $('#sBranch').value || null,
      min_order_amount: min === '' ? null : Math.max(0, num(min)) };
  }
  async function save(andPublish) {
    var err = $('#sErr'), ok = $('#sOk'); K.notice(err, ''); K.notice(ok, '');
    if (DZ.logo.busy()) return K.notice(err, 'Wait for the logo to finish uploading, then save.', 'err');
    var btns = [$('#sSave'), $('#sPub'), $('#sUnpub')]; btns.forEach(function (b) { b.disabled = true; });
    try {
      if (andPublish) {
        if (!S.loaded.zones) await loadList('zones');
        if ($('#sDel').checked && activeZones().length === 0) {
          throw new Error('You offer delivery but have no delivery areas yet, so delivery would be free to any address. Add a delivery area first, or switch delivery off.');
        }
      }
      var s = await K.api('PUT', '/storefront/settings', body());
      if (andPublish) s = await K.api('POST', '/storefront/publish');
      paint(s, await K.branches());
      K.notice(ok, andPublish ? 'Saved and published. Your store is live.' : 'Saved.', 'ok');
    } catch (ex) { K.notice(err, (andPublish && ex.status ? 'Saved, but the store could not go live: ' : '') + failText(ex, 'We could not save.'), 'err'); }
    btns.forEach(function (b) { b.disabled = false; });
  }
  $('#sfForm').addEventListener('submit', function (e) { e.preventDefault(); save(false); });
  $('#sPub').addEventListener('click', function () { save(true); });
  $('#sUnpub').addEventListener('click', async function () {
    K.notice($('#sErr'), ''); try { paint(await K.api('POST', '/storefront/unpublish'), await K.branches()); K.notice($('#sOk'), 'Your store is offline.', 'ok'); } catch (ex) { K.notice($('#sErr'), failText(ex), 'err'); }
  });

  /* =====================================================
     Delivery areas, banners and pages
     ===================================================== */
  var CFG = {
    zones: {
      path: '/storefront/delivery-zones', list: '#znList', err: '#znListErr', noun: 'delivery area',
      dlg: '#znDlg', form: '#znForm', ferr: '#znErr', save: '#znSave', del: '#znDel', title: '#znTitle', newTitle: 'Add a delivery area', editTitle: 'Edit delivery area',
      fill: function (z) { $('#znName').value = z.name || ''; $('#znFee').value = z.fee !== undefined && z.fee !== null ? z.fee : ''; $('#znMins').value = z.estimated_minutes || ''; $('#znMin').value = z.min_order_amount && num(z.min_order_amount) > 0 ? z.min_order_amount : ''; $('#znActive').checked = z.is_active !== false; },
      read: function () {
        var name = $('#znName').value.trim(); if (!name) return { error: 'Enter the area name.' };
        var fee = $('#znFee').value.trim(); if (fee === '' || !(num(fee) >= 0)) return { error: 'Enter the delivery fee. Use 0 for free delivery.' };
        var mins = $('#znMins').value.trim(), min = $('#znMin').value.trim();
        return { body: { name: name, fee: num(fee), estimated_minutes: mins === '' ? null : Math.round(num(mins)), min_order_amount: min === '' ? null : num(min), is_active: $('#znActive').checked } };
      },
      render: function (rows, box) {
        if (!rows.length) { box.appendChild(emptyBox('moped', 'No delivery areas yet', 'Add the places you deliver to and what each one costs. You need at least one before you can publish with delivery on.')); return; }
        var t = tableOf(['Area', 'Fee', 'Minimum order', 'Time', 'Status'], [1, 2]);
        rows.forEach(function (z) {
          var r = K.el('tr', undefined, 'go'), c = K.el('td'); c.appendChild(K.el('b', z.name || '')); r.appendChild(c);
          r.appendChild(K.el('td', num(z.fee) === 0 ? 'Free' : K.money(z.fee), 'r num')); r.appendChild(K.el('td', num(z.min_order_amount) > 0 ? K.money(z.min_order_amount) : '', 'r num muted'));
          r.appendChild(K.el('td', z.estimated_minutes ? '~' + z.estimated_minutes + ' min' : '', 'muted'));
          var st = K.el('td'); st.appendChild(z.is_active === false ? statusTag('Off') : statusTag('Active', 'ok')); r.appendChild(st);
          r.addEventListener('click', function () { openForm('zones', z); }); t.body.appendChild(r);
        });
        box.appendChild(t.card);
      }
    },
    banners: {
      path: '/storefront/banners', list: '#bnList', err: '#bnListErr', noun: 'banner',
      dlg: '#bnDlg', form: '#bnForm', ferr: '#bnErr', save: '#bnSave', del: '#bnDel', title: '#bnTitle', newTitle: 'Add a banner', editTitle: 'Edit banner',
      fill: function (b) { DZ.banner.set(b.image_url); $('#bnHead').value = b.title || ''; $('#bnSub').value = b.subtitle || ''; $('#bnLink').value = b.link_url || ''; $('#bnFrom').value = localInput(b.starts_at); $('#bnTo').value = localInput(b.ends_at); $('#bnSort').value = b.sort_order !== undefined && b.sort_order !== null ? b.sort_order : ''; $('#bnActive').checked = b.is_active !== false; },
      read: function () {
        if (DZ.banner.busy()) return { error: 'Wait for the picture to finish uploading.' };
        var img = $('#bnImage').value.trim(); if (!/^(https?:\/\/|\/)/i.test(img)) return { error: 'Add a picture for the banner.' };
        var link = blank($('#bnLink').value); if (link && !/^(https?:\/\/|\/)/i.test(link)) return { error: 'The link must start with https://' };
        var from = isoFrom($('#bnFrom').value), to = isoFrom($('#bnTo').value); if (from && to && from >= to) return { error: 'The end time must be after the start time.' };
        var sort = $('#bnSort').value.trim();
        return { body: { image_url: img, title: blank($('#bnHead').value), subtitle: blank($('#bnSub').value), link_url: link, starts_at: from, ends_at: to, sort_order: sort === '' ? 0 : Math.round(num(sort)), is_active: $('#bnActive').checked } };
      },
      render: function (rows, box) {
        if (!rows.length) { box.appendChild(emptyBox('image', 'No banners yet', 'Add a picture with a headline to show at the top of your store.')); return; }
        var t = tableOf(['Picture', 'Banner', 'Shows', 'Status']), now = Date.now();
        rows.forEach(function (b) {
          var r = K.el('tr', undefined, 'go'), p = K.el('td'), im = K.el('img', undefined, 'sf-thumb'); im.alt = ''; im.loading = 'lazy'; im.src = b.image_url || ''; p.appendChild(im); r.appendChild(p);
          var c = K.el('td', undefined, 'sf-cell'); c.appendChild(K.el('b', b.title || 'Untitled banner')); if (b.subtitle) c.appendChild(K.el('small', b.subtitle)); r.appendChild(c);
          var from = b.starts_at ? new Date(b.starts_at).getTime() : null, to = b.ends_at ? new Date(b.ends_at).getTime() : null;
          r.appendChild(K.el('td', from || to ? (from ? 'From ' + when(b.starts_at) : '') + (from && to ? ' ' : '') + (to ? 'until ' + when(b.ends_at) : '') : 'Always', 'muted'));
          var st = K.el('td'), state = b.is_active === false ? ['Hidden', ''] : from && from > now ? ['Scheduled', 'wait'] : to && to <= now ? ['Ended', 'bad'] : ['Showing', 'ok']; st.appendChild(statusTag(state[0], state[1])); r.appendChild(st);
          r.addEventListener('click', function () { openForm('banners', b); }); t.body.appendChild(r);
        });
        box.appendChild(t.card);
      }
    },
    pages: {
      path: '/storefront/pages', list: '#pgList', err: '#pgListErr', noun: 'page',
      dlg: '#pgDlg', form: '#pgForm', ferr: '#pgErr', save: '#pgSave', del: '#pgDel', title: '#pgTitle', newTitle: 'Add a page', editTitle: 'Edit page',
      fill: function (p) { $('#pgHead').value = p.title || ''; $('#pgSlug').value = p.slug || ''; $('#pgBody').value = p.content || ''; $('#pgSort').value = p.sort_order !== undefined && p.sort_order !== null ? p.sort_order : ''; $('#pgPub').checked = p.is_published !== false; },
      read: function () {
        var title = $('#pgHead').value.trim(); if (!title) return { error: 'Enter a title for the page.' };
        var content = $('#pgBody').value; if (content.length > 20000) return { error: 'The page is too long. Keep it under 20,000 characters.' };
        var sort = $('#pgSort').value.trim(), slug = blank($('#pgSlug').value), b = { title: title, content: content, sort_order: sort === '' ? 0 : Math.round(num(sort)), is_published: $('#pgPub').checked };
        if (slug) b.slug = slug; return { body: b };
      },
      render: function (rows, box) {
        if (!rows.length) { box.appendChild(emptyBox('file-text', 'No pages yet', 'Add pages like About us, Delivery info or Returns. They appear in your store footer.')); return; }
        var t = tableOf(['Page', 'Address', 'Status']);
        rows.forEach(function (p) {
          var r = K.el('tr', undefined, 'go'), c = K.el('td'); c.appendChild(K.el('b', p.title || '')); r.appendChild(c);
          r.appendChild(K.el('td', p.slug || '', 'mono muted'));
          var st = K.el('td'); st.appendChild(p.is_published === false ? statusTag('Draft') : statusTag('Published', 'ok')); r.appendChild(st);
          r.addEventListener('click', function () { openForm('pages', p); }); t.body.appendChild(r);
        });
        box.appendChild(t.card);
      }
    }
  };

  async function loadList(kind) {
    var c = CFG[kind], box = $(c.list); K.notice($(c.err), '');
    box.textContent = ''; for (var i = 0; i < 3; i++) box.appendChild(K.el('div', undefined, 'sk-row'));
    try {
      S[kind] = rowsOf(await K.api('GET', c.path + '?limit=100')); S.loaded[kind] = true;
      box.textContent = ''; c.render(S[kind], box);
    } catch (ex) { box.textContent = ''; K.notice($(c.err), failText(ex, 'We could not load the ' + c.noun + 's.'), 'err'); }
    checklist();
  }

  function openForm(kind, item) {
    var c = CFG[kind]; S.edit[kind] = item || null; K.notice($(c.ferr), '');
    $(c.title).textContent = item ? c.editTitle : c.newTitle; c.fill(item || {}); $(c.del).hidden = !item;
    $(c.dlg).showModal();
  }
  Object.keys(CFG).forEach(function (kind) {
    var c = CFG[kind];
    $(c.form).addEventListener('submit', async function (e) {
      e.preventDefault(); var err = $(c.ferr), btn = $(c.save); K.notice(err, '');
      var r = c.read(); if (r.error) return K.notice(err, r.error, 'err');
      K.busy(btn, true, 'Saving...');
      try {
        if (S.edit[kind]) await K.api('PATCH', c.path + '/' + encodeURIComponent(S.edit[kind].id), r.body); else await K.api('POST', c.path, r.body);
        $(c.dlg).close(); K.toast(c.noun.charAt(0).toUpperCase() + c.noun.slice(1) + ' saved'); await loadList(kind);
      } catch (ex) { K.notice(err, failText(ex, 'We could not save the ' + c.noun + '.'), 'err'); }
      K.busy(btn, false);
    });
    $(c.del).addEventListener('click', async function () {
      var it = S.edit[kind]; if (!it) return;
      if (!window.confirm('Delete this ' + c.noun + '? This cannot be undone.')) return;
      var btn = this; K.busy(btn, true, 'Deleting...');
      try { await K.api('DELETE', c.path + '/' + encodeURIComponent(it.id)); $(c.dlg).close(); K.toast(c.noun.charAt(0).toUpperCase() + c.noun.slice(1) + ' deleted'); await loadList(kind); }
      catch (ex) { K.notice($(c.ferr), failText(ex, 'We could not delete the ' + c.noun + '.'), 'err'); }
      K.busy(btn, false);
    });
  });
  $('#addZone').addEventListener('click', function () { openForm('zones', null); });
  $('#addBanner').addEventListener('click', function () { openForm('banners', null); });
  $('#addPage').addEventListener('click', function () { openForm('pages', null); });

  document.querySelectorAll('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { var d = b.closest('dialog'); if (d && d.open) d.close(); }); });

  /* ---------- start ---------- */
  console.info('step-storefront.js: loaded');
  (async function () {
    try { paint(await K.api('GET', '/storefront/settings'), await K.branches()); }
    catch (ex) { K.notice($('#sErr'), failText(ex), 'err'); }
    // the checklist needs these to be accurate
    loadList('zones'); loadList('banners'); loadList('pages');
  })();
})();