// Automatic organizer payouts.
//   - Buyers pay Gatepass. The platform fee stays; the rest is the organizer's earnings (orders.payout_kobo).
//   - PAYOUT_DELAY_HOURS after an event starts, the earnings of every paid, un-refunded order are sent to the organizer's bank account.
//   - Orders with a refund request still waiting are held back until the organizer decides.
//   - Each order is put in at most one payout, so nothing is ever paid twice, even with two servers running.
const db = require('./db');
const config = require('./config');
const payments = require('./payments');
const { sendPayoutEmail } = require('./mailer');
const { httpError } = require('./orders');

const log = (err) => console.error('[payout]', err.message);

// ---------------- the organizer's bank account ----------------
async function resolveAccount({ bankCode, accountNumber }) {
  if (!/^\d{10}$/.test(String(accountNumber))) throw httpError(400, 'Enter the 10-digit account number.');
  if (!(await payments.listBanks()).some((b) => b.code === bankCode)) throw httpError(400, 'Choose your bank from the list.');
  try { return await payments.resolveAccount({ bankCode, accountNumber: String(accountNumber) }); }
  catch (err) { throw httpError(400, err.message || 'We could not verify that account.'); }
}

async function savePayoutAccount({ userId, bankCode, accountNumber }) {
  const resolved = await resolveAccount({ bankCode, accountNumber });                       // always re-checked here, never trusted from the browser
  const bank = (await payments.listBanks()).find((b) => b.code === bankCode);
  let recipient;
  try { recipient = await payments.createRecipient({ name: resolved.accountName, accountNumber: String(accountNumber), bankCode }); }
  catch (err) { log(err); throw httpError(502, 'We could not save that account with the payment provider. Please check the details and try again.'); }
  await db.query(
    `INSERT INTO payout_accounts (user_id, bank_code, bank_name, account_name, account_last4, recipient_code) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET bank_code = $2, bank_name = $3, account_name = $4, account_last4 = $5, recipient_code = $6, updated_at = NOW()`,
    [userId, bankCode, bank.name, resolved.accountName, String(accountNumber).slice(-4), recipient.recipientCode]);
  return { bank_name: bank.name, account_name: resolved.accountName, account_last4: String(accountNumber).slice(-4) };
}

