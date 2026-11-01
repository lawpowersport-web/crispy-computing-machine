/**
 * BassBox Underseat Enclosures — back end
 * Zero-dependency Node.js server (Node 18+): REST API, admin auth,
 * JSON-file database, static file hosting, Google Merchant feed & sitemap.
 *
 *   node server.js            → http://localhost:3000
 *   Admin panel               → http://localhost:3000/admin/
 *   Default admin login       → admin / admin123  (change it in Admin → Settings)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;

/* ---------------------------------------------------------------- database */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(password, salt, hash) {
  const test = crypto.scryptSync(String(password), salt, 64);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
    seed.admin = { username: process.env.ADMIN_USER || 'admin', salt, hash };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    console.log('Created database from seed →', DB_FILE);
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
const db = loadDb();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}

/* ----------------------------------------------------------------- helpers */
const uid = (p = '') => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const round2 = (n) => Math.round(n * 100) / 100;
const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const plugin = (id) => db.plugins.find((p) => p.id === id) || { enabled: false, config: {} };
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const escXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}
const ok = (res, data) => send(res, 200, data);
const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------- admin auth */
const tokens = new Map(); // token -> expiry
function issueToken() {
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL_MS);
  return t;
}
function isAdmin(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const exp = tokens.get(m[1]);
  if (!exp || exp < Date.now()) { tokens.delete(m[1]); return false; }
  return true;
}
const loginAttempts = new Map(); // ip -> {count, until}

/* ------------------------------------------------------------ product logic */
function productRating(id) {
  const r = db.reviews.filter((x) => x.productId === id && x.approved);
  if (!r.length) return { rating: 0, reviewCount: 0 };
  return { rating: round2(r.reduce((a, b) => a + b.rating, 0) / r.length), reviewCount: r.length };
}
function publicProduct(p) {
  return { ...p, ...productRating(p.id) };
}
function fitsVehicle(p, make, model, year) {
  if (p.universal) return true;
  return (p.fitment || []).some((f) =>
    (!make || f.make.toLowerCase() === make.toLowerCase()) &&
    (!model || f.model.toLowerCase() === model.toLowerCase()) &&
    (!year || (year >= f.yearFrom && year <= f.yearTo)));
}
function fitmentTree() {
  const tree = {};
  for (const p of db.products) {
    if (!p.active) continue;
    for (const f of p.fitment || []) {
      tree[f.make] ??= {};
      tree[f.make][f.model] ??= new Set();
      for (let y = f.yearFrom; y <= f.yearTo; y++) tree[f.make][f.model].add(y);
    }
  }
  const out = {};
  for (const make of Object.keys(tree).sort()) {
    out[make] = {};
    for (const model of Object.keys(tree[make]).sort()) out[make][model] = [...tree[make][model]].sort((a, b) => b - a);
  }
  return out;
}

/** Price a cart line server-side. Throws on invalid options. */
function priceLine(item) {
  const p = db.products.find((x) => x.id === item.productId && x.active);
  if (!p) throw new Error('A product in your cart is no longer available');
  const qty = Math.max(1, Math.min(20, Math.floor(num(item.qty, 1))));
  const o = item.options || {};
  const opts = p.options || {};
  const chosen = {};
  let unit = p.salePrice && p.salePrice < p.price ? p.salePrice : p.price;

  if (opts.subSizes?.length) {
    const s = Number(o.subSize);
    if (!opts.subSizes.includes(s)) throw new Error(`Choose a subwoofer size for ${p.name}`);
    chosen.subSize = `${s}"`;
  }
  if (opts.configurations?.length) {
    const c = opts.configurations.find((x) => x.label === o.configuration);
    if (!c) throw new Error(`Choose a configuration for ${p.name}`);
    unit += num(c.extra);
    chosen.configuration = c.label;
  }
  if (opts.colors?.length) {
    if (!opts.colors.includes(o.color)) throw new Error(`Choose a carpet color for ${p.name}`);
    chosen.color = o.color;
  }
  if (opts.addons?.length && Array.isArray(o.addons)) {
    const picked = opts.addons.filter((a) => o.addons.includes(a.label));
    unit += picked.reduce((s, a) => s + num(a.price), 0);
    if (picked.length) chosen.addons = picked.map((a) => a.label).join(', ');
  }
  if (p.stock < qty) throw new Error(`Only ${p.stock} left of ${p.name}`);
  return { productId: p.id, name: p.name, sku: p.sku, options: chosen, qty, unitPrice: round2(unit), lineTotal: round2(unit * qty) };
}

