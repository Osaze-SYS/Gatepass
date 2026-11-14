# Gatepass

An event ticketing platform. Organizers publish events with pictures and ticket types, buyers search, pay online and receive QR tickets, and staff scan those tickets at the gate. Includes platform fees, refunds, rate limiting and a PostgreSQL back end.

Built as a portfolio project to show a complete, realistic system: accounts, payments with webhooks, concurrency-safe inventory, refunds, signed tickets and check-in.

![Architecture](docs/architecture.svg)
![Schema](docs/schema.svg)

## Features

- **Search and browse:** text search, category chips, date, price and sort filters, shareable URLs.
- **Event pages:** cover picture and gallery (up to 6 pictures per event), clear price breakdown, refund policy, map link.
- **Organizer pictures:** add, reorder (make cover) and remove pictures; photos are shrunk in the browser before upload and stored in the database.
- **Checkout:** pay with Paystack (or the practice checkout), tickets held for 15 minutes, free events skip payment.
- **Platform fee:** a percentage (and optional flat amount) per paid ticket, paid by the buyer on top or deducted from the organizer.
- **Tickets:** signed QR codes on a ticket page (printable) and by email.
- **Refunds:** buyers can refund themselves until a cutoff set by the organizer; organizers can refund any order; used tickets cannot be refunded.
- **Gate scanner:** camera or typed code, rejects forged, repeated and refunded tickets.
- **Dashboard:** earnings, fees, refunds, sales per ticket type, attendee and order lists.
- **Rate limiting:** login, checkout, refunds, uploads and the API overall.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env   then set APP_SECRET
npm run seed                # demo organizer + 4 events with pictures
npm start                   # http://localhost:3000
npm test                    # 17 automated tests
```

Demo organizer: `demo@gatepass.dev` / `password123`.

With no settings changed the app uses **PGlite**, a real PostgreSQL engine that runs inside Node and keeps its files in `./data`. Nothing to install. Stop the server before running `npm run seed` in this mode.

### Use a PostgreSQL server instead

Set `DATABASE_URL` in `.env`. Tables are created automatically on first start.

- **Free hosted database:** create a project on Neon or Supabase and paste the connection string.
- **Local with Docker:** run `docker compose up -d`, then set `DATABASE_URL=postgres://gatepass:gatepass@localhost:5432/gatepass`.

If your host needs SSL and the string does not say so, set `DATABASE_SSL=true`. The same 13 tests pass on both PGlite and a real PostgreSQL server; to run them against your own server set `TEST_DATABASE_URL` (use an empty test database).

### Real Paystack test payments and refunds

1. Copy your Paystack **test** secret key (`sk_test_...`) into `PAYSTACK_SECRET_KEY`.
2. Pay with Paystack's test cards. After payment the ticket page asks Paystack to verify, so it works on localhost.
3. To exercise the webhook, expose your server with a tunnel (for example ngrok), set `BASE_URL` to the tunnel address, and add `<BASE_URL>/api/webhooks/paystack` in the Paystack dashboard.
4. Refunds use Paystack's refund API. Without a key they are simulated.

### Send real emails

Without any setup, ticket emails are not sent (a note with the ticket link is printed in the terminal). To send real ones:

1. Create a free Brevo account and verify a sender address (your own email works, no domain needed).
2. Create an API key in Brevo and put it in `.env` as `BREVO_API_KEY`.
3. Set `MAIL_FROM="Gatepass <the-address-you-verified>"`. It must match exactly.
4. Check it: `npm run test-email -- you@example.com`.

Brevo's free plan allows 300 emails a day. The app uses Brevo's web (HTTPS) API because several free hosts, including Render's free web services and Railway's free and hobby plans, block normal SMTP email. If you prefer plain SMTP (a Gmail app password, for example), set the `SMTP_*` values instead; that works on your own computer and on hosts that allow it.

Email contains the online ticket link, the QR codes, and refund notices. Names in emails are escaped so nobody can inject HTML.

## Walkthrough

1. Open `/organizer.html`, log in, choose **Create event**, add pictures and ticket types.
2. Open the public page from **My events**, buy tickets, and note the service fee line.
3. The ticket page shows QR codes and a refund option.
4. Open `/scan.html` as the organizer and scan a code. The first scan says "Entry allowed", the second "Already scanned".
5. Back in **My events**, open **Orders and refunds** and refund an order, then try scanning its ticket again.

## Design decisions

**No overselling.** Stock is reserved with one conditional statement: `UPDATE ticket_types SET sold = sold + $1 WHERE id = $2 AND sold + $1 <= capacity RETURNING id`. PostgreSQL locks the row while it runs, so two buyers can never take the last ticket. A `CHECK (sold <= capacity)` constraint is a second safety net. A test fires 40 simultaneous purchases at 10 tickets and asserts exactly 10 succeed.

