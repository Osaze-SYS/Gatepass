const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');

let t, org, other;
test.before(async () => { t = await boot(); org = await t.register('org@disc.test'); other = await t.register('other@disc.test'); });
test.after(() => t.close());

const addCode = (eventId, body, auth = org) => t.api(`/api/organizer/events/${eventId}/discounts`, body, auth);
const pct = (code, value = 20, extra = {}) => ({ code, kind: 'percent', value, ...extra });

test('percent and fixed codes lower the price, and the platform fee follows the discounted price', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { priceNaira: 10000, capacity: 20 });         // ₦10,000 = 1,000,000 kobo
  assert.strictEqual((await addCode(eventId, pct('SAVE20'))).status, 201);
  assert.strictEqual((await addCode(eventId, { code: 'TAKE1000', kind: 'fixed', value: 1000 })).status, 201);

  const q = await t.api('/api/quote', { ticketTypeId: typeId, quantity: 2, code: ' save20 ' });      // case and spaces do not matter
  assert.deepStrictEqual([q.body.unit_kobo, q.body.discount_kobo, q.body.subtotal_kobo, q.body.fee_kobo, q.body.amount_kobo], [800000, 400000, 1600000, 80000, 1680000]);
  assert.strictEqual(q.body.code.code, 'SAVE20');
  const fixed = await t.api('/api/quote', { ticketTypeId: typeId, quantity: 3, code: 'TAKE1000' });
  assert.deepStrictEqual([fixed.body.unit_kobo, fixed.body.discount_kobo], [900000, 300000]);
  const plain = await t.api('/api/quote', { ticketTypeId: typeId, quantity: 2 });
  assert.deepStrictEqual([plain.body.discount_kobo, plain.body.amount_kobo, plain.body.code], [0, 2100000, null]);

  const co = await t.buy(typeId, 1, 2, { code: 'save20' });                                           // checkout agrees with the quote
  assert.strictEqual(co.status, 201);
  assert.strictEqual(co.body.amount_kobo, 1680000);
  await t.api('/api/mock/pay', { reference: co.body.reference });
  const order = (await t.api(`/api/orders/${co.body.reference}`)).body;
  assert.deepStrictEqual([order.discount_code, order.discount_kobo, order.subtotal_kobo, order.fee_kobo, order.amount_kobo], ['SAVE20', 400000, 1600000, 80000, 1680000]);
  const totals = (await t.api('/api/organizer/events', null, org)).body.find((e) => e.id === eventId).totals;
  assert.deepStrictEqual([totals.gross, totals.fees, totals.net], [1680000, 80000, 1600000]);     // the organizer carries the discount
});

test('a 100% code makes the order free: no payment, no fee', async () => {
  const { typeId } = await t.makeEvent(org, { priceNaira: 5000 });
  await addCode((await t.api('/api/organizer/events', null, org)).body.find((e) => e.ticketTypes.some((x) => x.id === typeId)).id, pct('FREE100', 100));
  const co = await t.buy(typeId, 2, 2, { code: 'FREE100' });
  assert.strictEqual(co.status, 201);
  assert.deepStrictEqual([co.body.amount_kobo, co.body.fee_kobo], [0, 0]);
  const order = (await t.api(`/api/orders/${co.body.reference}`)).body;
  assert.deepStrictEqual([order.status, order.tickets.length], ['paid', 2]);                       // tickets issued straight away
});

