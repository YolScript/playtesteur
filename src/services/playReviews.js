// Service de validation des tests via l'API Google Play Developer Reporting
// (Android Publisher API v3 - reviews.list).
//
// Nécessite que le package soit publié (piste de test fermé) et que le compte
// de service ait accès dans Play Console. Sans configuration, bascule en
// MODE DEV : la validation d'un avis est simulée (acceptée immédiatement)
// pour permettre de tester tout le parcours de gamification sans Play Console.
const { resoudreCredentials } = require('./googleCredentials');

// Configuration résolue À CHAQUE APPEL (avec cache invalidé quand elle
// change) plutôt que figée au chargement : la page de configuration admin
// peut coller la clé du compte de service (via siteConfig → process.env)
// et activer l'API Play Console sans redémarrer le serveur.
let cacheConfig = null;
let avertissementDevAffiche = false;

function resoudreConfig() {
  const credentials = resoudreCredentials(
    'GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH',
    'GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_JSON'
  );
  const empreinte = credentials?.client_email || '';
  if (cacheConfig && cacheConfig.empreinte === empreinte) return cacheConfig;

  const devMode = !credentials;
  let androidpublisher = null;
  if (!devMode) {
    const { google } = require('googleapis');
    const authClient = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    androidpublisher = google.androidpublisher({ version: 'v3', auth: authClient });
    avertissementDevAffiche = false;
  } else if (!avertissementDevAffiche) {
    console.warn('[playReviews] MODE DEV actif : clé Play Console absente, validation des avis simulée.');
    avertissementDevAffiche = true;
  }

  cacheConfig = {
    empreinte,
    devMode,
    androidpublisher,
    serviceAccountEmail: credentials?.client_email || null,
  };
  return cacheConfig;
}

// Cherche, parmi les avis publics de l'application, un commentaire dont
// l'auteur correspond au pseudo Play Store du testeur. Retourne
// { reviewId, totalVus } — reviewId est null si aucun avis correspondant
// n'est détecté. totalVus (nombre d'avis renvoyés par l'API, tous auteurs
// confondus) permet de distinguer « Google n'a renvoyé aucun avis pour
// cette app » (délai d'indexation, app trop récente) de « des avis existent
// mais aucun ne correspond au pseudo » (pseudo mal renseigné) — les deux
// cas produisaient le même message opaque "avis non trouvé".
async function trouverAvisDuTesteur(packageName, pseudoPlayStore) {
  if (!pseudoPlayStore) return { reviewId: null, totalVus: 0 };

  const { devMode, androidpublisher } = resoudreConfig();
  if (devMode) {
    // Simulation : on considère l'avis trouvé instantanément.
    return { reviewId: `dev-review-${Date.now()}`, totalVus: 1 };
  }

  const pseudoNormalise = pseudoPlayStore.trim().toLowerCase();
  let pageToken;
  let totalVus = 0;
  do {
    const res = await androidpublisher.reviews.list({
      packageName,
      maxResults: 100,
      token: pageToken,
    });
    const reviews = res.data.reviews || [];
    totalVus += reviews.length;
    const match = reviews.find(
      (r) => (r.authorName || '').trim().toLowerCase() === pseudoNormalise
    );
    if (match) return { reviewId: match.reviewId, totalVus };
    pageToken = res.data.tokenPagination?.nextPageToken;
  } while (pageToken);

  return { reviewId: null, totalVus };
}

const LOCALES_PREFEREES = ['fr-FR', 'en-US'];

// Importe le titre, la description et l'icône d'une application depuis sa
// fiche Play Console (Android Publisher API - edits.listings / edits.images).
// Le compte de service doit avoir accès en lecture à l'app dans Play Console.
async function importerFicheApp(packageName) {
  if (!packageName || !packageName.trim()) {
    throw new Error('Le nom du package est requis pour importer depuis Play Console.');
  }

  const { devMode, androidpublisher } = resoudreConfig();
  if (devMode) {
    return {
      nom_application: packageName,
      description: `Fiche importée (mode dev simulé) pour le package ${packageName}.`,
      logo_url: null,
      screenshots: [],
      video_url: null,
    };
  }

  const pkg = packageName.trim();
  let editId;
  try {
    const edit = await androidpublisher.edits.insert({ packageName: pkg });
    editId = edit.data.id;

    const { data: listingsData } = await androidpublisher.edits.listings.list({
      editId,
      packageName: pkg,
    });
    const listings = listingsData.listings || [];
    if (listings.length === 0) {
      throw new Error("Aucune fiche Play Store trouvée pour ce package.");
    }
    const listing =
      LOCALES_PREFEREES.map((l) => listings.find((x) => x.language === l)).find(Boolean) ||
      listings[0];

    let logo_url = null;
    try {
      const { data: imagesData } = await androidpublisher.edits.images.list({
        editId,
        packageName: pkg,
        language: listing.language,
        imageType: 'icon',
      });
      logo_url = imagesData.images?.[0]?.url || null;
    } catch (_) {
      // Icône indisponible : on continue sans logo.
    }

    let screenshots = [];
    try {
      const { data: screenshotsData } = await androidpublisher.edits.images.list({
        editId,
        packageName: pkg,
        language: listing.language,
        imageType: 'phoneScreenshots',
      });
      screenshots = (screenshotsData.images || []).slice(0, 8).map((img) => img.url);
    } catch (_) {
      // Captures indisponibles : on continue sans galerie.
    }

    return {
      nom_application: listing.title || pkg,
      description: listing.shortDescription || listing.fullDescription || '',
      logo_url,
      screenshots,
      video_url: listing.video || null,
    };
  } catch (err) {
    if (err.code === 404 || err.code === 403) {
      throw new Error(
        "Application introuvable ou inaccessible pour le compte de service Play Console (vérifiez le nom du package et les autorisations)."
      );
    }
    throw err;
  } finally {
    if (editId) {
      androidpublisher.edits.delete({ editId, packageName: pkg }).catch(() => {});
    }
  }
}

const AVIS_SIMULES = [
  { author: 'Léa M.', rating: 5, text: "Super application, exactement ce qu'il me fallait !", date: null },
  { author: 'Karim B.', rating: 4, text: 'Bonne app, quelques bugs mineurs mais rien de bloquant.', date: null },
  { author: 'Sophie T.', rating: 5, text: 'Interface claire, je recommande.', date: null },
];

// Liste les derniers avis publics de l'application (aperçu pour les
// testeurs potentiels), indépendamment du pseudo d'un testeur particulier.
async function listerAvis(packageName, maxResults = 10) {
  if (!packageName) return [];

  const { devMode, androidpublisher } = resoudreConfig();
  if (devMode) {
    return AVIS_SIMULES;
  }

  const res = await androidpublisher.reviews.list({ packageName, maxResults });
  const reviews = res.data.reviews || [];

  return reviews.map((r) => {
    const comment = r.comments?.[0]?.userComment;
    return {
      author: r.authorName || 'Utilisateur Google',
      rating: comment?.starRating || null,
      text: comment?.text || '',
      date: comment?.lastModified?.seconds ? Number(comment.lastModified.seconds) * 1000 : null,
    };
  });
}

module.exports = {
  // Getters : reflètent l'état réel à chaque lecture (la config peut
  // changer en cours de route via la page admin, sans redémarrage).
  get devMode() {
    return resoudreConfig().devMode;
  },
  get serviceAccountEmail() {
    return resoudreConfig().serviceAccountEmail;
  },
  trouverAvisDuTesteur,
  importerFicheApp,
  listerAvis,
};
