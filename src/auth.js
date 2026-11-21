const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', config.secret).update(data).digest('base64url');

// ---- Passwords (scrypt, per-user salt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---- Login tokens: base64url(payload).signature ----
// purpose 's' = login session, 'v' = email confirmation link. A token only works for its own purpose.
// "Remember me" keeps a session for 30 days; otherwise it lasts one day (and the browser forgets it when closed).
// `extra` is stored as x: the session version for logins, a password fingerprint for reset links.
function issueToken(userId, remember = false, purpose = 's', ttlMs, extra) {
  const ttl = ttlMs || (remember ? 30 * 864e5 : 864e5);
  const payload = b64(JSON.stringify({ uid: userId, exp: Date.now() + ttl, p: purpose, ...(extra !== undefined ? { x: extra } : {}) }));
  return `${payload}.${hmac(payload)}`;
}
function readToken(token, purpose = 's') {
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() && (data.p || 's') === purpose ? data : null;
}

// A reset link is single-use because it carries a fingerprint of the password it was issued for.
const fingerprint = (passwordHash) => hmac('pw:' + passwordHash).slice(0, 16);

// Checks the token and that the account's session version still matches, so resetting a password logs every device out.
// requireAuth is for organizers only. requireTeam also lets scanner team members through (used by the gate scanner).
// req.ownerId is the organizer whose events the person may work with: themselves, or the organizer a scanner works for.
function authenticate(allowTeam) {
  return async (req, res, next) => {
    try {
      const data = readToken((req.get('authorization') || '').replace(/^Bearer /, ''));
      if (!data) return res.status(401).json({ error: 'Please log in.' });
      const row = (await db.query('SELECT session_version, role, owner_id FROM users WHERE id = $1', [data.uid])).rows[0];
      if (!row || (data.x ?? 0) !== row.session_version) return res.status(401).json({ error: 'Please log in again.' });
      if (row.role !== 'organizer' && !allowTeam) return res.status(403).json({ error: 'This area is only for the event organizer.' });
      req.userId = data.uid;
      req.role = row.role;
      req.ownerId = row.role === 'scanner' ? row.owner_id : data.uid;
      next();
    } catch (err) { next(err); }
  };
}
const requireAuth = authenticate(false), requireTeam = authenticate(true);

module.exports = { hashPassword, verifyPassword, issueToken, readToken, requireAuth, requireTeam, fingerprint, hmac };
