/* BassBox admin panel — vanilla JS single-page app */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (d) => new Date(d).toLocaleString();
  let token = sessionStorage.getItem('bb_admin_token');
  let cache = {};

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api/admin' + path, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500); }
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

  /* ---------------- auth ---------------- */
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    const data = await res.json();
    if (!res.ok) return ($('#login-err').textContent = data.error);
    token = data.token; sessionStorage.setItem('bb_admin_token', token); f.reset(); start();
  });
  function logout() {
    if (token) fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    token = null; sessionStorage.removeItem('bb_admin_token');
    $('#app-view').classList.add('hidden'); $('#login-view').classList.remove('hidden');
  }
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');

  /* ---------------- router ---------------- */
  const views = {};
  async function go() {
    const v = (location.hash || '#dashboard').slice(1);
    const view = views[v] ? v : 'dashboard';
    $$('#nav a[data-v]').forEach((a) => a.classList.toggle('on', a.dataset.v === view));
    $('#sidebar').classList.remove('open');
    $('#view-actions').innerHTML = '';
    $('#view').innerHTML = '<p class="muted">Loading…</p>';
    try { await views[view](); } catch (e) { $('#view').innerHTML = `<div class="panel" style="color:#b91c1c">${esc(e.message)}</div>`; }
    refreshCounts();
  }
  addEventListener('hashchange', go);
  async function refreshCounts() {
    try {
      const s = await api('/stats');
      $('#c-orders').textContent = s.pendingOrders || '';
      $('#c-reviews').textContent = s.pendingReviews || '';
      $('#c-messages').textContent = s.unreadMessages || '';
    } catch {}
  }
  const title = (t, actions = '') => { $('#view-title').textContent = t; $('#view-actions').innerHTML = actions; document.title = t + ' | Admin'; };

  /* ---------------- dashboard ---------------- */
  views.dashboard = async () => {
    title('Dashboard', `<a class="btn btn-ghost" href="#products">+ Add product</a>`);
    const s = await api('/stats');
    const max = Math.max(1, ...s.revenueByDay.map((d) => d.revenue));
    $('#view').innerHTML = `
      <div class="grid-4">
        <div class="kpi"><small>Total revenue</small><strong>${money(s.revenue)}</strong></div>
        <div class="kpi"><small>Orders</small><strong>${s.orders}</strong><span class="muted">${s.pendingOrders} need action</span></div>
        <div class="kpi"><small>Subscribers</small><strong>${s.subscribers}</strong></div>
        <div class="kpi"><small>Products</small><strong>${s.products}</strong><span class="muted">${s.lowStock.length} low stock</span></div>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Revenue — last 14 days</h2>
          <div class="chart">${s.revenueByDay.map((d) => `<div class="bar" style="height:${(d.revenue / max) * 100}%" data-tip="${d.date}: ${money(d.revenue)}"></div>`).join('')}</div>
          <div class="chart-labels">${s.revenueByDay.map((d) => `<span>${d.date.slice(8)}</span>`).join('')}</div></div>
        <div class="panel"><h2>Needs attention</h2>
          <p>🧾 <a href="#orders">${s.pendingOrders} open orders</a></p>
          <p>⭐ <a href="#reviews">${s.pendingReviews} reviews awaiting approval</a></p>
          <p>✉️ <a href="#messages">${s.unreadMessages} unread messages</a></p>
          <h2 style="margin-top:18px">Low stock</h2>
          ${s.lowStock.length ? s.lowStock.map((p) => `<p>${esc(p.name)} — <strong style="color:#b45309">${p.stock}</strong></p>`).join('') : '<p class="muted">All good.</p>'}</div>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Recent orders</h2><div class="table-wrap">${ordersTable(s.recentOrders)}</div></div>
        <div class="panel"><h2>Top products</h2>${s.topProducts.length ? s.topProducts.map((p) => `<p>${esc(p.name)} <strong style="float:right">${p.qty} sold</strong></p>`).join('') : '<p class="muted">No sales yet.</p>'}</div>
      </div>`;
    bindOrderRows();
  };

  /* ---------------- orders ---------------- */
  const STATUSES = ['pending', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];
  const ordersTable = (orders) => orders.length ? `<table><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead><tbody>
    ${orders.map((o) => `<tr data-order="${esc(o.id)}" style="cursor:pointer"><td><a href="#orders">${esc(o.id)}</a></td><td>${date(o.createdAt)}</td><td>${esc(o.customer.firstName)} ${esc(o.customer.lastName)}<br><small class="muted">${esc(o.customer.email)}</small></td><td>${o.items.reduce((s, i) => s + i.qty, 0)}</td><td><strong>${money(o.total)}</strong></td><td>${esc(o.paymentMethod)} ${pill(o.paymentStatus)}</td><td>${pill(o.status)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No orders yet.</p>';
  const bindOrderRows = () => $$('[data-order]').forEach((r) => (r.onclick = (e) => { e.preventDefault(); openOrder(r.dataset.order); }));

  views.orders = async () => {
    title('Orders');
    cache.orders = await api('/orders');
    $('#view').innerHTML = `<div class="panel"><div class="toolbar"><input id="o-q" placeholder="Search order #, name, email"><select id="o-s"><option value="">All statuses</option>${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select><button class="btn btn-ghost" id="o-csv">⬇ Export CSV</button></div><div class="table-wrap" id="o-table"></div></div>`;
    const render = () => {
      const q = $('#o-q').value.toLowerCase(), st = $('#o-s').value;
      $('#o-table').innerHTML = ordersTable(cache.orders.filter((o) => (!st || o.status === st) && (!q || [o.id, o.customer.firstName, o.customer.lastName, o.customer.email].join(' ').toLowerCase().includes(q))));
      bindOrderRows();
    };
    $('#o-q').oninput = render; $('#o-s').onchange = render; render();
    $('#o-csv').onclick = () => {
      const rows = [['order', 'date', 'name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'items', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'payment', 'status', 'tracking']]
        .concat(cache.orders.map((o) => [o.id, o.createdAt, `${o.customer.firstName} ${o.customer.lastName}`, o.customer.email, o.customer.phone, o.customer.address, o.customer.city, o.customer.state, o.customer.zip, o.items.map((i) => `${i.qty}x ${i.name}`).join('; '), o.subtotal, o.discount, o.shipping, o.tax, o.total, o.paymentMethod, o.status, o.tracking]));
      download('orders.csv', rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'));
    };
  };
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); }

  async function openOrder(id) {
    const orders = cache.orders || (cache.orders = await api('/orders'));
    let o = orders.find((x) => x.id === id);
    if (!o) { cache.orders = await api('/orders'); o = cache.orders.find((x) => x.id === id); }
    const c = o.customer;
    modal(`Order ${esc(o.id)}`, `
      <div class="fg">
        <div><h2>Customer</h2><p>${esc(c.firstName)} ${esc(c.lastName)}<br>${esc(c.email)}<br>${esc(c.phone)}</p><p>${esc(c.address)} ${esc(c.address2)}<br>${esc(c.city)}, ${esc(c.state)} ${esc(c.zip)} ${esc(c.country)}</p>
          ${c.vehicle ? `<p>🚙 <strong>${esc(c.vehicle)}</strong></p>` : ''}${c.notes ? `<div class="msg-body">${esc(c.notes)}</div>` : ''}</div>
        <div><h2>Update</h2>
          <label>Status</label><select id="m-status">${STATUSES.map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <label style="margin-top:10px">Payment status</label><select id="m-pay">${['awaiting', 'authorized', 'paid', 'refunded'].map((s) => `<option ${s === o.paymentStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <label style="margin-top:10px">Tracking number</label><input id="m-track" value="${esc(o.tracking)}">
          <label style="margin-top:10px">Note (shown to customer)</label><input id="m-note" placeholder="e.g. Shipped via UPS Ground"></div>
      </div>
      <div class="section-title">Items</div>
      <table><tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}<br><small class="muted">${esc(i.sku)} • ${esc(Object.values(i.options).join(' • '))}</small></td><td>${i.qty} × ${money(i.unitPrice)}</td><td style="text-align:right">${money(i.lineTotal)}</td></tr>`).join('')}
      <tr><td colspan="2">Subtotal</td><td style="text-align:right">${money(o.subtotal)}</td></tr>
      ${o.discount ? `<tr><td colspan="2">Discount (${esc(o.coupon)})</td><td style="text-align:right">−${money(o.discount)}</td></tr>` : ''}
      <tr><td colspan="2">Shipping</td><td style="text-align:right">${money(o.shipping)}</td></tr><tr><td colspan="2">Tax</td><td style="text-align:right">${money(o.tax)}</td></tr>
      <tr><td colspan="2"><strong>Total</strong></td><td style="text-align:right"><strong>${money(o.total)}</strong></td></tr></tbody></table>
      <div class="section-title">History</div>${o.history.map((h) => `<p>${pill(h.status)} <span class="muted">${date(h.at)}</span> ${esc(h.note)}</p>`).join('')}`,
    async () => {
      await api('/orders/' + o.id, 'PUT', { status: $('#m-status').value, paymentStatus: $('#m-pay').value, tracking: $('#m-track').value, note: $('#m-note').value });
      toast('Order updated'); cache.orders = null; go();
    }, 'Save order', `<button class="btn btn-ghost" onclick="window.print()">🖨 Print</button>`);
  }

  /* ---------------- products ---------------- */
  views.products = async () => {
    title('Products', `<button class="btn" id="add-prod">+ Add product</button>`);
    const [products, settings] = await Promise.all([api('/products'), api('/settings')]);
    cache.products = products; cache.categories = settings.categories;
    $('#view').innerHTML = `<div class="panel"><div class="toolbar"><input id="p-q" placeholder="Search name, SKU, vehicle"><select id="p-c"><option value="">All categories</option>${settings.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div class="table-wrap" id="p-table"></div></div>`;
    const render = () => {
      const q = $('#p-q').value.toLowerCase(), cat = $('#p-c').value;
      const list = products.filter((p) => (!cat || p.category === cat) && (!q || [p.name, p.sku, ...(p.fitment || []).map((f) => f.make + ' ' + f.model)].join(' ').toLowerCase().includes(q)));
      $('#p-table').innerHTML = `<table><thead><tr><th></th><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Rating</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((p) => `<tr><td><img src="${esc(p.image || `/img/product/${p.slug}.svg`)}" alt=""></td><td><strong>${esc(p.name)}</strong>${p.featured ? ' ⭐' : ''}<br><small class="muted">${p.universal ? 'Universal' : (p.fitment || []).length + ' fitment(s)'}</small></td><td>${esc(p.sku)}</td><td>${esc(p.category)}</td>
          <td>${p.salePrice ? `<del class="muted">${money(p.price)}</del> ${money(p.salePrice)}` : money(p.price)}</td><td style="color:${p.stock <= 5 ? '#b45309' : ''}">${p.stock}</td><td>${p.reviewCount ? `${p.rating}★ (${p.reviewCount})` : '—'}</td><td>${pill(p.active ? 'on' : 'off')}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button> <button class="btn btn-ghost btn-sm" data-dup="${p.id}">Duplicate</button> <button class="btn btn-danger btn-sm" data-del="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table>`;
      $$('[data-edit]').forEach((b) => (b.onclick = () => productForm(products.find((p) => p.id === b.dataset.edit))));
      $$('[data-dup]').forEach((b) => (b.onclick = () => { const p = structuredClone(products.find((x) => x.id === b.dataset.dup)); delete p.id; p.name += ' (copy)'; p.slug = ''; p.sku += '-COPY'; productForm(p); }));
      $$('[data-del]').forEach((b) => (b.onclick = async () => { if (!confirm('Delete this product?')) return; await api('/products/' + b.dataset.del, 'DELETE'); toast('Deleted'); go(); }));
    };
    $('#p-q').oninput = render; $('#p-c').onchange = render; render();
    $('#add-prod').onclick = () => productForm({ active: true, options: { subSizes: [10, 12], configurations: [{ label: 'Single', extra: 0 }, { label: 'Dual', extra: 40 }], colors: ['Black', 'Charcoal Grey', 'Grey', 'Tan'], addons: [] }, fitment: [], features: [], specs: {} });
  };

  const repeater = (id, rows, cols, blank) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div id="${id}"></div><button type="button" class="btn btn-ghost btn-sm">+ Add row</button>`;
    const list = wrap.firstChild;
    const addRow = (r = blank) => {
      const row = document.createElement('div');
      row.className = 'repeat-row';
      row.style.gridTemplateColumns = cols.map((c) => c.w || '1fr').join(' ') + ' 34px';
      row.innerHTML = cols.map((c) => `<input data-k="${c.k}" placeholder="${c.ph}" type="${c.type || 'text'}" value="${esc(r[c.k] ?? '')}">`).join('') + `<button type="button" class="btn btn-danger btn-sm">✕</button>`;
      row.lastChild.onclick = () => row.remove();
      list.appendChild(row);
    };
    rows.forEach(addRow);
    wrap.lastChild.onclick = () => addRow();
    return wrap;
  };
  const readRepeater = (id) => $$(`#${id} .repeat-row`).map((row) => Object.fromEntries($$('input', row).map((i) => [i.dataset.k, i.type === 'number' ? Number(i.value) : i.value.trim()])));

  function productForm(p) {
    const o = p.options || {};
    modal(p.id ? 'Edit product' : 'New product', `
      <div class="fg">
        <div class="full"><label>Product name *</label><input id="f-name" value="${esc(p.name)}"></div>
        <div><label>SKU</label><input id="f-sku" value="${esc(p.sku)}"></div>
        <div><label>URL slug</label><input id="f-slug" value="${esc(p.slug)}" placeholder="auto from name"></div>
        <div><label>Category</label><select id="f-cat">${cache.categories.map((c) => `<option value="${c.id}" ${c.id === p.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Enclosure type</label><select id="f-type">${['sealed', 'ported', 'bandpass'].map((t) => `<option ${t === p.enclosureType ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label>Price ($) *</label><input id="f-price" type="number" step="0.01" value="${p.price ?? ''}"></div>
        <div><label>Sale price ($)</label><input id="f-sale" type="number" step="0.01" value="${p.salePrice ?? ''}"></div>
        <div><label>Stock</label><input id="f-stock" type="number" value="${p.stock ?? 0}"></div>
        <div><label>Image URL (optional)</label><input id="f-img" value="${esc(p.image)}" placeholder="https://… (auto-generated if empty)"></div>
        <div class="full" style="display:flex;gap:20px;flex-wrap:wrap"><label class="check"><input type="checkbox" id="f-active" ${p.active !== false ? 'checked' : ''}> Active (visible)</label><label class="check"><input type="checkbox" id="f-feat" ${p.featured ? 'checked' : ''}> Featured on home page</label><label class="check"><input type="checkbox" id="f-uni" ${p.universal ? 'checked' : ''}> Universal fit</label></div>
        <div class="full"><label>Description</label><textarea id="f-desc">${esc(p.description)}</textarea></div>
        <div class="full"><label>Features (one per line)</label><textarea id="f-features">${esc((p.features || []).join('\n'))}</textarea></div>
      </div>
      <div class="section-title">Product options</div>
      <div class="fg">
        <div><label>Subwoofer sizes (comma separated)</label><input id="f-subs" value="${esc((o.subSizes || []).join(', '))}" placeholder="8, 10, 12"></div>
        <div><label>Carpet colors (comma separated)</label><input id="f-colors" value="${esc((o.colors || []).join(', '))}"></div>
        <div><label>Configurations (label + extra price)</label><div id="rep-conf"></div></div>
        <div><label>Add-ons (label + price)</label><div id="rep-addons"></div></div>
      </div>
      <div class="section-title">Specifications (name + value)</div><div id="rep-specs"></div>
      <div class="section-title">Vehicle fitment</div><div id="rep-fit"></div>`,
    async () => {
      const csv = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
      const body = {
        name: $('#f-name').value, sku: $('#f-sku').value, slug: $('#f-slug').value, category: $('#f-cat').value, enclosureType: $('#f-type').value,
        price: $('#f-price').value, salePrice: $('#f-sale').value || null, stock: $('#f-stock').value, image: $('#f-img').value,
        active: $('#f-active').checked, featured: $('#f-feat').checked, universal: $('#f-uni').checked,
        description: $('#f-desc').value, features: $('#f-features').value.split('\n').map((s) => s.trim()).filter(Boolean),
        options: { subSizes: csv($('#f-subs').value).map(Number), colors: csv($('#f-colors').value), configurations: readRepeater('conf-list'), addons: readRepeater('addon-list') },
        specs: Object.fromEntries(readRepeater('spec-list').filter((r) => r.k).map((r) => [r.k, r.v])),
        fitment: readRepeater('fit-list'),
      };
      await api(p.id ? '/products/' + p.id : '/products', p.id ? 'PUT' : 'POST', body);
      toast('Product saved'); go();
    });
    $('#rep-conf').appendChild(repeater('conf-list', o.configurations || [], [{ k: 'label', ph: 'Single' }, { k: 'extra', ph: '0', type: 'number', w: '90px' }], { label: '', extra: 0 }));
    $('#rep-addons').appendChild(repeater('addon-list', o.addons || [], [{ k: 'label', ph: 'Amp rack' }, { k: 'price', ph: '0', type: 'number', w: '90px' }], { label: '', price: 0 }));
    $('#rep-specs').appendChild(repeater('spec-list', Object.entries(p.specs || {}).map(([k, v]) => ({ k, v })), [{ k: 'k', ph: 'Net volume' }, { k: 'v', ph: '0.75 cu ft' }], { k: '', v: '' }));
    $('#rep-fit').appendChild(repeater('fit-list', p.fitment || [], [{ k: 'make', ph: 'Make' }, { k: 'model', ph: 'Model' }, { k: 'yearFrom', ph: 'From', type: 'number', w: '90px' }, { k: 'yearTo', ph: 'To', type: 'number', w: '90px' }, { k: 'cab', ph: 'Cab (Crew Cab…)' }], { make: '', model: '', yearFrom: '', yearTo: '', cab: '' }));
  }

  /* ---------------- reviews ---------------- */
  views.reviews = async () => {
    title('Reviews');
    const list = await api('/reviews');
    $('#view').innerHTML = `<div class="panel"><div class="table-wrap">${list.length ? `<table><thead><tr><th>Rating</th><th>Review</th><th>Product</th><th>Author</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td style="color:#f59e0b;white-space:nowrap">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td><td><strong>${esc(r.title)}</strong><br>${esc(r.body)}</td><td>${esc(r.product)}</td><td>${esc(r.name)}<br><small class="muted">${esc(r.email)} ${date(r.createdAt)}</small></td><td>${pill(r.approved ? 'on' : 'pending')}</td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-ap="${r.id}" data-v="${r.approved ? 0 : 1}">${r.approved ? 'Unpublish' : 'Approve'}</button> <button class="btn btn-danger btn-sm" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No reviews yet.</p>'}</div></div>`;
    $$('[data-ap]').forEach((b) => (b.onclick = async () => { await api('/reviews/' + b.dataset.ap, 'PUT', { approved: b.dataset.v === '1' }); toast('Saved'); go(); }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete review?')) { await api('/reviews/' + b.dataset.del, 'DELETE'); go(); } }));
  };

  /* ---------------- coupons ---------------- */
  views.coupons = async () => {
    title('Coupons', `<button class="btn" id="add-c">+ New coupon</button>`);
    const list = await api('/coupons');
    $('#view').innerHTML = `<div class="panel"><div class="table-wrap">${list.length ? `<table><thead><tr><th>Code</th><th>Discount</th><th>Min. subtotal</th><th>Used</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><strong>${esc(c.code)}</strong></td><td>${c.type === 'percent' ? c.value + '%' : money(c.value)}</td><td>${money(c.minSubtotal)}</td><td>${c.used || 0}${c.usageLimit ? ' / ' + c.usageLimit : ''}</td><td>${esc(c.expires || '—')}</td><td>${pill(c.active ? 'on' : 'off')}</td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${esc(c.code)}">Edit</button> <button class="btn btn-danger btn-sm" data-del="${esc(c.code)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No coupons.</p>'}</div>
      <p class="muted">Coupons only work while the <a href="#plugins">Coupons plugin</a> is enabled.</p></div>`;
    const form = (c = { type: 'percent', active: true }) => modal(c.code ? 'Edit coupon' : 'New coupon', `<div class="fg">
        <div><label>Code</label><input id="c-code" value="${esc(c.code)}" ${c.code ? 'readonly' : ''}></div>
        <div><label>Type</label><select id="c-type"><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>Percent off</option><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Fixed amount off</option></select></div>
        <div><label>Value</label><input id="c-val" type="number" value="${c.value ?? ''}"></div>
        <div><label>Minimum subtotal ($)</label><input id="c-min" type="number" value="${c.minSubtotal ?? 0}"></div>
        <div><label>Usage limit (0 = unlimited)</label><input id="c-lim" type="number" value="${c.usageLimit ?? 0}"></div>
        <div><label>Expires</label><input id="c-exp" type="date" value="${esc(c.expires || '')}"></div>
        <label class="check full"><input type="checkbox" id="c-act" ${c.active ? 'checked' : ''}> Active</label></div>`,
      async () => { await api('/coupons', 'POST', { code: $('#c-code').value, type: $('#c-type').value, value: $('#c-val').value, minSubtotal: $('#c-min').value, usageLimit: $('#c-lim').value, expires: $('#c-exp').value, active: $('#c-act').checked }); toast('Coupon saved'); go(); });
    $('#add-c').onclick = () => form();
    $$('[data-edit]').forEach((b) => (b.onclick = () => form(list.find((c) => c.code === b.dataset.edit))));
    $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete coupon?')) { await api('/coupons/' + encodeURIComponent(b.dataset.del), 'DELETE'); go(); } }));
  };

  /* ---------------- messages ---------------- */
  views.messages = async () => {
    title('Messages & Quote Requests');
    const list = await api('/messages');
    $('#view').innerHTML = `<div class="panel"><div class="toolbar"><select id="m-type"><option value="">All types</option><option value="quote">Custom quotes</option><option value="contact">Contact form</option><option value="chat">Live chat</option></select></div><div id="m-list"></div></div>`;
    const render = () => {
      const t = $('#m-type').value;
      const items = list.filter((m) => !t || m.type === t);
      $('#m-list').innerHTML = items.length ? items.map((m) => `<div style="border-bottom:1px solid var(--border);padding:14px 0;${m.read ? 'opacity:.7' : ''}">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div>${pill(m.type)} ${m.read ? '' : '<span class="pill pending">new</span>'} <strong>${esc(m.name)}</strong> &lt;<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>&gt; ${esc(m.phone)}</div><span class="muted">${date(m.createdAt)}</span></div>
        ${m.vehicle ? `<div>🚙 ${esc(m.vehicle)}</div>` : ''}${m.subSpec ? `<div>🔊 ${esc(m.subSpec)}</div>` : ''}<div class="msg-body">${esc(m.message)}</div>
        <div style="margin-top:8px;display:flex;gap:8px"><a class="btn btn-ghost btn-sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: your ' + m.type + ' request')}">Reply by email</a><button class="btn btn-ghost btn-sm" data-read="${m.id}" data-v="${m.read ? 0 : 1}">Mark ${m.read ? 'unread' : 'read'}</button><button class="btn btn-danger btn-sm" data-del="${m.id}">Delete</button></div></div>`).join('') : '<p class="muted">No messages.</p>';
      $$('[data-read]').forEach((b) => (b.onclick = async () => { await api('/messages/' + b.dataset.read, 'PUT', { read: b.dataset.v === '1' }); go(); }));
      $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete message?')) { await api('/messages/' + b.dataset.del, 'DELETE'); go(); } }));
    };
    $('#m-type').onchange = render; render();
  };

  /* ---------------- subscribers ---------------- */
  views.subscribers = async () => {
    title('Newsletter Subscribers', `<button class="btn btn-ghost" id="sub-csv">⬇ Export CSV</button>`);
    const list = await api('/subscribers');
    $('#view').innerHTML = `<div class="panel"><p class="muted">${list.length} subscriber(s). Import the CSV into your email marketing tool.</p><div class="table-wrap">${list.length ? `<table><thead><tr><th>Email</th><th>Source</th><th>Date</th><th></th></tr></thead><tbody>${list.map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.source)}</td><td>${date(s.createdAt)}</td><td><button class="btn btn-danger btn-sm" data-del="${esc(s.email)}">Remove</button></td></tr>`).join('')}</tbody></table>` : ''}</div></div>`;
    $('#sub-csv').onclick = async () => {
      const res = await fetch('/api/admin/subscribers?format=csv', { headers: { Authorization: 'Bearer ' + token } });
      download('subscribers.csv', await res.text());
    };
    $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Remove subscriber?')) { await api('/subscribers/' + encodeURIComponent(b.dataset.del), 'DELETE'); go(); } }));
  };

  /* ---------------- plugins ---------------- */
  views.plugins = async () => {
    title('Plugins');
    const list = await api('/plugins');
    $('#view').innerHTML = `<p class="muted" style="margin-top:-10px">Turn store features on or off. Changes apply to the storefront immediately.</p><div class="plugin-grid">${list.map((p) => `
      <div class="plugin" data-id="${p.id}">
        <div class="plugin-head"><div class="plugin-ico">${p.icon}</div><div><strong>${esc(p.name)}</strong><span class="muted" style="font-size:.8rem">${p.enabled ? 'Active' : 'Inactive'}</span></div>
          <label class="switch"><input type="checkbox" data-toggle ${p.enabled ? 'checked' : ''} aria-label="Enable ${esc(p.name)}"><span></span></label></div>
        <p class="muted" style="margin:0">${esc(p.description)}</p>
        ${Object.keys(p.config || {}).length ? `<div class="plugin-config">${Object.entries(p.config).map(([k, v]) => typeof v === 'boolean'
          ? `<label class="check"><input type="checkbox" data-cfg="${k}" ${v ? 'checked' : ''}> ${esc(k.replace(/([A-Z])/g, ' $1'))}</label>`
          : `<div><label style="text-transform:capitalize">${esc(k.replace(/([A-Z])/g, ' $1'))}</label><input data-cfg="${k}" type="${typeof v === 'number' ? 'number' : 'text'}" value="${esc(v)}"></div>`).join('')}
          <button class="btn btn-ghost btn-sm" data-save style="align-self:flex-start">Save settings</button></div>` : ''}
      </div>`).join('')}</div>`;
    $$('.plugin').forEach((el) => {
      const id = el.dataset.id;
      $('[data-toggle]', el).onchange = async (e) => { await api('/plugins/' + id, 'PUT', { enabled: e.target.checked }); toast(`${e.target.checked ? 'Enabled' : 'Disabled'}`); $('.plugin-head .muted', el).textContent = e.target.checked ? 'Active' : 'Inactive'; };
      const save = $('[data-save]', el);
      if (save) save.onclick = async () => {
        const config = Object.fromEntries($$('[data-cfg]', el).map((i) => [i.dataset.cfg, i.type === 'checkbox' ? i.checked : i.value]));
        await api('/plugins/' + id, 'PUT', { config }); toast('Plugin settings saved');
      };
    });
  };

  /* ---------------- SEO ---------------- */
  views.seo = async () => {
    title('SEO & Product Feeds');
    const origin = location.origin;
    $('#view').innerHTML = `
      <div class="panel"><h2>🛍️ Google Merchant Center feed</h2>
        <p>Submit this URL in Google Merchant Center → Products → Feeds → <em>Scheduled fetch</em>:</p>
        <p><input readonly value="${origin}/feed/google-merchant.xml" onclick="this.select()"></p>
        <p><a class="btn btn-ghost" href="/feed/google-merchant.xml" target="_blank">Preview feed ↗</a></p>
        <p class="muted">Tip: set the <code>SITE_URL</code> environment variable to your live domain so links in the feed are correct. Every active product needs a price, image and description to be approved.</p><p style="color:#b45309"><strong>Important:</strong> Google does not accept SVG images. Before submitting, upload a real JPG/PNG photo for each product and paste its URL into the product's <em>Image URL</em> field.</p></div>
      <div class="panel"><h2>🗺️ Sitemap & robots</h2>
        <p>Submit your sitemap in Google Search Console:</p>
        <p><input readonly value="${origin}/sitemap.xml" onclick="this.select()"></p>
        <p><a class="btn btn-ghost" href="/sitemap.xml" target="_blank">sitemap.xml ↗</a> <a class="btn btn-ghost" href="/robots.txt" target="_blank">robots.txt ↗</a></p></div>
      <div class="panel"><h2>⭐ Structured data</h2><p>Product pages output schema.org <code>Product</code>, <code>Offer</code> and <code>AggregateRating</code> JSON-LD while the <a href="#plugins">SEO &amp; Structured Data plugin</a> is on, so prices and stars can appear in Google results.</p></div>`;
  };

  /* ---------------- settings ---------------- */
  views.settings = async () => {
    title('Store Settings');
    const s = await api('/settings');
    $('#view').innerHTML = `
      <form class="panel" id="set-form"><h2>Store details</h2><div class="fg">
        <div><label>Store name</label><input name="storeName" value="${esc(s.storeName)}"></div>
        <div><label>Tagline</label><input name="tagline" value="${esc(s.tagline)}"></div>
        <div><label>Email</label><input name="email" value="${esc(s.email)}"></div>
        <div><label>Phone</label><input name="phone" value="${esc(s.phone)}"></div>
        <div><label>Address</label><input name="address" value="${esc(s.address)}"></div>
        <div><label>Business hours</label><input name="hours" value="${esc(s.hours)}"></div>
      </div>
      <h2 style="margin-top:20px">Checkout</h2><div class="fg">
        <div><label>Currency</label><select name="currency">${['USD', 'CAD', 'EUR', 'GBP', 'AUD'].map((c) => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div><label>Flat shipping rate</label><input name="shippingFlat" type="number" step="0.01" value="${s.shippingFlat}"></div>
        <div><label>Free shipping over</label><input name="freeShippingOver" type="number" step="0.01" value="${s.freeShippingOver}"></div>
        <div><label>Sales tax rate (e.g. 0.07 = 7%)</label><input name="taxRate" type="number" step="0.001" value="${s.taxRate}"></div>
        <div><label>Collect tax for state (code, blank = none)</label><input name="taxState" value="${esc(s.taxState)}" placeholder="TX"></div>
      </div>
      <h2 style="margin-top:20px">Social links</h2><div class="fg">${Object.entries(s.social).map(([k, v]) => `<div><label style="text-transform:capitalize">${k}</label><input data-social="${k}" value="${esc(v)}" placeholder="https://"></div>`).join('')}</div>
      <button class="btn" style="margin-top:18px">Save settings</button></form>
      <form class="panel" id="pw-form"><h2>Admin account</h2><div class="fg">
        <div><label>Username</label><input name="username" value="${esc(s.adminUser)}" autocomplete="username"></div>
        <div><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div>
        <div><label>New password (min 8 chars)</label><input name="next" type="password" autocomplete="new-password" required minlength="8"></div>
      </div><button class="btn" style="margin-top:14px">Update login</button></form>`;
    $('#set-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.social = Object.fromEntries($$('[data-social]').map((i) => [i.dataset.social, i.value]));
      await api('/settings', 'PUT', body); toast('Settings saved');
    };
    $('#pw-form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/password', 'PUT', Object.fromEntries(new FormData(e.target))); toast('Login updated'); e.target.current.value = e.target.next.value = ''; }
      catch (err) { toast(err.message); }
    };
  };

  /* ---------------- modal ---------------- */
  function modal(heading, html, onSave, saveLabel = 'Save', extra = '') {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><div class="modal-head"><h2 style="margin:0">${heading}</h2><button class="btn btn-ghost btn-sm" data-close>✕</button></div><div>${html}</div>
      <div class="modal-foot">${extra}<button class="btn btn-ghost" data-close>Cancel</button><button class="btn" data-save>${saveLabel}</button></div></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    $$('[data-close]', bg).forEach((b) => (b.onclick = close));
    bg.addEventListener('mousedown', (e) => e.target === bg && close());
    $('[data-save]', bg).onclick = async (e) => {
      e.target.disabled = true;
      try { await onSave(); close(); } catch (err) { toast(err.message); e.target.disabled = false; }
    };
  }

  /* ---------------- boot ---------------- */
  function start() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    go();
  }
  if (token) start();
})();
