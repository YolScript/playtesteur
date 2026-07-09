const { MAX_MAILS, scoreMinPour } = require('./scoring');

// Version sûre d'un utilisateur enrichie des infos de palier utiles à
// l'affichage de la jauge côté client.
function publicUser(user) {
  const prochainPalierMails = Math.min(user.mails_debloques + 1, MAX_MAILS);
  const scoreProchainPalier =
    user.mails_debloques >= MAX_MAILS ? null : scoreMinPour(prochainPalierMails);

  return {
    id: user.id,
    pseudo: user.pseudo,
    email: user.email,
    avatar_url: user.avatar_url,
    pseudo_play_store: user.pseudo_play_store,
    role: user.role,
    statut_profil: user.statut_profil,
    score_global: user.score_global,
    mails_debloques: user.mails_debloques,
    mails_max: MAX_MAILS,
    score_prochain_palier: scoreProchainPalier,
    derniere_date_test: user.derniere_date_test,
    fraud_warnings: user.fraud_warnings,
    masquer_infos: !!user.masquer_infos,
    created_at: user.created_at,
  };
}

function publicApplication(app) {
  let screenshots = [];
  if (app.screenshots) {
    try {
      screenshots = JSON.parse(app.screenshots);
    } catch (_) {
      screenshots = [];
    }
  }

  return {
    id: app.id,
    developpeur_id: app.developpeur_id,
    nom_application: app.nom_application,
    description: app.description,
    logo_url: app.logo_url,
    package_name: app.package_name,
    mails_recrutes: app.mails_recrutes,
    mails_max: 12,
    statut: app.statut,
    screenshots,
    video_url: app.video_url,
    created_at: app.created_at,
  };
}

module.exports = { publicUser, publicApplication };
