// Payouts run in practice mode (no Paystack key), and the transfer call is replaced where a test needs it to fail.
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');
const payouts = require('../src/payouts');
const payments = require('../src/payments');

let t, org, other, org3;
test.before(async () => { t = await boot(); org = await t.register('org@pay.test'); other = await t.register('other@pay.test'); org3 = await t.register('org3@pay.test'); });
test.after(() => t.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overview = async (token = org) => (await t.api('/api/organizer/payouts', null, token)).body;
const saveAccount = (token = org, bankCode = '058', accountNumber = '0123456789') => t.api('/api/organizer/payout-account', { bankCode, accountNumber }, token, 'PUT');
async function until(cond, ms = 3000) { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) { if (await cond()) return true; } return false; }
// Keeps running the job until the condition holds (a run may be skipped while another is already in progress).
const runUntil = (cond) => until(async () => { await payouts.runPayouts(); return cond(); });
const statusOf = async (id) => (await t.db.query('SELECT status FROM payouts WHERE id = $1', [id])).rows[0].status;
const payoutFor = async (eventId) => (await t.db.query('SELECT * FROM payouts WHERE event_id = $1 ORDER BY id DESC', [eventId])).rows[0];
async function finishedEventWithOrder(token, title, n) {            // an event that started 3 days ago, with one paid order worth ₦5,000
  const ev = await t.makeEvent(token, { title, priceNaira: 5000, days: -3 });
  await t.buyAndPay(ev.typeId, n);
  return ev.eventId;
}

test('earnings are paid out automatically after the event, once there is a bank account, and only for orders that really are paid', async () => {
  const past = await t.makeEvent(org, { title: 'Finished Show', priceNaira: 5000, capacity: 20, days: -3 });
  const future = await t.makeEvent(org, { title: 'Next Month', priceNaira: 5000, days: 5 });
  await t.buyAndPay(past.typeId, 1, 2);                                          // earns ₦10,000
  const refunded = await t.buyAndPay(past.typeId, 2, 1);
  const waiting = await t.buyAndPay(past.typeId, 3, 1);                          // a refund request is still waiting
  await t.buyAndPay(future.typeId, 4, 1);                                        // the event is not over
  await t.api(`/api/organizer/orders/${refunded}/refund`, {}, org);
  await t.db.query("INSERT INTO refund_requests (order_id, reason) SELECT id, 'x' FROM orders WHERE reference = $1", [waiting]);

  assert.deepStrictEqual((await payouts.runPayouts()).created, 0);                // no bank account yet, so nothing is claimed
  let o = await overview();
  assert.strictEqual(o.account, null);
  assert.strictEqual(o.practiceMode, true);
  assert.deepStrictEqual(o.upcoming.map((u) => [u.title, u.amount_kobo, u.held_orders]), [['Finished Show', 1000000, 1], ['Next Month', 500000, 0]]);

  assert.ok((await t.api('/api/organizer/payout-banks', null, org)).body.some((b) => b.code === '058' && b.name === 'Guaranty Trust Bank'));
  assert.strictEqual((await t.api('/api/organizer/payout-account/resolve', { bankCode: '058', accountNumber: '0123456789' }, org)).body.accountName, 'PRACTICE ACCOUNT 6789');
  const saved = await saveAccount();
  assert.deepStrictEqual(saved.body, { bank_name: 'Guaranty Trust Bank', account_name: 'PRACTICE ACCOUNT 6789', account_last4: '6789' });   // only the last 4 digits are kept
  assert.ok(await until(async () => (await overview()).payouts.length === 1));   // saving the account releases the waiting earnings

  o = await overview();
  assert.deepStrictEqual(o.payouts.map((p) => [p.title, p.amount_kobo, p.order_count, p.status, p.account_label]), [['Finished Show', 1000000, 1, 'success', 'Guaranty Trust Bank ••••6789']]);
  assert.strictEqual((await payouts.runPayouts()).created, 0);                    // running again pays nothing twice
  assert.deepStrictEqual(o.upcoming.map((u) => [u.title, u.amount_kobo, u.held_orders]).slice(0, 2), [['Finished Show', 0, 1], ['Next Month', 500000, 0]]);

  const paidOut = (await t.db.query('SELECT o.reference FROM orders o WHERE o.payout_id IS NOT NULL')).rows[0].reference;
  const blocked = await t.api(`/api/organizer/orders/${paidOut}/refund`, {}, org);
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.body.error, /already sent to the organizer/);              // money that left cannot be refunded from here

  await t.db.query("UPDATE refund_requests SET status = 'declined' WHERE status = 'pending'");
  assert.ok(await runUntil(async () => (await overview()).payouts.length === 2));  // the held order goes out once the request is decided
  assert.deepStrictEqual((await overview()).payouts.map((p) => p.amount_kobo), [500000, 1000000]);
  assert.deepStrictEqual((await overview()).upcoming.map((u) => u.title), ['Next Month']);
});

