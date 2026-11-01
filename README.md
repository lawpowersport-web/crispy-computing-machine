# BassBox Enclosures — Underseat Subwoofer Box Store

A complete e-commerce website for vehicle-specific underseat subwoofer enclosures,
with a storefront (front end), REST API (back end) and admin panel.
It's ready to submit to **Google Merchant Center**.

No frameworks and no `npm install`: plain HTML/CSS/JavaScript plus one Node.js file.

## Quick start

```bash
node server.js                # needs Node.js 18+
```

- Storefront: http://localhost:3000
- Admin panel: http://localhost:3000/admin/  (default login **admin / admin123**. Change it in Admin → Settings.)

Environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `SITE_URL` | Your live domain, used in the Google feed and sitemap | `http://localhost:PORT` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Initial admin login (first run only) | `admin` / `admin123` |
| `DB_FILE` | Path of the JSON database | `data/db.json` |

On first run, `data/db.json` is created from `data/seed.json`. Delete `db.json` to reset the store.

## Features

### Storefront (`public/`)
| Page | Features |
|---|---|
| `index.html` | Hero, **Year / Make / Model fitment finder**, category tiles, featured products, why-us, how-it-works, customer reviews, newsletter |
| `shop.html` | Vehicle filter, category / sub-size / price filters, sorting, search, filter chips |
| `product.html` | Sub size, single/dual, carpet color swatches, priced add-ons, live price, "Fits your vehicle" badge, tabs (description, specs, fitment, reviews, shipping), review form, related and recently viewed products, schema.org JSON-LD |
| `cart.html` | Quantity editing, coupon codes, free-shipping progress bar, prices recalculated on the server |
| `checkout.html` | Contact, shipping, vehicle notes, payment method, tax/shipping/discount totals, order confirmation |
| `track.html` | Order tracking by order number and email, with a status timeline |
| `custom.html` | Custom box quote request form |
| `faq.html`, `contact.html`, `wishlist.html`, `404.html` | Supporting pages |

The header, footer, slide-out cart drawer and plugin widgets are shared through `public/js/app.js`.

### Admin panel (`public/admin/`)
- **Dashboard**: revenue, a 14-day revenue chart, open orders, low stock, top products
- **Orders**: search and filter, order detail, status, payment status, tracking number, customer notes, CSV export, print
- **Products**: add, edit, duplicate and delete products. Edit price, sale price, stock, options (sizes, configurations, colors, add-ons), specs and **vehicle fitment** (make, model, years, cab)
- **Reviews**: approve, unpublish or delete
- **Coupons**: percent or fixed discounts, minimum subtotal, usage limit, expiry date
- **Messages**: contact form, custom quote and live chat messages
- **Subscribers**: newsletter list with CSV export
- **Plugins**: switch features on or off and configure them
- **SEO & Feeds**: Google Merchant feed URL, sitemap, robots.txt
- **Settings**: store info, currency, shipping, tax, social links, admin password

### Plugins (switch on or off in Admin → Plugins)
Vehicle Fitment Finder · Product Reviews & Stars · Live Chat (with an optional WhatsApp link) ·
Newsletter Popup · Announcement Bar · Coupons · Wishlist · Recently Viewed · Pay-Later Messaging ·
Cookie Consent · Google Merchant Center Feed · SEO & Structured Data · Google Analytics (GA4) ·
Meta Pixel · Back-to-Top button

## Google Merchant Center
1. Deploy the site on your domain with HTTPS and start it with `SITE_URL=https://yourdomain.com`.
2. **Add real product photos.** Google rejects SVG images, so upload a JPG or PNG for each product and paste its URL into Admin → Products → Image URL.
3. In Merchant Center, go to Products → Feeds → Add feed → Scheduled fetch and enter
   `https://yourdomain.com/feed/google-merchant.xml`.
4. Submit `https://yourdomain.com/sitemap.xml` in Google Search Console.
5. Merchant Center also requires visible shipping, return and contact information. The FAQ and Contact pages cover this. Replace the placeholder phone, email and address in Admin → Settings.

## Before going live
- **Payments:** the checkout card form is a demo and card numbers are never sent to the server. Connect a real gateway (Stripe Checkout, Square or PayPal) in `checkout.html` and in `POST /api/orders` in `server.js`.
- **Emails:** to send order confirmations, add an email provider (SMTP, SendGrid, etc.) in the `POST /api/orders` handler.
- Change the admin password and run behind HTTPS (Nginx, Caddy, or a host such as Render or Railway).
- Back up `data/db.json` regularly.

## API reference
Public: `GET /api/config`, `GET /api/fitment`, `GET /api/products`, `GET /api/products/:slug`,
`GET /api/reviews/featured`, `POST /api/reviews`, `POST /api/newsletter`, `POST /api/contact`,
`POST /api/coupons/validate`, `POST /api/cart/quote`, `POST /api/orders`, `GET /api/orders/track`

Admin (Bearer token from `POST /api/admin/login`): `/api/admin/stats`, `products`, `orders`,
`reviews`, `coupons`, `messages`, `subscribers`, `plugins`, `settings`, `password`
