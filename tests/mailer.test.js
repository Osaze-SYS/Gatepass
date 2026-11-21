// Checks the email code without sending anything: the Brevo web API call is replaced by a fake.
process.env.BREVO_API_KEY = 'test-key';
process.env.SMTP_HOST = '';
process.env.MAIL_FROM = 'Gatepass Events <tickets@example.com>';

const test = require('node:test');
const assert = require('node:assert');
const { sendTicketEmail, sendRefundEmail, mode } = require('../src/mailer');
const { newTicket } = require('../src/tickets');

let calls, reply;
test.beforeEach(() => {
  calls = []; reply = { ok: true, status: 201, body: { messageId: 'x' } };
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    // The real Brevo answers 400 "attachment is missing" when the attachment list is present but empty.
    if (Array.isArray(body.attachment) && body.attachment.length === 0) return { ok: false, status: 400, json: async () => ({ message: 'attachment is missing' }) };
    calls.push({ url, opts, body });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  };
});

test('uses the Brevo API when a key is set', () => assert.strictEqual(mode, 'brevo-api'));

test('ticket email: correct request, QR codes attached, link included, names escaped', async () => {
  await sendTicketEmail({
    to: 'ada@test.dev', name: 'Ada <script>', eventTitle: 'Tech & Night', venue: 'Hall "A"', startsAt: new Date('2027-01-20T18:00:00Z'),
    ticketName: 'VIP', tickets: [newTicket(), newTicket()], ticketUrl: 'https://gatepass.example/ticket.html?reference=gp_123',
  });
  assert.strictEqual(calls.length, 1);
  const { url, opts, body } = calls[0];
  assert.strictEqual(url, 'https://api.brevo.com/v3/smtp/email');
  assert.strictEqual(opts.headers['api-key'], 'test-key');
  assert.deepStrictEqual(body.sender, { name: 'Gatepass Events', email: 'tickets@example.com' });
  assert.strictEqual(body.to[0].email, 'ada@test.dev');
  assert.strictEqual(body.subject, 'Your tickets for Tech & Night');
  assert.strictEqual(body.attachment.length, 2);
  assert.ok(Buffer.from(body.attachment[0].content, 'base64').slice(1, 4).toString() === 'PNG', 'attachment is a PNG image');
  assert.ok(body.htmlContent.includes('https://gatepass.example/ticket.html?reference=gp_123'));
  assert.ok(!body.htmlContent.includes('<script>'), 'buyer name must be escaped');
  assert.ok(body.htmlContent.includes('Tech &amp; Night'));
});

test('refund email is sent through the same route', async () => {
  await sendRefundEmail({ to: 'ada@test.dev', name: 'Ada', eventTitle: 'Tech Night', amountKobo: 500000 });
  assert.strictEqual(calls[0].body.subject, 'Your refund for Tech Night');
  assert.ok(!('attachment' in calls[0].body), 'emails without attachments must not send an empty attachment list');
  assert.ok(calls[0].body.htmlContent.includes('₦5,000'));
});

test('a rejected email raises a clear error', async () => {
  reply = { ok: false, status: 400, body: { message: 'sender email is invalid' } };
  await assert.rejects(() => sendRefundEmail({ to: 'a@b.co', name: 'A', eventTitle: 'E', amountKobo: 100 }), /Brevo rejected the email \(HTTP 400\): sender email is invalid/);
});

test('refund request email goes to the organizer with the buyer details escaped', async () => {
  const { sendRefundRequestEmail } = require('../src/mailer');
  await sendRefundRequestEmail({ to: 'org@test.dev', organizerName: 'Org', buyerName: 'Ada <b>', buyerEmail: 'ada@test.dev', eventTitle: 'Tech Night', ticketName: 'VIP', quantity: 2, amountKobo: 800000, reason: '<img src=x>', dashboardUrl: 'https://gatepass.example/organizer.html' });
  const { body } = calls[0];
  assert.strictEqual(body.to[0].email, 'org@test.dev');
  assert.strictEqual(body.subject, 'Refund request for Tech Night');
  assert.ok(body.htmlContent.includes('₦8,000') && body.htmlContent.includes('https://gatepass.example/organizer.html'));
  assert.ok(!body.htmlContent.includes('<img src=x>') && !body.htmlContent.includes('Ada <b>'), 'user text must be escaped');
});

