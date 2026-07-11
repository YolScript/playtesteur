const express = require('express');
const db = require('../db/init');
const { publicUser } = require('../services/serialize');
const googleAuth = require('../services/googleAuth');
const { logActivity } = require('../services/activityLog');
const push = require('../services/pushNotifications');

const router = express.Router();

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const findByGoogleId = db.prepare('SELECT * FROM users WHERE google_id = ?');
const insertUser = db.prepare(`
  INSERT INTO users (pseudo, email, google_id, avatar_url, pseudo_play_store)
  VALUES (?, ?, ?, ?, ?)
`);
const majProfilGoogle = db.prepare(
  'UPDATE users SET google_id = ?, avatar_url = ?, pseudo_play_store = ? WHERE id = ?'
);

// Crée le compte au premier login Google, ou relie google_id à un compte
// existant retrouvé par email (cas d'un compte créé avant liaison Google).
// Le pseudo Play Store est resynchronisé avec le nom du compte Google à CHAQUE
// connexion (non modifiable manuellement) : c'est ce pseudo que le serveur
// recherche pour valider les tests quotidiens. Le pseudo visuel (pseudo), lui,
// n'est défini qu'à la création et peut ensuite être personnalisé.
function connecterOuCreer(profile) {
  const existant = findByGoogleId.get(profile.googleId) || findByEmail.get(profile.email);
  if (existant) {
    majProfilGoogle.run(profile.googleId, profile.avatarUrl, profile.pseudo, existant.id);
    return findById.get(existant.id);
  }
  const info = insertUser.run(profile.pseudo, profile.email, profile.googleId, profile.avatarUrl, profile.pseudo);
  push.notifierNouvelUtilisateur(profile.pseudo).catch((err) => console.error('[push]', err.message));
  return findById.get(info.lastInsertRowid);
}

function ouvrirSession(req, user) {
  req.session.userId = user.id;
  req.session.role = user.role;
  logActivity(user.id, 'Connexion');
}

router.get('/config', (req, res) => {
  res.json({ googleAuthDevMode: googleAuth.devMode });
});

// Redirige vers l'écran de consentement Google.
router.get('/google', (req, res) => {
  if (googleAuth.devMode) {
    return res.status(400).json({ erreur: 'Mode dev actif : utilisez /api/auth/dev-login.' });
  }
  res.redirect(googleAuth.getAuthUrl());
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) throw new Error(error || 'Code OAuth manquant.');
    const profile = await googleAuth.handleCallback(code);
    const user = connecterOuCreer(profile);
    ouvrirSession(req, user);
    res.redirect('/#/dashboard');
  } catch (err) {
    console.error('[auth.google.callback]', err);
    res.redirect('/#/login');
  }
});

// MODE DEV uniquement : simule une connexion Google sans credentials OAuth réelles.
router.post('/dev-login', (req, res) => {
  if (!googleAuth.devMode) {
    return res.status(403).json({ erreur: 'Le mode dev est désactivé (OAuth Google configuré).' });
  }
  const { email, pseudo } = req.body || {};
  if (!email || !pseudo) {
    return res.status(400).json({ erreur: 'Email et pseudo sont requis en mode dev.' });
  }
  const user = connecterOuCreer({
    googleId: `dev-${email.trim().toLowerCase()}`,
    email: email.trim().toLowerCase(),
    pseudo: pseudo.trim(),
    avatarUrl: null,
  });
  ouvrirSession(req, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = findById.get(req.session.userId);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

module.exports = router;
