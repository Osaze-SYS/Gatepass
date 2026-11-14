const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const payments = require('./payments');
const { breakdown } = require('./fees');
const { newTicket, signCode } = require('./tickets');
const { sendTicketEmail, sendRefundEmail, sendRefundRequestEmail, sendRefundDeclinedEmail } = require('./mailer');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Stock reservation. This one conditional UPDATE is what prevents overselling:
// it only succeeds if enough tickets remain, and the check and the increment
// happen atomically inside PostgreSQL (the row is locked while it runs).
// ---------------------------------------------------------------------------
const RESERVE = 'UPDATE ticket_types SET sold = sold + $1 WHERE id = $2 AND sold + $1 <= capacity RETURNING id';

// Gives back stock held by unpaid orders whose reservation window has passed.
async function expirePendingOrders() {
  await db.tx(async (q) => {
    // Flipping the status and reading the rows is one statement, so a payment that
    // lands at the same moment cannot be undone by accident.
    const stale = await q("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW() RETURNING ticket_type_id, quantity");
    for (const o of stale.rows) await q('UPDATE ticket_types SET sold = sold - $1 WHERE id = $2', [o.quantity, o.ticket_type_id]);
  });
}

// Creates a pending order and holds the tickets. Throws a 409 when sold out.
async function createOrder({ ticketTypeId, quantity, buyerName, buyerEmail }) {
  return db.tx(async (q) => {
    const type = (await q('SELECT id, price_kobo FROM ticket_types WHERE id = $1', [ticketTypeId])).rows[0];
    if (!type) throw httpError(404, 'That ticket type does not exist.');
    if (!(await q(RESERVE, [quantity, ticketTypeId])).rows.length) throw httpError(409, 'Not enough tickets left. Try a smaller quantity.');
    const b = breakdown(type.price_kobo, quantity);
    const reference = 'gp_' + crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + config.reservationMinutes * 60000);
    const inserted = await q(
      `INSERT INTO orders (reference, ticket_type_id, quantity, subtotal_kobo, fee_kobo, amount_kobo, payout_kobo, buyer_name, buyer_email, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
      [reference, ticketTypeId, quantity, b.subtotal, b.fee, b.amount, b.payout, buyerName, buyerEmail, expiresAt]
    );
    return inserted.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Fulfilment. Safe to call many times for the same reference (webhooks are often
// delivered more than once): the row lock means only the first call issues tickets.
// ---------------------------------------------------------------------------
async function issueTickets(reference, paidKobo) {
  return db.tx(async (q) => {
    const order = (await q('SELECT * FROM orders WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!order) return { state: 'unknown' };
    if (order.status === 'paid') return { state: 'already_paid', order };
    if (['refunded', 'refund_pending', 'refund_due'].includes(order.status)) return { state: order.status, order };
    if (paidKobo < order.amount_kobo) return { state: 'underpaid', order };

    if (order.status === 'expired') {
      // Payment arrived after the hold lapsed. Try to take the stock back.
      if (!(await q(RESERVE, [order.quantity, order.ticket_type_id])).rows.length) {
        await q("UPDATE orders SET status = 'refund_due' WHERE id = $1", [order.id]);
        return { state: 'refund_due', order };
      }
    }
    await q("UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1", [order.id]);
    for (let i = 0; i < order.quantity; i++) {
      await q('INSERT INTO tickets (id, order_id, ticket_type_id) VALUES ($1, $2, $3)', [newTicket().id, order.id, order.ticket_type_id]);
    }
    return { state: 'issued', order };
  });
}

async function fulfillOrder(reference, paidKobo) {
  const result = await issueTickets(reference, paidKobo);
  if (result.state === 'issued') {
    // Email outside the transaction: a mail failure must never undo a paid order.
    sendOrderEmail(reference).catch((err) => console.error('[mail] failed:', err.message));
  }
  return result;
}

async function sendOrderEmail(reference) {
  const { rows } = await db.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, e.title, e.venue, e.starts_at, t.name AS ticket_name
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id
     WHERE o.reference = $1`, [reference]);
  const row = rows[0];
  const tickets = (await db.query('SELECT id FROM tickets WHERE order_id = $1 ORDER BY id', [row.id])).rows.map((t) => ({ code: signCode(t.id) }));
  await sendTicketEmail({ to: row.buyer_email, name: row.buyer_name, eventTitle: row.title, venue: row.venue, startsAt: row.starts_at, ticketName: row.ticket_name, tickets,
    ticketUrl: `${config.baseUrl}/ticket.html?reference=${encodeURIComponent(reference)}` });
}

// ---------------------------------------------------------------------------
// Refunds. Three steps so money and tickets never get out of step:
//   1. lock the order, void its tickets, mark it 'refund_pending'
//   2. ask the payment provider to send the money back
//   3. on success mark it 'refunded' and return the stock; on failure undo step 1
// An order stuck in 'refund_pending' (e.g. the server crashed) can simply be retried.
// ---------------------------------------------------------------------------
async function refundOrder({ reference, initiatedBy, reason = '' }) {
  const claim = await db.tx(async (q) => {
    const order = (await q('SELECT * FROM orders WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!order) throw httpError(404, 'Order not found.');
    if (order.status === 'refunded') throw httpError(409, 'This order was already refunded.');
    if (!['paid', 'refund_pending', 'refund_due'].includes(order.status)) throw httpError(409, 'This order has not been paid, so there is nothing to refund.');
    const used = (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = $1 AND checked_in_at IS NOT NULL', [order.id])).rows[0].n;
    if (used > 0) throw httpError(409, 'Some of these tickets were already used at the gate, so the order cannot be refunded.');
    await q('UPDATE tickets SET voided_at = COALESCE(voided_at, NOW()) WHERE order_id = $1', [order.id]);
    await q("UPDATE orders SET status = 'refund_pending' WHERE id = $1", [order.id]);
    return order;
  });

  try {
    await payments.refund(reference, claim.amount_kobo);
  } catch (err) {
    console.error('[refund] provider error:', err.message);
    if (claim.status !== 'refund_pending') {
      await db.tx(async (q) => {
        await q('UPDATE tickets SET voided_at = NULL WHERE order_id = $1', [claim.id]);
        await q('UPDATE orders SET status = $2 WHERE id = $1', [claim.id, claim.status]);
      });
    }
    throw httpError(502, 'The payment provider could not process the refund. Nothing was changed. Please try again.');
  }

  await db.tx(async (q) => {
    const hadTickets = (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = $1', [claim.id])).rows[0].n > 0;
    await q("UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = $1", [claim.id]);
    if (hadTickets) await q('UPDATE ticket_types SET sold = sold - $1 WHERE id = $2', [claim.quantity, claim.ticket_type_id]);
    await q('INSERT INTO refunds (order_id, amount_kobo, initiated_by, reason) VALUES ($1, $2, $3, $4)', [claim.id, claim.amount_kobo, initiatedBy, String(reason).slice(0, 300)]);
    // Any refund, however it happened, settles a waiting request for the same order.
    await q("UPDATE refund_requests SET status = 'approved', decided_at = NOW() WHERE order_id = $1 AND status = 'pending'", [claim.id]);
  });

  sendRefundEmail({ to: claim.buyer_email, name: claim.buyer_name, amountKobo: claim.amount_kobo, eventTitle: (await db.query('SELECT e.title FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1', [claim.ticket_type_id])).rows[0].title })
    .catch((err) => console.error('[mail] failed:', err.message));
  return { amount_kobo: claim.amount_kobo };
}

// ---------------------------------------------------------------------------
// Refund requests: after the instant-refund cutoff the buyer asks, the organizer decides.
// ---------------------------------------------------------------------------
async function requestRefund({ reference, email, reason }) {
  const order = (await db.query(
    `SELECT o.id, o.status, o.buyer_name, o.buyer_email, o.quantity, o.amount_kobo, t.name AS ticket_name,
            e.title, e.starts_at, e.refund_cutoff_hours, u.email AS organizer_email, u.name AS organizer_name
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id JOIN users u ON u.id = e.organizer_id
     WHERE o.reference = $1`, [reference])).rows[0];
  if (!order || order.buyer_email !== email) throw httpError(404, 'We could not find an order with that email address.');
  if (order.status === 'refunded') throw httpError(409, 'This order was already refunded.');
  if (order.status !== 'paid') throw httpError(409, 'This order cannot be refunded.');
  if (refundWindow(order.starts_at, order.refund_cutoff_hours).open) throw httpError(409, 'You can still refund this order yourself, instantly. No request is needed.');
  if (new Date(order.starts_at) <= new Date()) throw httpError(403, 'This event has already started, so refunds are closed. Please contact the organizer directly.');
  const used = (await db.query('SELECT COUNT(*) AS n FROM tickets WHERE order_id = $1 AND checked_in_at IS NOT NULL', [order.id])).rows[0].n;
  if (used > 0) throw httpError(409, 'Some of these tickets were already used at the gate, so the order cannot be refunded.');
  const made = await db.query('INSERT INTO refund_requests (order_id, reason) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING RETURNING id', [order.id, String(reason || '').slice(0, 300)]);
  if (!made.rows.length) throw httpError(409, 'You have already sent a refund request for this order.');
  sendRefundRequestEmail({ to: order.organizer_email, organizerName: order.organizer_name, buyerName: order.buyer_name, buyerEmail: order.buyer_email,
    eventTitle: order.title, ticketName: order.ticket_name, quantity: order.quantity, amountKobo: order.amount_kobo, reason, dashboardUrl: `${config.baseUrl}/organizer.html` })
    .catch((err) => console.error('[mail] failed:', err.message));
}

// The organizer approves (money goes back, tickets stop working) or declines (tickets stay valid).
async function decideRefundRequest({ reference, organizerId, action, note = '' }) {
  if (!['approve', 'decline'].includes(action)) throw httpError(400, 'Choose approve or decline.');
  const row = (await db.query(
    `SELECT rr.id, rr.status, o.buyer_name, o.buyer_email, e.title
     FROM refund_requests rr JOIN orders o ON o.id = rr.order_id JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id
     WHERE o.reference = $1 AND e.organizer_id = $2`, [reference, organizerId])).rows[0];
  if (!row) throw httpError(404, 'Refund request not found.');
  if (row.status !== 'pending') throw httpError(409, 'This request was already handled.');
  if (action === 'approve') {
    await refundOrder({ reference, initiatedBy: 'buyer', reason: 'Approved refund request' });   // also marks the request approved
    return { result: 'approved' };
  }
  await db.query("UPDATE refund_requests SET status = 'declined', decline_note = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending'", [row.id, String(note).slice(0, 300)]);
  sendRefundDeclinedEmail({ to: row.buyer_email, name: row.buyer_name, eventTitle: row.title, note: String(note).slice(0, 300) }).catch((err) => console.error('[mail] failed:', err.message));
  return { result: 'declined' };
}

// Buyers can refund themselves until `cutoff hours` before the event starts.
function refundWindow(startsAt, cutoffHours) {
  const closesAt = new Date(new Date(startsAt).getTime() - cutoffHours * 3600 * 1000);
  return { open: Date.now() < closesAt.getTime(), closesAt };
}

module.exports = { createOrder, expirePendingOrders, fulfillOrder, refundOrder, requestRefund, decideRefundRequest, refundWindow, httpError };
