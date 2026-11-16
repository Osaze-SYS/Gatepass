const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');

let t, org, other;
test.before(async () => { t = await boot(); org = await t.register('org@rep.test'); other = await t.register('other@rep.test'); });
test.after(() => t.close());

const setPaid = (ref, when) => t.db.query('UPDATE orders SET paid_at = $2 WHERE reference = $1', [ref, when]);
const lagosDay = (d) => new Date(d.getTime() + 3600e3).toISOString().slice(0, 10);       // Nigeria is UTC+1

test('sales per day use Lagos dates, skip refunded orders and old sales, and add up per ticket type', async () => {
  const a = await t.makeEvent(org, { title: 'Chart Event A', priceNaira: 1000, types: [{ name: 'Regular', priceNaira: 1000, capacity: 50 }, { name: 'VIP', priceNaira: 5000, capacity: 20 }] });
  const b = await t.makeEvent(org, { title: 'Chart Event B', priceNaira: 2000 });
  const vip = a.types.find((x) => x.name === 'VIP').id, regular = a.types.find((x) => x.name === 'Regular').id;

  const lateNight = new Date(Date.now() - 3 * 864e5); lateNight.setUTCHours(23, 30, 0, 0);     // 23:30 UTC is already the next day in Lagos
  const morning = new Date(Date.now() - 1 * 864e5); morning.setUTCHours(10, 0, 0, 0);
  const r1 = await t.buyAndPay(regular, 1, 2);        // 2 × ₦1,000
  const r2 = await t.buyAndPay(vip, 2, 1);            // 1 × ₦5,000
  const r3 = await t.buyAndPay(regular, 3, 1);        // refunded later, so it must not count
  const r4 = await t.buyAndPay(regular, 4, 1);        // too old for the default 30 days
  const r5 = await t.buyAndPay(b.typeId, 5, 3);       // another event
  await setPaid(r1, lateNight); await setPaid(r2, lateNight); await setPaid(r3, morning); await setPaid(r4, new Date(Date.now() - 40 * 864e5)); await setPaid(r5, morning);
  await t.api(`/api/organizer/orders/${r3}/refund`, {}, org);

  const forA = (await t.api(`/api/organizer/sales?event=${a.eventId}`, null, org)).body;
  assert.strictEqual(forA.days, 30);
  assert.deepStrictEqual(forA.perDay.map((d) => [d.day, d.tickets, d.orders, d.gross_kobo, d.earnings_kobo]), [[lagosDay(lateNight), 3, 2, 735000, 700000]]);
  assert.deepStrictEqual(forA.byType.map((x) => [x.name, x.tickets, x.earnings_kobo]), [['VIP', 1, 500000], ['Regular', 3, 300000]]);   // refunded excluded; old sale still in the all-time split

  const all = (await t.api('/api/organizer/sales?days=30', null, org)).body;
  assert.deepStrictEqual(all.perDay.map((d) => [d.day, d.tickets]), [[lagosDay(lateNight), 3], [lagosDay(morning), 3]]);
  assert.deepStrictEqual((await t.api('/api/organizer/sales?days=3', null, org)).body.days, 7);          // the range is kept within 7 to 365 days
  assert.strictEqual((await t.api(`/api/organizer/sales?event=${a.eventId}`, null, other)).status, 404);
  assert.deepStrictEqual((await t.api('/api/organizer/sales', null, other)).body.perDay, []);            // other organizers see only their own
  assert.strictEqual((await t.api('/api/organizer/sales')).status, 401);
});

test('the guest list downloads as a spreadsheet-safe CSV', async () => {
  const { eventId, typeId } = await t.makeEvent(org, { title: 'Guest, List "Night"', priceNaira: 2000 });
  await t.api(`/api/organizer/events/${eventId}/discounts`, { code: 'LESS10', kind: 'percent', value: 10 }, org);
  const normal = await t.buyAndPay(typeId, 1, 2, { code: 'LESS10' });
  const sneaky = (await t.api('/api/checkout', { ticketTypeId: typeId, quantity: 1, name: '=HYPERLINK("http://evil.example","click")', email: 'sneaky@test.dev' })).body.reference;
  await t.api('/api/mock/pay', { reference: sneaky });
  const comma = (await t.api('/api/checkout', { ticketTypeId: typeId, quantity: 1, name: 'Okafor, Ada', email: 'ada@test.dev' })).body.reference;
  await t.api('/api/mock/pay', { reference: comma });
  await t.api(`/api/organizer/orders/${comma}/refund`, {}, org);
  const code = (await t.api(`/api/orders/${normal}`)).body.tickets[0].code;
  await t.api('/api/checkin', { code }, org);

  const res = await t.api(`/api/organizer/events/${eventId}/export.csv`, null, org);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="guests-guest-list-night\.csv"/);
  const csv = res.body;
  const raw = Buffer.from(await (await fetch(`${t.base}/api/organizer/events/${eventId}/export.csv`, { headers: { Authorization: `Bearer ${org}` } })).arrayBuffer());
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a BOM so Excel reads UTF-8');
  assert.ok(csv.startsWith('Order,Name,Email,Ticket,Quantity,Discount code,Discount (NGN),Paid (NGN),Platform fee (NGN),You earn (NGN),Status,Paid at (Lagos time),Checked in'));
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 4);                                                                       // header + 3 orders (the refunded one is listed too)
  assert.ok(lines.some((l) => l.startsWith(normal + ',Buyer 1,buyer1@test.dev,Regular,2,LESS10,400.00,3780.00,180.00,3600.00,paid,')) && lines.some((l) => l.endsWith(',1 of 2')));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), 'formulas are defused');
  assert.ok(csv.includes('"Okafor, Ada"') && csv.includes(',refunded,'));
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/export.csv`, null, other)).status, 404);
  assert.strictEqual((await t.api(`/api/organizer/events/${eventId}/export.csv`)).status, 401);
});
