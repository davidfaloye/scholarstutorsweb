const mongoose = require('mongoose');

// One document per checkout attempt. The unique reference lets the webhook
// and the callback both look up the same payment without double-activating.
const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, required: true, unique: true },
    amount: { type: Number, required: true }, // in kobo
    currency: { type: String, default: 'NGN' },
    payerEmail: { type: String, required: true },
    paidForSomeoneElse: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'abandoned', 'amount_mismatch'],
      default: 'pending',
      index: true,
    },
    channel: String, // card, bank_transfer, ussd, bank, mobile_money...
    paidAt: Date,
    expiresAt: Date, // the subscription end date this payment produced
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