function findCoupon(code) {
  if (!code || !plugin('coupons').enabled) return null;
  const c = db.coupons.find((x) => x.code.toLowerCase() === String(code).trim().toLowerCase() && x.active);
  if (!c) return null;
  if (c.expires && new Date(c.expires) < new Date()) return null;
  if (c.usageLimit && c.used >= c.usageLimit) return null;
  return c;
}
function couponDiscount(c, subtotal) {
  if (!c || subtotal < num(c.minSubtotal)) return 0;
  return round2(Math.min(subtotal, c.type === 'percent' ? subtotal * c.value / 100 : c.value));
}

function quote(items, couponCode, shippingState) {
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty');
  if (items.length > 50) throw new Error('Too many cart lines');
  const lines = items.map(priceLine);
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const coupon = findCoupon(couponCode);
  if (couponCode && !coupon) throw new Error('That coupon code is not valid');
  const discount = couponDiscount(coupon, subtotal);
  if (coupon && discount === 0) throw new Error(`Coupon requires a subtotal of at least $${coupon.minSubtotal}`);
  const s = db.settings;
  const shipping = subtotal - discount >= s.freeShippingOver ? 0 : s.shippingFlat;
  const taxable = shippingState && s.taxState && shippingState.toUpperCase() === s.taxState.toUpperCase();
  const tax = taxable ? round2((subtotal - discount) * s.taxRate) : 0;
  const total = round2(subtotal - discount + shipping + tax);
  return { lines, subtotal, discount, coupon: coupon?.code || null, shipping, tax, total };
}

/* ------------------------------------------------------------------ router */
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, admin: !!opts.admin });
};

/* ---------- public API ---------- */
route('GET', '/api/config', (req, res) => {
  const s = db.settings;
  ok(res, {
    store: { name: s.storeName, tagline: s.tagline, email: s.email, phone: s.phone, address: s.address, hours: s.hours, social: s.social, currency: s.currency, freeShippingOver: s.freeShippingOver, shippingFlat: s.shippingFlat },
    plugins: Object.fromEntries(db.plugins.map((p) => [p.id, { enabled: p.enabled, config: p.config || {} }])),
    categories: db.categories,
  });
});

route('GET', '/api/fitment', (req, res) => ok(res, plugin('fitment-finder').enabled ? fitmentTree() : {}));

route('GET', '/api/products', (req, res, { query }) => {
  const q = str(query.get('q'), 100).toLowerCase();
  const cat = query.get('category');
  const make = query.get('make'), model = query.get('model');
  const year = num(query.get('year'), 0);
  const sub = num(query.get('sub'), 0);
  const maxPrice = num(query.get('maxPrice'), 0);
  let list = db.products.filter((p) => p.active)
    .filter((p) => !cat || p.category === cat)
    .filter((p) => !q || [p.name, p.sku, p.description, ...(p.fitment || []).map((f) => `${f.make} ${f.model}`)].join(' ').toLowerCase().includes(q))
    .filter((p) => !(make || model || year) || fitsVehicle(p, make, model, year))
    .filter((p) => !sub || (p.options?.subSizes || []).includes(sub))
    .filter((p) => !maxPrice || (p.salePrice || p.price) <= maxPrice)
    .filter((p) => query.get('featured') !== '1' || p.featured)
    .map(publicProduct);
  const sort = query.get('sort');
  const price = (p) => p.salePrice || p.price;
  if (sort === 'price-asc') list.sort((a, b) => price(a) - price(b));
  else if (sort === 'price-desc') list.sort((a, b) => price(b) - price(a));
  else if (sort === 'rating') list.sort((a, b) => b.rating - a.rating);
  else if (sort === 'newest') list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  else list.sort((a, b) => (b.featured - a.featured) || a.name.localeCompare(b.name));
  ok(res, list);
});

