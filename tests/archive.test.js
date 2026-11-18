const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');
const payments = require('../src/payments');

let t, org, other;
test.before(async () => { t = await boot(); org = await t.register('org@arch.test'); other = await t.register('other@arch.test'); });
test.after(() => t.close());

const archive = (id, auth = org) => t.api(`/api/organizer/events/${id}/archive`, {}, auth);
const unarchive = (id, auth = org) => t.api(`/api/organizer/events/${id}/unarchive`, {}, auth);
const row = async (id) => (await t.api('/api/organizer/events', null, org)).body.find((e) => e.id === id);

test('only events that have started can be archived, and archiving can be undone', async () => {
  const upcoming = await t.makeEvent(org, { days: 5 });
  const past = await t.makeEvent(org, { days: -2 });
  const refused = await archive(upcoming.eventId);
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /already started/);
  assert.strictEqual((await archive(past.eventId, other)).status, 404);
  assert.strictEqual((await t.api(`/api/organizer/events/${past.eventId}/archive`, {})).status, 401);
  assert.strictEqual((await archive(past.eventId)).status, 200);
  assert.strictEqual((await archive(past.eventId)).status, 200);                                  // archiving twice is harmless
  assert.ok((await row(past.eventId)).archived_at);
  assert.strictEqual((await row(upcoming.eventId)).archived_at, null);
  assert.strictEqual((await unarchive(past.eventId)).status, 200);
  assert.strictEqual((await row(past.eventId)).archived_at, null);
  assert.strictEqual((await unarchive(past.eventId, other)).status, 404);
});

test('an archived event still counts in totals and charts, and its guest list, orders and public page keep working', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { days: -2, priceNaira: 5000, title: 'Archived Concert' });
  const ref = await t.buyAndPay(typeId, 1, 2);
  const before = (await t.api('/api/organizer/sales?days=30', null, org)).body.perDay.reduce((n, d) => n + Number(d.tickets), 0);
  assert.strictEqual((await archive(eventId)).status, 200);
  const e = await row(eventId);
  assert.ok(e.archived_at);
  assert.strictEqual(e.totals.net, 1000000);                                                       // earnings are still there
  assert.strictEqual((await t.api('/api/organizer/sales?days=30', null, org)).body.perDay.reduce((n, d) => n + Number(d.tickets), 0), before);
  const csv = await t.api(`/api/organizer/events/${eventId}/export.csv`, null, org);
  assert.strictEqual(csv.status, 200);
  assert.ok(csv.body.includes(ref));
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/orders`, null, org)).body.length, 1);
  assert.strictEqual((await t.api(`/api/orders/${ref}`)).body.status, 'paid');                      // the buyer's ticket page still works
  assert.strictEqual((await t.api(`/api/events/${eventId}`)).status, 200);                          // and so does a shared event link
});

test('archived events leave public browsing', async () => {
  const { eventId } = await t.makeEvent(org, { days: -0.5, title: 'Started Earlier Today' });
  assert.ok((await t.api('/api/events?q=Earlier Today')).body.some((e) => e.id === eventId));      // started 12 hours ago, still listed
  await archive(eventId);
  assert.deepStrictEqual((await t.api('/api/events?q=Earlier Today')).body, []);
});

test('nothing that needs a refund decision can be hidden by archiving', async () => {
  const a = await t.makeEvent(org, { days: -2 });
  const r1 = await t.buyAndPay(a.typeId, 10);
  await t.db.query("UPDATE orders SET status = 'refund_due' WHERE reference = $1", [r1]);
  assert.match((await archive(a.eventId)).body.error, /Settle the refunds first: 1 order needs/);
  await t.api(`/api/organizer/orders/${r1}/refund`, {}, org);
  assert.strictEqual((await archive(a.eventId)).status, 200);

  const b = await t.makeEvent(org, { days: -2 });
  const r2 = await t.buyAndPay(b.typeId, 11);
  await t.db.query("INSERT INTO refund_requests (order_id, reason) SELECT id, 'x' FROM orders WHERE reference = $1", [r2]);
  assert.strictEqual((await archive(b.eventId)).status, 409);                                       // a refund request is waiting
  await t.api(`/api/organizer/orders/${r2}/refund-request/decide`, { action: 'decline' }, org);
  assert.strictEqual((await archive(b.eventId)).status, 200);

  const c = await t.makeEvent(org, { days: 5 });                                                    // cancelled, but the refund fails
  await t.buyAndPay(c.typeId, 12);
  const original = payments.refund;
  payments.refund = async () => { throw new Error('provider down'); };
  try { await t.api(`/api/organizer/events/${c.eventId}/cancel`, {}, org); } finally { payments.refund = original; }
  assert.match((await archive(c.eventId)).body.error, /Continue refunds/);
  await t.api(`/api/organizer/events/${c.eventId}/cancel`, {}, org);                                // finish the refunds
  assert.strictEqual((await archive(c.eventId)).status, 200);                                       // a settled cancelled event can be archived
});

test('a started event can no longer be edited or given new discount codes, but existing codes can be switched off', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { days: 5 });
  await t.api(`/api/organizer/events/${eventId}/discounts`, { code: 'EARLY10', kind: 'percent', value: 10 }, org);
  const codeId = (await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body[0].id;
  await t.db.query("UPDATE events SET starts_at = NOW() - INTERVAL '2 days' WHERE id = $1", [eventId]);        // the event has now started
  const edit = await t.api(`/api/organizer/events/${eventId}`, { title: 'x', venue: 'v', startsAt: t.inDays(3), ticketTypes: [{ id: typeId, name: 'R', priceNaira: 1, capacity: 5 }] }, org, 'PUT');
  assert.strictEqual(edit.status, 409);
  assert.match(edit.body.error, /already started/);
  const code = await t.api(`/api/organizer/events/${eventId}/discounts`, { code: 'LATE10', kind: 'percent', value: 10 }, org);
  assert.strictEqual(code.status, 409);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts/${codeId}/toggle`, { active: false }, org)).status, 200);
});

test('an archived event can still be deleted', async () => {
  const { eventId } = await t.makeEvent(org, { days: -2 });
  await archive(eventId);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}`, null, org, 'DELETE')).status, 200);
  assert.ok(!(await row(eventId)));
});
