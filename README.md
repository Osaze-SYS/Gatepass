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
- **Manage events:** organizers can edit an event until it starts (details, date, refund policy, ticket prices and numbers, add or remove ticket types) and delete it once it has started or been cancelled; a changed date or venue is emailed to everyone who bought tickets.
- **Archive:** finished events can be tucked into a collapsed Archived section and restored with one click. They still count in totals, charts, guest lists and payouts. Past events no longer offer editing or new discount codes.
- **Cancel an event:** one click stops sales, releases unpaid holds, and refunds every order in full, emailing each buyer. It can be run again to finish any refunds that failed.
- **Discount codes:** percent-off or fixed-amount codes per event, with a use limit and an expiry; buyers see the new total before paying, and a 100% code makes the order free.
- **Sales charts and exports:** tickets and earnings per day (last 30 days) for all events or one event, a split by ticket type, and the guest list as a CSV file for Excel.
- **Automatic payouts:** organizers add a verified bank account; their earnings are sent automatically after the event (Paystack Transfers), with a history, retries and email notices.
- **Password reset:** an emailed single-use link; resetting ends every login on every device.
- **Refund policy per event:** instant refunds until a cutoff, or "No refunds, all sales are final".
- **Accounts:** organizers confirm their email through a link (with a pop-up after sign-up), and the login page has "Remember me".
- **Emails:** buyers get their tickets and an event link to share; organizers get an email for every sale, refund request and granted refund; buyers hear about refunds and declined requests.
- **Sharing:** the ticket page has a share box (copy link, WhatsApp, device share), and shared event links show a proper preview with the event's title and picture.
- **Refunds:** buyers refund themselves instantly until a cutoff the organizer sets; after the cutoff they send a request that the organizer approves or declines (the organizer is emailed, and so is the buyer if it is declined); organizers can refund any order at any time; used tickets cannot be refunded.
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
npm test                    # 60 automated tests
```

Demo organizer: `demo@gatepass.dev` / `password123`.

With no settings changed the app uses **PGlite**, a real PostgreSQL engine that runs inside Node and keeps its files in `./data`. Nothing to install. Stop the server before running `npm run seed` in this mode.

### Use a PostgreSQL server instead

Set `DATABASE_URL` in `.env`. Tables are created automatically on first start.

- **Free hosted database:** create a project on Neon or Supabase and paste the connection string.
- **Local with Docker:** run `docker compose up -d`, then set `DATABASE_URL=postgres://gatepass:gatepass@localhost:5432/gatepass`.

If your host needs SSL and the string does not say so, set `DATABASE_SSL=true`. The whole test suite passes on both PGlite and a real PostgreSQL server. To run it against your own server, use an empty test database and run `TEST_DATABASE_URL=postgres://... node --test --test-concurrency=1`.

### Real Paystack test payments and refunds

1. Copy your Paystack **test** secret key (`sk_test_...`) into `PAYSTACK_SECRET_KEY`.
2. Pay with Paystack's test cards. After payment the ticket page asks Paystack to verify, so it works on localhost.
3. To exercise the webhook, expose your server with a tunnel (for example ngrok), set `BASE_URL` to the tunnel address, and add `<BASE_URL>/api/webhooks/paystack` in the Paystack dashboard.
4. Refunds use Paystack's refund API. Without a key they are simulated.

### Payouts with real money (read this before going live)

Payouts use Paystack Transfers. In practice mode (no Paystack key) they are simulated, so the whole flow can be tried safely. For real transfers:

1. Your Paystack account must have Transfers enabled (this normally needs a verified business).
2. Turn **off** the OTP requirement for transfers in Paystack settings. Otherwise Paystack waits for a person to approve each transfer; Gatepass reports this clearly and the organizer can retry once it is off.
3. Keep enough balance in your Paystack account. Buyer payments settle into it on Paystack's schedule; if the balance is short the payout simply waits and tries again.
4. Make sure the webhook also receives `transfer.success`, `transfer.failed` and `transfer.reversed` (the same webhook address as for payments). If a webhook is missed, the job checks with Paystack after 10 minutes.

Each payout uses a unique reference, so a transfer is never sent twice. Organizers' account numbers are never stored: Paystack holds the full number and Gatepass keeps only the bank, the account name and the last 4 digits. The payout job runs every minute while the server is awake; on a free host that sleeps, point a free uptime pinger at `/api/health` so payouts are not delayed. **Live transfers could not be tested against a real Paystack account while building this, so run a small test payout in Paystack test mode first.**

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