route('GET', '/api/products/:slug', (req, res, { params }) => {
  const p = db.products.find((x) => x.active && (x.slug === params.slug || x.id === params.slug));
  if (!p) return fail(res, 404, 'Product not found');
  const reviews = plugin('reviews').enabled
    ? db.reviews.filter((r) => r.productId === p.id && r.approved).map(({ email, ...r }) => r).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const related = db.products.filter((x) => x.active && x.id !== p.id && x.category === p.category).slice(0, 4).map(publicProduct);
  ok(res, { product: publicProduct(p), reviews, related });
});

route('GET', '/api/reviews/featured', (req, res) => {
  if (!plugin('reviews').enabled) return ok(res, []);
  ok(res, db.reviews.filter((r) => r.approved && r.rating >= 4).slice(-6).reverse().map((r) => ({
    name: r.name, rating: r.rating, title: r.title, body: r.body, product: db.products.find((p) => p.id === r.productId)?.name,
  })));
});

route('POST', '/api/reviews', async (req, res) => {
  if (!plugin('reviews').enabled) return fail(res, 403, 'Reviews are disabled');
  const b = await readBody(req);
  const p = db.products.find((x) => x.id === b.productId);
  const rating = Math.round(num(b.rating));
  if (!p) return fail(res, 400, 'Unknown product');
  if (rating < 1 || rating > 5) return fail(res, 400, 'Rating must be 1–5');
  if (!str(b.name) || !str(b.body)) return fail(res, 400, 'Name and review are required');
  const autoApprove = !!plugin('reviews').config?.autoApprove;
  db.reviews.push({ id: uid('rv_'), productId: p.id, name: str(b.name, 60), email: str(b.email, 120), rating, title: str(b.title, 120), body: str(b.body, 2000), approved: autoApprove, createdAt: new Date().toISOString() });
  save();
  ok(res, { ok: true, message: autoApprove ? 'Thanks! Your review is live.' : 'Thanks! Your review will appear after moderation.' });
});

route('POST', '/api/newsletter', async (req, res) => {
  const b = await readBody(req);
  const email = str(b.email, 120).toLowerCase();
  if (!isEmail(email)) return fail(res, 400, 'Please enter a valid email');
  if (!db.subscribers.some((s) => s.email === email)) {
    db.subscribers.push({ email, source: str(b.source, 40) || 'site', createdAt: new Date().toISOString() });
    save();
  }
  const code = plugin('newsletter-popup').config?.couponCode;
  ok(res, { ok: true, message: code ? `You're in! Use code ${code} at checkout.` : "You're subscribed!" });
});

route('POST', '/api/contact', async (req, res) => {
  const b = await readBody(req);
  const email = str(b.email, 120);
  if (!str(b.name) || !isEmail(email) || !str(b.message)) return fail(res, 400, 'Name, valid email and message are required');
  db.messages.push({
    id: uid('msg_'), type: ['quote', 'chat', 'contact'].includes(b.type) ? b.type : 'contact',
    name: str(b.name, 80), email, phone: str(b.phone, 40), vehicle: str(b.vehicle, 120), subSpec: str(b.subSpec, 200),
    message: str(b.message, 4000), read: false, createdAt: new Date().toISOString(),
  });
  save();
  ok(res, { ok: true, message: "Thanks! We'll get back to you within one business day." });
});

route('POST', '/api/coupons/validate', async (req, res) => {
  const b = await readBody(req);
  const c = findCoupon(b.code);
  if (!c) return fail(res, 400, 'That coupon code is not valid');
  ok(res, { code: c.code, type: c.type, value: c.value, minSubtotal: c.minSubtotal });
});

route('POST', '/api/cart/quote', async (req, res) => {
  const b = await readBody(req);
  try { ok(res, quote(b.items, b.coupon, b.state)); } catch (e) { fail(res, 400, e.message); }
});

