// Applique un ajustement de score (jeu quotidien OU action manuelle admin) et
// répercute les conséquences sur les mails actifs / Google Groups, en
// réutilisant exactement la même règle de palier que le job de minuit.
const db = require('../db/init');
const googleGroups = require('../services/googleGroups');
const { palierMaxMails, MAX_MAILS } = require('./scoring');

const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const majUser = db.prepare('UPDATE users SET score_global = ?, mails_debloques = ? WHERE id = ?');
const majStatutProfil = db.prepare('UPDATE users SET statut_profil = ? WHERE id = ?');
const derniersCompletes = db.prepare(`
  SELECT h.*, a.google_group_email, a.id AS app_id
  FROM historique_tests h
  JOIN applications a ON a.id = h.application_id
  WHERE h.testeur_id = ? AND h.statut = 'Complété'
  ORDER BY h.date_action DESC
  LIMIT ?
`);
const enCoursDuTesteur = db.prepare(`
  SELECT h.*, a.google_group_email, a.id AS app_id
  FROM historique_tests h
  JOIN applications a ON a.id = h.application_id
  WHERE h.testeur_id = ? AND h.statut = 'En_Cours'
`);
const suspendreHistorique = db.prepare(`UPDATE historique_tests SET statut = 'Suspendu' WHERE id = ?`);
const decrementerMailsApp = db.prepare(
  'UPDATE applications SET mails_recrutes = MAX(0, mails_recrutes - 1) WHERE id = ?'
);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

async function ejecterHistorique(row, user) {
  suspendreHistorique.run(row.id);
  decrementerMailsApp.run(row.app_id);
  if (row.google_group_email) {
    try {
      await googleGroups.retirerMembre(row.google_group_email, user.email);
    } catch (err) {
      console.error('[sanctions] éjection groupe échouée', row.google_group_email, err.message);
    }
  }
}

// delta positif ou négatif. Retourne l'utilisateur mis à jour.
async function ajusterScore(userId, delta) {
  const user = findUserById.get(userId);
  if (!user) throw new Error('Utilisateur introuvable.');

  // score_global n'est plus plafonné en haut (voir scoring.js) : seul le
  // plancher de 0 s'applique ici, pour ne pas faire redescendre à 100 un
  // utilisateur qui l'a déjà dépassé via ses tests.
  const score_global = Math.max(0, user.score_global + delta);
  const mailsAutorises = palierMaxMails(score_global);
  const nbMailsEjectes = Math.max(0, user.mails_debloques - mailsAutorises);
  const mails_debloques = clamp(user.mails_debloques - nbMailsEjectes, 0, MAX_MAILS);

  majUser.run(score_global, mails_debloques, userId);

  if (nbMailsEjectes > 0) {
    const rows = derniersCompletes.all(userId, nbMailsEjectes);
    for (const row of rows) {
      await ejecterHistorique(row, user);
    }
  }

  if (mails_debloques === 0 && user.statut_profil === 'Validé') {
    const rows = enCoursDuTesteur.all(userId);
    for (const row of rows) {
      await ejecterHistorique(row, user);
    }
    majStatutProfil.run('En_Attente', userId);
  }

  return findUserById.get(userId);
}

module.exports = { ajusterScore };
