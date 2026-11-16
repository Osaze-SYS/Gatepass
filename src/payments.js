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

// ---------------------------------------------------------------------------
// Payouts (Paystack Transfers). Without a Paystack key everything below is simulated, so the whole flow can be tried safely.
// ---------------------------------------------------------------------------
const MOCK_BANKS = [['Access Bank', '044'], ['Ecobank Nigeria', '050'], ['FCMB', '214'], ['Fidelity Bank', '070'], ['First Bank of Nigeria', '011'], ['Guaranty Trust Bank', '058'],
  ['Keystone Bank', '082'], ['Kuda Microfinance Bank', '50211'], ['Moniepoint MFB', '50515'], ['OPay', '999992'], ['PalmPay', '999991'], ['Polaris Bank', '076'],
  ['Providus Bank', '101'], ['Stanbic IBTC Bank', '221'], ['Sterling Bank', '232'], ['Union Bank', '032'], ['United Bank for Africa', '033'], ['Wema Bank', '035'], ['Zenith Bank', '057']]
  .map(([name, code]) => ({ name, code }));

// Turns a failed Paystack answer into an Error. `retryable` means "we do not know the transfer failed, so trying again is safe
// with the same reference": network trouble, server errors, and an empty balance (it fills up as Paystack settles sales).
function providerError(res, body, fallback) {
  const message = (body && body.message) || fallback;
  const err = new Error(message);
  err.retryable = !res || res.status >= 500 || /balance/i.test(message);
  return err;
}

let bankCache = { at: 0, list: null };
async function listBanks() {
  if (!live) return MOCK_BANKS;
  if (bankCache.list && Date.now() - bankCache.at < 24 * 3600e3) return bankCache.list;
  const res = await fetch(`${PAYSTACK}/bank?currency=NGN&perPage=200`, { headers: { Authorization: `Bearer ${config.paystackKey}` } });
  const body = await res.json();
  if (!res.ok || !body.status) throw providerError(res, body, 'Could not load the list of banks.');
  const list = body.data.filter((b) => b.code && b.active !== false && b.is_deleted !== true).map((b) => ({ name: b.name, code: String(b.code) })).sort((a, b) => a.name.localeCompare(b.name));
  bankCache = { at: Date.now(), list };
  return list;
}

// Looks up the name on a bank account, so the organizer can confirm it is theirs before saving.
async function resolveAccount({ accountNumber, bankCode }) {
  if (!live) return { accountName: `PRACTICE ACCOUNT ${accountNumber.slice(-4)}` };
  const res = await fetch(`${PAYSTACK}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`, { headers: { Authorization: `Bearer ${config.paystackKey}` } });
  const body = await res.json();
  if (!res.ok || !body.status) throw new Error('We could not verify that account. Check the bank and account number.');
  return { accountName: body.data.account_name };
}

// Paystack keeps the full account number; we only keep the code it gives back.
async function createRecipient({ name, accountNumber, bankCode }) {
  if (!live) return { recipientCode: 'RCP_practice_' + crypto.randomBytes(6).toString('hex') };
  const res = await fetch(`${PAYSTACK}/transferrecipient`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' }),
  });
  const body = await res.json();
  if (!res.ok || !body.status) throw providerError(res, body, 'Could not save the account.');
  return { recipientCode: body.data.recipient_code };
}

// Sends money from the Paystack balance. The reference makes it safe to repeat: the same reference never pays twice.
// status: 'success' | 'pending' (Paystack is processing it) | 'otp' (Paystack wants a human to approve it).
async function transfer({ reference, amountKobo, recipientCode, reason }) {
  if (!live) return { status: 'success', transferCode: 'TRF_practice_' + crypto.randomBytes(6).toString('hex') };
  let res, body;
  try {
    res = await fetch(`${PAYSTACK}/transfer`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'balance', amount: amountKobo, recipient: recipientCode, reference, reason }),
    });
    body = await res.json();
  } catch (err) { err.retryable = true; throw err; }          // no answer at all: we cannot know, so it stays safe to retry
  if (!res.ok || !body.status) throw providerError(res, body, 'The transfer was rejected.');
  return { status: body.data.status, transferCode: body.data.transfer_code };
}

async function verifyTransfer(reference) {
  if (!live) return { status: 'success' };
  const res = await fetch(`${PAYSTACK}/transfer/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${config.paystackKey}` } });
  const body = await res.json();
  if (!res.ok || !body.status) throw providerError(res, body, 'Could not check the transfer.');
  return { status: body.data.status, reason: body.data.reason || '' };
}

// Paystack signs the raw request body with HMAC-SHA512 using your secret key.
function validWebhookSignature(rawBody, signature) {
  if (!live || !signature) return false;
  const expected = crypto.createHmac('sha512', config.paystackKey).update(rawBody).digest('hex');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = { live, initializePayment, verifyPayment, refund, listBanks, resolveAccount, createRecipient, transfer, verifyTransfer, validWebhookSignature };
