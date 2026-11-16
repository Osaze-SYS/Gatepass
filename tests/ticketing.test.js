// Run with: npm test
// Uses an in-memory PostgreSQL (PGlite) and the built-in mock payment flow.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';   // set TEST_DATABASE_URL to run the same tests on a real PostgreSQL server
process.env.PAYSTACK_SECRET_KEY = '';
process.env.APP_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp } = require('../server');

const HIGH = { auth: { limit: 1000 }, checkout: { limit: 1000 }, refund: { limit: 1000 }, upload: { limit: 1000 }, api: { limit: 100000 } };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, token, token2;
const api = async (path, body, auth, method) => {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : null };
};

test.before(async () => {
  await db.init();
  server = createApp({ limits: HIGH }).listen(0);
  base = `http://localhost:${server.address().port}`;
  token = (await api('/api/auth/register', { name: 'Org', email: 'org@test.dev', password: 'password123' })).body.token;
  token2 = (await api('/api/auth/register', { name: 'Other', email: 'other@test.dev', password: 'password123' })).body.token;
});
test.after(async () => { server.close(); await db.close(); });

const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
async function makeEvent({ capacity = 10, priceNaira = 1000, title = 'Test event', category = 'Tech', days = 10, auth = token } = {}) {
  const res = await api('/api/organizer/events', { title, venue: 'Hall', category, startsAt: inDays(days), ticketTypes: [{ name: 'Regular', priceNaira, capacity }] }, auth);
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const event = (await api(`/api/events/${res.body.id}`)).body;
  return { eventId: res.body.id, typeId: event.ticketTypes[0].id };
}
const buy = (ticketTypeId, quantity = 1, i = 0) => api('/api/checkout', { ticketTypeId, quantity, name: 'Buyer ' + i, email: `buyer${i}@test.dev` });
async function buyAndPay(typeId, quantity = 1, i = 0) {
  const { body } = await buy(typeId, quantity, i);
  await api('/api/mock/pay', { reference: body.reference });
  return body.reference;
}

// ---------- inventory and payment ----------
test('never oversells: 40 simultaneous buyers, 10 tickets', async () => {
  const { typeId } = await makeEvent({ capacity: 10 });
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => buy(typeId, 1, i)));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 10);
  assert.strictEqual(results.filter((r) => r.status === 409).length, 30);
});

test('paid order issues tickets once, even if payment is confirmed twice', async () => {
  const { typeId } = await makeEvent({ capacity: 5 });
  const { body } = await buy(typeId, 2);
  await api('/api/mock/pay', { reference: body.reference });
  await api('/api/mock/pay', { reference: body.reference });
  const order = (await api(`/api/orders/${body.reference}`)).body;
  assert.strictEqual(order.status, 'paid');
  assert.strictEqual(order.tickets.length, 2);
});

test('unpaid reservations expire and return stock', async () => {
  const { typeId } = await makeEvent({ capacity: 3 });
  const first = await buy(typeId, 3);
  assert.strictEqual((await buy(typeId, 1)).status, 409);
  await db.query("UPDATE orders SET expires_at = NOW() - INTERVAL '1 day' WHERE reference = $1", [first.body.reference]);
  assert.strictEqual((await buy(typeId, 1)).status, 201);
});

// ---------- gate ----------
test('a ticket scans once, forged codes are rejected, other organizers cannot scan it', async () => {
  const { typeId } = await makeEvent({ capacity: 5 });
  const ref = await buyAndPay(typeId);
  const { code } = (await api(`/api/orders/${ref}`)).body.tickets[0];
  assert.strictEqual((await api('/api/checkin', { code }, token2)).body.result, 'wrong_event');
  assert.strictEqual((await api('/api/checkin', { code }, token)).body.result, 'valid');
  assert.strictEqual((await api('/api/checkin', { code }, token)).body.result, 'already_used');
  assert.strictEqual((await api('/api/checkin', { code: code.split('.')[0] + '.0000000000000000' }, token)).body.result, 'invalid');
  assert.strictEqual((await api('/api/checkin', { code: 'x.y' })).status, 401);
});

