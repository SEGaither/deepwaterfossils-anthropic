const PRICES = require('./prices');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { listingId } = req.body || {};
  if (!listingId) {
    return res.status(400).json({ error: 'Missing listingId' });
  }

  const listing = PRICES[listingId];
  if (!listing) {
    return res.status(400).json({ error: 'Unknown listing' });
  }

  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const base = process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return res.status(502).json({ error: 'Failed to authenticate with PayPal' });
  }

  const orderRes = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        description: listing.title,
        amount: { currency_code: 'USD', value: listing.price },
      }],
    }),
  });

  const orderData = await orderRes.json();
  if (!orderData.id) {
    return res.status(502).json({ error: 'Failed to create PayPal order' });
  }

  res.status(200).json({ id: orderData.id });
};
