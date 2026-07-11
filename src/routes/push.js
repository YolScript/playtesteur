const express = require('express');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/pushNotifications');

const router = express.Router();

router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.publicKey });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ erreur: 'Abonnement push invalide.' });
  }
  push.sAbonner(req.session.userId, subscription);
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) push.seDesabonner(endpoint);
  res.json({ ok: true });
});

module.exports = router;
