const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('../services/serialize');
const googleGroups = require('../services/googleGroups');
const { seuilOnboardingEffectif } = require('../services/validation');

const router = express.Router();

const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const majMasquerInfos = db.prepare('UPDATE users SET masquer_infos = ? WHERE id = ?');
const majPseudo = db.prepare('UPDATE users SET pseudo = ? WHERE id = ?');
const compterTestsCompletes = db.prepare(
  `SELECT COUNT(*) AS n FROM historique_tests WHERE testeur_id = ? AND statut = 'Complété'`
);

// Avant que le profil passe "Validé" (TESTS_REQUIS_ONBOARDING tests
// complétés), le score/mail quotidien ne s'incrémente pas encore (voir
// services/validation.js) : la jauge de progression doit refléter cette
// règle plutôt que le palier de score, sinon le message affiché est faux
// ("encore 1 point" alors que ce sont des tests qui manquent, pas des points).
function enrichirUser(user) {
  return {
    ...publicUser(user),
    tests_completes: compterTestsCompletes.get(user.id).n,
    tests_requis_onboarding: seuilOnboardingEffectif(),
  };
}

// Un mail n'est "débloqué" qu'une fois le test validé (avis Play Store
// détecté) : un test tout juste rejoint (statut En_Cours) ne doit pas
// apparaître ici, sinon le testeur voit un mail "actif" avant même d'avoir
// terminé son test.
const mailsDuTesteur = db.prepare(`
  SELECT h.id, h.statut, h.date_rejoint, h.date_action,
         a.nom_application, a.google_group_email
  FROM historique_tests h
  JOIN applications a ON a.id = h.application_id
  WHERE h.testeur_id = ? AND h.statut != 'En_Cours'
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

  // IMPORTANT : chaque entrée doit garder le google_group_email réel de
  // l'application (le mail de groupe que le testeur utilise côté Play
  // Console). Une ancienne "priorisation admin" remplaçait ici le premier
  // mail par l'adresse personnelle de l'admin : les testeurs recevaient
  // alors un mail d'utilisateur du site au lieu du mail Play Console de
  // leur application (bug signalé, retiré).
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
      // Lien "Rejoindre le groupe" pour les groupes non gérés par l'API
      // (groupes @googlegroups.com gratuits) : l'adhésion se fait par le
      // testeur lui-même, ce lien doit donc rester accessible ici.
      group_join_url: googleGroups.estGroupeGere(r.google_group_email)
        ? null
        : googleGroups.urlAdhesion(r.google_group_email),
      statut: r.statut,
      statut_visuel,
      raison,
      date_rejoint: r.date_rejoint,
    };
  });
}

router.get('/', requireAuth, (req, res) => {
  const user = findById.get(req.session.userId);
  res.json({ user: enrichirUser(user), mails: listeMails(user) });
});

// Masquage purement visuel de l'email : n'affecte que l'affichage côté
// utilisateur lui-même et dans le panel admin, aucune restriction d'accès.
router.post('/masquer-infos', requireAuth, (req, res) => {
  const masquer = !!req.body?.masquer;
  majMasquerInfos.run(masquer ? 1 : 0, req.session.userId);
  res.json({ user: enrichirUser(findById.get(req.session.userId)) });
});

// Coût en points des exports de l'éditeur (photo/GIF/vidéo). Le serveur
// décide du coût à partir du type déclaré (jamais du montant fourni par le
// client) et débite le score avant que l'export local (canvas/ffmpeg.wasm)
// ne démarre.
const COUTS_EXPORT_EDITEUR = { photo: 2, gif: 5, video: 10 };
const depenserPoints = db.prepare('UPDATE users SET score_global = score_global - ? WHERE id = ?');

router.post('/depenser-points-export', requireAuth, (req, res) => {
  const { type } = req.body || {};
  const cout = COUTS_EXPORT_EDITEUR[type];
  if (!cout) {
    return res.status(400).json({ erreur: "Type d'export invalide." });
  }

  const user = findById.get(req.session.userId);
  if (user.score_global < cout) {
    return res.status(400).json({
      erreur: `Pas assez de points pour cet export : ${cout} requis, vous avez ${user.score_global}.`,
    });
  }

  depenserPoints.run(cout, user.id);
  logActivity(req.session.userId, 'A exporté un média (éditeur)', `${type} — ${cout} points dépensés`);
  res.json({ user: enrichirUser(findById.get(req.session.userId)) });
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
  res.json({ user: enrichirUser(findById.get(req.session.userId)) });
});

module.exports = router;
