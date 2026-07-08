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

async function runMidnightJob() {
  console.log('[midnightJob] Démarrage du job de minuit...');
  try {
    await appliquerSanctionsInactivite();
    await cloreApplicationsInactives();
    console.log('[midnightJob] Terminé.');
  } catch (err) {
    console.error('[midnightJob] Erreur inattendue :', err);
  }
}

module.exports = { runMidnightJob };