// ---------- platform fee ----------
test('platform fee: buyer pays 5% on top, organizer keeps the ticket price', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 10, priceNaira: 10000 });
  const { body } = await buy(typeId, 2);
  assert.strictEqual(body.subtotal_kobo, 2000000);
  assert.strictEqual(body.fee_kobo, 100000);
  assert.strictEqual(body.amount_kobo, 2100000);
  await api('/api/mock/pay', { reference: body.reference });
  const stats = (await api('/api/organizer/events', null, token)).body.find((e) => e.id === eventId).totals;
  assert.deepStrictEqual([stats.gross, stats.fees, stats.net], [2100000, 100000, 2000000]);
});

test('free tickets carry no fee and skip payment', async () => {
  const { typeId } = await makeEvent({ capacity: 5, priceNaira: 0 });
  const { body } = await buy(typeId, 2);
  assert.strictEqual(body.fee_kobo, 0);
  assert.strictEqual(body.amount_kobo, 0);
  assert.strictEqual((await api(`/api/orders/${body.reference}`)).body.tickets.length, 2);
});

// ---------- refunds ----------
test('organizer refund voids tickets, returns stock and cannot be repeated', async () => {
  const { typeId } = await makeEvent({ capacity: 2, priceNaira: 5000 });
  const ref = await buyAndPay(typeId, 2);
  assert.strictEqual((await buy(typeId, 1, 9)).status, 409);                    // sold out
  const { code } = (await api(`/api/orders/${ref}`)).body.tickets[0];
  const refund = await api(`/api/organizer/orders/${ref}/refund`, { reason: 'Event moved' }, token);
  assert.strictEqual(refund.status, 200);
  assert.strictEqual((await api(`/api/orders/${ref}`)).body.status, 'refunded');
  assert.strictEqual((await api('/api/checkin', { code }, token)).body.result, 'refunded');
  assert.strictEqual((await buy(typeId, 2, 8)).status, 201);                    // stock is back
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 409);
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token2)).status, 404);
});

test('buyers can refund themselves before the cutoff, with the right email', async () => {
  const { typeId } = await makeEvent({ capacity: 5, priceNaira: 2000 });
  const ref = await buyAndPay(typeId, 1, 3);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'someone@else.dev' })).status, 404);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'buyer3@test.dev' })).status, 200);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'buyer3@test.dev' })).status, 409);
});

test('self-service refunds close at the cutoff, but the organizer can still refund', async () => {
  const { typeId } = await makeEvent({ capacity: 5, priceNaira: 2000, days: 1 });  // starts in 24h, cutoff is 48h
  const ref = await buyAndPay(typeId, 1, 4);
  assert.strictEqual((await api(`/api/orders/${ref}`)).body.refund.available, false);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'buyer4@test.dev' })).status, 403);
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 200);
});

test('used tickets block refunds', async () => {
  const { typeId } = await makeEvent({ capacity: 5, priceNaira: 2000 });
  const ref = await buyAndPay(typeId, 2, 5);
  const { code } = (await api(`/api/orders/${ref}`)).body.tickets[0];
  await api('/api/checkin', { code }, token);
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 409);
});

// ---------- search ----------
test('search filters by text, category, price and sorts', async () => {
  await makeEvent({ title: 'Zebra Jazz Night', category: 'Music', priceNaira: 5000, days: 20 });
  await makeEvent({ title: 'Zebra Coding Meetup', category: 'Tech', priceNaira: 0, days: 5 });
  const titles = async (qs) => (await api('/api/events?q=zebra' + qs)).body.map((e) => e.title);
  assert.deepStrictEqual(await titles(''), ['Zebra Coding Meetup', 'Zebra Jazz Night']);       // soonest first
  assert.deepStrictEqual(await titles('&category=Music'), ['Zebra Jazz Night']);
  assert.deepStrictEqual(await titles('&price=free'), ['Zebra Coding Meetup']);
  assert.deepStrictEqual(await titles('&price=paid'), ['Zebra Jazz Night']);
  assert.deepStrictEqual(await titles('&when=week'), ['Zebra Coding Meetup']);
  assert.deepStrictEqual(await titles('&sort=price'), ['Zebra Coding Meetup', 'Zebra Jazz Night']);
  assert.deepStrictEqual((await api('/api/events?q=%25')).body, []);                             // wildcards are escaped
});

