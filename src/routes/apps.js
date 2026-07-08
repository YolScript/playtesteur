const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicApplication, publicUser } = require('../services/serialize');
const googleGroups = require('../services/googleGroups');
const playReviews = require('../services/playReviews');
const { applyDailyTestGain } = require('../services/scoring');

const router = express.Router();

const insertApp = db.prepare(`
  INSERT INTO applications (developpeur_id, nom_application, description, logo_url, package_name, google_group_email, screenshots, video_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const findAppById = db.prepare('SELECT * FROM applications WHERE id = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const countDistinctCompletedTests = db.prepare(
  `SELECT COUNT(*) AS n FROM historique_tests WHERE testeur_id = ? AND statut = 'Complété'`
);
const findHistorique = db.prepare(
  'SELECT * FROM historique_tests WHERE testeur_id = ? AND application_id = ?'
);
const insertHistorique = db.prepare(
  `INSERT INTO historique_tests (testeur_id, application_id, statut) VALUES (?, ?, 'En_Cours')`
);
const completerHistorique = db.prepare(
  `UPDATE historique_tests SET statut = 'Complété', date_action = datetime('now') WHERE id = ?`
);
const incrementerMailsApp = db.prepare(
  'UPDATE applications SET mails_recrutes = mails_recrutes + 1 WHERE id = ?'
);
const marquerAppComplete = db.prepare(
  `UPDATE applications SET statut = 'Complété' WHERE id = ? AND mails_recrutes >= 12`
);
const validerProfil = db.prepare(
  `UPDATE users SET statut_profil = 'Validé', mails_debloques = MAX(mails_debloques, 1) WHERE id = ?`
);
const appliquerGainQuotidien = db.prepare(
  'UPDATE users SET score_global = ?, mails_debloques = ?, derniere_date_test = datetime(\'now\') WHERE id = ?'
);
const marquerDateTestSansGain = db.prepare(
  "UPDATE users SET derniere_date_test = datetime('now') WHERE id = ?"
);

// Catalogue public : toutes les apps en recrutement, hors mes propres apps et
// hors apps déjà testées ou rejointes (anti-doublon : une fois testée, une
// app est définitivement masquée pour ce testeur).
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.* FROM applications a
       WHERE a.statut = 'En_Cours'
         AND a.developpeur_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM historique_tests h
           WHERE h.application_id = a.id AND h.testeur_id = ?
         )
       ORDER BY a.mails_recrutes ASC, a.created_at ASC`
    )
    .all(req.session.userId, req.session.userId);
  res.json({ applications: rows.map(publicApplication) });
});

router.get('/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM applications WHERE developpeur_id = ? ORDER BY created_at DESC')
    .all(req.session.userId);
  res.json({ applications: rows.map(publicApplication) });
});

router.get('/:id', requireAuth, (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });

  const historique = findHistorique.get(req.session.userId, app.id);
  res.json({
    application: publicApplication(app),
    mon_historique: historique ? { statut: historique.statut, date_action: historique.date_action } : null,
  });
});

// Aperçu des derniers avis publics Play Store de l'application (indépendant
// du pseudo d'un testeur particulier), pour donner envie de la tester.
router.get('/:id/avis', requireAuth, async (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });

  try {
    const avis = await playReviews.listerAvis(app.package_name, 10);
    res.json({ avis });
  } catch (err) {
    console.error('[apps.avis]', err);
    res.status(500).json({ erreur: 'Impossible de récupérer les avis pour le moment.' });
  }
});

