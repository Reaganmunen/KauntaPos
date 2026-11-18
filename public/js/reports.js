/* Reports. Every block loads on its own, so one failing report never blanks the page.
   GET /reports/dashboard, /sales, /top-products, /by-category, /payment-methods, /profit,
   /vat, /cashiers, /stock-value. The sales chart is drawn here as plain SVG, no chart library. */
(function () {
  'use strict';
  var K = window.KApp;
  if (!K) { console.error('reports.js: window.KApp is missing. js/config.js, js/app.js or js/shell.js did not load or did not define it.'); return; }

  var $ = function (s) { return document.querySelector(s); };
  var NS = 'http://www.w3.org/2000/svg';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var METHOD = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', credit: 'On credit', bank_transfer: 'Bank transfer', other: 'Other' };
  var S = { period: 'last_30_days', from: '', to: '', branch: '', group: 'day', by: 'revenue', token: 0, range: null, sales: null, data: {} };

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function sv(tag, attrs, parent) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (parent) parent.appendChild(e); return e; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) { return K.money(num(v)); }
  function sum(rows, key) { return (rows || []).reduce(function (t, r) { return t + num(r[key]); }, 0); }
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.data || d.items)) || []; }
  function failText(ex) { return ex && ex.status === 403 ? 'Your role does not include this report.' : (ex && ex.message) || 'We could not load this.'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function compact(v) {
    var a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e6) return s + +(a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + +(a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return s + Math.round(a);
  }
  function addDays(ds, n) { var d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  function dmy(ds, withYear) { var p = ds.slice(0, 10).split('-'); return +p[2] + ' ' + MON[+p[1] - 1] + (withYear ? ' ' + p[0] : ''); }
  function labelOf(b, g) {
    if (g === 'hour') return b.slice(11, 16);
    if (g === 'month') { var p = b.split('-'); return MON[+p[1] - 1] + ' ' + p[0]; }
    return dmy(b);
  }
  function fullLabel(b, g) {
    if (g === 'hour') return dmy(b) + ', ' + b.slice(11, 16);
    if (g === 'week') return 'Week of ' + dmy(b, true);
    if (g === 'month') return labelOf(b, g);
    return dmy(b, true);
  }
  function skeleton(box, n) { box.textContent = ''; for (var i = 0; i < (n || 3); i++) box.appendChild(el('div', 'sk-row')); }
  function empty(box, text) { box.textContent = ''; box.appendChild(el('p', 'rp-empty', text)); }
  function failed(box, ex, retry) {
    box.textContent = ''; var w = el('div', 'rp-err'); w.appendChild(el('span', null, failText(ex)));
    var b = el('button', 'btn sm', 'Try again'); b.type = 'button'; b.addEventListener('click', retry); w.appendChild(b); box.appendChild(w);
  }

  /* ---------- query building ---------- */
  function rangeParts() {
    var p = [];
    if (S.period === 'custom') { if (S.from) p.push('from=' + S.from); if (S.to) p.push('to=' + S.to); }
    else p.push('period=' + S.period);
    if (S.branch) p.push('branch_id=' + encodeURIComponent(S.branch));
    return p;
  }
  function url(path, extra) { var p = rangeParts().concat(extra || []); return path + (p.length ? '?' + p.join('&') : ''); }
  function branchUrl(path) { return path + (S.branch ? '?branch_id=' + encodeURIComponent(S.branch) : ''); }

  // Loads one block. A newer load() call makes older answers get dropped.
  function block(key, path, sel, render, rows) {
    var box = $(sel), tk = S.token; skeleton(box, rows);
    return K.api('GET', path).then(function (d) {
      if (tk !== S.token) return null;
      S.data[key] = d; render(d, box); return d;
    }).catch(function (ex) {
      if (tk !== S.token) return null;
      failed(box, ex, function () { block(key, path, sel, render, rows); });
      return null;
    });
  }

  /* ---------- horizontal bars ---------- */
  function hbars(box, rows, format) {
    box.textContent = '';
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.value); }).concat([0])) || 1;
    rows.forEach(function (r) {
      var row = el('div', 'rp-row'), t = el('div', 'rp-row-t');
      var name = el('span', 'rp-name', r.label); name.title = r.label; t.appendChild(name); t.appendChild(el('span', 'rp-val', format(r.value))); row.appendChild(t);
      var track = el('div', 'rp-track'), fill = el('span', 'rp-fill' + (r.value < 0 ? ' neg' : ''));
      fill.style.width = Math.max(1, Math.abs(r.value) / max * 100) + '%'; track.appendChild(fill); row.appendChild(track);
      if (r.sub) row.appendChild(el('div', 'rp-sub', r.sub));
      box.appendChild(row);
    });
  }

  /* ---------- sales trend (SVG) ---------- */
  function niceTicks(min, max) {
    if (max === min) { max = min + 1; }
    var rough = (max - min) / 4, mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10)), n = rough / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    var out = []; for (var v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 1000; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function showTip(box, html, cx, topY) {
    var tip = $('#tip'); tip.textContent = '';
    var b = el('b', null, html[0]); tip.appendChild(b); html.slice(1).forEach(function (l) { tip.appendChild(el('span', null, l)); });
    tip.hidden = false; box.appendChild(tip);
    var w = tip.offsetWidth, h = tip.offsetHeight, bw = box.clientWidth;
    tip.style.left = Math.max(0, Math.min(bw - w, cx - w / 2)) + 'px';
    tip.style.top = Math.max(0, topY - h - 8) + 'px';
  }
  function hideTip() { $('#tip').hidden = true; }

  function drawTrend() {
    var box = $('#chart'); if (!box || !S.data.sales) return;
    var series = S.data.sales.series || [], g = S.data.sales.group_by || S.group;
    var saved = $('#tip'); if (saved.parentNode === box) document.body.appendChild(saved); hideTip();
    box.textContent = '';
    var vals = series.map(function (r) { return num(r.net_sales); });
    var W = Math.max(280, box.clientWidth || 600), H = W < 480 ? 220 : 280, m = { l: 46, r: 6, t: 10, b: 26 };
    var ticks = niceTicks(Math.min(0, Math.min.apply(null, vals)), Math.max(0, Math.max.apply(null, vals)));
    var lo = ticks[0], hi = ticks[ticks.length - 1], iw = W - m.l - m.r, ih = H - m.t - m.b;
    var y = function (v) { return m.t + ih - (v - lo) / (hi - lo) * ih; };
    var svg = sv('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Net sales by ' + g + ', ' + series.length + ' bars' }, box);

    ticks.forEach(function (t) {
      sv('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), 'class': t === 0 ? 'zero' : 'grid' }, svg);
      var tx = sv('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg); tx.textContent = compact(t);
    });

    var n = series.length, slot = iw / n, bw = Math.min(40, Math.max(3, slot * 0.7));
    var best = vals.indexOf(Math.max.apply(null, vals)), every = Math.ceil(n / Math.max(1, Math.floor(iw / 64)));
    series.forEach(function (r, i) {
      var v = vals[i], x = m.l + slot * i + (slot - bw) / 2, y0 = y(0), yv = y(v);
      var top = Math.min(y0, yv), h = Math.max(v === 0 ? 0 : 1, Math.abs(yv - y0));
      var bar = sv('rect', { x: x, y: top, width: bw, height: h, rx: Math.min(3, bw / 3), 'class': 'bar' + (v < 0 ? ' neg' : '') + (i === best && v > 0 ? ' best' : ''), tabindex: 0, 'aria-label': fullLabel(r.bucket, g) + ': ' + money(v) }, svg);
      var hit = sv('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ih, 'class': 'hit' }, svg);
      var lines = [fullLabel(r.bucket, g), money(v) + ' net', plural(num(r.sales_count), 'sale', 'sales')];
      if (num(r.refunds) > 0) lines.push(money(r.refunds) + ' refunded');
      var on = function () { showTip(box, lines, m.l + slot * i + slot / 2, top); };
      hit.addEventListener('mouseenter', on); hit.addEventListener('mouseleave', hideTip); hit.addEventListener('click', on);
      bar.addEventListener('focus', on); bar.addEventListener('blur', hideTip);
      if (i % every === 0) { var lx = sv('text', { x: m.l + slot * i + slot / 2, y: H - 8, 'text-anchor': 'middle' }, svg); lx.textContent = labelOf(r.bucket, g); }
    });
  }

  /* ---------- renderers ---------- */
  function paintRange(r) {
    if (!r) return;
    var one = r.from_date === r.to_date;
    $('#rangeLabel').textContent = (one ? dmy(r.from_date, true) : dmy(r.from_date, r.from_date.slice(0, 4) !== r.to_date.slice(0, 4)) + ' to ' + dmy(r.to_date, true)) + (S.branch ? '' : ' · all branches');
  }

  function renderSales(d, box) {
    var series = d.series || [];
    S.range = d.range; paintRange(d.range);
    var net = sum(series, 'net_sales'), gross = sum(series, 'gross_sales'), refunds = sum(series, 'refunds'), count = sum(series, 'sales_count'), disc = sum(series, 'discounts');
    S.sales = { net: net, gross: gross, refunds: refunds, count: count, disc: disc };
    renderFigures();
    box.textContent = '';
    if (!series.length || (net === 0 && gross === 0 && refunds === 0)) { empty(box, 'No sales in this range yet. Pick another period or branch.'); return; }

    var top = el('div', 'rp-top'), left = el('div');
    left.appendChild(el('div', 'rp-big', money(net)));
    left.appendChild(el('div', 'rp-cap', 'Net sales, after refunds · ' + plural(count, 'sale', 'sales')));
    top.appendChild(left);
    var delta = el('div', 'rp-delta flat'); delta.id = 'delta'; top.appendChild(delta);
    box.appendChild(top);
    var chart = el('div', 'rp-chart'); chart.id = 'chart'; box.appendChild(chart);
    drawTrend();
    loadDelta(S.token, net);
  }

  function loadDelta(tk, net) {
    var r = S.range; if (!r) return;
    var n = daysBetween(r.from_date, r.to_date) + 1, pt = addDays(r.from_date, -1), pf = addDays(pt, -(n - 1));
    var p = ['from=' + pf, 'to=' + pt, 'group_by=month']; if (S.branch) p.push('branch_id=' + encodeURIComponent(S.branch));
    K.api('GET', '/reports/sales?' + p.join('&')).then(function (d) {
      if (tk !== S.token) return;
      var prev = sum(d.series, 'net_sales'), box = $('#delta'); if (!box) return;
      var span = n === 1 ? 'the day before' : 'the previous ' + n + ' days';
      if (prev === 0) { box.textContent = net > 0 ? 'No sales in ' + span : ''; return; }
      var ch = (net - prev) / Math.abs(prev) * 100;
      box.className = 'rp-delta ' + (Math.abs(ch) < 0.05 ? 'flat' : ch > 0 ? 'up' : 'down');
      box.textContent = (ch > 0 ? '+' : ch < 0 ? '-' : '') + Math.abs(ch).toFixed(1) + '% vs ' + span;
    }).catch(function () { /* the comparison is optional */ });
  }

  function fig(label, value, sub, neg) {
    var f = el('div', 'rp-fig'); f.appendChild(el('small', null, label)); f.appendChild(el('b', neg ? 'neg' : '', value));
    if (sub) f.appendChild(el('span', null, sub)); return f;
  }
  function renderFigures() {
    var box = $('#b-figures'), s = S.sales, p = S.data.profit; box.textContent = '';
    box.appendChild(fig('Gross profit', p ? money(p.gross_profit) : '—', p ? num(p.margin_percent).toFixed(1) + '% margin' : '', p && num(p.gross_profit) < 0));
    box.appendChild(fig('Net profit', p ? money(p.net_profit) : '—', p ? 'After ' + money(p.expenses) + ' expenses' : '', p && num(p.net_profit) < 0));
    box.appendChild(fig('Sales made', s ? String(s.count) : '—', s && s.count ? 'Average ' + money(s.gross / s.count) : ''));
    box.appendChild(fig('Refunds', s ? money(s.refunds) : '—', s && s.disc ? money(s.disc) + ' given as discounts' : ''));
  }

  function renderProfit(d, box) {
    S.data.profit = d; renderFigures();
    var rev = num(d.revenue), cogs = num(d.cost_of_goods), exp = num(d.expenses), net = num(d.net_profit);
    if (!rev && !cogs && !exp) { empty(box, 'No sales or expenses in this range.'); return; }
    box.textContent = '';
    var base = Math.max(rev, cogs + exp, 1), bar = el('div', 'rp-split');
    [['cogs', cogs], ['exp', exp], ['net', Math.max(0, net)]].forEach(function (s) { var sp = el('span', s[0]); sp.style.width = (s[1] / base * 100) + '%'; bar.appendChild(sp); });
    box.appendChild(bar);
    var lg = el('div', 'rp-legend');
    function line(cls, label, value, extra) { var r = el('div', extra || ''), l = el('span'); l.appendChild(el('i', cls)); l.appendChild(document.createTextNode(label)); r.appendChild(l); r.appendChild(el('span', 'num', value)); lg.appendChild(r); }
    line('', 'Revenue, excluding VAT', money(rev), 'tot');
    line('cogs', 'Cost of goods sold', money(cogs));
    line('exp', 'Expenses', money(exp));
    line(net < 0 ? 'loss' : 'net', net < 0 ? 'Loss' : 'Net profit', money(net), 'tot');
    box.appendChild(lg);
    if (net < 0) box.appendChild(el('p', 'rp-warn', 'You spent ' + money(-net) + ' more than you earned in this range.'));

    var eb = rowsOf(d.expense_breakdown).map(function (c) { return { label: c.category || 'Uncategorised', value: num(c.total), sub: plural(num(c.count), 'expense', 'expenses') }; });
    var ebox = $('#b-exp');
    if (!eb.length) empty(ebox, 'No expenses recorded in this range.'); else hbars(ebox, eb, money);
  }

  function renderPay(d, box) {
    var rows = rowsOf(d.methods).map(function (r) {
      var raw = r.method || r.payment_method || r.name || 'other', v = num(r.total !== undefined ? r.total : r.amount !== undefined ? r.amount : r.net !== undefined ? r.net : r.net_total);
      return { label: METHOD[raw] || String(raw).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }), value: v, sub: r.count !== undefined ? plural(num(r.count), 'payment', 'payments') : '' };
    }).filter(function (r) { return r.value !== 0; }).sort(function (a, b) { return b.value - a.value; });
    if (!rows.length) { empty(box, 'No payments in this range.'); return; }
    hbars(box, rows, money);
  }

  function renderProducts(d, box) {
    var by = S.by, fmt = by === 'quantity' ? function (v) { return String(+v.toFixed(2)); } : money;
    var rows = rowsOf(d.products).map(function (p) {
      var name = (p.product_name || 'Product') + (p.variant_name && p.variant_name !== 'Default' ? ' · ' + p.variant_name : '');
      return { label: name, value: num(p[by]), sub: [by !== 'quantity' ? +num(p.quantity).toFixed(2) + ' sold' : money(p.revenue), by !== 'profit' ? money(p.profit) + ' profit' : money(p.revenue) + ' revenue'].join(' · ') };
    });
    if (!rows.length) { empty(box, 'No products sold in this range.'); return; }
    hbars(box, rows, fmt);
  }

  function renderCats(d, box) {
    var rows = rowsOf(d.categories).map(function (c) { return { label: c.category || 'Uncategorised', value: num(c.revenue), sub: num(c.share_percent).toFixed(1) + '% of revenue · ' + money(c.profit) + ' profit' }; });
    if (!rows.length) { empty(box, 'No category sales in this range.'); return; }
    hbars(box, rows, money);
  }

  function table(head, rows, foot, rightFrom) {
    var wrap = el('div', 'scroll'), tb = el('table'), th = el('thead'), tr = el('tr');
    head.forEach(function (h, i) { tr.appendChild(el('th', i >= rightFrom ? 'r' : '', h)); }); th.appendChild(tr); tb.appendChild(th);
    var body = el('tbody'); rows.forEach(function (r) { var x = el('tr'); r.forEach(function (c, i) { x.appendChild(el('td', i >= rightFrom ? 'r num' : '', c)); }); body.appendChild(x); }); tb.appendChild(body);
    if (foot) { var f = el('tfoot'), fr = el('tr'); foot.forEach(function (c, i) { fr.appendChild(el('td', i >= rightFrom ? 'r num' : '', c)); }); f.appendChild(fr); tb.appendChild(f); }
    wrap.appendChild(tb); return wrap;
  }

  function renderCash(d, box) {
    var list = rowsOf(d.cashiers);
    if (!list.length) { empty(box, 'No cashier sales in this range.'); return; }
    box.textContent = '';
    var max = Math.max.apply(null, list.map(function (c) { return num(c.net_sales); }).concat([1]));
    var rows = list.map(function (c) { return { label: c.cashier || 'Unknown', value: num(c.net_sales), sub: plural(num(c.sales_count), 'sale', 'sales') + ' · average ' + money(c.average_sale) + (num(c.refunds_count) ? ' · ' + plural(num(c.refunds_count), 'refund', 'refunds') : '') }; });
    hbars(box, rows, money);
    void max;
  }

  function renderVat(d, box) {
    var list = rowsOf(d.tax);
    if (!list.length) { empty(box, 'No taxable sales in this range.'); return; }
    box.textContent = '';
    var rows = list.map(function (t) { return [t.tax_code || '-', t.tax_rate === null || t.tax_rate === undefined ? '' : num(t.tax_rate) + '%', money(t.taxable_amount), money(t.tax_amount), money(t.gross_amount)]; });
    box.appendChild(table(['Tax code', 'Rate', 'Taxable amount', 'VAT', 'Total'], rows, ['Total', '', money(sum(list, 'taxable_amount')), money(sum(list, 'tax_amount')), money(sum(list, 'gross_amount'))], 1));
  }

  function renderStock(d, box) {
    var list = rowsOf(d.branches), t = d.total || { cost_value: 0, retail_value: 0 };
    if (!list.length || (!num(t.cost_value) && !num(t.retail_value))) { empty(box, 'No stock on hand.'); return; }
    box.textContent = '';
    var tot = el('div', 'rp-stock-tot');
    [['At cost', money(t.cost_value)], ['At selling price', money(t.retail_value)], ['Potential margin', money(num(t.retail_value) - num(t.cost_value))]].forEach(function (x) { var c = el('div'); c.appendChild(el('small', null, x[0])); c.appendChild(el('b', null, x[1])); tot.appendChild(c); });
    box.appendChild(tot);
    var max = Math.max.apply(null, list.map(function (b) { return Math.max(num(b.cost_value), num(b.retail_value)); }).concat([1]));
    list.forEach(function (b) {
      var p = el('div', 'rp-pair'), t1 = el('div', 'rp-row-t'); t1.appendChild(el('span', 'rp-name', b.branch_name || 'Branch')); p.appendChild(t1);
      [['cost', b.cost_value], ['retail', b.retail_value]].forEach(function (x) { var tr = el('div', 'rp-track'), f = el('span', 'rp-fill ' + x[0]); f.style.width = Math.max(1, num(x[1]) / max * 100) + '%'; tr.appendChild(f); p.appendChild(tr); });
      var sub = el('div', 'rp-sub'); sub.appendChild(el('span', 'num', 'Cost ' + money(b.cost_value))); sub.appendChild(el('span', 'num', 'Selling price ' + money(b.retail_value))); p.appendChild(sub);
      box.appendChild(p);
    });
  }

  function renderAttn(d, box) {
    var a = (d && d.attention) || {}, items = [];
    function add(n, text, href, soft) { if (num(n) > 0) items.push({ text: text, href: href, soft: soft }); }
    add(a.low_stock_count, plural(num(a.low_stock_count), 'product is', 'products are') + ' low on stock');
    add(a.expiring_30_days, plural(num(a.expiring_30_days), 'batch expires', 'batches expire') + ' within 30 days');
    add(a.open_tabs, plural(num(a.open_tabs), 'open tab', 'open tabs'), null, true);
    add(a.unmatched_mpesa_payments, plural(num(a.unmatched_mpesa_payments), 'M-Pesa payment', 'M-Pesa payments') + ' not matched to a sale');
    if (a.etims) {
      add(a.etims.failed, plural(num(a.etims.failed), 'eTIMS receipt needs', 'eTIMS receipts need') + ' attention', 'etims-invoices.html');
      add(a.etims.pending, plural(num(a.etims.pending), 'receipt is', 'receipts are') + ' waiting to go to KRA', 'etims-invoices.html', true);
    }
    if (num(a.customers_owe) > 0) items.push({ text: money(a.customers_owe) + ' owed by customers', soft: true });
    box.textContent = '';
    if (!items.length) { var ok = el('span', 'ok'); ok.appendChild(el('i')); ok.appendChild(document.createTextNode('Nothing needs attention right now')); box.appendChild(ok); return; }
    items.forEach(function (it) { var n = it.href ? el('a', it.soft ? 'soft' : '') : el('span', it.soft ? 'soft' : ''); if (it.href) n.href = it.href; n.appendChild(el('i')); n.appendChild(document.createTextNode(it.text)); box.appendChild(n); });
  }

  /* ---------- loading ---------- */
  function loadSales() { return block('sales', url('/reports/sales', ['group_by=' + S.group]), '#b-sales', renderSales, 4); }
  function loadProducts() { return block('products', url('/reports/top-products', ['by=' + S.by, 'limit=10']), '#b-products', renderProducts, 5); }
  function loadAll() {
    S.token++; S.data = {}; S.sales = null; hideTip(); renderFigures();
    loadSales();
    block('profit', url('/reports/profit'), '#b-profit', renderProfit, 4);
    $('#b-exp').textContent = ''; skeleton($('#b-exp'), 3);
    block('pay', url('/reports/payment-methods'), '#b-pay', renderPay, 3);
    loadProducts();
    block('cats', url('/reports/by-category'), '#b-cats', renderCats, 4);
    block('cash', url('/reports/cashiers'), '#b-cash', renderCash, 3);
    block('vat', url('/reports/vat'), '#b-vat', renderVat, 2);
    block('stock', branchUrl('/reports/stock-value'), '#b-stock', renderStock, 2);
    block('attn', branchUrl('/reports/dashboard'), '#b-attn', renderAttn, 1);
  }

  /* ---------- CSV ---------- */
  function csv(name, head, rows) {
    var guard = function (c) { if (typeof c === 'number') return c; var s = String(c === null || c === undefined ? '' : c); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    var text = [head].concat(rows).map(function (r) { return r.map(function (c) { return '"' + String(guard(c)).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var a = document.createElement('a'), url2 = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
    a.href = url2; a.download = name + (S.range ? '-' + S.range.from_date + '-to-' + S.range.to_date : '') + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url2); }, 1000);
  }
  function needData(key) { if (S.data[key]) return true; K.toast('That report has not loaded yet.'); return false; }
  $('#csvSales').addEventListener('click', function () {
    if (!needData('sales')) return;
    csv('sales', ['Period', 'Sales', 'Gross sales', 'Refunds', 'Net sales', 'Tax', 'Discounts'],
      (S.data.sales.series || []).map(function (r) { return [r.bucket, num(r.sales_count), num(r.gross_sales), num(r.refunds), num(r.net_sales), num(r.tax), num(r.discounts)]; }));
  });
  $('#csvProducts').addEventListener('click', function () {
    if (!needData('products')) return;
    csv('top-products-by-' + S.by, ['Product', 'Variant', 'SKU', 'Quantity', 'Revenue', 'Profit'],
      rowsOf(S.data.products.products).map(function (p) { return [p.product_name, p.variant_name, p.sku, num(p.quantity), num(p.revenue), num(p.profit)]; }));
  });
  $('#csvCash').addEventListener('click', function () {
    if (!needData('cash')) return;
    csv('cashiers', ['Cashier', 'Sales', 'Gross sales', 'Refunds', 'Net sales', 'Average sale', 'Discounts'],
      rowsOf(S.data.cash.cashiers).map(function (c) { return [c.cashier, num(c.sales_count), num(c.gross_sales), num(c.refunds), num(c.net_sales), num(c.average_sale), num(c.discounts)]; }));
  });
  $('#csvVat').addEventListener('click', function () {
    if (!needData('vat')) return;
    csv('vat', ['Tax code', 'Rate', 'Taxable amount', 'VAT', 'Total'],
      rowsOf(S.data.vat.tax).map(function (t) { return [t.tax_code, t.tax_rate === null || t.tax_rate === undefined ? '' : num(t.tax_rate), num(t.taxable_amount), num(t.tax_amount), num(t.gross_amount)]; }));
  });

  /* ---------- controls ---------- */
  function press(group, attr, value) { document.querySelectorAll(group + ' button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset[attr] === value)); }); }
  function autoGroup() {
    if (S.period === 'today' || S.period === 'yesterday') return 'hour';
    if (S.period === 'year') return 'month';
    if (S.period === 'custom') {
      var f = S.from || S.to, t = S.to || S.from; if (!f) return 'day';
      var n = daysBetween(f, t) + 1; return n <= 2 ? 'hour' : n <= 62 ? 'day' : n <= 180 ? 'week' : 'month';
    }
    return 'day';
  }
  function setPeriod(p) {
    S.period = p; press('#period', 'p', p); $('#customBox').hidden = p !== 'custom';
    if (p === 'custom') { if (!S.from && !S.to) return; }
    S.group = autoGroup(); press('#group', 'g', S.group); loadAll();
  }
  document.querySelectorAll('#period button').forEach(function (b) { b.addEventListener('click', function () { setPeriod(b.dataset.p); }); });
  function onCustom() { S.from = $('#cFrom').value; S.to = $('#cTo').value; if (S.from && S.to && S.from > S.to) { K.toast('The start date must not be after the end date.'); return; } if (S.from || S.to) setPeriod('custom'); }
  $('#cFrom').addEventListener('change', onCustom); $('#cTo').addEventListener('change', onCustom);
  document.querySelectorAll('#group button').forEach(function (b) { b.addEventListener('click', function () { S.group = b.dataset.g; press('#group', 'g', S.group); S.token++; loadSales(); }); });
  document.querySelectorAll('#by button').forEach(function (b) { b.addEventListener('click', function () { S.by = b.dataset.b; press('#by', 'b', S.by); loadProducts(); }); });
  $('#branch').addEventListener('change', function () { S.branch = this.value; loadAll(); });
  $('#refresh').addEventListener('click', loadAll);
  $('#print').addEventListener('click', function () { window.print(); });

  var rt = null;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawTrend, 150); });

  /* ---------- start ---------- */
  console.info('reports.js: loaded');
  K.api('GET', '/branches').then(function (d) {
    var sel = $('#branch'); rowsOf(d).forEach(function (b) { var o = document.createElement('option'); o.value = b.id; o.textContent = b.name || ''; sel.appendChild(o); });
  }).catch(function () { /* the branch filter is optional */ });
  loadAll();
})();