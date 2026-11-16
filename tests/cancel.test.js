const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');
const orders = require('../src/orders');
const payments = require('../src/payments');

let t, org, other;
test.before(async () => { t = await boot(); org = await t.register('org@cancel.test'); other = await t.register('other@cancel.test'); });
test.after(() => t.close());

const cancel = (id, body = {}, auth = org) => t.api(`/api/organizer/events/${id}/cancel`, body, auth);
const statusOf = async (ref) => (await t.api(`/api/orders/${ref}`)).body.status;
const dashboardRow = async (id) => (await t.api('/api/organizer/events', null, org)).body.find((e) => e.id === id);

test('cancelling stops sales, releases holds, refunds every order and settles waiting requests', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { capacity: 10, priceNaira: 4000, days: 1, title: 'Doomed Concert' });   // starts tomorrow, so past the 48 hour cutoff
  await t.api(`/api/organizer/events/${eventId}/discounts`, { code: 'CODE10', kind: 'percent', value: 10 }, org);
  const r1 = await t.buyAndPay(typeId, 1, 2);
  const r2 = await t.buyAndPay(typeId, 2, 1);
  const r3 = await t.buyAndPay(typeId, 4, 1, { code: 'CODE10' });
  await t.api(`/api/orders/${r2}/refund-request`, { email: 'buyer2@test.dev', reason: 'Cannot come' });           // a request is waiting
  const unpaid = (await t.buy(typeId, 3, 1)).body.reference;                                                       // and an unpaid hold

  assert.strictEqual((await cancel(eventId, {}, other)).status, 404);
  const done = await cancel(eventId, { reason: 'Artist fell ill' });
  assert.strictEqual(done.status, 200);
  assert.deepStrictEqual([done.body.refunded, done.body.failed.length, done.body.skipped, done.body.remaining, done.body.alreadyCancelled], [3, 0, 0, 0, false]);
  for (const ref of [r1, r2, r3]) assert.strictEqual(await statusOf(ref), 'refunded');
  assert.strictEqual(await statusOf(unpaid), 'expired');

  const ev = (await t.api(`/api/events/${eventId}`)).body;
  assert.deepStrictEqual([ev.cancelled, ev.cancel_reason, ev.ticketTypes[0].remaining], [true, 'Artist fell ill', 10]);   // every ticket is back
  assert.deepStrictEqual((await t.api('/api/events?q=Doomed')).body, []);                                           // gone from browsing
  assert.strictEqual((await t.buy(typeId, 5)).status, 409);                                                         // nothing more can be bought
  const rows = (await t.api(`/api/organizer/events/${eventId}/orders`, null, org)).body;
  assert.strictEqual(rows.find((o) => o.reference === r2).request_status, 'approved');
  const used = (await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body[0].used_count;
  assert.strictEqual(used, 1);                                                                                      // the unpaid hold gave its code use back, the paid one keeps it

  // A payment that arrives after the cancellation never becomes a ticket, and is flagged for refund.
  await t.api('/api/mock/pay', { reference: unpaid });
  const late = (await t.api(`/api/orders/${unpaid}`)).body;
  assert.deepStrictEqual([late.status, late.tickets.length], ['refund_due', 0]);
  const row = await dashboardRow(eventId);
  assert.deepStrictEqual([Boolean(row.cancelled_at), row.totals.open_orders], [true, 1]);
  const again = await cancel(eventId);                                                                              // running it again finishes what is left
  assert.deepStrictEqual([again.body.refunded, again.body.alreadyCancelled], [1, true]);
  assert.strictEqual(await statusOf(unpaid), 'refunded');
  assert.strictEqual((await cancel(eventId)).body.refunded, 0);

  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}`, { title: 'x', venue: 'v', startsAt: t.inDays(3), ticketTypes: [{ id: typeId, name: 'R', priceNaira: 1, capacity: 5 }] }, org, 'PUT')).status, 409);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}`, null, org, 'DELETE')).status, 200);          // everything is settled, so it can be deleted
});

test('an event that has already started cannot be cancelled', async () => {
  const { eventId } = await t.makeEvent(org, { days: -1 });
  assert.strictEqual((await cancel(eventId)).status, 409);
});

test('orders that were already scanned are skipped and everything else is refunded', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { capacity: 10, priceNaira: 2000, days: 5 });
  const r1 = await t.buyAndPay(typeId, 10, 2);
  const r2 = await t.buyAndPay(typeId, 11, 1);
  const tickets = (await t.api(`/api/orders/${r1}`)).body.tickets;
  assert.strictEqual((await t.api('/api/checkin', { code: tickets[0].code }, org)).body.result, 'valid');       // doors opened early for this guest
  const done = await cancel(eventId);
  assert.deepStrictEqual([done.body.refunded, done.body.skipped], [1, 1]);
  assert.deepStrictEqual([await statusOf(r1), await statusOf(r2)], ['paid', 'refunded']);
  assert.strictEqual((await t.api('/api/checkin', { code: tickets[1].code }, org)).body.result, 'cancelled');      // the gate says why
});

test('refunds that fail are reported, leave the order intact, and succeed when run again', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { capacity: 10, priceNaira: 2000, days: 5 });
  const refs = [await t.buyAndPay(typeId, 20), await t.buyAndPay(typeId, 21)];
  const original = payments.refund;
  payments.refund = async () => { throw new Error('provider down'); };
  try {
    const first = await cancel(eventId);
    assert.deepStrictEqual([first.body.refunded, first.body.failed.length], [0, 2]);
    assert.deepStrictEqual([await statusOf(refs[0]), await statusOf(refs[1])], ['paid', 'paid']);               // nothing was lost
    assert.strictEqual((await t.api(`/api/orders/${refs[0]}`)).body.tickets.length, 1);
  } finally { payments.refund = original; }
  const second = await cancel(eventId);
  assert.deepStrictEqual([second.body.refunded, second.body.failed.length], [2, 0]);
});

test('a long cancellation stops at its time budget and can be continued', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { capacity: 10, priceNaira: 2000, days: 5 });
  await t.buyAndPay(typeId, 30); await t.buyAndPay(typeId, 31); await t.buyAndPay(typeId, 32);
  const organizerId = (await t.db.query('SELECT organizer_id FROM events WHERE id = $1', [eventId])).rows[0].organizer_id;
  const partial = await orders.cancelEvent({ eventId, organizerId, reason: 'Venue closed', budgetMs: -1 });         // no time left: nothing refunded yet
  assert.deepStrictEqual([partial.refunded, partial.remaining], [0, 3]);
  assert.strictEqual((await dashboardRow(eventId)).totals.open_orders, 3);
  const rest = await cancel(eventId);
  assert.deepStrictEqual([rest.body.refunded, rest.body.remaining], [3, 0]);
});
