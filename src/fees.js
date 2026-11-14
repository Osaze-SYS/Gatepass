const config = require('./config');

// Platform fee for ONE ticket. Free tickets never carry a fee.
const feePerTicket = (priceKobo) => (priceKobo === 0 ? 0 : Math.round((priceKobo * config.feePercent) / 100) + config.feeFlatKobo);

// What the buyer sees and what the organizer earns for an order of `quantity` tickets.
function breakdown(priceKobo, quantity) {
  const subtotal = priceKobo * quantity;
  const buyerPays = config.feePayer === 'buyer';
  const fee = buyerPays ? feePerTicket(priceKobo) * quantity : Math.min(feePerTicket(priceKobo) * quantity, subtotal);
  const amount = buyerPays ? subtotal + fee : subtotal;
  return { subtotal, fee, amount, payout: amount - fee, feePayer: config.feePayer };
}

// The extra amount shown to the buyer per ticket (0 when the organizer absorbs the fee).
const buyerFeePerTicket = (priceKobo) => (config.feePayer === 'buyer' ? feePerTicket(priceKobo) : 0);

module.exports = { feePerTicket, breakdown, buyerFeePerTicket };
