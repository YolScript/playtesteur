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

module.exports = { requireAuth, requireAdmin };
