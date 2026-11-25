/* Price / weight labels printed by a shop scale (EAN-13 that starts with a private prefix such as 2).
   One file, used by the till in the browser and by the server when it checks the shop's settings.

   A label is laid out as:   prefix + item code (PLU) + [one check digit of the value] + value + EAN check digit
   The shop tells Kaunta its layout once (Products > Scale labels). Defaults: 2 + 6-digit PLU + 5-digit value.

     KScale.normalize(settings)       -> { ok, config, error }
     KScale.parse(code, config)       -> null (not a scale label) | { ok:false, reason } | { ok:true, plu, kind, quantity | amount }
     KScale.normalizePlu('000123')    -> '123'
     KScale.describe(config)          -> '2 PPPPPP VVVVV C'
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KScale = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    prefix: '2',
    plu_length: 6,
    value_check_digit: false,   // some scales print a check digit just before the value
    value_length: 5,
    value_type: 'weight',       // what the value means: 'weight' or 'price'
    decimals: 3,                // weight in grams -> 3 (kg). price in cents -> 2
    verify_check_digit: true,
  };

  function toInt(v, fallback) { var n = parseInt(v, 10); return isFinite(n) ? n : fallback; }

  function normalize(input) {
    var s = input && typeof input === 'object' ? input : {};
    var c = {
      enabled: s.enabled === undefined ? DEFAULTS.enabled : Boolean(s.enabled),
      prefix: String(s.prefix === undefined ? DEFAULTS.prefix : s.prefix).trim(),
      plu_length: toInt(s.plu_length, DEFAULTS.plu_length),
      value_check_digit: s.value_check_digit === undefined ? DEFAULTS.value_check_digit : Boolean(s.value_check_digit),
      value_length: toInt(s.value_length, DEFAULTS.value_length),
      value_type: s.value_type === 'price' ? 'price' : 'weight',
      decimals: toInt(s.decimals, s.value_type === 'price' ? 2 : DEFAULTS.decimals),
      verify_check_digit: s.verify_check_digit === undefined ? DEFAULTS.verify_check_digit : Boolean(s.verify_check_digit),
    };
    function bad(error) { return { ok: false, config: c, error: error }; }
    if (!/^[0-9]{1,3}$/.test(c.prefix)) return bad('The label prefix is one to three digits, for example 2.');
    if (c.plu_length < 1 || c.plu_length > 8) return bad('The item code is between 1 and 8 digits.');
    if (c.value_length < 3 || c.value_length > 7) return bad('The weight or price is between 3 and 7 digits.');
    if (c.decimals < 0 || c.decimals > 4) return bad('Decimals must be between 0 and 4.');
    var total = c.prefix.length + c.plu_length + (c.value_check_digit ? 1 : 0) + c.value_length + 1;
    if (total !== 13) return bad('These parts add up to ' + total + ' digits. A scale label has 13, so adjust the lengths by ' + (13 - total > 0 ? '+' : '') + (13 - total) + '.');
    return { ok: true, config: c, error: null };
  }

  function checkDigit(first12) {
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += Number(first12.charAt(i)) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
  }

  function normalizePlu(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, '');
    return d || (String(v || '').replace(/\D/g, '') ? '0' : '');
  }

  function parse(code, cfg) {
    var n = cfg && cfg.config ? cfg : normalize(cfg);
    if (!n.ok || !n.config.enabled) return null;
    var c = n.config, s = String(code == null ? '' : code).trim();
    if (!/^[0-9]{13}$/.test(s) || s.indexOf(c.prefix) !== 0) return null;
    if (c.verify_check_digit && checkDigit(s.slice(0, 12)) !== Number(s.charAt(12))) return { ok: false, reason: 'check_digit' };
    var at = c.prefix.length;
    var plu = s.substr(at, c.plu_length); at += c.plu_length + (c.value_check_digit ? 1 : 0);
    var value = Number(s.substr(at, c.value_length)) / Math.pow(10, c.decimals);
    var out = { ok: true, plu: normalizePlu(plu), kind: c.value_type };
    if (c.value_type === 'price') out.amount = Math.round(value * 100) / 100;
    else out.quantity = Math.round(value * 1000) / 1000;
    return out;
  }

  function describe(cfg) {
    var n = cfg && cfg.config ? cfg : normalize(cfg), c = n.config;
    function rep(ch, k) { return new Array(Math.max(k, 0) + 1).join(ch); }
    return [c.prefix, rep('P', c.plu_length)].concat(c.value_check_digit ? ['K'] : []).concat([rep('V', c.value_length), 'C']).join(' ');
  }

  return { DEFAULTS: DEFAULTS, normalize: normalize, parse: parse, normalizePlu: normalizePlu, checkDigit: checkDigit, describe: describe };
});
