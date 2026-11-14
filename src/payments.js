const crypto = require('crypto');
const config = require('./config');

const live = Boolean(config.paystackKey);
const PAYSTACK = 'https://api.paystack.co';

// Starts a payment and returns the URL the buyer should be sent to.
async function initializePayment({ reference, email, amountKobo }) {
  if (!live) {
    return { url: `${config.baseUrl}/mock-pay.html?reference=${reference}`, mock: true };
  }
  const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      currency: 'NGN',
      callback_url: `${config.baseUrl}/ticket.html?reference=${reference}`,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.status) throw new Error(body.message || 'Could not start payment.');
  return { url: body.data.authorization_url, mock: false };
}

// Asks Paystack directly whether a payment succeeded. Used as a fallback when
// the webhook cannot reach a local machine.
async function verifyPayment(reference) {
  if (!live) return null;
  const res = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${config.paystackKey}` },
  });
  const body = await res.json();
  if (!res.ok || !body.status) return null;
  return { success: body.data.status === 'success', amountKobo: body.data.amount };
}

// Sends money back to the buyer. Paystack queues the refund and settles it shortly after.
async function refund(reference, amountKobo) {
  if (!live) return { mock: true };
  const res = await fetch(`${PAYSTACK}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: reference, amount: amountKobo }),
  });
  const body = await res.json();
  if (!res.ok || !body.status) throw new Error(body.message || 'Refund failed.');
  return { mock: false, status: body.data && body.data.status };
}

// Paystack signs the raw request body with HMAC-SHA512 using your secret key.
function validWebhookSignature(rawBody, signature) {
  if (!live || !signature) return false;
  const expected = crypto.createHmac('sha512', config.paystackKey).update(rawBody).digest('hex');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = { live, initializePayment, verifyPayment, refund, validWebhookSignature };
