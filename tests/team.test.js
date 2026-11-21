// With no email service set up the invitation link is handed back to the organizer, which lets these tests use it directly.
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');

let t, org, other;
test.before(async () => { t = await boot(); org = await t.register('org@team.test'); other = await t.register('other@team.test'); });
test.after(() => t.close());

const tokenOf = (url) => decodeURIComponent(new URL(url).searchParams.get('token'));
const invite = (name, email, auth = org) => t.api('/api/organizer/team', { name, email }, auth);
// Invites someone, accepts as them, and returns their login token.
async function addScanner(email, name = 'Sam Scanner', ownerToken = org) {
  const inv = await invite(name, email, ownerToken);
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));
  assert.strictEqual((await t.api('/api/auth/join', { token: tokenOf(inv.body.inviteUrl), password: 'scanner-pass-1' })).status, 201);
  return (await t.api('/api/auth/login', { email, password: 'scanner-pass-1' })).body.token;
}

test('invitations: sent once, checked, accepted with a password, and used only once', async () => {
  const inv = await invite('Sam Scanner', ' Sam@Team.test ');
  assert.strictEqual(inv.status, 201);
  assert.match(inv.body.inviteUrl, /\/join\.html\?token=/);
  const token = tokenOf(inv.body.inviteUrl);
  let list = (await t.api('/api/organizer/team', null, org)).body;
  assert.deepStrictEqual(list.map((m) => [m.name, m.email, m.status]), [['Sam Scanner', 'sam@team.test', 'invited']]);

  assert.strictEqual((await invite('Sam Again', 'sam@team.test')).status, 409);                     // already invited
  assert.strictEqual((await invite('Boss', 'other@team.test')).status, 409);                         // already has a Gatepass account
  assert.strictEqual((await invite('', 'x@team.test')).status, 400);
  assert.strictEqual((await invite('No Email', 'not-an-email')).status, 400);
  assert.strictEqual((await t.api('/api/auth/register', { name: 'Sam', email: 'sam@team.test', password: 'password123' })).status, 409);   // cannot sign up separately while invited

  const info = await t.api(`/api/auth/join-info?token=${encodeURIComponent(token)}`);
  assert.deepStrictEqual(info.body, { name: 'Sam Scanner', email: 'sam@team.test', ownerName: 'Org org@team.test' });
  assert.strictEqual((await t.api('/api/auth/join-info?token=garbage')).status, 400);
  assert.strictEqual((await t.api('/api/auth/join-info?token=' + encodeURIComponent(org))).status, 400);       // a login token is not an invitation
  assert.strictEqual((await t.api('/api/auth/join', { token, password: 'short' })).status, 400);
  assert.strictEqual((await t.api('/api/auth/join', { token, password: 'scanner-pass-1' })).status, 201);
  assert.strictEqual((await t.api('/api/auth/join', { token, password: 'scanner-pass-1' })).status, 400);       // the link works once
  assert.strictEqual((await t.api(`/api/auth/join-info?token=${encodeURIComponent(token)}`)).status, 400);

  list = (await t.api('/api/organizer/team', null, org)).body;
  assert.strictEqual(list[0].status, 'active');
  const login = await t.api('/api/auth/login', { email: 'sam@team.test', password: 'scanner-pass-1' });
  assert.deepStrictEqual([login.status, login.body.role, login.body.name], [200, 'scanner', 'Sam Scanner']);
  const me = await t.api('/api/me', null, login.body.token);
  assert.deepStrictEqual(me.body, { name: 'Sam Scanner', role: 'scanner', ownerName: 'Org org@team.test' });
  assert.strictEqual((await t.api('/api/me', null, org)).body.role, 'organizer');
});