**Payment is confirmed by the server, not the browser.** Tickets are issued only after Paystack's webhook (valid HMAC-SHA512 signature over the raw body, matching amount) or a direct verification call. Fulfilment locks the order row, so a webhook delivered twice still issues tickets once.

**Late payments are not lost.** If a payment lands after the hold expired, the app tries to take the stock back; if it is gone, the order becomes `refund_due` and appears in the organizer's refund list.

**Refunds in three steps so money and tickets stay in step.** (1) Lock the order, void its tickets and mark it `refund_pending`. (2) Ask the payment provider to return the money. (3) On success mark it `refunded` and release the stock; on failure undo step 1. A crash in the middle leaves a `refund_pending` order that can simply be retried.

**Platform fee.** Per ticket: `round(price x percent) + flat`. Each order stores the subtotal, fee, amount charged and organizer payout, so reports never have to recompute history when rates change. With `FEE_PAYER=buyer` the fee is added on top; with `organizer` it is deducted from the payout.

**Pictures in the database.** Stored as `BYTEA`, so they survive hosts with temporary disks. The browser shrinks photos to at most 1600 px wide before upload; the server checks the real file signature (not just the declared type), limits the size, and serves them with long cache headers.

**Search.** Parameterized `ILIKE` over title, venue, description and category with `%` and `_` escaped, plus category, date, price and sort filters.

**Rate limiting.** Per visitor address: 10 login or sign-up attempts per 15 minutes, 20 checkouts per 10 minutes, 10 refund requests per hour, 60 uploads per hour, 300 API calls per minute. Tune with environment variables; set `TRUST_PROXY=1` behind a proxy.

**One database layer, two engines.** `src/db.js` exposes `query` and `tx` over either `pg` (a real server) or PGlite. All SQL is plain PostgreSQL.

**Security basics.** Passwords use scrypt with per-user salts, login tokens are signed and expire, organizers can only manage their own events, all user content is escaped before display, and input is validated on the server.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Accounts |
| GET | `/api/events?q=&category=&when=&price=&sort=` | Search and browse |
| GET | `/api/events/:id`, `/api/images/:id` | Event detail, pictures |
| POST | `/api/checkout` | Reserve tickets and start payment |
| GET | `/api/orders/:reference` | Order status, tickets, refund eligibility |
| POST | `/api/orders/:reference/refund` | Buyer refund (needs checkout email) |
| POST | `/api/webhooks/paystack` | Signed payment confirmation |
| POST | `/api/organizer/events` | Create event with ticket types (auth) |
| POST, DELETE | `/api/organizer/events/:id/images[/:imageId]` | Add, remove pictures (auth) |
| POST | `/api/organizer/events/:id/images/:imageId/cover` | Make a picture the cover (auth) |
| GET | `/api/organizer/events` | Earnings, fees, refunds, sales (auth) |
| GET | `/api/organizer/events/:id/orders` | Orders for one event (auth) |
| POST | `/api/organizer/orders/:reference/refund` | Organizer refund (auth) |
| POST | `/api/checkin` | Validate and consume a ticket (auth) |

## Configuration

See `.env.example`. Key settings: `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `PLATFORM_FEE_PERCENT`, `PLATFORM_FEE_FLAT_NAIRA`, `FEE_PAYER`, `RESERVATION_MINUTES`, `TRUST_PROXY`, and the `LIMIT_*` values.

## Deploying

Use a host that runs Node (Render, Railway, Fly.io). Set `APP_SECRET`, `BASE_URL` (your public address), `DATABASE_URL` (a hosted PostgreSQL such as Neon), `TRUST_PROXY=1`, and your Paystack keys. Run `npm run seed` once if you want demo data. HTTPS also makes the camera scanner work on phones.

## Known limits and next steps

- Refund requests that Paystack settles later are treated as done once Paystack accepts them; add a refund webhook to track final settlement.
- Organizer payouts are not automated. Earnings are tracked, and Paystack subaccounts or transfers can pay organizers out.
- Add email verification, password reset and two-factor login for organizers.
- Add event editing and cancelling (cancelling could refund every order automatically).
- Move pictures to object storage (S3 or similar) if galleries grow large, and add a job queue for emails when running several servers.

## Project layout

```
server.js            API routes
src/db.js            PostgreSQL layer (pg or PGlite) and schema
src/orders.js        reservation, expiry, fulfilment, refunds
src/fees.js          platform fee maths
src/payments.js      Paystack and practice checkout
src/tickets.js       signed codes and QR images
src/images.js        picture validation
src/ratelimit.js     rate limiters
src/auth.js          passwords and login tokens
src/mailer.js        ticket and refund emails
public/              pages: browse, event, ticket, organizer dashboard, scanner
seed.js, seed-images demo data
tests/               17 automated tests (database, payments, refunds, search, pictures, rate limits, email)
scripts/             send-test-email.js (checks your email settings)
docs/                architecture and schema diagrams (SVG)
```
