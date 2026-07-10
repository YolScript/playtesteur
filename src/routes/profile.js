const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('../services/serialize');

const router = express.Router();

const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const majMasquerInfos = db.prepare('UPDATE users SET masquer_infos = ? WHERE id = ?');
const majPseudo = db.prepare('UPDATE users SET pseudo = ? WHERE id = ?');

const mailsDuTesteur = db.prepare(`
  SELECT h.id, h.statut, h.date_rejoint, h.date_action,
         a.nom_application, a.google_group_email
  FROM historique_tests h
  JOIN applications a ON a.id = h.application_id
  WHERE h.testeur_id = ?
  ORDER BY h.date_rejoint DESC
  LIMIT 12
`);
const dernierMotifFraud = db.prepare(
  `SELECT raison FROM fraud_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
);

// Chaque "mail débloqué" est une adhésion (historique_tests) au groupe de
// test d'une application. Statut visuel : rouge si l'accès a été retiré
// (Suspendu), orange si l'utilisateur a un avertissement de fraude actif
// (risque de suspension prochaine, raison = dernier motif de fraud_log),
// vert sinon.
function listeMails(user) {
  const raisonRisque =
    user.fraud_warnings > 0 ? dernierMotifFraud.get(user.id)?.raison || null : null;

  return mailsDuTesteur.all(user.id).map((r) => {
    let statut_visuel = 'vert';
    let raison = null;
    if (r.statut === 'Suspendu') {
      statut_visuel = 'rouge';
    } else if (user.fraud_warnings > 0) {
      statut_visuel = 'orange';
      raison = raisonRisque;
    }
    return {
      id: r.id,
      nom_application: r.nom_application,
      google_group_email: r.google_group_email,
      statut: r.statut,
      statut_visuel,
      raison,
      date_rejoint: r.date_rejoint,
    };
  });
}

router.get('/', requireAuth, (req, res) => {
  const user = findById.get(req.session.userId);
  res.json({ user: publicUser(user), mails: listeMails(user) });
});

// Masquage purement visuel de l'email : n'affecte que l'affichage côté
// utilisateur lui-même et dans le panel admin, aucune restriction d'accès.
router.post('/masquer-infos', requireAuth, (req, res) => {
  const masquer = !!req.body?.masquer;
  majMasquerInfos.run(masquer ? 1 : 0, req.session.userId);
  res.json({ user: publicUser(findById.get(req.session.userId)) });
});

// Modification visuelle du pseudo par l'utilisateur
router.post('/pseudo', requireAuth, (req, res) => {
  const pseudo = req.body?.pseudo?.trim();
  if (!pseudo) {
    return res.status(400).json({ erreur: 'Le pseudo ne peut pas être vide.' });
  }
  if (pseudo.length > 50) {
    return res.status(400).json({ erreur: 'Le pseudo ne peut pas dépasser 50 caractères.' });
  }
  majPseudo.run(pseudo, req.session.userId);
  res.json({ user: publicUser(findById.get(req.session.userId)) });
});

module.exports = router;