// ---------- pictures ----------
test('organizers manage event pictures; bad files and strangers are rejected', async () => {
  const { eventId } = await makeEvent();
  const up = await api(`/api/organizer/events/${eventId}/images`, { image: PNG }, token);
  assert.strictEqual(up.status, 201);
  const img = await fetch(`${base}/api/images/${up.body.id}`);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await api(`/api/organizer/events/${eventId}/images`, { image: 'data:text/html;base64,PGI+' }, token)).status, 400);
  const fake = 'data:image/png;base64,' + Buffer.from('this is not a png').toString('base64');
  assert.strictEqual((await api(`/api/organizer/events/${eventId}/images`, { image: fake }, token)).status, 400);
  assert.strictEqual((await api(`/api/organizer/events/${eventId}/images`, { image: PNG }, token2)).status, 404);
  const second = await api(`/api/organizer/events/${eventId}/images`, { image: PNG }, token);
  await api(`/api/organizer/events/${eventId}/images/${second.body.id}/cover`, {}, token);
  assert.strictEqual((await api(`/api/events/${eventId}`)).body.images[0], second.body.id);
  assert.strictEqual((await api('/api/events?q=Test event')).body.find((e) => e.id === eventId).cover_image_id, second.body.id);
  await api(`/api/organizer/events/${eventId}/images/${second.body.id}`, null, token, 'DELETE');
  assert.strictEqual((await api(`/api/events/${eventId}`)).body.images.length, 1);
  for (let i = 0; i < 5; i++) await api(`/api/organizer/events/${eventId}/images`, { image: PNG }, token);
  assert.strictEqual((await api(`/api/organizer/events/${eventId}/images`, { image: PNG }, token)).status, 400);   // max 6
});

// ---------- rate limiting ----------
test('login attempts are rate limited', async () => {
  const tight = createApp({ limits: { auth: { limit: 3 }, api: { limit: 100000 } } }).listen(0);
  const url = `http://localhost:${tight.address().port}/api/auth/login`;
  const attempt = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'org@test.dev', password: 'wrong-password' }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await attempt()).status);
  tight.close();
  assert.deepStrictEqual(codes, [401, 401, 401, 429, 429]);
});

// ---------- refund requests (after the instant-refund cutoff) ----------
const decide = (ref, action, note, auth = token) => api(`/api/organizer/orders/${ref}/refund-request/decide`, { action, note }, auth);
const request = (ref, i, reason = 'Cannot attend') => api(`/api/orders/${ref}/refund-request`, { email: `buyer${i}@test.dev`, reason });

test('after the cutoff the buyer sends a request and the organizer approves it', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 2, priceNaira: 4000, days: 1 });     // starts in 24h, cutoff is 48h
  const ref = await buyAndPay(typeId, 2, 20);
  const order = (await api(`/api/orders/${ref}`)).body;
  assert.strictEqual(order.refund.available, false);
  assert.strictEqual(order.refund.canRequest, true);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'buyer20@test.dev' })).status, 403);          // no instant refund any more
  assert.strictEqual((await api(`/api/orders/${ref}/refund-request`, { email: 'nobody@test.dev' })).status, 404);   // wrong email
  assert.strictEqual((await request(ref, 20)).status, 201);
  assert.strictEqual((await request(ref, 20)).status, 409);                                                         // only one request per order
  const after = (await api(`/api/orders/${ref}`)).body;
  assert.strictEqual(after.refund.request.status, 'pending');
  assert.strictEqual(after.refund.canRequest, false);
  const row = (await api(`/api/organizer/events/${eventId}/orders`, null, token)).body[0];
  assert.deepStrictEqual([row.request_status, row.request_reason], ['pending', 'Cannot attend']);                  // waiting requests are listed first
  const totals = (await api('/api/organizer/events', null, token)).body.find((e) => e.id === eventId).totals;
  assert.strictEqual(totals.needs_attention, 1);
  assert.strictEqual((await decide(ref, 'approve', '', token2)).status, 404);                                       // other organizers cannot decide
  assert.strictEqual((await decide(ref, 'maybe')).status, 400);
  assert.strictEqual((await decide(ref, 'approve')).status, 200);
  assert.strictEqual((await api(`/api/orders/${ref}`)).body.status, 'refunded');
  assert.strictEqual((await api(`/api/organizer/events/${eventId}/orders`, null, token)).body[0].request_status, 'approved');
  assert.strictEqual((await decide(ref, 'approve')).status, 409);                                                   // already handled
  assert.strictEqual((await buy(typeId, 2, 90)).status, 201);                                                       // the stock came back
});

