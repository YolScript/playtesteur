// Logique de validation d'un test (partagée entre la route manuelle
// "Vérifier mon avis Play Store" et le job de vérification automatique).
const db = require('../db/init');
const playReviews = require('./playReviews');
const { applyDailyTestGain } = require('./scoring');
const { logActivity } = require('./activityLog');

const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const completerHistorique = db.prepare(
  `UPDATE historique_tests SET statut = 'Complété', date_action = datetime('now') WHERE id = ?`
);
const incrementerMailsApp = db.prepare(
  'UPDATE applications SET mails_recrutes = mails_recrutes + 1 WHERE id = ?'
);
const marquerAppComplete = db.prepare(
  `UPDATE applications SET statut = 'Complété' WHERE id = ? AND mails_recrutes >= 12`
);
const countDistinctCompletedTests = db.prepare(
  `SELECT COUNT(*) AS n FROM historique_tests WHERE testeur_id = ? AND statut = 'Complété'`
);
const validerProfil = db.prepare(
  `UPDATE users SET statut_profil = 'Validé', mails_debloques = MAX(mails_debloques, 1) WHERE id = ?`
);
const appliquerGainQuotidien = db.prepare(
  "UPDATE users SET score_global = ?, mails_debloques = ?, derniere_date_test = datetime('now') WHERE id = ?"
);
const marquerDateTestSansGain = db.prepare("UPDATE users SET derniere_date_test = datetime('now') WHERE id = ?");

// Tente de valider un test en cours en interrogeant l'API Play Reviews.
// Retourne { valide: false, raison } ou { valide: true, reviewId, user }.
async function tenterValiderTest(historique, app, user) {
  if (!user.pseudo_play_store) {
    return { valide: false, raison: 'pseudo_manquant' };
  }

  const { reviewId, totalVus } = await playReviews.trouverAvisDuTesteur(app.package_name, user.pseudo_play_store);
  if (!reviewId) {
    return { valide: false, raison: 'avis_non_trouve', totalVus };
  }

  completerHistorique.run(historique.id);
  incrementerMailsApp.run(app.id);
  marquerAppComplete.run(app.id);

  const nbTestsCompletes = countDistinctCompletedTests.get(user.id).n;

  if (user.statut_profil !== 'Validé') {
    if (nbTestsCompletes >= 10) {
      // Ticket d'entrée franchi : profil validé + 1er mail débloqué.
      validerProfil.run(user.id);
    }
    marquerDateTestSansGain.run(user.id);
  } else {
    const gain = applyDailyTestGain(user, new Date().toISOString());
    appliquerGainQuotidien.run(gain.score_global, gain.mails_debloques, user.id);
  }

  logActivity(user.id, 'Test validé (avis Play Store détecté)', app.nom_application);

  return { valide: true, reviewId, user: findUserById.get(user.id) };
}

module.exports = { tenterValiderTest };
