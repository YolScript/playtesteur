const db = require('../db/init');

// Compte propriétaire du site : seul autorisé à voir/modifier la
// configuration du site (page Compte). Volontairement codé en dur — cette
// valeur ne doit pas être modifiable depuis l'interface qu'elle protège.
const SUPER_ADMIN_EMAIL = 'agorasjohn@gmail.com';

const findEmailById = db.prepare('SELECT email FROM users WHERE id = ?');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ erreur: 'Authentification requise.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'administrator') {
    return res.status(403).json({ erreur: 'Accès administrateur requis.' });
  }
  next();
}

// Vérifie l'email EN BASE (pas en session) : même un autre administrateur
// ne peut pas accéder à la configuration du site.
function requireSuperAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'administrator') {
    return res.status(403).json({ erreur: 'Accès administrateur requis.' });
  }
  const user = findEmailById.get(req.session.userId);
  if (!user || String(user.email).toLowerCase() !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ erreur: 'Réservé au propriétaire du site.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, SUPER_ADMIN_EMAIL };