test('declining keeps the tickets valid and the buyer cannot ask again', async () => {
  const { typeId } = await makeEvent({ capacity: 5, priceNaira: 4000, days: 1 });
  const ref = await buyAndPay(typeId, 1, 21);
  assert.strictEqual((await request(ref, 21)).status, 201);
  assert.strictEqual((await decide(ref, 'decline', 'Please transfer the ticket instead')).status, 200);
  const order = (await api(`/api/orders/${ref}`)).body;
  assert.strictEqual(order.status, 'paid');
  assert.deepStrictEqual([order.refund.request.status, order.refund.request.decline_note], ['declined', 'Please transfer the ticket instead']);
  assert.strictEqual(order.refund.canRequest, false);
  assert.strictEqual((await request(ref, 21)).status, 409);
  assert.strictEqual((await decide(ref, 'approve')).status, 409);
  assert.strictEqual((await api('/api/checkin', { code: order.tickets[0].code }, token)).body.result, 'valid');       // still works at the gate
});

test('requests are refused before the cutoff, after the event starts, and once tickets are used', async () => {
  const early = await makeEvent({ capacity: 5, priceNaira: 4000, days: 10 });
  const r1 = await buyAndPay(early.typeId, 1, 22);
  assert.strictEqual((await request(r1, 22)).status, 409);                       // still inside the instant-refund window
  const started = await makeEvent({ capacity: 5, priceNaira: 4000, days: -1 });
  const r2 = await buyAndPay(started.typeId, 1, 23);
  assert.strictEqual((await api(`/api/orders/${r2}`)).body.refund.reason, 'started');
  assert.strictEqual((await request(r2, 23)).status, 403);
  const used = await makeEvent({ capacity: 5, priceNaira: 4000, days: 1 });
  const r3 = await buyAndPay(used.typeId, 2, 24);
  await api('/api/checkin', { code: (await api(`/api/orders/${r3}`)).body.tickets[0].code }, token);
  assert.strictEqual((await request(r3, 24)).status, 409);
});

test('an organizer refund also settles a waiting request', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 5, priceNaira: 4000, days: 1 });
  const ref = await buyAndPay(typeId, 1, 25);
  await request(ref, 25);
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 200);
  const row = (await api(`/api/organizer/events/${eventId}/orders`, null, token)).body.find((o) => o.reference === ref);
  assert.strictEqual(row.request_status, 'approved');
  assert.strictEqual((await decide(ref, 'decline')).status, 409);
});

// ---------- no-refund events ----------
test('a no-refund event blocks buyer refunds and requests, but the organizer can still refund', async () => {
  const res = await api('/api/organizer/events', { title: 'Final Sale Show', venue: 'Hall', category: 'Music', startsAt: inDays(10), refundsAllowed: false, ticketTypes: [{ name: 'Regular', priceNaira: 3000, capacity: 5 }] }, token);
  assert.strictEqual(res.status, 201);
  const event = (await api(`/api/events/${res.body.id}`)).body;
  assert.deepStrictEqual([event.refundsAllowed, event.refundPolicy.allowed], [false, false]);
  const ref = await buyAndPay(event.ticketTypes[0].id, 1, 30);
  const order = (await api(`/api/orders/${ref}`)).body;
  assert.deepStrictEqual([order.refund.available, order.refund.canRequest, order.refund.reason], [false, false, 'none']);
  assert.strictEqual((await api(`/api/orders/${ref}/refund`, { email: 'buyer30@test.dev' })).status, 403);
  assert.strictEqual((await api(`/api/orders/${ref}/refund-request`, { email: 'buyer30@test.dev' })).status, 403);
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 200);
});

