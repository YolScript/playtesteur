const express = require('express');
const db = require('../db/init');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { publicUser, publicApplication } = require('../services/serialize');
const googleGroups = require('../services/googleGroups');
const googleAuth = require('../services/googleAuth');
const { ajusterScore } = require('../services/sanctions');
const { logActivity } = require('../services/activityLog');
const siteConfig = require('../services/siteConfig');
const playReviews = require('../services/playReviews');

const router = express.Router();

const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const majFraudWarnings = db.prepare(
  'UPDATE users SET fraud_warnings = ?, suspendu = ? WHERE id = ?'
);
const insertFraudLog = db.prepare(
  'INSERT INTO fraud_log (user_id, raison) VALUES (?, ?)'
);
const majSuspendu = db.prepare('UPDATE users SET suspendu = ? WHERE id = ?');
const groupesActifsDuTesteur = db.prepare(`
  SELECT h.id AS historique_id, h.application_id, a.google_group_email
  FROM historique_tests h
  JOIN applications a ON a.id = h.application_id
  WHERE h.testeur_id = ? AND h.statut = 'En_Cours'
`);
const suspendreHistorique = db.prepare(`UPDATE historique_tests SET statut = 'Suspendu' WHERE id = ?`);
const decrementerMailsApp = db.prepare(
  'UPDATE applications SET mails_recrutes = MAX(0, mails_recrutes - 1) WHERE id = ?'
);

router.use(requireAdmin);

router.get('/stats', (req, res) => {
  const nbUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const nbValides = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE statut_profil = 'Validé'`).get().n;
  const nbSuspendus = db.prepare('SELECT COUNT(*) AS n FROM users WHERE suspendu = 1').get().n;
  const nbApps = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  const nbAppsEnCours = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE statut = 'En_Cours'`).get().n;
  const nbAppsCompletes = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE statut = 'Complété'`).get().n;
  const nbAppsTerminees = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE statut = 'Terminé_Inactif'`).get().n;

  res.json({
    utilisateurs: { total: nbUsers, valides: nbValides, suspendus: nbSuspendus },
    applications: { total: nbApps, en_cours: nbAppsEnCours, completes: nbAppsCompletes, terminees: nbAppsTerminees },
    api_google: {
      auth_mode: googleAuth.devMode ? 'DEV (simulé)' : 'PRODUCTION',
      groups_mode: googleGroups.devMode ? 'DEV (simulé)' : 'PRODUCTION',
      reviews_mode: playReviews.devMode ? 'DEV (simulé)' : 'PRODUCTION',
    },
  });
});

/* --------------------------------------------------------------------
   Configuration du site (page Compte) : renseigne TOUTES les intégrations
   sans toucher au .env ni redémarrer le serveur. Réservé au propriétaire
   du site (requireSuperAdmin, email vérifié en base) — les autres
   administrateurs n'y ont pas accès.
   -------------------------------------------------------------------- */
function etatConfig() {
  const reglages = siteConfig.DEFINITIONS.map((d) => ({
    cle: d.cle,
    label: d.label,
    aide: d.aide,
    secrete: d.secrete,
    type: d.type,
    effet: d.effet,
    groupe: d.groupe,
    ...(d.secrete
      ? { presente: !!(siteConfig.lire(d.cle) || process.env[d.cle]) }
      : { valeur: siteConfig.lire(d.cle) || process.env[d.cle] || '' }),
  }));
  return {
    reglages,
    modes: {
      auth_mode: googleAuth.devMode ? 'DEV (simulé)' : 'PRODUCTION',
      groups_mode: googleGroups.devMode ? 'DEV (simulé)' : 'PRODUCTION',
      reviews_mode: playReviews.devMode ? 'DEV (simulé)' : 'PRODUCTION',
    },
    service_account_email: playReviews.serviceAccountEmail || null,
  };
}

router.get('/config', requireSuperAdmin, (req, res) => {
  res.json(etatConfig());
});

router.post('/config', requireSuperAdmin, (req, res) => {
  const entrees = req.body || {};
  try {
    for (const definition of siteConfig.DEFINITIONS) {
      const { cle } = definition;
      if (entrees[cle] === undefined) continue; // champ absent = inchangé
      const valeur = String(entrees[cle] || '').trim();
      if (definition.type === 'json' && valeur) {
        try {
          JSON.parse(valeur);
        } catch (_) {
          return res.status(400).json({
            erreur: `"${definition.label}" doit être le contenu JSON complet du fichier téléchargé depuis Google Cloud.`,
          });
        }
      }
      siteConfig.definir(cle, valeur);
    }
    logActivity(req.session.userId, 'A modifié la configuration du site');
    res.json(etatConfig());
  } catch (err) {
    console.error('[admin.config]', err);
    res.status(500).json({ erreur: "Impossible d'enregistrer la configuration." });
  }
});

