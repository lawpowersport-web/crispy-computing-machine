/* BassBox Enclosures — shared storefront script (header, footer, cart, plugins) */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  const App = { $, $$, esc, api, store, config: null, plugins: {} };
  App.on = (id) => !!App.plugins[id]?.enabled;
  App.pcfg = (id) => App.plugins[id]?.config || {};
  App.money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: App.config?.store.currency || 'USD' }).format(n || 0);
  App.img = (p) => (p.image ? p.image : `/img/product/${encodeURIComponent(p.slug)}.svg`);
  App.stars = (r, count) => {
    const full = Math.round(r || 0);
    return `<span class="stars" aria-label="${r} out of 5">${'★'.repeat(full)}${'☆'.repeat(5 - full)}${count != null ? `<small>(${count})</small>` : ''}</span>`;
  };
  App.priceHtml = (p) => p.salePrice && p.salePrice < p.price
    ? `<span class="price"><span class="sale">${App.money(p.salePrice)}</span><del>${App.money(p.price)}</del></span>`
    : `<span class="price">${App.money(p.price)}</span>`;

  App.toast = (msg) => {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2800);
  };

  /* ---------------- cart ---------------- */
  const CART = 'bb_cart';
  App.cart = {
    items: () => store.get(CART, []),
    save(items) { store.set(CART, items); App.updateBadges(); document.dispatchEvent(new CustomEvent('cart:change')); },
    key: (productId, options) => productId + '|' + JSON.stringify(options || {}),
    add(product, options, qty = 1, unitPrice) {
      const items = this.items();
      const key = this.key(product.id, options);
      const ex = items.find((i) => i.key === key);
      if (ex) ex.qty = Math.min(20, ex.qty + qty);
      else items.push({ key, productId: product.id, slug: product.slug, name: product.name, image: App.img(product), options, qty, unitPrice });
      this.save(items);
    },
    setQty(key, qty) { const items = this.items(); const i = items.find((x) => x.key === key); if (i) i.qty = Math.max(1, Math.min(20, qty)); this.save(items); },
    remove(key) { this.save(this.items().filter((i) => i.key !== key)); },
    clear() { this.save([]); },
    count() { return this.items().reduce((s, i) => s + i.qty, 0); },
    subtotal() { return this.items().reduce((s, i) => s + i.qty * i.unitPrice, 0); },
    payload() { return this.items().map((i) => ({ productId: i.productId, qty: i.qty, options: i.options })); },
  };
  App.optionText = (o) => {
    if (!o) return '';
    const parts = [];
    if (o.subSize) parts.push(`${o.subSize}" sub`);
    if (o.configuration) parts.push(o.configuration);
    if (o.color) parts.push(`${o.color} carpet`);
    if (o.addons?.length) parts.push('+ ' + o.addons.join(', '));
    return parts.join(' • ');
  };

  /* ---------------- wishlist ---------------- */
  App.wishlist = {
    ids: () => store.get('bb_wishlist', []),
    has(id) { return this.ids().includes(id); },
    toggle(id) {
      const ids = this.ids();
      const on = !ids.includes(id);
      store.set('bb_wishlist', on ? [...ids, id] : ids.filter((x) => x !== id));
      App.updateBadges();
      App.toast(on ? 'Added to wishlist' : 'Removed from wishlist');
      return on;
    },
  };

  App.updateBadges = () => {
    const c = $('#cart-count'); if (c) c.textContent = App.cart.count();
    const w = $('#wish-count'); if (w) w.textContent = App.wishlist.ids().length;
  };

  /* ---------------- product card ---------------- */
  App.productCard = (p) => {
    const sale = p.salePrice && p.salePrice < p.price;
    const fit = p.universal ? 'Universal fit' : (p.fitment?.[0] ? `${p.fitment[0].make} ${p.fitment[0].model}` : '');
    return `<article class="card">
      ${sale ? `<span class="tag">Sale</span>` : p.stock <= 0 ? `<span class="tag" style="background:#555">Sold out</span>` : ''}
      ${App.on('wishlist') ? `<button class="wish-btn ${App.wishlist.has(p.id) ? 'on' : ''}" data-wish="${esc(p.id)}" aria-label="Toggle wishlist">${App.wishlist.has(p.id) ? '♥' : '♡'}</button>` : ''}
      <a class="card-img" href="/product.html?p=${encodeURIComponent(p.slug)}"><img loading="lazy" src="${esc(App.img(p))}" alt="${esc(p.name)}"></a>
      <div class="card-body">
        <span class="card-meta">${esc(fit)} • ${esc(p.enclosureType)}</span>
        <a class="card-title" href="/product.html?p=${encodeURIComponent(p.slug)}">${esc(p.name)}</a>
        ${App.on('reviews') && p.reviewCount ? App.stars(p.rating, p.reviewCount) : ''}
        ${App.priceHtml(p)}
      </div>
    </article>`;
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wish]');
    if (!b) return;
    e.preventDefault();
    const on = App.wishlist.toggle(b.dataset.wish);
    b.classList.toggle('on', on);
    b.textContent = on ? '♥' : '♡';
    document.dispatchEvent(new CustomEvent('wishlist:change'));
  });

  /* ---------------- vehicle selection (fitment) ---------------- */
  App.vehicle = {
    get: () => store.get('bb_vehicle', null),
    set: (v) => store.set('bb_vehicle', v),
    clear: () => localStorage.removeItem('bb_vehicle'),
    label: (v) => (v ? `${v.year} ${v.make} ${v.model}` : ''),
  };
  /** Wires up Year/Make/Model selects inside a container. onGo(vehicle) is called on submit. */
  App.mountFinder = async (root, onGo) => {
    const tree = await api('/api/fitment').catch(() => ({}));
    const [ySel, mSel, moSel] = ['year', 'make', 'model'].map((n) => $(`[name=${n}]`, root));
    const years = [...new Set(Object.values(tree).flatMap((m) => Object.values(m).flat()))].sort((a, b) => b - a);
    ySel.innerHTML = '<option value="">Year</option>' + years.map((y) => `<option>${y}</option>`).join('');
    const fillMakes = () => {
      const y = +ySel.value;
      const makes = Object.keys(tree).filter((mk) => !y || Object.values(tree[mk]).some((ys) => ys.includes(y)));
      mSel.innerHTML = '<option value="">Make</option>' + makes.map((m) => `<option>${esc(m)}</option>`).join('');
      mSel.disabled = !makes.length; fillModels();
    };
    const fillModels = () => {
      const y = +ySel.value, mk = mSel.value;
      const models = mk ? Object.keys(tree[mk]).filter((mo) => !y || tree[mk][mo].includes(y)) : [];
      moSel.innerHTML = '<option value="">Model</option>' + models.map((m) => `<option>${esc(m)}</option>`).join('');
      moSel.disabled = !models.length;
    };
    ySel.onchange = fillMakes; mSel.onchange = fillModels;
    fillMakes();
    const v = App.vehicle.get();
    if (v) { ySel.value = v.year; fillMakes(); mSel.value = v.make; fillModels(); moSel.value = v.model; }
    root.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!ySel.value || !mSel.value || !moSel.value) return App.toast('Please choose year, make and model');
      const veh = { year: +ySel.value, make: mSel.value, model: moSel.value };
      App.vehicle.set(veh);
      onGo ? onGo(veh) : (location.href = `/shop.html?year=${veh.year}&make=${encodeURIComponent(veh.make)}&model=${encodeURIComponent(veh.model)}`);
    });
  };

  /* ---------------- layout ---------------- */
  const LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="#fff"/></svg>`;
  function renderHeader() {
    const s = App.config.store;
    const path = location.pathname;
    const nav = [['/', 'Home'], ['/shop.html', 'Shop All'], ['/shop.html?category=underseat', 'Underseat'], ['/custom.html', 'Custom Box'], ['/faq.html', 'FAQ'], ['/contact.html', 'Contact']];
    const el = $('#site-header');
    if (!el) return;
    el.outerHTML = `
      ${App.on('announcement-bar') && App.pcfg('announcement-bar').text ? `<div class="announcement">${esc(App.pcfg('announcement-bar').text)}</div>` : ''}
      <div class="topbar"><div class="container">
        <span>📞 <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a> &nbsp;•&nbsp; ✉️ <a href="mailto:${esc(s.email)}">${esc(s.email)}</a></span>
        <span><a href="/track.html">Track Order</a> &nbsp;•&nbsp; ${esc(s.hours || '')}</span>
      </div></div>
      <header class="site-header"><div class="container">
        <button class="icon-btn menu-toggle" aria-label="Menu" id="menu-toggle">☰</button>
        <a href="/" class="logo"><span class="logo-mark">${LOGO_SVG}</span><span>${esc(s.name).replace(/^(\S+)/, '$1<em>')}</em></span></a>
        <nav class="main-nav" id="main-nav">${nav.map(([h, t]) => `<a href="${h}" class="${(h === path || (h !== '/' && path + location.search === h)) ? 'active' : ''}">${t}</a>`).join('')}</nav>
        <form class="header-search" action="/shop.html"><input name="q" placeholder="Search by truck or part #" aria-label="Search"><button aria-label="Search">🔍</button></form>
        <div class="header-icons">
          ${App.on('wishlist') ? `<a class="icon-btn" href="/wishlist.html" aria-label="Wishlist">♡<span class="badge" id="wish-count">0</span></a>` : ''}
          <button class="icon-btn" id="cart-btn" aria-label="Cart">🛒<span class="badge" id="cart-count">0</span></button>
        </div>
      </div></header>`;
    $('#menu-toggle').onclick = () => $('#main-nav').classList.toggle('open');
    $('#cart-btn').onclick = openCartDrawer;
  }

  function renderFooter() {
    const s = App.config.store;
    const el = $('#site-footer');
    if (!el) return;
    const soc = Object.entries(s.social || {}).filter(([, v]) => v);
    el.outerHTML = `<footer class="site-footer"><div class="container">
      <div class="footer-grid">
        <div>
          <a href="/" class="logo" style="margin-bottom:14px"><span class="logo-mark">${LOGO_SVG}</span><span>${esc(s.name)}</span></a>
          <p>${esc(s.tagline)}</p>
          <p>${esc(s.address)}</p>
          ${soc.length ? `<div class="socials">${soc.map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener" aria-label="${k}">${k.slice(0, 2).toUpperCase()}</a>`).join('')}</div>` : ''}
        </div>
        <div><h4>Shop</h4><ul>${App.config.categories.map((c) => `<li><a href="/shop.html?category=${c.id}">${esc(c.name)}</a></li>`).join('')}<li><a href="/custom.html">Custom Enclosures</a></li></ul></div>
        <div><h4>Support</h4><ul><li><a href="/contact.html">Contact Us</a></li><li><a href="/track.html">Track Your Order</a></li><li><a href="/faq.html">FAQ</a></li><li><a href="/faq.html#shipping">Shipping & Returns</a></li><li><a href="/faq.html#warranty">Warranty</a></li></ul></div>
        <div><h4>Get in touch</h4><ul><li>📞 <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></li><li>✉️ <a href="mailto:${esc(s.email)}">${esc(s.email)}</a></li><li>🕘 ${esc(s.hours || '')}</li></ul>
          <form class="coupon-row" id="footer-news"><input type="email" name="email" placeholder="Your email" required aria-label="Email"><button class="btn btn-sm">Join</button></form>
        </div>
      </div>
      <div class="footer-bottom"><span>© ${new Date().getFullYear()} ${esc(s.name)}. All rights reserved.</span>
        <div class="pay-icons"><span>VISA</span><span>MC</span><span>AMEX</span><span>DISCOVER</span><span>PAYPAL</span></div></div>
    </div></footer>`;
    App.bindNewsletter($('#footer-news'), 'footer');
  }

  App.bindNewsletter = (form, source) => {
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api('/api/newsletter', { method: 'POST', body: { email: form.email.value, source } }); App.toast(r.message); form.reset(); store.set('bb_news_done', 1); }
      catch (err) { App.toast(err.message); }
    });
  };

  /* ---------------- cart drawer ---------------- */
  function openCartDrawer() {
    let d = $('#cart-drawer');
    if (!d) {
      document.body.insertAdjacentHTML('beforeend', `<div class="overlay hidden" id="cart-overlay"></div>
        <aside class="drawer" id="cart-drawer" aria-label="Cart"><div class="drawer-head"><h3 style="margin:0">Your Cart</h3><button class="modal-close" style="position:static" id="drawer-close">×</button></div>
        <div class="drawer-body" id="drawer-body"></div><div class="drawer-foot" id="drawer-foot"></div></aside>`);
      d = $('#cart-drawer');
      const close = () => { d.classList.remove('open'); $('#cart-overlay').classList.add('hidden'); };
      $('#drawer-close').onclick = close; $('#cart-overlay').onclick = close;
      document.addEventListener('cart:change', renderDrawer);
    }
    renderDrawer();
    d.classList.add('open'); $('#cart-overlay').classList.remove('hidden');
  }
  App.openCart = openCartDrawer;
  function renderDrawer() {
    const items = App.cart.items();
    const body = $('#drawer-body'); if (!body) return;
    if (!items.length) { body.innerHTML = `<div class="empty" style="margin-top:20px">Your cart is empty.<br><br><a class="btn btn-sm" href="/shop.html">Shop boxes</a></div>`; $('#drawer-foot').innerHTML = ''; return; }
    body.innerHTML = items.map((i) => `<div class="mini-line"><img src="${esc(i.image)}" alt=""><div class="grow"><strong>${esc(i.name)}</strong><div class="muted" style="font-size:.8rem">${esc(App.optionText(i.options))}</div>${i.qty} × ${App.money(i.unitPrice)}</div><button class="remove-btn" data-rm="${esc(i.key)}">Remove</button></div>`).join('');
    $$('[data-rm]', body).forEach((b) => (b.onclick = () => App.cart.remove(b.dataset.rm)));
    const sub = App.cart.subtotal(), free = App.config.store.freeShippingOver;
    $('#drawer-foot').innerHTML = `${free ? `<div style="font-size:.85rem">${sub >= free ? '🎉 You qualify for free shipping!' : `Add ${App.money(free - sub)} more for free shipping`}</div><div class="free-ship-bar"><span style="width:${Math.min(100, (sub / free) * 100)}%"></span></div>` : ''}
      <div class="summary-row total" style="border:0;margin:0;padding:0"><span>Subtotal</span><span>${App.money(sub)}</span></div>
      <a class="btn btn-block" href="/checkout.html">Checkout</a><a class="btn btn-outline btn-block" href="/cart.html">View Cart</a>`;
  }

  /* ---------------- plugins ---------------- */
  function pluginNewsletterPopup() {
    if (!App.on('newsletter-popup') || store.get('bb_news_done') || sessionStorage.getItem('bb_news_seen')) return;
    const c = App.pcfg('newsletter-popup');
    setTimeout(() => {
      sessionStorage.setItem('bb_news_seen', 1);
      document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="news-modal"><div class="modal">
        <button class="modal-close" aria-label="Close">×</button>
        <div style="font-size:2.4rem">🔊</div><h2>${esc(c.headline || 'Join our list')}</h2>
        <p class="muted">Get exclusive deals, new vehicle fitments and install tips.</p>
        <form id="news-popup-form" style="display:flex;flex-direction:column;gap:10px"><input type="email" name="email" placeholder="Enter your email" required aria-label="Email"><button class="btn btn-block">Unlock my discount</button></form>
        <p style="margin-top:10px;font-size:.8rem" class="muted">No spam. Unsubscribe anytime.</p></div></div>`);
      const m = $('#news-modal');
      const close = () => m.remove();
      $('.modal-close', m).onclick = close;
      m.onclick = (e) => e.target === m && close();
      const f = $('#news-popup-form');
      App.bindNewsletter(f, 'popup');
      f.addEventListener('submit', () => setTimeout(close, 400));
    }, (c.delaySeconds || 8) * 1000);
  }

  function pluginChat() {
    if (!App.on('live-chat')) return;
    const c = App.pcfg('live-chat');
    const answers = {
      'Will it fit my truck?': 'Use the Year / Make / Model finder at the top of the shop. Every box listed for your vehicle is designed for that exact cab.',
      'How long to ship?': 'Boxes are built to order in 3–5 business days, then ship in 2–5 days within the continental US.',
      'Which subs fit?': 'Our underseat boxes are made for shallow-mount subwoofers. Check the mounting depth in the product Specs tab.',
      'Returns?': 'Unused boxes can be returned within 30 days. Custom boxes are final sale.',
    };
    document.body.insertAdjacentHTML('beforeend', `<button class="chat-launcher" id="chat-launch" aria-label="Chat with us">💬</button>
      <div class="chat-panel hidden" id="chat-panel"><div class="chat-head"><strong>${esc(App.config.store.name)}</strong><br><small>Typically replies within a few hours</small></div>
      <div class="chat-body" id="chat-body"><div class="bubble">${esc(c.greeting || 'Hi! How can we help?')}</div><div class="quick">${Object.keys(answers).map((q) => `<button>${esc(q)}</button>`).join('')}</div></div>
      <form class="chat-form" id="chat-form"><input name="name" placeholder="Your name" required><input name="email" type="email" placeholder="Email" required><textarea name="message" rows="2" placeholder="Type your message…" required></textarea><button class="btn btn-sm">Send</button>
      ${c.whatsapp ? `<a class="btn btn-sm btn-dark" target="_blank" rel="noopener" href="https://wa.me/${esc(String(c.whatsapp).replace(/\D/g, ''))}">Chat on WhatsApp</a>` : ''}</form></div>`);
    const body = $('#chat-body');
    const add = (t, me) => { body.insertAdjacentHTML('beforeend', `<div class="bubble ${me ? 'me' : ''}">${esc(t)}</div>`); body.scrollTop = body.scrollHeight; };
    $('#chat-launch').onclick = () => $('#chat-panel').classList.toggle('hidden');
    $$('.quick button', body).forEach((b) => (b.onclick = () => { add(b.textContent, true); setTimeout(() => add(answers[b.textContent]), 400); }));
    $('#chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        add(f.message.value, true);
        await api('/api/contact', { method: 'POST', body: { type: 'chat', name: f.name.value, email: f.email.value, message: f.message.value } });
        add("Thanks! We've got your message and will email you shortly.");
        f.message.value = '';
      } catch (err) { add(err.message); }
    });
  }

  function pluginCookie() {
    if (!App.on('cookie-consent') || store.get('bb_cookie_ok')) return;
    document.body.insertAdjacentHTML('beforeend', `<div class="cookie-bar" id="cookie-bar">${esc(App.pcfg('cookie-consent').text)} <a href="/faq.html#privacy" style="text-decoration:underline">Learn more</a><br><button class="btn btn-sm">Accept</button></div>`);
    $('#cookie-bar button').onclick = () => { store.set('bb_cookie_ok', 1); $('#cookie-bar').remove(); };
  }

  function pluginBackToTop() {
    if (!App.on('back-to-top')) return;
    document.body.insertAdjacentHTML('beforeend', `<button class="to-top" id="to-top" aria-label="Back to top">↑</button>`);
    const b = $('#to-top');
    addEventListener('scroll', () => b.classList.toggle('show', scrollY > 600), { passive: true });
    b.onclick = () => scrollTo({ top: 0 });
  }

  function pluginTracking() {
    const ga = App.pcfg('analytics').measurementId;
    if (App.on('analytics') && /^G-[A-Z0-9]+$/.test(ga)) {
      const s = document.createElement('script'); s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${ga}`; document.head.appendChild(s);
      window.dataLayer = window.dataLayer || []; window.gtag = function () { dataLayer.push(arguments); }; gtag('js', new Date()); gtag('config', ga);
    }
    const px = App.pcfg('facebook-pixel').pixelId;
    if (App.on('facebook-pixel') && /^\d+$/.test(px)) {
      /* Standard Meta Pixel bootstrap */
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', px); fbq('track', 'PageView');
    }
  }
  App.track = (event, data) => { try { window.gtag?.('event', event, data); window.fbq?.('track', event, data); } catch {} };

  /* ---------------- boot ---------------- */
  App.ready = (async () => {
    try { App.config = await api('/api/config'); }
    catch { App.config = { store: { name: 'Store', currency: 'USD', social: {} }, plugins: {}, categories: [] }; }
    App.plugins = App.config.plugins;
    renderHeader(); renderFooter(); App.updateBadges();
    pluginTracking(); pluginNewsletterPopup(); pluginChat(); pluginCookie(); pluginBackToTop();
    return App;
  })();

  window.App = App;
})();
