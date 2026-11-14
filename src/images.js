const config = require('./config');

const MIME = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

// Checks the file's real signature, not just what the browser claims it is.
function looksLike(mime, b) {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png') return b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP';
  return false;
}

// Accepts a data URL such as "data:image/jpeg;base64,...." and returns { mime, data } or an error message.
function parseImage(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!match) return { error: 'Upload a JPG, PNG or WebP picture.' };
  const data = Buffer.from(match[2], 'base64');
  if (data.length > config.maxImageBytes) return { error: 'That picture is too large. Try a smaller one.' };
  if (!looksLike(match[1], data)) return { error: 'That file is not a valid picture.' };
  return { mime: match[1], data };
}

module.exports = { parseImage };
