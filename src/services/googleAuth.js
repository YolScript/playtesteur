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

// Échange le code OAuth contre le profil Google vérifié de l'utilisateur.
async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code);
  const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
  const payload = ticket.getPayload();

  if (!payload.email_verified) {
    throw new Error('Cet email Google n\'est pas vérifié.');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    pseudo: payload.name || payload.email.split('@')[0],
    avatarUrl: payload.picture || null,
  };
}

module.exports = { devMode, getAuthUrl, handleCallback };
