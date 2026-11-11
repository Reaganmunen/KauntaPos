/* Test sale: POST /sales with one line paid in cash. The shop's price list and tax settings decide the
   real total, so a "payment is short" reply is shown as is. */
(function () {
  'use strict';
  var K = window.KApp; if (!K) return;
  var $ = function (s) { return document.querySelector(s); };
  var products = [], variant = null, branch = null, cashTouched = false;

  function total() { return variant ? K.num(variant.selling_price) * Math.max(K.num($('#qty').value), 0) : 0; }
  function paint() {
    var t = total(); $('#total').textContent = K.money(t);
    if (!cashTouched) $('#cash').value = t ? String(Math.round(t * 100) / 100) : '';
    $('#saleBtn').disabled = !variant;
  }

  async function pick(id) {
    variant = null; paint(); K.notice($('#saleErr'), '');
    if (!id) return;
    try {
      var p = await K.api('GET', '/products/' + id);
      var vs = (p.variants || []).filter(function (v) { return v.is_active !== false; });
      variant = vs.filter(function (v) { return v.is_default; })[0] || vs[0] || null;
      if (!variant) K.notice($('#saleErr'), 'That product has nothing to sell yet. Add a price on the products page.', 'err');
    } catch (ex) { K.notice($('#saleErr'), ex.message, 'err'); }
    paint();
  }

  async function load() {
    var sel = $('#product');
    try {
      var list = await K.api('GET', '/products?limit=100&is_active=true');
      products = Array.isArray(list) ? list : (list && list.rows) || [];
      sel.textContent = '';
      if (!products.length) { sel.appendChild(K.el('option', 'No products yet')); K.notice($('#saleErr'), 'Add at least one product first.', 'err'); return; }
      sel.appendChild(K.el('option', 'Choose a product')).value = '';
      products.forEach(function (p) { var o = K.el('option', p.name + (p.min_price != null ? '  (' + K.money(p.min_price) + ')' : '')); o.value = p.id; sel.appendChild(o); });
      var b = await K.branches(); branch = b[0] || null;
      if (products.length === 1) { sel.value = products[0].id; pick(products[0].id); }
    } catch (ex) { sel.textContent = ''; sel.appendChild(K.el('option', 'Could not load products')); K.notice($('#saleErr'), ex.message, 'err'); }
  }

  $('#product').addEventListener('change', function () { cashTouched = false; pick(this.value); });
  $('#qty').addEventListener('input', paint);
  $('#cash').addEventListener('input', function () { cashTouched = true; });

  $('#saleForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#saleErr'), btn = $('#saleBtn'); K.notice(err, '');
    var qty = K.num($('#qty').value), cash = K.num($('#cash').value);
    if (!variant) return K.notice(err, 'Choose a product.', 'err');
    if (qty <= 0) return K.notice(err, 'Enter how many.', 'err');
    if (cash <= 0) return K.notice(err, 'Enter the cash received.', 'err');
    K.busy(btn, true, 'Completing...');
    try {
      var headers = branch ? { 'X-Branch-Id': branch.id } : {};
      var sale = await K.api('POST', '/sales', {
        client_uuid: K.uuid(), notes: 'Test sale',
        items: [{ variant_id: variant.id, quantity: qty }],
        payments: [{ method: 'cash', amount: cash }]
      }, headers);
      $('#saleCard').hidden = true; $('#doneCard').hidden = false;
      $('#doneTitle').textContent = 'Sale ' + (sale.sale_number || '') + ' complete';
      var change = cash - K.num(sale.total);
      $('#doneText').textContent = 'Total ' + K.money(sale.total) + ', cash received ' + K.money(cash) + (change > 0.005 ? ', change ' + K.money(change) : '') + '.';
    } catch (ex) {
      var msg = ex.message;
      if (ex.code === 'insufficient_stock') msg += '. Add stock on the products page, or pick another product.';
      K.notice(err, msg, 'err');
    }
    K.busy(btn, false);
  });
  $('#again').addEventListener('click', function () { $('#doneCard').hidden = true; $('#saleCard').hidden = false; cashTouched = false; load(); });
  load();
})();