test('declined email tells the buyer their tickets are still valid', async () => {
  const { sendRefundDeclinedEmail } = require('../src/mailer');
  await sendRefundDeclinedEmail({ to: 'ada@test.dev', name: 'Ada', eventTitle: 'Tech Night', note: 'Please transfer the ticket' });
  assert.strictEqual(calls[0].body.subject, 'About your refund request for Tech Night');
  assert.ok(calls[0].body.htmlContent.includes('still valid') && calls[0].body.htmlContent.includes('Please transfer the ticket'));
});

test('refund email for a cancelled event says so', async () => {
  await sendRefundEmail({ to: 'ada@test.dev', name: 'Ada', eventTitle: 'Tech Night', amountKobo: 500000, cancelled: true });
  assert.strictEqual(calls[0].body.subject, 'Tech Night was cancelled: your refund');
  assert.ok(calls[0].body.htmlContent.includes('cancelled') && calls[0].body.htmlContent.includes('₦5,000'));
});

test('payout emails: sent and failed', async () => {
  const { sendPayoutEmail } = require('../src/mailer');
  await sendPayoutEmail({ to: 'org@test.dev', name: 'Org', eventTitle: 'Tech Night', amountKobo: 1000000, accountLabel: 'GTBank ••••6789', ok: true, dashboardUrl: 'https://gatepass.example/organizer.html' });
  assert.strictEqual(calls[0].body.subject, 'Your payout for Tech Night is on its way');
  assert.ok(calls[0].body.htmlContent.includes('₦10,000') && calls[0].body.htmlContent.includes('GTBank ••••6789'));
  await sendPayoutEmail({ to: 'org@test.dev', name: 'Org', eventTitle: 'Tech <b>Night</b>', amountKobo: 1000000, accountLabel: 'GTBank ••••6789', ok: false, reason: 'Recipient <invalid>', dashboardUrl: 'https://gatepass.example/organizer.html' });
  assert.strictEqual(calls[1].body.subject, 'We could not send your payout for Tech <b>Night</b>');
  assert.ok(calls[1].body.htmlContent.includes('Recipient &lt;invalid&gt;') && calls[1].body.htmlContent.includes('Retry'));
});

test('messages to ticket holders carry the organizer as reply-to; invitations explain what a team member can do', async () => {
  const { sendBroadcastEmail, sendTeamInviteEmail } = require('../src/mailer');
  await sendBroadcastEmail({ to: 'guest@test.dev', name: 'Gina <b>', subject: 'Doors open', body: 'Line one\nLine <i>two</i>', organizerName: 'Ada Okafor', organizerEmail: 'ada@test.dev', eventTitle: 'Tech Night', ticketUrl: 'https://gatepass.example/ticket.html?reference=gp_1' });
  const m = calls[0].body;
  assert.deepStrictEqual(m.replyTo, { email: 'ada@test.dev', name: 'Ada Okafor' });
  assert.ok(m.htmlContent.includes('Line one<br>Line &lt;i&gt;two&lt;/i&gt;') && m.htmlContent.includes('Gina &lt;b&gt;') && m.htmlContent.includes('ticket.html?reference=gp_1') && m.htmlContent.includes('Reply to this email to reach them'));
  await sendTeamInviteEmail({ to: 'sam@test.dev', name: 'Sam', ownerName: 'Ada <Okafor>', url: 'https://gatepass.example/join.html?token=abc' });
  const inv = calls[1].body;
  assert.strictEqual(inv.subject, 'Ada <Okafor> invited you to scan tickets on Gatepass');
  assert.ok(inv.htmlContent.includes('Ada &lt;Okafor&gt;') && inv.htmlContent.includes('will not see earnings') && inv.htmlContent.includes('join.html?token=abc'));
  assert.ok(!('replyTo' in inv), 'emails that are not from an organizer have no reply-to');
});
