# Scholars&Tutors website + Paystack activation

## What's here

- `public/index.html` – the whole marketing site and pricing page (one file, no build step).
- `backend-additions/models/Payment.js` – records each checkout attempt.
- `backend-additions/routes/payments.js` – `/initialize`, `/verify/:reference`, the Paystack webhook, and a `hasFullAccess(user)` helper.

## Deploy the site on Render

New → **Static Site** → connect this repo, then:

| Setting | Value |
|---|---|
| Branch | `main` |
| Build command | *(leave empty)* |
| Publish directory | `public` |

Add your domain under Settings → Custom Domains.

Only `public/` is served. The `backend-additions/` folder stays private; Those files belong in the `aitutor` backend.

## 1. Backend (aitutor repo on Render)

Copy `backend-additions/models/Payment.js` to `server/models/` and `backend-additions/routes/payments.js` to `server/routes/`, then in `server.js`:

```js
const cors = require('cors');
const payments = require('./routes/payments');

// Webhook FIRST, with the raw body, so the signature check works
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), payments.webhook);

app.use(express.json());
app.use(cors({ origin: ['https://scholarstutors.com', 'https://www.scholarstutors.com'] })); // your site domain
app.use('/api/payments', payments.router);
```

Add to the User schema:

```js
subscription: {
  status: { type: String, enum: ['none', 'active'], default: 'none' },
  source: { type: String, enum: ['paystack', 'google_play', 'bulk'] },
  expiresAt: Date,
  lastReference: String,
},
```

`findStudent()` in `payments.js` looks up `email` and `phone`. Rename those if your User model uses different fields, and point `hasFullAccess()` at your existing trial field.

Render environment variables:

| Variable | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | `sk_test_...` while testing, `sk_live_...` at launch |
| `PAYSTACK_CALLBACK_URL` | the site's address, e.g. `https://scholarstutors.com/` |

Uses Node's built-in `fetch`, so Render needs Node 18 or newer.

## 2. Paystack dashboard

- Settings → API Keys & Webhooks → Webhook URL: `https://api.euritechnologies.com/api/payments/webhook`
- Settings → Preferences → payment channels: enable Card, Bank Transfer, USSD, Bank, and OPay/mobile money.

## 3. Website

Edit the `CONFIG` block at the bottom of `public/index.html`:

- `API_BASE` – already `https://api.euritechnologies.com`
- `PLAY_URL` – swap in the real Play Store listing link once the app is published

Host the file anywhere static (Netlify, Vercel, Cloudflare Pages, cPanel). Paystack returns users to `PAYSTACK_CALLBACK_URL?reference=...`, and the page confirms the payment and shows the activation result at the top.

The `/terms` and `/privacy` footer links expect pages at those paths. Your Play Store listing needs the privacy URL too.

## 4. Test before going live

1. Sign up in the app with a test account.
2. On the site, enter that email or phone and pay with Paystack's test card `4084 0840 8408 4081` (any future expiry, CVV `408`, OTP `123456`).
3. Confirm the site shows "account is active" and the user's `subscription.expiresAt` is a year out.
4. Pay again for the same account and confirm it adds a second year rather than resetting.

## Keep the Play build compliant

The app must not link to this site's pricing page, show the price, or tell users to pay here. That includes push notifications. Reach users with the payment link by SMS, WhatsApp or email instead.