router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY score_global DESC').all();
  res.json({ users: rows.map(publicUser).map((u, i) => ({ ...u, suspendu: !!rows[i].suspendu })) });
});

router.get('/apps', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.pseudo AS dev_pseudo, u.email AS dev_email
       FROM applications a
       JOIN users u ON u.id = a.developpeur_id
       ORDER BY a.created_at DESC`
    )
    .all();
  res.json({
    applications: rows.map((a) => ({
      ...publicApplication(a),
      developpeur: { pseudo: a.dev_pseudo, email: a.dev_email },
    })),
  });
});

// Système à 3 avertissements pour tentative de fraude. Au 3e, le compte est
// suspendu et éjecté de tous les groupes actifs.
router.post('/users/:id/warn', async (req, res) => {
  const { raison } = req.body || {};
  const user = findUserById.get(req.params.id);
  if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

  const nouveauxWarnings = user.fraud_warnings + 1;
  const doitSuspendre = nouveauxWarnings >= 3;
  majFraudWarnings.run(nouveauxWarnings, doitSuspendre ? 1 : user.suspendu, user.id);
  insertFraudLog.run(user.id, raison || 'Non précisée');
  logActivity(user.id, 'A reçu un avertissement admin', raison || 'Non précisée');

  if (doitSuspendre) {
    await ejecterTousLesGroupes(user);
  }

  res.json({ user: publicUser(findUserById.get(user.id)) });
});

router.post('/users/:id/exclude', async (req, res) => {
  const user = findUserById.get(req.params.id);
  if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

  majSuspendu.run(1, user.id);
  await ejecterTousLesGroupes(user);
  insertFraudLog.run(user.id, req.body?.raison || 'Exclusion manuelle administrateur');
  logActivity(user.id, 'Exclu par un administrateur', req.body?.raison || 'Non précisée');

  res.json({ user: publicUser(findUserById.get(user.id)) });
});

router.post('/users/:id/reinstate', (req, res) => {
  const user = findUserById.get(req.params.id);
  if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

  majFraudWarnings.run(0, 0, user.id);
  res.json({ user: publicUser(findUserById.get(user.id)) });
});

// Ajustement manuel du score (+1 / +5 / +10 / -20 / mise à 0 pour un "ban").
// Répercute automatiquement l'éjection des mails/groupes si le score
// descend sous le palier correspondant (même règle que le job de minuit).
router.post('/users/:id/adjust-score', async (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta) || Math.abs(delta) > 100) {
    return res.status(400).json({ erreur: 'Delta de score invalide.' });
  }
  try {
    const user = await ajusterScore(req.params.id, delta);
    logActivity(user.id, `Score ajusté par un admin (${delta > 0 ? '+' : ''}${delta})`);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(404).json({ erreur: err.message });
  }
});

// Console d'activité globale : dernières actions de tous les utilisateurs.
router.get('/logs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT l.id, l.action, l.details, l.created_at, u.id AS user_id, u.pseudo, u.email
       FROM activity_log l
       JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC
       LIMIT 200`
    )
    .all();
  res.json({ logs: rows });
});

// Console d'activité d'un utilisateur précis.
router.get('/users/:id/logs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, action, details, created_at
       FROM activity_log
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all(req.params.id);
  res.json({ logs: rows });
});

// Liste des testeurs ayant rejoint/validé un test pour une application
// (quel compte a généré quel mail actif).
router.get('/apps/:id/testeurs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.pseudo, u.email, u.masquer_infos, h.statut, h.date_rejoint, h.date_action
       FROM historique_tests h
       JOIN users u ON u.id = h.testeur_id
       WHERE h.application_id = ?
       ORDER BY h.date_action DESC, h.date_rejoint DESC`
    )
    .all(req.params.id);
  res.json({ testeurs: rows });
});

async function ejecterTousLesGroupes(user) {
  const rows = groupesActifsDuTesteur.all(user.id);
  for (const row of rows) {
    suspendreHistorique.run(row.historique_id);
    decrementerMailsApp.run(row.application_id);
    if (row.google_group_email) {
      try {
        await googleGroups.retirerMembre(row.google_group_email, user.email);
      } catch (err) {
        console.error('[admin.exclude] éjection groupe échouée', row.google_group_email, err.message);
      }
    }
  }
}

module.exports = router;
