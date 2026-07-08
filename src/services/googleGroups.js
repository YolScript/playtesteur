// Service de gestion des accès via l'API Google Groups (Admin SDK Directory).
//
// Les Google Groups nécessitent un domaine Google Workspace (pas un compte
// Gmail gratuit) + un compte de service avec délégation domaine-wide. Si la
// configuration n'est pas présente dans .env, le service bascule en MODE DEV :
// les groupes/membres sont simulés en mémoire, ce qui permet de tester tout
// le parcours (inscription, ajout au groupe, éjection) sans compte Workspace.
const { resoudreCredentials } = require('./googleCredentials');

const IMPERSONATE = process.env.GOOGLE_ADMIN_IMPERSONATE_EMAIL;
const DOMAIN = process.env.GOOGLE_GROUPS_DOMAIN;
const credentials = resoudreCredentials('GOOGLE_SERVICE_ACCOUNT_KEY_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY_JSON');

const devMode = !credentials || !IMPERSONATE || !DOMAIN;

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
    subject: IMPERSONATE,
  });
  directory = google.admin({ version: 'directory_v1', auth });
} else {
  console.warn('[googleGroups] MODE DEV actif : variables Google Workspace absentes, groupes simulés en mémoire.');
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
  const domaine = DOMAIN || 'playtesteur.dev';
  const groupEmail = `app-${appId}-${slugify(nomApplication)}@${domaine}`;

  if (devMode) {
    devGroups.set(groupEmail, new Set());
    return groupEmail;
  }

  await directory.groups.insert({
    requestBody: {
      email: groupEmail,
      name: `PlayTesteur - ${nomApplication}`,
      description: `Groupe de testeurs auto-géré pour l'application "${nomApplication}" (PlayTesteur).`,
    },
  });
  return groupEmail;
}

async function ajouterMembre(groupEmail, userEmail) {
  if (devMode) {
    if (!devGroups.has(groupEmail)) devGroups.set(groupEmail, new Set());
    devGroups.get(groupEmail).add(userEmail);
    return;
  }

  try {
    await directory.members.insert({
      groupKey: groupEmail,
      requestBody: { email: userEmail, role: 'MEMBER' },
    });
  } catch (err) {
    // 409 = déjà membre, on ignore silencieusement
    if (err.code !== 409) throw err;
  }
}

async function retirerMembre(groupEmail, userEmail) {
  if (devMode) {
    devGroups.get(groupEmail)?.delete(userEmail);
    return;
  }

  try {
    await directory.members.delete({ groupKey: groupEmail, memberKey: userEmail });
  } catch (err) {
    // 404 = déjà absent du groupe, on ignore silencieusement
    if (err.code !== 404) throw err;
  }
}

module.exports = { devMode, creerGroupe, ajouterMembre, retirerMembre };
