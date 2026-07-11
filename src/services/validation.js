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
// Nombre de tests à valider avant que le profil passe "Validé" et que le
// gain de score/mails quotidien (applyDailyTestGain) démarre. Avant ce
// palier, les tests comptent pour l'atteindre mais ne rapportent ni score
// ni mail (onboarding/probation) — exporté pour que l'UI puisse afficher
// une progression cohérente ("encore X tests", pas "encore X points").
const TESTS_REQUIS_ONBOARDING = 10;

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
// Apps "en attente de test" = qui recrutent encore des testeurs.
const countApplicationsEnRecrutement = db.prepare(
  `SELECT COUNT(*) AS n FROM applications WHERE statut = 'En_Cours'`
);
const validerProfil = db.prepare(
  `UPDATE users SET statut_profil = 'Validé', mails_debloques = MAX(mails_debloques, 1) WHERE id = ?`
);
const appliquerGainQuotidien = db.prepare(
  "UPDATE users SET score_global = ?, mails_debloques = ?, derniere_date_test = datetime('now') WHERE id = ?"
);
const marquerDateTestSansGain = db.prepare("UPDATE users SET derniere_date_test = datetime('now') WHERE id = ?");

// Le palier des 10 tests n'a de sens que s'il y a effectivement plus de 10
// applications en attente de test sur la plateforme : sinon il serait
// impossible à atteindre (pas assez d'apps disponibles). Tant que ce n'est
// pas le cas, le profil se valide dès le premier test — et ce test donne
// aussi son gain immédiatement (pas de délai d'un test à l'autre). Exporté
// pour que l'UI affiche une progression cohérente avec ce qui sera
// réellement exigé.
function seuilOnboardingEffectif() {
  const nbApplications = countApplicationsEnRecrutement.get().n;
  return nbApplications > TESTS_REQUIS_ONBOARDING ? TESTS_REQUIS_ONBOARDING : 1;
}

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

  if (user.statut_profil !== 'Validé' && nbTestsCompletes >= seuilOnboardingEffectif()) {
    // Ticket d'entrée franchi : profil validé + 1er mail débloqué.
    validerProfil.run(user.id);
  }

  // Relit l'utilisateur : s'il vient d'être validé ci-dessus, le gain de CE
  // test doit déjà s'appliquer (pas seulement à partir du suivant) — c'est
  // notamment le cas quand le palier est abaissé à 1 test (peu d'apps
  // disponibles) : le tout premier test doit rapporter ses points.
  const userMisAJour = findUserById.get(user.id);
  if (userMisAJour.statut_profil === 'Validé') {
    const gain = applyDailyTestGain(userMisAJour, new Date().toISOString());
    appliquerGainQuotidien.run(gain.score_global, gain.mails_debloques, user.id);
  } else {
    marquerDateTestSansGain.run(user.id);
  }

  console.log(
    `[avis] "${app.nom_application}" note ${noteNum}/5 par ${user.pseudo} (user #${user.id}) — ${texteNormalise.length} caractères.`
  );
  logActivity(user.id, 'Avis publié sur PlayTesteur', `${app.nom_application} — ${noteNum}/5`);

  return { valide: true, user: findUserById.get(user.id) };
}

module.exports = { validerAvis, MIN_AVIS_LENGTH, TESTS_REQUIS_ONBOARDING, seuilOnboardingEffectif };
