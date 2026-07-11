// Configuration du site modifiable depuis l'interface (page Compte,
// réservée au propriétaire du site), persistée en base — évite de devoir
// éditer le .env et redémarrer le serveur pour brancher les intégrations.
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

// Description de chaque réglage — sert aussi de liste blanche (tout le
// reste est refusé : pas de stockage arbitraire de variables
// d'environnement depuis une route HTTP) et de source pour générer le
// formulaire côté client.
//   secrete : la valeur n'est JAMAIS renvoyée au navigateur (présente/absente).
//   type 'json' : le contenu doit être un JSON valide (clé de compte de service).
//   effet 'redemarrage' : lu une seule fois au démarrage du serveur.
const DEFINITIONS = [
  {
    cle: 'GOOGLE_OAUTH_CLIENT_ID',
    label: 'Client ID OAuth (connexion Google)',
    aide: 'Google Cloud → API et services → Identifiants → ID client OAuth 2.0. Active le bouton "Se connecter avec Google".',
    secrete: false,
    type: 'text',
    effet: 'immediate',
    groupe: 'Connexion Google (OAuth)',
  },
  {
    cle: 'GOOGLE_OAUTH_CLIENT_SECRET',
    label: 'Client Secret OAuth',
    aide: 'Le code secret associé au Client ID ci-dessus.',
    secrete: true,
    type: 'text',
    effet: 'immediate',
    groupe: 'Connexion Google (OAuth)',
  },
  {
    cle: 'GOOGLE_OAUTH_REDIRECT_URI',
    label: 'URI de redirection OAuth',
    aide: 'Ex : https://votre-site.fr/api/auth/google/callback — doit être identique dans Google Cloud.',
    secrete: false,
    type: 'text',
    effet: 'immediate',
    groupe: 'Connexion Google (OAuth)',
  },
  {
    cle: 'GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_JSON',
    label: 'Clé JSON du compte de service Play Console',
    aide: "Contenu complet du fichier JSON du compte de service invité dans Play Console. Active l'import de fiche et la validation automatique des avis.",
    secrete: true,
    type: 'json',
    effet: 'immediate',
    groupe: 'API Play Console (avis & fiches)',
  },
  {
    cle: 'GOOGLE_SERVICE_ACCOUNT_KEY_JSON',
    label: 'Clé JSON du compte de service Google Groups',
    aide: 'Peut être la même clé que ci-dessus. Utilisée pour gérer les groupes de testeurs via l’API (nécessite Workspace/Cloud Identity).',
    secrete: true,
    type: 'json',
    effet: 'immediate',
    groupe: 'API Google Groups (Workspace / Cloud Identity)',
  },
  {
    cle: 'GOOGLE_ADMIN_IMPERSONATE_EMAIL',
    label: 'Email admin Workspace / Cloud Identity',
    aide: 'Compte administrateur de votre Workspace/Cloud Identity, au nom duquel le compte de service agit (délégation domain-wide).',
    secrete: false,
    type: 'text',
    effet: 'immediate',
    groupe: 'API Google Groups (Workspace / Cloud Identity)',
  },
  {
    cle: 'GOOGLE_GROUPS_DOMAIN',
    label: 'Domaine des groupes',
    aide: 'Le domaine de votre Workspace/Cloud Identity (ex : playtesteur.fr). Laisser vide sans Workspace : les groupes gratuits @googlegroups.com fonctionnent sans.',
    secrete: false,
    type: 'text',
    effet: 'immediate',
    groupe: 'API Google Groups (Workspace / Cloud Identity)',
  },
  {
    cle: 'SESSION_SECRET',
    label: 'Secret des sessions',
    aide: 'Chaîne aléatoire longue qui signe les cookies de connexion. Prise en compte au prochain redémarrage du serveur (les utilisateurs devront se reconnecter).',
    secrete: true,
    type: 'text',
    effet: 'redemarrage',
    groupe: 'Serveur',
  },
];

const CLES_ENV = DEFINITIONS.map((d) => d.cle);

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
// process.env à la demande (googleGroups, googleAuth, playReviews) voient
// immédiatement la configuration sauvegardée, y compris au démarrage.
appliquerEnv();

module.exports = { DEFINITIONS, CLES_ENV, lire, definir, appliquerEnv };
