/* KDrop: picture upload with the basketball hoop drop zone.
   Usage: var dz = KDrop.mount(hostElement, { kind: 'logo' | 'banner', input: hiddenInput, onChange: fn });
          dz.set(url)  show a saved picture (or clear with a falsy value)
          dz.busy()    true while a picture is still being shrunk or uploaded
   The hidden input always holds the saved picture address, so forms read it like any other field.
   Pictures are shrunk in the browser first (smaller upload, faster store), then sent to POST /storefront/upload.
   Colours come from the system variables in css/ui.css (see css/dropzone.css), so light and dark themes both work. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('dropzone.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load.'); return; }

  var TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var MAX_SOURCE = 12 * 1024 * 1024;   // the file the person picks
  var TARGET_BYTES = 450 * 1024;       // what we actually send
  var SIZES = { logo: 512, banner: 1600 };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- the hoop ---------- */
  function hoopSvg() {
    // Net: straight strands from the rim down to a narrower bottom, crossed by two curved rows.
    var strands = '', i, n = 9;
    for (i = 0; i < n; i++) {
      var x1 = 54 + i * (92 / (n - 1)), x2 = 74 + i * (52 / (n - 1));
      strands += '<path d="M' + x1.toFixed(1) + ' 80 L' + x2.toFixed(1) + ' 150"/>';
    }
    var rows = '<path d="M60 102 Q100 112 140 102"/><path d="M67 126 Q100 135 133 126"/>';
    return '<svg class="dz-stage" viewBox="0 0 200 160" aria-hidden="true" focusable="false">' +
      '<rect class="dz-board" x="62" y="6" width="76" height="56" rx="4"/>' +
      '<rect class="dz-board-in" x="82" y="30" width="36" height="28" rx="2"/>' +
      '<line class="dz-arm" x1="100" y1="62" x2="100" y2="70"/>' +
      '<g class="dz-ball"><circle r="15"/>' +
      '<path d="M-15 0 H15 M0 -15 V15"/><path d="M-10.6 -10.6 Q-4 0 -10.6 10.6"/><path d="M10.6 -10.6 Q4 0 10.6 10.6"/></g>' +
      '<g class="dz-net">' + strands + rows + '</g>' +
      '<ellipse class="dz-rim" cx="100" cy="76" rx="50" ry="8"/>' +
      '</svg>';
  }

  /* ---------- picture handling ---------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('We could not read that picture. Try a different file.')); };
      im.src = url;
    });
  }
  function canvasBlob(canvas, type, q) { return new Promise(function (r) { canvas.toBlob(r, type, q); }); }
  function readDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = function () { reject(new Error('We could not read that picture.')); }; fr.readAsDataURL(blob);
    });
  }
  // Scale down to the size the store needs, then lower the quality (and then the size) until it is small enough.
  async function shrink(file, kind) {
    var im = await loadImage(file), max = SIZES[kind] || 1200;
    var w = im.naturalWidth, h = im.naturalHeight;
    if (!w || !h) throw new Error('We could not read that picture. Try a different file.');
    var scale = Math.min(1, max / Math.max(w, h)), blob = null, qualities = [0.86, 0.74, 0.62, 0.5];
    for (var round = 0; round < 4; round++) {
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(im, 0, 0, cw, ch);
      for (var q = 0; q < qualities.length; q++) {
        blob = await canvasBlob(canvas, 'image/webp', qualities[q]);   // falls back to PNG where WebP is not supported
        if (blob && blob.size <= TARGET_BYTES) return blob;
        if (blob && blob.type !== 'image/webp') break;                  // quality does nothing for PNG, so shrink the size instead
      }
      scale *= 0.75;
    }
    if (!blob) throw new Error('We could not prepare that picture.');
    if (blob.size > TARGET_BYTES * 2) throw new Error('That picture is too detailed to upload. Try a smaller one.');
    return blob;
  }
  function kb(n) { return n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, reduce && reduce.matches ? 0 : ms); }); }

  /* ---------- the component ---------- */
  function mount(host, opts) {
    opts = opts || {};
    var kind = opts.kind || 'banner', input = opts.input, pending = 0, token = 0;
    host.classList.add('dz'); host.setAttribute('data-kind', kind); host.textContent = '';
    host.innerHTML =
      '<input class="dz-file" type="file" accept="' + TYPES.join(',') + '" hidden>' +
      '<div class="dz-drop" tabindex="0" role="button" aria-label="Add a picture. Drop a file here, or press Enter to choose one.">' +
        '<span class="dz-ic"><i class="ph ph-upload-simple"></i></span>' +
        '<b class="dz-title">Drop a picture here</b><small class="dz-sub">or take the shot</small>' +
        hoopSvg() + '<span class="dz-bar" aria-hidden="true"></span>' +
      '</div>' +
      '<div class="dz-done" hidden>' +
        '<div class="dz-thumb"><img alt="" decoding="async"></div>' +
        '<div class="dz-meta"><b>Picture added</b><small class="dz-info"></small></div>' +
        '<div class="dz-btns"><button class="btn sm" type="button" data-act="replace">Replace</button><button class="btn sm" type="button" data-act="remove">Remove</button></div>' +
      '</div>' +
      '<p class="dz-err" role="alert" hidden></p>';

    var file = host.querySelector('.dz-file'), zone = host.querySelector('.dz-drop'), done = host.querySelector('.dz-done'),
        img = done.querySelector('img'), info = host.querySelector('.dz-info'), err = host.querySelector('.dz-err'),
        title = host.querySelector('.dz-title'), sub = host.querySelector('.dz-sub');

    function say(t, s) { title.textContent = t; sub.textContent = s; }
    function idle() { zone.classList.remove('is-over', 'is-shot', 'is-wait'); say('Drop a picture here', 'or take the shot'); }
    function fail(msg) { err.textContent = msg; err.hidden = !msg; if (msg) { zone.classList.remove('shake'); void zone.offsetWidth; zone.classList.add('shake'); } }
    function show(url, note) {
      var has = Boolean(url);
      if (input) input.value = url || '';
      zone.hidden = has; done.hidden = !has;
      if (has) { img.src = url; info.textContent = note || 'Saved to your store.'; } else { img.removeAttribute('src'); }
      idle();
    }

    async function take(f) {
      fail('');
      if (!f) return;
      if (TYPES.indexOf(f.type) < 0) return fail('Use a PNG, JPG, WebP or GIF picture.');
      if (f.size > MAX_SOURCE) return fail('That file is over 12 MB. Pick a smaller picture.');
      var mine = ++token; pending++;
      zone.classList.remove('is-over'); zone.classList.add('is-shot', 'is-wait');
      say('Taking the shot', f.name.length > 34 ? f.name.slice(0, 31) + '...' : f.name);
      try {
        // the ball flies for about a second while the picture is prepared and sent
        var results = await Promise.all([shrink(f, kind).then(async function (blob) {
          var res = await K.api('POST', '/storefront/upload', { kind: kind, filename: f.name, data: await readDataUrl(blob) });
          return { url: res && res.url, bytes: (res && res.bytes) || blob.size };
        }), wait(1250)]);
        if (mine !== token) return;
        var out = results[0];
        if (!out.url) throw new Error('The upload did not return a picture address.');
        zone.classList.remove('is-wait'); say('Scored', 'Saved ' + kb(out.bytes));
        await wait(650);
        if (mine !== token) return;
        show(out.url, 'Saved to your store, ' + kb(out.bytes) + '.');
        if (opts.onChange) opts.onChange(out.url);
      } catch (ex) {
        if (mine !== token) return;
        idle(); fail((ex && ex.status === 403) ? 'Your role does not include this. Ask the shop owner for access.' : (ex && ex.message) || 'We could not upload that picture.');
      } finally { pending = Math.max(0, pending - 1); }
    }

    /* events */
    function choose() { file.click(); }
    zone.addEventListener('click', choose);
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    file.addEventListener('change', function () { var f = file.files && file.files[0]; file.value = ''; take(f); });
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (e) { e.preventDefault(); if (zone.classList.contains('is-shot')) return; zone.classList.add('is-over'); say('Release to shoot', 'Let go to upload'); });
    });
    zone.addEventListener('dragleave', function (e) { if (e.relatedTarget && zone.contains(e.relatedTarget)) return; if (!zone.classList.contains('is-shot')) idle(); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); if (zone.classList.contains('is-shot')) return; idle(); take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
    done.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      if (b.dataset.act === 'replace') { choose(); return; }
      token++; show(''); fail(''); if (opts.onChange) opts.onChange('');
    });
    img.addEventListener('error', function () { info.textContent = 'This picture could not be loaded.'; });

    show(input && input.value ? input.value : '', 'Current picture.');
    return {
      set: function (url) { token++; fail(''); show(url || '', 'Current picture.'); },
      get: function () { return input ? input.value : ''; },
      busy: function () { return pending > 0; }
    };
  }

  window.KDrop = { mount: mount };
})();