// ---------------- creating payouts ----------------
// Puts every eligible order of one event into a new payout, atomically. Returns the payout id, or null if there is nothing to pay.
async function claimPayout(eventId, userId) {
  return db.tx(async (q) => {
    const acct = (await q('SELECT bank_name, account_last4 FROM payout_accounts WHERE user_id = $1', [userId])).rows[0];
    if (!acct) return null;
    const rows = (await q(
      `SELECT o.id, o.payout_kobo FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id
       WHERE t.event_id = $1 AND o.status = 'paid' AND o.payout_id IS NULL AND o.payout_kobo > 0
         AND NOT EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status = 'pending')
       FOR UPDATE OF o`, [eventId])).rows;
    if (!rows.length) return null;
    const total = rows.reduce((sum, r) => sum + r.payout_kobo, 0);
    const made = await q(
      `INSERT INTO payouts (event_id, user_id, amount_kobo, order_count, status, account_label) VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
      [eventId, userId, total, rows.length, `${acct.bank_name} ••••${acct.account_last4}`]);
    await q('UPDATE orders SET payout_id = $1 WHERE id = ANY($2::int[])', [made.rows[0].id, rows.map((r) => r.id)]);
    return made.rows[0].id;
  });
}

// ---------------- sending and tracking ----------------
// Moves a payout to its final state (once) and tells the organizer.
async function settle(id, status, { transferCode, reason = '' } = {}) {
  const done = await db.query(
    `UPDATE payouts SET status = $2::text, transfer_code = COALESCE($3, transfer_code), failure_reason = $4, updated_at = NOW()
     WHERE id = $1 AND status <> $2::text AND status <> 'reversed' AND NOT (status = 'success' AND $2::text = 'failed')
     RETURNING user_id, event_id, amount_kobo, account_label`, [id, status, transferCode || null, reason]);
  if (!done.rows.length) return false;
  const p = done.rows[0];
  const who = (await db.query('SELECT u.name, u.email, e.title FROM users u, events e WHERE u.id = $1 AND e.id = $2', [p.user_id, p.event_id])).rows[0];
  sendPayoutEmail({ to: who.email, name: who.name, eventTitle: who.title, amountKobo: p.amount_kobo, accountLabel: p.account_label, ok: status === 'success',
    reason, dashboardUrl: `${config.baseUrl}/organizer.html` }).catch(log);
  return true;
}

async function submitPayout(id) {
  const p = (await db.query(
    `SELECT p.id, p.attempt, p.amount_kobo, e.title, a.recipient_code
     FROM payouts p JOIN events e ON e.id = p.event_id LEFT JOIN payout_accounts a ON a.user_id = p.user_id
     WHERE p.id = $1 AND p.status = 'pending'`, [id])).rows[0];
  if (!p || !p.recipient_code) return false;
  const reference = `gatepass-payout-${p.id}-${p.attempt}`;       // lowercase, 16 to 50 characters, as Paystack requires; the same reference is reused when the answer was unclear
  try {
    const out = await payments.transfer({ reference, amountKobo: p.amount_kobo, recipientCode: p.recipient_code, reason: `Earnings from ${p.title}`.slice(0, 100) });
    if (out.status === 'success') await settle(p.id, 'success', { transferCode: out.transferCode });
    else if (out.status === 'otp') await settle(p.id, 'failed', { transferCode: out.transferCode, reason: 'Paystack is asking for an OTP to approve transfers. Turn off the OTP requirement for transfers in your Paystack settings, then retry' });
    else await db.query("UPDATE payouts SET status = 'processing', transfer_code = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'", [p.id, out.transferCode || null]);
    return true;
  } catch (err) {
    if (err.retryable) { log(err); return false; }                 // stays pending; the next run tries again with the same reference
    await settle(p.id, 'failed', { reason: err.message || 'The transfer was rejected' });
    return false;
  }
}

// Paystack reports the outcome of a transfer by webhook; this applies it.
async function applyTransferEvent(reference, event, reason = '') {
  const m = /^gatepass-payout-(\d+)-\d+$/.exec(String(reference));
  if (!m) return false;
  const status = { 'transfer.success': 'success', 'transfer.failed': 'failed', 'transfer.reversed': 'reversed' }[event];
  return status ? settle(Number(m[1]), status, { reason }) : false;
}

// If a webhook never arrived, ask Paystack directly.
async function checkPayout(id) {
  const p = (await db.query("SELECT id, attempt FROM payouts WHERE id = $1 AND status = 'processing'", [id])).rows[0];
  if (!p) return;
  try {
    const out = await payments.verifyTransfer(`gatepass-payout-${p.id}-${p.attempt}`);
    const status = { success: 'success', failed: 'failed', reversed: 'reversed', rejected: 'failed', blocked: 'failed', abandoned: 'failed' }[out.status];
    if (status) await settle(p.id, status, { reason: out.reason || '' });
  } catch (err) { log(err); }
}

// The scheduled job (runs every minute while the server is awake).
let running = false;
async function runPayouts() {
  if (running) return { skipped: true };
  running = true;
  try {
    const out = { created: 0, submitted: 0, checked: 0 };
    const due = (await db.query(
      `SELECT DISTINCT e.id, e.organizer_id FROM events e JOIN ticket_types t ON t.event_id = e.id JOIN orders o ON o.ticket_type_id = t.id
       WHERE e.starts_at < NOW() - make_interval(hours => $1::int) AND o.status = 'paid' AND o.payout_id IS NULL AND o.payout_kobo > 0`, [config.payoutDelayHours])).rows;
    for (const ev of due) { try { if (await claimPayout(ev.id, ev.organizer_id)) out.created++; } catch (err) { log(err); } }
    for (const p of (await db.query("SELECT id FROM payouts WHERE status = 'pending' ORDER BY id")).rows) { if (await submitPayout(p.id)) out.submitted++; }
    for (const p of (await db.query("SELECT id FROM payouts WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'")).rows) { await checkPayout(p.id); out.checked++; }
    return out;
  } finally { running = false; }
}

// After a rejected transfer the organizer fixes the cause and presses Retry. A fresh attempt number means a fresh reference.
async function retryPayout({ userId, payoutId }) {
  const done = await db.query("UPDATE payouts SET status = 'pending', attempt = attempt + 1, failure_reason = '', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'failed' RETURNING id", [payoutId, userId]);
  if (!done.rows.length) throw httpError(409, 'Only a failed payout can be retried.');
  await submitPayout(payoutId);
  return (await db.query('SELECT id, status, failure_reason, attempt FROM payouts WHERE id = $1', [payoutId])).rows[0];
}

// Everything the Payouts tab shows.
async function payoutOverview(userId) {
  const account = (await db.query('SELECT bank_name, account_name, account_last4 FROM payout_accounts WHERE user_id = $1', [userId])).rows[0] || null;
  const payouts = (await db.query(
    `SELECT p.id, e.title, p.amount_kobo, p.order_count, p.status, p.failure_reason, p.account_label, p.created_at, p.updated_at
     FROM payouts p JOIN events e ON e.id = p.event_id WHERE p.user_id = $1 ORDER BY p.id DESC LIMIT 100`, [userId])).rows;
  const upcoming = (await db.query(
    `SELECT e.id, e.title, e.starts_at, e.starts_at + make_interval(hours => $2::int) AS due_at,
            COALESCE(SUM(o.payout_kobo) FILTER (WHERE NOT EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status = 'pending')), 0) AS amount_kobo,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status = 'pending')) AS held_orders
     FROM events e JOIN ticket_types t ON t.event_id = e.id JOIN orders o ON o.ticket_type_id = t.id
     WHERE e.organizer_id = $1 AND o.status = 'paid' AND o.payout_id IS NULL AND o.payout_kobo > 0
     GROUP BY e.id ORDER BY e.starts_at`, [userId, config.payoutDelayHours])).rows;
  return { account, delayHours: config.payoutDelayHours, practiceMode: !payments.live, payouts, upcoming };
}

module.exports = { resolveAccount, savePayoutAccount, runPayouts, submitPayout, retryPayout, applyTransferEvent, payoutOverview };
