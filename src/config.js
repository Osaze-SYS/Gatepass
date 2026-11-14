require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  secret: process.env.APP_SECRET || 'dev-only-secret',
  trustProxy: process.env.TRUST_PROXY || '',       // set to 1 when deployed behind a proxy (Render, Railway...)

  // Database: set DATABASE_URL for a PostgreSQL server (Neon, Supabase, Render, Docker...).
  // Leave it empty to use PGlite, a real PostgreSQL engine that runs inside Node with no install.
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  pgliteDir: process.env.PGLITE_DIR ?? './data/pglite',   // 'memory://' keeps it in RAM (used by tests)

  paystackKey: process.env.PAYSTACK_SECRET_KEY || '',
  reservationMinutes: num(process.env.RESERVATION_MINUTES, 15),

  // Platform fee, charged per paid ticket (free tickets carry no fee).
  feePercent: num(process.env.PLATFORM_FEE_PERCENT, 5),
  feeFlatKobo: Math.round(num(process.env.PLATFORM_FEE_FLAT_NAIRA, 0) * 100),
  feePayer: process.env.FEE_PAYER === 'organizer' ? 'organizer' : 'buyer',   // buyer: added on top. organizer: deducted from payout.

  // Images are stored in the database. Browsers shrink them before upload.
  maxImageBytes: 1.5 * 1024 * 1024,
  maxImagesPerEvent: 6,

  // Requests allowed per window, per IP address.
  limits: {
    auth: { windowMs: 15 * 60 * 1000, limit: num(process.env.LIMIT_AUTH, 10) },
    checkout: { windowMs: 10 * 60 * 1000, limit: num(process.env.LIMIT_CHECKOUT, 20) },
    refund: { windowMs: 60 * 60 * 1000, limit: num(process.env.LIMIT_REFUND, 10) },
    upload: { windowMs: 60 * 60 * 1000, limit: num(process.env.LIMIT_UPLOAD, 60) },
    api: { windowMs: 60 * 1000, limit: num(process.env.LIMIT_API, 300) },
  },

  mail: {
    brevoKey: process.env.BREVO_API_KEY || '',   // sends over HTTPS, so it works on hosts that block SMTP
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Gatepass <tickets@example.com>',
  },
};
