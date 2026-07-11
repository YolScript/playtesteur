// Service de gestion des accès via l'API Google Groups (Admin SDK Directory).
//
// Les Google Groups nécessitent un domaine Google Workspace (pas un compte
// Gmail gratuit) + un compte de service avec délégation domaine-wide. Si la
// configuration n'est pas présente dans .env, le service bascule en MODE DEV :
// les groupes/membres sont simulés en mémoire, ce qui permet de tester tout
// le parcours (inscription, ajout au groupe, éjection) sans compte Workspace.
const { resoudreCredentials } = require('./googleCredentials');

// La configuration est résolue À CHAQUE APPEL (avec cache invalidé quand
// elle change) plutôt que figée au chargement du module : la page admin
// peut ainsi renseigner les variables (via siteConfig → process.env) et
// voir l'API basculer de DEV à PRODUCTION sans redémarrer le serveur.
let cacheConfig = null;
let avertissementDevAffiche = false;

function resoudreConfig() {
  const impersonate = process.env.GOOGLE_ADMIN_IMPERSONATE_EMAIL;
  const domain = process.env.GOOGLE_GROUPS_DOMAIN;
  const credentials = resoudreCredentials('GOOGLE_SERVICE_ACCOUNT_KEY_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY_JSON');
  const empreinte = [impersonate || '', domain || '', credentials?.client_email || ''].join('|');
  if (cacheConfig && cacheConfig.empreinte === empreinte) return cacheConfig;

  const devMode = !credentials || !impersonate || !domain;
  let directory = null;
  if (!devMode) {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [
        'https://www.googleapis.com/auth/admin.directory.group',
        'https://www.googleapis.com/auth/admin.directory.group.member',
      ],
      subject: impersonate,
    });
    directory = google.admin({ version: 'directory_v1', auth });
    avertissementDevAffiche = false;
  } else if (!avertissementDevAffiche) {
    console.warn('[googleGroups] MODE DEV actif : variables Google Workspace absentes, groupes simulés en mémoire.');
    avertissementDevAffiche = true;
  }

  cacheConfig = { empreinte, devMode, directory, domain };
  return cacheConfig;
}

// Groupes et membres simulés en mode dev : Map<groupEmail, Set<memberEmail>>
const devGroups = new Map();

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

async function creerGroupe(appId, nomApplication) {
  const config = resoudreConfig();
  const domaine = config.domain || 'playtesteur.dev';
  const groupEmail = `app-${appId}-${slugify(nomApplication)}@${domaine}`;

  if (config.devMode) {
    devGroups.set(groupEmail, new Set());
    return groupEmail;
  }

  await config.directory.groups.insert({
    requestBody: {
      email: groupEmail,
      name: `PlayTesteur - ${nomApplication}`,
      description: `Groupe de testeurs auto-géré pour l'application "${nomApplication}" (PlayTesteur).`,
    },
  });
  return groupEmail;
}

async function ajouterMembre(groupEmail, userEmail) {
  const config = resoudreConfig();
  if (config.devMode) {
    if (!devGroups.has(groupEmail)) devGroups.set(groupEmail, new Set());
    devGroups.get(groupEmail).add(userEmail);
    return;
  }

  try {
    await config.directory.members.insert({
      groupKey: groupEmail,
      requestBody: { email: userEmail, role: 'MEMBER' },
    });
  } catch (err) {
    // 409 = déjà membre, on ignore silencieusement
    if (err.code !== 409) throw err;
  }
}

async function retirerMembre(groupEmail, userEmail) {
  const config = resoudreConfig();
  if (config.devMode) {
    devGroups.get(groupEmail)?.delete(userEmail);
    return;
  }

  try {
    await config.directory.members.delete({ groupKey: groupEmail, memberKey: userEmail });
  } catch (err) {
    // 404 = déjà absent du groupe, on ignore silencieusement
    if (err.code !== 404) throw err;
  }
}

// Groupe "externe" = fourni par le développeur (typiquement un groupe grand
// public xxx@googlegroups.com créé gratuitement sur groups.google.com, sans
// Google Workspace ni domaine). L'API Admin SDK ne peut PAS gérer ses
// membres : l'adhésion passe par le testeur lui-même via l'URL du groupe
// (réglage du groupe : "Qui peut rejoindre : tout le monde sur le web").
function estGroupeGere(groupEmail) {
  const config = resoudreConfig();
  if (config.devMode) return false;
  return !!groupEmail && groupEmail.toLowerCase().endsWith(`@${String(config.domain).toLowerCase()}`);
}

// URL de la page du groupe où le testeur clique "Rejoindre le groupe".
function urlAdhesion(groupEmail) {
  if (!groupEmail || !groupEmail.includes('@')) return null;
  const [local, domaine] = groupEmail.toLowerCase().split('@');
  if (domaine === 'googlegroups.com') return `https://groups.google.com/g/${local}`;
  return `https://groups.google.com/a/${domaine}/g/${local}`;
}

module.exports = {
  // Getter : reflète l'état réel à chaque lecture (la config peut changer
  // en cours de route via la page admin, sans redémarrage).
  get devMode() {
    return resoudreConfig().devMode;
  },
  creerGroupe,
  ajouterMembre,
  retirerMembre,
  estGroupeGere,
  urlAdhesion,
};