test('payout setup is checked, private to each organizer, and safe against bad input', async () => {
  assert.strictEqual((await t.api('/api/organizer/payout-account/resolve', { bankCode: '058', accountNumber: '123' }, other)).status, 400);
  assert.strictEqual((await t.api('/api/organizer/payout-account/resolve', { bankCode: '000', accountNumber: '0123456789' }, other)).status, 400);
  assert.strictEqual((await saveAccount(other, '000')).status, 400);
  assert.strictEqual((await saveAccount(other, '058', 'abcdefghij')).status, 400);
  const o = await overview(other);
  assert.deepStrictEqual([o.account, o.payouts, o.upcoming], [null, [], []]);                                    // nothing of org's shows here
  assert.strictEqual((await t.api('/api/organizer/payouts')).status, 401);
  assert.strictEqual((await t.api('/api/organizer/payouts/1/retry', {}, other)).status, 409);                    // not theirs, and not failed
});

test('transfer problems: unclear failures retry with the same reference, clear failures need an explicit retry', async () => {
  const original = payments.transfer, originalVerify = payments.verifyTransfer, refs = [];
  try {
    // 1. The network drops: nothing is known, so it stays pending and the retry reuses the reference (Paystack never pays one reference twice).
    payments.transfer = async ({ reference }) => { refs.push(reference); throw Object.assign(new Error('network down'), { retryable: true }); };
    const a = await finishedEventWithOrder(org3, 'Flaky Network', 40);
    await saveAccount(org3);
    assert.ok(await until(async () => (await payoutFor(a)) && refs.length >= 1));
    const pa = await payoutFor(a);
    assert.strictEqual(pa.status, 'pending');
    payments.transfer = async ({ reference }) => { refs.push(reference); return { status: 'success', transferCode: 'TRF_ok' }; };
    assert.ok(await runUntil(async () => (await statusOf(pa.id)) === 'success'));
    assert.deepStrictEqual([...new Set(refs)], [`gatepass-payout-${pa.id}-1`]);

    // 2. The bank rejects it: marked failed with the reason, and the organizer retries once the cause is fixed (a new reference).
    payments.transfer = async () => { throw new Error('Recipient account is invalid'); };
    const b = await finishedEventWithOrder(org3, 'Bad Account', 41);
    assert.ok(await runUntil(async () => (await payoutFor(b))?.status === 'failed'));
    const pb = await payoutFor(b);
    assert.strictEqual(pb.failure_reason, 'Recipient account is invalid');
    assert.strictEqual((await overview(org3)).payouts.find((p) => p.id === pb.id).status, 'failed');
    refs.length = 0;
    payments.transfer = async ({ reference }) => { refs.push(reference); return { status: 'success', transferCode: 'TRF_ok2' }; };
    const retried = await t.api(`/api/organizer/payouts/${pb.id}/retry`, {}, org3);
    assert.deepStrictEqual([retried.status, retried.body.status, retried.body.attempt], [200, 'success', 2]);
    assert.deepStrictEqual(refs, [`gatepass-payout-${pb.id}-2`]);
    assert.strictEqual((await t.api(`/api/organizer/payouts/${pb.id}/retry`, {}, org3)).status, 409);             // it is done, nothing to retry

    // 3. Paystack asks for an OTP: reported clearly instead of leaving money in limbo.
    payments.transfer = async () => ({ status: 'otp', transferCode: 'TRF_otp' });
    const c = await finishedEventWithOrder(org3, 'Needs Otp', 42);
    assert.ok(await runUntil(async () => (await payoutFor(c))?.status === 'failed'));
    assert.match((await payoutFor(c)).failure_reason, /OTP/);

    // 4. Paystack accepts it and reports later by webhook: success is final, a late "failed" cannot undo it, a reversal can.
    payments.transfer = async () => ({ status: 'pending', transferCode: 'TRF_slow' });
    const d = await finishedEventWithOrder(org3, 'Slow Bank', 43);
    assert.ok(await runUntil(async () => (await payoutFor(d))?.status === 'processing'));
    const pd = await payoutFor(d), ref = `gatepass-payout-${pd.id}-1`;
    assert.strictEqual(await payouts.applyTransferEvent(ref, 'transfer.success'), true);
    assert.strictEqual(await payouts.applyTransferEvent(ref, 'transfer.success'), false);                         // repeated webhooks change nothing
    assert.strictEqual(await payouts.applyTransferEvent(ref, 'transfer.failed', 'late'), false);
    assert.strictEqual(await statusOf(pd.id), 'success');
    assert.strictEqual(await payouts.applyTransferEvent(ref, 'transfer.reversed'), true);
    assert.strictEqual(await payouts.applyTransferEvent(ref, 'transfer.success'), false);
    assert.strictEqual(await statusOf(pd.id), 'reversed');
    assert.strictEqual(await payouts.applyTransferEvent('not-ours', 'transfer.success'), false);

    // 5. A webhook never arrives: after 10 minutes the job asks Paystack itself.
    payments.transfer = async () => ({ status: 'pending', transferCode: 'TRF_quiet' });
    const e = await finishedEventWithOrder(org3, 'Quiet Webhook', 44);
    assert.ok(await runUntil(async () => (await payoutFor(e))?.status === 'processing'));
    const pe = await payoutFor(e);
    payments.verifyTransfer = async () => ({ status: 'success' });
    await t.db.query("UPDATE payouts SET updated_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [pe.id]);
    assert.ok(await runUntil(async () => (await statusOf(pe.id)) === 'success'));
  } finally { payments.transfer = original; payments.verifyTransfer = originalVerify; }
});
