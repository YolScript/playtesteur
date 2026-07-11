// Job exécuté chaque nuit à minuit : sanction d'inactivité + clôture des
// applications dont le créateur n'est plus réciproque depuis 3 jours.
const db = require('../db/init');
const { ajusterScore } = require('../services/sanctions');
const { MIDNIGHT_PENALTY } = require('../services/scoring');

const listeValides = db.prepare(`SELECT * FROM users WHERE statut_profil = 'Validé' AND suspendu = 0`);

const appsCompletesAClore = db.prepare(`
  SELECT a.*, u.derniere_date_test AS dev_derniere_date_test
  FROM applications a
  JOIN users u ON u.id = a.developpeur_id
  WHERE a.statut = 'Complété'
`);
const cloreApp = db.prepare(`UPDATE applications SET statut = 'Terminé_Inactif' WHERE id = ?`);

// Mails débloqués (tests "Complété") dont le testeur est inactif depuis 3
// jours (même règle que cloreApplicationsInactives ci-dessus, appliquée au
// testeur plutôt qu'au développeur) : le slot est libéré pour qu'un testeur
// actif puisse le reprendre — tout remplacement passe par le même parcours
// d'avis noté (1 à 5 étoiles), donc vient nécessairement "avec une note".
const historiquesCompletesAvecTesteur = db.prepare(`
  SELECT h.id, h.application_id, u.derniere_date_test
  FROM historique_tests h
  JOIN users u ON u.id = h.testeur_id
  WHERE h.statut = 'Complété'
`);
const suspendreHistoriqueInactif = db.prepare(`UPDATE historique_tests SET statut = 'Suspendu' WHERE id = ?`);
const decrementerMailsAppInactif = db.prepare(
  'UPDATE applications SET mails_recrutes = MAX(0, mails_recrutes - 1) WHERE id = ?'
);
const reouvrirAppSiComplete = db.prepare(
  `UPDATE applications SET statut = 'En_Cours' WHERE id = ? AND statut = 'Complété'`
);

async function appliquerSanctionsInactivite() {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const utilisateurs = listeValides.all();

  for (const user of utilisateurs) {
    const testeAujourdhui = user.derniere_date_test && user.derniere_date_test.slice(0, 10) === aujourdhui;
    if (testeAujourdhui) continue;

    await ajusterScore(user.id, -MIDNIGHT_PENALTY);
  }
}

async function cloreApplicationsInactives() {
  const TROIS_JOURS_MS = 3 * 24 * 60 * 60 * 1000;
  const maintenant = Date.now();
  const apps = appsCompletesAClore.all();

  for (const app of apps) {
    const derniereActivite = app.dev_derniere_date_test
      ? Date.parse(app.dev_derniere_date_test.replace(' ', 'T') + 'Z')
      : 0;
    if (maintenant - derniereActivite >= TROIS_JOURS_MS) {
      cloreApp.run(app.id);
    }
  }
}

async function remplacerMailsTesteursInactifs() {
  const TROIS_JOURS_MS = 3 * 24 * 60 * 60 * 1000;
  const maintenant = Date.now();
  const rows = historiquesCompletesAvecTesteur.all();
  let liberes = 0;

  for (const row of rows) {
    const derniereActivite = row.derniere_date_test
      ? Date.parse(row.derniere_date_test.replace(' ', 'T') + 'Z')
      : 0;
    if (maintenant - derniereActivite >= TROIS_JOURS_MS) {
      suspendreHistoriqueInactif.run(row.id);
      decrementerMailsAppInactif.run(row.application_id);
      reouvrirAppSiComplete.run(row.application_id);
      liberes++;
    }
  }

  if (liberes > 0) {
    console.log(`[midnightJob] ${liberes} mail(s) libéré(s) pour testeur inactif depuis 3 jours.`);
  }
}

async function runMidnightJob() {
  console.log('[midnightJob] Démarrage du job de minuit...');
  try {
    await appliquerSanctionsInactivite();
    await cloreApplicationsInactives();
    await remplacerMailsTesteursInactifs();
    console.log('[midnightJob] Terminé.');
  } catch (err) {
    console.error('[midnightJob] Erreur inattendue :', err);
  }
}

module.exports = { runMidnightJob, remplacerMailsTesteursInactifs };
