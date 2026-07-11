// Intégration Play Console (Android Publisher API v3) pour l'import de
// fiche d'application et l'aperçu des avis publics existants — pas pour la
// validation des tests, qui se fait désormais via un avis saisi directement
// sur le site (voir services/validation.js : Google filtre silencieusement
// les avis liés à un programme de récompense, la détection automatique via
// reviews.list n'était pas fiable).
//
// Nécessite que le package soit publié et que le compte de service ait
// accès dans Play Console. Sans configuration, bascule en MODE DEV (import
// de fiche simulé) pour permettre de tester sans Play Console.
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
    console.warn('[playReviews] MODE DEV actif : clé Play Console absente, import de fiche simulé.');
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

// Liste les pistes de test existantes d'un package (internal, alpha, beta,
// production, ou pistes personnalisées) — pour laisser le développeur
// choisir sur laquelle appliquer le groupe de testeurs automatiquement.
async function listerPistesTest(packageName) {
  if (!packageName || !packageName.trim()) return [];

  const { devMode, androidpublisher } = resoudreConfig();
  if (devMode) return ['internal', 'alpha', 'beta', 'production'];

  const pkg = packageName.trim();
  let editId;
  try {
    const edit = await androidpublisher.edits.insert({ packageName: pkg });
    editId = edit.data.id;
    const { data } = await androidpublisher.edits.tracks.list({ editId, packageName: pkg });
    return (data.tracks || []).map((t) => t.track);
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

// Applique la liste des groupes testeurs d'une piste de test dans Play
// Console (remplace la liste actuelle par le groupe de l'app sur
// PlayTesteur), via l'API Android Publisher (edits.testers). Nécessite que
// le compte de service ait l'autorisation "Gérer les canaux de test et
// modifier les listes de testeurs".
async function configurerGroupeTesteurs(packageName, track, groupEmail) {
  const { devMode, androidpublisher } = resoudreConfig();
  if (devMode) return; // Simulation : rien à appliquer réellement.

  const pkg = packageName.trim();
  let editId;
  try {
    const edit = await androidpublisher.edits.insert({ packageName: pkg });
    editId = edit.data.id;
    await androidpublisher.edits.testers.patch({
      editId,
      packageName: pkg,
      track,
      requestBody: { googleGroups: [groupEmail] },
    });
    await androidpublisher.edits.commit({ editId, packageName: pkg });
    editId = null; // Le commit consomme l'edit : pas besoin (et pas possible) de le supprimer ensuite.
  } catch (err) {
    if (err.code === 404 || err.code === 403) {
      throw new Error(
        "Piste de test introuvable ou inaccessible pour le compte de service Play Console (vérifiez le nom de la piste et les autorisations)."
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
  importerFicheApp,
  listerAvis,
  listerPistesTest,
  configurerGroupeTesteurs,
};
