// Store de sessions persisté en SQLite, à la place du MemoryStore par
// défaut d'express-session : celui-ci perd TOUTES les sessions à chaque
// redémarrage du process (déconnexion silencieuse de tout le monde), ce
// qui arrive à chaque modification de fichier en dev (`node --watch`) et
// à chaque crash/redéploiement en production.
const session = require('express-session');
const db = require('../db/init');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
)`);

const DUREE_PAR_DEFAUT_MS = 24 * 60 * 60 * 1000;

const getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
const setStmt = db.prepare(`
  INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
`);
const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
const purgeExpireesStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');

function calculerExpiration(sessionData) {
  const maxAge = sessionData?.cookie?.maxAge;
  return Date.now() + (typeof maxAge === 'number' ? maxAge : DUREE_PAR_DEFAUT_MS);
}

class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      setStmt.run(sid, JSON.stringify(sessionData), calculerExpiration(sessionData));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      destroyStmt.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      touchStmt.run(calculerExpiration(sessionData), sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }
}

// Purge des sessions déjà expirées au démarrage (le volume reste faible :
// get() vérifie de toute façon l'expiration à chaque lecture, pas besoin
// d'une tâche périodique dédiée).
purgeExpireesStmt.run(Date.now());

module.exports = SqliteSessionStore;
