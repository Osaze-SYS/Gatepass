const nodemailer = require('nodemailer');
const config = require('./config');
const { qrBuffer } = require('./tickets');

// Three ways to send, chosen from your settings:
//   brevo-api : BREVO_API_KEY is set. Sends over HTTPS, so it works on hosts that block SMTP (Render and Railway free plans).
//   smtp      : SMTP_HOST is set (Gmail app password, Brevo SMTP, any provider).
//   console   : nothing set. Emails are not sent, a short note is printed instead.
const mode = config.mail.brevoKey ? 'brevo-api' : config.mail.host ? 'smtp' : 'console';

const transport = mode === 'smtp'
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,          // 465 = SSL from the start, 587 upgrades with STARTTLS
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    })
  : nodemailer.createTransport({ jsonTransport: true });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "Gatepass <me@example.com>"  ->  { name: 'Gatepass', email: 'me@example.com' }
function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1].trim() || 'Gatepass', email: m[2].trim() } : { name: 'Gatepass', email: String(from || '').trim() };
}

// msg: { to, toName, subject, html, attachments: [{ filename, content: Buffer, cid? }] }
async function send(msg) {
  if (mode === 'brevo-api') {
    const payload = {
      sender: parseFrom(config.mail.from),
      to: [{ email: msg.to, name: msg.toName || undefined }],
      subject: msg.subject,
      htmlContent: msg.html,
    };
    // Brevo rejects an empty attachment list ("attachment is missing"), so only send the field when there is something to attach.
    if (msg.attachments && msg.attachments.length) payload.attachment = msg.attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') }));
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': config.mail.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Brevo rejected the email (HTTP ${res.status}): ${body.message || 'unknown error'}`);
    }
    return;
  }
  await transport.sendMail({ from: config.mail.from, to: msg.to, subject: msg.subject, html: msg.html, attachments: msg.attachments });
}

const money = (kobo) => (kobo === 0 ? 'Free' : '₦' + (kobo / 100).toLocaleString('en-NG'));
const button = (url, label) => `<p><a href="${esc(url)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">${esc(label)}</a></p>`;