// ---------- editing events ----------
test('organizers can edit an event, its ticket types and its refund policy', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 5, priceNaira: 1000, title: 'Editable Event' });
  const ref = await buyAndPay(typeId, 2, 31);                                                   // 2 tickets sold
  const put = (types, extra = {}, auth = token) => api(`/api/organizer/events/${eventId}`, {
    title: 'Edited Title', venue: 'New Venue', category: 'Music', startsAt: inDays(12), description: 'Updated text',
    refundsAllowed: false, refundCutoffHours: 24, ticketTypes: types, ...extra }, auth, 'PUT');
  const regular = (o = {}) => ({ id: typeId, name: 'Regular Plus', priceNaira: 1500, capacity: 20, ...o });

  assert.strictEqual((await put([regular()], {}, token2)).status, 404);                          // not your event
  assert.strictEqual((await put([regular({ capacity: 1 })])).status, 409);                       // below the 2 already sold
  assert.strictEqual((await put([{ name: 'Only new', priceNaira: 100, capacity: 5 }])).status, 409);   // would remove a type that has orders
  assert.strictEqual((await put([regular()], { title: '' })).status, 400);
  assert.strictEqual((await put([regular({ id: 999999 })])).status, 400);                        // type from somewhere else

  const ok = await put([regular(), { name: 'VIP', priceNaira: 9000, capacity: 3 }]);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.notified, 1);                                                       // date and venue changed, one buyer told
  const ev = (await api(`/api/events/${eventId}`)).body;
  assert.deepStrictEqual([ev.title, ev.venue, ev.category, ev.description, ev.refundsAllowed], ['Edited Title', 'New Venue', 'Music', 'Updated text', false]);
  assert.deepStrictEqual(ev.ticketTypes.map((t) => [t.name, t.price_kobo, t.remaining]), [['Regular Plus', 150000, 18], ['VIP', 900000, 3]]);
  assert.strictEqual((await api(`/api/orders/${ref}`)).body.subtotal_kobo, 200000);              // the earlier order keeps the price it was bought at

  const trimmed = await put([regular()], { startsAt: ev.starts_at, venue: 'New Venue' });         // drop the unused VIP type, nothing else changes
  assert.strictEqual(trimmed.status, 200);
  assert.strictEqual(trimmed.body.notified, 0);
  assert.strictEqual((await api(`/api/events/${eventId}`)).body.ticketTypes.length, 1);
});

// ---------- deleting events ----------
test('deleting an event hides it, and live orders must be refunded first', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 5, priceNaira: 1000, title: 'Doomed Event' });
  const ref = await buyAndPay(typeId, 1, 32);
  const del = (id, auth = token) => api(`/api/organizer/events/${id}`, null, auth, 'DELETE');
  assert.strictEqual((await del(eventId, token2)).status, 404);
  assert.strictEqual((await del(eventId)).status, 409);                                          // still has a paid order
  assert.strictEqual((await api(`/api/organizer/orders/${ref}/refund`, {}, token)).status, 200);
  assert.strictEqual((await del(eventId)).status, 200);
  assert.strictEqual((await api(`/api/events/${eventId}`)).status, 404);
  assert.deepStrictEqual((await api('/api/events?q=Doomed')).body, []);
  assert.ok(!(await api('/api/organizer/events', null, token)).body.some((e) => e.id === eventId));
  assert.strictEqual((await buy(typeId, 1, 33)).status, 404);                                    // can no longer be bought
  assert.strictEqual((await api(`/api/orders/${ref}`)).body.status, 'refunded');                 // the buyer's history is kept
  assert.strictEqual((await api(`/api/organizer/events/${eventId}`, { title: 'x' }, token, 'PUT')).status, 404);
});

test('an event that is long over can be deleted even though it had sales', async () => {
  const { eventId, typeId } = await makeEvent({ capacity: 5, priceNaira: 1000, days: -3, title: 'Old Event' });
  await buyAndPay(typeId, 1, 34);
  assert.strictEqual((await api(`/api/organizer/events/${eventId}`, null, token, 'DELETE')).status, 200);
});

// ---------- share previews ----------
test('shared event links carry a preview with the event details (escaped)', async () => {
  const res = await api('/api/organizer/events', { title: 'Preview <Night> & "Show"', venue: 'Hall', category: 'Music', startsAt: inDays(5), description: 'Great night', ticketTypes: [{ name: 'Regular', priceNaira: 100, capacity: 5 }] }, token);
  await api(`/api/organizer/events/${res.body.id}/images`, { image: PNG }, token);
  const html = await (await fetch(`${base}/event.html?id=${res.body.id}`)).text();
  assert.ok(html.includes('<meta property="og:title" content="Preview &lt;Night&gt; &amp; &quot;Show&quot;">'));
  assert.ok(html.includes('<title>Preview &lt;Night&gt; &amp; &quot;Show&quot; · Gatepass</title>'));
  assert.ok(/property="og:image" content="[^"]+\/api\/images\/\d+"/.test(html));
  const generic = await (await fetch(`${base}/event.html?id=999999`)).text();
  assert.ok(generic.includes('<title>Event · Gatepass</title>') && !generic.includes('og:title'));
});

test('health check answers for uptime pingers', async () => {
  assert.deepStrictEqual((await api('/api/health')).body, { ok: true });
});
