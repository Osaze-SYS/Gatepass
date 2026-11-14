// Sends one test email so you can check your email settings.
// Usage:  npm run test-email -- you@example.com
const config = require('../src/config');
const { sendTestEmail, mode } = require('../src/mailer');

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Give an email address to send to, for example:\n  npm run test-email -- you@example.com');
  process.exit(1);
}
const label = { 'brevo-api': 'Brevo API (HTTPS)', smtp: `SMTP (${config.mail.host}:${config.mail.port})`, console: 'none (nothing is set up)' }[mode];
console.log(`Email method: ${label}\nFrom:         ${config.mail.from}\nTo:           ${to}\n`);
if (mode === 'console') {
  console.error('No email service is configured. Set BREVO_API_KEY (or SMTP_HOST) in your .env file, then try again.');
  process.exit(1);
}
sendTestEmail(to).then(() => {
  console.log('Sent! Check the inbox (and the spam folder) of ' + to + '.');
}).catch((err) => {
  console.error('Could not send: ' + err.message + '\n');
  const m = err.message.toLowerCase();
  if (m.includes('sender') || m.includes('unverified') || m.includes('from')) console.error('Hint: MAIL_FROM must use exactly the sender address you verified with your email service.');
  else if (m.includes('401') || m.includes('invalid login') || m.includes('authentication') || m.includes('key')) console.error('Hint: the API key or password looks wrong. Copy it again, with no spaces or quotes.');
  else if (m.includes('timeout') || m.includes('econnrefused') || m.includes('etimedout')) console.error('Hint: the connection is blocked. Some networks and free hosts block SMTP. Use BREVO_API_KEY instead, which works over HTTPS.');
  process.exit(1);
});
