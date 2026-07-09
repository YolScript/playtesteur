// Journal d'activité : trace les actions significatives des utilisateurs
// pour la console admin (globale et par compte).
const db = require('../db/init');

const insertLog = db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)');

function logActivity(userId, action, details) {
  try {
    insertLog.run(userId, action, details || null);
  } catch (err) {
    console.error('[activityLog]', err.message);
  }
}

module.exports = { logActivity };
