// Adds a demo organizer and a few events (with pictures) so the site is not empty.
// Login: demo@gatepass.dev / password123
// Note: with the built-in database, stop the server before running this.
const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const { hashPassword } = require('./src/auth');

const inDays = (d, h = 18) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x; };
const events = [
  { title: 'Abuja Tech Night', venue: 'Transcorp Hilton, Abuja', category: 'Tech', at: inDays(14), image: 'tech.jpg',
    description: 'Talks, live demos and networking for student developers and founders.\n\nMeet people building products in Nigeria, get feedback on your project, and walk away with new contacts.',
    types: [['Student', 2500, 150], ['Regular', 5000, 200], ['VIP', 15000, 30]] },
  { title: 'Afrobeats Rooftop Live', venue: 'Jabi Lake Mall Rooftop, Abuja', category: 'Music', at: inDays(30, 20), image: 'music.jpg',
    description: 'A live band, two DJs and the best skyline in town. Doors open at 7pm.',
    types: [['Early bird', 3000, 40], ['Gate', 6000, 160]] },
  { title: 'Founders Open Mic', venue: 'University of Abuja Auditorium', category: 'Community', at: inDays(7, 16), image: 'community.jpg',
    description: 'Five-minute pitches, honest feedback and no entry fee. Bring an idea and a friend.',
    types: [['Free entry', 0, 120]] },
  { title: 'Lagos Food Festival', venue: 'Tafawa Balewa Square, Lagos', category: 'Food & Drink', at: inDays(45, 12),
    description: 'Street food, chefs from across the country and live cooking stages.', types: [['General', 2000, 500], ['Tasting pass', 8000, 100]] },
];

(async () => {
  await db.init();
  let user = (await db.query('SELECT id FROM users WHERE email = $1', ['demo@gatepass.dev'])).rows[0];
  if (!user) user = (await db.query('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id', ['Demo Organizer', 'demo@gatepass.dev', hashPassword('password123')])).rows[0];
  const have = (await db.query('SELECT COUNT(*) AS n FROM events WHERE organizer_id = $1', [user.id])).rows[0].n;
  if (have > 0) { console.log('Already seeded.'); return db.close(); }
  for (const e of events) {
    const ev = await db.query('INSERT INTO events (organizer_id, title, description, venue, category, starts_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [user.id, e.title, e.description, e.venue, e.category, e.at]);
    const id = ev.rows[0].id;
    for (const [name, naira, cap] of e.types) await db.query('INSERT INTO ticket_types (event_id, name, price_kobo, capacity) VALUES ($1, $2, $3, $4)', [id, name, naira * 100, cap]);
    if (e.image) await db.query('INSERT INTO event_images (event_id, mime, data, position) VALUES ($1, $2, $3, 0)', [id, 'image/jpeg', fs.readFileSync(path.join(__dirname, 'seed-images', e.image))]);
  }
  console.log(`Seeded demo organizer (demo@gatepass.dev / password123) and ${events.length} events.`);
  await db.close();
})().catch((err) => { console.error(err); process.exit(1); });
