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

const HIGH = { auth: { limit: 1000 }, checkout: { limit: 1000 }, refund: { limit: 1000 }, upload: { limit: 1000 }, broadcast: { limit: 1000 }, quote: { limit: 1000 }, api: { limit: 100000 } };
const realFetch = global.fetch;
const sent = [], failFor = new Set();
global.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.brevo.com')) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  if (Array.isArray(body.attachment) && body.attachment.length === 0) return { ok: false, status: 400, json: async () => ({ message: 'attachment is missing' }) };   // the real Brevo does this
  if (failFor.has(body.to[0].email)) return { ok: false, status: 400, json: async () => ({ message: 'invalid recipient' }) };
  sent.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent, replyTo: body.replyTo });
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

// ---------- password reset ----------
const tokenIn = (m, page) => decodeURIComponent(new RegExp(`${page}\\.html\\?token=([^"&]+)`).exec(m.html)[1]);

test('password reset: a single-use emailed link, every login ends, and nothing leaks about who has an account', async () => {
  const org = await makeOrganizer('reset@features.test');
  assert.strictEqual((await api('/api/organizer/events', null, org)).status, 200);

  assert.strictEqual((await api('/api/auth/forgot', { email: 'ghost@features.test' })).status, 200);       // same answer for unknown emails
  assert.strictEqual((await api('/api/auth/forgot', { email: 'reset@features.test' })).status, 200);
  assert.ok(await waitFor(() => mails('reset@features.test', 'Reset your').length === 1));
  assert.strictEqual(mails('ghost@features.test', 'Reset').length, 0);
  const mail = mails('reset@features.test', 'Reset your')[0];
  assert.ok(mail.html.includes('https://gatepass.example/reset.html?token='));
  const token = tokenIn(mail, 'reset');

  assert.strictEqual((await api('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.strictEqual((await api('/api/auth/reset', { token: 'garbage', password: 'brand-new-pass' })).status, 400);
  assert.strictEqual((await api('/api/auth/reset', { token: org, password: 'brand-new-pass' })).status, 400);    // a login token is not a reset link
  assert.strictEqual((await api('/api/auth/reset', { token, password: 'brand-new-pass' })).status, 200);

  assert.strictEqual((await api('/api/organizer/events', null, org)).status, 401);                               // the old login no longer works anywhere
  assert.strictEqual((await api('/api/auth/login', { email: 'reset@features.test', password: 'password123' })).status, 401);
  const fresh = await api('/api/auth/login', { email: 'reset@features.test', password: 'brand-new-pass' });
  assert.strictEqual(fresh.status, 200);
  assert.strictEqual((await api('/api/organizer/events', null, fresh.body.token)).status, 200);
  assert.strictEqual((await api('/api/auth/reset', { token, password: 'another-new-pass' })).status, 400);        // the link only works once
});

test('password reset also confirms an account that was never confirmed', async () => {
  await api('/api/auth/register', { name: 'Late', email: 'late@features.test', password: 'password123' });
  assert.strictEqual((await api('/api/auth/login', { email: 'late@features.test', password: 'password123' })).status, 403);
  await api('/api/auth/forgot', { email: 'late@features.test' });
  assert.ok(await waitFor(() => mails('late@features.test', 'Reset your').length === 1));
  assert.strictEqual((await api('/api/auth/reset', { token: tokenIn(mails('late@features.test', 'Reset your')[0], 'reset'), password: 'chosen-password' })).status, 200);
  assert.strictEqual((await api('/api/auth/login', { email: 'late@features.test', password: 'chosen-password' })).status, 200);
});


// ---------- team invitations by email ----------
test('team invitations are emailed, and a failed email leaves no invitation behind', async () => {
  const boss = await makeOrganizer('boss@features.test');
  const ok = await api('/api/organizer/team', { name: 'Tolu Scanner', email: 'tolu@features.test' }, boss);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.inviteUrl, undefined);                                           // with email set up, the link is only in the email
  const mail = mails('tolu@features.test', 'invited you')[0];
  assert.ok(mail.html.includes('https://gatepass.example/join.html?token=') && mail.html.includes('will not see earnings'));
  assert.strictEqual((await api('/api/auth/join', { token: tokenIn(mail, 'join'), password: 'tolu-password-1' })).status, 201);
  assert.strictEqual((await api('/api/auth/login', { email: 'tolu@features.test', password: 'tolu-password-1' })).body.role, 'scanner');

  failFor.add('bounce@features.test');
  assert.strictEqual((await api('/api/organizer/team', { name: 'Bounce', email: 'bounce@features.test' }, boss)).status, 502);
  failFor.delete('bounce@features.test');
  assert.deepStrictEqual((await api('/api/organizer/team', null, boss)).body.map((m) => m.email), ['tolu@features.test']);      // no half-made invitation
  assert.strictEqual((await api('/api/organizer/team', { name: 'Bounce', email: 'bounce@features.test' }, boss)).status, 201);
});

// ---------- messages to ticket holders ----------
const broadcast = require('../src/broadcast');

test('messages to ticket holders: audience, test send, real send with reply-to, filters, history and failures', async () => {
  const org = await makeOrganizer('speaker@features.test');
  const created = await api('/api/organizer/events', { title: 'Broadcast Night', venue: 'Hall', category: 'Music', startsAt: inDays(10),
    ticketTypes: [{ name: 'Regular', priceNaira: 2000, capacity: 50 }, { name: 'VIP', priceNaira: 9000, capacity: 10 }] }, org);
  const id = created.body.id, [regular, vip] = (await api(`/api/events/${id}`)).body.ticketTypes;
  await buyAndPay(regular.id, 50, 2);                                    // buyer 50: one order, two tickets
  await buyAndPay(regular.id, 51); await buyAndPay(vip.id, 51);          // buyer 51: two orders, counts once
  const refunded = await buyAndPay(regular.id, 52);                      // refunded, so not included
  await api(`/api/organizer/orders/${refunded}/refund`, {}, org);
  await api('/api/checkout', { ticketTypeId: regular.id, quantity: 1, name: 'Unpaid', email: 'fbuyer53@test.dev' });    // never paid, not included

  const aud = (await api(`/api/organizer/events/${id}/audience`, null, org)).body;
  assert.strictEqual(aud.total, 2);
  assert.deepStrictEqual(aud.byType.map((x) => [x.name, x.people]), [['Regular', 2], ['VIP', 1]]);
  const send = (body, auth = org) => api(`/api/organizer/events/${id}/message`, body, auth);
  const history = async () => (await api(`/api/organizer/events/${id}/messages`, null, org)).body;

  // A test copy goes only to the organizer, marked as a test.
  const test1 = await send({ subject: 'Doors open at 6', body: 'Hello\nBring ID <b>please</b>', testOnly: true });
  assert.strictEqual(test1.status, 200);
  assert.ok(await waitFor(() => mails('speaker@features.test', '[Test] Doors open at 6').length === 1));
  const preview = mails('speaker@features.test', '[Test]')[0];
  assert.deepStrictEqual(preview.replyTo, { email: 'speaker@features.test', name: 'Organizer speaker@features.test' });
  assert.ok(preview.html.includes('Hello<br>Bring ID &lt;b&gt;please&lt;/b&gt;'), 'text is escaped and keeps its line breaks');
  assert.strictEqual(mails('fbuyer50@test.dev', 'Doors open').length, 0);
  assert.deepStrictEqual(await history(), []);                                                         // a test is not recorded as a send

  // The real send: each person once, replies go to the organizer, each gets their own ticket link.
  const real = await send({ subject: 'Doors open at 6', body: 'See you there!' });
  assert.deepStrictEqual([real.status, real.body.recipients], [202, 2]);
  assert.ok(await waitFor(async () => (await history())[0]?.status === 'done'));
  assert.deepStrictEqual((await history())[0] && [(await history())[0].recipient_count, (await history())[0].sent_count, (await history())[0].failed_count], [2, 2, 0]);
  for (const n of [50, 51]) {
    const m = mails(`fbuyer${n}@test.dev`, 'Doors open at 6');
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].replyTo.email, 'speaker@features.test');
    assert.ok(m[0].html.includes('https://gatepass.example/ticket.html?reference=gp_') && m[0].html.includes('See you there!'));
  }
  assert.strictEqual(mails('fbuyer52@test.dev', 'Doors open').length + mails('fbuyer53@test.dev', 'Doors open').length, 0);
  assert.strictEqual((await send({ subject: 'Doors open at 6', body: 'See you there!' })).status, 409);       // the same message again, straight away

  // Only one ticket type.
  const vipOnly = await send({ subject: 'VIP lounge', body: 'Your lounge is on the 2nd floor.', ticketTypeId: vip.id });
  assert.strictEqual(vipOnly.body.recipients, 1);
  assert.ok(await waitFor(() => mails('fbuyer51@test.dev', 'VIP lounge').length === 1));
  assert.strictEqual(mails('fbuyer50@test.dev', 'VIP lounge').length, 0);

  // If an email fails, it is counted and the rest still go out.
  assert.ok(await waitFor(async () => (await history())[0]?.status === 'done'));
  failFor.add('fbuyer51@test.dev');
  const flaky = await send({ subject: 'Parking', body: 'Park at gate B.' });
  assert.strictEqual(flaky.status, 202);
  assert.ok(await waitFor(async () => (await history())[0]?.subject === 'Parking' && (await history())[0].status === 'done'));
  failFor.delete('fbuyer51@test.dev');
  const last = (await history())[0];
  assert.deepStrictEqual([last.sent_count, last.failed_count], [1, 1]);
  assert.deepStrictEqual((await history()).map((m) => m.subject), ['Parking', 'VIP lounge', 'Doors open at 6']);   // newest first
});