route('POST', '/api/orders', async (req, res) => {
  const b = await readBody(req);
  const c = b.customer || {};
  const customer = {
    firstName: str(c.firstName, 60), lastName: str(c.lastName, 60), email: str(c.email, 120).toLowerCase(), phone: str(c.phone, 40),
    address: str(c.address, 160), address2: str(c.address2, 160), city: str(c.city, 80), state: str(c.state, 40), zip: str(c.zip, 20), country: str(c.country, 60) || 'US',
    vehicle: str(c.vehicle, 120), notes: str(c.notes, 1000),
  };
  for (const k of ['firstName', 'lastName', 'address', 'city', 'state', 'zip']) if (!customer[k]) return fail(res, 400, 'Please complete all required shipping fields');
  if (!isEmail(customer.email)) return fail(res, 400, 'Please enter a valid email');
  const methods = ['card', 'paypal', 'bank', 'cod'];
  const paymentMethod = methods.includes(b.paymentMethod) ? b.paymentMethod : 'card';
  let q;
  try { q = quote(b.items, b.coupon, customer.state); } catch (e) { return fail(res, 400, e.message); }

  for (const l of q.lines) db.products.find((p) => p.id === l.productId).stock -= l.qty;
  if (q.coupon) { const cp = db.coupons.find((x) => x.code === q.coupon); cp.used = (cp.used || 0) + 1; }
  const order = {
    id: 'BB' + (10000 + db.orders.length + 1),
    createdAt: new Date().toISOString(), status: 'pending',
    paymentMethod, paymentStatus: paymentMethod === 'cod' || paymentMethod === 'bank' ? 'awaiting' : 'authorized',
    customer, items: q.lines, subtotal: q.subtotal, discount: q.discount, coupon: q.coupon, shipping: q.shipping, tax: q.tax, total: q.total,
    tracking: '', history: [{ status: 'pending', at: new Date().toISOString(), note: 'Order placed' }],
  };
  db.orders.push(order);
  if (b.subscribe && !db.subscribers.some((s) => s.email === customer.email)) db.subscribers.push({ email: customer.email, source: 'checkout', createdAt: order.createdAt });
  save();
  ok(res, { ok: true, orderId: order.id, total: order.total });
});

route('GET', '/api/orders/track', (req, res, { query }) => {
  const o = db.orders.find((x) => x.id.toLowerCase() === str(query.get('id')).toLowerCase() && x.customer.email === str(query.get('email')).toLowerCase());
  if (!o) return fail(res, 404, 'No order found with that number and email');
  ok(res, { id: o.id, createdAt: o.createdAt, status: o.status, tracking: o.tracking, items: o.items, total: o.total, history: o.history });
});

/* ---------- admin API ---------- */
route('POST', '/api/admin/login', async (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = loginAttempts.get(ip);
  if (a && a.until > Date.now()) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
  const b = await readBody(req);
  if (str(b.username) === db.admin.username && checkPassword(str(b.password), db.admin.salt, db.admin.hash)) {
    loginAttempts.delete(ip);
    return ok(res, { token: issueToken(), username: db.admin.username });
  }
  const count = (a?.count || 0) + 1;
  loginAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
  fail(res, 401, 'Invalid username or password');
});
route('POST', '/api/admin/logout', (req, res) => {
  tokens.delete((req.headers.authorization || '').replace('Bearer ', ''));
  ok(res, { ok: true });
}, { admin: true });

route('GET', '/api/admin/stats', (req, res) => {
  const paid = db.orders.filter((o) => o.status !== 'cancelled');
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10);
    return { date: d, revenue: round2(paid.filter((o) => o.createdAt.startsWith(d)).reduce((s, o) => s + o.total, 0)) };
  });
  const sold = {};
  for (const o of paid) for (const l of o.items) sold[l.name] = (sold[l.name] || 0) + l.qty;
  ok(res, {
    revenue: round2(paid.reduce((s, o) => s + o.total, 0)),
    orders: db.orders.length,
    pendingOrders: db.orders.filter((o) => o.status === 'pending' || o.status === 'processing').length,
    products: db.products.length,
    lowStock: db.products.filter((p) => p.stock <= 5).map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
    subscribers: db.subscribers.length,
    unreadMessages: db.messages.filter((m) => !m.read).length,
    pendingReviews: db.reviews.filter((r) => !r.approved).length,
    revenueByDay: days,
    topProducts: Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })),
    recentOrders: db.orders.slice(-5).reverse(),
  });
}, { admin: true });

