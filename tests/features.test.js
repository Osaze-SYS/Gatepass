// Email-driven features. Brevo is replaced by a fake that records every email instead of sending it.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.APP_SECRET = 'test-secret';
process.env.BREVO_API_KEY = 'test-key';
process.env.SMTP_HOST = '';
process.env.MAIL_FROM = 'Gatepass <noreply@example.com>';
process.env.BASE_URL = 'https://gatepass.example';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp } = require('../server');

const HIGH = { auth: { limit: 1000 }, checkout: { limit: 1000 }, refund: { limit: 1000 }, upload: { limit: 1000 }, api: { limit: 100000 } };
const realFetch = global.fetch;
const sent = [], failFor = new Set();
global.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.brevo.com')) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  if (Array.isArray(body.attachment) && body.attachment.length === 0) return { ok: false, status: 400, json: async () => ({ message: 'attachment is missing' }) };   // the real Brevo does this
  if (failFor.has(body.to[0].email)) return { ok: false, status: 400, json: async () => ({ message: 'invalid recipient' }) };
  sent.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent });
  return { ok: true, status: 201, json: async () => ({}) };
};
const mails = (to, part) => sent.filter((m) => m.to === to && m.subject.includes(part));
const waitFor = async (cond, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

let server, base;
const api = async (path, body, auth, method) => {
  const res = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
const tokenFromEmail = (m) => decodeURIComponent(/verify\.html\?token=([^"&]+)/.exec(m.html)[1]);

// Registers an organizer, confirms their email through the emailed link, and logs them in.
async function makeOrganizer(email) {
  await api('/api/auth/register', { name: 'Organizer ' + email, email, password: 'password123' });
  await api('/api/auth/verify', { token: tokenFromEmail(mails(email, 'Confirm')[0]) });
  return (await api('/api/auth/login', { email, password: 'password123' })).body.token;
}
async function makeEvent(token, { days = 10, price = 5000, capacity = 10, title = 'Mail Event' } = {}) {
  const res = await api('/api/organizer/events', { title, venue: 'Hall', category: 'Tech', startsAt: inDays(days), ticketTypes: [{ name: 'Regular', priceNaira: price, capacity }] }, token);
  const ev = (await api(`/api/events/${res.body.id}`)).body;
  return { eventId: res.body.id, typeId: ev.ticketTypes[0].id, title };
}
async function buyAndPay(typeId, n, qty = 1) {
  const { body } = await api('/api/checkout', { ticketTypeId: typeId, quantity: qty, name: 'Buyer ' + n, email: `fbuyer${n}@test.dev` });
  await api('/api/mock/pay', { reference: body.reference });
  return body.reference;
}

test.before(async () => { await db.init(); server = createApp({ limits: HIGH }).listen(0); base = `http://localhost:${server.address().port}`; });
test.after(async () => { server.close(); await db.close(); });

test('new accounts must confirm their email before they can log in', async () => {
  const reg = await api('/api/auth/register', { name: 'Ada', email: 'ada@features.test', password: 'password123' });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.body.needsVerification, true);
  assert.strictEqual(reg.body.token, undefined);                                              // no session until the email is confirmed
  const first = mails('ada@features.test', 'Confirm')[0];
  assert.ok(first.html.includes('https://gatepass.example/verify.html?token='));
  const blocked = await api('/api/auth/login', { email: 'ada@features.test', password: 'password123' });
  assert.deepStrictEqual([blocked.status, blocked.body.needsVerification, blocked.body.email], [403, true, 'ada@features.test']);
  assert.strictEqual((await api('/api/auth/login', { email: 'ada@features.test', password: 'wrong-password' })).status, 401);
  assert.strictEqual((await api('/api/auth/resend', { email: 'ada@features.test' })).status, 200);
  assert.strictEqual(mails('ada@features.test', 'Confirm').length, 2);
  assert.strictEqual((await api('/api/auth/resend', { email: 'nobody@features.test' })).status, 200);   // same answer for unknown emails
  assert.strictEqual(mails('nobody@features.test', 'Confirm').length, 0);
  assert.strictEqual((await api('/api/auth/verify', { token: 'garbage' })).status, 400);
  const token = tokenFromEmail(first);
  assert.strictEqual((await api('/api/organizer/events', null, token)).status, 401);          // a confirmation link is not a login
  assert.strictEqual((await api('/api/auth/verify', { token })).status, 200);

  const ttl = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).exp - Date.now();
  const short = (await api('/api/auth/login', { email: 'ada@features.test', password: 'password123' })).body.token;
  const long = (await api('/api/auth/login', { email: 'ada@features.test', password: 'password123', remember: true })).body.token;
  assert.ok(ttl(short) < 25 * 3600e3 && ttl(short) > 20 * 3600e3, 'without "remember me" the session lasts about a day');
  assert.ok(ttl(long) > 29 * 864e5, '"remember me" keeps it about 30 days');
  assert.strictEqual((await api('/api/organizer/events', null, long)).status, 200);
});

test('registration fails cleanly if the confirmation email cannot be sent', async () => {
  failFor.add('bad@features.test');
  assert.strictEqual((await api('/api/auth/register', { name: 'Bad', email: 'bad@features.test', password: 'password123' })).status, 502);
  failFor.delete('bad@features.test');
  assert.strictEqual((await api('/api/auth/login', { email: 'bad@features.test', password: 'password123' })).status, 401);   // no half-made account
  assert.strictEqual((await api('/api/auth/register', { name: 'Bad', email: 'bad@features.test', password: 'password123' })).status, 201);   // can try again
});

test('the organizer is emailed about every sale, and the buyer gets a link to share the event', async () => {
  const org = await makeOrganizer('seller@features.test');
  const { eventId, typeId, title } = await makeEvent(org, { price: 5000 });
  await buyAndPay(typeId, 1, 2);
  assert.ok(await waitFor(() => mails('seller@features.test', 'New sale').length === 1 && mails('fbuyer1@test.dev', 'Your tickets').length === 1));
  const sale = mails('seller@features.test', 'New sale')[0];
  assert.ok(sale.subject.includes('2 × Regular') && sale.subject.includes(title));
  assert.ok(sale.html.includes('Buyer 1') && sale.html.includes('fbuyer1@test.dev') && sale.html.includes('₦10,500') && sale.html.includes('₦10,000'));   // paid vs what the organizer earns
  assert.ok(mails('fbuyer1@test.dev', 'Your tickets')[0].html.includes(`https://gatepass.example/event.html?id=${eventId}`));
});

test('when a refund is granted, the buyer and the organizer are both emailed', async () => {
  const org = await makeOrganizer('refunder@features.test');
  const early = await makeEvent(org, { days: 10, price: 2000 });
  const refundsTo = (e) => mails(e, 'Refund granted').length;

  const r1 = await buyAndPay(early.typeId, 2);                                               // buyer refunds instantly
  await api(`/api/orders/${r1}/refund`, { email: 'fbuyer2@test.dev' });
  assert.ok(await waitFor(() => mails('fbuyer2@test.dev', 'Your refund').length === 1 && refundsTo('refunder@features.test') === 1));
  assert.ok(mails('refunder@features.test', 'Refund granted')[0].html.includes('automatically'));

  const closing = await makeEvent(org, { days: 1, price: 2000, title: 'Closing Event' });    // inside the cutoff: request, then approval
  const r2 = await buyAndPay(closing.typeId, 3);
  await api(`/api/orders/${r2}/refund-request`, { email: 'fbuyer3@test.dev', reason: 'Cannot come' });
  assert.ok(await waitFor(() => mails('refunder@features.test', 'Refund request').length === 1));
  await api(`/api/organizer/orders/${r2}/refund-request/decide`, { action: 'approve' }, org);
  assert.ok(await waitFor(() => mails('fbuyer3@test.dev', 'Your refund').length === 1 && refundsTo('refunder@features.test') === 2));
  assert.ok(mails('refunder@features.test', 'Refund granted')[1].html.includes('You approved'));

  const r3 = await buyAndPay(early.typeId, 4);                                               // the organizer refunds directly: only the buyer is emailed
  await api(`/api/organizer/orders/${r3}/refund`, {}, org);
  assert.ok(await waitFor(() => mails('fbuyer4@test.dev', 'Your refund').length === 1));
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(refundsTo('refunder@features.test'), 2);
});

test('changing the date or venue emails everyone holding tickets, other edits do not', async () => {
  const org = await makeOrganizer('editor@features.test');
  const { eventId, typeId, title } = await makeEvent(org, { title: 'Moving Event' });
  await buyAndPay(typeId, 5); await buyAndPay(typeId, 6); await buyAndPay(typeId, 6);          // two people, one of them twice
  const body = (extra) => ({ title, venue: 'Hall', category: 'Tech', startsAt: new Date((await_event.starts_at)).toISOString(), refundCutoffHours: 48, ticketTypes: [{ id: typeId, name: 'Regular', priceNaira: 5000, capacity: 10 }], ...extra });
  const await_event = (await api(`/api/events/${eventId}`)).body;
  const updates = () => sent.filter((m) => m.subject === `Update for ${title}`);

  const quiet = await api(`/api/organizer/events/${eventId}`, body({ description: 'New description' }), org, 'PUT');
  assert.strictEqual(quiet.body.notified, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(updates().length, 0);

  const moved = await api(`/api/organizer/events/${eventId}`, body({ venue: 'Brand New Venue' }), org, 'PUT');
  assert.strictEqual(moved.body.notified, 2);
  assert.ok(await waitFor(() => updates().length === 2));
  assert.deepStrictEqual(updates().map((m) => m.to).sort(), ['fbuyer5@test.dev', 'fbuyer6@test.dev']);
  assert.ok(updates()[0].html.includes('Brand New Venue') && updates()[0].html.includes('still valid'));
});