test('a team member can scan the organizer\'s tickets and nothing else', async () => {
  const sam = await addScanner('scan1@team.test');
  const mine = await t.makeEvent(org, { priceNaira: 5000 });
  const theirs = await t.makeEvent(other, { priceNaira: 5000 });
  const myTicket = (await t.api(`/api/orders/${await t.buyAndPay(mine.typeId, 1)}`)).body.tickets[0].code;
  const theirTicket = (await t.api(`/api/orders/${await t.buyAndPay(theirs.typeId, 2)}`)).body.tickets[0].code;

  assert.strictEqual((await t.api('/api/checkin', { code: myTicket }, sam)).body.result, 'valid');
  assert.strictEqual((await t.api('/api/checkin', { code: myTicket }, sam)).body.result, 'already_used');
  assert.strictEqual((await t.api('/api/checkin', { code: theirTicket }, sam)).body.result, 'wrong_event');      // another organizer's event
  assert.strictEqual((await t.api('/api/checkin', { code: myTicket.split('.')[0] + '.0000000000000000' }, sam)).body.result, 'invalid');
  assert.strictEqual((await t.api('/api/checkin', { code: myTicket })).status, 401);

  // Everything about money, orders, settings and people is closed to them.
  const closed = [
    ['GET', '/api/organizer/events'], ['GET', '/api/organizer/sales'], ['GET', `/api/organizer/events/${mine.eventId}/orders`], ['GET', `/api/organizer/events/${mine.eventId}/export.csv`],
    ['GET', `/api/organizer/events/${mine.eventId}/discounts`], ['GET', '/api/organizer/payouts'], ['GET', '/api/organizer/payout-banks'], ['GET', '/api/organizer/team'],
    ['GET', `/api/organizer/events/${mine.eventId}/audience`], ['GET', `/api/organizer/events/${mine.eventId}/messages`],
    ['POST', '/api/organizer/events'], ['POST', '/api/organizer/team'], ['POST', `/api/organizer/events/${mine.eventId}/cancel`], ['POST', `/api/organizer/events/${mine.eventId}/message`],
    ['POST', `/api/organizer/events/${mine.eventId}/archive`], ['PUT', `/api/organizer/events/${mine.eventId}`], ['PUT', '/api/organizer/payout-account'], ['DELETE', `/api/organizer/events/${mine.eventId}`],
  ];
  for (const [method, path] of closed) {
    const r = await t.api(path, method === 'GET' || method === 'DELETE' ? null : {}, sam, method);
    assert.strictEqual(r.status, 403, `${method} ${path} should be closed to team members, got ${r.status}`);
  }
  assert.strictEqual((await t.api('/api/organizer/orders/gp_x/refund', {}, sam)).status, 403);
});

test('team lists are private, invitations can be sent again, and removing someone ends their access', async () => {
  const inv = await invite('Pending Pat', 'pat@team.test');
  const id = (await t.api('/api/organizer/team', null, org)).body.find((m) => m.email === 'pat@team.test').id;
  assert.strictEqual((await t.api('/api/organizer/team', null, other)).body.length, 0);             // the other organizer sees nothing of ours
  assert.strictEqual((await t.api(`/api/organizer/team/${id}/resend`, {}, other)).status, 404);
  assert.strictEqual((await t.api(`/api/organizer/team/${id}`, null, other, 'DELETE')).status, 404);
  const again = await t.api(`/api/organizer/team/${id}/resend`, {}, org);
  assert.strictEqual(again.status, 200);
  assert.match(again.body.inviteUrl, /join\.html/);
  assert.strictEqual((await t.api('/api/auth/join', { token: tokenOf(again.body.inviteUrl), password: 'pat-password-1' })).status, 201);
  assert.strictEqual((await t.api(`/api/organizer/team/${id}/resend`, {}, org)).status, 404);          // already accepted, nothing to resend

  const pat = (await t.api('/api/auth/login', { email: 'pat@team.test', password: 'pat-password-1' })).body.token;
  assert.strictEqual((await t.api('/api/me', null, pat)).status, 200);
  assert.strictEqual((await t.api(`/api/organizer/team/${id}`, null, org, 'DELETE')).status, 200);
  assert.strictEqual((await t.api('/api/me', null, pat)).status, 401);                               // their login stopped working at once
  assert.strictEqual((await t.api('/api/auth/login', { email: 'pat@team.test', password: 'pat-password-1' })).status, 401);
  assert.strictEqual((await t.api('/api/organizer/team', null, org)).body.some((m) => m.email === 'pat@team.test'), false);
  assert.strictEqual((await invite('Pat Again', 'pat@team.test')).status, 201);                      // the address can be invited again later
});

test('a team can have at most 20 members', async () => {
  const boss = await t.register('boss20@team.test');
  for (let i = 0; i < 20; i++) assert.strictEqual((await invite('Member ' + i, `m${i}@big.test`, boss)).status, 201);
  const extra = await invite('One Too Many', 'm20@big.test', boss);
  assert.strictEqual(extra.status, 400);
  assert.match(extra.body.error, /up to 20/);
});