function cleanProduct(b, existing = {}) {
  const p = { ...existing };
  p.name = str(b.name, 160) || existing.name;
  if (!p.name) throw new Error('Product name is required');
  p.slug = slugify(str(b.slug) || p.name);
  if (db.products.some((x) => x.slug === p.slug && x.id !== existing.id)) p.slug += '-' + crypto.randomBytes(2).toString('hex');
  p.sku = str(b.sku, 60);
  p.category = db.categories.some((c) => c.id === b.category) ? b.category : db.categories[0].id;
  p.price = round2(Math.max(0, num(b.price)));
  p.salePrice = b.salePrice ? round2(Math.max(0, num(b.salePrice))) : null;
  p.stock = Math.max(0, Math.floor(num(b.stock)));
  p.active = b.active !== false;
  p.featured = !!b.featured;
  p.universal = !!b.universal;
  p.enclosureType = ['sealed', 'ported', 'bandpass'].includes(b.enclosureType) ? b.enclosureType : 'sealed';
  p.description = str(b.description, 5000);
  p.features = Array.isArray(b.features) ? b.features.map((f) => str(f, 200)).filter(Boolean) : [];
  p.specs = b.specs && typeof b.specs === 'object' ? Object.fromEntries(Object.entries(b.specs).slice(0, 30).map(([k, v]) => [str(k, 60), str(v, 200)])) : {};
  p.image = str(b.image, 500);
  const o = b.options || {};
  p.options = {
    subSizes: Array.isArray(o.subSizes) ? o.subSizes.map(Number).filter((n) => n > 0) : [],
    configurations: Array.isArray(o.configurations) ? o.configurations.map((c) => ({ label: str(c.label, 60), extra: round2(num(c.extra)) })).filter((c) => c.label) : [],
    colors: Array.isArray(o.colors) ? o.colors.map((c) => str(c, 40)).filter(Boolean) : [],
    addons: Array.isArray(o.addons) ? o.addons.map((a) => ({ label: str(a.label, 80), price: round2(num(a.price)) })).filter((a) => a.label) : [],
  };
  p.fitment = Array.isArray(b.fitment) ? b.fitment.map((f) => ({
    make: str(f.make, 40), model: str(f.model, 60), yearFrom: Math.floor(num(f.yearFrom)), yearTo: Math.floor(num(f.yearTo || f.yearFrom)), cab: str(f.cab, 60),
  })).filter((f) => f.make && f.model && f.yearFrom > 1950 && f.yearTo >= f.yearFrom) : [];
  return p;
}
route('GET', '/api/admin/products', (req, res) => ok(res, db.products.map(publicProduct)), { admin: true });
route('POST', '/api/admin/products', async (req, res) => {
  const b = await readBody(req);
  try {
    const p = cleanProduct(b, { id: uid('p_'), createdAt: new Date().toISOString() });
    db.products.push(p); save(); ok(res, p);
  } catch (e) { fail(res, 400, e.message); }
}, { admin: true });
route('PUT', '/api/admin/products/:id', async (req, res, { params }) => {
  const i = db.products.findIndex((p) => p.id === params.id);
  if (i < 0) return fail(res, 404, 'Not found');
  try { db.products[i] = cleanProduct(await readBody(req), db.products[i]); save(); ok(res, db.products[i]); }
  catch (e) { fail(res, 400, e.message); }
}, { admin: true });
route('DELETE', '/api/admin/products/:id', (req, res, { params }) => {
  db.products = db.products.filter((p) => p.id !== params.id); save(); ok(res, { ok: true });
}, { admin: true });

