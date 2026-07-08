const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('../services/serialize');

const router = express.Router();

const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const updatePseudoPlayStore = db.prepare(
  'UPDATE users SET pseudo_play_store = ? WHERE id = ?'
);

router.get('/', requireAuth, (req, res) => {
  const user = findById.get(req.session.userId);
  res.json({ user: publicUser(user) });
});

router.put('/', requireAuth, (req, res) => {
  const { pseudo_play_store } = req.body || {};
  if (!pseudo_play_store || !pseudo_play_store.trim()) {
    return res.status(400).json({ erreur: 'Le pseudo Play Store est requis.' });
  }
  updatePseudoPlayStore.run(pseudo_play_store.trim(), req.session.userId);
  const user = findById.get(req.session.userId);
  res.json({ user: publicUser(user) });
});

module.exports = router;
