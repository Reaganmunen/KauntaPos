/* Kaunta theme: one switch for every page. Load in <head> so the theme is set before first paint.
   Choice is saved in localStorage ("kaunta-theme": light | dark). With no saved choice it follows the device. */
(function () {
  var KEY = 'kaunta-theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var btn = null, metaLight = null;

  function stored() { try { var v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the choice lasts for this page only */ } }
  function current() { return stored() || (mq && mq.matches ? 'dark' : 'light'); }

  function apply(t) {
    root.setAttribute('data-theme', t);
    root.setAttribute('data-bs-theme', t);
    root.style.colorScheme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { if (metaLight === null) metaLight = meta.getAttribute('content'); meta.setAttribute('content', t === 'dark' ? '#151311' : metaLight); }
    if (btn) {
      btn.textContent = t === 'dark' ? 'Light' : 'Dark';
      btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
    }
  }

  apply(current());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!stored()) apply(current()); });
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(current()); });

  document.addEventListener('DOMContentLoaded', function () {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'theme-toggle';
    btn.addEventListener('click', function () { var next = current() === 'dark' ? 'light' : 'dark'; save(next); apply(next); });
    var navActions = document.querySelector('.site-nav .d-flex');   /* landing page: sits beside Sign in */
    var authMain = document.querySelector('.auth-main');            /* login and signup: top right of the form side */
    if (navActions) navActions.insertBefore(btn, navActions.firstChild);
    else if (authMain) authMain.appendChild(btn);
    else { btn.className += ' theme-toggle-float'; document.body.appendChild(btn); }
    apply(current());
  });
})();