test('messages to ticket holders: only the organizer, only real input, and not too often', async () => {
  const org = await makeOrganizer('careful@features.test'), stranger = await makeOrganizer('stranger@features.test');
  const mine = await makeEvent(org, { title: 'Careful Event' }), spare = await makeEvent(org, { title: 'Spare Event' }), empty = await makeEvent(org, { title: 'Empty Event' });
  await buyAndPay(mine.typeId, 60);
  const send = (body, auth = org, ev = mine.eventId) => api(`/api/organizer/events/${ev}/message`, body, auth);

  assert.strictEqual((await send({ subject: 'Hi', body: 'x' }, stranger)).status, 404);                       // someone else's event
  assert.strictEqual((await api(`/api/organizer/events/${mine.eventId}/audience`, null, stranger)).status, 404);
  assert.strictEqual((await api(`/api/organizer/events/${mine.eventId}/messages`, null, stranger)).status, 404);
  assert.strictEqual((await send({ subject: 'Hi', body: 'x' }, undefined)).status, 202);                       // the owner can
  assert.strictEqual((await send({ subject: '', body: 'x' })).status, 400);
  assert.strictEqual((await send({ subject: 'No body', body: '   ' })).status, 400);
  assert.strictEqual((await send({ subject: 'Wrong type', body: 'x', ticketTypeId: spare.typeId })).status, 400);   // a ticket type from another event
  assert.strictEqual((await send({ subject: 'Nobody', body: 'x' }, org, empty.eventId)).status, 400);        // nobody holds a ticket yet
  assert.strictEqual((await api(`/api/organizer/events/${mine.eventId}/message`, { subject: 'No login', body: 'x' })).status, 401);

  const ownerId = (await db.query("SELECT id FROM users WHERE email = 'careful@features.test'")).rows[0].id;     // ten messages today is the limit
  for (let i = 0; i < 9; i++) await db.query("INSERT INTO event_messages (event_id, user_id, subject, body, recipient_count, status) VALUES ($1, $2, $3, 'b', 1, 'done')", [mine.eventId, ownerId, 'Earlier ' + i]);
  assert.strictEqual((await send({ subject: 'One too many', body: 'x' })).status, 429);
});

test('a send that was interrupted by a restart is shown as interrupted', async () => {
  const org = await makeOrganizer('restart@features.test');
  const ev = await makeEvent(org, { title: 'Restart Event' });
  const ownerId = (await db.query("SELECT id FROM users WHERE email = 'restart@features.test'")).rows[0].id;
  await db.query("INSERT INTO event_messages (event_id, user_id, subject, body, recipient_count, created_at) VALUES ($1, $2, 'Old', 'b', 5, NOW() - INTERVAL '2 hours')", [ev.eventId, ownerId]);
  await db.query("INSERT INTO event_messages (event_id, user_id, subject, body, recipient_count) VALUES ($1, $2, 'Fresh', 'b', 5)", [ev.eventId, ownerId]);
  await broadcast.interruptStale();
  const rows = (await api(`/api/organizer/events/${ev.eventId}/messages`, null, org)).body;
  assert.deepStrictEqual(rows.map((m) => [m.subject, m.status]), [['Fresh', 'sending'], ['Old', 'interrupted']]);      // only the stale one
});
