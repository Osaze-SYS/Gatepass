// Shared setup for the test files: a throwaway database, the app on a random port, and a few small helpers.
// (This file is not a test itself, so `node --test` skips it.)
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.APP_SECRET = 'test-secret';

const db = require('../src/db');
const { createApp } = require('../server');

const HIGH = { auth: { limit: 1000 }, checkout: { limit: 1000 }, refund: { limit: 1000 }, upload: { limit: 1000 }, quote: { limit: 1000 }, broadcast: { limit: 1000 }, api: { limit: 100000 } };

async function boot() {
  await db.init();
  const server = createApp({ limits: HIGH }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const api = async (path, body, auth, method) => {
    const res = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
  const register = async (email) => (await api('/api/auth/register', { name: 'Org ' + email, email, password: 'password123' })).body.token;
  async function makeEvent(token, { capacity = 10, priceNaira = 1000, title = 'Test event', category = 'Tech', days = 10, refundsAllowed, types } = {}) {
    const ticketTypes = types || [{ name: 'Regular', priceNaira, capacity }];
    const res = await api('/api/organizer/events', { title, venue: 'Hall', category, startsAt: inDays(days), refundsAllowed, ticketTypes }, token);
    if (res.status !== 201) throw new Error('could not create event: ' + JSON.stringify(res.body));
    const ev = (await api(`/api/events/${res.body.id}`)).body;
    return { eventId: res.body.id, typeId: ev.ticketTypes[0].id, types: ev.ticketTypes };
  }
  const buy = (typeId, n, quantity = 1, extra = {}) => api('/api/checkout', { ticketTypeId: typeId, quantity, name: 'Buyer ' + n, email: `buyer${n}@test.dev`, ...extra });
  async function buyAndPay(typeId, n, quantity = 1, extra = {}) {
    const { body } = await buy(typeId, n, quantity, extra);
    await api('/api/mock/pay', { reference: body.reference });
    return body.reference;
  }
  return { db, server, base, api, inDays, register, makeEvent, buy, buyAndPay, close: async () => { server.close(); await db.close(); } };
}

module.exports = { boot };
