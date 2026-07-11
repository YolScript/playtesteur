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
// Configuration résolue À CHAQUE APPEL (avec cache invalidé quand elle
// change) plutôt que figée au chargement : la page de configuration admin
// peut renseigner les identifiants OAuth (via siteConfig → process.env) et
// activer la vraie connexion Google sans redémarrer le serveur.
let cacheConfig = null;
let avertissementDevAffiche = false;

function resoudreConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const empreinte = [clientId || '', clientSecret || '', redirectUri || ''].join('|');
  if (cacheConfig && cacheConfig.empreinte === empreinte) return cacheConfig;

  const devMode = !clientId || !clientSecret || !redirectUri;
  let oauth2Client = null;
  if (!devMode) {
    const { google } = require('googleapis');
    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    avertissementDevAffiche = false;
  } else if (!avertissementDevAffiche) {
    console.warn('[googleAuth] MODE DEV actif : OAuth Google absent, connexion simulée via /api/auth/dev-login.');
    avertissementDevAffiche = true;
  }

  cacheConfig = { empreinte, devMode, oauth2Client, clientId };
  return cacheConfig;
}

function getAuthUrl() {
  return resoudreConfig().oauth2Client.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
  });
}

// Échange le code OAuth contre le profil Google vérifié de l'utilisateur.
async function handleCallback(code) {
  const { oauth2Client, clientId } = resoudreConfig();
  const { tokens } = await oauth2Client.getToken(code);
  const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
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

module.exports = {
  get devMode() {
    return resoudreConfig().devMode;
  },
  getAuthUrl,
  handleCallback,
};
