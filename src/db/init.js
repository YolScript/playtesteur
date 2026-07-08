const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'playtesteur.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudo TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  google_id TEXT UNIQUE,
  avatar_url TEXT,
  pseudo_play_store TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'administrator')),
  statut_profil TEXT NOT NULL DEFAULT 'En_Attente' CHECK (statut_profil IN ('En_Attente', 'Validé')),
  score_global INTEGER NOT NULL DEFAULT 0 CHECK (score_global BETWEEN 0 AND 100),
  mails_debloques INTEGER NOT NULL DEFAULT 0 CHECK (mails_debloques BETWEEN 0 AND 12),
  derniere_date_test TEXT,
  fraud_warnings INTEGER NOT NULL DEFAULT 0,
  suspendu INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  developpeur_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nom_application TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  package_name TEXT,
  google_group_email TEXT UNIQUE,
  mails_recrutes INTEGER NOT NULL DEFAULT 0 CHECK (mails_recrutes BETWEEN 0 AND 12),
  statut TEXT NOT NULL DEFAULT 'En_Cours' CHECK (statut IN ('En_Cours', 'Complété', 'Terminé_Inactif')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS historique_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  testeur_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  date_rejoint TEXT NOT NULL DEFAULT (datetime('now')),
  date_action TEXT,
  statut TEXT NOT NULL DEFAULT 'En_Cours' CHECK (statut IN ('En_Cours', 'Complété', 'Suspendu')),
  UNIQUE (testeur_id, application_id)
);

CREATE TABLE IF NOT EXISTS fraud_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raison TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_historique_testeur ON historique_tests(testeur_id);
CREATE INDEX IF NOT EXISTS idx_historique_app ON historique_tests(application_id);
CREATE INDEX IF NOT EXISTS idx_applications_dev ON applications(developpeur_id);
`);

module.exports = db;
