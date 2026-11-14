// Run with: npm test
// Uses a throwaway database and the built-in mock payment flow.
process.env.DB_FILE = ':memory:';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.APP_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

let server, base, token;
const api = async (path, body, auth) => {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  token = (await api('/api/auth/register', { name: 'Org', email: 'org@test.dev', password: 'password123' })).body.token;
});
test.after(() => server.close());

async function makeEvent(capacity, priceNaira = 1000) {
  const res = await api('/api/organizer/events', {
    title: 'Test event', venue: 'Hall', startsAt: new Date(Date.now() + 864e5).toISOString(),
    ticketTypes: [{ name: 'Regular', priceNaira, capacity }],
  }, token);
  assert.strictEqual(res.status, 201);
  const event = (await api(`/api/events/${res.body.id}`)).body;
  return event.ticketTypes[0].id;
}
const buy = (ticketTypeId, quantity = 1, i = 0) =>
  api('/api/checkout', { ticketTypeId, quantity, name: 'Buyer ' + i, email: `buyer${i}@test.dev` });

test('never oversells: 40 simultaneous buyers, 10 tickets', async () => {
  const typeId = await makeEvent(10);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => buy(typeId, 1, i)));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 10);
  assert.strictEqual(results.filter((r) => r.status === 409).length, 30);
});

test('paid order issues tickets once, even if payment is confirmed twice', async () => {
  const typeId = await makeEvent(5);
  const { body } = await buy(typeId, 2);
  await api('/api/mock/pay', { reference: body.reference });
  await api('/api/mock/pay', { reference: body.reference });
  const order = (await api(`/api/orders/${body.reference}`)).body;
  assert.strictEqual(order.status, 'paid');
  assert.strictEqual(order.tickets.length, 2);
});

test('a ticket can be scanned in once, and forged codes are rejected', async () => {
  const typeId = await makeEvent(5);
  const { body } = await buy(typeId, 1);
  await api('/api/mock/pay', { reference: body.reference });
  const { code } = (await api(`/api/orders/${body.reference}`)).body.tickets[0];
  assert.strictEqual((await api('/api/checkin', { code }, token)).body.result, 'valid');
  assert.strictEqual((await api('/api/checkin', { code }, token)).body.result, 'already_used');
  const forged = code.split('.')[0] + '.0000000000000000';
  assert.strictEqual((await api('/api/checkin', { code: forged }, token)).body.result, 'invalid');
});

test('unpaid reservations expire and return stock', async () => {
  const typeId = await makeEvent(3);
  const first = await buy(typeId, 3);
  assert.strictEqual((await buy(typeId, 1)).status, 409);
  // Simulate the 15-minute hold running out.
  require('../src/db').prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE reference = ?").run(first.body.reference);
  assert.strictEqual((await buy(typeId, 1)).status, 201);
});

test('scanner needs a login', async () => {
  assert.strictEqual((await api('/api/checkin', { code: 'x.y' })).status, 401);
});
