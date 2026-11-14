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
  global.fetch = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: reply.ok, status: reply.status, json: async () => reply.body }; };
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
  assert.ok(calls[0].body.htmlContent.includes('₦5,000'));
});

test('a rejected email raises a clear error', async () => {
  reply = { ok: false, status: 400, body: { message: 'sender email is invalid' } };
  await assert.rejects(() => sendRefundEmail({ to: 'a@b.co', name: 'A', eventTitle: 'E', amountKobo: 100 }), /Brevo rejected the email \(HTTP 400\): sender email is invalid/);
});