// Pré-remplit le formulaire de soumission depuis la fiche Play Console
// (titre, description, icône) sans créer l'application.
router.post('/import', requireAuth, async (req, res) => {
  const { package_name } = req.body || {};
  try {
    const fiche = await playReviews.importerFicheApp(package_name);
    res.json(fiche);
  } catch (err) {
    res.status(400).json({ erreur: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { nom_application, description, logo_url, package_name, screenshots, video_url } = req.body || {};
  if (!nom_application || !nom_application.trim()) {
    return res.status(400).json({ erreur: "Le nom de l'application est requis." });
  }

  try {
    const info = insertApp.run(
      req.session.userId,
      nom_application.trim(),
      description || null,
      logo_url || null,
      package_name || null,
      null,
      Array.isArray(screenshots) && screenshots.length ? JSON.stringify(screenshots) : null,
      video_url || null
    );
    const appId = info.lastInsertRowid;

    const groupEmail = await googleGroups.creerGroupe(appId, nom_application.trim());
    db.prepare('UPDATE applications SET google_group_email = ? WHERE id = ?').run(groupEmail, appId);

    const app = findAppById.get(appId);
    res.status(201).json({ application: publicApplication(app) });
  } catch (err) {
    console.error('[apps.create]', err);
    res.status(500).json({ erreur: "Impossible de créer l'application pour le moment." });
  }
});

// Édition des infos d'une application par son créateur (nom, description,
// logo, package). Le groupe Google et le compteur de testeurs ne changent pas.
router.put('/:id', requireAuth, (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });
  if (app.developpeur_id !== req.session.userId) {
    return res.status(403).json({ erreur: "Vous n'êtes pas le créateur de cette application." });
  }

  const { nom_application, description, logo_url, package_name, screenshots, video_url } = req.body || {};
  if (!nom_application || !nom_application.trim()) {
    return res.status(400).json({ erreur: "Le nom de l'application est requis." });
  }

  db.prepare(
    'UPDATE applications SET nom_application = ?, description = ?, logo_url = ?, package_name = ?, screenshots = ?, video_url = ? WHERE id = ?'
  ).run(
    nom_application.trim(),
    description || null,
    logo_url || null,
    package_name || null,
    Array.isArray(screenshots) && screenshots.length ? JSON.stringify(screenshots) : null,
    video_url || null,
    app.id
  );

  res.json({ application: publicApplication(findAppById.get(app.id)) });
});

// Rejoindre le test d'une application : ajout immédiat au Google Group.
router.post('/:id/join', requireAuth, async (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });
  if (app.developpeur_id === req.session.userId) {
    return res.status(400).json({ erreur: 'Vous ne pouvez pas tester votre propre application.' });
  }
  if (app.statut !== 'En_Cours') {
    return res.status(400).json({ erreur: "Cette application n'accepte plus de nouveaux testeurs." });
  }
  if (findHistorique.get(req.session.userId, app.id)) {
    return res.status(409).json({ erreur: 'Vous avez déjà rejoint ou testé cette application.' });
  }

  const user = findUserById.get(req.session.userId);

  try {
    if (app.google_group_email) {
      await googleGroups.ajouterMembre(app.google_group_email, user.email);
    }
    insertHistorique.run(req.session.userId, app.id);
    res.status(201).json({ ok: true, message: 'Accès accordé. Installez l’application puis laissez un avis pour valider votre test.' });
  } catch (err) {
    console.error('[apps.join]', err);
    res.status(500).json({ erreur: 'Impossible de vous ajouter au groupe de test pour le moment.' });
  }
});

// Valide le test quotidien : interroge l'API Google Play Reviews à la
// recherche d'un avis laissé par le pseudo Play Store du testeur.
router.post('/:id/valider', requireAuth, async (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });

  const historique = findHistorique.get(req.session.userId, app.id);
  if (!historique || historique.statut !== 'En_Cours') {
    return res.status(400).json({ erreur: "Vous n'avez pas de test en cours pour cette application." });
  }

  const user = findUserById.get(req.session.userId);
  if (!user.pseudo_play_store) {
    return res.status(400).json({ erreur: "Renseignez d'abord votre pseudo Play Store dans votre profil." });
  }

  try {
    const reviewId = await playReviews.trouverAvisDuTesteur(app.package_name, user.pseudo_play_store);
    if (!reviewId) {
      return res.status(404).json({
        erreur: "Aucun avis correspondant à votre pseudo Play Store n'a été détecté pour le moment. Réessayez après publication de l'avis.",
      });
    }

    completerHistorique.run(historique.id);
    incrementerMailsApp.run(app.id);
    marquerAppComplete.run(app.id);

    const nbTestsCompletes = countDistinctCompletedTests.get(req.session.userId).n;

    let userMisAJour;
    if (user.statut_profil !== 'Validé') {
      if (nbTestsCompletes >= 10) {
        // Ticket d'entrée franchi : profil validé + 1er mail débloqué.
        validerProfil.run(req.session.userId);
        marquerDateTestSansGain.run(req.session.userId);
      } else {
        // Encore dans les 10 tests obligatoires : pas de gain de score/mail.
        marquerDateTestSansGain.run(req.session.userId);
      }
    } else {
      const gain = applyDailyTestGain(user, new Date().toISOString());
      appliquerGainQuotidien.run(gain.score_global, gain.mails_debloques, req.session.userId);
    }
    userMisAJour = findUserById.get(req.session.userId);

    res.json({ ok: true, reviewId, user: publicUser(userMisAJour) });
  } catch (err) {
    console.error('[apps.valider]', err);
    res.status(500).json({ erreur: "Impossible de vérifier l'avis pour le moment." });
  }
});

module.exports = router;