test('codes can be used up, expire, be switched off, and only work for their own event', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { priceNaira: 2000, capacity: 20 });
  const other1 = await t.makeEvent(org, { priceNaira: 2000, capacity: 20 });
  const free = await t.makeEvent(org, { priceNaira: 0, capacity: 20 });
  await addCode(eventId, pct('ONCE', 10, { maxUses: 1 }));
  await addCode(eventId, pct('SOON', 10, { expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  await addCode(free.eventId, pct('NOPE', 10));

  assert.strictEqual((await t.buy(typeId, 10, 1, { code: 'ONCE' })).status, 201);
  const used = await t.buy(typeId, 11, 1, { code: 'ONCE' });
  assert.strictEqual(used.status, 400);
  assert.match(used.body.error, /fully used/);
  await t.db.query("UPDATE orders SET expires_at = NOW() - INTERVAL '1 hour' WHERE buyer_email = 'buyer10@test.dev'");
  assert.strictEqual((await t.buy(typeId, 12, 1, { code: 'ONCE' })).status, 201);                  // the unpaid order expired, so its use came back
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body.find((c) => c.code === 'ONCE').used_count, 1);

  await t.db.query("UPDATE discount_codes SET expires_at = NOW() - INTERVAL '1 hour' WHERE code = 'SOON'");
  assert.match((await t.buy(typeId, 13, 1, { code: 'SOON' })).body.error, /expired/);

  await addCode(eventId, pct('TOGGLE'));
  const id = (await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body.find((c) => c.code === 'TOGGLE').id;
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts/${id}/toggle`, { active: false }, org)).status, 200);
  assert.strictEqual((await t.buy(typeId, 14, 1, { code: 'TOGGLE' })).status, 400);                // switched off
  await t.api(`/api/organizer/events/${eventId}/discounts/${id}/toggle`, { active: true }, org);
  assert.strictEqual((await t.buy(typeId, 15, 1, { code: 'TOGGLE' })).status, 201);                // and back on

  assert.strictEqual((await t.buy(other1.typeId, 16, 1, { code: 'TOGGLE' })).status, 400);         // belongs to a different event
  assert.strictEqual((await t.buy(typeId, 17, 1, { code: 'NOSUCHCODE' })).status, 400);
  assert.match((await t.buy(free.typeId, 18, 1, { code: 'NOPE' })).body.error, /already free/);
});

test('only the last use of a code goes through when buyers race for it', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { priceNaira: 3000, capacity: 50 });
  await addCode(eventId, pct('RACE', 10, { maxUses: 3 }));
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => t.buy(typeId, 100 + i, 1, { code: 'RACE' })));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 3);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body[0].used_count, 3);
});

test('organizers get clear errors, and cannot touch each other\'s codes', async () => {
  const { eventId } = await t.makeEvent(org);
  assert.strictEqual((await addCode(eventId, pct('ab'))).status, 400);                              // too short
  assert.strictEqual((await addCode(eventId, pct('bad code!'))).status, 400);
  assert.strictEqual((await addCode(eventId, pct('GOOD1'))).status, 201);
  assert.strictEqual((await addCode(eventId, pct('good1'))).status, 409);                           // same code again
  assert.strictEqual((await addCode(eventId, pct('P150', 150))).status, 400);
  assert.strictEqual((await addCode(eventId, pct('P0', 0))).status, 400);
  assert.strictEqual((await addCode(eventId, { code: 'FIX0', kind: 'fixed', value: 0 })).status, 400);
  assert.strictEqual((await addCode(eventId, { code: 'NOKIND', value: 5 })).status, 400);
  assert.strictEqual((await addCode(eventId, pct('MAX0', 10, { maxUses: 0 }))).status, 400);
  assert.strictEqual((await addCode(eventId, pct('OLD', 10, { expiresAt: '2020-01-01T00:00:00Z' }))).status, 400);
  assert.strictEqual((await addCode(eventId, pct('THEIRS'), other)).status, 404);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts`, null, other)).status, 404);
  const id = (await t.api(`/api/organizer/events/${eventId}/discounts`, null, org)).body[0].id;
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/discounts/${id}/toggle`, { active: false }, other)).status, 404);
});

test('refunding a discounted order returns exactly what was paid', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { priceNaira: 4000 });
  await addCode(eventId, pct('HALF', 50));
  const co = await t.buy(typeId, 30, 1, { code: 'HALF' });                                          // ₦2,000 + ₦100 fee
  assert.strictEqual(co.body.amount_kobo, 210000);
  await t.api('/api/mock/pay', { reference: co.body.reference });
  assert.strictEqual((await t.api(`/api/orders/${co.body.reference}/refund`, { email: 'buyer30@test.dev' })).status, 200);
  const totals = (await t.api('/api/organizer/events', null, org)).body.find((e) => e.id === eventId).totals;
  assert.deepStrictEqual([totals.refunded, totals.gross], [210000, 0]);
});
