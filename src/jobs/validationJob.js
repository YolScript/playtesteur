// Job périodique : vérifie automatiquement, pour chaque test en cours, si un
// avis correspondant au pseudo Play Store du testeur est apparu — évite au
// testeur de devoir cliquer manuellement "Vérifier mon avis Play Store".
const db = require('../db/init');
const { tenterValiderTest } = require('../services/validation');

const testsEnCours = db.prepare(`SELECT id, application_id, testeur_id FROM historique_tests WHERE statut = 'En_Cours'`);
const findAppById = db.prepare('SELECT * FROM applications WHERE id = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');

async function runValidationJob() {
  const rows = testsEnCours.all();
  let valides = 0;

  for (const row of rows) {
    const app = findAppById.get(row.application_id);
    const user = findUserById.get(row.testeur_id);
    if (!app || !user) continue;

    try {
      const result = await tenterValiderTest({ id: row.id }, app, user);
      if (result.valide) valides++;
    } catch (err) {
      console.error('[validationJob] erreur historique', row.id, err.message);
    }
  }

  if (valides > 0) {
    console.log(`[validationJob] ${valides} test(s) validé(s) automatiquement.`);
  }
}

module.exports = { runValidationJob };
