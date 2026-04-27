module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ clientId: process.env.PAYPAL_CLIENT_ID || '' });
};
