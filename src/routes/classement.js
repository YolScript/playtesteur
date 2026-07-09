const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Calcule le nombre de jours consécutifs (jusqu'à aujourd'hui ou hier) à
// partir d'une liste de dates 'YYYY-MM-DD' uniques triées décroissantes.
function calculerStreak(joursTries) {
  if (joursTries.length === 0) return 0;

  const aujourdHui = new Date();
  const hier = new Date(aujourdHui);
  hier.setUTCDate(hier.getUTCDate() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);

  if (joursTries[0] !== fmt(aujourdHui) && joursTries[0] !== fmt(hier)) {
    return 0; // dernier jour actif ni aujourd'hui ni hier : streak cassé
  }

  let streak = 1;
  const curseur = new Date(joursTries[0] + 'T00:00:00Z');
  for (let i = 1; i < joursTries.length; i++) {
    curseur.setUTCDate(curseur.getUTCDate() - 1);
    if (joursTries[i] === fmt(curseur)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Classement général des testeurs : apps testées + streak de jours
// consécutifs, dérivés de l'historique des tests validés.
router.get('/', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, pseudo, avatar_url FROM users WHERE suspendu = 0').all();

  const joursParUser = db
    .prepare(
      `SELECT testeur_id, DATE(date_action) AS jour
       FROM historique_tests
       WHERE statut = 'Complété' AND date_action IS NOT NULL
       GROUP BY testeur_id, DATE(date_action)
       ORDER BY testeur_id, jour DESC`
    )
    .all();
  const nbAppsParUser = db
    .prepare(
      `SELECT testeur_id, COUNT(*) AS n FROM historique_tests WHERE statut = 'Complété' GROUP BY testeur_id`
    )
    .all();

  const joursMap = {};
  for (const row of joursParUser) {
    if (!joursMap[row.testeur_id]) joursMap[row.testeur_id] = [];
    joursMap[row.testeur_id].push(row.jour);
  }
  const nbMap = {};
  for (const row of nbAppsParUser) nbMap[row.testeur_id] = row.n;

  const classement = users
    .map((u) => ({
      pseudo: u.pseudo,
      avatar_url: u.avatar_url,
      apps_testees: nbMap[u.id] || 0,
      jours_consecutifs: calculerStreak(joursMap[u.id] || []),
    }))
    .filter((u) => u.apps_testees > 0)
    .sort((a, b) => b.apps_testees - a.apps_testees || b.jours_consecutifs - a.jours_consecutifs);

  res.json({ classement });
});

module.exports = router;
