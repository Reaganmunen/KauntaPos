/* The signed-in app shell: a slim rail of sections, a panel listing the pages inside the chosen section,
   and a top bar. Every admin page only needs <main class="page" id="page"> and this script;
   the shell wraps it. Set <body data-nav="products.html"> to say which page is open (it falls back to the file name).

   To switch on a page you have built, set ready: true for it in NAV below. Pages that are not ready yet show a
   "Soon" tag instead of a link, so nobody lands on a missing page. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var page = document.getElementById('page'); if (!page) return;

  var NAV = [
    { id: 'home', label: 'Home', icon: 'house-line', title: 'Home', blurb: 'How the shop is doing today.', items: [
      { href: 'dashboard.html', label: 'Overview', icon: 'squares-four', desc: 'Sales, stock and what needs you', ready: true }
    ] },
    { id: 'sell', label: 'Sell', icon: 'cash-register', title: 'Sell', blurb: 'Take payments and follow orders.', items: [
      { href: 'pos.html', label: 'New sale', icon: 'cash-register', desc: 'Open the till', ready: true },
      { href: 'test-sale.html', label: 'Practice sale', icon: 'flask', desc: 'Try a cash sale and its receipt', ready: true },
      { href: 'sales.html', label: 'Sales', icon: 'receipt', desc: 'Every receipt, searchable', ready: true },
      { href: 'shifts.html', label: 'Shifts', icon: 'clock', desc: 'Cash drawer and handover', ready: true },
      { href: 'online-orders.html', label: 'Online orders', icon: 'shopping-bag', desc: 'Orders from your store', ready: true}
    ] },
    { id: 'stock', label: 'Stock', icon: 'package', title: 'Stock', blurb: 'What you sell and what is on the shelf.', items: [
      { href: 'products.html', label: 'Products', icon: 'package', desc: 'Prices, photos and variants', ready: true },
      { href: 'inventory.html', label: 'Inventory', icon: 'stack', desc: 'Stock levels by branch', ready:true },
      { href: 'purchases.html', label: 'Purchases', icon: 'truck', desc: 'Orders to your suppliers', ready:true }
    ] },
    { id: 'people', label: 'People', icon: 'users-three', title: 'People', blurb: 'Customers, suppliers and your team.', items: [
      { href: 'customers.html', label: 'Customers', icon: 'users', desc: 'Who buys and who owes', ready:true },
      { href: 'suppliers.html', label: 'Suppliers', icon: 'handshake', desc: 'Who you buy from', ready:true },
      { href: 'team.html', label: 'Team', icon: 'identification-badge', desc: 'Staff, roles and PINs', ready:true }
    ] },
    { id: 'money', label: 'Money', icon: 'wallet', title: 'Money', blurb: 'Payments, tax and reports.', items: [
      { href: 'expenses.html', label: 'Expenses', icon: 'wallet', desc: 'Rent, wages and running costs', ready:true },
      { href: 'mpesa.html', label: 'M-Pesa', icon: 'device-mobile', desc: 'Till or paybill connection', ready: true },
      { href: 'etims.html', label: 'eTIMS', icon: 'seal-check', desc: 'KRA receipts through Digitax', ready: true },
      { href: 'reports.html', label: 'Reports', icon: 'chart-bar', desc: 'Sales, profit and tax', ready:true }
    ] },
    { id: 'shop', label: 'Shop', icon: 'storefront', title: 'Shop', blurb: 'Your online store, branches and profile.', items: [
      { href: 'storefront.html', label: 'Online store', icon: 'storefront', desc: 'Name, delivery and publishing', ready: true },
      { href: 'branches.html', label: 'Branches', icon: 'git-branch', desc: 'Every place you sell from', ready:true},
      { href: 'profile.html', label: 'Profile and shop', icon: 'user-circle', desc: 'Your details, logo and password', ready: true },
      { href: 'subscription.html', label: 'Plan and billing', icon: 'credit-card', desc: 'Your plan, usage and payments', ready: true }
    ] }
  ];

  var here = document.body.getAttribute('data-nav') || location.pathname.split('/').pop() || 'dashboard.html';
  var current = NAV.filter(function (s) { return s.items.some(function (i) { return i.href === here; }); })[0] || NAV[0];
  var shown = current;
  var S = K.session || {}, shopTitle = (S.tenant && S.tenant.name) || 'Your shop', userName = (S.user && (S.user.name || S.user.full_name)) || '';

  function firstReady(sec) { return (sec.items.filter(function (i) { return i.ready; })[0] || sec.items[0]).href; }

  var shell = document.createElement('div');
  shell.className = 'shell'; shell.id = 'shell';
  shell.innerHTML =
    '<div class="nav" id="nav">' +
      '<nav class="rail" aria-label="Sections">' +
        '<a class="rail-logo" href="dashboard.html" aria-label="Kaunta home"><img src="img/logo-mark.svg" alt="" width="46" height="46"></a>' +
        NAV.map(function (s) { return '<button class="rail-i' + (s === shown ? ' on' : '') + '" type="button" data-sec="' + s.id + '" aria-label="' + K.esc(s.label) + '"><i class="ph ph-' + s.icon + '"></i><span>' + K.esc(s.label) + '</span></button>'; }).join('') +
        '<span class="rail-sp"></span>' +
        '<span data-theme-slot></span>' +
        '<a class="av" id="railAv" href="profile.html" title="Your profile">' + K.esc((userName || shopTitle).charAt(0).toUpperCase()) + '</a>' +
      '</nav>' +
      '<aside class="panel" aria-label="Pages">' +
        '<div class="panel-h"><h2 id="panelTitle"></h2><p id="panelBlurb"></p></div>' +
        '<nav class="panel-l" id="panelLinks" aria-label="Pages in this section"></nav>' +
        '<div class="panel-f"><button class="pl" id="signOut" type="button"><span class="ic sm"><i class="ph ph-door-open"></i></span><span><b>Sign out</b></span></button></div>' +
      '</aside>' +
    '</div>' +
    '<div class="scrim" id="scrim"></div>' +
    '<div class="main">' +
      '<header class="topbar">' +
        '<button class="icon-btn menu-btn" id="menuBtn" type="button" aria-label="Open menu" aria-controls="nav" aria-expanded="false"><i class="ph ph-list"></i></button>' +
        '<a class="chip" href="profile.html" title="Your shop profile"><span class="av sq" id="tbShopAv"></span><b id="tbShopName"></b></a>' +
        '<span class="grow"></span>' +
        '<span class="chip plain hide-s"><i class="ph ph-calendar-blank"></i><span id="dateLine"></span></span>' +
        '<a class="chip hide-s" id="meChip" href="profile.html" title="Your profile"><span class="av" id="tbMeAv"></span><span id="tbUserName"></span></a>' +
      '</header>' +
    '</div>';
  document.body.insertBefore(shell, document.body.firstChild);
  shell.querySelector('.main').appendChild(page);

  function paintPanel() {
    shell.querySelector('#panelTitle').textContent = shown.title;
    shell.querySelector('#panelBlurb').textContent = shown.blurb;
    shell.querySelectorAll('.rail-i').forEach(function (b) { b.classList.toggle('on', b.dataset.sec === shown.id); });
    shell.querySelector('#panelLinks').innerHTML = shown.items.map(function (i) {
      var inner = '<span class="ic sm"><i class="ph ph-' + i.icon + '"></i></span><span><b>' + K.esc(i.label) + '</b><small>' + K.esc(i.desc) + '</small></span>';
      if (!i.ready) return '<div class="pl off" aria-disabled="true">' + inner + '<span class="tag">Soon</span></div>';
      return '<a class="pl' + (i.href === here ? ' on' : '') + '" href="' + i.href + '"' + (i.href === here ? ' aria-current="page"' : '') + '>' + inner + '</a>';
    }).join('');
  }
  paintPanel();

  shell.querySelectorAll('.rail-i').forEach(function (b) {
    b.addEventListener('click', function () { shown = NAV.filter(function (s) { return s.id === b.dataset.sec; })[0]; paintPanel(); });
  });

  /* mobile: the rail and panel slide in together */
  function setNav(open) { shell.classList.toggle('nav-open', open); shell.querySelector('#menuBtn').setAttribute('aria-expanded', String(open)); }
  shell.querySelector('#menuBtn').addEventListener('click', function () { setNav(!shell.classList.contains('nav-open')); });
  shell.querySelector('#scrim').addEventListener('click', function () { setNav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false); });
  shell.querySelector('#signOut').addEventListener('click', function () { K.logout(); });

  /* top bar details */
  shell.querySelector('#dateLine').textContent = new Date().toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  K.avatar(shell.querySelector('#tbShopAv'), null, shopTitle); shell.querySelector('#tbShopName').textContent = shopTitle;
  K.avatar(shell.querySelector('#tbMeAv'), null, userName); shell.querySelector('#tbUserName').textContent = userName;
  var slot = shell.querySelector('[data-theme-slot]');
  if (window.KTheme && slot) window.KTheme.mount(slot);

  /* One quiet notice at the top of the page when the subscription needs attention. It reads tenant.access
     from /auth/me (see utils/entitlements on the server). The Plan and billing page has its own status block. */
  function lastDay(iso) { var t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? '' : new Date(t - 1).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function days(n) { return n + (n === 1 ? ' day' : ' days'); }
  var OFF = 'You can still look at and export your records. Selling and editing are off until you pay.';
  function noticeFor(a) {
    if (!a) return null;
    var left = a.days_left, end = lastDay(a.ends_at);
    switch (a.state) {
      case 'trial':
        if (left === null || left > 7) return null;
        return { head: left <= 0 ? 'Your free trial ends today.' : 'Your free trial ends in ' + days(left) + '.', text: 'Subscribe to keep selling' + (end ? ' after ' + end : '') + '.' };
      case 'active':
        if (left === null || left > 5) return null;
        return { head: 'Your plan ends in ' + days(Math.max(left, 0)) + '.', text: 'Pay' + (end ? ' before ' + end : '') + ' to carry on without a break.' };
      case 'grace':
        return { head: 'Your payment is due.', text: 'Everything still works. ' + (a.grace_ends_at ? 'Pay by ' + lastDay(a.grace_ends_at) + ' to avoid losing the ability to sell and edit.' : 'Pay soon to avoid losing the ability to sell and edit.') };
      case 'trial_expired': return { tone: 'bad', head: 'Your free trial has ended.', text: OFF };
      case 'expired': return { tone: 'bad', head: 'Your subscription has ended.', text: OFF };
      case 'cancelled': return { tone: 'bad', head: 'Your subscription is cancelled.', text: OFF };
      case 'inactive': return { tone: 'bad', head: 'Your subscription is not active.', text: OFF };
      case 'suspended': return { tone: 'bad', head: 'This account is suspended.', text: 'Contact Kaunta support, or send your payment details on the Plan and billing page.' };
      default: return null;
    }
  }
  function showNotice(d) {
    if (here === 'subscription.html') return;
    var n = noticeFor(d.tenant && d.tenant.access); if (!n) return;
    var box = document.createElement('div'); box.className = 'sub-note' + (n.tone ? ' ' + n.tone : ''); box.setAttribute('role', 'status');
    var msg = document.createElement('span'), b = document.createElement('b'); b.textContent = n.head;
    msg.appendChild(b); msg.appendChild(document.createTextNode(' ' + n.text));
    var link = document.createElement('a'); link.href = 'subscription.html'; link.textContent = 'Plan and billing';
    box.appendChild(msg); box.appendChild(link);
    page.insertBefore(box, page.firstChild);
  }

  K.identity().then(function (d) {
    if (!d) return;
    showNotice(d);
    var t = d.tenant || {}, u = d.user || {};
    if (t.name) shell.querySelector('#tbShopName').textContent = t.name;
    K.avatar(shell.querySelector('#tbShopAv'), t.logo_url, t.name || shopTitle);
    var nm = u.full_name || userName; shell.querySelector('#tbUserName').textContent = nm || '';
    K.avatar(shell.querySelector('#tbMeAv'), u.avatar_url, nm); K.avatar(shell.querySelector('#railAv'), u.avatar_url, nm || shopTitle);
    document.dispatchEvent(new CustomEvent('kaunta:identity', { detail: d }));
  });
})();