route('GET', '/api/admin/orders', (req, res) => ok(res, [...db.orders].reverse()), { admin: true });
route('PUT', '/api/admin/orders/:id', async (req, res, { params }) => {
  const o = db.orders.find((x) => x.id === params.id);
  if (!o) return fail(res, 404, 'Not found');
  const b = await readBody(req);
  const statuses = ['pending', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];
  if (b.status && statuses.includes(b.status) && b.status !== o.status) {
    if (b.status === 'cancelled' || b.status === 'refunded') {
      if (o.status !== 'cancelled' && o.status !== 'refunded') for (const l of o.items) { const p = db.products.find((x) => x.id === l.productId); if (p) p.stock += l.qty; }
    }
    o.status = b.status;
    o.history.push({ status: b.status, at: new Date().toISOString(), note: str(b.note, 300) });
  }
  if (b.tracking !== undefined) o.tracking = str(b.tracking, 120);
  if (b.paymentStatus && ['awaiting', 'authorized', 'paid', 'refunded'].includes(b.paymentStatus)) o.paymentStatus = b.paymentStatus;
  save(); ok(res, o);
}, { admin: true });

route('GET', '/api/admin/reviews', (req, res) => ok(res, [...db.reviews].reverse().map((r) => ({ ...r, product: db.products.find((p) => p.id === r.productId)?.name }))), { admin: true });
route('PUT', '/api/admin/reviews/:id', async (req, res, { params }) => {
  const r = db.reviews.find((x) => x.id === params.id);
  if (!r) return fail(res, 404, 'Not found');
  const b = await readBody(req);
  r.approved = !!b.approved; save(); ok(res, r);
}, { admin: true });
route('DELETE', '/api/admin/reviews/:id', (req, res, { params }) => { db.reviews = db.reviews.filter((r) => r.id !== params.id); save(); ok(res, { ok: true }); }, { admin: true });

route('GET', '/api/admin/coupons', (req, res) => ok(res, db.coupons), { admin: true });
route('POST', '/api/admin/coupons', async (req, res) => {
  const b = await readBody(req);
  const code = str(b.code, 30).toUpperCase().replace(/\s+/g, '');
  if (!code) return fail(res, 400, 'Code is required');
  const c = { code, type: b.type === 'fixed' ? 'fixed' : 'percent', value: Math.max(0, num(b.value)), minSubtotal: Math.max(0, num(b.minSubtotal)), usageLimit: Math.max(0, Math.floor(num(b.usageLimit))), expires: str(b.expires, 10) || null, active: b.active !== false };
  const i = db.coupons.findIndex((x) => x.code === code);
  if (i >= 0) db.coupons[i] = { ...db.coupons[i], ...c }; else db.coupons.push({ ...c, used: 0 });
  save(); ok(res, c);
}, { admin: true });
route('DELETE', '/api/admin/coupons/:code', (req, res, { params }) => { db.coupons = db.coupons.filter((c) => c.code !== decodeURIComponent(params.code)); save(); ok(res, { ok: true }); }, { admin: true });

route('GET', '/api/admin/messages', (req, res) => ok(res, [...db.messages].reverse()), { admin: true });
route('PUT', '/api/admin/messages/:id', async (req, res, { params }) => {
  const m = db.messages.find((x) => x.id === params.id);
  if (!m) return fail(res, 404, 'Not found');
  m.read = !!(await readBody(req)).read; save(); ok(res, m);
}, { admin: true });
route('DELETE', '/api/admin/messages/:id', (req, res, { params }) => { db.messages = db.messages.filter((m) => m.id !== params.id); save(); ok(res, { ok: true }); }, { admin: true });