**Refund requests.** Instant refunds stop at the organizer's cutoff. After that, and until the event starts, the buyer (who must give the email used at checkout) can send one request per order. It appears at the top of the organizer's orders list, and the organizer is emailed. Approving runs the same three-step refund as above; declining leaves the tickets valid and emails the buyer the organizer's note. Any other refund of the same order, such as the organizer refunding directly, settles the waiting request automatically.

**Editing and deleting events.** Editing keeps each ticket type's id, so earlier orders stay linked and keep the price they were bought at. The number of tickets cannot go below what is sold or held, and a ticket type that has orders cannot be removed. Deleting hides the event instead of erasing it, so sales and refund history stay intact; an upcoming event must be cancelled first (which refunds everyone), and a cancelled event can only be deleted once every order is refunded.

**Email confirmation and "Remember me".** With an email service set up, a new organizer account cannot log in until the emailed link is used (the link is a signed, single-purpose token that expires after 48 hours and cannot be used as a login). Without an email service, accounts work straight away so local testing needs no setup. "Remember me" keeps the login for 30 days in the browser's long-term storage; without it the login lasts one day and is forgotten when the browser closes.

**Cancelling an event.** It marks the event cancelled first (so nothing new can be bought), releases unpaid holds, then refunds each order with the same three-step refund as before. A payment that arrives after the cancellation is never turned into tickets: the order is flagged for refund. The refund loop stops at a time budget and can be run again, and it only touches what is unfinished. Orders already scanned or already paid out are skipped and reported.

**Discount codes.** A code is claimed with one atomic statement (`used_count < max_uses`), so the last use goes to exactly one buyer even when many race for it, and an unpaid order that expires gives its use back. The discount comes off each ticket and the platform fee is worked out on the discounted price, so the organizer carries the discount. Prices shown to the buyer come from the server (`/api/quote`), so the total always matches checkout.

**Charts and exports.** Charts are plain SVG built in the browser, with the data grouped by day in Lagos time on the server. CSV cells that start with `=`, `+`, `-` or `@` get a leading apostrophe, so a buyer cannot plant a spreadsheet formula in the organizer's guest list, and the file starts with a byte-order mark so Excel reads the ₦ sign correctly.

**Payouts.** Earnings (`orders.payout_kobo`) are claimed per event with one locked query that sets `payout_id` on each order, so an order can only ever be in one payout, even with two servers running. Orders with a refund request waiting are held back. A transfer whose result is unclear (network drop, Paystack error) stays `pending` and is retried with the same reference, which Paystack never pays twice; a clear rejection becomes `failed` and the organizer retries with a new reference. After a payout, refunding those orders from Gatepass is blocked, because the money has left.

**Sessions and password reset.** A reset link carries a fingerprint of the current password hash, so it works once. Resetting also bumps a per-user session version that every login token is checked against, which ends all existing logins immediately.

**Archiving versus deleting.** Delete hides an event for good: it leaves the totals, charts and guest list. Archive only moves a finished event into a collapsed section and takes it off public browsing, so every number, export and payout stays intact, and it can be restored. An event can be archived once it has started (or been cancelled and fully refunded), and never while a refund decision is waiting, so nothing that needs attention can be hidden. If something needing attention appears on an archived event later, the archive section opens by itself.

**Platform fee.** Per ticket: `round(price x percent) + flat`. Each order stores the subtotal, fee, amount charged and organizer payout, so reports never have to recompute history when rates change. With `FEE_PAYER=buyer` the fee is added on top; with `organizer` it is deducted from the payout.

**Pictures in the database.** Stored as `BYTEA`, so they survive hosts with temporary disks. The browser shrinks photos to at most 1600 px wide before upload; the server checks the real file signature (not just the declared type), limits the size, and serves them with long cache headers.

**Search.** Parameterized `ILIKE` over title, venue, description and category with `%` and `_` escaped, plus category, date, price and sort filters.

**Rate limiting.** Per visitor address: 10 login or sign-up attempts per 15 minutes, 20 checkouts per 10 minutes, 10 refund requests per hour, 60 uploads per hour, 300 API calls per minute. Tune with environment variables; set `TRUST_PROXY=1` behind a proxy.

**One database layer, two engines.** `src/db.js` exposes `query` and `tx` over either `pg` (a real server) or PGlite. All SQL is plain PostgreSQL.

