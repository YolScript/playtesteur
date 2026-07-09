// Authentification via "Se connecter avec Google" (OAuth 2.0 / OpenID Connect).
//
// L'email Google renvoyé par ce flux est celui utilisé tel quel comme
// identité du compte ET comme adresse ajoutée aux Google Groups de test
// (voir services/googleGroups.js) : c'est pourquoi l'utilisateur doit se
// connecter avec le MÊME compte Google que celui lié à sa Google Play
// Console, sans quoi les accès aux tests fermés ne correspondront pas.
//
// Sans configuration OAuth dans .env, bascule en MODE DEV : la route
// /api/auth/dev-login permet de simuler une connexion Google (email + nom
// saisis librement) pour développer sans créer de credentials OAuth réels.
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

const devMode = !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI;

let oauth2Client = null;
if (!devMode) {
  const { google } = require('googleapis');
  oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
} else {
  console.warn('[googleAuth] MODE DEV actif : OAuth Google absent, connexion simulée via /api/auth/dev-login.');
}

function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
  });
}

// Récupère le "Pseudo" configuré dans les paramètres du compte Google
// (Infos personnelles > Nom > Pseudo). Ce champ n'est pas dans le id_token
// OpenID standard (name/given_name/family_name) : il faut un appel séparé à
// l'API Google People. Il n'existe pas de scope OAuth dédié à ce champ
// (user.nickname.read n'est pas un scope valide côté Google, cf. erreur
// "invalid_scope") : on retente l'appel avec le scope "profile" déjà
// accordé — Google le sert parfois pour people/me, sinon la requête
// échoue proprement et on retombe sur le prénom.
async function recupererPseudoGoogle(auth) {
  try {
    const { google } = require('googleapis');
    const people = google.people({ version: 'v1', auth });
    const { data } = await people.people.get({
      resourceName: 'people/me',
      personFields: 'nicknames',
    });
    const nickname = (data.nicknames || []).find((n) => n.value)?.value;
    return nickname || null;
  } catch (err) {
    console.warn('[googleAuth] Pseudo Google (nickname) indisponible, fallback sur le prénom.', err.message);
    return null;
  }
}

// Échange le code OAuth contre le profil Google vérifié de l'utilisateur.
async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
  const payload = ticket.getPayload();

  if (!payload.email_verified) {
    throw new Error('Cet email Google n\'est pas vérifié.');
  }

  const nickname = await recupererPseudoGoogle(oauth2Client);
  const pseudo = nickname || payload.given_name || payload.name || payload.email.split('@')[0];

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    pseudo,
    avatarUrl: payload.picture || null,
  };
}

module.exports = { devMode, getAuthUrl, handleCallback };
