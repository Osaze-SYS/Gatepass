// One small interface over two PostgreSQL back ends:
//   - a real server through `pg`   (when DATABASE_URL is set)
//   - PGlite, PostgreSQL running inside Node (zero setup, great for development and demos)
// All SQL in the app is plain PostgreSQL and works on both.
const config = require('./config');

let impl = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  starts_at TIMESTAMPTZ NOT NULL,
  refund_cutoff_hours INTEGER NOT NULL DEFAULT 48 CHECK (refund_cutoff_hours >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Pictures live in the database so they survive on hosts with temporary disks.
CREATE TABLE IF NOT EXISTS event_images (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Money is stored in kobo (integers). CHECK keeps stock honest even if a query is wrong.
CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_kobo INTEGER NOT NULL CHECK (price_kobo >= 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  sold INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0 AND sold <= capacity)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  subtotal_kobo INTEGER NOT NULL,   -- ticket price x quantity
  fee_kobo INTEGER NOT NULL,        -- platform fee for the whole order
  amount_kobo INTEGER NOT NULL,     -- what the buyer pays
  payout_kobo INTEGER NOT NULL,     -- what the organizer keeps (amount - fee)
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired','refund_due','refund_pending','refunded')),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  checked_in_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,            -- set when the order is refunded
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount_kobo INTEGER NOT NULL,
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('buyer','organizer')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_images_event ON event_images(event_id, position);
CREATE INDEX IF NOT EXISTS idx_types_event ON ticket_types(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_expiry ON orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
`;

async function connect() {
  if (config.databaseUrl) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => Number(v));   // COUNT/SUM come back as bigint strings otherwise
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    const norm = (r) => ({ rows: r.rows, rowCount: r.rowCount });
    return {
      kind: 'PostgreSQL server',
      query: (text, params) => pool.query(text, params).then(norm),
      exec: (sql) => pool.query(sql),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((text, params) => client.query(text, params).then(norm));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(config.pgliteDir === 'memory://' ? undefined : config.pgliteDir);
  await pg.waitReady;
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    kind: 'PGlite (PostgreSQL inside Node)',
    query: (text, params) => pg.query(text, params).then(norm),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn((text, params) => t.query(text, params).then(norm))),
    close: () => pg.close(),
  };
}

async function init() {
  if (impl) return impl;
  if (!config.databaseUrl && config.pgliteDir !== 'memory://') require('fs').mkdirSync(config.pgliteDir, { recursive: true });
  impl = await connect();
  await impl.exec(SCHEMA);
  return impl;
}

const need = () => { if (!impl) throw new Error('Database not ready. Call db.init() first.'); return impl; };

module.exports = {
  init,
  query: (text, params) => need().query(text, params),
  tx: (fn) => need().tx(fn),
  close: async () => { if (impl) { await impl.close(); impl = null; } },
  get kind() { return impl ? impl.kind : 'not connected'; },
};
