const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const Payment = require('../models/Payment');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL; // e.g. https://scholarstutors.com/
const PRICE_KOBO = 2000 * 100; // ₦2,000
const PLAN_DAYS = 365;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!PAYSTACK_SECRET) console.warn('[payments] PAYSTACK_SECRET_KEY is not set');

// ---------- helpers ----------

// Turns 0803..., 803..., 234803..., +234803... into 08031234567
function toLocalPhone(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('234')) d = '0' + d.slice(3);
  if (d.length === 10) d = '0' + d;
  return d;
}

// Adjust the field names if your User model stores email/phone differently.
async function findStudent(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) return User.findOne({ email: id.toLowerCase() });
  const local = toLocalPhone(id); // 08031234567
  if (local.length !== 11) return null;
  const intl = '+234' + local.slice(1); // +2348031234567
  return User.findOne({ phone: { $in: [local, intl, intl.slice(1)] } });
}

// "Adaeze Okafor" -> "Adaeze O." so the site never exposes a full name
function shortName(user) {
  const parts = String(user.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'The student';
  return parts[1] ? `${parts[0]} ${parts[1][0]}.` : parts[0];
}

async function paystack(path, options = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(body.message || `Paystack error ${res.status}`);
  return body.data;
}

// Grants a year of access. Safe to call from both the webhook and /verify:
// the atomic pending -> success claim means the year is only added once.
async function applyPayment(payment, tx) {
  if (payment.status !== 'pending') return payment;

  if (tx.status !== 'success') {
    if (['failed', 'abandoned'].includes(tx.status)) {
      payment.status = tx.status;
      await payment.save();
    }
    return payment;
  }

  if (tx.amount < payment.amount || tx.currency !== 'NGN') {
    payment.status = 'amount_mismatch';
    await payment.save();
    console.error('[payments] amount mismatch', payment.reference, tx.amount, tx.currency);
    return payment;
  }

  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'pending' },
    { status: 'success', paidAt: new Date(tx.paid_at || Date.now()), channel: tx.channel },
    { new: true }
  );
  if (!claimed) return Payment.findById(payment._id); // the other path got here first

  const user = await User.findById(payment.user);
  const now = new Date();
  const current = user.subscription && user.subscription.expiresAt;
  const base = current && current > now ? current : now; // early renewal stacks
  const expiresAt = new Date(base.getTime() + PLAN_DAYS * 24 * 60 * 60 * 1000);

  user.subscription = {
    status: 'active',
    source: 'paystack',
    expiresAt,
    lastReference: payment.reference,
  };
  await user.save();

  claimed.expiresAt = expiresAt;
  await claimed.save();
  return claimed;
}

// ---------- public routes (mounted after express.json) ----------

const router = express.Router();

// POST /api/payments/initialize  { identifier, payerEmail? }
router.post('/initialize', async (req, res) => {
  try {
    const { identifier, payerEmail } = req.body || {};
    const user = await findStudent(identifier);
    if (!user) {
      return res.status(404).json({
        message:
          "We couldn't find an account with that email or phone number. Check it matches what the student used to sign up in the app.",
      });
    }

    // Paystack needs an email. Use the payer's if given, else the student's.
    const email = (payerEmail || user.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({
        message: 'This account has no email address. Tick "paying for someone else" and enter an email for the receipt.',
      });
    }

    const reference = `ST-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await Payment.create({
      user: user._id,
      reference,
      amount: PRICE_KOBO,
      payerEmail: email,
      paidForSomeoneElse: Boolean(payerEmail) && payerEmail.toLowerCase() !== (user.email || '').toLowerCase(),
    });

    const tx = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email,
        amount: PRICE_KOBO,
        currency: 'NGN',
        reference,
        callback_url: CALLBACK_URL,
        metadata: {
          userId: String(user._id),
          custom_fields: [
            { display_name: 'Student', variable_name: 'student', value: shortName(user) },
            { display_name: 'Plan', variable_name: 'plan', value: 'Scholars&Tutors yearly' },
          ],
        },
      }),
    });

    res.json({ authorizationUrl: tx.authorization_url, reference, studentName: shortName(user) });
  } catch (err) {
    console.error('[payments] initialize failed', err);
    res.status(502).json({ message: "We couldn't start the payment. Please try again in a moment." });
  }
});

// GET /api/payments/verify/:reference  — called by the website after Paystack redirects back
router.get('/verify/:reference', async (req, res) => {
  try {
    let payment = await Payment.findOne({ reference: req.params.reference });
    if (!payment) return res.status(404).json({ status: 'not_found' });

    if (payment.status === 'pending') {
      const tx = await paystack(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
      payment = await applyPayment(payment, tx);
    }

    const user = await User.findById(payment.user).select('name');
    res.json({
      status: payment.status === 'success' ? 'success' : payment.status === 'pending' ? 'pending' : 'failed',
      studentName: user ? shortName(user) : 'The student',
      expiresAt: payment.expiresAt,
    });
  } catch (err) {
    console.error('[payments] verify failed', err);
    res.status(502).json({ status: 'pending' });
  }
});

// ---------- webhook (needs the raw body; mount BEFORE express.json) ----------

const webhook = express.Router();

// POST /api/payments/webhook
webhook.post('/', async (req, res) => {
  const signature = req.get('x-paystack-signature') || '';
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.sendStatus(401);

  res.sendStatus(200); // acknowledge fast; Paystack retries on slow responses

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event !== 'charge.success') return;
    const payment = await Payment.findOne({ reference: event.data.reference });
    if (!payment) return console.warn('[payments] webhook for unknown reference', event.data.reference);
    // Re-verify with Paystack instead of trusting the payload alone
    const tx = await paystack(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
    await applyPayment(payment, tx);
  } catch (err) {
    console.error('[payments] webhook handling failed', err);
  }
});

// ---------- access check for the rest of the API ----------

// Use this wherever the app decides whether premium features are unlocked.
// Adjust trialEndsAt to whatever field your trial logic already uses.
function hasFullAccess(user, now = new Date()) {
  const paid = user.subscription && user.subscription.expiresAt && user.subscription.expiresAt > now;
  const inTrial = user.trialEndsAt && user.trialEndsAt > now;
  return Boolean(paid || inTrial);
}

module.exports = { router, webhook, hasFullAccess };
