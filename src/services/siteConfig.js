// Configuration du site modifiable depuis l'interface admin (page Compte),
// persistée en base — évite de devoir éditer le .env et redémarrer le
// serveur pour brancher les intégrations Google.
//
// Chaque clé pilote la variable d'environnement du même nom : une valeur
// non vide en base ÉCRASE celle du .env (la configuration faite depuis
// l'interface doit prendre effet, sinon elle serait silencieusement
// ignorée). Une valeur vide en base = retour au .env / au mode DEV.
const db = require('../db/init');

db.exec(`
CREATE TABLE IF NOT EXISTS site_config (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Seules clés autorisées — tout le reste est refusé (pas de stockage
// arbitraire de variables d'environnement depuis une route HTTP).
const CLES_ENV = [
  'GOOGLE_ADMIN_IMPERSONATE_EMAIL',
  'GOOGLE_GROUPS_DOMAIN',
  'GOOGLE_SERVICE_ACCOUNT_KEY_JSON',
];

// Clés dont la valeur ne doit jamais repartir vers le navigateur (on
// renvoie seulement "présente/absente").
const CLES_SECRETES = ['GOOGLE_SERVICE_ACCOUNT_KEY_JSON'];

const lireStmt = db.prepare('SELECT valeur FROM site_config WHERE cle = ?');
const upsertStmt = db.prepare(`
  INSERT INTO site_config (cle, valeur, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur, updated_at = excluded.updated_at
`);

function lire(cle) {
  return lireStmt.get(cle)?.valeur ?? '';
}

function definir(cle, valeur) {
  if (!CLES_ENV.includes(cle)) {
    throw new Error(`Clé de configuration inconnue : ${cle}`);
  }
  upsertStmt.run(cle, String(valeur ?? '').trim());
  appliquerEnv();
}

function appliquerEnv() {
  for (const cle of CLES_ENV) {
    const v = lire(cle);
    if (v) process.env[cle] = v;
  }
}

// Appliqué dès le chargement du module : les services qui lisent
// process.env à la demande (googleGroups...) voient immédiatement la
// configuration sauvegardée, y compris au démarrage du serveur.
appliquerEnv();

module.exports = { CLES_ENV, CLES_SECRETES, lire, definir, appliquerEnv };
