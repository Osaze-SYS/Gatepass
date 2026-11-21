const { rateLimit } = require('express-rate-limit');
const config = require('./config');

// Builds one limiter per area. `overrides` lets tests use tiny limits.
function makeLimiters(overrides = {}) {
  const make = (name, message) => {
    const { windowMs, limit } = { ...config.limits[name], ...(overrides[name] || {}) };
    return rateLimit({
      windowMs, limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: message },
    });
  };
  return {
    auth: make('auth', 'Too many login attempts. Please wait a few minutes and try again.'),
    checkout: make('checkout', 'Too many checkout attempts. Please wait a few minutes and try again.'),
    refund: make('refund', 'Too many refund requests. Please try again later.'),
    upload: make('upload', 'Too many uploads. Please try again later.'),
    broadcast: make('broadcast', 'You are sending messages too quickly. Please try again later.'),
    quote: make('quote', 'Too many price checks. Please wait a few minutes and try again.'),
    api: make('api', 'Too many requests. Please slow down.'),
  };
}

module.exports = { makeLimiters };
