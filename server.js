const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./src/config');
const db = require('./src/db');
const payments = require('./src/payments');
const { hashPassword, verifyPassword, issueToken, readToken, requireAuth } = require('./src/auth');
const mailer = require('./src/mailer');
const { signCode, parseCode, qrDataUrl } = require('./src/tickets');
const { createOrder, expirePendingOrders, fulfillOrder, refundOrder, requestRefund, decideRefundRequest, notifyBuyersOfEventChange, refundWindow, httpError } = require('./src/orders');
const { buyerFeePerTicket } = require('./src/fees');
const { parseImage } = require('./src/images');
const { makeLimiters } = require('./src/ratelimit');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = ['Music', 'Tech', 'Business', 'Faith', 'Sports', 'Education', 'Food & Drink', 'Arts', 'Community', 'Other'];
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw httpError(404, 'Not found.'); return n; };

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const verifyUrl = (userId) => `${config.baseUrl}/verify.html?token=${encodeURIComponent(issueToken(userId, false, 'v', 2 * 864e5))}`;

// Shared by "create event" and "edit event": reads and checks everything the organizer typed.
function parseEventBody(body) {
  const title = str(body.title, 120), venue = str(body.venue, 160), description = str(body.description, 3000);
  const category = CATEGORIES.includes(body.category) ? body.category : 'Other';
  const refundsAllowed = !(body.refundsAllowed === false || body.refundsAllowed === 'false');
  const cutoff = body.refundCutoffHours === undefined || body.refundCutoffHours === '' ? 48 : Number(body.refundCutoffHours);
  const startsAt = new Date(body.startsAt);
  const types = Array.isArray(body.ticketTypes) ? body.ticketTypes : [];
  if (!title || !venue || isNaN(startsAt)) throw httpError(400, 'Enter a title, venue and a valid date and time.');
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 720) throw httpError(400, 'Refund cutoff must be between 0 and 720 hours.');
  if (!types.length || types.length > 8) throw httpError(400, 'Add between 1 and 8 ticket types.');
  const clean = types.map((t) => ({ id: t.id === undefined || t.id === null ? null : Number(t.id), name: str(t.name, 60), price: Math.round(Number(t.priceNaira) * 100), capacity: Number(t.capacity) }));
  if (clean.some((t) => (t.id !== null && !Number.isInteger(t.id)) || !t.name || !(t.price >= 0) || t.price > 2000000000 || !Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > 1000000)) throw httpError(400, 'Each ticket type needs a name, a price (0 or more) and a whole-number capacity.');
  return { title, venue, description, category, refundsAllowed, cutoff, startsAt, types: clean };
}

const COVER = '(SELECT i.id FROM event_images i WHERE i.event_id = e.id ORDER BY i.position, i.id LIMIT 1)';

