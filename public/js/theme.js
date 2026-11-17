/* Kaunta theme: one switch for every page. Load in <head> so the theme is set before first paint.
   The choice is saved in localStorage ("kaunta-theme": light or dark). With no saved choice it follows the device. */
(function () {
  var KEY = 'kaunta-theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var btn = null, metaLight = null;
  var SUN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>';
  var MOON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

  function stored() { try { var v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the choice lasts for this page only */ } }
  function current() { return stored() || (mq && mq.matches ? 'dark' : 'light'); }

  function apply(t) {
    root.setAttribute('data-theme', t);
    root.setAttribute('data-bs-theme', t);
    root.style.colorScheme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { if (metaLight === null) metaLight = meta.getAttribute('content'); meta.setAttribute('content', t === 'dark' ? '#0a100d' : metaLight); }
    if (btn) {
      btn.innerHTML = t === 'dark' ? SUN : MOON;
      btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('title', t === 'dark' ? 'Light mode' : 'Dark mode');
      btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
    }
  }

  apply(current());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!stored()) apply(current()); });
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(current()); });

  /* Pages with a [data-theme-slot] get the button there. Shell pages add the slot after load, so it is built on demand. */
  function build() {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'theme-toggle';
    btn.addEventListener('click', function () { var next = current() === 'dark' ? 'light' : 'dark'; save(next); apply(next); });
    apply(current());
    return btn;
  }
  window.KTheme = { mount: function (slot) { if (!btn) build(); slot.appendChild(btn); } };

  document.addEventListener('DOMContentLoaded', function () {
    var slot = document.querySelector('[data-theme-slot]');
    var navActions = document.querySelector('.site-nav .d-flex');   /* landing page: sits beside Sign in */
    if (slot) window.KTheme.mount(slot);
    else if (navActions) { navActions.insertBefore(build(), navActions.firstChild); }
    else if (document.body.hasAttribute('data-theme-float')) { build(); btn.className += ' theme-toggle-float'; document.body.appendChild(btn); }
  });
})();
