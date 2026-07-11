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
  masquer_infos INTEGER NOT NULL DEFAULT 0,
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
  screenshots TEXT,
  video_url TEXT,
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

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  texte TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_historique_testeur ON historique_tests(testeur_id);
CREATE INDEX IF NOT EXISTS idx_historique_app ON historique_tests(application_id);
CREATE INDEX IF NOT EXISTS idx_applications_dev ON applications(developpeur_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_app ON messages(application_id);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  categorie TEXT NOT NULL CHECK (categorie IN ('Bug', 'Information')),
  sujet TEXT NOT NULL,
  message TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'Ouvert' CHECK (statut IN ('Ouvert', 'En_Cours', 'Fermé')),
  reponse_admin TEXT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_statut ON tickets(statut);
`);

// Migration idempotente pour les bases déjà créées avant l'ajout de ces
// colonnes (CREATE TABLE IF NOT EXISTS ne les ajoute pas rétroactivement).
const colonnesApplications = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
if (!colonnesApplications.includes('screenshots')) {
  db.exec('ALTER TABLE applications ADD COLUMN screenshots TEXT');
}
if (!colonnesApplications.includes('video_url')) {
  db.exec('ALTER TABLE applications ADD COLUMN video_url TEXT');
}

const colonnesUsers = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!colonnesUsers.includes('masquer_infos')) {
  db.exec('ALTER TABLE users ADD COLUMN masquer_infos INTEGER NOT NULL DEFAULT 0');
}

// Avis saisi directement sur le site (remplace la vérification via l'API
// Google Play Reviews, trop peu fiable : voir historique du projet).
const colonnesHistorique = db.prepare('PRAGMA table_info(historique_tests)').all().map((c) => c.name);
if (!colonnesHistorique.includes('avis_texte')) {
  db.exec('ALTER TABLE historique_tests ADD COLUMN avis_texte TEXT');
}
if (!colonnesHistorique.includes('avis_note')) {
  db.exec('ALTER TABLE historique_tests ADD COLUMN avis_note INTEGER CHECK (avis_note BETWEEN 1 AND 5)');
}

// Table des messages de discussion des tickets
db.exec(`
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
`);

// Migration idempotente pour ajouter l'image_url aux tickets
const colonnesTickets = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!colonnesTickets.includes('image_url')) {
  db.exec('ALTER TABLE tickets ADD COLUMN image_url TEXT');
}

const colonnesTicketMessages = db.prepare('PRAGMA table_info(ticket_messages)').all().map((c) => c.name);
if (!colonnesTicketMessages.includes('image_url')) {
  db.exec('ALTER TABLE ticket_messages ADD COLUMN image_url TEXT');
}

module.exports = db;
