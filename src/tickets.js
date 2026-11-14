const crypto = require('crypto');
const QRCode = require('qrcode');
const { hmac } = require('./auth');

// A ticket code looks like "<random id>.<signature>". The signature means a
// forged code is rejected by the scanner without even touching the database.
function signCode(id) {
  return `${id}.${hmac('ticket:' + id).slice(0, 16)}`;
}

function newTicket() {
  const id = crypto.randomBytes(10).toString('hex');
  return { id, code: signCode(id) };
}

function parseCode(code) {
  const [id, sig] = String(code || '').trim().split('.');
  if (!id || !sig) return null;
  const expected = hmac('ticket:' + id).slice(0, 16);
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

const qrDataUrl = (code) => QRCode.toDataURL(code, { margin: 1, width: 320 });
const qrBuffer = (code) => QRCode.toBuffer(code, { margin: 1, width: 320 });

module.exports = { newTicket, signCode, parseCode, qrDataUrl, qrBuffer };
