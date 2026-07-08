// Service de validation des tests via l'API Google Play Developer Reporting
// (Android Publisher API v3 - reviews.list).
//
// Nécessite que le package soit publié (piste de test fermé) et que le compte
// de service ait accès dans Play Console. Sans configuration, bascule en
// MODE DEV : la validation d'un avis est simulée (acceptée immédiatement)
// pour permettre de tester tout le parcours de gamification sans Play Console.
const fs = require('fs');
const path = require('path');

const KEY_PATH = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH;
const devMode = !KEY_PATH || !fs.existsSync(path.resolve(KEY_PATH));

let androidpublisher = null;
let authClient = null;
if (!devMode) {
  const { google } = require('googleapis');
  authClient = new google.auth.JWT({
    keyFile: path.resolve(KEY_PATH),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  androidpublisher = google.androidpublisher({ version: 'v3', auth: authClient });
} else {
  console.warn('[playReviews] MODE DEV actif : clé Play Console absente, validation des avis simulée.');
}

// Cherche, parmi les avis publics de l'application, un commentaire dont
// l'auteur correspond au pseudo Play Store du testeur. Retourne le review_id
// trouvé, ou null si aucun avis correspondant n'est détecté.
async function trouverAvisDuTesteur(packageName, pseudoPlayStore) {
  if (!pseudoPlayStore) return null;

  if (devMode) {
    // Simulation : on considère l'avis trouvé instantanément.
    return `dev-review-${Date.now()}`;
  }

  const pseudoNormalise = pseudoPlayStore.trim().toLowerCase();
  let pageToken;
  do {
    const res = await androidpublisher.reviews.list({
      packageName,
      maxResults: 100,
      token: pageToken,
    });
    const reviews = res.data.reviews || [];
    const match = reviews.find(
      (r) => (r.authorName || '').trim().toLowerCase() === pseudoNormalise
    );
    if (match) return match.reviewId;
    pageToken = res.data.tokenPagination?.nextPageToken;
  } while (pageToken);

  return null;
}

const LOCALES_PREFEREES = ['fr-FR', 'en-US'];

// Importe le titre, la description et l'icône d'une application depuis sa
// fiche Play Console (Android Publisher API - edits.listings / edits.images).
// Le compte de service doit avoir accès en lecture à l'app dans Play Console.
async function importerFicheApp(packageName) {
  if (!packageName || !packageName.trim()) {
    throw new Error('Le nom du package est requis pour importer depuis Play Console.');
  }

  if (devMode) {
    return {
      nom_application: packageName,
      description: `Fiche importée (mode dev simulé) pour le package ${packageName}.`,
      logo_url: null,
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

    return {
      nom_application: listing.title || pkg,
      description: listing.shortDescription || listing.fullDescription || '',
      logo_url,
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

module.exports = { devMode, trouverAvisDuTesteur, importerFicheApp };
