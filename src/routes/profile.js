const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('../services/serialize');

const router = express.Router();

const findById = db.prepare('SELECT * FROM users WHERE id = ?');

router.get('/', requireAuth, (req, res) => {
  const user = findById.get(req.session.userId);
  res.json({ user: publicUser(user) });
});

module.exports = router;