route('GET', '/api/admin/subscribers', (req, res, { query }) => {
  if (query.get('format') === 'csv') {
    const csv = 'email,source,created_at\n' + db.subscribers.map((s) => `${s.email},${s.source},${s.createdAt}`).join('\n');
    return send(res, 200, csv, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="subscribers.csv"' });
  }
  ok(res, [...db.subscribers].reverse());
}, { admin: true });
route('DELETE', '/api/admin/subscribers/:email', (req, res, { params }) => { db.subscribers = db.subscribers.filter((s) => s.email !== decodeURIComponent(params.email)); save(); ok(res, { ok: true }); }, { admin: true });

route('GET', '/api/admin/plugins', (req, res) => ok(res, db.plugins), { admin: true });
route('PUT', '/api/admin/plugins/:id', async (req, res, { params }) => {
  const p = db.plugins.find((x) => x.id === params.id);
  if (!p) return fail(res, 404, 'Not found');
  const b = await readBody(req);
  if (typeof b.enabled === 'boolean') p.enabled = b.enabled;
  if (b.config && typeof b.config === 'object') {
    for (const [k, v] of Object.entries(b.config)) if (k in (p.config || {})) p.config[k] = typeof p.config[k] === 'number' ? num(v) : typeof p.config[k] === 'boolean' ? !!v : str(v, 500);
  }
  save(); ok(res, p);
}, { admin: true });

route('GET', '/api/admin/settings', (req, res) => ok(res, { ...db.settings, categories: db.categories, adminUser: db.admin.username }), { admin: true });
route('PUT', '/api/admin/settings', async (req, res) => {
  const b = await readBody(req);
  const s = db.settings;
  for (const k of ['storeName', 'tagline', 'email', 'phone', 'address', 'hours', 'currency', 'taxState']) if (b[k] !== undefined) s[k] = str(b[k], 300);
  for (const k of ['taxRate', 'shippingFlat', 'freeShippingOver']) if (b[k] !== undefined) s[k] = Math.max(0, num(b[k]));
  if (b.social && typeof b.social === 'object') for (const k of Object.keys(s.social)) if (b.social[k] !== undefined) s.social[k] = str(b.social[k], 300);
  save(); ok(res, s);
}, { admin: true });
route('PUT', '/api/admin/password', async (req, res) => {
  const b = await readBody(req);
  if (!checkPassword(str(b.current), db.admin.salt, db.admin.hash)) return fail(res, 400, 'Current password is wrong');
  if (str(b.next).length < 8) return fail(res, 400, 'New password must be at least 8 characters');
  Object.assign(db.admin, hashPassword(b.next));
  if (str(b.username)) db.admin.username = str(b.username, 40);
  save(); ok(res, { ok: true });
}, { admin: true });

/* ---------- SEO / Google Merchant ---------- */
function productImageUrl(p) { return p.image?.startsWith('http') ? p.image : `${SITE_URL}/img/product/${p.slug}.svg`; }
route('GET', '/feed/google-merchant.xml', (req, res) => {
  if (!plugin('google-merchant').enabled) return send(res, 404, 'Feed disabled');
  const brand = plugin('google-merchant').config?.brand || db.settings.storeName;
  const items = db.products.filter((p) => p.active).map((p) => `
    <item>
      <g:id>${escXml(p.sku || p.id)}</g:id>
      <g:title>${escXml(p.name)}</g:title>
      <g:description>${escXml(p.description)}</g:description>
      <g:link>${SITE_URL}/product.html?p=${escXml(p.slug)}</g:link>
      <g:image_link>${escXml(productImageUrl(p))}</g:image_link>
      <g:availability>${p.stock > 0 ? 'in_stock' : 'out_of_stock'}</g:availability>
      <g:price>${p.price.toFixed(2)} ${db.settings.currency}</g:price>${p.salePrice && p.salePrice < p.price ? `
      <g:sale_price>${p.salePrice.toFixed(2)} ${db.settings.currency}</g:sale_price>` : ''}
      <g:brand>${escXml(brand)}</g:brand>
      <g:mpn>${escXml(p.sku || p.id)}</g:mpn>
      <g:condition>new</g:condition>
      <g:google_product_category>Vehicles &amp; Parts &gt; Vehicle Parts &amp; Accessories &gt; Motor Vehicle Electronics &gt; Motor Vehicle Subwoofers</g:google_product_category>
      <g:product_type>${escXml(db.categories.find((c) => c.id === p.category)?.name || '')}</g:product_type>
      <g:shipping><g:country>US</g:country><g:price>${(p.price >= db.settings.freeShippingOver ? 0 : db.settings.shippingFlat).toFixed(2)} ${db.settings.currency}</g:price></g:shipping>
    </item>`).join('');
  send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escXml(db.settings.storeName)}</title>
    <link>${SITE_URL}</link>
    <description>${escXml(db.settings.tagline)}</description>${items}
  </channel>
</rss>`, { 'Content-Type': 'application/xml; charset=utf-8' });
});
route('GET', '/sitemap.xml', (req, res) => {
  const pages = ['/', '/shop.html', '/custom.html', '/faq.html', '/contact.html', '/track.html'];
  const urls = [...pages.map((u) => SITE_URL + u), ...db.products.filter((p) => p.active).map((p) => `${SITE_URL}/product.html?p=${p.slug}`)];
  send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escXml(u)}</loc></url>`).join('\n')}\n</urlset>`, { 'Content-Type': 'application/xml; charset=utf-8' });
});
route('GET', '/robots.txt', (req, res) => send(res, 200, `User-agent: *\nDisallow: /admin/\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`));

/* Generated product image (SVG) so the store works without photo uploads. */
const COLOR_HEX = { black: '#1d1d1f', 'charcoal grey': '#3c4048', grey: '#6b6f76', gray: '#6b6f76', tan: '#b69a74', beige: '#c9b08a', blue: '#1e3a8a', red: '#991b1b', brown: '#5b3a22' };
route('GET', '/img/product/:slug', (req, res, { params }) => {
  const p = db.products.find((x) => x.slug === params.slug.replace(/\.svg$/, ''));
  const color = COLOR_HEX[(p?.options?.colors?.[0] || 'black').toLowerCase()] || '#1d1d1f';
  const subs = p?.options?.configurations?.some((c) => /dual|2/i.test(c.label)) ? 2 : 1;
  const ported = p?.enclosureType === 'ported';
  const circles = [...Array(subs)].map((_, i) => {
    const cx = subs === 1 ? 300 : 210 + i * 180;
    return `<circle cx="${cx}" cy="250" r="78" fill="#111"/><circle cx="${cx}" cy="250" r="70" fill="url(#cone)"/><circle cx="${cx}" cy="250" r="22" fill="#2a2a2a"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450"><defs><radialGradient id="cone"><stop offset="0" stop-color="#555"/><stop offset="1" stop-color="#151515"/></radialGradient><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f5f7"/><stop offset="1" stop-color="#dfe2e7"/></linearGradient></defs><rect width="600" height="450" fill="url(#bg)"/><ellipse cx="300" cy="372" rx="250" ry="18" fill="#000" opacity=".15"/><path d="M60 150 L540 150 L560 360 L40 360 Z" fill="${color}"/><path d="M60 150 L540 150 L520 120 L90 120 Z" fill="${color}" opacity=".75"/>${circles}${ported ? '<rect x="470" y="300" width="60" height="40" rx="6" fill="#0b0b0b"/>' : ''}<text x="300" y="420" text-anchor="middle" font-family="Arial" font-size="18" fill="#666">${escXml(p?.name || 'Subwoofer enclosure').slice(0, 60)}</text></svg>`;
  send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
});

/* ------------------------------------------------------------ static files */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const nf = path.join(PUBLIC_DIR, '404.html');
      return fs.existsSync(nf) ? send(res, 404, fs.readFileSync(nf), { 'Content-Type': MIME['.html'] }) : send(res, 404, 'Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.admin && !isAdmin(req)) return fail(res, 401, 'Unauthorized');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.handler(req, res, { params, query: url.searchParams });
    }
    if (url.pathname.startsWith('/api/')) return fail(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Server error');
    if (!e.status) console.error(e);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Store running at http://localhost:${PORT}`);
    console.log(`Admin panel  at http://localhost:${PORT}/admin/`);
  });
}
module.exports = server;
