// An organizer's message to the people who hold tickets for one event.
// Safeguards: only ticket holders of that event, plain text only (no clickable links or formatting),
// replies go to the organizer, a limit on how often, a confirmation in the dashboard, and a record of every send.
const db = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const { httpError } = require('./orders');

const clean = (s, max) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const log = (err) => console.error('[message]', err.message);

// How many different people would receive a message (people with several orders count once).
async function audienceCounts(eventId) {
  const total = (await db.query("SELECT COUNT(DISTINCT o.buyer_email) AS n FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id WHERE t.event_id = $1 AND o.status = 'paid'", [eventId])).rows[0].n;
  const byType = (await db.query(
    `SELECT t.id, t.name, COUNT(DISTINCT o.buyer_email) AS people FROM ticket_types t
     LEFT JOIN orders o ON o.ticket_type_id = t.id AND o.status = 'paid' WHERE t.event_id = $1 GROUP BY t.id, t.name ORDER BY t.price_kobo, t.id`, [eventId])).rows;
  return { total, byType };
}

const recipients = async (eventId, ticketTypeId) => (await db.query(
  `SELECT DISTINCT ON (o.buyer_email) o.buyer_email, o.buyer_name, o.reference
   FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id
   WHERE t.event_id = $1 AND o.status = 'paid' ${ticketTypeId ? 'AND t.id = $2' : ''} ORDER BY o.buyer_email, o.paid_at DESC`,
  ticketTypeId ? [eventId, ticketTypeId] : [eventId])).rows;

async function history(eventId) {
  return (await db.query(
    `SELECT m.id, m.subject, m.recipient_count, m.sent_count, m.failed_count, m.status, m.created_at, t.name AS ticket_name
     FROM event_messages m LEFT JOIN ticket_types t ON t.id = m.ticket_type_id WHERE m.event_id = $1 ORDER BY m.id DESC LIMIT 10`, [eventId])).rows;
}

async function sendMessage({ eventId, organizer, subject, body, ticketTypeId, testOnly }) {
  subject = clean(subject, 120).replace(/\s*\n\s*/g, ' ');
  body = clean(body, 2000);
  if (!subject || !body) throw httpError(400, 'Write a subject and a message.');
  const event = (await db.query('SELECT title FROM events WHERE id = $1', [eventId])).rows[0];
  if (ticketTypeId && !(await db.query('SELECT 1 FROM ticket_types WHERE id = $1 AND event_id = $2', [ticketTypeId, eventId])).rows.length) throw httpError(400, 'Choose one of this event\'s ticket types.');
  const base = { organizerName: organizer.name, organizerEmail: organizer.email, eventTitle: event.title };

  if (testOnly) {                                                  // a preview, sent only to the organizer
    await mailer.sendBroadcastEmail({ to: organizer.email, name: organizer.name, subject: `[Test] ${subject}`, body, ticketUrl: null, ...base });
    return { test: true };
  }
  const people = await recipients(eventId, ticketTypeId || null);
  if (!people.length) throw httpError(400, 'Nobody has a ticket for that selection yet.');
  if ((await db.query("SELECT 1 FROM event_messages WHERE event_id = $1 AND subject = $2 AND body = $3 AND created_at > NOW() - INTERVAL '10 minutes'", [eventId, subject, body])).rows.length) throw httpError(409, 'You just sent this exact message. Wait a few minutes before sending it again.');
  if ((await db.query("SELECT COUNT(*) AS n FROM event_messages WHERE event_id = $1 AND created_at > NOW() - INTERVAL '24 hours'", [eventId])).rows[0].n >= 10) throw httpError(429, 'You can send up to 10 messages per event per day.');
  const row = (await db.query('INSERT INTO event_messages (event_id, user_id, ticket_type_id, subject, body, recipient_count) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [eventId, organizer.id, ticketTypeId || null, subject, body, people.length])).rows[0];

  // Send in the background so the dashboard does not wait; the history shows the progress.
  (async () => {
    let sent = 0, failed = 0;
    for (const p of people) {
      try { await mailer.sendBroadcastEmail({ to: p.buyer_email, name: p.buyer_name, subject, body, ticketUrl: `${config.baseUrl}/ticket.html?reference=${encodeURIComponent(p.reference)}`, ...base }); sent++; }
      catch (err) { failed++; log(err); }
      if ((sent + failed) % 10 === 0) await db.query('UPDATE event_messages SET sent_count = $2, failed_count = $3 WHERE id = $1', [row.id, sent, failed]);
    }
    await db.query("UPDATE event_messages SET sent_count = $2, failed_count = $3, status = 'done', finished_at = NOW() WHERE id = $1", [row.id, sent, failed]);
  })().catch(log);
  return { id: row.id, recipients: people.length };
}

// A restart in the middle of a send leaves it marked "sending"; after 30 minutes it is shown as interrupted.
async function interruptStale() {
  await db.query("UPDATE event_messages SET status = 'interrupted', finished_at = NOW() WHERE status = 'sending' AND created_at < NOW() - INTERVAL '30 minutes'");
}

module.exports = { audienceCounts, history, sendMessage, interruptStale };
