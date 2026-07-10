const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { publicApplication, publicUser } = require('../services/serialize');
const googleGroups = require('../services/googleGroups');
const playReviews = require('../services/playReviews');
const { tenterValiderTest } = require('../services/validation');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const insertApp = db.prepare(`
  INSERT INTO applications (developpeur_id, nom_application, description, logo_url, package_name, google_group_email, screenshots, video_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const findAppById = db.prepare('SELECT * FROM applications WHERE id = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const findHistorique = db.prepare(
  'SELECT * FROM historique_tests WHERE testeur_id = ? AND application_id = ?'
);
const insertHistorique = db.prepare(
  `INSERT INTO historique_tests (testeur_id, application_id, statut) VALUES (?, ?, 'En_Cours')`
);

// Catalogue public : toutes les apps en recrutement, hors mes propres apps et
// hors apps déjà testées ou rejointes (anti-doublon : une fois testée, une
// app est définitivement masquée pour ce testeur).
// Les administrateurs peuvent voir toutes les applications (y compris les leurs,
// les déjà testées/rejointes et les complétées).
router.get('/', requireAuth, (req, res) => {
  const isAdmin = req.session.role === 'administrator';
  let rows;
  if (isAdmin) {
    rows = db
      .prepare(
        `SELECT a.* FROM applications a
         ORDER BY a.mails_recrutes ASC, a.created_at ASC`
      )
      .all();
  } else {
    rows = db
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
  }
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

// Email du compte de service à ajouter dans Play Console (Utilisateurs et
// autorisations) pour que l'import automatique de fiche fonctionne.
router.get('/service-account', requireAuth, (req, res) => {
  res.json({ email: playReviews.serviceAccountEmail });
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

// Valide une adresse de groupe fournie par le développeur (groupe Google
// grand public gratuit, ou groupe Workspace s'il en a un).
function validerGroupeFourni(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) {
    throw new Error("L'adresse du groupe Google n'est pas une adresse email valide.");
  }
  return e;
}

router.post('/', requireAuth, async (req, res) => {
  const { nom_application, description, logo_url, package_name, screenshots, video_url, google_group_email } = req.body || {};
  if (!nom_application || !nom_application.trim()) {
    return res.status(400).json({ erreur: "Le nom de l'application est requis." });
  }

  let groupeFourni;
  try {
    groupeFourni = validerGroupeFourni(google_group_email);
  } catch (err) {
    return res.status(400).json({ erreur: err.message });
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

    // Groupe fourni par le développeur (gratuit, sans Workspace) prioritaire ;
    // sinon création automatique via l'API si un Workspace est configuré
    // (en MODE DEV le groupe auto-créé est fictif et ne sert qu'aux tests).
    const groupEmail = groupeFourni || (await googleGroups.creerGroupe(appId, nom_application.trim()));
    db.prepare('UPDATE applications SET google_group_email = ? WHERE id = ?').run(groupEmail, appId);

    const app = findAppById.get(appId);
    logActivity(req.session.userId, 'A soumis une application', nom_application.trim());
    res.status(201).json({ application: publicApplication(app) });
  } catch (err) {
    console.error('[apps.create]', err);
    res.status(500).json({ erreur: "Impossible de créer l'application pour le moment." });
  }
});

// Édition des infos d'une application par son créateur (nom, description,
// logo, package, groupe de testeurs). Le compteur de testeurs ne change pas.
router.put('/:id', requireAuth, (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });
  if (app.developpeur_id !== req.session.userId) {
    return res.status(403).json({ erreur: "Vous n'êtes pas le créateur de cette application." });
  }

  const { nom_application, description, logo_url, package_name, screenshots, video_url, google_group_email } = req.body || {};
  if (!nom_application || !nom_application.trim()) {
    return res.status(400).json({ erreur: "Le nom de l'application est requis." });
  }

  // Le développeur peut renseigner/corriger son groupe de testeurs après
  // coup (indispensable pour brancher un vrai groupe @googlegroups.com sur
  // une app créée avant cette fonctionnalité). Champ absent = inchangé.
  let groupeFourni = app.google_group_email;
  if (google_group_email !== undefined) {
    try {
      groupeFourni = validerGroupeFourni(google_group_email) || app.google_group_email;
    } catch (err) {
      return res.status(400).json({ erreur: err.message });
    }
  }

  db.prepare(
    'UPDATE applications SET nom_application = ?, description = ?, logo_url = ?, package_name = ?, screenshots = ?, video_url = ?, google_group_email = ? WHERE id = ?'
  ).run(
    nom_application.trim(),
    description || null,
    logo_url || null,
    package_name || null,
    Array.isArray(screenshots) && screenshots.length ? JSON.stringify(screenshots) : null,
    video_url || null,
    groupeFourni,
    app.id
  );

  logActivity(req.session.userId, 'A modifié une application', nom_application.trim());
  res.json({ application: publicApplication(findAppById.get(app.id)) });
});

// Rejoindre le test d'une application. Deux cas :
// - Groupe géré par l'API (Workspace configuré) : ajout automatique du mail.
// - Groupe externe (@googlegroups.com fourni par le développeur, gratuit) :
//   l'API ne peut pas ajouter le membre — on renvoie l'URL du groupe et le
//   testeur clique lui-même "Rejoindre le groupe" (adhésion en un clic si le
//   groupe est réglé sur "tout le monde peut rejoindre").
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
    const groupeGere = googleGroups.estGroupeGere(app.google_group_email);
    if (app.google_group_email && groupeGere) {
      await googleGroups.ajouterMembre(app.google_group_email, user.email);
    }
    insertHistorique.run(req.session.userId, app.id);
    logActivity(req.session.userId, 'A rejoint un test', app.nom_application);

    const joinUrl = !groupeGere ? googleGroups.urlAdhesion(app.google_group_email) : null;
    res.status(201).json({
      ok: true,
      join_url: joinUrl,
      message: joinUrl
        ? 'Dernière étape : cliquez sur "Rejoindre le groupe Google" pour activer votre accès testeur, puis installez l’application et laissez un avis.'
        : 'Accès accordé. Installez l’application puis laissez un avis pour valider votre test.',
    });
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

  try {
    const result = await tenterValiderTest(historique, app, user);
    if (!result.valide) {
      if (result.raison === 'pseudo_manquant') {
        return res.status(400).json({ erreur: "Renseignez d'abord votre pseudo Play Store dans votre profil." });
      }
      return res.status(404).json({
        erreur: "Aucun avis correspondant à votre pseudo Play Store n'a été détecté pour le moment. Réessayez après publication de l'avis.",
      });
    }
    res.json({ ok: true, reviewId: result.reviewId, user: publicUser(result.user) });
  } catch (err) {
    console.error('[apps.valider]', err);
    res.status(500).json({ erreur: "Impossible de vérifier l'avis pour le moment." });
  }
});

// Accès au chat : le créateur de l'app, ou un testeur ayant rejoint le test
// (peu importe le statut de son historique).
function peutAccederAuChat(app, userId) {
  if (app.developpeur_id === userId) return true;
  return !!findHistorique.get(userId, app.id);
}

// Chat de l'application : messages entre le créateur et les testeurs inscrits.
router.get('/:id/messages', requireAuth, (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });
  if (!peutAccederAuChat(app, req.session.userId)) {
    return res.status(403).json({ erreur: "Vous devez avoir rejoint le test pour accéder au chat." });
  }

  const messages = db
    .prepare(
      `SELECT m.id, m.texte, m.created_at, u.id AS user_id, u.pseudo, u.avatar_url,
              (u.id = ?) AS de_moi, (u.id = a.developpeur_id) AS du_createur
       FROM messages m
       JOIN users u ON u.id = m.user_id
       JOIN applications a ON a.id = m.application_id
       WHERE m.application_id = ?
       ORDER BY m.created_at ASC
       LIMIT 200`
    )
    .all(req.session.userId, app.id);

  res.json({
    messages: messages.map((m) => ({ ...m, de_moi: !!m.de_moi, du_createur: !!m.du_createur })),
  });
});

router.post('/:id/messages', requireAuth, (req, res) => {
  const app = findAppById.get(req.params.id);
  if (!app) return res.status(404).json({ erreur: 'Application introuvable.' });
  if (!peutAccederAuChat(app, req.session.userId)) {
    return res.status(403).json({ erreur: "Vous devez avoir rejoint le test pour accéder au chat." });
  }

  const texte = (req.body?.texte || '').trim().slice(0, 1000);
  if (!texte) {
    return res.status(400).json({ erreur: 'Le message ne peut pas être vide.' });
  }

  db.prepare('INSERT INTO messages (application_id, user_id, texte) VALUES (?, ?, ?)').run(
    app.id,
    req.session.userId,
    texte
  );

  res.status(201).json({ ok: true });
});

module.exports = router;