async function sendTicketEmail({ to, name, eventTitle, venue, startsAt, ticketName, tickets, ticketUrl, eventUrl }) {
  const inline = mode !== 'brevo-api';        // inline pictures work over SMTP; the API route attaches them instead
  const attachments = [];
  for (const [i, t] of tickets.entries()) {
    attachments.push({ filename: `ticket-${i + 1}.png`, content: await qrBuffer(t.code), ...(inline ? { cid: `qr${i}` } : {}) });
  }
  const blocks = tickets.map((t, i) => inline
    ? `<p><b>Ticket ${i + 1} of ${tickets.length}</b> (${esc(ticketName)})<br><img src="cid:qr${i}" width="200" alt="QR code"></p>`
    : `<p><b>Ticket ${i + 1} of ${tickets.length}</b> (${esc(ticketName)}): the QR code is attached as ticket-${i + 1}.png</p>`).join('');
  const when = new Date(startsAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' });
  await send({
    to, toName: name,
    subject: `Your tickets for ${eventTitle}`,
    html: `<p>Hi ${esc(name)},</p><p>You're going to <b>${esc(eventTitle)}</b> at ${esc(venue)} on ${esc(when)}.</p>${ticketUrl ? button(ticketUrl, 'View your tickets online') : ''}${blocks}<p>Show each QR code at the gate. Each one works once.</p>${eventUrl ? `<p>Going with friends? Share the event: <a href="${esc(eventUrl)}">${esc(eventUrl)}</a></p>` : ''}`,
    attachments,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). ${tickets.length} ticket(s) for ${to}${ticketUrl ? ': ' + ticketUrl : ''}`);
}

async function sendRefundEmail({ to, name, eventTitle, amountKobo }) {
  const amount = amountKobo === 0 ? 'nothing (free order)' : '₦' + (amountKobo / 100).toLocaleString('en-NG');
  await send({
    to, toName: name,
    subject: `Your refund for ${eventTitle}`,
    html: `<p>Hi ${esc(name)},</p><p>We have refunded <b>${esc(amount)}</b> for your order for <b>${esc(eventTitle)}</b>. Your tickets are no longer valid. Banks can take a few days to show the money.</p>`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Refund notice for ${to}`);
}

async function sendRefundRequestEmail({ to, organizerName, buyerName, buyerEmail, eventTitle, ticketName, quantity, amountKobo, reason, dashboardUrl }) {
  await send({
    to, toName: organizerName,
    subject: `Refund request for ${eventTitle}`,
    html: `<p>Hi ${esc(organizerName)},</p><p><b>${esc(buyerName)}</b> (${esc(buyerEmail)}) asked for a refund of <b>${esc('₦' + (amountKobo / 100).toLocaleString('en-NG'))}</b> for ${esc(quantity)} × ${esc(ticketName)} to <b>${esc(eventTitle)}</b>. The instant-refund period has ended, so the decision is yours.</p>
      <p>Their reason: ${esc(reason || 'No reason given')}</p>${button(dashboardUrl, 'Review the request')}`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Refund request for ${eventTitle} from ${buyerEmail}`);
}

async function sendRefundDeclinedEmail({ to, name, eventTitle, note }) {
  await send({
    to, toName: name,
    subject: `About your refund request for ${eventTitle}`,
    html: `<p>Hi ${esc(name)},</p><p>The organizer of <b>${esc(eventTitle)}</b> could not approve your refund request, so your tickets are still valid.</p>${note ? `<p>Their note: ${esc(note)}</p>` : ''}<p>If you have questions, please contact the organizer directly.</p>`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Declined refund notice for ${to}`);
}

async function sendVerificationEmail({ to, name, url }) {
  await send({
    to, toName: name,
    subject: 'Confirm your email for Gatepass',
    html: `<p>Hi ${esc(name)},</p><p>Welcome to Gatepass! Please confirm your email address to activate your organizer account.</p>${button(url, 'Confirm my email')}<p>This link works for 48 hours. If you did not create an account, you can ignore this email.</p>`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Confirmation link for ${to}: ${url}`);
}

async function sendSaleEmail({ to, organizerName, buyerName, buyerEmail, eventTitle, ticketName, quantity, amountKobo, payoutKobo, remaining, dashboardUrl }) {
  await send({
    to, toName: organizerName,
    subject: `New sale: ${quantity} × ${ticketName} for ${eventTitle}`,
    html: `<p>Hi ${esc(organizerName)},</p><p><b>${esc(buyerName)}</b> (${esc(buyerEmail)}) just bought <b>${esc(quantity)} × ${esc(ticketName)}</b> for <b>${esc(eventTitle)}</b>.</p>
      <p>Paid: ${esc(money(amountKobo))}<br>You earn: ${esc(money(payoutKobo))}<br>Tickets left in this type: ${esc(remaining)}</p>${button(dashboardUrl, 'View your orders')}`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Sale notice for ${eventTitle} from ${buyerEmail}`);
}

async function sendRefundOrganizerEmail({ to, organizerName, buyerName, buyerEmail, eventTitle, ticketName, quantity, amountKobo, via, dashboardUrl }) {
  const how = via === 'request' ? 'You approved the refund request from' : 'A refund was granted automatically (instant refund period) to';
  await send({
    to, toName: organizerName,
    subject: `Refund granted for ${eventTitle}`,
    html: `<p>Hi ${esc(organizerName)},</p><p>${esc(how)} <b>${esc(buyerName)}</b> (${esc(buyerEmail)}): <b>${esc(money(amountKobo))}</b> for ${esc(quantity)} × ${esc(ticketName)} to <b>${esc(eventTitle)}</b>. Their tickets no longer work and the places are back on sale.</p>${button(dashboardUrl, 'View your orders')}`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Refund notice to organizer for ${eventTitle}`);
}

async function sendEventUpdateEmail({ to, name, eventTitle, venue, startsAt, ticketUrl }) {
  const when = new Date(startsAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' });
  await send({
    to, toName: name,
    subject: `Update for ${eventTitle}`,
    html: `<p>Hi ${esc(name)},</p><p>The organizer updated the details of <b>${esc(eventTitle)}</b>. Here is the latest:</p><p><b>When:</b> ${esc(when)}<br><b>Where:</b> ${esc(venue)}</p><p>Your tickets are still valid.</p>${ticketUrl ? button(ticketUrl, 'View your tickets') : ''}`,
  });
  if (mode === 'console') console.log(`[mail] not sent (no email service set up). Event update for ${to}`);
}

// Used by `npm run test-email` to check your settings.
async function sendTestEmail(to) {
  await send({
    to, subject: 'Gatepass test email',
    html: '<p>It works! Gatepass can send email with your current settings.</p>',
    attachments: [{ filename: 'test.png', content: await qrBuffer('gatepass-test') }],
  });
}

module.exports = { sendTicketEmail, sendRefundEmail, sendRefundRequestEmail, sendRefundDeclinedEmail, sendVerificationEmail, sendSaleEmail, sendRefundOrganizerEmail, sendEventUpdateEmail, sendTestEmail, mode };
