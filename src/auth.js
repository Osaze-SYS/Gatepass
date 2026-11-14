const crypto = require('crypto');
const config = require('./config');

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
function issueToken(userId) {
  const payload = b64(JSON.stringify({ uid: userId, exp: Date.now() + 7 * 864e5 }));
  return `${payload}.${hmac(payload)}`;
}
function readToken(token) {
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const data = readToken(header.replace(/^Bearer /, ''));
  if (!data) return res.status(401).json({ error: 'Please log in.' });
  req.userId = data.uid;
  next();
}

module.exports = { hashPassword, verifyPassword, issueToken, requireAuth, hmac };