**Security basics.** Passwords use scrypt with per-user salts, login tokens are signed and expire, organizers can only manage their own events, all user content is escaped before display, and input is validated on the server.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Accounts (login accepts `remember`) |
| POST | `/api/auth/verify`, `/api/auth/resend` | Confirm an email address, send the link again |
| POST | `/api/auth/forgot`, `/api/auth/reset` | Password reset by email |
| GET | `/api/health` | Health check for uptime pingers |
| POST | `/api/quote` | Price for a ticket and quantity, with an optional discount code |
| GET | `/api/events?q=&category=&when=&price=&sort=` | Search and browse |
| GET | `/api/events/:id`, `/api/images/:id` | Event detail, pictures |
| POST | `/api/checkout` | Reserve tickets and start payment |
| GET | `/api/orders/:reference` | Order status, tickets, refund eligibility |
| POST | `/api/orders/:reference/refund` | Instant buyer refund before the cutoff (needs checkout email) |
| POST | `/api/orders/:reference/refund-request` | Buyer asks the organizer after the cutoff |
| POST | `/api/webhooks/paystack` | Signed payment confirmation |
| POST | `/api/organizer/events` | Create event with ticket types (auth) |
| PUT, DELETE | `/api/organizer/events/:id` | Edit or delete an event (auth) |
| POST, DELETE | `/api/organizer/events/:id/images[/:imageId]` | Add, remove pictures (auth) |
| POST | `/api/organizer/events/:id/images/:imageId/cover` | Make a picture the cover (auth) |
| GET | `/api/organizer/events` | Earnings, fees, refunds, sales (auth) |
| GET | `/api/organizer/events/:id/orders` | Orders for one event (auth) |
| POST | `/api/organizer/orders/:reference/refund` | Organizer refund (auth) |
| POST | `/api/organizer/orders/:reference/refund-request/decide` | Approve or decline a buyer's request (auth) |
| POST | `/api/organizer/events/:id/cancel` | Cancel an event and refund everyone; call again to finish (auth) |
| POST | `/api/organizer/events/:id/archive`, `/unarchive` | Tuck a finished event away, or bring it back (auth) |
| GET, POST | `/api/organizer/events/:id/discounts` | List and add discount codes (auth) |
| POST | `/api/organizer/events/:id/discounts/:codeId/toggle` | Turn a code on or off (auth) |
| GET | `/api/organizer/sales?event=&days=` | Sales per day and per ticket type (auth) |
| GET | `/api/organizer/events/:id/export.csv` | Guest list as a CSV file (auth) |
| GET, PUT | `/api/organizer/payouts`, `/api/organizer/payout-account` | Payout overview, save the bank account (auth) |
| POST | `/api/organizer/payout-account/resolve`, `/api/organizer/payouts/:id/retry` | Check an account name, retry a failed payout (auth) |
| POST | `/api/checkin` | Validate and consume a ticket (auth) |

## Configuration

See `.env.example`. Key settings: `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `PLATFORM_FEE_PERCENT`, `PLATFORM_FEE_FLAT_NAIRA`, `FEE_PAYER`, `RESERVATION_MINUTES`, `TRUST_PROXY`, and the `LIMIT_*` values.

## Deploying

Use a host that runs Node (Render, Railway, Fly.io). Set `APP_SECRET`, `BASE_URL` (your public address), `DATABASE_URL` (a hosted PostgreSQL such as Neon), `TRUST_PROXY=1`, and your Paystack keys. Run `npm run seed` once if you want demo data. HTTPS also makes the camera scanner work on phones.

## Known limits and next steps

- Live Paystack transfers (payouts) and refunds were built to Paystack's documentation but could not be tested against a real account here. Run test-mode payments, a refund and a small payout before relying on them.
- Refunds that Paystack settles later are treated as done once Paystack accepts them; add a refund webhook to track final settlement.
- One payout is made per event, after the delay. Earnings from sales made after that point go out in a later payout.
- Add two-factor login for organizers, and a per-code usage report.
- Move pictures to object storage (S3 or similar) if galleries grow large, and add a job queue for emails and payouts when running several servers.

## Project layout

```
server.js            API routes
src/db.js            PostgreSQL layer (pg or PGlite) and schema
src/orders.js        reservation, expiry, fulfilment, refunds, discount codes, cancellation
src/payouts.js       bank accounts, payout claiming, sending and tracking
src/fees.js          platform fee maths
src/payments.js      Paystack (payments, refunds, transfers) and practice mode
src/tickets.js       signed codes and QR images
src/images.js        picture validation
src/ratelimit.js     rate limiters
src/auth.js          passwords, login tokens, session versions
src/mailer.js        all emails
public/              pages: browse, event, ticket, organizer dashboard, scanner, email confirmation, password reset
seed.js, seed-images demo data
tests/               60 automated tests
docs/                architecture and schema diagrams (SVG)
```