function createApp(opts = {}) {
  const app = express();
  const limit = makeLimiters(opts.limits);
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });
  app.use('/api/organizer', express.json({ limit: '3mb' }));      // organizer routes carry picture uploads
  // Keep the raw body: Paystack's webhook signature is computed over the exact bytes sent.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api', limit.api);
  // Event pages get the event's own title, text and picture in their <head>, so a shared link shows a proper preview in WhatsApp, Facebook and so on.
  const eventPage = fs.readFileSync(path.join(__dirname, 'public', 'event.html'), 'utf8');
  app.get('/event.html', wrap(async (req, res) => {
    let html = eventPage;
    const id = Number(req.query.id);
    if (Number.isInteger(id) && id > 0 && id <= 2147483647) {
      const ev = (await db.query(`SELECT e.title, e.description, e.venue, e.starts_at, ${COVER} AS cover FROM events e WHERE e.id = $1 AND e.deleted_at IS NULL`, [id])).rows[0];
      if (ev) {
        const when = new Date(ev.starts_at).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' });
        const text = `${when} · ${ev.venue}. ${ev.description || 'Get your tickets on Gatepass.'}`.replace(/\s+/g, ' ').slice(0, 200);
        const tags = [['og:type', 'website'], ['og:site_name', 'Gatepass'], ['og:title', ev.title], ['og:description', text], ['og:url', `${config.baseUrl}/event.html?id=${id}`],
          ...(ev.cover ? [['og:image', `${config.baseUrl}/api/images/${ev.cover}`]] : []), ['twitter:card', ev.cover ? 'summary_large_image' : 'summary']]
          .map(([k, v]) => `<meta property="${k}" content="${escHtml(v)}">`).join('') + `<meta name="description" content="${escHtml(text)}">`;
        html = html.replace('<title>Event · Gatepass</title>', `<title>${escHtml(ev.title)} · Gatepass</title>`).replace('</head>', tags + '</head>');
      }
    }
    res.type('html').send(html);
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  const ownEvent = async (eventId, userId) => {
    const row = (await db.query('SELECT id FROM events WHERE id = $1 AND organizer_id = $2 AND deleted_at IS NULL', [intId(eventId), userId])).rows[0];
    if (!row) throw httpError(404, 'Event not found.');
    return row.id;
  };

  app.get('/api/meta', (_req, res) => res.json({
    categories: CATEGORIES, feePercent: config.feePercent, feePayer: config.feePayer, paymentsLive: payments.live,
    maxImages: config.maxImagesPerEvent,
  }));

  // ---------------- Accounts ----------------
  // With an email service set up, new accounts must confirm their email before they can log in.
  // Without one (local testing) there is no way to send the link, so accounts are active straight away.
  app.post('/api/auth/register', limit.auth, wrap(async (req, res) => {
    const name = str(req.body.name, 80), email = str(req.body.email).toLowerCase(), password = str(req.body.password, 200);
    if (!name || !EMAIL.test(email) || password.length < 8) throw httpError(400, 'Enter your name, a valid email and a password of at least 8 characters.');
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length) throw httpError(409, 'An account with this email already exists. Try logging in.');
    const needsConfirm = mailer.mode !== 'console';
    const { rows } = await db.query('INSERT INTO users (name, email, password_hash, email_verified) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hashPassword(password), !needsConfirm]);
    const userId = rows[0].id;
    if (!needsConfirm) return res.status(201).json({ token: issueToken(userId, false), name });
    try {
      await mailer.sendVerificationEmail({ to: email, name, url: verifyUrl(userId) });
    } catch (err) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);       // do not leave an account nobody can confirm
      console.error('[mail] failed:', err.message);
      throw httpError(502, 'We could not send the confirmation email. Check the address and try again.');
    }
    res.status(201).json({ needsVerification: true, email });
  }));

  app.post('/api/auth/login', limit.auth, wrap(async (req, res) => {
    const user = (await db.query('SELECT * FROM users WHERE email = $1', [str(req.body.email).toLowerCase()])).rows[0];
    if (!user || !verifyPassword(str(req.body.password, 200), user.password_hash)) throw httpError(401, 'Email or password is incorrect.');
    if (!user.email_verified) return res.status(403).json({ error: 'Please confirm your email first. We sent you a link when you signed up.', needsVerification: true, email: user.email });
    res.json({ token: issueToken(user.id, req.body.remember === true), name: user.name });   // "remember me" = 30 days, otherwise 1 day
  }));

  // Always answers the same way, so nobody can use this to find out which emails have accounts.
  app.post('/api/auth/resend', limit.auth, wrap(async (req, res) => {
    const user = (await db.query('SELECT id, name, email, email_verified FROM users WHERE email = $1', [str(req.body.email).toLowerCase()])).rows[0];
    if (user && !user.email_verified && mailer.mode !== 'console') {
      try { await mailer.sendVerificationEmail({ to: user.email, name: user.name, url: verifyUrl(user.id) }); } catch (err) { console.error('[mail] failed:', err.message); }
    }
    res.json({ ok: true });
  }));

  app.post('/api/auth/verify', limit.auth, wrap(async (req, res) => {
    const data = readToken(str(req.body.token, 800), 'v');
    if (!data) throw httpError(400, 'This link is invalid or has expired. Log in to get a new confirmation email.');
    await db.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [data.uid]);
    res.json({ ok: true });
  }));

  // ---------------- Browse and search ----------------
  // Filters: q (text), category, when (week|month), price (free|paid), sort (date|price|newest)
  app.get('/api/events', wrap(async (req, res) => {
    const where = ["e.starts_at >= NOW() - INTERVAL '1 day'", 'e.deleted_at IS NULL'], having = [], params = [];
    const add = (v) => { params.push(v); return '$' + params.length; };
    const q = str(req.query.q, 80);
    if (q) {
      const p = add(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(e.title ILIKE ${p} OR e.venue ILIKE ${p} OR e.description ILIKE ${p} OR e.category ILIKE ${p})`);
    }
    if (CATEGORIES.includes(req.query.category)) where.push(`e.category = ${add(req.query.category)}`);
    if (req.query.when === 'week') where.push("e.starts_at < NOW() + INTERVAL '7 days'");
    if (req.query.when === 'month') where.push("e.starts_at < NOW() + INTERVAL '30 days'");
    if (req.query.price === 'free') having.push('MIN(t.price_kobo) = 0');
    if (req.query.price === 'paid') having.push('MAX(t.price_kobo) > 0');
    const order = { price: 'from_kobo, e.starts_at', newest: 'e.created_at DESC' }[req.query.sort] || 'e.starts_at';
    const { rows } = await db.query(
      `SELECT e.id, e.title, e.venue, e.category, e.starts_at,
              MIN(t.price_kobo) AS from_kobo, SUM(t.capacity - t.sold) AS remaining, ${COVER} AS cover_image_id
       FROM events e JOIN ticket_types t ON t.event_id = e.id
       WHERE ${where.join(' AND ')} GROUP BY e.id
       ${having.length ? 'HAVING ' + having.join(' AND ') : ''}
       ORDER BY ${order}, e.id LIMIT 60`, params);
    res.json(rows);
  }));

  app.get('/api/events/:id', wrap(async (req, res) => {
    await expirePendingOrders();
    const id = intId(req.params.id);
    const event = (await db.query('SELECT id, title, description, venue, category, starts_at, refund_cutoff_hours, refunds_allowed FROM events WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!event) throw httpError(404, 'Event not found.');
    const types = (await db.query('SELECT id, name, price_kobo, capacity - sold AS remaining FROM ticket_types WHERE event_id = $1 ORDER BY price_kobo, id', [id])).rows;
    event.ticketTypes = types.map((t) => ({ ...t, fee_kobo: buyerFeePerTicket(t.price_kobo) }));
    event.images = (await db.query('SELECT id FROM event_images WHERE event_id = $1 ORDER BY position, id', [id])).rows.map((r) => r.id);
    event.feePayer = config.feePayer;
    const w = refundWindow(event.starts_at, event.refund_cutoff_hours);
    event.refundsAllowed = event.refunds_allowed;
    event.refundPolicy = { allowed: event.refunds_allowed, cutoffHours: event.refund_cutoff_hours, closesAt: w.closesAt, open: event.refunds_allowed && w.open };
    res.json(event);
  }));

  app.get('/api/images/:id', wrap(async (req, res) => {
    const img = (await db.query('SELECT mime, data FROM event_images WHERE id = $1', [intId(req.params.id)])).rows[0];
    if (!img) throw httpError(404, 'Picture not found.');
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(Buffer.from(img.data));
  }));

  // ---------------- Checkout ----------------
  app.post('/api/checkout', limit.checkout, wrap(async (req, res) => {
    await expirePendingOrders();
    const ticketTypeId = Number(req.body.ticketTypeId), quantity = Number(req.body.quantity);
    const buyerName = str(req.body.name, 80), buyerEmail = str(req.body.email).toLowerCase();
    if (!Number.isInteger(ticketTypeId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw httpError(400, 'Choose between 1 and 10 tickets.');
    if (!buyerName || !EMAIL.test(buyerEmail)) throw httpError(400, 'Enter your name and a valid email so we can send your tickets.');

    const order = await createOrder({ ticketTypeId, quantity, buyerName, buyerEmail });
    const summary = { subtotal_kobo: order.subtotal_kobo, fee_kobo: order.fee_kobo, amount_kobo: order.amount_kobo };
    if (order.amount_kobo === 0) {            // free tickets skip payment
      await fulfillOrder(order.reference, 0);
      return res.status(201).json({ reference: order.reference, url: `/ticket.html?reference=${order.reference}`, ...summary });
    }
    try {
      const { url } = await payments.initializePayment({ reference: order.reference, email: buyerEmail, amountKobo: order.amount_kobo });
      res.status(201).json({ reference: order.reference, url, ...summary });
    } catch (err) {
      // Payment provider failed: give the held tickets back immediately.
      await db.query("UPDATE orders SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [order.id]);
      await expirePendingOrders();
      throw httpError(502, 'Payment could not be started. Please try again.');
    }
  }));

  // Order page data. If Paystack's webhook could not reach us (e.g. on localhost),
  // ask Paystack directly so the buyer still gets their tickets.
  app.get('/api/orders/:reference', wrap(async (req, res) => {
    const find = async () => (await db.query('SELECT * FROM orders WHERE reference = $1', [str(req.params.reference, 60)])).rows[0];
    let order = await find();
    if (!order) throw httpError(404, 'Order not found.');
    if (order.status === 'pending' && payments.live) {
      const check = await payments.verifyPayment(order.reference);
      if (check && check.success) await fulfillOrder(order.reference, check.amountKobo);
      order = await find();
    }
    const info = (await db.query(
      `SELECT e.id AS event_id, e.title, e.venue, e.starts_at, e.refund_cutoff_hours, e.refunds_allowed, t.name AS ticket_name, ${COVER} AS cover_image_id
       FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1`, [order.ticket_type_id])).rows[0];
    const out = {
      reference: order.reference, status: order.status, quantity: order.quantity, buyer_name: order.buyer_name,
      subtotal_kobo: order.subtotal_kobo, fee_kobo: order.fee_kobo, amount_kobo: order.amount_kobo,
      ...info, cover_image_id: info.cover_image_id, tickets: [],
    };
    if (order.status === 'paid') {
      const rows = (await db.query('SELECT id, checked_in_at FROM tickets WHERE order_id = $1 AND voided_at IS NULL ORDER BY id', [order.id])).rows;
      out.tickets = await Promise.all(rows.map(async (t) => ({ code: signCode(t.id), qr: await qrDataUrl(signCode(t.id)), checkedIn: Boolean(t.checked_in_at) })));
      const w = refundWindow(info.starts_at, info.refund_cutoff_hours);
      const anyUsed = out.tickets.some((t) => t.checkedIn);
      const started = new Date(info.starts_at) <= new Date();
      const request = (await db.query('SELECT status, decline_note, created_at FROM refund_requests WHERE order_id = $1', [order.id])).rows[0] || null;
      out.refund = {
        allowed: info.refunds_allowed,
        available: info.refunds_allowed && w.open && !anyUsed, closesAt: w.closesAt, cutoffHours: info.refund_cutoff_hours,
        canRequest: info.refunds_allowed && !w.open && !anyUsed && !started && !request,      // after the cutoff the buyer can ask the organizer
        request,
        reason: !info.refunds_allowed ? 'none' : anyUsed ? 'used' : w.open ? '' : started ? 'started' : 'closed',
      };
    }
    res.json(out);
  }));

  // Buyer refunds themselves: needs the order link plus the email used at checkout,
  // and only works until the event's refund cutoff.
  app.post('/api/orders/:reference/refund', limit.refund, wrap(async (req, res) => {
    const row = (await db.query(
      `SELECT o.reference, o.buyer_email, e.starts_at, e.refund_cutoff_hours, e.refunds_allowed
       FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id WHERE o.reference = $1`,
      [str(req.params.reference, 60)])).rows[0];
    if (!row || row.buyer_email !== str(req.body.email).toLowerCase()) throw httpError(404, 'We could not find an order with that email address.');
    if (!row.refunds_allowed) throw httpError(403, 'This event does not offer refunds. All sales are final.');
    if (!refundWindow(row.starts_at, row.refund_cutoff_hours).open) throw httpError(403, `Self-service refunds closed ${row.refund_cutoff_hours} hours before the event. Please contact the organizer.`);
    const out = await refundOrder({ reference: row.reference, initiatedBy: 'buyer', reason: str(req.body.reason, 300) });
    res.json({ ok: true, ...out });
  }));

  // After the instant-refund cutoff the buyer sends a request; the organizer decides.
  app.post('/api/orders/:reference/refund-request', limit.refund, wrap(async (req, res) => {
    await requestRefund({ reference: str(req.params.reference, 60), email: str(req.body.email).toLowerCase(), reason: str(req.body.reason, 300) });
    res.status(201).json({ ok: true });
  }));

  // Paystack calls this after every payment. We trust only the signature, then
  // re-check the amount before issuing tickets.
  app.post('/api/webhooks/paystack', wrap(async (req, res) => {
    if (!payments.validWebhookSignature(req.rawBody || Buffer.alloc(0), req.get('x-paystack-signature'))) return res.sendStatus(401);
    const { event, data } = req.body;
    if (event === 'charge.success' && data && data.reference) await fulfillOrder(data.reference, data.amount);
    res.sendStatus(200);          // always acknowledge quickly so Paystack stops retrying
  }));

  // Stand-in for the payment page when no Paystack key is configured.
  app.post('/api/mock/pay', wrap(async (req, res) => {
    if (payments.live) throw httpError(404, 'Not found.');
    const order = (await db.query('SELECT reference, amount_kobo FROM orders WHERE reference = $1', [str(req.body.reference, 60)])).rows[0];
    if (!order) throw httpError(404, 'Order not found.');
    await fulfillOrder(order.reference, order.amount_kobo);
    res.json({ ok: true });
  }));

  // ---------------- Organizer ----------------
  app.post('/api/organizer/events', requireAuth, wrap(async (req, res) => {
    const p = parseEventBody(req.body);
    const id = await db.tx(async (q) => {
      const ev = await q('INSERT INTO events (organizer_id, title, description, venue, category, starts_at, refund_cutoff_hours, refunds_allowed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [req.userId, p.title, p.description, p.venue, p.category, p.startsAt, p.cutoff, p.refundsAllowed]);
      for (const t of p.types) await q('INSERT INTO ticket_types (event_id, name, price_kobo, capacity) VALUES ($1, $2, $3, $4)', [ev.rows[0].id, t.name, t.price, t.capacity]);
      return ev.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  // Edit an event. Ticket types that already exist keep their id so past orders stay linked to them.
  app.put('/api/organizer/events/:id', requireAuth, wrap(async (req, res) => {
    const id = await ownEvent(req.params.id, req.userId);
    const p = parseEventBody(req.body);
    const changed = await db.tx(async (q) => {
      const ev = (await q('SELECT venue, starts_at FROM events WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!ev) throw httpError(404, 'Event not found.');
      const existing = (await q('SELECT t.id, t.name, t.sold, (SELECT COUNT(*) FROM orders o WHERE o.ticket_type_id = t.id) AS orders FROM ticket_types t WHERE t.event_id = $1 FOR UPDATE', [id])).rows;
      const byId = new Map(existing.map((t) => [t.id, t]));
      const keep = new Set();
      for (const t of p.types) {
        if (t.id === null) continue;
        const cur = byId.get(t.id);
        if (!cur) throw httpError(400, 'One of the ticket types does not belong to this event.');
        if (t.capacity < cur.sold) throw httpError(409, `"${cur.name}": ${cur.sold} tickets are already sold or held, so the number of tickets cannot go below that.`);
        keep.add(t.id);
      }
      for (const cur of existing) {
        if (keep.has(cur.id)) continue;
        if (cur.orders > 0) throw httpError(409, `"${cur.name}" already has orders, so it cannot be removed. Lower its number of tickets to the amount already sold instead.`);
        await q('DELETE FROM ticket_types WHERE id = $1', [cur.id]);
      }
      for (const t of p.types) {
        if (t.id !== null) await q('UPDATE ticket_types SET name = $2, price_kobo = $3, capacity = $4 WHERE id = $1', [t.id, t.name, t.price, t.capacity]);
        else await q('INSERT INTO ticket_types (event_id, name, price_kobo, capacity) VALUES ($1, $2, $3, $4)', [id, t.name, t.price, t.capacity]);
      }
      await q('UPDATE events SET title = $2, venue = $3, description = $4, category = $5, starts_at = $6, refund_cutoff_hours = $7, refunds_allowed = $8 WHERE id = $1',
        [id, p.title, p.venue, p.description, p.category, p.startsAt, p.cutoff, p.refundsAllowed]);
      return new Date(ev.starts_at).getTime() !== p.startsAt.getTime() || ev.venue !== p.venue;
    });
    const notified = changed ? await notifyBuyersOfEventChange(id) : 0;      // a new date or venue is emailed to everyone holding tickets
    res.json({ ok: true, notified });
  }));

  // Delete an event. It is hidden rather than erased, so sales and refund history stay intact.
  // An upcoming event with live orders must have them refunded first.
  app.delete('/api/organizer/events/:id', requireAuth, wrap(async (req, res) => {
    const id = await ownEvent(req.params.id, req.userId);
    await expirePendingOrders();
    const n = (await db.query(
      `SELECT COUNT(*) AS n FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id
       WHERE e.id = $1 AND e.starts_at > NOW() - INTERVAL '1 day' AND o.status IN ('paid', 'pending', 'refund_due', 'refund_pending')`, [id])).rows[0].n;
    if (n > 0) throw httpError(409, `This event still has ${n} active ${n === 1 ? 'order' : 'orders'}. Refund them from Orders and refunds first, then you can delete it.`);
    await db.query('UPDATE events SET deleted_at = NOW() WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  // Pictures for an event's ticket page. The first picture is the cover.
  app.post('/api/organizer/events/:id/images', requireAuth, limit.upload, wrap(async (req, res) => {
    const eventId = await ownEvent(req.params.id, req.userId);
    const count = (await db.query('SELECT COUNT(*) AS n FROM event_images WHERE event_id = $1', [eventId])).rows[0].n;
    if (count >= config.maxImagesPerEvent) throw httpError(400, `You can add up to ${config.maxImagesPerEvent} pictures per event.`);
    const img = parseImage(req.body.image);
    if (img.error) throw httpError(400, img.error);
    const { rows } = await db.query(
      'INSERT INTO event_images (event_id, mime, data, position) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM event_images WHERE event_id = $1)) RETURNING id',
      [eventId, img.mime, img.data]);
    res.status(201).json({ id: rows[0].id });
  }));

  app.delete('/api/organizer/events/:id/images/:imageId', requireAuth, wrap(async (req, res) => {
    const eventId = await ownEvent(req.params.id, req.userId);
    await db.query('DELETE FROM event_images WHERE id = $1 AND event_id = $2', [intId(req.params.imageId), eventId]);
    res.json({ ok: true });
  }));

  app.post('/api/organizer/events/:id/images/:imageId/cover', requireAuth, wrap(async (req, res) => {
    const eventId = await ownEvent(req.params.id, req.userId);
    const { rows } = await db.query(
      'UPDATE event_images SET position = (SELECT COALESCE(MIN(position), 0) - 1 FROM event_images WHERE event_id = $1) WHERE id = $2 AND event_id = $1 RETURNING id',
      [eventId, intId(req.params.imageId)]);
    if (!rows.length) throw httpError(404, 'Picture not found.');
    res.json({ ok: true });
  }));

  app.get('/api/organizer/events', requireAuth, wrap(async (req, res) => {
    await expirePendingOrders();
    const events = (await db.query('SELECT id, title, description, venue, category, starts_at, refund_cutoff_hours, refunds_allowed FROM events WHERE organizer_id = $1 AND deleted_at IS NULL ORDER BY starts_at DESC', [req.userId])).rows;
    await Promise.all(events.map(async (e) => {
      e.ticketTypes = (await db.query(
        `SELECT t.id, t.name, t.price_kobo, t.capacity, t.sold, (SELECT COUNT(*) FROM orders o WHERE o.ticket_type_id = t.id) AS order_count,
                (SELECT COUNT(*) FROM tickets k WHERE k.ticket_type_id = t.id AND k.voided_at IS NULL) AS issued,
                (SELECT COUNT(*) FROM tickets k WHERE k.ticket_type_id = t.id AND k.voided_at IS NULL AND k.checked_in_at IS NOT NULL) AS checked_in
         FROM ticket_types t WHERE t.event_id = $1 ORDER BY t.price_kobo, t.id`, [e.id])).rows;
      e.totals = (await db.query(
        `SELECT COALESCE(SUM(o.amount_kobo) FILTER (WHERE o.status = 'paid'), 0) AS gross,
                COALESCE(SUM(o.fee_kobo) FILTER (WHERE o.status = 'paid'), 0) AS fees,
                COALESCE(SUM(o.payout_kobo) FILTER (WHERE o.status = 'paid'), 0) AS net,
                COALESCE(SUM(o.amount_kobo) FILTER (WHERE o.status = 'refunded'), 0) AS refunded,
                COUNT(*) FILTER (WHERE o.status IN ('refund_due', 'refund_pending')) AS needs_attention
         FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id WHERE t.event_id = $1`, [e.id])).rows[0];
      const waiting = (await db.query(
        `SELECT COUNT(*) AS n FROM refund_requests rr JOIN orders o ON o.id = rr.order_id JOIN ticket_types t ON t.id = o.ticket_type_id
         WHERE t.event_id = $1 AND rr.status = 'pending' AND o.status = 'paid'`, [e.id])).rows[0].n;
      e.totals.needs_attention = Number(e.totals.needs_attention) + Number(waiting);   // waiting requests also need a decision
      e.images = (await db.query('SELECT id FROM event_images WHERE event_id = $1 ORDER BY position, id', [e.id])).rows.map((r) => r.id);
    }));
    res.json(events);
  }));

  // Orders for one event, including the ones that need a refund decision.
  app.get('/api/organizer/events/:id/orders', requireAuth, wrap(async (req, res) => {
    const eventId = await ownEvent(req.params.id, req.userId);
    const { rows } = await db.query(
      `SELECT o.reference, o.buyer_name, o.buyer_email, t.name AS ticket_name, o.quantity, o.amount_kobo, o.fee_kobo, o.payout_kobo,
              o.status, o.paid_at, o.refunded_at,
              (SELECT COUNT(*) FROM tickets k WHERE k.order_id = o.id AND k.checked_in_at IS NOT NULL) AS used,
              rr.status AS request_status, rr.reason AS request_reason, rr.decline_note AS request_note, rr.created_at AS requested_at
       FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id LEFT JOIN refund_requests rr ON rr.order_id = o.id
       WHERE t.event_id = $1 AND o.status IN ('paid', 'refund_due', 'refund_pending', 'refunded')
       ORDER BY COALESCE(rr.status = 'pending', false) DESC, COALESCE(o.paid_at, o.created_at) DESC LIMIT 500`, [eventId]);
    res.json(rows);
  }));

  app.post('/api/organizer/orders/:reference/refund', requireAuth, limit.refund, wrap(async (req, res) => {
    const row = (await db.query(
      `SELECT o.reference FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id JOIN events e ON e.id = t.event_id
       WHERE o.reference = $1 AND e.organizer_id = $2`, [str(req.params.reference, 60), req.userId])).rows[0];
    if (!row) throw httpError(404, 'Order not found.');
    const out = await refundOrder({ reference: row.reference, initiatedBy: 'organizer', reason: str(req.body.reason, 300) });
    res.json({ ok: true, ...out });
  }));

  // Approve or decline a buyer's refund request (organizers only, for their own events).
  app.post('/api/organizer/orders/:reference/refund-request/decide', requireAuth, limit.refund, wrap(async (req, res) => {
    const out = await decideRefundRequest({ reference: str(req.params.reference, 60), organizerId: req.userId, action: str(req.body.action, 10), note: str(req.body.note, 300) });
    res.json({ ok: true, ...out });
  }));

  // ---------------- Gate check-in ----------------
  app.post('/api/checkin', requireAuth, wrap(async (req, res) => {
    const id = parseCode(req.body.code);
    if (!id) return res.json({ result: 'invalid', message: 'Not a valid ticket.' });
    const ticket = (await db.query(
      `SELECT k.id, k.checked_in_at, k.voided_at, t.name AS ticket_name, e.title, e.organizer_id, o.buyer_name
       FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id
       JOIN events e ON e.id = t.event_id JOIN orders o ON o.id = k.order_id WHERE k.id = $1`, [id])).rows[0];
    if (!ticket) return res.json({ result: 'invalid', message: 'Ticket not found.' });
    if (ticket.organizer_id !== req.userId) return res.json({ result: 'wrong_event', message: 'This ticket is for an event you do not manage.' });
    const base = { event: ticket.title, ticketType: ticket.ticket_name, buyer: ticket.buyer_name };
    if (ticket.voided_at) return res.json({ result: 'refunded', message: 'This ticket was refunded.', ...base });
    // Atomic: only one scan can flip NULL -> timestamp, so a ticket cannot be used twice.
    const done = await db.query('UPDATE tickets SET checked_in_at = NOW() WHERE id = $1 AND checked_in_at IS NULL AND voided_at IS NULL RETURNING id', [id]);
    if (!done.rows.length) {
      const used = (await db.query('SELECT checked_in_at FROM tickets WHERE id = $1', [id])).rows[0];
      return res.json({ result: 'already_used', message: 'Already scanned.', ...base, usedAt: used.checked_in_at });
    }
    res.json({ result: 'valid', message: 'Entry allowed.', ...base });
  }));

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found.')));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large. Try a smaller picture.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid.' });
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on our side.' });
  });
  return app;
}

if (require.main === module) {
  db.init().then(() => {
    setInterval(() => expirePendingOrders().catch((e) => console.error(e)), 60 * 1000).unref();
    createApp().listen(config.port, () => {
      console.log(`Gatepass running at ${config.baseUrl}`);
      console.log(`Database: ${db.kind}`);
      console.log(payments.live ? 'Payments: Paystack' : 'Payments: mock checkout (set PAYSTACK_SECRET_KEY to use Paystack)');
    });
  }).catch((err) => { console.error('Could not start:', err.message); process.exit(1); });
}

module.exports = { createApp, CATEGORIES };
