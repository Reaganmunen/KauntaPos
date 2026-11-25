/* Promotions: one function that prices offers, used by the till (live preview in the cart) and by the server
   (the amount actually charged), so the two can never disagree.

   An offer (promotion) looks like:
     { id, name, type, priority, starts_at, ends_at, branch_id, variant_ids: [..],
       buy_qty, get_qty, limit_per_sale,          type 'multi_buy'  buy 2 get 1 free
       bundle_qty, bundle_price,                  type 'bundle'     3 for KES 500
       percent_off,                               type 'percent'    15% off
       amount_off }                               type 'amount'     KES 20 off each

   A line looks like: { key, variant_id, quantity, unit_price, locked, weighed }
     locked  = the price was set by hand or by a customer price list, so offers leave it alone.
     weighed = sold by weight: percent and amount offers apply, multi-buys and bundles (which count whole units) do not.

   KPromo.apply(lines, offers, { at, branchId }) ->
     { byKey: { [key]: { discount, promotion_id, name } }, applied: [{ promotion_id, name, discount }], total }
   Rules: offers run in priority order (then oldest first); a line takes part in at most one offer;
   the cheapest units are the free or bundled ones, so an offer never gives away more than it says.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KPromo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TYPES = ['multi_buy', 'bundle', 'percent', 'amount'];

  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function time(v, fallback) { var t = v ? new Date(v).getTime() : NaN; return isNaN(t) ? fallback : t; }

  /** Is the offer switched on and inside its dates right now (or at `at`)? */
  function isLive(p, at) {
    if (!p || p.is_active === false) return false;
    var t = time(at, Date.now());
    if (p.starts_at && time(p.starts_at, -Infinity) > t) return false;
    if (p.ends_at && time(p.ends_at, Infinity) < t) return false;
    return true;
  }

  function fmtNum(n) { return String(Math.round(num(n) * 100) / 100); }

  /** "Buy 2 get 1 free", "3 for KES 500", "15% off", "KES 20 off each". */
  function describe(p, money) {
    var m = money || function (n) { return 'KES ' + fmtNum(n); };
    switch (p && p.type) {
      case 'multi_buy': return 'Buy ' + fmtNum(p.buy_qty) + ' get ' + fmtNum(p.get_qty) + ' free';
      case 'bundle': return fmtNum(p.bundle_qty) + ' for ' + m(p.bundle_price);
      case 'percent': return fmtNum(p.percent_off) + '% off';
      case 'amount': return m(p.amount_off) + ' off each';
      default: return '';
    }
  }

  /** Why an offer cannot be saved, or null when it is fine. */
  function problem(p) {
    if (!p || TYPES.indexOf(p.type) < 0) return 'Choose the kind of offer.';
    var whole = function (v) { return num(v) >= 1 && Math.floor(num(v)) === num(v); };
    if (p.type === 'multi_buy') {
      if (!whole(p.buy_qty)) return 'Buy quantity must be a whole number, 1 or more.';
      if (!whole(p.get_qty)) return 'Free quantity must be a whole number, 1 or more.';
      if (p.limit_per_sale != null && p.limit_per_sale !== '' && !whole(p.limit_per_sale)) return 'The limit per sale must be a whole number, 1 or more.';
    } else if (p.type === 'bundle') {
      if (!whole(p.bundle_qty) || num(p.bundle_qty) < 2) return 'A bundle needs 2 or more items.';
      if (p.bundle_price == null || p.bundle_price === '' || num(p.bundle_price) < 0) return 'Enter the bundle price.';
    } else if (p.type === 'percent') {
      if (!(num(p.percent_off) > 0 && num(p.percent_off) <= 100)) return 'Percent off must be more than 0 and at most 100.';
    } else if (p.type === 'amount') {
      if (!(num(p.amount_off) > 0)) return 'Enter the amount off each item.';
    }
    if (p.starts_at && p.ends_at && time(p.ends_at, 0) <= time(p.starts_at, 0)) return 'The end must be after the start.';
    return null;
  }

  /* Whole units of each line, cheapest line first. Weighed lines never take part. */
  function unitPool(lines) {
    return lines
      .filter(function (l) { return !l.weighed; })
      .map(function (l) { return { line: l, units: Math.floor(num(l.quantity) + 1e-9), price: num(l.unit_price) }; })
      .filter(function (u) { return u.units > 0; })
      .sort(function (a, b) { return a.price - b.price; });
  }

  function gross(l) { return r2(num(l.quantity) * num(l.unit_price)); }

  /* Each compute function returns [{ key, discount }] for the lines it used. */
  var COMPUTE = {
    percent: function (p, lines) {
      return lines.map(function (l) { return { key: l.key, discount: r2(gross(l) * num(p.percent_off) / 100) }; });
    },
    amount: function (p, lines) {
      return lines.map(function (l) { return { key: l.key, discount: Math.min(gross(l), r2(num(p.amount_off) * num(l.quantity))) }; });
    },
    multi_buy: function (p, lines) {
      var pool = unitPool(lines), units = pool.reduce(function (s, u) { return s + u.units; }, 0);
      var size = num(p.buy_qty) + num(p.get_qty), groups = size > 0 ? Math.floor(units / size) : 0;
      if (num(p.limit_per_sale) >= 1) groups = Math.min(groups, Math.floor(num(p.limit_per_sale)));
      var free = groups * num(p.get_qty), out = [];
      pool.forEach(function (u) {
        var take = Math.min(free, u.units); free -= take;
        if (take > 0) out.push({ key: u.line.key, discount: r2(take * u.price) });
      });
      return out;
    },
    bundle: function (p, lines) {
      var pool = unitPool(lines), units = pool.reduce(function (s, u) { return s + u.units; }, 0);
      var q = num(p.bundle_qty), groups = q >= 2 ? Math.floor(units / q) : 0;
      if (!groups) return [];
      var left = groups * q, used = [], worth = 0;
      pool.forEach(function (u) {
        var take = Math.min(left, u.units); left -= take;
        if (take > 0) { used.push({ key: u.line.key, value: take * u.price }); worth += take * u.price; }
      });
      var saving = r2(worth - groups * num(p.bundle_price));
      if (!(saving > 0) || !(worth > 0)) return [];
      var rest = saving;
      return used.map(function (x, i) {
        var d = i === used.length - 1 ? rest : Math.min(r2(saving * x.value / worth), rest);
        rest = r2(rest - d);
        return { key: x.key, discount: d };
      });
    },
  };

  function apply(lines, offers, opts) {
    var o = opts || {}, byKey = {}, applied = [], total = 0, taken = {};
    var live = (offers || []).filter(function (p) {
      return isLive(p, o.at) && (!p.branch_id || !o.branchId || String(p.branch_id) === String(o.branchId));
    }).map(function (p, i) { return { p: p, i: i }; }).sort(function (a, b) {
      return (num(b.p.priority) - num(a.p.priority)) || (a.i - b.i);
    });

    live.forEach(function (entry) {
      var p = entry.p, compute = COMPUTE[p.type];
      if (!compute || problem(p)) return;
      var set = {}; (p.variant_ids || []).forEach(function (id) { set[id] = true; });
      var eligible = (lines || []).filter(function (l) {
        return !taken[l.key] && !l.locked && set[l.variant_id] && num(l.unit_price) > 0 && num(l.quantity) > 0;
      });
      if (!eligible.length) return;
      var parts = compute(p, eligible).filter(function (x) { return x.discount > 0; }), sum = 0;
      parts.forEach(function (x) {
        var line = eligible.filter(function (l) { return l.key === x.key; })[0];
        var d = Math.min(x.discount, gross(line));
        byKey[x.key] = { discount: d, promotion_id: p.id, name: p.name }; taken[x.key] = true; sum += d;
      });
      if (sum > 0) { applied.push({ promotion_id: p.id, name: p.name, discount: r2(sum) }); total += sum; }
    });
    return { byKey: byKey, applied: applied, total: r2(total) };
  }

  return { TYPES: TYPES, apply: apply, isLive: isLive, describe: describe, problem: problem };
});
