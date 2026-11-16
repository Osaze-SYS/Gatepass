const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const payments = require('./payments');
const { breakdown } = require('./fees');
const { newTicket, signCode } = require('./tickets');
const { sendTicketEmail, sendRefundEmail, sendRefundRequestEmail, sendRefundDeclinedEmail, sendSaleEmail, sendRefundOrganizerEmail, sendEventUpdateEmail } = require('./mailer');

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
    const stale = await q("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW() RETURNING ticket_type_id, quantity, discount_code_id");
    for (const o of stale.rows) {
      await q('UPDATE ticket_types SET sold = sold - $1 WHERE id = $2', [o.quantity, o.ticket_type_id]);
      if (o.discount_code_id) await q('UPDATE discount_codes SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1', [o.discount_code_id]);   // an unpaid order gives its code use back
    }
  });
}

// Creates a pending order and holds the tickets. Throws a 409 when sold out.
async function createOrder({ ticketTypeId, quantity, buyerName, buyerEmail, code }) {
  return db.tx(async (q) => {
    const type = (await q('SELECT t.id, t.price_kobo, t.event_id, e.cancelled_at FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND e.deleted_at IS NULL', [ticketTypeId])).rows[0];
    if (!type) throw httpError(404, 'That ticket is no longer available.');
    if (type.cancelled_at) throw httpError(409, 'This event was cancelled, so tickets are no longer on sale.');
    if (!(await q(RESERVE, [quantity, ticketTypeId])).rows.length) throw httpError(409, 'Not enough tickets left. Try a smaller quantity.');
    let unit = type.price_kobo, dc = null;
    if (code) {
      dc = await lookupCode(q, type.event_id, code, type.price_kobo);
      // One atomic statement claims a use, so two buyers cannot both take the last one.
      const claimed = await q(`UPDATE discount_codes SET used_count = used_count + 1
        WHERE id = $1 AND active AND (max_uses IS NULL OR used_count < max_uses) AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id`, [dc.id]);
      if (!claimed.rows.length) throw httpError(409, 'That discount code was just used up.');
      unit = discountedPrice(type.price_kobo, dc);
    }
    const b = breakdown(unit, quantity);
    const reference = 'gp_' + crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + config.reservationMinutes * 60000);
    const inserted = await q(
      `INSERT INTO orders (reference, ticket_type_id, quantity, subtotal_kobo, fee_kobo, amount_kobo, payout_kobo, buyer_name, buyer_email, status, expires_at, discount_code_id, discount_code, discount_kobo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13) RETURNING *`,
      [reference, ticketTypeId, quantity, b.subtotal, b.fee, b.amount, b.payout, buyerName, buyerEmail, expiresAt, dc ? dc.id : null, dc ? dc.code : '', (type.price_kobo - unit) * quantity]
    );
    return inserted.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Discount codes. A code takes a percentage, or a fixed amount, off every ticket in an order.
// The platform fee is worked out on the discounted price, so the organizer carries the discount.
// ---------------------------------------------------------------------------
const normalizeCode = (raw) => String(raw ?? '').trim().toUpperCase();
const discountedPrice = (priceKobo, dc) => (dc.kind === 'percent' ? Math.round((priceKobo * (100 - dc.value)) / 100) : Math.max(0, priceKobo - dc.value));

// Finds a code for this event and explains clearly why it cannot be used. `q` is a query function (inside a transaction or not).
async function lookupCode(q, eventId, rawCode, priceKobo) {
  const dc = (await q('SELECT * FROM discount_codes WHERE event_id = $1 AND code = $2', [eventId, normalizeCode(rawCode)])).rows[0];
  if (!dc || !dc.active) throw httpError(400, 'That discount code is not valid for this event.');
  if (dc.expires_at && new Date(dc.expires_at) <= new Date()) throw httpError(400, 'That discount code has expired.');
  if (dc.max_uses !== null && dc.used_count >= dc.max_uses) throw httpError(400, 'That discount code has been fully used.');
  if (priceKobo === 0) throw httpError(400, 'This ticket is already free, so a discount code does not apply.');
  return dc;
}

// What an order would cost, without holding any tickets. Used to show the buyer the new total.
async function quoteOrder({ ticketTypeId, quantity, code }) {
  const type = (await db.query('SELECT t.id, t.price_kobo, t.event_id, e.cancelled_at FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND e.deleted_at IS NULL', [ticketTypeId])).rows[0];
  if (!type) throw httpError(404, 'That ticket is no longer available.');
  let unit = type.price_kobo, applied = null;
  if (code) {
    const dc = await lookupCode((text, params) => db.query(text, params), type.event_id, code, type.price_kobo);
    unit = discountedPrice(type.price_kobo, dc);
    applied = { code: dc.code, kind: dc.kind, value: dc.value };
  }
  const b = breakdown(unit, quantity);
  return { unit_kobo: unit, discount_kobo: (type.price_kobo - unit) * quantity, subtotal_kobo: b.subtotal, fee_kobo: b.fee, amount_kobo: b.amount, code: applied };
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

    const cancelled = (await q('SELECT e.cancelled_at FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1', [order.ticket_type_id])).rows[0].cancelled_at;
    if (cancelled) {
      // The event was cancelled before this payment arrived: no tickets, and the money is owed back.
      if (order.status === 'pending') {
        await q('UPDATE ticket_types SET sold = sold - $1 WHERE id = $2', [order.quantity, order.ticket_type_id]);
        if (order.discount_code_id) await q('UPDATE discount_codes SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1', [order.discount_code_id]);
      }
      await q("UPDATE orders SET status = 'refund_due' WHERE id = $1", [order.id]);
      return { state: 'refund_due', order };
    }

    if (order.status === 'expired') {
      // Payment arrived after the hold lapsed. Try to take the stock back.
      if (!(await q(RESERVE, [order.quantity, order.ticket_type_id])).rows.length) {
        await q("UPDATE orders SET status = 'refund_due' WHERE id = $1", [order.id]);
        return { state: 'refund_due', order };
      }
      if (order.discount_code_id) await q('UPDATE discount_codes SET used_count = used_count + 1 WHERE id = $1', [order.discount_code_id]);
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
    notifyOrganizerOfSale(reference).catch((err) => console.error('[mail] failed:', err.message));
  }
  return result;
}

async function sendOrderEmail(reference) {
  const { rows } = await db.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, e.id AS event_id, e.title, e.venue, e.starts_at, t.name AS ticket_name
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id
     WHERE o.reference = $1`, [reference]);
  const row = rows[0];
  const tickets = (await db.query('SELECT id FROM tickets WHERE order_id = $1 ORDER BY id', [row.id])).rows.map((t) => ({ code: signCode(t.id) }));
  await sendTicketEmail({ to: row.buyer_email, name: row.buyer_name, eventTitle: row.title, venue: row.venue, startsAt: row.starts_at, ticketName: row.ticket_name, tickets,
    ticketUrl: `${config.baseUrl}/ticket.html?reference=${encodeURIComponent(reference)}`, eventUrl: `${config.baseUrl}/event.html?id=${row.event_id}` });
}

// The organizer gets an email for every sale.
async function notifyOrganizerOfSale(reference) {
  const row = (await db.query(
    `SELECT o.buyer_name, o.buyer_email, o.quantity, o.amount_kobo, o.payout_kobo, o.discount_code, o.discount_kobo, t.name AS ticket_name, t.capacity - t.sold AS remaining,
            e.title, u.email AS organizer_email, u.name AS organizer_name
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id JOIN users u ON u.id = e.organizer_id
     WHERE o.reference = $1`, [reference])).rows[0];
  await sendSaleEmail({ to: row.organizer_email, organizerName: row.organizer_name, buyerName: row.buyer_name, buyerEmail: row.buyer_email, eventTitle: row.title,
    ticketName: row.ticket_name, quantity: row.quantity, amountKobo: row.amount_kobo, payoutKobo: row.payout_kobo, remaining: row.remaining, discountCode: row.discount_code, discountKobo: row.discount_kobo, dashboardUrl: `${config.baseUrl}/organizer.html` });
}

// After the organizer changes the date or venue, everyone holding tickets is told. Returns how many people will be emailed.
async function notifyBuyersOfEventChange(eventId) {
  const ev = (await db.query('SELECT title, venue, starts_at FROM events WHERE id = $1', [eventId])).rows[0];
  const buyers = (await db.query(
    `SELECT DISTINCT ON (o.buyer_email) o.buyer_email, o.buyer_name, o.reference
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id
     WHERE t.event_id = $1 AND o.status = 'paid' ORDER BY o.buyer_email, o.paid_at DESC`, [eventId])).rows;
  (async () => {
    for (const b of buyers) {
      try { await sendEventUpdateEmail({ to: b.buyer_email, name: b.buyer_name, eventTitle: ev.title, venue: ev.venue, startsAt: ev.starts_at, ticketUrl: `${config.baseUrl}/ticket.html?reference=${encodeURIComponent(b.reference)}` }); }
      catch (err) { console.error('[mail] failed:', err.message); }
    }
  })();
  return buyers.length;
}

// ---------------------------------------------------------------------------
// Refunds. Three steps so money and tickets never get out of step:
//   1. lock the order, void its tickets, mark it 'refund_pending'
//   2. ask the payment provider to send the money back
//   3. on success mark it 'refunded' and return the stock; on failure undo step 1
// An order stuck in 'refund_pending' (e.g. the server crashed) can simply be retried.
// ---------------------------------------------------------------------------
async function refundOrder({ reference, initiatedBy, reason = '', via }) {
  const claim = await db.tx(async (q) => {
    const order = (await q('SELECT * FROM orders WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!order) throw httpError(404, 'Order not found.');
    if (order.status === 'refunded') throw httpError(409, 'This order was already refunded.');
    if (!['paid', 'refund_pending', 'refund_due'].includes(order.status)) throw httpError(409, 'This order has not been paid, so there is nothing to refund.');
    if (order.payout_id) throw httpError(409, 'The earnings for this order were already sent to the organizer, so it can no longer be refunded here.');
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

  // Emails: the buyer always hears about it; the organizer too when the buyer's own request or instant refund triggered it.
  const ctx = (await db.query(
    `SELECT e.title, t.name AS ticket_name, u.email AS organizer_email, u.name AS organizer_name
     FROM ticket_types t JOIN events e ON e.id = t.event_id JOIN users u ON u.id = e.organizer_id WHERE t.id = $1`, [claim.ticket_type_id])).rows[0];
  const log = (err) => console.error('[mail] failed:', err.message);
  sendRefundEmail({ to: claim.buyer_email, name: claim.buyer_name, amountKobo: claim.amount_kobo, eventTitle: ctx.title, cancelled: via === 'cancellation' }).catch(log);
  if (initiatedBy === 'buyer') {
    sendRefundOrganizerEmail({ to: ctx.organizer_email, organizerName: ctx.organizer_name, buyerName: claim.buyer_name, buyerEmail: claim.buyer_email, eventTitle: ctx.title,
      ticketName: ctx.ticket_name, quantity: claim.quantity, amountKobo: claim.amount_kobo, via: via || 'instant', dashboardUrl: `${config.baseUrl}/organizer.html` }).catch(log);
  }
  return { amount_kobo: claim.amount_kobo };
}

// ---------------------------------------------------------------------------
// Refund requests: after the instant-refund cutoff the buyer asks, the organizer decides.
// ---------------------------------------------------------------------------
async function requestRefund({ reference, email, reason }) {
  const order = (await db.query(
    `SELECT o.id, o.status, o.buyer_name, o.buyer_email, o.quantity, o.amount_kobo, t.name AS ticket_name,
            e.title, e.starts_at, e.refund_cutoff_hours, e.refunds_allowed, u.email AS organizer_email, u.name AS organizer_name
     FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id JOIN users u ON u.id = e.organizer_id
     WHERE o.reference = $1`, [reference])).rows[0];
  if (!order || order.buyer_email !== email) throw httpError(404, 'We could not find an order with that email address.');
  if (order.status === 'refunded') throw httpError(409, 'This order was already refunded.');
  if (order.status !== 'paid') throw httpError(409, 'This order cannot be refunded.');
  if (!order.refunds_allowed) throw httpError(403, 'This event does not offer refunds. All sales are final.');
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
    await refundOrder({ reference, initiatedBy: 'buyer', reason: 'Approved refund request', via: 'request' });   // also marks the request approved
    return { result: 'approved' };
  }
  await db.query("UPDATE refund_requests SET status = 'declined', decline_note = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending'", [row.id, String(note).slice(0, 300)]);
  sendRefundDeclinedEmail({ to: row.buyer_email, name: row.buyer_name, eventTitle: row.title, note: String(note).slice(0, 300) }).catch((err) => console.error('[mail] failed:', err.message));
  return { result: 'declined' };
}

// ---------------------------------------------------------------------------
// Cancelling an event: sales stop, unpaid holds are released, and every order is refunded.
// It is safe to run again: orders already refunded are skipped, so a second run only finishes what is left.
// ---------------------------------------------------------------------------
async function refundCancelledOrders(eventId, { budgetMs = 25000 } = {}) {
  const started = Date.now();
  const orders = (await db.query(
    `SELECT o.reference FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id
     WHERE t.event_id = $1 AND o.status IN ('paid', 'refund_due', 'refund_pending') ORDER BY o.id`, [eventId])).rows;
  const result = { refunded: 0, failed: [], skipped: 0, remaining: 0 };
  for (const o of orders) {
    if (Date.now() - started > budgetMs) { result.remaining++; continue; }        // stop before the web request times out; the organizer can continue
    try {
      await refundOrder({ reference: o.reference, initiatedBy: 'organizer', reason: 'Event cancelled', via: 'cancellation' });
      result.refunded++;
    } catch (err) {
      if (err.status === 409) result.skipped++;      // already scanned at the gate, already paid out, or already refunded
      else result.failed.push({ reference: o.reference, error: err.message });
    }
  }
  return result;
}

async function cancelEvent({ eventId, organizerId, reason = '', budgetMs }) {
  const ev = (await db.query('SELECT id, starts_at, cancelled_at FROM events WHERE id = $1 AND organizer_id = $2 AND deleted_at IS NULL', [eventId, organizerId])).rows[0];
  if (!ev) throw httpError(404, 'Event not found.');
  if (!ev.cancelled_at) {
    if (new Date(ev.starts_at) <= new Date()) throw httpError(409, 'This event has already started, so it cannot be cancelled. You can still refund orders one by one.');
    await db.tx(async (q) => {
      await q('UPDATE events SET cancelled_at = NOW(), cancel_reason = $2 WHERE id = $1 AND cancelled_at IS NULL', [eventId, String(reason).slice(0, 300)]);
      const held = await q(`UPDATE orders o SET status = 'expired' FROM ticket_types t
        WHERE t.id = o.ticket_type_id AND t.event_id = $1 AND o.status = 'pending' RETURNING o.ticket_type_id, o.quantity, o.discount_code_id`, [eventId]);
      for (const o of held.rows) {
        await q('UPDATE ticket_types SET sold = sold - $1 WHERE id = $2', [o.quantity, o.ticket_type_id]);
        if (o.discount_code_id) await q('UPDATE discount_codes SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1', [o.discount_code_id]);
      }
    });
  }
  return { ...(await refundCancelledOrders(eventId, { budgetMs })), alreadyCancelled: Boolean(ev.cancelled_at) };
}

// Buyers can refund themselves until `cutoff hours` before the event starts.
function refundWindow(startsAt, cutoffHours) {
  const closesAt = new Date(new Date(startsAt).getTime() - cutoffHours * 3600 * 1000);
  return { open: Date.now() < closesAt.getTime(), closesAt };
}

module.exports = { createOrder, quoteOrder, normalizeCode, cancelEvent, refundCancelledOrders, expirePendingOrders, fulfillOrder, refundOrder, requestRefund, decideRefundRequest, notifyBuyersOfEventChange, refundWindow, httpError };
