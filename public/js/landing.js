/* Kaunta landing page behaviour. Plain JS, no build step.
   API base: set window.KAUNTA_API before this script to point elsewhere (default /api). */
(function () {
  'use strict';

  var API = (window.KAUNTA_API || '/api').replace(/\/$/, '');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var money = function (n) { return n.toLocaleString('en-KE'); };

  /* ---------------------------------------------------------------
     1. Hero: a looping sale at the till
  --------------------------------------------------------------- */
  // Product photos live in public/img/products/. Drop in your own files with these names
  // (transparent PNG, about 600x600, product centred). A missing file shows the first letter instead.
  var IMG_DIR = 'img/products/';
  var PRODUCTS = [
    { id: 'flour', name: 'Maize flour 2kg', price: 185, img: 'maize-flour.png',  bg: '#fff3e8' },
    { id: 'oil',   name: 'Cooking oil 1L',  price: 340, img: 'cooking-oil.png',  bg: '#fff3e8' },
    { id: 'bread', name: 'Bread 400g',      price: 70,  img: 'bread.png',        bg: '#fff3e8' },
    { id: 'milk',  name: 'Milk 500ml',      price: 60,  img: 'milk.png',         bg: '#fff3e8' },
    { id: 'soap',  name: 'Bar soap',        price: 120, img: 'soap.png',         bg: '#fff3e8' },
    { id: 'sugar', name: 'Sugar 1kg',       price: 190, img: 'sugar.png',        bg: '#fff3e8' }
  ];
  function thumb(p) {
    var letter = p.name.charAt(0);
    return '<div class="sw" style="background:' + p.bg + '"><img src="' + IMG_DIR + p.img + '" alt="" loading="lazy" ' +
      'onerror="this.outerHTML=\'<span class=ph>' + letter + '</span>\'"></div>';
  }
  // the sale that plays: [product id, quantity]. Total = 725
  var SALE = [['flour', 1], ['oil', 1], ['bread', 2], ['milk', 1]];

  var tilesEl = $('#tiles');
  var cartLines = $('#cartLines');
  var cartTotal = $('#cartTotal');
  var payBtn = $('#payBtn');
  var phone = $('#phone');
  var stk = $('#stk');
  var stkOk = $('#stkOk');
  var receipt = $('#receipt');
  var toast = $('#stockToast');
  var pinDots = $$('.pin i', stk);
  var ctl = $('#sceneCtl');

  if (tilesEl) {
    tilesEl.innerHTML = PRODUCTS.map(function (p) {
      return '<div class="tile" data-id="' + p.id + '">' + thumb(p) + '<b>' + p.name + '</b><small>KES ' + p.price + '</small></div>';
    }).join('');
  }

  function drawQR(canvas) {
    if (!canvas) return;
    var n = 21, ctx = canvas.getContext('2d'), seed = 482;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    ctx.clearRect(0, 0, n, n);
    ctx.fillStyle = '#1d1b19';
    function finder(x, y) {
      for (var i = 0; i < 7; i++) for (var j = 0; j < 7; j++) {
        var edge = i === 0 || j === 0 || i === 6 || j === 6, core = i > 1 && i < 5 && j > 1 && j < 5;
        if (edge || core) ctx.fillRect(x + i, y + j, 1, 1);
      }
    }
    for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) {
      var inFinder = (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12);
      if (!inFinder && rnd() > 0.52) ctx.fillRect(x, y, 1, 1);
    }
    finder(0, 0); finder(14, 0); finder(0, 14);
  }
  drawQR($('#qr'));

  var paused = false, runId = 0;
  async function wait(ms) {               // sleeps, but holds while paused and aborts on a new run
    var id = runId, left = ms;
    while (left > 0) {
      if (id !== runId) throw new Error('cancel');
      await sleep(paused ? 120 : Math.min(left, 120));
      if (!paused) left -= 120;
    }
  }

  function resetScene() {
    cartLines.innerHTML = '<div class="cart-empty">Tap an item to start a sale.</div>';
    cartTotal.textContent = '0';
    payBtn.className = 'pay-btn';
    payBtn.textContent = 'Pay with M-Pesa';
    phone.classList.remove('show');
    stk.classList.remove('done');
    pinDots.forEach(function (d) { d.classList.remove('on'); });
    stkOk.innerHTML = '&nbsp;';
    receipt.classList.remove('show');
    toast.classList.remove('show');
  }

  function countTo(el, from, to, ms) {
    if (reduceMotion) { el.textContent = money(to); return; }
    var t0 = performance.now();
    (function tick(t) {
      var k = Math.min(1, (t - t0) / ms);
      el.textContent = money(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  async function playSale() {
    var total = 0;
    resetScene();
    await wait(900);
    for (var i = 0; i < SALE.length; i++) {
      var p = PRODUCTS.filter(function (x) { return x.id === SALE[i][0]; })[0], qty = SALE[i][1];
      var tile = $('.tile[data-id="' + p.id + '"]', tilesEl);
      tile.classList.add('hit'); await wait(260); tile.classList.remove('hit');
      if (i === 0) cartLines.innerHTML = '';
      var line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = '<span>' + qty + ' x ' + p.name + '</span><span>' + money(p.price * qty) + '</span>';
      cartLines.appendChild(line);
      var next = total + p.price * qty;
      countTo(cartTotal, total, next, 420);
      total = next;
      await wait(620);
    }
    payBtn.classList.add('hit'); await wait(240); payBtn.classList.remove('hit');
    payBtn.textContent = 'Waiting for customer...';
    await wait(500);
    phone.classList.add('show');
    await wait(1400);
    for (var d = 0; d < pinDots.length; d++) { pinDots[d].classList.add('on'); await wait(320); }
    stkOk.textContent = 'Sending...';
    await wait(700);
    stk.classList.add('done');
    payBtn.classList.add('paid'); payBtn.textContent = 'Paid KES ' + money(total);
    await wait(900);
    receipt.classList.add('show');
    await wait(900);
    toast.classList.add('show');
    await wait(3600);
    phone.classList.remove('show');
    receipt.classList.remove('show');
    toast.classList.remove('show');
    await wait(900);
  }

  async function loop() {
    var id = ++runId;
    while (id === runId) {
      try { await playSale(); } catch (e) { return; }
    }
  }

  if (tilesEl) {
    if (reduceMotion) {            // show the finished state, no motion
      SALE.forEach(function (s) {
        var p = PRODUCTS.filter(function (x) { return x.id === s[0]; })[0];
        if (cartLines.querySelector('.cart-empty')) cartLines.innerHTML = '';
        cartLines.insertAdjacentHTML('beforeend', '<div class="cart-line"><span>' + s[1] + ' x ' + p.name + '</span><span>' + money(p.price * s[1]) + '</span></div>');
      });
      cartTotal.textContent = '725';
      payBtn.classList.add('paid'); payBtn.textContent = 'Paid KES 725';
      receipt.classList.add('show');
      ctl.style.display = 'none';
    } else {
      loop();
      ctl.addEventListener('click', function () {
        paused = !paused;
        ctl.setAttribute('aria-pressed', String(paused));
        ctl.innerHTML = paused ? '<i class="bi bi-play-circle"></i> <span>Play demo</span>' : '<i class="bi bi-pause-circle"></i> <span>Pause demo</span>';
      });
      // don't burn cycles while the hero is off screen
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (e) { paused = !e[0].isIntersecting || ctl.getAttribute('aria-pressed') === 'true'; }, { threshold: 0.15 }).observe($('#scene'));
      }
    }
  }

  /* ---------------------------------------------------------------
     2. Demo: four steps that auto-advance and can be clicked
  --------------------------------------------------------------- */
  var steps = $$('#steps .step'), screens = $$('#stage .screen'), demoBox = $('#demoBox');
  var cur = 0, stepTimer = null, DUR = 5500;

  function typeName() {
    var el = $('#typedName'); if (!el) return;
    var full = 'Mama Njeri Stores', i = 0;
    if (reduceMotion) { el.textContent = full; return; }
    el.textContent = '';
    (function next() { if (i <= full.length && cur === 0) { el.textContent = full.slice(0, i++); setTimeout(next, 55); } })();
  }
  function growBars() {
    $$('#bars div').forEach(function (b) { b.style.height = '0'; });
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      $$('#bars div').forEach(function (b) { b.style.height = (b.dataset.h * 1.1) + '%'; });
    }); });
  }
  function go(i) {
    cur = i;
    steps.forEach(function (s, k) {
      s.classList.remove('on');
      if (k === i) { void s.offsetWidth; s.classList.add('on'); s.style.setProperty('--dur', DUR + 'ms'); }
    });
    screens.forEach(function (s, k) { s.classList.toggle('on', k === i); });
    if (i === 0) typeName();
    if (i === 3) growBars();
    clearTimeout(stepTimer);
    if (!reduceMotion) stepTimer = setTimeout(function () { go((i + 1) % steps.length); }, DUR);
  }
  steps.forEach(function (s) { s.addEventListener('click', function () { go(+s.dataset.i); }); });
  if (steps.length) {
    var started = false;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e, o) { if (e[0].isIntersecting && !started) { started = true; go(0); o.disconnect(); } }, { threshold: 0.25 }).observe(demoBox);
    } else { go(0); }
  }

  /* ---------------------------------------------------------------
     3. Online storefront mini-shop
  --------------------------------------------------------------- */
  var shopGrid = $('#shopGrid'), shopText = $('#shopCartText'), shopPay = $('#shopPay');
  var basket = {};
  if (shopGrid) {
    shopGrid.innerHTML = PRODUCTS.map(function (p) {
      return '<button class="shop-item" type="button" data-id="' + p.id + '">' + thumb(p) + '<b>' + p.name + '</b><small>KES ' + p.price + '</small></button>';
    }).join('');
    shopGrid.addEventListener('click', function (e) {
      var b = e.target.closest('.shop-item'); if (!b) return;
      basket[b.dataset.id] = (basket[b.dataset.id] || 0) + 1;
      var count = 0, total = 0;
      PRODUCTS.forEach(function (p) { var q = basket[p.id] || 0; count += q; total += q * p.price; });
      shopText.innerHTML = '<b>' + count + (count === 1 ? ' item' : ' items') + '</b>, KES ' + money(total);
      shopPay.disabled = false;
      shopPay.dataset.total = total;
    });
    shopPay.addEventListener('click', function () {
      shopPay.disabled = true;
      shopText.textContent = 'Check your phone for the M-Pesa prompt.';
      setTimeout(function () {
        shopText.innerHTML = '<b>Paid KES ' + money(+shopPay.dataset.total) + '.</b> The order is now on the shop till.';
        basket = {}; shopPay.textContent = 'Pay with M-Pesa';
      }, 2400);
    });
  }

  /* ---------------------------------------------------------------
     4. Screen strip (duplicated so the loop is seamless)
  --------------------------------------------------------------- */
  var track = $('#stripTrack');
  if (track) {
    var cards = [
      '<h5>New sale</h5><div class="ln"><span>Bread</span><span>70</span></div><div class="ln"><span>Milk</span><span>60</span></div><div class="big mt-2">KES 130</div><div class="btnx">Charge</div>',
      '<h5>Low stock</h5><div class="ln"><span>Bread 400g</span><span>6</span></div><div class="ln"><span>Milk 500ml</span><span>4</span></div><div class="ln"><span>Sugar 1kg</span><span>9</span></div><div class="btnx">Create order</div>',
      '<h5>M-Pesa</h5><div class="ln"><span>0722 ••• 410</span><span>725</span></div><div class="ln"><span>0733 ••• 982</span><span>360</span></div><div class="btnx green">2 confirmed</div>',
      '<h5>Shift report</h5><div class="ln"><span>Cash</span><span>12,400</span></div><div class="ln"><span>M-Pesa</span><span>36,520</span></div><div class="big mt-2">48,920</div>',
      '<h5>Transfer</h5><div class="ln"><span>To Kilimani</span><span>12</span></div><div class="ln"><span>Unga 2kg</span><span>sent</span></div><div class="btnx">Receive</div>',
      '<h5>Customers</h5><div class="ln"><span>Mama Atieno</span><span>owes 850</span></div><div class="ln"><span>Mr. Kiptoo</span><span>owes 0</span></div><div class="btnx">Record payment</div>'
    ].map(function (c) { return '<div class="mini-phone">' + c + '</div>'; }).join('');
    track.innerHTML = cards + cards;
  }

  /* ---------------------------------------------------------------
     5. Pricing toggle
  --------------------------------------------------------------- */
  $$('.billing button').forEach(function (b) {
    b.addEventListener('click', function () {
      var yearly = b.dataset.bill === 'yearly';
      $$('.billing button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $$('.price [data-m]').forEach(function (el) { el.textContent = yearly ? el.dataset.y : el.dataset.m; });
      $$('.price .per').forEach(function (el) { el.textContent = yearly ? 'year' : 'month'; });
    });
  });

  /* ---------------------------------------------------------------
     6. Sign up: POST /auth/register
        body: { slug, name, business_type, owner_name, owner_email | owner_phone, password }
  --------------------------------------------------------------- */
  var form = $('#signupForm'), nameIn = $('#shopName'), slugIn = $('#slug'), slugOut = $('#slugOut'), msg = $('#formMsg'), btn = $('#signupBtn');
  var slugTouched = false;
  function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  if (form) {
    nameIn.addEventListener('input', function () { if (!slugTouched) { slugIn.value = slugify(nameIn.value); } slugOut.textContent = slugIn.value || 'your-shop'; });
    slugIn.addEventListener('input', function () { slugTouched = true; slugIn.value = slugify(slugIn.value); slugOut.textContent = slugIn.value || 'your-shop'; });

    function show(kind, text) { msg.className = 'form-msg ' + kind; msg.textContent = text; }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      msg.className = 'form-msg';
      var d = {
        name: nameIn.value.trim(), slug: slugIn.value.trim(), business_type: $('#bizType').value,
        owner_name: $('#ownerName').value.trim(), owner_email: $('#ownerEmail').value.trim(),
        owner_phone: $('#ownerPhone').value.trim(), password: $('#password').value
      };
      if (!d.name || !d.slug || !d.owner_name) return show('err', 'Add your shop name, address and your name.');
      if (d.slug.length < 3) return show('err', 'The shop address needs at least 3 letters or numbers.');
      if (!d.owner_email && !d.owner_phone) return show('err', 'Add a phone number or an email so we can reach you.');
      if (d.password.length < 8) return show('err', 'Use a password of at least 8 characters.');
      if (!d.owner_email) delete d.owner_email;
      if (!d.owner_phone) delete d.owner_phone;

      btn.disabled = true; var label = btn.textContent; btn.textContent = 'Creating your shop...';
      try {
        var res = await fetch(API + '/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(d)
        });
        var body = null; try { body = await res.json(); } catch (_) { /* non-JSON reply */ }
        if (!res.ok || (body && body.success === false)) {
          var m = body && body.error && body.error.message;
          return show('err', m || 'We could not create the shop. Check the details and try again.');
        }
        show('ok', 'Your shop is ready. Taking you to sign in...');
        setTimeout(function () { window.location.href = 'login.html?shop=' + encodeURIComponent(d.slug); }, 1400);
      } catch (err) {
        show('err', 'We could not reach the server. Check your connection and try again.');
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  /* ---------------------------------------------------------------
     7. Footer: service status from GET /health
  --------------------------------------------------------------- */
  var status = $('#apiStatus');
  if (status) {
    fetch(API + '/health', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (b) { return r.ok && b.success; }); })
      .then(function (ok) { status.classList.add(ok ? 'up' : 'down'); $('span', status).textContent = ok ? 'All systems running' : 'Service is having trouble'; })
      .catch(function () { status.classList.add('down'); $('span', status).textContent = 'Service unreachable'; });
  }

  var y = $('#year'); if (y) y.textContent = new Date().getFullYear();
})();