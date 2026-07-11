// Logique de validation d'un test : l'avis est saisi directement sur le
// site (et non vérifié via l'API Google Play Reviews — abandonné après
// investigation : Google filtre silencieusement les avis liés à un
// programme de récompense, l'avis testeur n'apparaissait même pas côté
// Play Console après plusieurs jours). La qualité de l'avis (constructif,
// pas de spam) est contrôlée a posteriori par les administrateurs via le
// système d'avertissement existant, pas bloquée à la soumission.
const db = require('../db/init');
const { applyDailyTestGain } = require('./scoring');
const { logActivity } = require('./activityLog');

const MIN_AVIS_LENGTH = 20;

const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const completerHistorique = db.prepare(
  `UPDATE historique_tests SET statut = 'Complété', date_action = datetime('now'), avis_texte = ?, avis_note = ? WHERE id = ?`
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

// Valide un test en cours à partir d'un avis saisi sur le site.
// Retourne { valide: false, raison } ou { valide: true, user }.
async function validerAvis(historique, app, user, texte, note) {
  const texteNormalise = (texte || '').trim();
  if (texteNormalise.length < MIN_AVIS_LENGTH) {
    return { valide: false, raison: 'avis_trop_court' };
  }

  const noteNum = Number(note);
  if (!Number.isInteger(noteNum) || noteNum < 1 || noteNum > 5) {
    return { valide: false, raison: 'note_invalide' };
  }

  completerHistorique.run(texteNormalise, noteNum, historique.id);
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

  console.log(
    `[avis] "${app.nom_application}" note ${noteNum}/5 par ${user.pseudo} (user #${user.id}) — ${texteNormalise.length} caractères.`
  );
  logActivity(user.id, 'Avis publié sur PlayTesteur', `${app.nom_application} — ${noteNum}/5`);

  return { valide: true, user: findUserById.get(user.id) };
}

module.exports = { validerAvis, MIN_AVIS_LENGTH };
