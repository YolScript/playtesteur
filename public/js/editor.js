/* ==========================================================================
   ÉDITEUR (vidéo/photo promo) — 100% côté navigateur, rien n'est envoyé
   au serveur. Rendu WebGL (three.js) en timeline (intro -> photos ->
   outro, chaque segment ayant sa propre durée), aperçu temps réel avec
   lecture/pause, export PNG (formats Play Store) et export MP4 haute
   qualité (1920x1080, 60 im/s) via MediaRecorder puis ffmpeg.wasm.

   Chaque calque (photo, légende, texte, logo/texte d'intro-outro) est
   composé visuellement sur un canvas 2D hors-écran (coins arrondis,
   contour, ombre — même technique qu'avant), puis appliqué comme texture
   sur un plan three.js positionnable/rotable librement sur les 3 axes
   (x, y, z). Le plan z=0 correspond exactement au cadre 1920x1080 en
   unités "pixel", donc tous les calculs de position existants (x*width,
   y*height) restent valides pour la profondeur nulle.
   ========================================================================== */

const EditorState = {
  bgType: null, // 'video' | 'image' | 'color' | 'gradient' | null
  bgVideoEl: null,
  bgImageEl: null,
  bgColor: '#12151c',
  bgGradient: { color1: '#0f2027', color2: '#2c5364', angle: 135 },
  bgAdjust: { brightness: 100, blur: 0 }, // brightness: 40-160%, blur: 0-15px
  overlay: { type: 'none', strength: 0.5 }, // type: 'none' | 'grain' | 'vignette'
  bgChromaKey: { active: false, color: '#00ff00', tolerance: 0.35 },
  audioEl: null,
  audioGainNode: null,
  audioVolume: 0.8,
  audioFadeIn: 0,
  audioFadeOut: 0,
  audioTrimStart: 0,
  audioWaveform: null, // Float32Array de niveaux RMS normalisés, pour l'affichage
  voiceEl: null,
  voiceGainNode: null,
  voiceVolume: 1,
  fontFamily: null,
  fontBlob: null, // fichier de la police perso (pour la sauvegarde de projet) — pas suivi dans l'historique
  fontFileName: null,

  // Identité du projet dans le stockage local (IndexedDB) — pas suivie
  // dans l'historique undo/redo, seulement dans la sauvegarde de projet.
  projetId: null,
  projetNom: 'Projet sans titre',

  intro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  outro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  photos: [], // [{ id, img, x, y, z, rotX, rotY, rotZ, scale, texte, duree }]

  // [{ id, texte, x, y, z, fontFamily, size, color, bold, italic, align,
  //    anim, startTime, endTime }] — plusieurs blocs de texte libres
  // indépendants, chacun avec son propre style, sa fenêtre d'affichage
  // (null = du début/jusqu'à la fin) et son animation d'entrée/sortie.
  textBlocks: [],

  // [{ id, type, emoji, x, y, z, rotZ, scale, couleur, opacite, startTime,
  //    endTime }] — formes vectorielles et stickers emoji, calques libres
  // au même titre que les blocs de texte (indépendants de la timeline photo).
  shapes: [],

  // [{ id, points:[{x,y}], couleur, epaisseur, opacite, startTime, endTime }]
  // — traits de dessin libre (pinceau), un calque plein cadre par trait.
  drawings: [],
  modeDessin: false,
  dessinCouleur: '#ff2d95',
  dessinEpaisseur: 6,

  // Cadre décoratif plein cadre, dessiné par-dessus tout le reste.
  cadreDecoratif: { type: 'none', couleur: '#ffffff', epaisseur: 24 },

  // [{ id, temps, nom }] — repères nommés sur la timeline visuelle.
  marqueurs: [],

  playback: { playing: false, currentTime: 0, lastFrameTs: null },
  // État de l'export : la timeline avance toujours en temps réel (1x),
  // identique à une lecture normale, pour que la durée exportée corresponde
  // exactement à `dureeTotale` et reste synchronisée avec l'audio.
  exporting: false,
  exportFps: 30,
  // Mode IA : remplace le rendu visuel de chaque calque par un simple
  // cadre pointillé + label (id, dimensions) — pour qu'une IA pilotant
  // l'éditeur lise la disposition sans avoir à interpréter une image.
  modeContours: false,
  _scrubbing: false,

  imageExportFormat: 'playstore', // 'playstore' (1080x1920) | 'square' (1080x1080)

  effects: { bloomActive: false, bloomStrength: 0.4, bloomAudioReactive: false },
  transitionType: 'none', // 'none' | 'fade' | 'slide' | 'zoom'

  dragging: null, // null | { type:'photo'|'caption'|'textblock', id }
  _textBoxes: {}, // id -> box (pour le drag des blocs de texte)
  audioCtx: null,
  audioSourceCache: null,

  three: null, // rempli par initMoteur3D()
};

/* -------------------------------------------------------------------- */
/* Clés API IA — saisies par l'utilisateur, stockées uniquement dans le  */
/* navigateur (localStorage), jamais envoyées à notre serveur. Chaque    */
/* fonctionnalité IA (sous-titres, suppression de fond, voix off...)     */
/* appelle directement l'API du fournisseur depuis le navigateur avec la */
/* clé fournie ici.                                                      */
/* -------------------------------------------------------------------- */
const AI_KEYS_STORAGE_KEY = 'playtesteur_editor_ai_keys';
const AiKeys = { openai: '', removebg: '', pixabay: '' };

function chargerCleApiDepuisStockage() {
  try {
    const brut = localStorage.getItem(AI_KEYS_STORAGE_KEY);
    if (brut) Object.assign(AiKeys, JSON.parse(brut));
  } catch (_) {
    /* localStorage indisponible (navigation privée...) : clés restent vides */
  }
}

function sauvegarderCleApi(nom, valeur) {
  AiKeys[nom] = valeur;
  try {
    localStorage.setItem(AI_KEYS_STORAGE_KEY, JSON.stringify(AiKeys));
  } catch (_) {}
}

function bindReglagesIa() {
  chargerCleApiDepuisStockage();
  [
    ['editor-ai-key-openai', 'openai'],
    ['editor-ai-key-removebg', 'removebg'],
    ['editor-ai-key-pixabay', 'pixabay'],
  ].forEach(([inputId, nom]) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = AiKeys[nom] || '';
    input.addEventListener('input', (e) => sauvegarderCleApi(nom, e.target.value.trim()));
  });
}

/* -------------------------------------------------------------------- */
/* Bibliothèque Pixabay (vidéos & images libres de droits pour le fond) */
/* -------------------------------------------------------------------- */
async function rechercherPixabay() {
  const requeteInput = document.getElementById('editor-pixabay-recherche');
  const typeSelect = document.getElementById('editor-pixabay-type');
  const resultatsEl = document.getElementById('editor-pixabay-resultats');
  if (!requeteInput || !typeSelect || !resultatsEl) return;
  const requete = requeteInput.value.trim();
  const type = typeSelect.value;
  if (!requete) {
    toast('Entrez un terme de recherche.', 'error');
    return;
  }
  if (!AiKeys.pixabay) {
    toast('Renseignez votre clé API Pixabay dans la section "Clés API IA" plus bas.', 'error');
    return;
  }
  resultatsEl.innerHTML = '<p class="form-hint">Recherche en cours…</p>';
  try {
    const base = type === 'photos' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/';
    const url = `${base}?key=${encodeURIComponent(AiKeys.pixabay)}&q=${encodeURIComponent(requete)}&per_page=24&safesearch=true`;
    const reponse = await fetch(url);
    if (!reponse.ok) throw new Error(`Pixabay a répondu ${reponse.status}`);
    const donnees = await reponse.json();
    afficherResultatsPixabay(donnees.hits || [], type);
  } catch (err) {
    console.error('[editeur] recherche Pixabay échouée', err);
    resultatsEl.innerHTML = '<p class="form-hint">Recherche impossible (clé API invalide ou problème réseau).</p>';
  }
}

function afficherResultatsPixabay(hits, type) {
  const resultatsEl = document.getElementById('editor-pixabay-resultats');
  if (!resultatsEl) return;
  if (!hits.length) {
    resultatsEl.innerHTML = '<p class="form-hint">Aucun résultat pour cette recherche.</p>';
    return;
  }
  resultatsEl.innerHTML = hits
    .map((hit) => {
      const titre = escapeHtml((hit.tags || '').split(',')[0] || '');
      if (type === 'photos') {
        const source = hit.largeImageURL || hit.webformatURL;
        return `<button type="button" class="editor-pixabay-item" data-pixabay-url="${escapeHtml(source)}" data-pixabay-mediatype="image" title="${titre}">
          <img src="${escapeHtml(hit.previewURL)}" alt="${titre}" loading="lazy">
        </button>`;
      }
      const videos = hit.videos || {};
      const source = (videos.medium || videos.small || videos.tiny || {}).url;
      const apercu = (videos.tiny || videos.small || {}).url;
      if (!source || !apercu) return '';
      return `<button type="button" class="editor-pixabay-item" data-pixabay-url="${escapeHtml(source)}" data-pixabay-mediatype="video" title="${titre}">
        <video src="${escapeHtml(apercu)}" muted loop autoplay playsinline></video>
      </button>`;
    })
    .join('');
  resultatsEl.querySelectorAll('[data-pixabay-url]').forEach((btn) => {
    btn.addEventListener('click', () => appliquerResultatPixabay(btn.dataset.pixabayUrl, btn.dataset.pixabayMediatype));
  });
}

async function appliquerResultatPixabay(url, mediaType) {
  if (!url) return;
  toast('Téléchargement du média Pixabay…', 'info');
  try {
    const file = await chargerFichierDepuisUrl(url, mediaType === 'video' ? 'pixabay.mp4' : 'pixabay.jpg');
    await chargerFondDepuisFichier(file);
    afficherNomFichier('editor-bg-filename', file);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
    toast('Fond mis à jour depuis Pixabay.', 'success');
  } catch (err) {
    console.error('[editeur] application média Pixabay échouée', err);
    toast("Impossible de charger ce média (réseau ou restriction d'accès).", 'error');
  }
}

function bindPixabay() {
  const chercherBtn = document.getElementById('editor-pixabay-chercher');
  if (chercherBtn) chercherBtn.addEventListener('click', rechercherPixabay);
  const requeteInput = document.getElementById('editor-pixabay-recherche');
  if (requeteInput) {
    requeteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        rechercherPixabay();
      }
    });
  }
}

let editorRafId = null;
// Compteur PARTAGÉ entre calques photo et blocs texte (et non deux
// compteurs séparés) : les deux types de calque réutilisent les mêmes
// attributs data-*-for (data-saber-for, data-rotx-for, etc.) et les
// fonctions de binding interrogent le DOM avec `document.querySelector`
// non scopé à leur conteneur — si une photo et un texte avaient le même
// id, le binding du second se raccrochait par erreur au premier élément
// trouvé dans le DOM (celui de la photo), rendant ses propres contrôles
// inopérants. Un compteur unique garantit des id uniques quel que soit le
// type de calque.
let elementIdCounter = 0;

/* -------------------------------------------------------------------- */
/* Historique (undo/redo)                                                */
/* -------------------------------------------------------------------- */
// Champs "données utilisateur" à suivre dans l'historique — exclut le
// moteur three.js, les noeuds Web Audio, l'état de lecture/drag en cours,
// etc. qui ne doivent pas être capturés ni restaurés.
const CHAMPS_HISTORIQUE = [
  'bgType', 'bgColor', 'bgGradient', 'bgAdjust', 'overlay', 'bgChromaKey',
  'audioVolume', 'audioFadeIn', 'audioFadeOut', 'audioTrimStart', 'voiceVolume',
  'fontFamily', 'intro', 'outro', 'photos', 'textBlocks', 'shapes', 'drawings',
  'cadreDecoratif', 'imageExportFormat', 'effects', 'transitionType',
];
// Références aux éléments média déjà chargés : à réattacher telles quelles
// (jamais clonées, jamais recréées) lors d'une restauration.
const CHAMPS_HISTORIQUE_REFS = ['bgVideoEl', 'bgImageEl', 'audioEl', 'voiceEl'];

const Historique = { pile: [], index: -1, enPause: false };

function cloneProfondSansDom(valeur) {
  if (valeur === null || typeof valeur !== 'object') return valeur;
  if (valeur instanceof Node) return valeur; // média déjà chargé : référence conservée
  if (Array.isArray(valeur)) return valeur.map(cloneProfondSansDom);
  const out = {};
  for (const cle of Object.keys(valeur)) out[cle] = cloneProfondSansDom(valeur[cle]);
  return out;
}

function capturerSnapshot() {
  const snap = {};
  for (const champ of CHAMPS_HISTORIQUE) snap[champ] = cloneProfondSansDom(EditorState[champ]);
  for (const champ of CHAMPS_HISTORIQUE_REFS) snap[champ] = EditorState[champ];
  return snap;
}

// Capturé une seule fois, au chargement du script (avant toute interaction
// utilisateur) : sert de base pour "Nouveau projet" sans dupliquer la liste
// des valeurs par défaut de chaque champ.
const ETAT_INITIAL = capturerSnapshot();

function majBoutonsHistorique() {
  const btnUndo = document.getElementById('editor-undo-btn');
  const btnRedo = document.getElementById('editor-redo-btn');
  if (btnUndo) btnUndo.disabled = Historique.index <= 0;
  if (btnRedo) btnRedo.disabled = Historique.index < 0 || Historique.index >= Historique.pile.length - 1;
}

// À appeler après toute mutation significative de l'état (édition d'un
// champ, ajout/suppression de calque, fin de glisser-déposer…).
function pousserHistorique() {
  if (Historique.enPause) return;
  if (Historique.index < Historique.pile.length - 1) {
    Historique.pile = Historique.pile.slice(0, Historique.index + 1);
  }
  Historique.pile.push(capturerSnapshot());
  if (Historique.pile.length > 60) Historique.pile.shift();
  Historique.index = Historique.pile.length - 1;
  majBoutonsHistorique();
  planifierAutoSave();
}

function restaurerSnapshot(snap) {
  Historique.enPause = true;
  for (const champ of CHAMPS_HISTORIQUE) EditorState[champ] = cloneProfondSansDom(snap[champ]);
  for (const champ of CHAMPS_HISTORIQUE_REFS) EditorState[champ] = snap[champ];
  rafraichirListePhotos();
  rafraichirListeTextBlocks();
  rafraichirListeFormes();
  rafraichirPanneauDessin();
  rafraichirPanneauApresRestauration();
  Historique.enPause = false;
}

function annulerHistorique() {
  if (Historique.index <= 0) return;
  Historique.index -= 1;
  restaurerSnapshot(Historique.pile[Historique.index]);
  majBoutonsHistorique();
}

function refaireHistorique() {
  if (Historique.index < 0 || Historique.index >= Historique.pile.length - 1) return;
  Historique.index += 1;
  restaurerSnapshot(Historique.pile[Historique.index]);
  majBoutonsHistorique();
}

function initHistorique() {
  Historique.pile = [capturerSnapshot()];
  Historique.index = 0;
  majBoutonsHistorique();
}

/* -------------------------------------------------------------------- */
/* Projets — sauvegarde/chargement complets (état + médias) dans        */
/* IndexedDB (contrairement à localStorage, pas de limite de taille     */
/* pratique et support natif des Blob, donc des vidéos/audio importés). */
/* Couvre : sauvegarde/chargement, auto-save de secours, plusieurs      */
/* projets nommés, points de sauvegarde ("checkpoints") manuels, et     */
/* export/import d'un projet en fichier .json portable.                 */
/* -------------------------------------------------------------------- */
const PROJETS_DB_NOM = 'playtesteur_editor_projets';
const PROJETS_DB_VERSION = 1;
const PROJETS_STORE = 'projets';
const AUTOSAVE_ID = '__autosave__';

let _projetsDbPromise = null;
function ouvrirBaseProjets() {
  if (!_projetsDbPromise) {
    _projetsDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PROJETS_DB_NOM, PROJETS_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PROJETS_STORE)) {
          db.createObjectStore(PROJETS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _projetsDbPromise;
}

function requeteVersPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function enregistrementProjetPut(record) {
  const db = await ouvrirBaseProjets();
  const tx = db.transaction(PROJETS_STORE, 'readwrite');
  tx.objectStore(PROJETS_STORE).put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function enregistrementProjetGet(id) {
  const db = await ouvrirBaseProjets();
  return requeteVersPromise(db.transaction(PROJETS_STORE, 'readonly').objectStore(PROJETS_STORE).get(id));
}

async function enregistrementProjetGetAll() {
  const db = await ouvrirBaseProjets();
  return requeteVersPromise(db.transaction(PROJETS_STORE, 'readonly').objectStore(PROJETS_STORE).getAll());
}

async function enregistrementProjetDelete(id) {
  const db = await ouvrirBaseProjets();
  const tx = db.transaction(PROJETS_STORE, 'readwrite');
  tx.objectStore(PROJETS_STORE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idProjetUnique() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Récupère le blob source d'un élément média déjà chargé (son `src` est une
// URL blob: valide tant que la page n'a pas rechargé) — nécessaire car
// EditorState ne garde que l'élément <img>/<video>/<audio>, jamais le
// fichier d'origine.
async function blobDepuisElementMedia(el) {
  if (!el || !el.src) return null;
  try {
    const reponse = await fetch(el.src);
    return await reponse.blob();
  } catch (_) {
    return null;
  }
}

async function serialiserProjetComplet() {
  const etat = {};
  for (const champ of CHAMPS_HISTORIQUE) etat[champ] = cloneProfondSansDom(EditorState[champ]);
  etat.photos.forEach((p) => {
    delete p.img;
    delete p.bgOverrideVideoEl;
    delete p.bgOverrideImageEl;
    (p.sousMedias || []).forEach((sm) => delete sm.img);
  });
  ['intro', 'outro'].forEach((seg) => {
    delete etat[seg].logoImg;
    delete etat[seg].img;
  });

  const medias = {
    bg: await blobDepuisElementMedia(EditorState.bgVideoEl || EditorState.bgImageEl),
    bgType: EditorState.bgVideoEl ? 'video' : EditorState.bgImageEl ? 'image' : null,
    introLogo: await blobDepuisElementMedia(EditorState.intro.logoImg),
    introImg: await blobDepuisElementMedia(EditorState.intro.img),
    outroLogo: await blobDepuisElementMedia(EditorState.outro.logoImg),
    outroImg: await blobDepuisElementMedia(EditorState.outro.img),
    audio: await blobDepuisElementMedia(EditorState.audioEl),
    voice: await blobDepuisElementMedia(EditorState.voiceEl),
    font: EditorState.fontBlob || null,
    fontFileName: EditorState.fontFileName || null,
    photos: {},
  };
  for (const p of EditorState.photos) {
    medias.photos[p.id] = {
      media: await blobDepuisElementMedia(p.img),
      mediaType: p.img ? (p.img.tagName === 'VIDEO' ? 'video' : 'image') : null,
      bgOverride: await blobDepuisElementMedia(p.bgOverrideVideoEl || p.bgOverrideImageEl),
      bgOverrideType: p.bgOverrideVideoEl ? 'video' : p.bgOverrideImageEl ? 'image' : null,
      sousMedias: {},
    };
    for (const sm of p.sousMedias || []) {
      medias.photos[p.id].sousMedias[sm.id] = {
        media: await blobDepuisElementMedia(sm.img),
        mediaType: sm.img ? (sm.img.tagName === 'VIDEO' ? 'video' : 'image') : null,
      };
    }
  }
  return { etat, medias };
}

async function restaurerProjetComplet({ etat, medias }) {
  Historique.enPause = true;
  for (const champ of CHAMPS_HISTORIQUE) EditorState[champ] = cloneProfondSansDom(etat[champ]);

  EditorState.bgVideoEl = null;
  EditorState.bgImageEl = null;
  if (medias.bg && medias.bgType === 'video') EditorState.bgVideoEl = await chargerMediaPhoto(medias.bg);
  else if (medias.bg && medias.bgType === 'image') EditorState.bgImageEl = await chargerImage(medias.bg);

  EditorState.intro.logoImg = medias.introLogo ? await chargerImage(medias.introLogo) : null;
  EditorState.intro.img = medias.introImg ? await chargerImage(medias.introImg) : null;
  EditorState.outro.logoImg = medias.outroLogo ? await chargerImage(medias.outroLogo) : null;
  EditorState.outro.img = medias.outroImg ? await chargerImage(medias.outroImg) : null;

  EditorState.audioEl = null;
  EditorState.audioGainNode = null;
  if (medias.audio) {
    const audio = new Audio();
    audio.src = URL.createObjectURL(medias.audio);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    audio.currentTime = EditorState.audioTrimStart;
    EditorState.audioEl = audio;
    brancherAnalyseurAudio(audio);
    calculerWaveform(medias.audio);
  }

  EditorState.voiceEl = null;
  EditorState.voiceGainNode = null;
  if (medias.voice) {
    const voice = new Audio();
    voice.src = URL.createObjectURL(medias.voice);
    voice.crossOrigin = 'anonymous';
    EditorState.voiceEl = voice;
    brancherVoixOff(voice);
  }

  EditorState.fontFamily = null;
  EditorState.fontBlob = null;
  EditorState.fontFileName = null;
  if (medias.font) {
    try {
      const buf = await medias.font.arrayBuffer();
      const face = new FontFace('PolicePersonnalisee', buf);
      await face.load();
      document.fonts.add(face);
      EditorState.fontFamily = 'PolicePersonnalisee';
      EditorState.fontBlob = medias.font;
      EditorState.fontFileName = medias.fontFileName;
    } catch (_) {}
  }

  for (const p of EditorState.photos) {
    p.img = null;
    p.bgOverrideVideoEl = null;
    p.bgOverrideImageEl = null;
    const m = medias.photos ? medias.photos[p.id] : null;
    if (m && m.media) p.img = m.mediaType === 'video' ? await chargerMediaPhoto(m.media) : await chargerImage(m.media);
    if (m && m.bgOverride) {
      if (m.bgOverrideType === 'video') p.bgOverrideVideoEl = await chargerMediaPhoto(m.bgOverride);
      else p.bgOverrideImageEl = await chargerImage(m.bgOverride);
    }
    for (const sm of p.sousMedias || []) {
      sm.img = null;
      const msm = m && m.sousMedias ? m.sousMedias[sm.id] : null;
      if (msm && msm.media) sm.img = msm.mediaType === 'video' ? await chargerMediaPhoto(msm.media) : await chargerImage(msm.media);
    }
  }

  rafraichirListePhotos();
  rafraichirListeTextBlocks();
  rafraichirListeFormes();
  rafraichirPanneauDessin();
  rafraichirPanneauApresRestauration();
  Historique.enPause = false;
  initHistorique();
}

async function nouveauProjetVide() {
  Historique.enPause = true;
  for (const champ of CHAMPS_HISTORIQUE) EditorState[champ] = cloneProfondSansDom(ETAT_INITIAL[champ]);
  for (const champ of CHAMPS_HISTORIQUE_REFS) EditorState[champ] = null;
  EditorState.fontFamily = null;
  EditorState.fontBlob = null;
  EditorState.fontFileName = null;
  EditorState.projetId = null;
  EditorState.projetNom = 'Projet sans titre';
  EditorState.playback.currentTime = 0;
  EditorState.playback.playing = false;
  rafraichirListePhotos();
  rafraichirListeTextBlocks();
  rafraichirListeFormes();
  rafraichirPanneauDessin();
  rafraichirPanneauApresRestauration();
  Historique.enPause = false;
  initHistorique();
  await rafraichirPanneauProjet();
  toast('Nouveau projet créé.', 'success');
}

async function sauvegarderProjetCourant({ commeNouveau = false, nom } = {}) {
  const { etat, medias } = await serialiserProjetComplet();
  const nouveau = commeNouveau || !EditorState.projetId;
  const id = nouveau ? idProjetUnique() : EditorState.projetId;
  const nomFinal = nom || EditorState.projetNom || 'Projet sans titre';
  const maintenant = Date.now();
  const existant = nouveau ? null : await enregistrementProjetGet(id).catch(() => null);
  const record = {
    id,
    type: 'projet',
    nom: nomFinal,
    createdAt: (existant && existant.createdAt) || maintenant,
    updatedAt: maintenant,
    etat,
    medias,
  };
  await enregistrementProjetPut(record);
  EditorState.projetId = id;
  EditorState.projetNom = nomFinal;
  await rafraichirPanneauProjet();
  toast(`Projet « ${nomFinal} » enregistré.`, 'success');
  return record;
}

async function chargerProjet(id) {
  const record = await enregistrementProjetGet(id);
  if (!record) {
    toast('Projet introuvable.', 'error');
    return;
  }
  await restaurerProjetComplet(record);
  EditorState.projetId = record.id;
  EditorState.projetNom = record.nom;
  await rafraichirPanneauProjet();
  toast(`Projet « ${record.nom} » chargé.`, 'success');
}

async function dupliquerProjet(id) {
  const record = await enregistrementProjetGet(id);
  if (!record) return;
  const copie = {
    ...record,
    id: idProjetUnique(),
    nom: `${record.nom} (copie)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await enregistrementProjetPut(copie);
  await rafraichirPanneauProjet();
  toast(`Projet dupliqué en « ${copie.nom} ».`, 'success');
}

async function renommerProjet(id, nouveauNom) {
  const record = await enregistrementProjetGet(id);
  if (!record || !nouveauNom || !nouveauNom.trim()) return;
  record.nom = nouveauNom.trim();
  record.updatedAt = Date.now();
  await enregistrementProjetPut(record);
  if (EditorState.projetId === id) EditorState.projetNom = record.nom;
  await rafraichirPanneauProjet();
}

async function supprimerProjet(id) {
  const tous = await enregistrementProjetGetAll();
  const aSupprimer = tous.filter((r) => r.id === id || r.parentId === id);
  for (const r of aSupprimer) await enregistrementProjetDelete(r.id);
  if (EditorState.projetId === id) EditorState.projetId = null;
  await rafraichirPanneauProjet();
  toast('Projet supprimé.', 'success');
}

async function creerCheckpoint(nom) {
  if (!EditorState.projetId) await sauvegarderProjetCourant();
  const { etat, medias } = await serialiserProjetComplet();
  const record = {
    id: idProjetUnique(),
    type: 'checkpoint',
    parentId: EditorState.projetId,
    nom: nom && nom.trim() ? nom.trim() : new Date().toLocaleString('fr-FR'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    etat,
    medias,
  };
  await enregistrementProjetPut(record);
  await rafraichirPanneauProjet();
  toast('Point de sauvegarde créé.', 'success');
}

async function restaurerCheckpoint(id) {
  const record = await enregistrementProjetGet(id);
  if (!record) return;
  await restaurerProjetComplet(record);
  toast(`Restauré depuis « ${record.nom} ».`, 'success');
}

async function supprimerCheckpoint(id) {
  await enregistrementProjetDelete(id);
  await rafraichirPanneauProjet();
}

/* ---- Sauvegarde automatique ------------------------------------------ */
let _autoSaveTimer = null;
function planifierAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(sauvegarderAutoSave, 2500);
}

async function sauvegarderAutoSave() {
  try {
    const { etat, medias } = await serialiserProjetComplet();
    await enregistrementProjetPut({
      id: AUTOSAVE_ID,
      type: 'autosave',
      nom: EditorState.projetNom || 'Brouillon automatique',
      projetId: EditorState.projetId,
      updatedAt: Date.now(),
      etat,
      medias,
    });
  } catch (_) {
    /* échec silencieux : l'auto-save est un filet de sécurité, pas une
       action demandée explicitement par l'utilisateur */
  }
}

async function restaurerAutoSave() {
  const record = await enregistrementProjetGet(AUTOSAVE_ID);
  if (!record) return;
  await restaurerProjetComplet(record);
  EditorState.projetId = record.projetId || null;
  EditorState.projetNom = record.nom || 'Projet sans titre';
  await rafraichirPanneauProjet();
  const banniere = document.getElementById('editor-projet-autosave-banner');
  if (banniere) banniere.classList.add('hidden');
  toast('Brouillon automatique restauré.', 'success');
}

async function verifierAutoSaveAuDemarrage() {
  const banniere = document.getElementById('editor-projet-autosave-banner');
  if (!banniere) return;
  if (EditorState.projetId) {
    banniere.classList.add('hidden');
    return;
  }
  const record = await enregistrementProjetGet(AUTOSAVE_ID).catch(() => null);
  const vide =
    !record ||
    (!(record.etat?.photos?.length) &&
      !(record.etat?.textBlocks?.length) &&
      !record.medias?.bg &&
      !record.medias?.audio);
  banniere.classList.toggle('hidden', vide);
}

/* ---- Export / import en fichier portable ------------------------------ */
async function blobVersDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(lecteur.result);
    lecteur.onerror = reject;
    lecteur.readAsDataURL(blob);
  });
}

async function dataUrlVersBlob(dataUrl) {
  const reponse = await fetch(dataUrl);
  return reponse.blob();
}

async function encoderMediasEnBase64(valeur) {
  if (valeur instanceof Blob) return { __blob64: await blobVersDataUrl(valeur) };
  if (Array.isArray(valeur)) return Promise.all(valeur.map(encoderMediasEnBase64));
  if (valeur && typeof valeur === 'object') {
    const out = {};
    for (const cle of Object.keys(valeur)) out[cle] = await encoderMediasEnBase64(valeur[cle]);
    return out;
  }
  return valeur;
}

async function decoderMediasDepuisBase64(valeur) {
  if (valeur && typeof valeur === 'object' && typeof valeur.__blob64 === 'string') {
    return dataUrlVersBlob(valeur.__blob64);
  }
  if (Array.isArray(valeur)) return Promise.all(valeur.map(decoderMediasDepuisBase64));
  if (valeur && typeof valeur === 'object') {
    const out = {};
    for (const cle of Object.keys(valeur)) out[cle] = await decoderMediasDepuisBase64(valeur[cle]);
    return out;
  }
  return valeur;
}

async function exporterProjetFichier() {
  const { etat, medias } = await serialiserProjetComplet();
  const mediasB64 = await encoderMediasEnBase64(medias);
  const fichier = {
    format: 'playtesteur-editor-projet',
    version: 1,
    nom: EditorState.projetNom || 'Projet sans titre',
    exporteLe: new Date().toISOString(),
    etat,
    medias: mediasB64,
  };
  const blob = new Blob([JSON.stringify(fichier)], { type: 'application/json' });
  const nomFichier = (EditorState.projetNom || 'projet').replace(/[^\w-]+/g, '_').toLowerCase();
  downloadBlob(blob, `${nomFichier || 'projet'}.playtesteur.json`);
  toast('Projet exporté en fichier.', 'success');
}

async function importerProjetFichier(file) {
  try {
    const texte = await file.text();
    const fichier = JSON.parse(texte);
    if (fichier.format !== 'playtesteur-editor-projet') throw new Error('Fichier de projet invalide.');
    const medias = await decoderMediasDepuisBase64(fichier.medias);
    await restaurerProjetComplet({ etat: fichier.etat, medias });
    EditorState.projetId = null; // traité comme un nouveau projet local, pas encore enregistré
    EditorState.projetNom = fichier.nom || 'Projet importé';
    await rafraichirPanneauProjet();
    toast(`Projet « ${EditorState.projetNom} » importé.`, 'success');
  } catch (err) {
    console.error('[editeur] import projet échoué', err);
    toast("Impossible d'importer ce fichier de projet.", 'error');
  }
}

/* ---- UI ---------------------------------------------------------------- */
function formaterDateProjet(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function rafraichirPanneauProjet() {
  const nomInput = document.getElementById('editor-projet-nom');
  if (nomInput && document.activeElement !== nomInput) nomInput.value = EditorState.projetNom || '';

  const tous = await enregistrementProjetGetAll().catch(() => []);
  const projets = tous.filter((r) => r.type === 'projet').sort((a, b) => b.updatedAt - a.updatedAt);
  const checkpoints = EditorState.projetId
    ? tous
        .filter((r) => r.type === 'checkpoint' && r.parentId === EditorState.projetId)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];

  const listeEl = document.getElementById('editor-projet-liste');
  if (listeEl) {
    listeEl.innerHTML = projets.length
      ? projets
          .map(
            (p) => `
        <div class="editor-projet-item ${p.id === EditorState.projetId ? 'active' : ''}">
          <span class="editor-projet-item-nom" title="${escapeHtml(p.nom)}">${escapeHtml(p.nom)}</span>
          <span class="editor-projet-item-date">${formaterDateProjet(p.updatedAt)}</span>
          <div class="editor-projet-item-actions">
            <button type="button" data-projet-charger="${p.id}" title="Charger">Charger</button>
            <button type="button" data-projet-dupliquer="${p.id}" title="Dupliquer">Dupliquer</button>
            <button type="button" data-projet-renommer="${p.id}" title="Renommer">Renommer</button>
            <button type="button" data-projet-supprimer="${p.id}" title="Supprimer" class="editor-remove-btn">&times;</button>
          </div>
        </div>`
          )
          .join('')
      : `<p class="form-hint">Aucun projet enregistré pour l'instant.</p>`;

    listeEl.querySelectorAll('[data-projet-charger]').forEach((btn) => {
      btn.addEventListener('click', () => chargerProjet(btn.dataset.projetCharger));
    });
    listeEl.querySelectorAll('[data-projet-dupliquer]').forEach((btn) => {
      btn.addEventListener('click', () => dupliquerProjet(btn.dataset.projetDupliquer));
    });
    listeEl.querySelectorAll('[data-projet-renommer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nouveauNom = prompt('Nouveau nom du projet :');
        if (nouveauNom) renommerProjet(btn.dataset.projetRenommer, nouveauNom);
      });
    });
    listeEl.querySelectorAll('[data-projet-supprimer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Supprimer ce projet et ses points de sauvegarde ?')) supprimerProjet(btn.dataset.projetSupprimer);
      });
    });
  }

  const checkpointsEl = document.getElementById('editor-projet-checkpoints');
  if (checkpointsEl) {
    checkpointsEl.innerHTML = checkpoints.length
      ? checkpoints
          .map(
            (c) => `
        <div class="editor-projet-item">
          <span class="editor-projet-item-nom" title="${escapeHtml(c.nom)}">${escapeHtml(c.nom)}</span>
          <span class="editor-projet-item-date">${formaterDateProjet(c.createdAt)}</span>
          <div class="editor-projet-item-actions">
            <button type="button" data-checkpoint-restaurer="${c.id}" title="Restaurer">Restaurer</button>
            <button type="button" data-checkpoint-supprimer="${c.id}" title="Supprimer" class="editor-remove-btn">&times;</button>
          </div>
        </div>`
          )
          .join('')
      : '<p class="form-hint">Aucun point de sauvegarde pour ce projet.</p>';

    checkpointsEl.querySelectorAll('[data-checkpoint-restaurer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Restaurer ce point de sauvegarde ? Les modifications non enregistrées seront perdues.')) {
          restaurerCheckpoint(btn.dataset.checkpointRestaurer);
        }
      });
    });
    checkpointsEl.querySelectorAll('[data-checkpoint-supprimer]').forEach((btn) => {
      btn.addEventListener('click', () => supprimerCheckpoint(btn.dataset.checkpointSupprimer));
    });
  }
}

function bindGestionProjet() {
  const nomInput = document.getElementById('editor-projet-nom');
  if (nomInput) {
    nomInput.addEventListener('change', (e) => {
      EditorState.projetNom = e.target.value.trim() || 'Projet sans titre';
      if (EditorState.projetId) renommerProjet(EditorState.projetId, EditorState.projetNom);
    });
  }
  const btnNouveau = document.getElementById('editor-projet-nouveau');
  if (btnNouveau) {
    btnNouveau.addEventListener('click', () => {
      if (confirm('Créer un nouveau projet vide ? Les modifications non enregistrées seront perdues.')) nouveauProjetVide();
    });
  }
  const btnEnregistrer = document.getElementById('editor-projet-enregistrer');
  if (btnEnregistrer) {
    btnEnregistrer.addEventListener('click', () => {
      const nomActuel = document.getElementById('editor-projet-nom');
      sauvegarderProjetCourant({ nom: nomActuel ? nomActuel.value.trim() : undefined });
    });
  }
  const btnEnregistrerSous = document.getElementById('editor-projet-enregistrer-sous');
  if (btnEnregistrerSous) {
    btnEnregistrerSous.addEventListener('click', () => {
      const nouveauNom = prompt('Nom du nouveau projet :', `${EditorState.projetNom} (copie)`);
      if (nouveauNom) sauvegarderProjetCourant({ commeNouveau: true, nom: nouveauNom });
    });
  }
  const btnCheckpoint = document.getElementById('editor-projet-checkpoint');
  if (btnCheckpoint) {
    btnCheckpoint.addEventListener('click', () => {
      const nom = prompt('Nom de ce point de sauvegarde (optionnel) :', '');
      creerCheckpoint(nom);
    });
  }
  const btnExport = document.getElementById('editor-projet-export');
  if (btnExport) btnExport.addEventListener('click', exporterProjetFichier);

  const importInput = document.getElementById('editor-projet-import-input');
  if (importInput) {
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importerProjetFichier(file);
      e.target.value = '';
    });
  }

  const btnRestaurerAutosave = document.getElementById('editor-projet-restaurer-autosave');
  if (btnRestaurerAutosave) btnRestaurerAutosave.addEventListener('click', restaurerAutoSave);
  const btnIgnorerAutosave = document.getElementById('editor-projet-ignorer-autosave');
  if (btnIgnorerAutosave) {
    btnIgnorerAutosave.addEventListener('click', () => {
      const banniere = document.getElementById('editor-projet-autosave-banner');
      if (banniere) banniere.classList.add('hidden');
    });
  }

  verifierAutoSaveAuDemarrage();
  rafraichirPanneauProjet();
}

// Resynchronise les champs du panneau qui ne sont pas régénérés depuis
// zéro (contrairement aux listes photos/textBlocks) après une restauration
// d'historique — sinon la valeur affichée dans l'input diverge de
// EditorState tant que l'utilisateur n'y touche pas lui-même.
function rafraichirPanneauApresRestauration() {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  const setChecked = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  };
  const toggleHidden = (id, hidden) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', hidden);
  };
  // Sans ça, "Aucun fichier choisi" restait affiché après un chargement de
  // projet/checkpoint/undo alors qu'un média était bel et bien restauré —
  // seul un choix direct dans le champ mettait ce libellé à jour.
  const majNomFichier = (id, dejaCharge, libelle) => {
    const el = document.getElementById(id);
    if (el) el.textContent = dejaCharge ? libelle : 'Aucun fichier choisi';
  };

  const bgMode = EditorState.bgType === 'color' ? 'color' : EditorState.bgType === 'gradient' ? 'gradient' : 'media';
  setVal('editor-bg-type', bgMode);
  toggleHidden('editor-bg-media-panel', bgMode !== 'media');
  toggleHidden('editor-bg-color-panel', bgMode !== 'color');
  toggleHidden('editor-bg-gradient-panel', bgMode !== 'gradient');
  setVal('editor-bg-color', EditorState.bgColor);
  setVal('editor-bg-gradient1', EditorState.bgGradient.color1);
  setVal('editor-bg-gradient2', EditorState.bgGradient.color2);
  setVal('editor-bg-gradient-angle', EditorState.bgGradient.angle);
  setVal('editor-bg-brightness', EditorState.bgAdjust.brightness);
  setVal('editor-bg-blur', EditorState.bgAdjust.blur);
  setVal('editor-overlay-type', EditorState.overlay.type);
  setVal('editor-overlay-strength', Math.round(EditorState.overlay.strength * 100));
  setChecked('editor-bg-chromakey-toggle', EditorState.bgChromaKey.active);
  setVal('editor-bg-chromakey-color', EditorState.bgChromaKey.color);
  setVal('editor-bg-chromakey-tolerance', Math.round(EditorState.bgChromaKey.tolerance * 100));
  majNomFichier('editor-bg-filename', EditorState.bgVideoEl || EditorState.bgImageEl, EditorState.bgVideoEl ? 'Vidéo chargée' : 'Image chargée');

  setVal('editor-audio-volume', Math.round(EditorState.audioVolume * 100));
  setVal('editor-audio-fadein', EditorState.audioFadeIn);
  setVal('editor-audio-fadeout', EditorState.audioFadeOut);
  setVal('editor-audio-trim', EditorState.audioTrimStart);
  setVal('editor-voice-volume', Math.round(EditorState.voiceVolume * 100));
  majNomFichier('editor-audio-filename', EditorState.audioEl, 'Musique chargée');
  majNomFichier('editor-voice-filename', EditorState.voiceEl, 'Voix off chargée');
  majNomFichier('editor-font-filename', EditorState.fontBlob, EditorState.fontFileName || 'Police chargée');

  ['intro', 'outro'].forEach((prefix) => {
    const seg = EditorState[prefix];
    setChecked(`editor-${prefix}-toggle`, seg.active);
    toggleHidden(`editor-${prefix}-panel`, !seg.active);
    setVal(`editor-${prefix}-text`, seg.texte || '');
    setVal(`editor-${prefix}-duree`, seg.duree);
    majNomFichier(`editor-${prefix}-logo-filename`, seg.logoImg, 'Logo chargé');
    majNomFichier(`editor-${prefix}-img-filename`, seg.img, 'Image chargée');
  });

  setVal('editor-transition-type', EditorState.transitionType);
  setChecked('editor-bloom-toggle', EditorState.effects.bloomActive);
  setVal('editor-bloom-strength', Math.round(EditorState.effects.bloomStrength * 20));
  setChecked('editor-bloom-audioreactive', EditorState.effects.bloomAudioReactive);
  setVal('editor-cadre-type', EditorState.cadreDecoratif.type);
  setVal('editor-cadre-couleur', EditorState.cadreDecoratif.couleur);
  setVal('editor-cadre-epaisseur', EditorState.cadreDecoratif.epaisseur);

  const formatRadio = document.querySelector(`input[name="editor-img-format"][value="${EditorState.imageExportFormat}"]`);
  if (formatRadio) formatRadio.checked = true;

  document.querySelectorAll('.editor-controls input[type="range"]').forEach((input) => {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = ((Number(input.value) - min) / (max - min || 1)) * 100;
    input.style.setProperty('--range-progress', `${pct}%`);
  });
}

// Polices déjà chargées statiquement dans index.html (disponibles dès le
// premier rendu, sans requête réseau supplémentaire).
const FONTS_DISPONIBLES = [
  { value: "'Space Grotesk', sans-serif", label: 'Space Grotesk' },
  { value: "'Roboto', sans-serif", label: 'Roboto' },
  { value: "'Bebas Neue', sans-serif", label: 'Bebas Neue' },
  { value: "'Anton', sans-serif", label: 'Anton' },
  { value: "'Caveat', cursive", label: 'Caveat (manuscrite)' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
];

// Polices Google Fonts supplémentaires, chargées à la demande (voir
// chargerGoogleFontsEtendues()) uniquement quand l'éditeur s'ouvre, pour ne
// pas alourdir le chargement des autres pages du site avec des polices
// qu'elles n'utilisent jamais.
const FONTS_ETENDUES = [
  { famille: 'Montserrat', poids: '400;700;900', value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { famille: 'Oswald', poids: '400;700', value: "'Oswald', sans-serif", label: 'Oswald (condensée)' },
  { famille: 'Poppins', poids: '400;600;800', value: "'Poppins', sans-serif", label: 'Poppins' },
  { famille: 'Raleway', poids: '400;700;900', value: "'Raleway', sans-serif", label: 'Raleway' },
  { famille: 'Inter', poids: '400;700;900', value: "'Inter', sans-serif", label: 'Inter' },
  { famille: 'Archivo+Black', poids: '400', value: "'Archivo Black', sans-serif", label: 'Archivo Black (impact)' },
  { famille: 'Bungee', poids: '400', value: "'Bungee', sans-serif", label: 'Bungee' },
  { famille: 'Righteous', poids: '400', value: "'Righteous', sans-serif", label: 'Righteous' },
  { famille: 'Permanent+Marker', poids: '400', value: "'Permanent Marker', cursive", label: 'Permanent Marker (feutre)' },
  { famille: 'Pacifico', poids: '400', value: "'Pacifico', cursive", label: 'Pacifico (manuscrite)' },
  { famille: 'Shrikhand', poids: '400', value: "'Shrikhand', cursive", label: 'Shrikhand' },
  { famille: 'Merriweather', poids: '400;700;900', value: "'Merriweather', serif", label: 'Merriweather' },
  { famille: 'Abril+Fatface', poids: '400', value: "'Abril Fatface', serif", label: 'Abril Fatface' },
  { famille: 'Cormorant+Garamond', poids: '400;600;700', value: "'Cormorant Garamond', serif", label: 'Cormorant Garamond' },
  { famille: 'Amatic+SC', poids: '400;700', value: "'Amatic SC', cursive", label: 'Amatic SC' },
  { famille: 'Comfortaa', poids: '400;700', value: "'Comfortaa', sans-serif", label: 'Comfortaa (arrondie)' },
  { famille: 'Fira+Code', poids: '400;700', value: "'Fira Code', monospace", label: 'Fira Code (monospace)' },
];

let _googleFontsEtenduesChargees = false;
function chargerGoogleFontsEtendues() {
  if (_googleFontsEtenduesChargees) return;
  _googleFontsEtenduesChargees = true;
  const familles = FONTS_ETENDUES.map((f) => `family=${f.famille}:wght@${f.poids}`).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${familles}&display=swap`;
  document.head.appendChild(link);
}

function arreterEditeur() {
  if (editorRafId) {
    cancelAnimationFrame(editorRafId);
    editorRafId = null;
  }
}

// Accordéon exclusif (un seul ouvert à la fois parmi les frères de même
// niveau) + remplissage visuel des sliders (--range-progress). Écouteurs
// en phase de capture sur le panneau entier : l'event 'toggle' de
// <details> ne bubble pas de façon fiable, mais la capture descendante
// fonctionne même pour du contenu régénéré dynamiquement (listes photo/
// texte), sans avoir à ré-attacher quoi que ce soit à chaque refresh.
function bindAccordionUx() {
  const panel = document.querySelector('.editor-controls');
  if (!panel || panel.dataset.uxBound) return;
  panel.dataset.uxBound = '1';

  panel.addEventListener(
    'toggle',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLDetailsElement) || !el.open) return;
      const selector = el.classList.contains('editor-accordion-nested')
        ? ':scope > .editor-accordion-nested'
        : ':scope > .editor-accordion';
      const siblingsParent = el.parentElement;
      if (!siblingsParent) return;
      siblingsParent.querySelectorAll(selector).forEach((sib) => {
        if (sib !== el) sib.open = false;
      });
    },
    true
  );

  const majProgress = (input) => {
    if (input.type !== 'range') return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = ((Number(input.value) - min) / (max - min || 1)) * 100;
    input.style.setProperty('--range-progress', `${pct}%`);
  };
  panel.addEventListener('input', (e) => majProgress(e.target), true);
  // Valeurs initiales (au chargement et après chaque régénération de liste).
  new MutationObserver(() => {
    panel.querySelectorAll('input[type="range"]').forEach(majProgress);
  }).observe(panel, { childList: true, subtree: true });
  panel.querySelectorAll('input[type="range"]').forEach(majProgress);

  // Historique (undo/redo) : capture un instantané ~500ms après la
  // dernière modification faite via le panneau, plutôt qu'à chaque frappe
  // (un slider glissé ou un texte tapé produiraient sinon des dizaines
  // d'états intermédiaires inutiles).
  let debounceHistorique = null;
  panel.addEventListener(
    'input',
    () => {
      clearTimeout(debounceHistorique);
      debounceHistorique = setTimeout(pousserHistorique, 500);
    },
    true
  );
  panel.addEventListener(
    'change',
    (e) => {
      if (e.target.type === 'range') return; // déjà couvert par 'input' au relâchement
      clearTimeout(debounceHistorique);
      debounceHistorique = setTimeout(pousserHistorique, 500);
    },
    true
  );
}

async function initEditeur() {
  const canvas = document.getElementById('editor-canvas');
  if (!canvas) return;

  bindEditorInputs();
  bindTimelineControls();
  bindAccordionUx();
  bindHistoriqueUx();
  bindReglagesIa();
  bindPixabay();
  bindGestionProjet();
  bindBarreSelectionGroupee();
  chargerGoogleFontsEtendues();
  rafraichirListePhotos();
  rafraichirListeTextBlocks();
  rafraichirListeFormes();
  bindModeDessin();
  bindCadreDecoratif();

  arreterEditeur();
  await initMoteur3D(canvas);
  bindEditorDrag3D(canvas);

  // L'historique lui-même (pile de snapshots) est un état de session, pas
  // de DOM : ne l'initialiser qu'une fois, sinon revenir sur la vue
  // éditeur (SPA) effacerait l'undo/redo en cours.
  if (Historique.pile.length === 0) initHistorique();
  else majBoutonsHistorique();

  (function loop() {
    renderEditorFrame();
    editorRafId = requestAnimationFrame(loop);
  })();
}

function bindHistoriqueUx() {
  const btnUndo = document.getElementById('editor-undo-btn');
  const btnRedo = document.getElementById('editor-redo-btn');
  if (btnUndo && !btnUndo.dataset.bound) {
    btnUndo.dataset.bound = '1';
    btnUndo.addEventListener('click', annulerHistorique);
  }
  if (btnRedo && !btnRedo.dataset.bound) {
    btnRedo.dataset.bound = '1';
    btnRedo.addEventListener('click', refaireHistorique);
  }
  if (!window._playtesteurHistoryKeysBound) {
    window._playtesteurHistoryKeysBound = true;
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!document.getElementById('editor-canvas')) return; // pas sur la vue éditeur
      const cible = document.activeElement;
      const dansChampTexte =
        cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.isContentEditable);
      if (dansChampTexte) return; // laisser l'undo natif du champ agir
      const touche = e.key.toLowerCase();
      if (touche === 'z' && !e.shiftKey) {
        e.preventDefault();
        annulerHistorique();
      } else if (touche === 'y' || (touche === 'z' && e.shiftKey)) {
        e.preventDefault();
        refaireHistorique();
      }
    });
  }
}

/* -------------------------------------------------------------------- */
/* Timeline (intro -> photos -> outro)                                   */
/* -------------------------------------------------------------------- */
function calculerTimeline() {
  const segments = [];
  let t = 0;
  if (EditorState.intro.active) {
    const duree = Math.max(0.5, Number(EditorState.intro.duree) || 3);
    segments.push({ type: 'intro', start: t, end: t + duree, data: EditorState.intro });
    t += duree;
  }
  EditorState.photos.forEach((p) => {
    if (p.visible === false) return; // calque masqué : exclu de la timeline, comme une piste muette
    const duree = Math.max(0.5, Number(p.duree) || 3);
    segments.push({ type: 'photo', start: t, end: t + duree, data: p });
    t += duree;
  });
  if (EditorState.outro.active) {
    const duree = Math.max(0.5, Number(EditorState.outro.duree) || 3);
    segments.push({ type: 'outro', start: t, end: t + duree, data: EditorState.outro });
    t += duree;
  }
  return { segments, dureeTotale: t };
}

function segmentAuTemps(segments, t) {
  return segments.find((s) => t >= s.start && t < s.end) || segments[segments.length - 1] || null;
}

function allerAuSegment(predicate) {
  const { segments } = calculerTimeline();
  const seg = segments.find(predicate);
  if (seg) {
    EditorState.playback.playing = false;
    EditorState.playback.currentTime = Math.min(seg.start + 0.05, Math.max(seg.start, seg.end - 0.01));
  }
}

function avancerPlayback(dureeTotale) {
  const now = performance.now();
  if (EditorState.playback.playing) {
    if (EditorState.playback.lastFrameTs != null) {
      const delta = (now - EditorState.playback.lastFrameTs) / 1000;
      EditorState.playback.currentTime += delta;
      if (EditorState.playback.currentTime >= dureeTotale) {
        EditorState.playback.currentTime = dureeTotale > 0 ? dureeTotale - 0.001 : 0;
        EditorState.playback.playing = false;
      }
    }
    EditorState.playback.lastFrameTs = now;
  } else {
    EditorState.playback.lastFrameTs = null;
  }
  if (EditorState.playback.currentTime > dureeTotale) {
    EditorState.playback.currentTime = Math.max(0, dureeTotale - 0.001);
  }
}

function bindTimelineControls() {
  const playBtn = document.getElementById('editor-play-btn');
  const scrubber = document.getElementById('editor-scrubber');
  if (!playBtn || !scrubber) return;

  playBtn.addEventListener('click', async () => {
    const { dureeTotale } = calculerTimeline();
    if (dureeTotale <= 0) return;
    if (EditorState.playback.currentTime >= dureeTotale - 0.02) EditorState.playback.currentTime = 0;
    EditorState.playback.playing = !EditorState.playback.playing;
    EditorState.playback.lastFrameTs = null;

    if (EditorState.playback.playing) {
      // Un clic est garanti être un vrai geste utilisateur : c'est le
      // point de rattrapage fiable pour (re)lancer tout l'audio/vidéo,
      // y compris quand le premier appel .play() (au chargement d'un
      // média, potentiellement déclenché par script plutôt que par
      // l'utilisateur) avait été silencieusement bloqué par la politique
      // autoplay du navigateur — sans quoi la musique ne redémarre jamais.
      if (EditorState.audioCtx && EditorState.audioCtx.state === 'suspended') {
        await EditorState.audioCtx.resume().catch(() => {});
      }
      if (EditorState.audioEl) EditorState.audioEl.play().catch(() => {});
      if (EditorState.voiceEl) EditorState.voiceEl.play().catch(() => {});
      if (EditorState.bgVideoEl) EditorState.bgVideoEl.play().catch(() => {});
    }
  });

  scrubber.addEventListener('pointerdown', () => {
    EditorState._scrubbing = true;
    EditorState.playback.playing = false;
  });
  scrubber.addEventListener('input', (e) => {
    const { dureeTotale } = calculerTimeline();
    EditorState.playback.currentTime = (Number(e.target.value) / 100) * dureeTotale;
  });
  ['pointerup', 'pointercancel'].forEach((evtName) => {
    scrubber.addEventListener(evtName, () => {
      EditorState._scrubbing = false;
    });
  });
}

function mettreAJourUiTimeline(dureeTotale) {
  const playBtn = document.getElementById('editor-play-btn');
  const scrubber = document.getElementById('editor-scrubber');
  const label = document.getElementById('editor-time-label');
  if (playBtn) playBtn.textContent = EditorState.playback.playing ? '⏸' : '▶';
  if (label) label.textContent = `${EditorState.playback.currentTime.toFixed(1)}s / ${dureeTotale.toFixed(1)}s`;
  if (scrubber && !EditorState._scrubbing) {
    scrubber.value = dureeTotale > 0 ? (EditorState.playback.currentTime / dureeTotale) * 100 : 0;
  }
}

/* -------------------------------------------------------------------- */
/* Moteur 3D (three.js)                                                  */
/* -------------------------------------------------------------------- */
async function initMoteur3D(canvas) {
  const THREE = await import('/vendor/three/three.module.min.js');
  const width = canvas.width;
  const height = canvas.height;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  // Caméra perspective calibrée pour que le plan z=0 corresponde
  // exactement aux dimensions du cadre en unités "pixel" (origine au
  // centre, Y vers le haut) : convertirPx() fait le pont avec le système
  // de coordonnées pixel (origine haut-gauche, Y vers le bas) utilisé
  // partout ailleurs dans l'éditeur.
  const fovDeg = 45;
  const camera = new THREE.PerspectiveCamera(fovDeg, width / height, 1, 20000);
  const distance = height / 2 / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(0.4, 0.6, 1);
  scene.add(dirLight);

  // Le fond est placé en retrait (z=-bgDepth) pour rester derrière tous
  // les calques quelle que soit leur profondeur. Avec une caméra en
  // perspective, un plan plus loin de la caméra couvre un champ de vision
  // plus large à taille égale : sans compenser, un plan simplement mis à
  // l'échelle width x height (calibrée pour z=0) apparaît plus petit que
  // le cadre, laissant des bandes noires sur les bords.
  const bgDepth = 500;
  const bgGeo = new THREE.PlaneGeometry(1, 1);
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x12151c });
  const bgMesh = new THREE.Mesh(bgGeo, bgMat);
  bgMesh.position.z = -bgDepth;
  const bgScale = (distance + bgDepth) / distance;
  bgMesh.scale.set(width * bgScale, height * bgScale, 1);
  scene.add(bgMesh);

  // Post-processing "glow" (effet Saber / halo énergétique) : bloom sur
  // toute la scène, désactivable (coût de perf) et réglable en intensité.
  // Les zones lumineuses des calques (contours énergétiques, texte blanc,
  // particules) sont amplifiées en halo diffus.
  const { EffectComposer } = await import('/vendor/three/jsm/postprocessing/EffectComposer.js');
  const { RenderPass } = await import('/vendor/three/jsm/postprocessing/RenderPass.js');
  const { UnrealBloomPass } = await import('/vendor/three/jsm/postprocessing/UnrealBloomPass.js');
  const { OutputPass } = await import('/vendor/three/jsm/postprocessing/OutputPass.js');

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // threshold élevé : seules les zones vraiment lumineuses (contour
  // énergétique, particules, spectre) déclenchent le halo. Avec un seuil
  // bas, la scène entière (texte blanc, bordures, fond clair) contribue
  // et le bloom sature toute l'image en blanc dès une intensité modeste.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.1, 0.55, 0.82);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  EditorState.three = {
    THREE,
    renderer,
    scene,
    camera,
    composer,
    bloomPass,
    width,
    height,
    distance,
    bgMesh,
    bgTexture: null,
    bgSourceEl: null,
    raycaster: new THREE.Raycaster(),
    particleSystems: {},
    layers: {
      photo: null, // { mesh, canvas, ctx, texture, id }
      caption: null,
      introLogo: null,
      introImg: null,
      introText: null,
      // Les blocs de texte libres utilisent des clés dynamiques `text-<id>`.
    },
  };
}

// Coordonnées "pixel" (origine haut-gauche, Y bas) -> coordonnées monde
// three.js (origine centre, Y haut).
function pxToWorld(px, py, z) {
  const { width, height } = EditorState.three;
  return { x: px - width / 2, y: -(py - height / 2), z: z || 0 };
}
function worldToPx(x, y) {
  const { width, height } = EditorState.three;
  return { x: x + width / 2, y: height / 2 - y };
}

function getOrCreateCanvasLayer(name) {
  const layers = EditorState.three.layers;
  if (layers[name]) return layers[name];
  const { THREE, scene } = EditorState.three;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  // Les blocs de texte doivent toujours rester au tout premier plan, même
  // quand une photo inclinée en 3D (rotation X/Y/Z) dépasse en profondeur
  // devant eux : on désactive le test de profondeur et on force un
  // renderOrder élevé plutôt que de compter sur leur seule position z, qui
  // ne suffit plus à garantir l'ordre d'affichage dès qu'un autre calque
  // est tourné dans l'espace.
  const estTexte = name.startsWith('text-');
  if (estTexte) {
    material.depthTest = false;
    material.depthWrite = false;
  }
  const mesh = new THREE.Mesh(geometry, material);
  if (estTexte) mesh.renderOrder = 1000;
  mesh.visible = false;
  scene.add(mesh);
  const layer = { mesh, canvas, ctx, texture };
  layers[name] = layer;
  return layer;
}

function hideLayer(name) {
  const layer = EditorState.three.layers[name];
  if (layer) layer.mesh.visible = false;
}

// Redimensionne le canvas hors-écran d'un calque et repositionne son
// plan 3D en conséquence (le plan fait toujours exactement la taille du
// contenu dessiné, en unités pixel).
function sizeLayerCanvas(layer, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (layer.canvas.width !== w || layer.canvas.height !== h) {
    layer.canvas.width = w;
    layer.canvas.height = h;
    // Recrée la texture GPU plutôt que de muter les dimensions d'une
    // texture déjà uploadée : en cas de redimensionnements rapprochés du
    // canvas source (ex. frappe clavier rapide dans une légende), le
    // rendu WebGL restait figé sur une frame précédente (texte tronqué à
    // la première lettre) alors que le canvas source et l'état étaient
    // déjà corrects — un objet CanvasTexture neuf par changement de
    // taille évite ce désync.
    const { THREE } = EditorState.three;
    layer.texture.dispose();
    layer.texture = new THREE.CanvasTexture(layer.canvas);
    layer.texture.colorSpace = THREE.SRGBColorSpace;
    layer.mesh.material.map = layer.texture;
    layer.mesh.material.needsUpdate = true;
  }
  layer.mesh.scale.set(w, h, 1);
}

function placerLayer(layer, centerPx, centerPy, z, rotX, rotY, rotZ) {
  const world = pxToWorld(centerPx, centerPy, z);
  layer.mesh.position.set(world.x, world.y, world.z);
  layer.mesh.rotation.set(rotX || 0, rotY || 0, rotZ || 0);
  layer.mesh.visible = true;
  layer.texture.needsUpdate = true;
}

/* -------------------------------------------------------------------- */
/* Dessin (composition 2D hors-écran, texturée sur les plans 3D)         */
/* -------------------------------------------------------------------- */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  text.split('\n').forEach((paragraphe) => {
    const mots = paragraphe.split(/\s+/).filter(Boolean);
    if (mots.length === 0) {
      lines.push('');
      return;
    }
    let courante = '';
    mots.forEach((mot) => {
      const essai = courante ? `${courante} ${mot}` : mot;
      if (ctx.measureText(essai).width > maxWidth && courante) {
        lines.push(courante);
        courante = mot;
      } else {
        courante = essai;
      }
    });
    if (courante) lines.push(courante);
  });
  return lines;
}

function hexVersRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#000000');
  if (!m) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Dégradé linéaire couvrant tout le panneau de texte (panelW x panelH),
// orienté selon `angleDeg` (0 = gauche→droite, 90 = haut→bas).
function creerDegradeTexte(ctx, panelW, panelH, couleur1, couleur2, angleDeg) {
  const angle = (angleDeg * Math.PI) / 180;
  const cx = panelW / 2;
  const cy = panelH / 2;
  const longueur = Math.max(panelW, panelH);
  const dx = Math.cos(angle) * (longueur / 2);
  const dy = Math.sin(angle) * (longueur / 2);
  const degrade = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  degrade.addColorStop(0, couleur1);
  degrade.addColorStop(1, couleur2);
  return degrade;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Path de masque selon la forme choisie pour une photo. 'rect' = coins
// arrondis (comportement historique), 'circle' = ellipse inscrite,
// 'hexagon'/'pentagon' = polygone régulier inscrit, 'star' = étoile à 5
// branches, 'heart' = coeur (courbes de Bézier).
function maskShapePath(ctx, shape, x, y, w, h, r) {
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === 'hexagon' || shape === 'pentagon') {
    const cotes = shape === 'hexagon' ? 6 : 5;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    for (let i = 0; i < cotes; i++) {
      const a = ((Math.PI * 2) / cotes) * i - Math.PI / 2;
      const px = cx + (w / 2) * Math.cos(a);
      const py = cy + (h / 2) * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return;
  }
  if (shape === 'star') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const outerX = w / 2;
    const outerY = h / 2;
    const innerX = outerX * 0.42;
    const innerY = outerY * 0.42;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rx = i % 2 === 0 ? outerX : innerX;
      const ry = i % 2 === 0 ? outerY : innerY;
      const px = cx + rx * Math.cos(a);
      const py = cy + ry * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return;
  }
  if (shape === 'heart') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.85);
    ctx.bezierCurveTo(cx - s * 1.35, cy - s * 0.1, cx - s * 0.5, cy - s * 1.15, cx, cy - s * 0.35);
    ctx.bezierCurveTo(cx + s * 0.5, cy - s * 1.15, cx + s * 1.35, cy - s * 0.1, cx, cy + s * 0.85);
    ctx.closePath();
    return;
  }
  if (shape === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    return;
  }
  if (shape === 'arrow') {
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x, cy - h * 0.18);
    ctx.lineTo(x + w * 0.6, cy - h * 0.18);
    ctx.lineTo(x + w * 0.6, y);
    ctx.lineTo(x + w, cy);
    ctx.lineTo(x + w * 0.6, y + h);
    ctx.lineTo(x + w * 0.6, cy + h * 0.18);
    ctx.lineTo(x, cy + h * 0.18);
    ctx.closePath();
    return;
  }
  if (shape === 'line') {
    ctx.beginPath();
    ctx.rect(x, y + h / 2 - h * 0.06, w, h * 0.12);
    ctx.closePath();
    return;
  }
  roundRectPath(ctx, x, y, w, h, r);
}

// Fond : texture vidéo/image "cover" appliquée directement sur le plan
// de fond (pas besoin de composition hors-écran, three.js gère la
// texture vidéo nativement).
// Dimensions naturelles d'un média, qu'il s'agisse d'une <img> ou d'une
// <video> (calques "photo" acceptant maintenant les deux).
function mediaW(media) {
  return media.videoWidth || media.naturalWidth || media.width || 0;
}
function mediaH(media) {
  return media.videoHeight || media.naturalHeight || media.height || 0;
}

// Dessine un média (vidéo/image) en mode "cover" dans un canvas 2D.
function drawCoverOnCanvas(ctx, media, dw, dh) {
  const mw = media.videoWidth || media.naturalWidth || media.width || 0;
  const mh = media.videoHeight || media.naturalHeight || media.height || 0;
  if (!mw || !mh) return;
  const scale = Math.max(dw / mw, dh / mh);
  const w = mw * scale;
  const h = mh * scale;
  ctx.drawImage(media, (dw - w) / 2, (dh - h) / 2, w, h);
}

// Résout la source de fond effective pour le segment actif : l'override
// de la photo en cours s'il en a un, sinon le fond global.
function resoudreFondEffectif(segmentActif) {
  if (segmentActif && segmentActif.type === 'photo') {
    const p = segmentActif.data;
    if (p.bgOverrideType && p.bgOverrideType !== 'none') {
      return {
        type: p.bgOverrideType,
        videoEl: p.bgOverrideVideoEl,
        imageEl: p.bgOverrideImageEl,
        color: p.bgOverrideColor,
      };
    }
  }
  return {
    type: EditorState.bgType,
    videoEl: EditorState.bgVideoEl,
    imageEl: EditorState.bgImageEl,
    color: EditorState.bgColor,
  };
}

function mettreAJourFond(segmentActif) {
  const ts = EditorState.three;
  const { THREE } = ts;
  const fond = resoudreFondEffectif(segmentActif);
  const brightness = Number(EditorState.bgAdjust.brightness) || 100;
  const blur = Number(EditorState.bgAdjust.blur) || 0;
  const chromaKey = EditorState.bgChromaKey;
  const needsAdjustCanvas =
    (fond.type === 'video' || fond.type === 'image') && (brightness !== 100 || blur > 0 || chromaKey.active);

  if (fond.type === 'video' && fond.videoEl && fond.videoEl.readyState >= 2) {
    if (needsAdjustCanvas) {
      appliquerFondAjuste(ts, fond.videoEl, brightness, blur, chromaKey);
    } else {
      if (ts.bgSourceEl !== fond.videoEl || ts.bgSourceKind !== 'video') {
        ts.bgTexture = new THREE.VideoTexture(fond.videoEl);
        ts.bgTexture.colorSpace = THREE.SRGBColorSpace;
        ts.bgMesh.material.map = ts.bgTexture;
        ts.bgMesh.material.color.set(0xffffff);
        ts.bgMesh.material.transparent = false;
        ts.bgMesh.material.needsUpdate = true;
        ts.bgSourceEl = fond.videoEl;
        ts.bgSourceKind = 'video';
      }
      ajusterCoverUV(ts.bgTexture, fond.videoEl.videoWidth, fond.videoEl.videoHeight, ts.width, ts.height);
    }
  } else if (fond.type === 'image' && fond.imageEl) {
    if (needsAdjustCanvas) {
      appliquerFondAjuste(ts, fond.imageEl, brightness, blur, chromaKey);
    } else {
      if (ts.bgSourceEl !== fond.imageEl || ts.bgSourceKind !== 'image') {
        ts.bgTexture = new THREE.Texture(fond.imageEl);
        ts.bgTexture.colorSpace = THREE.SRGBColorSpace;
        ts.bgTexture.needsUpdate = true;
        ts.bgMesh.material.map = ts.bgTexture;
        ts.bgMesh.material.color.set(0xffffff);
        ts.bgMesh.material.transparent = false;
        ts.bgMesh.material.needsUpdate = true;
        ts.bgSourceEl = fond.imageEl;
        ts.bgSourceKind = 'image';
      }
      ajusterCoverUV(ts.bgTexture, fond.imageEl.naturalWidth, fond.imageEl.naturalHeight, ts.width, ts.height);
    }
  } else if (fond.type === 'gradient') {
    const key = `gradient:${EditorState.bgGradient.color1}:${EditorState.bgGradient.color2}:${EditorState.bgGradient.angle}`;
    if (ts.bgSourceEl !== key) {
      ts.bgTexture = creerTextureDegrade(THREE, EditorState.bgGradient);
      ts.bgMesh.material.map = ts.bgTexture;
      ts.bgMesh.material.color.set(0xffffff);
      ts.bgMesh.material.transparent = false;
      ts.bgMesh.material.needsUpdate = true;
      ts.bgSourceEl = key;
      ts.bgSourceKind = 'gradient';
    }
  } else if (fond.type === 'color') {
    ts.bgMesh.material.map = null;
    ts.bgMesh.material.color.set(fond.color || '#12151c');
    ts.bgMesh.material.transparent = false;
    ts.bgMesh.material.needsUpdate = true;
    ts.bgSourceEl = null;
    ts.bgSourceKind = 'color';
  } else {
    ts.bgMesh.material.map = null;
    ts.bgMesh.material.color.set(0x12151c);
    ts.bgMesh.material.transparent = false;
    ts.bgMesh.material.needsUpdate = true;
    ts.bgSourceEl = null;
    ts.bgSourceKind = null;
  }

  mettreAJourOverlay(ts, THREE);
}

// Compose le fond (vidéo/image) sur un canvas 2D hors-écran avec un
// filtre CSS (luminosité/flou), redessiné chaque frame — nécessaire pour
// une vidéo, acceptable en coût vu la résolution réduite du canvas.
function appliquerFondAjuste(ts, media, brightness, blur, chromaKey) {
  if (!ts.bgAdjustCanvas) {
    ts.bgAdjustCanvas = document.createElement('canvas');
    ts.bgAdjustCanvas.width = 960;
    ts.bgAdjustCanvas.height = 540;
    ts.bgAdjustCtx = ts.bgAdjustCanvas.getContext('2d');
  }
  const ctx = ts.bgAdjustCtx;
  ctx.filter = `brightness(${brightness}%) blur(${blur}px)`;
  ctx.clearRect(0, 0, ts.bgAdjustCanvas.width, ts.bgAdjustCanvas.height);
  drawCoverOnCanvas(ctx, media, ts.bgAdjustCanvas.width, ts.bgAdjustCanvas.height);
  ctx.filter = 'none';
  if (chromaKey && chromaKey.active) {
    appliquerChromaKey(
      ctx,
      0,
      0,
      ts.bgAdjustCanvas.width,
      ts.bgAdjustCanvas.height,
      chromaKey.color || '#00ff00',
      chromaKey.tolerance ?? 0.35
    );
  }

  if (ts.bgSourceKind !== 'adjust-canvas') {
    ts.bgTexture = new ts.THREE.CanvasTexture(ts.bgAdjustCanvas);
    ts.bgTexture.colorSpace = ts.THREE.SRGBColorSpace;
    ts.bgMesh.material.map = ts.bgTexture;
    ts.bgMesh.material.color.set(0xffffff);
    ts.bgSourceEl = media;
    ts.bgSourceKind = 'adjust-canvas';
  }
  ts.bgMesh.material.transparent = !!(chromaKey && chromaKey.active);
  ts.bgMesh.material.needsUpdate = true;
  ts.bgTexture.needsUpdate = true;
}

// Clé chromatique (fond vert/bleu) : rend transparents les pixels proches
// de la couleur cible dans la zone [x,y,w,h] du canvas, avec une bande de
// transition douce sur les 30% de tolérance les plus élevés pour adoucir
// le contour plutôt qu'un détourage à l'emporte-pièce.
function appliquerChromaKey(ctx, x, y, w, h, color, tolerance) {
  if (w <= 0 || h <= 0) return;
  const ix = Math.max(0, Math.round(x));
  const iy = Math.max(0, Math.round(y));
  const iw = Math.max(1, Math.round(w));
  const ih = Math.max(1, Math.round(h));
  let imgData;
  try {
    imgData = ctx.getImageData(ix, iy, iw, ih);
  } catch (_) {
    return; // média cross-origin non lisible
  }
  const data = imgData.data;
  const kr = parseInt(color.slice(1, 3), 16);
  const kg = parseInt(color.slice(3, 5), 16);
  const kb = parseInt(color.slice(5, 7), 16);
  const maxDist = Math.sqrt(3 * 255 * 255);
  const tol = Math.max(0.02, Number(tolerance) || 0.35) * maxDist;
  const edge = tol * 0.3;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < tol - edge) {
      data[i + 3] = 0;
    } else if (dist < tol) {
      data[i + 3] = Math.round(data[i + 3] * ((dist - (tol - edge)) / edge));
    }
  }
  ctx.putImageData(imgData, ix, iy);
}

function creerTextureDegrade(THREE, grad) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  const rad = (grad.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const g = ctx.createLinearGradient(
    256 - dx * 256, 256 - dy * 256,
    256 + dx * 256, 256 + dy * 256
  );
  g.addColorStop(0, grad.color1);
  g.addColorStop(1, grad.color2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Overlay global (grain ou vignette) sur un plan juste devant le fond.
let overlayTextureCache = {};
function mettreAJourOverlay(ts, THREE) {
  if (!ts.overlayMesh) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 });
    ts.overlayMesh = new THREE.Mesh(geo, mat);
    ts.overlayMesh.position.z = -450;
    ts.overlayMesh.scale.set(ts.width * 1.3, ts.height * 1.3, 1);
    ts.scene.add(ts.overlayMesh);
  }
  const type = EditorState.overlay.type;
  if (type === 'none') {
    ts.overlayMesh.visible = false;
    return;
  }
  ts.overlayMesh.visible = true;
  const strength = Number(EditorState.overlay.strength) || 0.5;
  const cacheKey = `${type}:${Math.round(strength * 20)}`;
  if (!overlayTextureCache[cacheKey]) {
    overlayTextureCache[cacheKey] = creerTextureOverlay(THREE, type, strength);
  }
  ts.overlayMesh.material.map = overlayTextureCache[cacheKey];
  ts.overlayMesh.material.needsUpdate = true;
}

function creerTextureOverlay(THREE, type, strength) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  if (type === 'vignette') {
    const g = ctx.createRadialGradient(256, 256, 100, 256, 256, 380);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.35 + strength * 0.5})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
  } else if (type === 'grain') {
    const imgData = ctx.createImageData(512, 512);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255;
      imgData.data[i] = v;
      imgData.data[i + 1] = v;
      imgData.data[i + 2] = v;
      imgData.data[i + 3] = strength * 90;
    }
    ctx.putImageData(imgData, 0, 0);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Ajuste le repeat/offset UV d'une texture pour un rendu "cover" (comme
// background-size:cover) sur un plan de proportions (dw x dh).
function ajusterCoverUV(texture, mw, mh, dw, dh) {
  if (!mw || !mh) return;
  const mediaAspect = mw / mh;
  const boxAspect = dw / dh;
  let repeatX = 1;
  let repeatY = 1;
  if (mediaAspect > boxAspect) {
    repeatX = boxAspect / mediaAspect;
  } else {
    repeatY = mediaAspect / boxAspect;
  }
  texture.wrapS = texture.wrapT = EditorState.three.THREE.ClampToEdgeWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.offset.set((1 - repeatX) / 2, (1 - repeatY) / 2);
}

// Point à la fraction t (0..1) du périmètre d'un rectangle à coins
// arrondis, en parcourant les 4 côtés + 4 arcs dans le sens horaire à
// partir du milieu du bord supérieur. Sert à faire "courir" une tête
// lumineuse le long du contour pour l'effet Saber.
function pointOnRoundRect(x, y, w, h, r, t) {
  const straightTop = w / 2 - r;
  const arc = (Math.PI / 2) * r;
  const straightSide = h - 2 * r;
  const straightBottom = w - 2 * r;
  const total = 2 * straightTop + straightBottom + 2 * straightSide + 4 * arc;
  let d = ((t % 1) + 1) % 1 * total;

  const seg = (len) => {
    if (d <= len) return true;
    d -= len;
    return false;
  };

  if (seg(straightTop)) return { px: x + w / 2 + d, py: y };
  if (seg(arc)) {
    const a = -Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return { px: x + w - r + r * Math.cos(a), py: y + r + r * Math.sin(a) };
  }
  if (seg(straightSide)) return { px: x + w, py: y + r + d };
  if (seg(arc)) {
    const a = (d / arc) * (Math.PI / 2);
    return { px: x + w - r + r * Math.cos(a), py: y + h - r + r * Math.sin(a) };
  }
  if (seg(straightBottom)) return { px: x + w - r - d, py: y + h };
  if (seg(arc)) {
    const a = Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return { px: x + r + r * Math.cos(a), py: y + h - r + r * Math.sin(a) };
  }
  if (seg(straightSide)) return { px: x, py: y + h - r - d };
  if (seg(arc)) {
    const a = Math.PI + (d / arc) * (Math.PI / 2);
    return { px: x + r + r * Math.cos(a), py: y + r + r * Math.sin(a) };
  }
  // Deuxième moitié du bord supérieur (du coin haut-gauche vers le milieu
  // du haut) : referme la boucle. Manquait ici, ce qui figeait tous les t
  // de cette plage sur un point fixe au lieu de parcourir le segment —
  // avec le total comptant 2x straightTop mais un seul consommé, une
  // fraction significative du contour n'était jamais réellement visitée.
  return { px: x + r + d, py: y };
}

// Normale sortante au point t du contour (dérivée numérique de la
// tangente). pointOnRoundRect parcourt le contour dans le sens horaire
// (Y vers le bas), donc la normale sortante est la tangente tournée de
// -90° : (dy, -dx).
function normaleSurRoundRect(x, y, w, h, r, t) {
  const dt = 0.001;
  const p0 = pointOnRoundRect(x, y, w, h, r, t);
  const p1 = pointOnRoundRect(x, y, w, h, r, (t + dt) % 1);
  const dx = p1.px - p0.px;
  const dy = p1.py - p0.py;
  const len = Math.hypot(dx, dy) || 1;
  return { nx: dy / len, ny: -dx / len };
}

// Spectre audio réactif : barres perpendiculaires au contour arrondi de
// la carte, hauteur proportionnelle à l'amplitude de fréquence lue en
// temps réel sur la musique de fond (Web Audio AnalyserNode). count =
// nombre de barres réparties tout autour du contour (0..1 complet),
// sizeMul = multiplicateur de leur longueur max.
function dessinerSpectreAudio(ctx, x, y, w, h, r, color, maxBarLen, count, sizeMul) {
  const analyserState = EditorState.audioAnalyser;
  if (!analyserState) return;
  analyserState.analyser.getByteFrequencyData(analyserState.dataArray);
  const data = analyserState.dataArray;
  const nBars = Math.max(4, Math.round(count) || 48);
  ctx.save();
  for (let i = 0; i < nBars; i++) {
    const t = i / nBars;
    const { px, py } = pointOnRoundRect(x, y, w, h, r, t);
    const { nx, ny } = normaleSurRoundRect(x, y, w, h, r, t);
    const amp = data[i % data.length] / 255;
    const len = (4 + amp * maxBarLen) * (sizeMul || 1);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55 + amp * 0.45;
    ctx.lineWidth = Math.max(2, w * 0.006);
    ctx.shadowColor = color;
    ctx.shadowBlur = 4 + amp * 10;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + nx * len, py + ny * len);
    ctx.stroke();
  }
  ctx.restore();
}

// Effet "Saber" : traînée lumineuse qui court le long du contour arrondi
// de la carte, tête vive + queue qui s'estompe, glow amplifié ensuite par
// le bloom global si activé. count = longueur de la traînée en nombre de
// points (un espacement fixe entre points, donc plus de points = la
// traînée couvre une plus grande fraction du tour, jusqu'au tour complet)
// ; sizeMul = multiplicateur du rayon des points.
function dessinerContourEnergetique(ctx, x, y, w, h, r, color, tGlobal, count, sizeMul) {
  const nQueue = Math.max(4, Math.round(count) || 26);
  const espacement = 0.9 / nQueue; // couvre jusqu'à 90% du tour au maximum du slider
  const vitesse = 0.18; // tours par seconde
  ctx.save();
  for (let i = 0; i < nQueue; i++) {
    const tTete = (tGlobal * vitesse - i * espacement) % 1;
    const { px, py } = pointOnRoundRect(x, y, w, h, r, tTete);
    const alpha = (1 - i / nQueue) * 0.9;
    const radius = Math.max(1.5, Math.min(w, h) * 0.018) * (1 - (i / nQueue) * 0.5) * (sizeMul || 1);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 6;
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Construit la chaîne CSS filter (Canvas 2D ctx.filter) pour une photo à
// partir de ses réglages. Valeurs neutres (100/0) omises pour rester
// performant quand aucun filtre n'est appliqué.
function cssFiltreImage(p) {
  const parts = [];
  const brightness = p.imgBrightness ?? 100;
  const contrast = p.imgContrast ?? 100;
  const saturation = p.imgSaturation ?? 100;
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
  if (saturation !== 100) parts.push(`saturate(${saturation}%)`);
  if (p.imgGrayscale) parts.push('grayscale(100%)');
  if (p.imgSepia) parts.push('sepia(75%)');
  if (p.imgBlur) parts.push(`blur(${Number(p.imgBlur)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// Photo "carte flottante" : coins arrondis, ombre douce, contour clair —
// composés sur un canvas hors-écran (comme avant) puis texturés sur un
// plan 3D. Flottement + tilt automatiques, plus rotation manuelle sur
// les 3 axes (p.rotX/rotY/rotZ, en degrés, ajoutés à l'auto-tilt).
// Teinte du contour dérivée de la profondeur z (au-delà de la simple
// perspective 3D déjà appliquée par le placement du calque) : un calque
// proche de la caméra (z élevé) tire vers le cyan, un calque en retrait
// (z négatif) vers le jaune-vert, z=0 reste au rose de base — une IA
// distingue ainsi l'empilement des calques d'un coup d'œil, sans avoir à
// comparer des nombres.
function couleurContourSelonZ(z, alpha) {
  const hue = 330 - Math.max(-60, Math.min(60, z || 0)) * 2;
  const hueNormalise = ((hue % 360) + 360) % 360;
  return alpha != null ? `hsla(${hueNormalise}, 85%, 60%, ${alpha})` : `hsl(${hueNormalise}, 85%, 60%)`;
}

// Mode IA "contours" : dessine un simple cadre pointillé + label (id,
// position x/y/z, dimensions) à la place du rendu visuel complet — une IA
// qui pilote l'éditeur peut ainsi lire la disposition (position, taille,
// profondeur, chevauchements) d'un coup d'œil sans avoir à interpréter une
// image détaillée. posInfo = {x, y, z} en unités monde (fractions 0..1
// pour x/y, pixels pour z) pour annoter le label et teinter le contour.
function dessinerContourAsset(ctx, x, y, w, h, radius, shape, label, posInfo) {
  const z = (posInfo && posInfo.z) || 0;
  const couleur = couleurContourSelonZ(z);
  ctx.save();
  ctx.fillStyle = couleurContourSelonZ(z, 0.12);
  maskShapePath(ctx, shape || 'rect', x, y, w, h, radius || 0);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = couleur;
  ctx.setLineDash([10, 6]);
  maskShapePath(ctx, shape || 'rect', x, y, w, h, radius || 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 20px monospace';
  ctx.fillStyle = couleur;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + 8, y + 8);
  const position = posInfo
    ? `x:${posInfo.x.toFixed(2)} y:${posInfo.y.toFixed(2)} z:${Math.round(z)}`
    : '';
  ctx.fillText(position, x + 8, y + 32);
  ctx.fillText(`${Math.round(w)}×${Math.round(h)}`, x + 8, y + 56);
  ctx.restore();
}

// Rend les médias superposés (composite simultané) du calque photo
// actuellement actif — chacun réutilise mettreAJourPhoto() sur son propre
// calque three.js ('photo-extra-<id>'), donc profite gratuitement de tous
// les mêmes réglages (forme, filtres, ombre, chromakey...). Masque les
// calques superposés d'un segment qui n'est plus actif.
function mettreAJourMediasSuperposes(segmentActif, tGlobal) {
  const actifs = segmentActif && segmentActif.type === 'photo' ? segmentActif.data.sousMedias || [] : [];
  const idsActifs = new Set();
  actifs.forEach((sm) => {
    const layerName = `photo-extra-${sm.id}`;
    const particlesKey = `photo-extra-particles-${sm.id}`;
    idsActifs.add(layerName);
    if (sm.visible === false || !sm.img) {
      hideLayer(layerName);
      mettreAJourParticules(null, null, tGlobal, particlesKey);
      return;
    }
    // Le contour énergétique (saber) est dessiné à même le canvas du média
    // par mettreAJourPhoto() ; les particules sont un système three.js à
    // part (points 3D, pas de texture 2D), à mettre à jour séparément avec
    // une clé dédiée — sinon "Particules" reste sans effet sur un média
    // superposé alors que la case à cocher existe bien dans le panneau.
    const box = mettreAJourPhoto(sm, tGlobal, layerName);
    mettreAJourParticules(sm, box, tGlobal, particlesKey);
  });
  Object.keys(EditorState.three.layers).forEach((name) => {
    if (name.startsWith('photo-extra-') && !idsActifs.has(name)) hideLayer(name);
  });
  Object.keys(EditorState.three.particleSystems).forEach((key) => {
    if (key.startsWith('photo-extra-particles-') && !actifs.some((sm) => `photo-extra-particles-${sm.id}` === key)) {
      EditorState.three.particleSystems[key].points.visible = false;
    }
  });
}

function mettreAJourPhoto(p, tGlobal, layerName) {
  layerName = layerName || 'photo';
  if (!p.img) {
    hideLayer(layerName);
    if (layerName === 'photo') hideLayer('caption');
    return null;
  }
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer(layerName);

  const w = Math.round(width * p.scale);
  const h = Math.round(w * (mediaH(p.img) / mediaW(p.img) || 1));
  const margeBase = Math.ceil(Math.min(w, h) * 0.14) + 16;
  const spectrumSizeMul = Number(p.spectrumSize) || 1;
  const margeSpectre = p.spectrumActive ? Math.ceil(Math.min(w, h) * 0.32 * spectrumSizeMul) : 0;
  const marge = margeBase + margeSpectre;
  sizeLayerCanvas(layer, w + marge * 2, h + marge * 2);

  const ctx = layer.ctx;
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  const ox = marge;
  const oy = marge;

  const shape = p.maskShape || 'rect';
  const radius = Math.min(w, h) * 0.06;

  if (EditorState.modeContours) {
    dessinerContourAsset(ctx, ox, oy, w, h, radius, shape, `#${p.id} photo`, { x: p.x, y: p.y, z: p.z || 0 });
  } else {
  // Lueur externe (glow) : même principe que l'ombre ci-dessous — remplie
  // avec la couleur choisie, floutée, puis évidée à l'intérieur pour ne
  // garder que le halo qui déborde du masque.
  if (p.glowActive) {
    ctx.save();
    const glowColor = p.glowColor || '#00e5ff';
    const glowStrength = Number(p.glowStrength) || 0.5;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = h * 0.22 * glowStrength;
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.fillStyle = glowColor;
    ctx.fill();
    ctx.shadowBlur = h * 0.1 * glowStrength;
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-out';
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.fill();
    ctx.restore();
  }

  // Ombre portée qui déborde du masque, sans remplir l'intérieur en noir
  // opaque : sinon les PNG à fond transparent laissaient voir ce noir à
  // travers leurs zones transparentes au lieu du fond de la scène. On
  // peint le fill + son flou débordant, puis on efface la partie
  // intérieure (destination-out) — il ne reste que le halo qui dépasse.
  if (p.shadowActive !== false) {
    ctx.save();
    ctx.shadowColor = hexVersRgba(p.shadowColor || '#000000', p.shadowOpacity ?? 0.55);
    ctx.shadowBlur = h * (p.shadowBlur ?? 0.14);
    ctx.shadowOffsetY = h * (p.shadowOffsetY ?? 0.08);
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-out';
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.fill();
    ctx.restore();
  }

  // Crop : fraction de l'image source utilisée (cropX/Y = coin haut-gauche,
  // cropW/H = largeur/hauteur, en fractions 0..1 de l'image originale).
  const cropX = Math.min(0.9, Math.max(0, Number(p.cropX) || 0));
  const cropY = Math.min(0.9, Math.max(0, Number(p.cropY) || 0));
  const cropW = Math.min(1 - cropX, Math.max(0.1, p.cropW != null ? Number(p.cropW) : 1));
  const cropH = Math.min(1 - cropY, Math.max(0.1, p.cropH != null ? Number(p.cropH) : 1));
  const iw = mediaW(p.img);
  const ih = mediaH(p.img);

  ctx.save();
  maskShapePath(ctx, shape, ox, oy, w, h, radius);
  ctx.clip();
  ctx.filter = cssFiltreImage(p);
  ctx.drawImage(p.img, cropX * iw, cropY * ih, cropW * iw, cropH * ih, ox, oy, w, h);
  ctx.filter = 'none';
  if (p.chromaKeyActive) {
    appliquerChromaKey(ctx, ox, oy, w, h, p.chromaKeyColor || '#00ff00', p.chromaKeyTolerance ?? 0.35);
  }
  if (p.vignette) {
    const grad = ctx.createRadialGradient(
      ox + w / 2, oy + h / 2, Math.min(w, h) * 0.25,
      ox + w / 2, oy + h / 2, Math.max(w, h) * 0.72
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${0.15 + (Number(p.vignetteStrength) || 0.5) * 0.55})`);
    ctx.fillStyle = grad;
    ctx.fillRect(ox, oy, w, h);
  }
  ctx.restore();

  if (p.borderActive !== false) {
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = Math.max(1, w * ((Number(p.borderWidth) || 3) / 1000));
    ctx.strokeStyle = p.borderColor || '#ffffff';
    maskShapePath(ctx, shape, ox, oy, w, h, radius);
    ctx.stroke();
    ctx.restore();
  }

  // Le contour Saber/spectre suit toujours un tracé rectangulaire arrondi
  // (pointOnRoundRect), même si le masque de la photo est un cercle ou un
  // hexagone : généraliser le tracé à ces formes est laissé pour plus tard.
  if (p.saberActive) {
    dessinerContourEnergetique(
      ctx, ox, oy, w, h, radius, p.saberColor || '#00e5ff', tGlobal,
      p.saberCount, p.saberSize
    );
  }
  if (p.spectrumActive) {
    dessinerSpectreAudio(
      ctx, ox, oy, w, h, radius, p.spectrumColor || '#ff2d95', margeSpectre * 0.85,
      p.spectrumCount, spectrumSizeMul
    );
  }
  }

  const phase = (p.id % 7) * 0.9;
  const floatActif = p.floatActive !== false;
  const floatY = floatActif ? Math.sin(tGlobal * 1.1 + phase) * h * 0.035 : 0;
  const autoTilt = floatActif ? Math.sin(tGlobal * 0.66 + phase) * 0.045 : 0;

  const baseX = p.x * width;
  const baseY = p.y * height + floatY;
  const rotX = ((p.rotX || 0) * Math.PI) / 180;
  const rotY = ((p.rotY || 0) * Math.PI) / 180;
  const rotZ = ((p.rotZ || 0) * Math.PI) / 180 + autoTilt;
  placerLayer(layer, baseX, baseY, p.z || 0, rotX, rotY, rotZ);

  return { x: baseX - w / 2, y: baseY - h / 2, w, h, cx: baseX, cy: baseY, z: p.z || 0 };
}

// Légende détachée de l'image : position libre (glissable), panneau
// "verre dépoli" derrière le texte (flou du fond de la texture composée,
// simplifié en voile semi-transparent — le vrai flou de scène 3D
// nécessiterait un post-processing dédié, cf. effets Saber à venir).
function mettreAJourLegende(p) {
  if (!p.texte) {
    hideLayer('caption');
    return null;
  }
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer('caption');
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Roboto', sans-serif";
  const size = Math.max(14, Math.round(width * 0.022));

  const measureCtx = layer.ctx;
  measureCtx.font = `600 ${size}px ${famille}`;
  const maxWidth = width * 0.7;
  const lignes = wrapText(measureCtx, p.texte, maxWidth);
  const lineHeight = size * 1.25;
  let boxW = 0;
  lignes.forEach((ligne) => {
    boxW = Math.max(boxW, measureCtx.measureText(ligne).width);
  });
  const boxH = lineHeight * lignes.length;
  const padX = 18;
  const padY = 12;
  const panelW = boxW + padX * 2;
  const panelH = boxH + padY * 2;
  const radius = 14;

  sizeLayerCanvas(layer, panelW, panelH);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  roundRectPath(ctx, 0, 0, panelW, panelH, radius);
  ctx.fillStyle = 'rgba(8,10,14,0.5)';
  ctx.fill();

  ctx.font = `600 ${size}px ${famille}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;
  lignes.forEach((ligne, i) => ctx.fillText(ligne, panelW / 2, padY + i * lineHeight));
  ctx.shadowBlur = 0;

  const cx = (p.texteX ?? p.x) * width;
  const topY = (p.texteY ?? p.y) * height;
  const centerY = topY - padY + panelH / 2;
  placerLayer(layer, cx, centerY, (p.z || 0) + 2, 0, 0, 0);

  return { x: cx - panelW / 2, y: topY - padY, w: panelW, h: panelH, cx, cy: centerY, z: (p.z || 0) + 2 };
}

function mettreAJourIntroOutro(seg) {
  const { width, height } = EditorState.three;
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Space Grotesk', sans-serif";

  if (seg.logoImg) {
    const layer = getOrCreateCanvasLayer('introLogo');
    const lw = Math.round(width * 0.16);
    const lh = Math.round(lw * (seg.logoImg.naturalHeight / seg.logoImg.naturalWidth || 1));
    sizeLayerCanvas(layer, lw, lh);
    layer.ctx.clearRect(0, 0, lw, lh);
    layer.ctx.drawImage(seg.logoImg, 0, 0, lw, lh);
    placerLayer(layer, width / 2, height * 0.1 + lh / 2, 0, 0, 0, 0);
  } else {
    hideLayer('introLogo');
  }

  if (seg.img) {
    const layer = getOrCreateCanvasLayer('introImg');
    const iw = Math.round(width * 0.46);
    const ih = Math.round(iw * (seg.img.naturalHeight / seg.img.naturalWidth || 1));
    sizeLayerCanvas(layer, iw, ih);
    layer.ctx.clearRect(0, 0, iw, ih);
    layer.ctx.drawImage(seg.img, 0, 0, iw, ih);
    placerLayer(layer, width / 2, height / 2, -1, 0, 0, 0);
  } else {
    hideLayer('introImg');
  }

  if (seg.texte) {
    const layer = getOrCreateCanvasLayer('introText');
    const size = Math.max(18, Math.round(width * 0.048));
    const measureCtx = layer.ctx;
    measureCtx.font = `700 ${size}px ${famille}`;
    const lignes = wrapText(measureCtx, seg.texte, width * 0.8);
    const lineHeight = size * 1.25;
    const totalHeight = lineHeight * lignes.length;
    let boxW = 0;
    lignes.forEach((ligne) => {
      boxW = Math.max(boxW, measureCtx.measureText(ligne).width);
    });
    const padX = 26;
    const padY = 16;
    const panelW = boxW + padX * 2;
    const panelH = totalHeight + padY * 2;

    sizeLayerCanvas(layer, panelW, panelH);
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, panelW, panelH);
    roundRectPath(ctx, 0, 0, panelW, panelH, 16);
    ctx.fillStyle = 'rgba(8,10,14,0.5)';
    ctx.fill();

    ctx.font = `700 ${size}px ${famille}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    lignes.forEach((ligne, i) => ctx.fillText(ligne, panelW / 2, padY + i * lineHeight));
    ctx.shadowBlur = 0;

    const y0 = height * 0.86 - totalHeight / 2;
    placerLayer(layer, width / 2, y0 - padY + panelH / 2, 1, 0, 0, 0);
  } else {
    hideLayer('introText');
  }
}

// Progression 0..1 d'une animation d'entrée/sortie pour un bloc actif
// entre [start, end] (secondes, sur la timeline globale) au temps `now`.
// null en start/end veut dire "pas de borne" (pas d'anim de ce côté).
function progressionAnimation(start, end, now, dureeAnim) {
  let inT = 1;
  let outT = 1;
  if (start != null) inT = Math.min(1, Math.max(0, (now - start) / dureeAnim));
  if (end != null) outT = Math.min(1, Math.max(0, (end - now) / dureeAnim));
  return Math.min(inT, outT);
}

// Courbes d'accélération appliquées à la progression linéaire (0..1) d'une
// animation d'entrée/sortie de texte. 'bounce'/'elastic' donnent un effet de
// rebond, 'easeInOut'/'easeOut' un ralenti plus naturel qu'une vitesse
// constante.
function appliquerEasing(t, easing) {
  switch (easing) {
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOut':
      return 1 - Math.pow(1 - t, 3);
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      let x = t;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
      if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
      return n1 * (x -= 2.625 / d1) * x + 0.984375;
    }
    case 'elastic': {
      if (t === 0 || t === 1) return t;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
    default:
      return t; // linear
  }
}

function blocTexteActif(b, now) {
  if (b.visible === false) return false;
  if (b.startTime != null && now < b.startTime) return false;
  if (b.endTime != null && now > b.endTime) return false;
  return true;
}

const SHAPES_DISPONIBLES = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Cercle' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'star', label: 'Étoile' },
  { value: 'heart', label: 'Cœur' },
  { value: 'hexagon', label: 'Hexagone' },
  { value: 'pentagon', label: 'Pentagone' },
  { value: 'arrow', label: 'Flèche' },
  { value: 'line', label: 'Ligne' },
  { value: 'sticker', label: 'Sticker (emoji)' },
];
const STICKERS_DISPONIBLES = ['⭐', '❤️', '🔥', '✨', '👍', '🎉', '💯', '⚡', '👀', '🚀', '✅', '❌'];

function formeActive(f, now) {
  if (f.visible === false) return false;
  if (f.startTime != null && now < f.startTime) return false;
  if (f.endTime != null && now > f.endTime) return false;
  return true;
}

// Dessine une forme vectorielle (réutilise maskShapePath) ou un sticker
// emoji sur son propre calque carré, positionné/pivoté comme un bloc de
// texte (calque libre, indépendant de la timeline photo).
function dessinerForme(f, layerName) {
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer(layerName);
  const taille = Math.max(20, (Number(f.scale) || 0.18) * Math.min(width, height));
  const marge = Math.ceil(taille * 0.25);
  const dim = taille + marge * 2;
  sizeLayerCanvas(layer, dim, dim);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, dim, dim);

  if (EditorState.modeContours) {
    dessinerContourAsset(ctx, 0, 0, dim, dim, 12, 'rect', `#${f.id} forme (${f.type})`, { x: f.x, y: f.y, z: f.z ?? 8 });
    placerLayer(layer, f.x * width, f.y * height, f.z ?? 8, 0, 0, ((f.rotZ || 0) * Math.PI) / 180);
    layer.mesh.scale.set(dim, dim, 1);
    return { x: f.x * width - dim / 2, y: f.y * height - dim / 2, w: dim, h: dim, cx: f.x * width, cy: f.y * height, z: f.z ?? 8 };
  }

  ctx.globalAlpha = Number(f.opacite ?? 1);

  if (f.type === 'sticker') {
    ctx.font = `${taille}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.emoji || '⭐', dim / 2, dim / 2 + taille * 0.08);
  } else {
    maskShapePath(ctx, f.type, marge, marge, taille, taille, taille * 0.08);
    ctx.fillStyle = f.couleur || '#00e676';
    ctx.fill();
    if (f.contourActive) {
      ctx.strokeStyle = f.contourColor || '#ffffff';
      ctx.lineWidth = Number(f.contourWidth) || 4;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const cx = f.x * width;
  const cy = f.y * height;
  const rotZ = ((f.rotZ || 0) * Math.PI) / 180;
  placerLayer(layer, cx, cy, f.z ?? 8, 0, 0, rotZ);
  layer.mesh.scale.set(dim, dim, 1);
  return { x: cx - dim / 2, y: cy - dim / 2, w: dim, h: dim, cx, cy, z: f.z ?? 8 };
}

function mettreAJourFormes(now) {
  EditorState.shapes.forEach((f) => {
    const layerName = `forme-${f.id}`;
    if (!formeActive(f, now)) {
      hideLayer(layerName);
      return;
    }
    dessinerForme(f, layerName);
  });
  // Masque les layers des formes supprimées entre-temps.
  Object.keys(EditorState.three.layers).forEach((name) => {
    if (name.startsWith('forme-') && !EditorState.shapes.some((f) => `forme-${f.id}` === name)) {
      hideLayer(name);
    }
  });
}

function dessinActif(d, now) {
  if (d.visible === false) return false;
  if (d.startTime != null && now < d.startTime) return false;
  if (d.endTime != null && now > d.endTime) return false;
  return true;
}

// Un trait de dessin libre occupe tout le cadre (les points peuvent partir
// n'importe où), contrairement aux formes/textes qui ont une boîte propre.
function dessinerTrait(d, layerName) {
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer(layerName);
  sizeLayerCanvas(layer, width, height);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, width, height);
  if (d.points.length >= 2) {
    ctx.globalAlpha = Number(d.opacite ?? 1);
    ctx.strokeStyle = d.couleur || '#ff2d95';
    ctx.lineWidth = Number(d.epaisseur) || 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    d.points.forEach((pt, i) => {
      const x = pt.x * width;
      const y = pt.y * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  placerLayer(layer, width / 2, height / 2, d.z ?? 9, 0, 0, 0);
  layer.mesh.scale.set(width, height, 1);
}

function mettreAJourDessins(now) {
  EditorState.drawings.forEach((d) => {
    const layerName = `dessin-${d.id}`;
    if (!dessinActif(d, now) || d.points.length < 2) {
      hideLayer(layerName);
      return;
    }
    dessinerTrait(d, layerName);
  });
  Object.keys(EditorState.three.layers).forEach((name) => {
    if (name.startsWith('dessin-') && !EditorState.drawings.some((d) => `dessin-${d.id}` === name)) {
      hideLayer(name);
    }
  });
}

// Cadre décoratif plein cadre, dessiné par-dessus tout le reste (z le plus
// élevé de la scène) — bordure simple/double, coins, pellicule ou polaroid.
function dessinerCadreDecoratif() {
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer('cadre-decoratif');
  sizeLayerCanvas(layer, width, height);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, width, height);
  const cfg = EditorState.cadreDecoratif;
  const couleur = cfg.couleur || '#ffffff';
  const ep = Math.max(2, Number(cfg.epaisseur) || 24);

  if (cfg.type === 'simple') {
    ctx.strokeStyle = couleur;
    ctx.lineWidth = ep;
    ctx.strokeRect(ep / 2, ep / 2, width - ep, height - ep);
  } else if (cfg.type === 'double') {
    const gap = ep * 0.8;
    const lw = Math.max(2, ep * 0.35);
    ctx.strokeStyle = couleur;
    ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, width - lw, height - lw);
    ctx.strokeRect(gap + lw / 2, gap + lw / 2, width - (gap + lw) * 2 + lw, height - (gap + lw) * 2 + lw);
  } else if (cfg.type === 'coins') {
    const long = Math.max(30, ep * 3);
    const m = ep * 0.6;
    ctx.strokeStyle = couleur;
    ctx.lineWidth = ep * 0.4;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(m, m + long);
    ctx.lineTo(m, m);
    ctx.lineTo(m + long, m);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - m - long, m);
    ctx.lineTo(width - m, m);
    ctx.lineTo(width - m, m + long);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m, height - m - long);
    ctx.lineTo(m, height - m);
    ctx.lineTo(m + long, height - m);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - m - long, height - m);
    ctx.lineTo(width - m, height - m);
    ctx.lineTo(width - m, height - m - long);
    ctx.stroke();
  } else if (cfg.type === 'pellicule') {
    const bandeW = Math.max(30, ep * 2.2);
    ctx.fillStyle = couleur;
    ctx.fillRect(0, 0, bandeW, height);
    ctx.fillRect(width - bandeW, 0, bandeW, height);
    const trouTaille = bandeW * 0.4;
    const pas = trouTaille * 2.2;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    for (let y = pas / 2; y < height; y += pas) {
      roundRectPath(ctx, bandeW / 2 - trouTaille / 2, y - trouTaille / 2, trouTaille, trouTaille, trouTaille * 0.2);
      ctx.fill();
      roundRectPath(ctx, width - bandeW / 2 - trouTaille / 2, y - trouTaille / 2, trouTaille, trouTaille, trouTaille * 0.2);
      ctx.fill();
    }
  } else if (cfg.type === 'polaroid') {
    const bordure = Math.max(16, ep);
    const bas = bordure * 3.2;
    ctx.fillStyle = couleur;
    ctx.fillRect(0, 0, width, bordure);
    ctx.fillRect(0, 0, bordure, height);
    ctx.fillRect(width - bordure, 0, bordure, height);
    ctx.fillRect(0, height - bas, width, bas);
  }

  placerLayer(layer, width / 2, height / 2, 25, 0, 0, 0);
  layer.mesh.scale.set(width, height, 1);
}

function mettreAJourCadreDecoratif() {
  if (!EditorState.cadreDecoratif || EditorState.cadreDecoratif.type === 'none') {
    hideLayer('cadre-decoratif');
    return;
  }
  dessinerCadreDecoratif();
}

function mettreAJourBlocsTexte(now, tGlobal) {
  const boxes = {};
  EditorState.textBlocks.forEach((b) => {
    const layerName = `text-${b.id}`;
    if (!b.texte || !blocTexteActif(b, now)) {
      hideLayer(layerName);
      mettreAJourParticules(null, null, tGlobal, `text-particles-${b.id}`);
      return;
    }
    const box = dessinerBlocTexte(b, layerName, now, tGlobal);
    if (box) boxes[b.id] = box;
    mettreAJourParticules(b, box, tGlobal, `text-particles-${b.id}`);
  });
  // Masque les layers (et particules) des blocs supprimés entre-temps.
  Object.keys(EditorState.three.layers).forEach((name) => {
    if (name.startsWith('text-') && !EditorState.textBlocks.some((b) => `text-${b.id}` === name)) {
      hideLayer(name);
    }
  });
  Object.keys(EditorState.three.particleSystems).forEach((key) => {
    if (key.startsWith('text-particles-') && !EditorState.textBlocks.some((b) => `text-particles-${b.id}` === key)) {
      EditorState.three.particleSystems[key].points.visible = false;
    }
  });
  return boxes;
}

// Une passe de dessin du texte respectant l'animation en cours (machine à
// écrire = révélation progressive des caractères, sinon alpha progressif
// pour fondu/glissement/pop) — réutilisée pour le glow, le contour et le
// texte final. `mode` = 'fill' (défaut) ou 'stroke' pour le contour.
function dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress, mode) {
  const dessinerTexte = mode === 'stroke' ? (t, x, y) => ctx.strokeText(t, x, y) : (t, x, y) => ctx.fillText(t, x, y);
  if (anim === 'typewriter') {
    const texteComplet = lignes.join('\n');
    const nVisible = Math.round(progress * texteComplet.length);
    let compte = 0;
    lignes.forEach((ligne, i) => {
      const restant = Math.max(0, nVisible - compte);
      dessinerTexte(ligne.slice(0, restant), textX, padY + i * lineHeight);
      compte += ligne.length;
    });
  } else {
    const animsAvecFondu = ['fade', 'slide', 'pop', 'rotate3d', 'blur'];
    const alphaAvant = ctx.globalAlpha;
    ctx.globalAlpha = (animsAvecFondu.includes(anim) ? progress : 1) * alphaAvant;
    lignes.forEach((ligne, i) => dessinerTexte(ligne, textX, padY + i * lineHeight));
    ctx.globalAlpha = alphaAvant;
  }
}

// Dessine `texte` (une seule ligne) le long d'un arc de cercle centré sur
// (centerX, centerY). `rayon` positif courbe le texte vers le haut (comme
// un sourire inversé, lettres suivant le haut du cercle), négatif vers le
// bas. Chaque caractère est positionné et pivoté selon sa tangente à l'arc.
function dessinerTexteCourbe(ctx, texte, centerX, centerY, rayon, mode) {
  const rayonAbs = Math.max(60, Math.abs(rayon));
  const sens = rayon < 0 ? -1 : 1;
  const caracteres = [...texte];
  const largeurs = caracteres.map((c) => ctx.measureText(c).width);
  const largeurTotale = largeurs.reduce((a, v) => a + v, 0);
  const angleTotal = largeurTotale / rayonAbs;
  let angle = -angleTotal / 2;
  const alignAvant = ctx.textAlign;
  const baselineAvant = ctx.textBaseline;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  caracteres.forEach((car, i) => {
    const demiPas = largeurs[i] / 2 / rayonAbs;
    angle += demiPas;
    const x = centerX + Math.sin(angle) * rayonAbs;
    const y = centerY - sens * Math.cos(angle) * rayonAbs;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle * sens);
    if (mode === 'stroke') ctx.strokeText(car, 0, 0);
    else ctx.fillText(car, 0, 0);
    ctx.restore();
    angle += demiPas;
  });
  ctx.textAlign = alignAvant;
  ctx.textBaseline = baselineAvant;
}

function dessinerBlocTexte(b, layerName, now, tGlobal) {
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer(layerName);
  const size = Number(b.size) || 56;
  const famille = b.fontFamily === 'custom' && EditorState.fontFamily ? `"${EditorState.fontFamily}"` : b.fontFamily || "'Space Grotesk', sans-serif";
  const weight = b.bold === false ? '400' : '700';
  const style = b.italic ? 'italic' : 'normal';

  const measureCtx = layer.ctx;
  measureCtx.font = `${style} ${weight} ${size}px ${famille}`;
  // letterSpacing n'est pas supporté par tous les moteurs (Chrome/Edge oui,
  // certaines versions de Firefox/Safari l'ignorent silencieusement) : dans
  // ce cas l'espacement reste simplement à 0, sans erreur.
  const espacementLettres = `${Number(b.espacementLettres) || 0}px`;
  measureCtx.letterSpacing = espacementLettres;
  const padX = 26;
  const padY = 18;
  const lineHeight = size * (Number(b.interligne) || 1.2);

  // Texte courbe : une seule ligne (les retours à la ligne n'ont pas de
  // sens sur un arc), dimensionnée d'après la sagittale de l'arc plutôt
  // que le pavé rectangulaire habituel.
  const estCourbe = !!b.texteCourbe;
  let lignes = [];
  let panelW;
  let panelH;
  let texteCourbe = '';
  let rayonCourbe = 0;
  let centerXCourbe = 0;
  let centerYCourbe = 0;

  if (estCourbe) {
    texteCourbe = (b.texte || '').replace(/\s*\n+\s*/g, ' ').trim();
    rayonCourbe = Number(b.courbeRayon) || 220;
    const rayonAbs = Math.max(60, Math.abs(rayonCourbe));
    const largeurTexte = [...texteCourbe].reduce((acc, c) => acc + measureCtx.measureText(c).width, 0);
    const angleTotal = Math.min(Math.PI * 1.8, largeurTexte / rayonAbs);
    const sagitta = rayonAbs * (1 - Math.cos(angleTotal / 2));
    panelW = largeurTexte + padX * 2 + size;
    panelH = size + sagitta + padY * 2;
    centerXCourbe = panelW / 2;
    centerYCourbe = rayonCourbe >= 0 ? padY + size / 2 + rayonAbs : panelH - padY - size / 2 - rayonAbs;
  } else {
    const maxWidth = width * (b.wrapWidth || 0.85);
    lignes = wrapText(measureCtx, b.texte, maxWidth);
    const totalHeight = lineHeight * lignes.length;
    let boxW = 0;
    lignes.forEach((ligne) => {
      boxW = Math.max(boxW, measureCtx.measureText(ligne).width);
    });
    panelW = boxW + padX * 2;
    panelH = totalHeight + padY * 2;
  }

  sizeLayerCanvas(layer, panelW, panelH);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, panelW, panelH);

  const anim = b.anim || 'none';
  // Durée de l'animation d'entrée/sortie — configurable par bloc
  // (animDuree) car un long texte en 'typewriter' à 0.5s fixe défilerait
  // bien trop vite pour être perçu comme un vrai effet machine à écrire.
  const dureeAnim = Number(b.animDuree) || 0.5;
  const progress = appliquerEasing(progressionAnimation(b.startTime, b.endTime, now, dureeAnim), b.easing);

  if (EditorState.modeContours) {
    dessinerContourAsset(ctx, 0, 0, panelW, panelH, 18, 'rect', `#${b.id} texte: "${(b.texte || '').slice(0, 20)}"`, {
      x: b.x,
      y: b.y,
      z: b.z ?? 10,
    });
  } else {
  if (b.bgPanelActive !== false) {
    roundRectPath(ctx, 0, 0, panelW, panelH, 18);
    ctx.fillStyle = 'rgba(8,10,14,0.5)';
    ctx.fill();
  }

  const align = b.align || 'center';
  ctx.font = `${style} ${weight} ${size}px ${famille}`;
  ctx.letterSpacing = espacementLettres; // sizeLayerCanvas() a réinitialisé le contexte
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const textX = align === 'left' ? padX : align === 'right' ? panelW - padX : panelW / 2;

  // 'blur' : net à progress=1, flou croissant à mesure qu'on s'éloigne du
  // plein affichage (entrée ou sortie).
  ctx.filter = anim === 'blur' ? `blur(${Math.max(0, (1 - progress) * 10)}px)` : 'none';

  // Sur un texte courbe, l'alignement gauche/centre/droite et la révélation
  // caractère par caractère (typewriter) n'ont pas de sens applicables tels
  // quels : on garde juste le fondu de progression, comme fade/slide/pop.
  // `mode` = 'fill' (défaut) ou 'stroke' pour le contour.
  const dessinerPasse = (mode) => {
    if (!estCourbe) {
      dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress, mode);
      return;
    }
    const animsAvecFondu = ['fade', 'slide', 'pop', 'rotate3d', 'blur', 'typewriter'];
    const alphaAvant = ctx.globalAlpha;
    ctx.globalAlpha = (animsAvecFondu.includes(anim) ? progress : 1) * alphaAvant;
    dessinerTexteCourbe(ctx, texteCourbe, centerXCourbe, centerYCourbe, rayonCourbe, mode);
    ctx.globalAlpha = alphaAvant;
  };

  if (b.glowActive) {
    ctx.save();
    ctx.fillStyle = b.glowColor || '#00e5ff';
    ctx.shadowColor = b.glowColor || '#00e5ff';
    ctx.shadowBlur = 32;
    dessinerPasse();
    ctx.shadowBlur = 16;
    dessinerPasse();
    ctx.restore();
  }

  if (b.strokeActive) {
    ctx.save();
    ctx.strokeStyle = b.strokeColor || '#000000';
    ctx.lineWidth = Number(b.strokeWidth) || 4;
    ctx.lineJoin = 'round';
    dessinerPasse('stroke');
    ctx.restore();
  }

  ctx.fillStyle = b.gradientActive
    ? creerDegradeTexte(ctx, panelW, panelH, b.gradientColor1 || '#00e5ff', b.gradientColor2 || '#ff2d95', b.gradientAngle ?? 90)
    : b.color || '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  dessinerPasse();
  ctx.shadowBlur = 0;

  if (b.saberActive) {
    dessinerContourEnergetique(
      ctx, 0, 0, panelW, panelH, 18, b.saberColor || '#00e5ff', tGlobal || 0,
      b.saberCount, b.saberSize
    );
  }
  ctx.filter = 'none';
  }

  let cx = b.x * width;
  let cy = b.y * height;
  let scaleMul = 1;
  let rotYAnim = 0;
  if (anim === 'slide') {
    cx += (1 - progress) * width * 0.15;
  } else if (anim === 'pop') {
    scaleMul = 0.6 + 0.4 * progress;
  } else if (anim === 'rotate3d') {
    rotYAnim = (1 - progress) * (Math.PI / 2);
  }

  const rotX = ((b.rotX || 0) * Math.PI) / 180;
  const rotY = ((b.rotY || 0) * Math.PI) / 180 + rotYAnim;
  const rotZ = ((b.rotZ || 0) * Math.PI) / 180;
  placerLayer(layer, cx, cy, b.z ?? 10, rotX, rotY, rotZ);
  layer.mesh.scale.set(panelW * scaleMul, panelH * scaleMul, 1);

  return { x: cx - panelW / 2, y: cy - panelH / 2, w: panelW, h: panelH, cx, cy, z: b.z ?? 10 };
}

let particuleSpriteTexture = null;
function getParticuleSprite(THREE) {
  if (particuleSpriteTexture) return particuleSpriteTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const cx = c.getContext('2d');
  const grad = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, 64, 64);
  particuleSpriteTexture = new THREE.CanvasTexture(c);
  return particuleSpriteTexture;
}

// Particules énergétiques flottant autour de la carte active (effet
// Saber additionnel). Positions relatives régénérées à chaque activation,
// dérive lente + scintillement.
function mettreAJourParticules(entity, box, tGlobal, key) {
  const ts = EditorState.three;
  const { THREE, scene } = ts;
  const p = entity;
  const actif = !!(p && p.particlesActive && box);

  if (!actif) {
    if (ts.particleSystems[key]) ts.particleSystems[key].points.visible = false;
    return;
  }

  let sys = ts.particleSystems[key];
  const count = 60;
  if (!sys) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seeds[i * 3] = Math.random() * Math.PI * 2;
      seeds[i * 3 + 1] = 0.6 + Math.random() * 0.8;
      seeds[i * 3 + 2] = Math.random();
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      size: 18,
      map: getParticuleSprite(THREE),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: 0x66e5ff,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    sys = { points, seeds, count };
    ts.particleSystems[key] = sys;
  }

  sys.points.visible = true;
  sys.points.material.color.set(p.saberColor || '#66e5ff');
  const positions = sys.points.geometry.attributes.position.array;
  const radiusX = box.w * 0.62;
  const radiusY = box.h * 0.62;
  for (let i = 0; i < sys.count; i++) {
    const baseAngle = sys.seeds[i * 3];
    const speed = sys.seeds[i * 3 + 1];
    const offset = sys.seeds[i * 3 + 2];
    const angle = baseAngle + tGlobal * speed * 0.4;
    const bob = Math.sin(tGlobal * speed + offset * 10) * 14;
    const px = box.cx + Math.cos(angle) * radiusX * (0.7 + 0.3 * Math.sin(offset * 6.28));
    const py = box.cy + Math.sin(angle) * radiusY * (0.7 + 0.3 * Math.cos(offset * 6.28)) + bob;
    const world = pxToWorld(px, py, box.z + 6);
    positions[i * 3] = world.x;
    positions[i * 3 + 1] = world.y;
    positions[i * 3 + 2] = world.z;
  }
  sys.points.geometry.attributes.position.needsUpdate = true;
}

// Niveau audio moyen instantané (0..1), pour piloter des effets réactifs
// à la musique (ex. intensité du bloom global) sans dépendre du contour
// d'un calque précis.
function niveauAudioMoyen() {
  const analyserState = EditorState.audioAnalyser;
  if (!analyserState) return 0;
  analyserState.analyser.getByteFrequencyData(analyserState.dataArray);
  const data = analyserState.dataArray;
  let somme = 0;
  for (let i = 0; i < data.length; i++) somme += data[i];
  return somme / data.length / 255;
}

const DUREE_TRANSITION = 0.4; // secondes

// Réinitialise le mesh d'un layer à son état "neutre" (opaque, pas de
// décalage) — nécessaire car la transition précédente a pu laisser une
// opacity/position altérée dessus.
function resetTransitionLayer(layerName) {
  const layer = EditorState.three.layers[layerName];
  if (layer) layer.mesh.material.opacity = 1;
}

// Applique l'effet visuel d'une transition en cours sur le mesh d'un
// layer photo : fondu (opacity), glissement (décalage horizontal) ou
// zoom (échelle), selon EditorState.transitionType. `progress` va de 0
// (segment pas encore commencé / sur le point de disparaître) à 1
// (pleinement affiché), `direction` = 'in' | 'out'.
function appliquerEffetTransition(layerName, progress, direction) {
  const layer = EditorState.three.layers[layerName];
  if (!layer || !layer.mesh.visible) return;
  const type = EditorState.transitionType;
  const mesh = layer.mesh;
  if (type === 'fade' || type === 'none') {
    mesh.material.opacity = type === 'none' ? 1 : progress;
  } else if (type === 'slide') {
    mesh.material.opacity = 1;
    const decalage = (1 - progress) * EditorState.three.width * 0.5;
    mesh.position.x += direction === 'in' ? decalage : -decalage;
  } else if (type === 'zoom') {
    mesh.material.opacity = progress;
    const s = direction === 'in' ? 0.85 + progress * 0.15 : 1 + (1 - progress) * 0.15;
    mesh.scale.multiplyScalar(s);
  }
}

function renderEditorFrame() {
  const ts = EditorState.three;
  if (!ts) return;

  const { segments, dureeTotale } = calculerTimeline();
  avancerPlayback(dureeTotale);
  const now = EditorState.playback.currentTime;
  const segmentActif = segmentAuTemps(segments, now);
  const idxActif = segments.indexOf(segmentActif);
  const segmentSuivant = idxActif >= 0 ? segments[idxActif + 1] : null;

  mettreAJourFond(segmentActif);
  appliquerFadeAudio(now, dureeTotale);

  // Fenêtre de transition : les DUREE_TRANSITION dernières secondes du
  // segment actif, s'il y a un segment suivant et qu'une transition est
  // choisie. Le sortant s'estompe sur son layer habituel, l'entrant est
  // pré-affiché en avance sur un second jeu de layers ('*-in').
  const enTransition =
    EditorState.transitionType !== 'none' &&
    segmentActif &&
    segmentSuivant &&
    segmentActif.end - now < DUREE_TRANSITION;
  const progressSortie = enTransition ? Math.max(0, (segmentActif.end - now) / DUREE_TRANSITION) : 1;
  const progressEntree = enTransition ? 1 - progressSortie : 0;

  const tGlobal = performance.now() / 1000;
  let photoBox = null;
  if (segmentActif && segmentActif.type === 'photo') {
    hideLayer('introLogo');
    hideLayer('introImg');
    hideLayer('introText');
    photoBox = mettreAJourPhoto(segmentActif.data, tGlobal, 'photo');
    resetTransitionLayer('photo');
    mettreAJourLegende(segmentActif.data);
    mettreAJourParticules(segmentActif.data, photoBox, tGlobal, 'photoParticles');
    if (enTransition) appliquerEffetTransition('photo', progressSortie, 'out');
  } else if (segmentActif) {
    hideLayer('photo');
    hideLayer('caption');
    mettreAJourIntroOutro(segmentActif.data);
    mettreAJourParticules(null, null, tGlobal, 'photoParticles');
  } else {
    hideLayer('photo');
    hideLayer('caption');
    hideLayer('introLogo');
    hideLayer('introImg');
    hideLayer('introText');
    mettreAJourParticules(null, null, tGlobal, 'photoParticles');
  }

  if (enTransition && segmentSuivant.type === 'photo') {
    resetTransitionLayer('photo-in');
    mettreAJourPhoto(segmentSuivant.data, tGlobal, 'photo-in');
    appliquerEffetTransition('photo-in', progressEntree, 'in');
  } else {
    hideLayer('photo-in');
  }

  mettreAJourMediasSuperposes(segmentActif, tGlobal);

  EditorState._textBoxes = mettreAJourBlocsTexte(EditorState.playback.currentTime, tGlobal);
  mettreAJourFormes(EditorState.playback.currentTime);
  mettreAJourDessins(EditorState.playback.currentTime);
  mettreAJourCadreDecoratif();

  ts.bloomPass.enabled = EditorState.effects.bloomActive;
  let strength = Number(EditorState.effects.bloomStrength) || 0;
  if (EditorState.effects.bloomAudioReactive) {
    strength += niveauAudioMoyen() * 0.35;
  }
  ts.bloomPass.strength = strength;
  if (EditorState.effects.bloomActive) {
    ts.composer.setSize(ts.width, ts.height);
    ts.composer.render();
  } else {
    ts.renderer.setSize(ts.width, ts.height, false);
    ts.renderer.render(ts.scene, ts.camera);
  }
  mettreAJourUiTimeline(dureeTotale);
}

/* -------------------------------------------------------------------- */
/* Contrôles (imports + réglages)                                        */
/* -------------------------------------------------------------------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function afficherNomFichier(spanId, file) {
  const span = document.getElementById(spanId);
  if (span) span.textContent = file ? file.name : 'Aucun fichier choisi';
}

function obtenirNomExport(defaut) {
  const input = document.getElementById('editor-filename');
  const brut = (input && input.value.trim()) || defaut;
  const nettoye = brut
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return nettoye || defaut;
}

async function chargerImage(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
  } catch (_) {}
  return img;
}

// Comme chargerImage, mais accepte aussi une vidéo (calques photo) : les
// deux s'utilisent ensuite de façon interchangeable avec ctx.drawImage et
// mediaW()/mediaH().
async function chargerMediaPhoto(file) {
  if (file.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    try {
      await video.play();
    } catch (_) {}
    return video;
  }
  return chargerImage(file);
}

// Charge un fichier (image ou vidéo) comme fond global, et met à jour
// bgType/bgVideoEl/bgImageEl en conséquence. Factorisé pour être réutilisé
// à la fois par l'input de fichier du panneau et par PlayTesteurAPI.
async function chargerFondDepuisFichier(file) {
  if (file.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    try {
      await video.play();
    } catch (_) {
      /* autoplay refusé, la boucle rAF affichera dès que possible */
    }
    EditorState.bgVideoEl = video;
    EditorState.bgType = 'video';
  } else {
    EditorState.bgImageEl = await chargerImage(file);
    EditorState.bgType = 'image';
  }
}

function bindSegmentControls(seg, prefix, segType) {
  const toggle = document.getElementById(`editor-${prefix}-toggle`);
  const panel = document.getElementById(`editor-${prefix}-panel`);
  const logoInput = document.getElementById(`editor-${prefix}-logo-input`);
  const imgInput = document.getElementById(`editor-${prefix}-img-input`);
  const textInput = document.getElementById(`editor-${prefix}-text`);
  const dureeInput = document.getElementById(`editor-${prefix}-duree`);
  if (!toggle) return;

  toggle.addEventListener('change', (e) => {
    seg.active = e.target.checked;
    panel.classList.toggle('hidden', !seg.active);
    if (seg.active) allerAuSegment((s) => s.type === segType);
  });
  logoInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier(`editor-${prefix}-logo-filename`, file);
    seg.logoImg = await chargerImage(file);
    allerAuSegment((s) => s.type === segType);
  });
  imgInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier(`editor-${prefix}-img-filename`, file);
    seg.img = await chargerImage(file);
    allerAuSegment((s) => s.type === segType);
  });
  textInput.addEventListener('input', (e) => {
    seg.texte = e.target.value;
  });
  dureeInput.addEventListener('input', (e) => {
    seg.duree = Math.max(0.5, Number(e.target.value) || 3);
  });
}

function bindEditorInputs() {
  const bgInput = document.getElementById('editor-bg-input');
  const audioInput = document.getElementById('editor-audio-input');
  const addPhotoBtn = document.getElementById('editor-add-photo');
  const addTextBlockBtn = document.getElementById('editor-add-textblock');
  const fontInput = document.getElementById('editor-font-input');
  const exportPngBtn = document.getElementById('editor-export-png');
  const exportMp4Btn = document.getElementById('editor-export-mp4');
  const exportGifBtn = document.getElementById('editor-export-gif');

  bgInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier('editor-bg-filename', file);
    await chargerFondDepuisFichier(file);
  });

  const bgTypeSelect = document.getElementById('editor-bg-type');
  const bgMediaPanel = document.getElementById('editor-bg-media-panel');
  const bgColorPanel = document.getElementById('editor-bg-color-panel');
  const bgGradientPanel = document.getElementById('editor-bg-gradient-panel');
  if (bgTypeSelect) {
    bgTypeSelect.addEventListener('change', (e) => {
      const mode = e.target.value;
      bgMediaPanel.classList.toggle('hidden', mode !== 'media');
      bgColorPanel.classList.toggle('hidden', mode !== 'color');
      bgGradientPanel.classList.toggle('hidden', mode !== 'gradient');
      if (mode === 'color') EditorState.bgType = 'color';
      else if (mode === 'gradient') EditorState.bgType = 'gradient';
      else EditorState.bgType = EditorState.bgVideoEl ? 'video' : EditorState.bgImageEl ? 'image' : null;
    });
  }
  const bgColorInput = document.getElementById('editor-bg-color');
  if (bgColorInput) bgColorInput.addEventListener('input', (e) => (EditorState.bgColor = e.target.value));
  const bgGradient1 = document.getElementById('editor-bg-gradient1');
  if (bgGradient1) bgGradient1.addEventListener('input', (e) => (EditorState.bgGradient.color1 = e.target.value));
  const bgGradient2 = document.getElementById('editor-bg-gradient2');
  if (bgGradient2) bgGradient2.addEventListener('input', (e) => (EditorState.bgGradient.color2 = e.target.value));
  const bgGradientAngle = document.getElementById('editor-bg-gradient-angle');
  if (bgGradientAngle) {
    bgGradientAngle.addEventListener('input', (e) => (EditorState.bgGradient.angle = Number(e.target.value)));
  }
  const bgBrightness = document.getElementById('editor-bg-brightness');
  if (bgBrightness) bgBrightness.addEventListener('input', (e) => (EditorState.bgAdjust.brightness = Number(e.target.value)));
  const bgBlur = document.getElementById('editor-bg-blur');
  if (bgBlur) bgBlur.addEventListener('input', (e) => (EditorState.bgAdjust.blur = Number(e.target.value)));
  const overlayType = document.getElementById('editor-overlay-type');
  if (overlayType) overlayType.addEventListener('change', (e) => (EditorState.overlay.type = e.target.value));
  const overlayStrength = document.getElementById('editor-overlay-strength');
  if (overlayStrength) {
    overlayStrength.addEventListener('input', (e) => (EditorState.overlay.strength = Number(e.target.value) / 100));
  }
  const bgChromaKeyToggle = document.getElementById('editor-bg-chromakey-toggle');
  if (bgChromaKeyToggle) {
    bgChromaKeyToggle.addEventListener('change', (e) => (EditorState.bgChromaKey.active = e.target.checked));
  }
  const bgChromaKeyColor = document.getElementById('editor-bg-chromakey-color');
  if (bgChromaKeyColor) {
    bgChromaKeyColor.addEventListener('input', (e) => (EditorState.bgChromaKey.color = e.target.value));
  }
  const bgChromaKeyTolerance = document.getElementById('editor-bg-chromakey-tolerance');
  if (bgChromaKeyTolerance) {
    bgChromaKeyTolerance.addEventListener(
      'input',
      (e) => (EditorState.bgChromaKey.tolerance = Number(e.target.value) / 100)
    );
  }

  audioInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier('editor-audio-filename', file);
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    audio.currentTime = EditorState.audioTrimStart;
    EditorState.audioEl = audio;
    audio.play().catch(() => {});
    brancherAnalyseurAudio(audio);
    calculerWaveform(file);
  });

  const voiceInput = document.getElementById('editor-voice-input');
  if (voiceInput) {
    voiceInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      afficherNomFichier('editor-voice-filename', file);
      const voice = new Audio();
      voice.src = URL.createObjectURL(file);
      voice.loop = false;
      voice.crossOrigin = 'anonymous';
      EditorState.voiceEl = voice;
      voice.play().catch(() => {});
      brancherVoixOff(voice);
    });
  }

  const audioVolumeInput = document.getElementById('editor-audio-volume');
  if (audioVolumeInput) {
    audioVolumeInput.addEventListener('input', (e) => {
      EditorState.audioVolume = Number(e.target.value) / 100;
    });
  }
  const audioFadeInInput = document.getElementById('editor-audio-fadein');
  if (audioFadeInInput) {
    audioFadeInInput.addEventListener('input', (e) => (EditorState.audioFadeIn = Number(e.target.value)));
  }
  const audioFadeOutInput = document.getElementById('editor-audio-fadeout');
  if (audioFadeOutInput) {
    audioFadeOutInput.addEventListener('input', (e) => (EditorState.audioFadeOut = Number(e.target.value)));
  }
  const audioTrimInput = document.getElementById('editor-audio-trim');
  if (audioTrimInput) {
    audioTrimInput.addEventListener('input', (e) => {
      EditorState.audioTrimStart = Math.max(0, Number(e.target.value) || 0);
      if (EditorState.audioEl) EditorState.audioEl.currentTime = EditorState.audioTrimStart;
    });
  }
  const voiceVolumeInput = document.getElementById('editor-voice-volume');
  if (voiceVolumeInput) {
    voiceVolumeInput.addEventListener('input', (e) => {
      EditorState.voiceVolume = Number(e.target.value) / 100;
      if (EditorState.voiceGainNode) EditorState.voiceGainNode.gain.value = EditorState.voiceVolume;
    });
  }

  bindSegmentControls(EditorState.intro, 'intro', 'intro');
  bindSegmentControls(EditorState.outro, 'outro', 'outro');

  addPhotoBtn.addEventListener('click', ajouterCalquePhoto);

  fontInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier('editor-font-filename', file);
    try {
      const buf = await file.arrayBuffer();
      const face = new FontFace('PolicePersonnalisee', buf);
      await face.load();
      document.fonts.add(face);
      EditorState.fontFamily = 'PolicePersonnalisee';
      EditorState.fontBlob = file;
      EditorState.fontFileName = file.name;
      toast('Police chargée, appliquée au texte.', 'success');
    } catch (err) {
      toast('Impossible de charger cette police.', 'error');
    }
  });

  addTextBlockBtn.addEventListener('click', ajouterBlocTexte);

  const addShapeBtn = document.getElementById('editor-add-shape');
  if (addShapeBtn) addShapeBtn.addEventListener('click', ajouterForme);

  const transitionSelect = document.getElementById('editor-transition-type');
  if (transitionSelect) {
    transitionSelect.addEventListener('change', (e) => {
      EditorState.transitionType = e.target.value;
    });
  }

  const bloomToggle = document.getElementById('editor-bloom-toggle');
  const bloomStrength = document.getElementById('editor-bloom-strength');
  if (bloomToggle) {
    bloomToggle.addEventListener('change', (e) => {
      EditorState.effects.bloomActive = e.target.checked;
    });
  }
  if (bloomStrength) {
    bloomStrength.addEventListener('input', (e) => {
      EditorState.effects.bloomStrength = Number(e.target.value) / 20;
    });
  }
  const bloomAudioReactive = document.getElementById('editor-bloom-audioreactive');
  if (bloomAudioReactive) {
    bloomAudioReactive.addEventListener('change', (e) => {
      if (e.target.checked && !EditorState.audioEl) {
        toast('Importez une musique de fond pour lier le halo à la musique.', 'error');
        e.target.checked = false;
        return;
      }
      EditorState.effects.bloomAudioReactive = e.target.checked;
    });
  }

  document.querySelectorAll('input[name="editor-img-format"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) EditorState.imageExportFormat = e.target.value;
      mettreAJourOverlayZoneCapture();
    });
  });

  const cropOverlayToggle = document.getElementById('editor-crop-overlay-toggle');
  if (cropOverlayToggle) {
    cropOverlayToggle.addEventListener('change', mettreAJourOverlayZoneCapture);
  }

  exportPngBtn.addEventListener('click', exportEditeurPng);
  exportMp4Btn.addEventListener('click', exportEditeurMp4);
  if (exportGifBtn) exportGifBtn.addEventListener('click', exportEditeurGif);
}

// Superpose sur l'aperçu 16:9 un cadre indiquant la zone gardée par
// l'export PNG (le PNG recalcule un cadrage à un autre ratio — 9:16 ou
// 1:1 — plutôt que de simplement rogner le 16:9 actuel, ce cadre reste
// donc une approximation centrée, mais elle indique fidèlement quelle
// portion centrale rester "en sécurité" quel que soit le format choisi).
// Le GIF garde le cadre plein (même ratio que la vidéo), donc rien à
// superposer pour lui — seul un rappel textuel est affiché.
function mettreAJourOverlayZoneCapture() {
  const toggle = document.getElementById('editor-crop-overlay-toggle');
  const overlay = document.getElementById('editor-crop-overlay');
  const frame = document.getElementById('editor-crop-overlay-frame');
  const label = document.getElementById('editor-crop-overlay-label');
  if (!toggle || !overlay || !frame || !label) return;

  const actif = toggle.checked;
  overlay.classList.toggle('hidden', !actif);
  if (!actif) return;

  const ratioCadre = 16 / 9;
  const estCarre = EditorState.imageExportFormat === 'square';
  const ratioCible = estCarre ? 1 : 9 / 16;
  const largeurPct = Math.min(100, (ratioCible / ratioCadre) * 100);
  frame.style.width = `${largeurPct}%`;
  label.textContent = estCarre
    ? 'Zone PNG carré (1080×1080) — GIF = cadre plein'
    : 'Zone PNG vertical (1080×1920) — GIF = cadre plein';
}

/* -------------------------------------------------------------------- */
/* Calques photo multiples (chacun avec sa légende et sa durée)          */
/* -------------------------------------------------------------------- */
// `media`, si fourni, sert à afficher un libellé cohérent quand le fichier
// vient d'être restauré (projet chargé, undo/redo...) plutôt qu'un choix
// direct dans ce champ — sinon "Aucun fichier choisi" restait affiché même
// avec un média déjà présent, laissant croire à tort que rien n'était chargé.
function markupFilePickerPhoto(inputId, filenameId, media) {
  const libelle = media ? (media.tagName === 'VIDEO' ? 'Vidéo chargée' : 'Image chargée') : 'Aucun fichier choisi';
  return `
    <div class="editor-file-picker-wrap">
      <label class="editor-file-picker" for="${inputId}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        <span>Choisir un fichier</span>
      </label>
      <input type="file" id="${inputId}" accept="image/png,image/jpeg,video/mp4" class="editor-file-input" multiple>
      <span class="editor-file-name" id="${filenameId}">${libelle}</span>
    </div>
  `;
}

// Sélection multiple courante pour les actions groupées — état d'interface
// éphémère (pas de session à session), donc volontairement hors
// EditorState/historique : coché/décoché n'est pas une action "undo-able".
const SelectionCalques = { photo: new Set(), textblock: new Set(), forme: new Set() };

// En-tête commun aux calques (photo ou bloc de texte) : case de sélection,
// nom éditable, verrouillage, visibilité, duplication et suppression.
// `typeRemove` fixe l'attribut data-remove-* correct (compatible avec les
// gestionnaires déjà en place) et sert aussi de clé dans SelectionCalques.
function renderCalqueHeadHtml(item, nomParDefaut, typeRemove) {
  const estVerrouille = !!item.verrouille;
  const estCache = item.visible === false;
  const estSelectionne = SelectionCalques[typeRemove].has(item.id);
  return `
    <div class="editor-photo-layer-head">
      <input type="checkbox" class="editor-calque-select" data-calquesel-for="${item.id}" data-calquesel-type="${typeRemove}" ${estSelectionne ? 'checked' : ''} title="Sélectionner pour une action groupée">
      <span class="editor-photo-layer-title" title="Glisser pour réordonner">&#9776;</span>
      <input type="text" class="editor-calque-nom" data-calquenom-for="${item.id}" value="${escapeHtml(item.nom || '')}" placeholder="${escapeHtml(nomParDefaut)}" title="Renommer ce calque">
      <div class="editor-calque-head-actions">
        <button type="button" class="editor-icon-btn ${estVerrouille ? 'active' : ''}" data-calquelock-for="${item.id}" title="${estVerrouille ? 'Déverrouiller (autoriser le déplacement)' : 'Verrouiller (empêcher déplacement et suppression)'}">${estVerrouille ? '🔒' : '🔓'}</button>
        <button type="button" class="editor-icon-btn ${estCache ? 'active' : ''}" data-calquevisible-for="${item.id}" title="${estCache ? 'Afficher ce calque' : 'Masquer ce calque (exclu de la timeline)'}">${estCache ? '🚫' : '👁'}</button>
        <button type="button" class="editor-icon-btn" data-calquecopystyle-for="${item.id}" title="Copier le style de ce calque (filtres, forme, effets...)">📋</button>
        <button type="button" class="editor-icon-btn" data-calquepastestyle-for="${item.id}" title="Coller le style copié">📥</button>
        <button type="button" class="editor-icon-btn" data-calqueduplique-for="${item.id}" title="Dupliquer ce calque">⧉</button>
        <button type="button" class="editor-remove-btn" data-remove-${typeRemove}="${item.id}" title="Supprimer" ${estVerrouille ? 'disabled' : ''}>&times;</button>
      </div>
    </div>
  `;
}

// Config par type de calque pour la sélection/les actions groupées —
// évite de multiplier les ternaires à chaque nouveau type de calque
// (photo/texte/forme partagent tous le même mécanisme).
const CONFIG_TYPE_CALQUE = {
  photo: { barId: 'editor-photos-bulk-bar', compteId: 'editor-photos-bulk-count', liste: () => EditorState.photos, rafraichir: () => rafraichirListePhotos() },
  textblock: { barId: 'editor-textblocks-bulk-bar', compteId: 'editor-textblocks-bulk-count', liste: () => EditorState.textBlocks, rafraichir: () => rafraichirListeTextBlocks() },
  forme: { barId: 'editor-shapes-bulk-bar', compteId: 'editor-shapes-bulk-count', liste: () => EditorState.shapes, rafraichir: () => rafraichirListeFormes() },
};

function majBarreSelectionGroupee(type) {
  const set = SelectionCalques[type];
  const config = CONFIG_TYPE_CALQUE[type];
  if (!set || !config) return;
  const bar = document.getElementById(config.barId);
  const compteEl = document.getElementById(config.compteId);
  if (bar) bar.classList.toggle('hidden', set.size === 0);
  if (compteEl) compteEl.textContent = `${set.size} sélectionné${set.size > 1 ? 's' : ''}`;
}

// Purge la sélection des id qui n'existent plus (calque supprimé
// individuellement) et resynchronise la barre d'actions groupées — appelé à
// chaque reconstruction de liste.
function purgerSelectionGroupee(type, listeActuelle) {
  const set = SelectionCalques[type];
  const idsActuels = new Set(listeActuelle.map((x) => x.id));
  [...set].forEach((id) => {
    if (!idsActuels.has(id)) set.delete(id);
  });
  majBarreSelectionGroupee(type);
}

// Applique une action (verrouiller/masquer/dupliquer/supprimer) à tous les
// calques actuellement sélectionnés pour ce type, en un seul passage
// d'historique plutôt qu'un par calque.
function executerActionGroupee(type, action) {
  const set = SelectionCalques[type];
  const config = CONFIG_TYPE_CALQUE[type];
  if (!set || !config) return;
  const ids = [...set];
  if (!ids.length) return;
  if (action === 'delete' && !confirm(`Supprimer ${ids.length} calque(s) sélectionné(s) ?`)) return;

  const liste = config.liste();

  if (action === 'lock') {
    liste.forEach((item) => {
      if (set.has(item.id)) item.verrouille = true;
    });
  } else if (action === 'hide') {
    liste.forEach((item) => {
      if (set.has(item.id)) item.visible = false;
    });
  } else if (action === 'duplicate') {
    ids.forEach((id) => {
      const index = liste.findIndex((item) => item.id === id);
      if (index === -1) return;
      const original = liste[index];
      const copie = {
        ...original,
        id: ++elementIdCounter,
        nom: original.nom ? `${original.nom} (copie)` : null,
        verrouille: false,
        sousMedias: (original.sousMedias || []).map((sm) => ({ ...sm, id: ++elementIdCounter })),
      };
      liste.splice(index + 1, 0, copie);
    });
  } else if (action === 'delete') {
    const restants = liste.filter((item) => !set.has(item.id) || item.verrouille);
    liste.length = 0;
    liste.push(...restants);
  }

  set.clear();
  config.rafraichir();
  pousserHistorique();
}

function bindBarreSelectionGroupee() {
  document.querySelectorAll('[data-bulk-action]').forEach((btn) => {
    btn.addEventListener('click', () => executerActionGroupee(btn.dataset.bulk, btn.dataset.bulkAction));
  });
}

// Carte compacte d'un média superposé — sous-ensemble volontairement plus
// léger des réglages complets du calque principal (position/taille/
// rotation, forme, bordure, filtres image, chromakey), suffisant pour
// composer un visuel à plusieurs médias sans dupliquer tout le panneau.
function renderSousMediaHtml(sm, index) {
  return `
    <div class="editor-photo-layer editor-sousmedia">
      <div class="editor-photo-layer-head">
        <input type="text" class="editor-calque-nom" data-smnom-for="${sm.id}" value="${escapeHtml(sm.nom || '')}" placeholder="Média ${index + 1}" title="Renommer">
        <div class="editor-calque-head-actions">
          <button type="button" class="editor-icon-btn ${sm.visible === false ? 'active' : ''}" data-smvisible-for="${sm.id}" title="${sm.visible === false ? 'Afficher' : 'Masquer'}">${sm.visible === false ? '🚫' : '👁'}</button>
          <button type="button" class="editor-icon-btn" data-smduplique-for="${sm.id}" title="Dupliquer">⧉</button>
          <button type="button" class="editor-remove-btn" data-smsupprimer-for="${sm.id}" title="Supprimer">&times;</button>
        </div>
      </div>
      ${markupFilePickerPhoto(`editor-sm-input-${sm.id}`, `editor-sm-filename-${sm.id}`, sm.img)}
      <div class="editor-row">
        <label class="editor-mini-label">X<input type="range" data-smx-for="${sm.id}" min="0" max="100" value="${Math.round((sm.x ?? 0.5) * 100)}"></label>
        <label class="editor-mini-label">Y<input type="range" data-smy-for="${sm.id}" min="0" max="100" value="${Math.round((sm.y ?? 0.5) * 100)}"></label>
        <label class="editor-mini-label">Taille<input type="range" data-smscale-for="${sm.id}" min="5" max="80" value="${Math.round((sm.scale ?? 0.22) * 100)}"></label>
      </div>
      ${renderReglagesAvancesPhotoHtml(sm)}
    </div>
  `;
}

function renderPhotoLayerHtml(p, index) {
  return `
    <div class="editor-photo-layer ${p.verrouille ? 'verrouille' : ''}" draggable="${!p.verrouille}" data-photo-drag="${p.id}">
      ${renderCalqueHeadHtml(p, `Photo/Vidéo ${index + 1}`, 'photo')}
      <span class="editor-mini-heading">Média principal (réglages ci-dessous et dans les sections pliables)</span>
      ${markupFilePickerPhoto(`editor-photo-input-${p.id}`, `editor-photo-filename-${p.id}`, p.img)}
      <textarea class="editor-photo-caption" data-caption-for="${p.id}" rows="2" placeholder="Texte lié à cette photo...">${p.texte || ''}</textarea>
      <div class="editor-row">
        <label class="editor-mini-label">Taille<input type="range" data-scale-for="${p.id}" min="5" max="80" value="${Math.round(p.scale * 100)}"></label>
        <label class="editor-mini-label">Durée (s)<input type="number" data-duree-for="${p.id}" min="0.5" max="30" step="0.5" value="${p.duree}" style="max-width:80px;"></label>
      </div>

      <details class="editor-accordion-nested" ${(p.sousMedias && p.sousMedias.length) ? 'open' : ''}>
        <summary>Médias superposés (même visuel)${p.sousMedias && p.sousMedias.length ? ` — ${p.sousMedias.length}` : ''}</summary>
        <div class="editor-accordion-nested-body">
          <span class="form-hint">Ctrl+clic sur plusieurs fichiers ci-dessus pour en ajouter d'un coup. Chacun s'affiche EN MÊME TEMPS que le média principal, avec sa propre position/taille/réglages (ex : incruster une capture d'écran sur une illustration).</span>
          <div class="editor-row" style="justify-content:flex-end;">
            <label class="editor-file-picker editor-file-picker-mini" for="editor-sousmedia-add-input-${p.id}">+ Ajouter un média superposé</label>
            <input type="file" id="editor-sousmedia-add-input-${p.id}" accept="image/png,image/jpeg,video/mp4" class="editor-file-input" multiple>
          </div>
          <div class="editor-sousmedias-liste">
            ${(p.sousMedias || []).map((sm, i) => renderSousMediaHtml(sm, i)).join('') || '<p class="form-hint">Aucun média superposé.</p>'}
          </div>
        </div>
      </details>

      ${renderReglagesAvancesPhotoHtml(p)}

      <details class="editor-accordion-nested">
        <summary>Fond de cette photo</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <select data-bgoverride-for="${p.id}">
              <option value="none" ${(!p.bgOverrideType || p.bgOverrideType === 'none') ? 'selected' : ''}>Fond global</option>
              <option value="video" ${p.bgOverrideType === 'video' ? 'selected' : ''}>Vidéo propre à cette photo</option>
              <option value="image" ${p.bgOverrideType === 'image' ? 'selected' : ''}>Image propre à cette photo</option>
              <option value="color" ${p.bgOverrideType === 'color' ? 'selected' : ''}>Couleur unie</option>
            </select>
          </div>
          <div class="editor-row">
            <input type="file" data-bgoverridefile-for="${p.id}" accept="video/mp4,image/png,image/jpeg" class="editor-file-input" id="editor-bgoverride-file-${p.id}">
            <label class="editor-file-picker" for="editor-bgoverride-file-${p.id}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
              <span>Choisir un fichier</span>
            </label>
            <input type="color" data-bgoverridecolor-for="${p.id}" value="${p.bgOverrideColor || '#12151c'}">
          </div>
        </div>
      </details>
    </div>
  `;
}

// Réglages avancés partagés par un calque photo principal ET ses médias
// superposés (même moteur de rendu, mettreAJourPhoto() lit les mêmes champs
// quel que soit l'appelant) — extrait une fois pour éviter que les deux
// panneaux ne divergent en fonctionnalités.
function renderReglagesAvancesPhotoHtml(p) {
  return `
      <details class="editor-accordion-nested">
        <summary>Forme &amp; bordure</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <select data-shape-for="${p.id}">
              <option value="rect" ${(!p.maskShape || p.maskShape === 'rect') ? 'selected' : ''}>Rectangle arrondi</option>
              <option value="circle" ${p.maskShape === 'circle' ? 'selected' : ''}>Cercle / ellipse</option>
              <option value="hexagon" ${p.maskShape === 'hexagon' ? 'selected' : ''}>Hexagone</option>
              <option value="pentagon" ${p.maskShape === 'pentagon' ? 'selected' : ''}>Pentagone</option>
              <option value="star" ${p.maskShape === 'star' ? 'selected' : ''}>Étoile</option>
              <option value="heart" ${p.maskShape === 'heart' ? 'selected' : ''}>Cœur</option>
            </select>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-border-for="${p.id}" ${p.borderActive !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Bordure</span></label>
            <input type="color" data-bordercolor-for="${p.id}" value="${p.borderColor || '#ffffff'}" title="Couleur de la bordure">
            <label class="editor-mini-label">Épaisseur<input type="range" data-borderwidth-for="${p.id}" min="1" max="15" value="${p.borderWidth ?? 3}"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Ombre &amp; lueur</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-shadow-for="${p.id}" ${p.shadowActive !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Ombre portée</span></label>
            <input type="color" data-shadowcolor-for="${p.id}" value="${p.shadowColor || '#000000'}" title="Couleur de l'ombre">
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Opacité<input type="range" data-shadowopacity-for="${p.id}" min="0" max="100" value="${Math.round((p.shadowOpacity ?? 0.55) * 100)}"></label>
            <label class="editor-mini-label">Flou<input type="range" data-shadowblur-for="${p.id}" min="0" max="30" value="${Math.round((p.shadowBlur ?? 0.14) * 100)}"></label>
            <label class="editor-mini-label">Décalage<input type="range" data-shadowoffset-for="${p.id}" min="0" max="20" value="${Math.round((p.shadowOffsetY ?? 0.08) * 100)}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-glow-for="${p.id}" ${p.glowActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Lueur externe (glow)</span></label>
            <input type="color" data-glowcolor-for="${p.id}" value="${p.glowColor || '#00e5ff'}" title="Couleur de la lueur">
            <label class="editor-mini-label">Intensité<input type="range" data-glowstrength-for="${p.id}" min="10" max="100" value="${Math.round((p.glowStrength ?? 0.5) * 100)}"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Filtres image</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-mini-label">Luminosité<input type="range" data-brightness-for="${p.id}" min="40" max="180" value="${p.imgBrightness ?? 100}"></label>
            <label class="editor-mini-label">Contraste<input type="range" data-contrast-for="${p.id}" min="40" max="180" value="${p.imgContrast ?? 100}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Saturation<input type="range" data-saturation-for="${p.id}" min="0" max="200" value="${p.imgSaturation ?? 100}"></label>
            <label class="editor-mini-label">Flou<input type="range" data-blur-for="${p.id}" min="0" max="10" value="${p.imgBlur ?? 0}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-grayscale-for="${p.id}" ${p.imgGrayscale ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Noir &amp; blanc</span></label>
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-sepia-for="${p.id}" ${p.imgSepia ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Sépia</span></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-vignette-for="${p.id}" ${p.vignette ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Vignette</span></label>
            <label class="editor-mini-label">Intensité<input type="range" data-vignettestrength-for="${p.id}" min="10" max="100" value="${Math.round((p.vignetteStrength ?? 0.5) * 100)}"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Clé chromatique (fond vert)</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-chromakey-for="${p.id}" ${p.chromaKeyActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Activer</span></label>
            <input type="color" data-chromakeycolor-for="${p.id}" value="${p.chromaKeyColor || '#00ff00'}" title="Couleur à retirer">
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Tolérance<input type="range" data-chromakeytolerance-for="${p.id}" min="5" max="80" value="${Math.round((p.chromaKeyTolerance ?? 0.35) * 100)}"></label>
          </div>
          <span class="form-hint">Rend transparente la couleur choisie (fond vert/bleu) sur cette photo ou vidéo.</span>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Recadrage</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-mini-label">Haut<input type="range" data-cropy-for="${p.id}" min="0" max="80" value="${Math.round((p.cropY ?? 0) * 100)}"></label>
            <label class="editor-mini-label">Gauche<input type="range" data-cropx-for="${p.id}" min="0" max="80" value="${Math.round((p.cropX ?? 0) * 100)}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Largeur<input type="range" data-cropw-for="${p.id}" min="20" max="100" value="${Math.round((p.cropW ?? 1) * 100)}"></label>
            <label class="editor-mini-label">Hauteur<input type="range" data-croph-for="${p.id}" min="20" max="100" value="${Math.round((p.cropH ?? 1) * 100)}"></label>
          </div>
          <div class="editor-row">
            <button type="button" class="editor-add-btn" data-cropvisuel-toggle-for="${p.id}">Recadrer visuellement</button>
          </div>
          <div class="editor-crop-editor hidden" id="editor-crop-editor-${p.id}">
            <div class="editor-crop-editor-stage" id="editor-crop-editor-stage-${p.id}">
              <img class="editor-crop-editor-img" id="editor-crop-editor-img-${p.id}" alt="" draggable="false">
              <div class="editor-crop-rect" data-cropvisuel-rect-for="${p.id}">
                <div class="editor-crop-handle" data-handle="se"></div>
              </div>
            </div>
            <span class="form-hint">Glissez le cadre pour déplacer le recadrage, son coin bas-droit pour le redimensionner. Disponible pour les images (pas les vidéos).</span>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-cropratiolock-for="${p.id}" ${p.cropRatioVerrouille ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Verrouiller le ratio largeur/hauteur</span></label>
          </div>
          <span class="form-hint">Haut/Gauche déplacent le point de départ du recadrage, Largeur/Hauteur ajustent la zone gardée de l'image originale. Le verrou garde les proportions actuelles quand vous ajustez l'un des deux curseurs.</span>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Rotation 3D</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-mini-label">Rotation X<input type="range" data-rotx-for="${p.id}" min="-45" max="45" value="${p.rotX || 0}"></label>
            <label class="editor-mini-label">Rotation Y<input type="range" data-roty-for="${p.id}" min="-45" max="45" value="${p.rotY || 0}"></label>
            <label class="editor-mini-label">Rotation Z<input type="range" data-rotz-for="${p.id}" min="-45" max="45" value="${p.rotZ || 0}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-float-for="${p.id}" ${p.floatActive !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Flottement automatique</span></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Contour énergétique &amp; particules</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-saber-for="${p.id}" ${p.saberActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Contour énergétique</span></label>
            <input type="color" data-sabercolor-for="${p.id}" value="${p.saberColor || '#00e5ff'}" title="Couleur de l'effet">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-particles-for="${p.id}" ${p.particlesActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Particules</span></label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Quantité<input type="range" data-sabercount-for="${p.id}" min="6" max="120" value="${p.saberCount ?? 26}"></label>
            <label class="editor-mini-label">Taille<input type="range" data-sabersize-for="${p.id}" min="30" max="300" value="${Math.round((p.saberSize ?? 1) * 100)}"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Spectre audio</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-spectrum-for="${p.id}" ${p.spectrumActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Activer (musique de fond)</span></label>
            <input type="color" data-spectrumcolor-for="${p.id}" value="${p.spectrumColor || '#ff2d95'}" title="Couleur du spectre">
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Quantité<input type="range" data-spectrumcount-for="${p.id}" min="8" max="600" value="${p.spectrumCount ?? 48}"></label>
            <label class="editor-mini-label">Taille<input type="range" data-spectrumsize-for="${p.id}" min="30" max="300" value="${Math.round((p.spectrumSize ?? 1) * 100)}"></label>
          </div>
        </div>
      </details>
  `;
}

// Presse-papiers de style : copie tous les champs d'un calque SAUF son
// contenu/sa position propres (image, texte, coordonnées, durée, nom,
// verrou...) — tout le reste (filtres, forme, bordure, effets...) est
// considéré comme "du style" réutilisable sur un autre calque du même type.
let StyleClipboard = null;
const CHAMPS_STYLE_EXCLUS = {
  photo: [
    'id', 'img', 'texte', 'x', 'y', 'z', 'texteX', 'texteY', 'duree', 'nom',
    'verrouille', 'visible', 'bgOverrideType', 'bgOverrideVideoEl',
    'bgOverrideImageEl', 'bgOverrideColor', 'sousMedias',
  ],
  textblock: ['id', 'texte', 'x', 'y', 'z', 'nom', 'verrouille', 'visible', 'startTime', 'endTime'],
  forme: ['id', 'emoji', 'x', 'y', 'z', 'nom', 'verrouille', 'visible', 'startTime', 'endTime'],
};

function copierStyleCalque(type, item) {
  const exclus = CHAMPS_STYLE_EXCLUS[type];
  const style = {};
  for (const cle of Object.keys(item)) {
    if (!exclus.includes(cle)) style[cle] = cloneProfondSansDom(item[cle]);
  }
  StyleClipboard = { type, style };
  toast('Style du calque copié.', 'success');
}

function collerStyleCalque(type, item) {
  if (!StyleClipboard || StyleClipboard.type !== type) {
    toast("Copiez d'abord le style d'un calque du même type.", 'error');
    return;
  }
  Object.assign(item, cloneProfondSansDom(StyleClipboard.style));
  (type === 'photo' ? rafraichirListePhotos : rafraichirListeTextBlocks)();
  pousserHistorique();
  toast('Style collé.', 'success');
}

// Boutons communs de l'en-tête d'un calque (sélection, renommer, verrouiller,
// masquer, copier/coller le style, dupliquer) — `rafraichirFn` reconstruit
// la liste (pour mettre à jour les icônes), `dupliquerFn` clone le calque
// juste après lui, `type` ('photo'|'textblock') sert de clé pour la
// sélection groupée et le presse-papiers de style.
function bindCalqueHeadEvents(item, rafraichirFn, dupliquerFn, type) {
  const selCheckbox = document.querySelector(`[data-calquesel-for="${item.id}"]`);
  if (selCheckbox) {
    selCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) SelectionCalques[type].add(item.id);
      else SelectionCalques[type].delete(item.id);
      majBarreSelectionGroupee(type);
    });
  }
  const copyStyleBtn = document.querySelector(`[data-calquecopystyle-for="${item.id}"]`);
  if (copyStyleBtn) copyStyleBtn.addEventListener('click', () => copierStyleCalque(type, item));
  const pasteStyleBtn = document.querySelector(`[data-calquepastestyle-for="${item.id}"]`);
  if (pasteStyleBtn) pasteStyleBtn.addEventListener('click', () => collerStyleCalque(type, item));
  const nomInput = document.querySelector(`[data-calquenom-for="${item.id}"]`);
  if (nomInput) {
    // Pas de pousserHistorique() ici : l'écouteur délégué sur .editor-controls
    // (bindAccordionUx) capture déjà tout événement "change" du panneau.
    nomInput.addEventListener('change', (e) => {
      item.nom = e.target.value.trim() || null;
    });
  }
  const lockBtn = document.querySelector(`[data-calquelock-for="${item.id}"]`);
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      item.verrouille = !item.verrouille;
      rafraichirFn();
      pousserHistorique();
    });
  }
  const visibleBtn = document.querySelector(`[data-calquevisible-for="${item.id}"]`);
  if (visibleBtn) {
    visibleBtn.addEventListener('click', () => {
      item.visible = item.visible === false ? true : false;
      rafraichirFn();
      pousserHistorique();
    });
  }
  const dupliqueBtn = document.querySelector(`[data-calqueduplique-for="${item.id}"]`);
  if (dupliqueBtn) dupliqueBtn.addEventListener('click', () => dupliquerFn(item.id));
}

// Recadrage visuel : positionne le cadre de sélection (en %) d'après
// cropX/Y/W/H, et resynchronise les curseurs Haut/Gauche/Largeur/Hauteur
// pour qu'ils restent cohérents avec une manipulation à la souris.
function positionnerRectCrop(p) {
  const rect = document.querySelector(`[data-cropvisuel-rect-for="${p.id}"]`);
  if (!rect) return;
  rect.style.left = `${(p.cropX ?? 0) * 100}%`;
  rect.style.top = `${(p.cropY ?? 0) * 100}%`;
  rect.style.width = `${(p.cropW ?? 1) * 100}%`;
  rect.style.height = `${(p.cropH ?? 1) * 100}%`;
}

function synchroniserCropSliders(p) {
  const setVal = (selecteur, valeur) => {
    const el = document.querySelector(selecteur);
    if (el) el.value = Math.round(valeur * 100);
  };
  setVal(`[data-cropx-for="${p.id}"]`, p.cropX ?? 0);
  setVal(`[data-cropy-for="${p.id}"]`, p.cropY ?? 0);
  setVal(`[data-cropw-for="${p.id}"]`, p.cropW ?? 1);
  setVal(`[data-croph-for="${p.id}"]`, p.cropH ?? 1);
}

// Glisser-déposer du recadrage directement sur l'image source : le cadre se
// déplace (ancré en haut-gauche, comme les curseurs existants) et se
// redimensionne depuis son coin bas-droit, en respectant le verrou de ratio
// s'il est actif.
function bindCropVisuel(p) {
  const stage = document.getElementById(`editor-crop-editor-stage-${p.id}`);
  const rect = document.querySelector(`[data-cropvisuel-rect-for="${p.id}"]`);
  if (!stage || !rect) return;

  const appliquer = (cropX, cropY, cropW, cropH) => {
    const minTaille = 0.1;
    cropW = Math.max(minTaille, Math.min(1, cropW));
    cropH = Math.max(minTaille, Math.min(1, cropH));
    cropX = Math.max(0, Math.min(1 - cropW, cropX));
    cropY = Math.max(0, Math.min(1 - cropH, cropY));
    p.cropX = cropX;
    p.cropY = cropY;
    p.cropW = cropW;
    p.cropH = cropH;
    positionnerRectCrop(p);
    synchroniserCropSliders(p);
  };

  let action = null;
  const demarrer = (type) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    action = {
      type,
      startClientX: e.clientX,
      startClientY: e.clientY,
      depart: { cropX: p.cropX ?? 0, cropY: p.cropY ?? 0, cropW: p.cropW ?? 1, cropH: p.cropH ?? 1 },
    };
    stage.setPointerCapture(e.pointerId);
  };

  rect.addEventListener('pointerdown', demarrer('move'));
  const poignee = rect.querySelector('[data-handle="se"]');
  if (poignee) poignee.addEventListener('pointerdown', demarrer('resize'));

  stage.addEventListener('pointermove', (e) => {
    if (!action) return;
    const stageRect = stage.getBoundingClientRect();
    const dx = (e.clientX - action.startClientX) / stageRect.width;
    const dy = (e.clientY - action.startClientY) / stageRect.height;
    const d = action.depart;
    if (action.type === 'move') {
      appliquer(d.cropX + dx, d.cropY + dy, d.cropW, d.cropH);
    } else {
      const ratio = d.cropH > 0 ? d.cropW / d.cropH : 1;
      const cropW = d.cropW + dx;
      const cropH = p.cropRatioVerrouille ? cropW / ratio : d.cropH + dy;
      appliquer(d.cropX, d.cropY, cropW, cropH);
    }
  });

  ['pointerup', 'pointercancel'].forEach((evtName) => {
    stage.addEventListener(evtName, () => {
      if (action) pousserHistorique();
      action = null;
    });
  });
}

// Câble les contrôles de chaque média superposé d'un calque photo `p`.
// Contrairement aux calques principaux, ces objets ne vivent que dans
// `p.sousMedias` : pas de jump()/timeline, pas d'entrée séparée dans
// SelectionCalques (la sélection groupée reste au niveau des calques
// principaux).
function bindSousMediaEvents(p) {
  const jumpVersParent = () => allerAuSegment((s) => s.type === 'photo' && s.data.id === p.id);
  (p.sousMedias || []).forEach((sm) => {
    const nomInput = document.querySelector(`[data-smnom-for="${sm.id}"]`);
    if (nomInput) nomInput.addEventListener('change', (e) => (sm.nom = e.target.value.trim() || null));

    const visibleBtn = document.querySelector(`[data-smvisible-for="${sm.id}"]`);
    if (visibleBtn) {
      visibleBtn.addEventListener('click', () => {
        sm.visible = sm.visible === false ? true : false;
        rafraichirListePhotos();
        pousserHistorique();
      });
    }
    const dupliqueBtn = document.querySelector(`[data-smduplique-for="${sm.id}"]`);
    if (dupliqueBtn) dupliqueBtn.addEventListener('click', () => dupliquerSousMedia(p, sm.id));
    const supprimerBtn = document.querySelector(`[data-smsupprimer-for="${sm.id}"]`);
    if (supprimerBtn) supprimerBtn.addEventListener('click', () => supprimerSousMedia(p, sm.id));

    const fileInput = document.getElementById(`editor-sm-input-${sm.id}`);
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        afficherNomFichier(`editor-sm-filename-${sm.id}`, file);
        sm.img = await chargerMediaPhoto(file);
      });
    }
    const xInput = document.querySelector(`[data-smx-for="${sm.id}"]`);
    if (xInput) xInput.addEventListener('input', (e) => (sm.x = Number(e.target.value) / 100));
    const yInput = document.querySelector(`[data-smy-for="${sm.id}"]`);
    if (yInput) yInput.addEventListener('input', (e) => (sm.y = Number(e.target.value) / 100));
    const scaleInput = document.querySelector(`[data-smscale-for="${sm.id}"]`);
    if (scaleInput) scaleInput.addEventListener('input', (e) => (sm.scale = Number(e.target.value) / 100));

    // Même jeu complet de réglages (forme, filtres, ombre/glow, chromakey,
    // recadrage, rotation 3D, effets énergétiques/particules, spectre) que
    // le média principal — voir renderReglagesAvancesPhotoHtml.
    bindReglagesAvancesPhotoEvents(sm, jumpVersParent);
  });
}

// Câble les réglages avancés partagés (voir renderReglagesAvancesPhotoHtml)
// — utilisé aussi bien pour le calque photo principal que pour chacun de
// ses médias superposés, `jump` recentre la timeline sur le bon segment
// dans les deux cas (le segment du calque principal).
function bindReglagesAvancesPhotoEvents(p, jump) {
  ['rotx', 'roty', 'rotz'].forEach((axe, i) => {
    const input = document.querySelector(`[data-${axe}-for="${p.id}"]`);
    if (!input) return;
    const champ = ['rotX', 'rotY', 'rotZ'][i];
    input.addEventListener('input', (e) => {
      p[champ] = Number(e.target.value);
      jump();
    });
  });
  const floatInput = document.querySelector(`[data-float-for="${p.id}"]`);
  if (floatInput) {
    floatInput.addEventListener('change', (e) => {
      p.floatActive = e.target.checked;
    });
  }
  const saberInput = document.querySelector(`[data-saber-for="${p.id}"]`);
  if (saberInput) {
    saberInput.addEventListener('change', (e) => {
      p.saberActive = e.target.checked;
      jump();
    });
  }
  const saberColorInput = document.querySelector(`[data-sabercolor-for="${p.id}"]`);
  if (saberColorInput) {
    saberColorInput.addEventListener('input', (e) => {
      p.saberColor = e.target.value;
    });
  }
  const particlesInput = document.querySelector(`[data-particles-for="${p.id}"]`);
  if (particlesInput) {
    particlesInput.addEventListener('change', (e) => {
      p.particlesActive = e.target.checked;
      jump();
    });
  }
  const spectrumInput = document.querySelector(`[data-spectrum-for="${p.id}"]`);
  if (spectrumInput) {
    spectrumInput.addEventListener('change', (e) => {
      if (e.target.checked && !EditorState.audioEl) {
        toast('Importez une musique de fond pour activer le spectre audio.', 'error');
        e.target.checked = false;
        return;
      }
      p.spectrumActive = e.target.checked;
      jump();
    });
  }
  const spectrumColorInput = document.querySelector(`[data-spectrumcolor-for="${p.id}"]`);
  if (spectrumColorInput) {
    spectrumColorInput.addEventListener('input', (e) => {
      p.spectrumColor = e.target.value;
    });
  }
  const saberCountInput = document.querySelector(`[data-sabercount-for="${p.id}"]`);
  if (saberCountInput) {
    saberCountInput.addEventListener('input', (e) => {
      p.saberCount = Number(e.target.value);
    });
  }
  const saberSizeInput = document.querySelector(`[data-sabersize-for="${p.id}"]`);
  if (saberSizeInput) {
    saberSizeInput.addEventListener('input', (e) => {
      p.saberSize = Number(e.target.value) / 100;
    });
  }
  const spectrumCountInput = document.querySelector(`[data-spectrumcount-for="${p.id}"]`);
  if (spectrumCountInput) {
    spectrumCountInput.addEventListener('input', (e) => {
      p.spectrumCount = Number(e.target.value);
    });
  }
  const spectrumSizeInput = document.querySelector(`[data-spectrumsize-for="${p.id}"]`);
  if (spectrumSizeInput) {
    spectrumSizeInput.addEventListener('input', (e) => {
      p.spectrumSize = Number(e.target.value) / 100;
      jump();
    });
  }
  const shapeInput = document.querySelector(`[data-shape-for="${p.id}"]`);
  if (shapeInput) shapeInput.addEventListener('change', (e) => (p.maskShape = e.target.value));

  const borderInput = document.querySelector(`[data-border-for="${p.id}"]`);
  if (borderInput) borderInput.addEventListener('change', (e) => (p.borderActive = e.target.checked));
  const borderColorInput = document.querySelector(`[data-bordercolor-for="${p.id}"]`);
  if (borderColorInput) borderColorInput.addEventListener('input', (e) => (p.borderColor = e.target.value));
  const borderWidthInput = document.querySelector(`[data-borderwidth-for="${p.id}"]`);
  if (borderWidthInput) borderWidthInput.addEventListener('input', (e) => (p.borderWidth = Number(e.target.value)));

  const shadowInput = document.querySelector(`[data-shadow-for="${p.id}"]`);
  if (shadowInput) shadowInput.addEventListener('change', (e) => (p.shadowActive = e.target.checked));
  const shadowColorInput = document.querySelector(`[data-shadowcolor-for="${p.id}"]`);
  if (shadowColorInput) shadowColorInput.addEventListener('input', (e) => (p.shadowColor = e.target.value));
  const shadowOpacityInput = document.querySelector(`[data-shadowopacity-for="${p.id}"]`);
  if (shadowOpacityInput) shadowOpacityInput.addEventListener('input', (e) => (p.shadowOpacity = Number(e.target.value) / 100));
  const shadowBlurInput = document.querySelector(`[data-shadowblur-for="${p.id}"]`);
  if (shadowBlurInput) shadowBlurInput.addEventListener('input', (e) => (p.shadowBlur = Number(e.target.value) / 100));
  const shadowOffsetInput = document.querySelector(`[data-shadowoffset-for="${p.id}"]`);
  if (shadowOffsetInput) shadowOffsetInput.addEventListener('input', (e) => (p.shadowOffsetY = Number(e.target.value) / 100));

  const glowInput = document.querySelector(`[data-glow-for="${p.id}"]`);
  if (glowInput) glowInput.addEventListener('change', (e) => (p.glowActive = e.target.checked));
  const glowColorInput = document.querySelector(`[data-glowcolor-for="${p.id}"]`);
  if (glowColorInput) glowColorInput.addEventListener('input', (e) => (p.glowColor = e.target.value));
  const glowStrengthInput = document.querySelector(`[data-glowstrength-for="${p.id}"]`);
  if (glowStrengthInput) glowStrengthInput.addEventListener('input', (e) => (p.glowStrength = Number(e.target.value) / 100));

  const brightnessInput = document.querySelector(`[data-brightness-for="${p.id}"]`);
  if (brightnessInput) brightnessInput.addEventListener('input', (e) => (p.imgBrightness = Number(e.target.value)));
  const contrastInput = document.querySelector(`[data-contrast-for="${p.id}"]`);
  if (contrastInput) contrastInput.addEventListener('input', (e) => (p.imgContrast = Number(e.target.value)));
  const saturationInput = document.querySelector(`[data-saturation-for="${p.id}"]`);
  if (saturationInput) saturationInput.addEventListener('input', (e) => (p.imgSaturation = Number(e.target.value)));
  const blurInput = document.querySelector(`[data-blur-for="${p.id}"]`);
  if (blurInput) blurInput.addEventListener('input', (e) => (p.imgBlur = Number(e.target.value)));
  const grayscaleInput = document.querySelector(`[data-grayscale-for="${p.id}"]`);
  if (grayscaleInput) grayscaleInput.addEventListener('change', (e) => (p.imgGrayscale = e.target.checked));
  const sepiaInput = document.querySelector(`[data-sepia-for="${p.id}"]`);
  if (sepiaInput) sepiaInput.addEventListener('change', (e) => (p.imgSepia = e.target.checked));
  const vignetteInput = document.querySelector(`[data-vignette-for="${p.id}"]`);
  if (vignetteInput) vignetteInput.addEventListener('change', (e) => (p.vignette = e.target.checked));
  const vignetteStrengthInput = document.querySelector(`[data-vignettestrength-for="${p.id}"]`);
  if (vignetteStrengthInput) {
    vignetteStrengthInput.addEventListener('input', (e) => (p.vignetteStrength = Number(e.target.value) / 100));
  }

  const chromaKeyInput = document.querySelector(`[data-chromakey-for="${p.id}"]`);
  if (chromaKeyInput) chromaKeyInput.addEventListener('change', (e) => (p.chromaKeyActive = e.target.checked));
  const chromaKeyColorInput = document.querySelector(`[data-chromakeycolor-for="${p.id}"]`);
  if (chromaKeyColorInput) chromaKeyColorInput.addEventListener('input', (e) => (p.chromaKeyColor = e.target.value));
  const chromaKeyToleranceInput = document.querySelector(`[data-chromakeytolerance-for="${p.id}"]`);
  if (chromaKeyToleranceInput) {
    chromaKeyToleranceInput.addEventListener('input', (e) => (p.chromaKeyTolerance = Number(e.target.value) / 100));
  }

  const cropXInput = document.querySelector(`[data-cropx-for="${p.id}"]`);
  if (cropXInput) cropXInput.addEventListener('input', (e) => (p.cropX = Number(e.target.value) / 100));
  const cropYInput = document.querySelector(`[data-cropy-for="${p.id}"]`);
  if (cropYInput) cropYInput.addEventListener('input', (e) => (p.cropY = Number(e.target.value) / 100));
  const cropWInput = document.querySelector(`[data-cropw-for="${p.id}"]`);
  const cropHInput = document.querySelector(`[data-croph-for="${p.id}"]`);
  if (cropWInput) {
    cropWInput.addEventListener('input', (e) => {
      const ratio = p.cropH > 0 ? p.cropW / p.cropH : 1;
      p.cropW = Number(e.target.value) / 100;
      if (p.cropRatioVerrouille) {
        p.cropH = Math.min(1, Math.max(0.2, p.cropW / ratio));
        if (cropHInput) cropHInput.value = Math.round(p.cropH * 100);
      }
    });
  }
  if (cropHInput) {
    cropHInput.addEventListener('input', (e) => {
      const ratio = p.cropH > 0 ? p.cropW / p.cropH : 1;
      p.cropH = Number(e.target.value) / 100;
      if (p.cropRatioVerrouille) {
        p.cropW = Math.min(1, Math.max(0.2, p.cropH * ratio));
        if (cropWInput) cropWInput.value = Math.round(p.cropW * 100);
      }
    });
  }
  const cropRatioLockInput = document.querySelector(`[data-cropratiolock-for="${p.id}"]`);
  if (cropRatioLockInput) cropRatioLockInput.addEventListener('change', (e) => (p.cropRatioVerrouille = e.target.checked));

  const cropVisuelToggle = document.querySelector(`[data-cropvisuel-toggle-for="${p.id}"]`);
  const cropEditor = document.getElementById(`editor-crop-editor-${p.id}`);
  if (cropVisuelToggle && cropEditor) {
    cropVisuelToggle.addEventListener('click', () => {
      if (!p.img || p.img.tagName === 'VIDEO') {
        toast('Le recadrage visuel est disponible pour les images (pas les vidéos).', 'error');
        return;
      }
      const seraOuvert = cropEditor.classList.contains('hidden');
      cropEditor.classList.toggle('hidden', !seraOuvert);
      if (seraOuvert) {
        const imgEl = document.getElementById(`editor-crop-editor-img-${p.id}`);
        if (imgEl) imgEl.src = p.img.src;
        positionnerRectCrop(p);
      }
    });
    bindCropVisuel(p);
  }
}

function bindPhotoLayerEvents() {
  EditorState.photos.forEach((p) => {
    const jump = () => allerAuSegment((s) => s.type === 'photo' && s.data.id === p.id);
    bindCalqueHeadEvents(p, rafraichirListePhotos, dupliquerCalquePhoto, 'photo');

    const fileInput = document.getElementById(`editor-photo-input-${p.id}`);
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const fichiers = Array.from(e.target.files || []);
        if (!fichiers.length) return;
        const [premier, ...autres] = fichiers;
        afficherNomFichier(`editor-photo-filename-${p.id}`, premier);
        p.img = await chargerMediaPhoto(premier);
        jump();

        // Sélection multiple : le premier fichier remplace le média
        // principal, chaque fichier supplémentaire devient un média
        // superposé sur CE MÊME visuel (composite simultané, pas une
        // nouvelle diapositive) — chacun avec ses propres réglages complets.
        if (autres.length) {
          await ajouterSousMedias(p, autres);
          rafraichirListePhotos();
          pousserHistorique();
          toast(`${autres.length} média(s) superposé(s) ajouté(s) sur ce visuel.`, 'success');
        }
      });
    }
    const sousMediaAddInput = document.getElementById(`editor-sousmedia-add-input-${p.id}`);
    if (sousMediaAddInput) {
      sousMediaAddInput.addEventListener('change', async (e) => {
        const fichiers = Array.from(e.target.files || []);
        if (!fichiers.length) return;
        await ajouterSousMedias(p, fichiers);
        rafraichirListePhotos();
        pousserHistorique();
        toast(`${fichiers.length} média(s) superposé(s) ajouté(s).`, 'success');
        e.target.value = '';
      });
    }
    bindSousMediaEvents(p);
    const captionInput = document.querySelector(`[data-caption-for="${p.id}"]`);
    if (captionInput) {
      captionInput.addEventListener('input', (e) => {
        p.texte = e.target.value;
      });
      captionInput.addEventListener('focus', jump);
    }
    const scaleInput = document.querySelector(`[data-scale-for="${p.id}"]`);
    if (scaleInput) {
      scaleInput.addEventListener('input', (e) => {
        p.scale = Number(e.target.value) / 100;
        jump();
      });
    }
    const dureeInput = document.querySelector(`[data-duree-for="${p.id}"]`);
    if (dureeInput) {
      dureeInput.addEventListener('input', (e) => {
        p.duree = Math.max(0.5, Number(e.target.value) || 3);
      });
    }
    bindReglagesAvancesPhotoEvents(p, jump);

    const bgOverrideSelect = document.querySelector(`[data-bgoverride-for="${p.id}"]`);
    if (bgOverrideSelect) {
      bgOverrideSelect.addEventListener('change', (e) => {
        p.bgOverrideType = e.target.value;
        jump();
      });
    }
    const bgOverrideFile = document.querySelector(`[data-bgoverridefile-for="${p.id}"]`);
    if (bgOverrideFile) {
      bgOverrideFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.type.startsWith('video/')) {
          const video = document.createElement('video');
          video.src = URL.createObjectURL(file);
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.crossOrigin = 'anonymous';
          try {
            await video.play();
          } catch (_) {}
          p.bgOverrideVideoEl = video;
          p.bgOverrideType = 'video';
        } else {
          p.bgOverrideImageEl = await chargerImage(file);
          p.bgOverrideType = 'image';
        }
        if (bgOverrideSelect) bgOverrideSelect.value = p.bgOverrideType;
        jump();
      });
    }
    const bgOverrideColor = document.querySelector(`[data-bgoverridecolor-for="${p.id}"]`);
    if (bgOverrideColor) {
      bgOverrideColor.addEventListener('input', (e) => {
        p.bgOverrideColor = e.target.value;
      });
    }
  });
  document.querySelectorAll('[data-remove-photo]').forEach((btn) => {
    btn.addEventListener('click', () => supprimerCalquePhoto(Number(btn.dataset.removePhoto)));
  });
  bindPhotoDragReorder();
}

// Réordonnancement des photos par glisser-déposer dans la liste (affecte
// l'ordre réel dans EditorState.photos, donc l'ordre de la timeline).
function bindPhotoDragReorder() {
  const container = document.getElementById('editor-photos-list');
  if (!container) return;
  let dragId = null;

  container.querySelectorAll('[data-photo-drag]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragId = Number(el.dataset.photoDrag);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = Number(el.dataset.photoDrag);
      if (dragId == null || targetId === dragId) return;
      const fromIdx = EditorState.photos.findIndex((p) => p.id === dragId);
      const toIdx = EditorState.photos.findIndex((p) => p.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = EditorState.photos.splice(fromIdx, 1);
      EditorState.photos.splice(toIdx, 0, moved);
      rafraichirListePhotos();
    });
  });
}

// Ajoute des médias superposés (composite simultané, même visuel) au
// calque `p` — chacun est un objet "photo" complet (mêmes réglages
// possibles : forme, filtres, ombre, chromakey...) sauf qu'il ne fait pas
// partie de la timeline : il s'affiche en même temps que `p` pendant tout
// son segment. Positionnés en cascade légère pour rester distincts par
// défaut plutôt que de tomber exactement l'un sur l'autre.
async function ajouterSousMedias(p, fichiers) {
  if (!p.sousMedias) p.sousMedias = [];
  for (const file of fichiers) {
    const sm = creerPhotoParDefaut(++elementIdCounter);
    sm.img = await chargerMediaPhoto(file);
    sm.scale = 0.22;
    const decalage = p.sousMedias.length % 4;
    sm.x = 0.72 + (decalage % 2) * 0.06;
    sm.y = 0.72 + Math.floor(decalage / 2) * 0.06;
    p.sousMedias.push(sm);
  }
}

function supprimerSousMedia(p, id) {
  p.sousMedias = (p.sousMedias || []).filter((sm) => sm.id !== id);
  rafraichirListePhotos();
  pousserHistorique();
}

function dupliquerSousMedia(p, id) {
  const original = (p.sousMedias || []).find((sm) => sm.id === id);
  if (!original) return;
  const copie = { ...original, id: ++elementIdCounter, nom: original.nom ? `${original.nom} (copie)` : null };
  p.sousMedias.push(copie);
  rafraichirListePhotos();
  pousserHistorique();
}

function rafraichirListePhotos() {
  const container = document.getElementById('editor-photos-list');
  if (!container) return;
  container.innerHTML =
    EditorState.photos.map((p, i) => renderPhotoLayerHtml(p, i)).join('') ||
    '<p class="form-hint">Aucune photo/vidéo ajoutée pour le moment.</p>';
  bindPhotoLayerEvents();
  purgerSelectionGroupee('photo', EditorState.photos);
}

function creerPhotoParDefaut(id) {
  return {
    id,
    sousMedias: [], // médias superposés : mêmes réglages complets, affichés EN MÊME TEMPS que ce calque (composite)
    nom: null, // null = nom par défaut ("Photo N"), sinon renommé par l'utilisateur
    verrouille: false, // empêche le déplacement sur le canvas et la suppression accidentelle
    visible: true, // false = exclu de la timeline (comme une piste "muette") sans être supprimé
    img: null,
    x: 0.5,
    y: 0.45,
    z: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    floatActive: true,
    scale: 0.3,
    texte: '',
    duree: 3,
    texteX: 0.5,
    texteY: 0.72,
    saberActive: false,
    saberColor: '#00e5ff',
    saberCount: 26,
    saberSize: 1,
    particlesActive: false,
    spectrumActive: false,
    spectrumColor: '#ff2d95',
    spectrumCount: 48,
    spectrumSize: 1,
    maskShape: 'rect',
    borderActive: true,
    borderColor: '#ffffff',
    borderWidth: 3,
    imgBrightness: 100,
    imgContrast: 100,
    imgSaturation: 100,
    imgGrayscale: false,
    imgSepia: false,
    imgBlur: 0,
    vignette: false,
    vignetteStrength: 0.5,
    cropX: 0,
    cropY: 0,
    cropW: 1,
    cropH: 1,
    cropRatioVerrouille: false,
    bgOverrideType: 'none', // 'none' | 'video' | 'image' | 'color'
    bgOverrideVideoEl: null,
    bgOverrideImageEl: null,
    bgOverrideColor: '#12151c',
    chromaKeyActive: false,
    chromaKeyColor: '#00ff00',
    chromaKeyTolerance: 0.35,
    shadowActive: true,
    shadowColor: '#000000',
    shadowOpacity: 0.55,
    shadowBlur: 0.14,
    shadowOffsetY: 0.08,
    glowActive: false,
    glowColor: '#00e5ff',
    glowStrength: 0.5,
  };
}

function ajouterCalquePhoto() {
  const id = ++elementIdCounter;
  EditorState.photos.push(creerPhotoParDefaut(id));
  rafraichirListePhotos();
  allerAuSegment((s) => s.type === 'photo' && s.data.id === id);
  pousserHistorique();
}

function supprimerCalquePhoto(id) {
  const p = EditorState.photos.find((ph) => ph.id === id);
  if (p && p.verrouille) return; // sécurité : le bouton est déjà désactivé, mais on se protège d'un appel programmatique
  EditorState.photos = EditorState.photos.filter((ph) => ph.id !== id);
  rafraichirListePhotos();
  pousserHistorique();
}

function dupliquerCalquePhoto(id) {
  const index = EditorState.photos.findIndex((p) => p.id === id);
  if (index === -1) return;
  const original = EditorState.photos[index];
  const copie = {
    ...original,
    id: ++elementIdCounter,
    nom: original.nom ? `${original.nom} (copie)` : null,
    verrouille: false,
    // Copie profonde des médias superposés (id propres) : un spread simple
    // partagerait le même tableau que l'original, et le modifier sur l'un
    // l'aurait modifié sur l'autre.
    sousMedias: (original.sousMedias || []).map((sm) => ({ ...sm, id: ++elementIdCounter })),
  };
  EditorState.photos.splice(index + 1, 0, copie);
  rafraichirListePhotos();
  pousserHistorique();
}

/* -------------------------------------------------------------------- */
/* Blocs de texte multiples (police, style, animation, fenêtre de temps) */
/* -------------------------------------------------------------------- */
// Presets de style texte : combinaisons de réglages prêtes à l'emploi
// (police, taille, couleur, contour/glow/dégradé...) appliquées d'un coup,
// comme point de départ à ajuster ensuite plutôt qu'à régler un par un.
const PRESETS_STYLE_TEXTE = {
  impact: {
    label: 'Titre impact',
    style: { fontFamily: "'Archivo Black', sans-serif", size: 84, bold: true, italic: false, color: '#ffffff', strokeActive: true, strokeColor: '#000000', strokeWidth: 6, gradientActive: false, glowActive: false, bgPanelActive: false },
  },
  neon: {
    label: 'Néon',
    style: { fontFamily: "'Righteous', sans-serif", size: 64, bold: true, italic: false, color: '#ffffff', glowActive: true, glowColor: '#00e5ff', strokeActive: false, gradientActive: false, bgPanelActive: false },
  },
  elegant: {
    label: 'Élégant',
    style: { fontFamily: "'Cormorant Garamond', serif", size: 60, bold: false, italic: true, color: '#f5e9da', strokeActive: false, glowActive: false, gradientActive: false, bgPanelActive: true },
  },
  manuscrit: {
    label: 'Manuscrit',
    style: { fontFamily: "'Pacifico', cursive", size: 56, bold: false, italic: false, color: '#ffffff', strokeActive: false, glowActive: false, gradientActive: false, bgPanelActive: false },
  },
  degrade: {
    label: 'Dégradé vibrant',
    style: { fontFamily: "'Poppins', sans-serif", size: 68, bold: true, italic: false, gradientActive: true, gradientColor1: '#ff2d95', gradientColor2: '#00e5ff', gradientAngle: 90, strokeActive: false, glowActive: false, bgPanelActive: false },
  },
  minimal: {
    label: 'Minimal',
    style: { fontFamily: "'Inter', sans-serif", size: 40, bold: false, italic: false, color: '#ffffff', strokeActive: false, glowActive: false, gradientActive: false, bgPanelActive: false },
  },
};

function optionsPresetsStyleHtml() {
  return Object.entries(PRESETS_STYLE_TEXTE)
    .map(([cle, preset]) => `<option value="${cle}">${preset.label}</option>`)
    .join('');
}

function optionsFontsHtml(selected) {
  const base = FONTS_DISPONIBLES.map(
    (f) => `<option value="${f.value}" ${f.value === selected ? 'selected' : ''}>${f.label}</option>`
  ).join('');
  const etendues = FONTS_ETENDUES.map(
    (f) => `<option value="${f.value}" ${f.value === selected ? 'selected' : ''}>${f.label}</option>`
  ).join('');
  return (
    base +
    `<optgroup label="Plus de polices (Google Fonts)">${etendues}</optgroup>` +
    `<option value="custom" ${selected === 'custom' ? 'selected' : ''}>Police importée</option>`
  );
}

function renderTextBlockHtml(b, index) {
  return `
    <div class="editor-photo-layer ${b.verrouille ? 'verrouille' : ''}">
      ${renderCalqueHeadHtml(b, `Texte ${index + 1}`, 'textblock')}
      <textarea data-texte-for="${b.id}" rows="2" placeholder="Votre texte...">${b.texte || ''}</textarea>

      <details class="editor-accordion-nested">
        <summary>Style</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <select data-preset-for="${b.id}">
              <option value="">Preset de style...</option>
              ${optionsPresetsStyleHtml()}
            </select>
            <button type="button" class="editor-add-btn" data-preset-appliquer-for="${b.id}">Appliquer</button>
          </div>
          <div class="editor-row">
            <select data-font-for="${b.id}">${optionsFontsHtml(b.fontFamily)}</select>
            <input type="color" data-color-for="${b.id}" value="${b.color || '#ffffff'}" title="Couleur du texte">
            <label class="editor-mini-label">Taille<input type="range" data-size-for="${b.id}" min="16" max="140" value="${b.size}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-bold-for="${b.id}" ${b.bold !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Gras</span></label>
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-italic-for="${b.id}" ${b.italic ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Italique</span></label>
            <select data-align-for="${b.id}">
              <option value="left" ${b.align === 'left' ? 'selected' : ''}>Gauche</option>
              <option value="center" ${(!b.align || b.align === 'center') ? 'selected' : ''}>Centré</option>
              <option value="right" ${b.align === 'right' ? 'selected' : ''}>Droite</option>
            </select>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Interlignage<input type="range" data-interligne-for="${b.id}" min="80" max="250" value="${Math.round((b.interligne ?? 1.2) * 100)}"></label>
            <label class="editor-mini-label">Espacement lettres<input type="range" data-espacementlettres-for="${b.id}" min="-4" max="30" value="${b.espacementLettres ?? 0}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-bgpanel-for="${b.id}" ${b.bgPanelActive !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Fond derrière le texte</span></label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Largeur du cadre<input type="range" data-wrapwidth-for="${b.id}" min="15" max="90" value="${Math.round((b.wrapWidth ?? 0.85) * 100)}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-stroke-for="${b.id}" ${b.strokeActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Contour</span></label>
            <input type="color" data-strokecolor-for="${b.id}" value="${b.strokeColor || '#000000'}" title="Couleur du contour">
            <label class="editor-mini-label">Épaisseur<input type="range" data-strokewidth-for="${b.id}" min="1" max="15" value="${b.strokeWidth ?? 4}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-gradient-for="${b.id}" ${b.gradientActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Dégradé</span></label>
            <input type="color" data-gradientcolor1-for="${b.id}" value="${b.gradientColor1 || '#00e5ff'}" title="Couleur 1">
            <input type="color" data-gradientcolor2-for="${b.id}" value="${b.gradientColor2 || '#ff2d95'}" title="Couleur 2">
            <label class="editor-mini-label">Angle<input type="range" data-gradientangle-for="${b.id}" min="0" max="360" value="${b.gradientAngle ?? 90}"></label>
          </div>
          <span class="form-hint">Un cadre plus étroit redispose automatiquement le texte sur plusieurs lignes (utile pour un texte "en liste" dans une marge latérale).</span>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-textecourbe-for="${b.id}" ${b.texteCourbe ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Texte le long d'une courbe</span></label>
            <label class="editor-mini-label">Courbure<input type="range" data-courberayon-for="${b.id}" min="-400" max="400" step="10" value="${b.courbeRayon ?? 220}"></label>
          </div>
          <span class="form-hint">Positif = arc vers le haut, négatif = vers le bas. Sur une seule ligne (les retours à la ligne et l'alignement gauche/droite sont ignorés en mode courbe).</span>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Animation &amp; timing</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-mini-label">Animation
              <select data-anim-for="${b.id}">
                <option value="none" ${(!b.anim || b.anim === 'none') ? 'selected' : ''}>Aucune</option>
                <option value="fade" ${b.anim === 'fade' ? 'selected' : ''}>Fondu</option>
                <option value="slide" ${b.anim === 'slide' ? 'selected' : ''}>Glissement</option>
                <option value="pop" ${b.anim === 'pop' ? 'selected' : ''}>Pop (zoom)</option>
                <option value="rotate3d" ${b.anim === 'rotate3d' ? 'selected' : ''}>Rotation 3D</option>
                <option value="blur" ${b.anim === 'blur' ? 'selected' : ''}>Flou → net</option>
                <option value="typewriter" ${b.anim === 'typewriter' ? 'selected' : ''}>Machine à écrire</option>
              </select>
            </label>
            <label class="editor-mini-label">Courbe
              <select data-easing-for="${b.id}">
                <option value="linear" ${(!b.easing || b.easing === 'linear') ? 'selected' : ''}>Linéaire</option>
                <option value="easeInOut" ${b.easing === 'easeInOut' ? 'selected' : ''}>Ralenti (ease in-out)</option>
                <option value="easeOut" ${b.easing === 'easeOut' ? 'selected' : ''}>Ralenti sortie (ease out)</option>
                <option value="bounce" ${b.easing === 'bounce' ? 'selected' : ''}>Rebond</option>
                <option value="elastic" ${b.easing === 'elastic' ? 'selected' : ''}>Élastique</option>
              </select>
            </label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Durée anim. (s)<input type="number" data-animduree-for="${b.id}" min="0.1" max="5" step="0.1" value="${b.animDuree ?? 0.5}" style="max-width:80px;"></label>
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Apparaît à (s, vide = début)<input type="number" data-start-for="${b.id}" min="0" step="0.5" value="${b.startTime ?? ''}" style="max-width:80px;"></label>
            <label class="editor-mini-label">Disparaît à (s, vide = fin)<input type="number" data-end-for="${b.id}" min="0" step="0.5" value="${b.endTime ?? ''}" style="max-width:80px;"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Rotation 3D</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-mini-label">Axe X<input type="range" data-rotx-for="${b.id}" min="-45" max="45" value="${b.rotX || 0}"></label>
            <label class="editor-mini-label">Axe Y<input type="range" data-roty-for="${b.id}" min="-45" max="45" value="${b.rotY || 0}"></label>
            <label class="editor-mini-label">Axe Z<input type="range" data-rotz-for="${b.id}" min="-45" max="45" value="${b.rotZ || 0}"></label>
          </div>
        </div>
      </details>

      <details class="editor-accordion-nested">
        <summary>Glow / Néon &amp; contour énergétique</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-glow-for="${b.id}" ${b.glowActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Glow néon</span></label>
            <input type="color" data-glowcolor-for="${b.id}" value="${b.glowColor || '#00e5ff'}" title="Couleur du glow">
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-saber-for="${b.id}" ${b.saberActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Contour énergétique</span></label>
            <input type="color" data-sabercolor-for="${b.id}" value="${b.saberColor || '#00e5ff'}" title="Couleur du contour">
          </div>
          <div class="editor-row">
            <label class="editor-mini-label">Quantité<input type="range" data-sabercount-for="${b.id}" min="6" max="120" value="${b.saberCount ?? 26}"></label>
            <label class="editor-mini-label">Taille<input type="range" data-sabersize-for="${b.id}" min="20" max="300" value="${Math.round((b.saberSize ?? 1) * 100)}"></label>
          </div>
          <div class="editor-row">
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-particles-for="${b.id}" ${b.particlesActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Particules flottantes</span></label>
          </div>
        </div>
      </details>
    </div>
  `;
}

function bindTextBlockEvents() {
  EditorState.textBlocks.forEach((b) => {
    bindCalqueHeadEvents(b, rafraichirListeTextBlocks, dupliquerBlocTexte, 'textblock');

    const presetSelect = document.querySelector(`[data-preset-for="${b.id}"]`);
    const presetBtn = document.querySelector(`[data-preset-appliquer-for="${b.id}"]`);
    if (presetBtn && presetSelect) {
      presetBtn.addEventListener('click', () => {
        const preset = PRESETS_STYLE_TEXTE[presetSelect.value];
        if (!preset) return;
        Object.assign(b, cloneProfondSansDom(preset.style));
        rafraichirListeTextBlocks();
        pousserHistorique();
        toast(`Style "${preset.label}" appliqué.`, 'success');
      });
    }

    const texteInput = document.querySelector(`[data-texte-for="${b.id}"]`);
    if (texteInput) texteInput.addEventListener('input', (e) => (b.texte = e.target.value));

    const fontInput = document.querySelector(`[data-font-for="${b.id}"]`);
    if (fontInput) fontInput.addEventListener('change', (e) => (b.fontFamily = e.target.value));

    const colorInput = document.querySelector(`[data-color-for="${b.id}"]`);
    if (colorInput) colorInput.addEventListener('input', (e) => (b.color = e.target.value));

    const sizeInput = document.querySelector(`[data-size-for="${b.id}"]`);
    if (sizeInput) sizeInput.addEventListener('input', (e) => (b.size = Number(e.target.value)));

    const boldInput = document.querySelector(`[data-bold-for="${b.id}"]`);
    if (boldInput) boldInput.addEventListener('change', (e) => (b.bold = e.target.checked));

    const italicInput = document.querySelector(`[data-italic-for="${b.id}"]`);
    if (italicInput) italicInput.addEventListener('change', (e) => (b.italic = e.target.checked));

    const alignInput = document.querySelector(`[data-align-for="${b.id}"]`);
    if (alignInput) alignInput.addEventListener('change', (e) => (b.align = e.target.value));

    const interligneInput = document.querySelector(`[data-interligne-for="${b.id}"]`);
    if (interligneInput) interligneInput.addEventListener('input', (e) => (b.interligne = Number(e.target.value) / 100));
    const espacementLettresInput = document.querySelector(`[data-espacementlettres-for="${b.id}"]`);
    if (espacementLettresInput) espacementLettresInput.addEventListener('input', (e) => (b.espacementLettres = Number(e.target.value)));

    const bgPanelInput = document.querySelector(`[data-bgpanel-for="${b.id}"]`);
    if (bgPanelInput) bgPanelInput.addEventListener('change', (e) => (b.bgPanelActive = e.target.checked));

    const strokeInput = document.querySelector(`[data-stroke-for="${b.id}"]`);
    if (strokeInput) strokeInput.addEventListener('change', (e) => (b.strokeActive = e.target.checked));
    const strokeColorInput = document.querySelector(`[data-strokecolor-for="${b.id}"]`);
    if (strokeColorInput) strokeColorInput.addEventListener('input', (e) => (b.strokeColor = e.target.value));
    const strokeWidthInput = document.querySelector(`[data-strokewidth-for="${b.id}"]`);
    if (strokeWidthInput) strokeWidthInput.addEventListener('input', (e) => (b.strokeWidth = Number(e.target.value)));

    const gradientInput = document.querySelector(`[data-gradient-for="${b.id}"]`);
    if (gradientInput) gradientInput.addEventListener('change', (e) => (b.gradientActive = e.target.checked));
    const gradientColor1Input = document.querySelector(`[data-gradientcolor1-for="${b.id}"]`);
    if (gradientColor1Input) gradientColor1Input.addEventListener('input', (e) => (b.gradientColor1 = e.target.value));
    const gradientColor2Input = document.querySelector(`[data-gradientcolor2-for="${b.id}"]`);
    if (gradientColor2Input) gradientColor2Input.addEventListener('input', (e) => (b.gradientColor2 = e.target.value));
    const gradientAngleInput = document.querySelector(`[data-gradientangle-for="${b.id}"]`);
    if (gradientAngleInput) gradientAngleInput.addEventListener('input', (e) => (b.gradientAngle = Number(e.target.value)));

    const wrapWidthInput = document.querySelector(`[data-wrapwidth-for="${b.id}"]`);
    if (wrapWidthInput) {
      wrapWidthInput.addEventListener('input', (e) => (b.wrapWidth = Number(e.target.value) / 100));
    }
    const texteCourbeInput = document.querySelector(`[data-textecourbe-for="${b.id}"]`);
    if (texteCourbeInput) texteCourbeInput.addEventListener('change', (e) => (b.texteCourbe = e.target.checked));
    const courbeRayonInput = document.querySelector(`[data-courberayon-for="${b.id}"]`);
    if (courbeRayonInput) courbeRayonInput.addEventListener('input', (e) => (b.courbeRayon = Number(e.target.value)));

    const animInput = document.querySelector(`[data-anim-for="${b.id}"]`);
    if (animInput) animInput.addEventListener('change', (e) => (b.anim = e.target.value));
    const easingInput = document.querySelector(`[data-easing-for="${b.id}"]`);
    if (easingInput) easingInput.addEventListener('change', (e) => (b.easing = e.target.value));
    const animDureeInput = document.querySelector(`[data-animduree-for="${b.id}"]`);
    if (animDureeInput) animDureeInput.addEventListener('input', (e) => (b.animDuree = Math.max(0.1, Number(e.target.value) || 0.5)));

    const startInput = document.querySelector(`[data-start-for="${b.id}"]`);
    if (startInput) {
      startInput.addEventListener('input', (e) => {
        b.startTime = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
      });
    }
    const endInput = document.querySelector(`[data-end-for="${b.id}"]`);
    if (endInput) {
      endInput.addEventListener('input', (e) => {
        b.endTime = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
      });
    }

    const rotXInput = document.querySelector(`[data-rotx-for="${b.id}"]`);
    if (rotXInput) rotXInput.addEventListener('input', (e) => (b.rotX = Number(e.target.value)));
    const rotYInput = document.querySelector(`[data-roty-for="${b.id}"]`);
    if (rotYInput) rotYInput.addEventListener('input', (e) => (b.rotY = Number(e.target.value)));
    const rotZInput = document.querySelector(`[data-rotz-for="${b.id}"]`);
    if (rotZInput) rotZInput.addEventListener('input', (e) => (b.rotZ = Number(e.target.value)));

    const glowInput = document.querySelector(`[data-glow-for="${b.id}"]`);
    if (glowInput) glowInput.addEventListener('change', (e) => (b.glowActive = e.target.checked));
    const glowColorInput = document.querySelector(`[data-glowcolor-for="${b.id}"]`);
    if (glowColorInput) glowColorInput.addEventListener('input', (e) => (b.glowColor = e.target.value));

    const saberInput = document.querySelector(`[data-saber-for="${b.id}"]`);
    if (saberInput) saberInput.addEventListener('change', (e) => (b.saberActive = e.target.checked));
    const saberColorInput = document.querySelector(`[data-sabercolor-for="${b.id}"]`);
    if (saberColorInput) saberColorInput.addEventListener('input', (e) => (b.saberColor = e.target.value));
    const saberCountInput = document.querySelector(`[data-sabercount-for="${b.id}"]`);
    if (saberCountInput) saberCountInput.addEventListener('input', (e) => (b.saberCount = Number(e.target.value)));
    const saberSizeInput = document.querySelector(`[data-sabersize-for="${b.id}"]`);
    if (saberSizeInput) {
      saberSizeInput.addEventListener('input', (e) => (b.saberSize = Number(e.target.value) / 100));
    }

    const particlesInput = document.querySelector(`[data-particles-for="${b.id}"]`);
    if (particlesInput) particlesInput.addEventListener('change', (e) => (b.particlesActive = e.target.checked));
  });
  document.querySelectorAll('[data-remove-textblock]').forEach((btn) => {
    btn.addEventListener('click', () => supprimerBlocTexte(Number(btn.dataset.removeTextblock)));
  });
}

function rafraichirListeTextBlocks() {
  const container = document.getElementById('editor-textblocks-list');
  if (!container) return;
  container.innerHTML =
    EditorState.textBlocks.map((b, i) => renderTextBlockHtml(b, i)).join('') ||
    '<p class="form-hint">Aucun texte ajouté pour le moment.</p>';
  bindTextBlockEvents();
  purgerSelectionGroupee('textblock', EditorState.textBlocks);
}

function creerTextBlockParDefaut(id, decalage) {
  return {
    id,
    nom: null,
    verrouille: false,
    visible: true,
    texte: '',
    x: 0.5,
    y: 0.2 + (decalage || 0),
    z: 10, // au-dessus de tout le reste (particules à z=6 étaient le plus haut)
    fontFamily: "'Space Grotesk', sans-serif",
    size: 56,
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    anim: 'none',
    animDuree: 0.5,
    easing: 'linear',
    startTime: null,
    endTime: null,
    bgPanelActive: true,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    glowActive: false,
    glowColor: '#00e5ff',
    saberActive: false,
    saberColor: '#00e5ff',
    saberCount: 26,
    saberSize: 1,
    particlesActive: false,
    wrapWidth: 0.85,
    texteCourbe: false,
    courbeRayon: 220,
    strokeActive: false,
    strokeColor: '#000000',
    strokeWidth: 4,
    gradientActive: false,
    gradientColor1: '#00e5ff',
    gradientColor2: '#ff2d95',
    gradientAngle: 90,
    interligne: 1.2,
    espacementLettres: 0,
  };
}

function ajouterBlocTexte() {
  const id = ++elementIdCounter;
  const decalage = (EditorState.textBlocks.length % 5) * 0.06;
  EditorState.textBlocks.push(creerTextBlockParDefaut(id, decalage));
  rafraichirListeTextBlocks();
  pousserHistorique();
}

function supprimerBlocTexte(id) {
  const b = EditorState.textBlocks.find((tb) => tb.id === id);
  if (b && b.verrouille) return;
  EditorState.textBlocks = EditorState.textBlocks.filter((tb) => tb.id !== id);
  hideLayer(`text-${id}`);
  const ts = EditorState.three;
  if (ts && ts.particleSystems[`text-particles-${id}`]) {
    ts.particleSystems[`text-particles-${id}`].points.visible = false;
  }
  rafraichirListeTextBlocks();
  pousserHistorique();
}

function dupliquerBlocTexte(id) {
  const index = EditorState.textBlocks.findIndex((b) => b.id === id);
  if (index === -1) return;
  const original = EditorState.textBlocks[index];
  const copie = { ...original, id: ++elementIdCounter, nom: original.nom ? `${original.nom} (copie)` : null, verrouille: false };
  EditorState.textBlocks.splice(index + 1, 0, copie);
  rafraichirListeTextBlocks();
  pousserHistorique();
}

/* -------------------------------------------------------------------- */
/* Formes vectorielles & stickers                                        */
/* -------------------------------------------------------------------- */
function creerFormeParDefaut(id) {
  return {
    id,
    nom: null,
    verrouille: false,
    visible: true,
    type: 'star',
    emoji: '⭐',
    x: 0.5,
    y: 0.5,
    z: 8,
    rotZ: 0,
    scale: 0.18,
    couleur: '#00e676',
    opacite: 1,
    contourActive: false,
    contourColor: '#ffffff',
    contourWidth: 4,
    startTime: null,
    endTime: null,
  };
}

function renderFormeHtml(f, index) {
  return `
    <div class="editor-photo-layer ${f.verrouille ? 'verrouille' : ''}" draggable="${!f.verrouille}" data-forme-drag="${f.id}">
      ${renderCalqueHeadHtml(f, `Forme ${index + 1}`, 'forme')}
      <div class="editor-row">
        <select data-formetype-for="${f.id}">${SHAPES_DISPONIBLES.map((s) => `<option value="${s.value}" ${f.type === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
      </div>
      ${f.type === 'sticker' ? `
      <div class="editor-row editor-sticker-choix">
        ${STICKERS_DISPONIBLES.map((e) => `<button type="button" class="editor-sticker-btn ${f.emoji === e ? 'active' : ''}" data-formeemoji-for="${f.id}" data-emoji="${e}">${e}</button>`).join('')}
      </div>` : `
      <div class="editor-row">
        <input type="color" data-formecouleur-for="${f.id}" value="${f.couleur || '#00e676'}" title="Couleur">
        <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-formecontour-for="${f.id}" ${f.contourActive ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Contour</span></label>
        <input type="color" data-formecontourcolor-for="${f.id}" value="${f.contourColor || '#ffffff'}" title="Couleur du contour">
      </div>`}
      <div class="editor-row">
        <label class="editor-mini-label">Taille<input type="range" data-formescale-for="${f.id}" min="4" max="60" value="${Math.round((f.scale ?? 0.18) * 100)}"></label>
        <label class="editor-mini-label">Rotation<input type="range" data-formerotz-for="${f.id}" min="-180" max="180" value="${f.rotZ || 0}"></label>
      </div>
      <div class="editor-row">
        <label class="editor-mini-label">Opacité<input type="range" data-formeopacite-for="${f.id}" min="10" max="100" value="${Math.round((f.opacite ?? 1) * 100)}"></label>
      </div>
      <div class="editor-row">
        <label class="editor-mini-label">Apparaît à (s, vide = début)<input type="number" data-formestart-for="${f.id}" min="0" step="0.5" value="${f.startTime ?? ''}" style="max-width:80px;"></label>
        <label class="editor-mini-label">Disparaît à (s, vide = fin)<input type="number" data-formeend-for="${f.id}" min="0" step="0.5" value="${f.endTime ?? ''}" style="max-width:80px;"></label>
      </div>
    </div>
  `;
}

function rafraichirListeFormes() {
  const container = document.getElementById('editor-shapes-list');
  if (!container) return;
  container.innerHTML =
    EditorState.shapes.map((f, i) => renderFormeHtml(f, i)).join('') ||
    '<p class="form-hint">Aucune forme/sticker ajouté pour le moment.</p>';
  bindFormeEvents();
  purgerSelectionGroupee('forme', EditorState.shapes);
}

function bindFormeEvents() {
  EditorState.shapes.forEach((f) => {
    bindCalqueHeadEvents(f, rafraichirListeFormes, dupliquerForme, 'forme');

    const typeInput = document.querySelector(`[data-formetype-for="${f.id}"]`);
    if (typeInput) {
      typeInput.addEventListener('change', (e) => {
        f.type = e.target.value;
        rafraichirListeFormes();
        pousserHistorique();
      });
    }
    document.querySelectorAll(`[data-formeemoji-for="${f.id}"]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        f.emoji = btn.dataset.emoji;
        rafraichirListeFormes();
        pousserHistorique();
      });
    });
    const couleurInput = document.querySelector(`[data-formecouleur-for="${f.id}"]`);
    if (couleurInput) couleurInput.addEventListener('input', (e) => (f.couleur = e.target.value));
    const contourInput = document.querySelector(`[data-formecontour-for="${f.id}"]`);
    if (contourInput) contourInput.addEventListener('change', (e) => (f.contourActive = e.target.checked));
    const contourColorInput = document.querySelector(`[data-formecontourcolor-for="${f.id}"]`);
    if (contourColorInput) contourColorInput.addEventListener('input', (e) => (f.contourColor = e.target.value));
    const scaleInput = document.querySelector(`[data-formescale-for="${f.id}"]`);
    if (scaleInput) scaleInput.addEventListener('input', (e) => (f.scale = Number(e.target.value) / 100));
    const rotzInput = document.querySelector(`[data-formerotz-for="${f.id}"]`);
    if (rotzInput) rotzInput.addEventListener('input', (e) => (f.rotZ = Number(e.target.value)));
    const opaciteInput = document.querySelector(`[data-formeopacite-for="${f.id}"]`);
    if (opaciteInput) opaciteInput.addEventListener('input', (e) => (f.opacite = Number(e.target.value) / 100));
    const startInput = document.querySelector(`[data-formestart-for="${f.id}"]`);
    if (startInput) {
      startInput.addEventListener('input', (e) => {
        f.startTime = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
      });
    }
    const endInput = document.querySelector(`[data-formeend-for="${f.id}"]`);
    if (endInput) {
      endInput.addEventListener('input', (e) => {
        f.endTime = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
      });
    }
  });
  document.querySelectorAll('[data-remove-forme]').forEach((btn) => {
    btn.addEventListener('click', () => supprimerForme(Number(btn.dataset.removeForme)));
  });
}

function ajouterForme() {
  const id = ++elementIdCounter;
  EditorState.shapes.push(creerFormeParDefaut(id));
  rafraichirListeFormes();
  pousserHistorique();
}

function supprimerForme(id) {
  const f = EditorState.shapes.find((s) => s.id === id);
  if (f && f.verrouille) return;
  EditorState.shapes = EditorState.shapes.filter((s) => s.id !== id);
  hideLayer(`forme-${id}`);
  rafraichirListeFormes();
  pousserHistorique();
}

function dupliquerForme(id) {
  const index = EditorState.shapes.findIndex((s) => s.id === id);
  if (index === -1) return;
  const original = EditorState.shapes[index];
  const copie = { ...original, id: ++elementIdCounter, nom: original.nom ? `${original.nom} (copie)` : null, verrouille: false };
  EditorState.shapes.splice(index + 1, 0, copie);
  rafraichirListeFormes();
  pousserHistorique();
}

/* -------------------------------------------------------------------- */
/* Dessin libre (pinceau)                                                */
/* -------------------------------------------------------------------- */
function creerDessinParDefaut(id) {
  return {
    id,
    nom: null,
    verrouille: false,
    visible: true,
    points: [],
    couleur: EditorState.dessinCouleur || '#ff2d95',
    epaisseur: Number(EditorState.dessinEpaisseur) || 6,
    opacite: 1,
    z: 9,
    startTime: null,
    endTime: null,
  };
}

function rafraichirPanneauDessin() {
  const compteEl = document.getElementById('editor-dessin-compte');
  if (compteEl) {
    compteEl.textContent = EditorState.drawings.length
      ? `${EditorState.drawings.length} trait(s)`
      : 'Aucun trait dessiné';
  }
  const toggleBtn = document.getElementById('editor-dessin-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', EditorState.modeDessin);
    toggleBtn.textContent = EditorState.modeDessin ? 'Dessin activé (cliquer pour arrêter)' : 'Activer le dessin libre';
  }
  const canvas = document.getElementById('editor-canvas');
  if (canvas) canvas.classList.toggle('editor-canvas-dessin', EditorState.modeDessin);
}

function annulerDernierTrait() {
  if (!EditorState.drawings.length) return;
  const dernier = EditorState.drawings[EditorState.drawings.length - 1];
  hideLayer(`dessin-${dernier.id}`);
  EditorState.drawings.pop();
  rafraichirPanneauDessin();
  pousserHistorique();
}

function effacerTousLesDessins() {
  if (!EditorState.drawings.length) return;
  if (!confirm('Effacer tous les traits de dessin libre ?')) return;
  EditorState.drawings.forEach((d) => hideLayer(`dessin-${d.id}`));
  EditorState.drawings = [];
  rafraichirPanneauDessin();
  pousserHistorique();
}

function bindModeDessin() {
  const toggleBtn = document.getElementById('editor-dessin-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      EditorState.modeDessin = !EditorState.modeDessin;
      rafraichirPanneauDessin();
    });
  }
  const couleurInput = document.getElementById('editor-dessin-couleur');
  if (couleurInput) couleurInput.addEventListener('input', (e) => (EditorState.dessinCouleur = e.target.value));
  const epaisseurInput = document.getElementById('editor-dessin-epaisseur');
  if (epaisseurInput) epaisseurInput.addEventListener('input', (e) => (EditorState.dessinEpaisseur = Number(e.target.value)));
  const undoBtn = document.getElementById('editor-dessin-undo');
  if (undoBtn) undoBtn.addEventListener('click', annulerDernierTrait);
  const clearBtn = document.getElementById('editor-dessin-clear');
  if (clearBtn) clearBtn.addEventListener('click', effacerTousLesDessins);
  rafraichirPanneauDessin();
}

function bindCadreDecoratif() {
  const typeSelect = document.getElementById('editor-cadre-type');
  if (typeSelect) {
    typeSelect.value = EditorState.cadreDecoratif.type;
    typeSelect.addEventListener('change', (e) => {
      EditorState.cadreDecoratif.type = e.target.value;
    });
  }
  const couleurInput = document.getElementById('editor-cadre-couleur');
  if (couleurInput) {
    couleurInput.value = EditorState.cadreDecoratif.couleur;
    couleurInput.addEventListener('input', (e) => (EditorState.cadreDecoratif.couleur = e.target.value));
  }
  const epaisseurInput = document.getElementById('editor-cadre-epaisseur');
  if (epaisseurInput) {
    epaisseurInput.value = EditorState.cadreDecoratif.epaisseur;
    epaisseurInput.addEventListener('input', (e) => (EditorState.cadreDecoratif.epaisseur = Number(e.target.value)));
  }
}

/* -------------------------------------------------------------------- */
/* Glisser-déposer sur le canvas (texte / photo active) — raycasting 3D  */
/* -------------------------------------------------------------------- */
function pointerToNdc(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((evt.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

function raycastLayer(canvas, evt, layerNames) {
  const ts = EditorState.three;
  const ndc = pointerToNdc(canvas, evt);
  ts.raycaster.setFromCamera(ndc, ts.camera);
  const meshes = layerNames
    .map((name) => ts.layers[name])
    .filter((l) => l && l.mesh.visible)
    .map((l) => l.mesh);
  const hits = ts.raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0] : null;
}

// Guides d'alignement (0..1 du cadre) : centre + règle des tiers. Le nom
// correspond à l'attribut data-guide de la ligne HTML affichée dessus.
const SEUIL_SNAP_ALIGNEMENT = 0.012;
const GUIDES_VERTICALES = { 'center-v': 0.5, 'third-v1': 1 / 3, 'third-v2': 2 / 3 };
const GUIDES_HORIZONTALES = { 'center-h': 0.5, 'third-h1': 1 / 3, 'third-h2': 2 / 3 };

// Aimante (fx, fy) sur le guide le plus proche s'il est à moins de
// SEUIL_SNAP_ALIGNEMENT, et allume la ligne correspondante à l'écran.
function appliquerSnapEtGuides(fx, fy) {
  let sx = fx;
  let sy = fy;
  const actifs = [];
  for (const [nom, val] of Object.entries(GUIDES_VERTICALES)) {
    if (Math.abs(fx - val) < SEUIL_SNAP_ALIGNEMENT) {
      sx = val;
      actifs.push(nom);
      break;
    }
  }
  for (const [nom, val] of Object.entries(GUIDES_HORIZONTALES)) {
    if (Math.abs(fy - val) < SEUIL_SNAP_ALIGNEMENT) {
      sy = val;
      actifs.push(nom);
      break;
    }
  }
  document.querySelectorAll('.editor-align-guide').forEach((el) => {
    el.classList.toggle('active', actifs.includes(el.dataset.guide));
  });
  return { fx: sx, fy: sy };
}

function masquerGuidesAlignement() {
  document.querySelectorAll('.editor-align-guide.active').forEach((el) => el.classList.remove('active'));
}

// Convertit une position pointeur en fraction (0..1) du cadre, projetée
// sur le plan de profondeur z du calque en cours de glisser-déposer.
function pointerToFraction(canvas, evt, z) {
  const ts = EditorState.three;
  const { THREE } = ts;
  const ndc = pointerToNdc(canvas, evt);
  ts.raycaster.setFromCamera(ndc, ts.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
  const point = new THREE.Vector3();
  if (!ts.raycaster.ray.intersectPlane(plane, point)) return null;
  const px = worldToPx(point.x, point.y);
  return { fx: Math.min(1, Math.max(0, px.x / ts.width)), fy: Math.min(1, Math.max(0, px.y / ts.height)) };
}

function nomsTextLayerNames() {
  return EditorState.textBlocks.map((b) => `text-${b.id}`);
}

function nomsFormeLayerNames() {
  return EditorState.shapes.map((f) => `forme-${f.id}`);
}

// Médias superposés du calque photo actif — uniquement ceux-là sont
// affichés/glissables à un instant donné (voir mettreAJourMediasSuperposes).
function nomsSousMediaLayerNames() {
  const p = calquePhotoActif();
  return p ? (p.sousMedias || []).map((sm) => `photo-extra-${sm.id}`) : [];
}

function bindEditorDrag3D(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    if (EditorState.modeDessin) {
      const trait = creerDessinParDefaut(++elementIdCounter);
      EditorState.drawings.push(trait);
      EditorState.dragging = { type: 'dessin', id: trait.id };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const layers = EditorState.three.layers;
    const textLayerNames = nomsTextLayerNames();
    const formeLayerNames = nomsFormeLayerNames();
    const smLayerNames = nomsSousMediaLayerNames();
    const textHit = raycastLayer(canvas, e, textLayerNames);
    const formeHit = !textHit && raycastLayer(canvas, e, formeLayerNames);
    // Les médias superposés sont vérifiés avant la photo principale : ils
    // sont sémantiquement "au-dessus" et doivent rester attrapables même
    // s'ils recouvrent une partie du média principal.
    const smHit = !textHit && !formeHit && raycastLayer(canvas, e, smLayerNames);
    if (textHit) {
      const id = Number(textLayerNames.find((n) => layers[n] && layers[n].mesh === textHit.object).replace('text-', ''));
      const b = EditorState.textBlocks.find((tb) => tb.id === id);
      if (b && !b.verrouille) EditorState.dragging = { type: 'textblock', id };
    } else if (formeHit) {
      const id = Number(formeLayerNames.find((n) => layers[n] && layers[n].mesh === formeHit.object).replace('forme-', ''));
      const f = EditorState.shapes.find((s) => s.id === id);
      if (f && !f.verrouille) EditorState.dragging = { type: 'forme', id };
    } else if (smHit) {
      const id = Number(smLayerNames.find((n) => layers[n] && layers[n].mesh === smHit.object).replace('photo-extra-', ''));
      const p = calquePhotoActif();
      const sm = p && (p.sousMedias || []).find((s) => s.id === id);
      if (sm && !sm.verrouille) EditorState.dragging = { type: 'sousmedia', id, parentId: p.id };
    } else if (layers.caption && layers.caption.mesh.visible && raycastLayer(canvas, e, ['caption'])) {
      const p = calquePhotoActif();
      if (p && !p.verrouille) EditorState.dragging = { type: 'caption', id: p.id };
    } else if (layers.photo && layers.photo.mesh.visible && raycastLayer(canvas, e, ['photo'])) {
      const p = calquePhotoActif();
      if (p && !p.verrouille) EditorState.dragging = { type: 'photo', id: p.id };
    }
    if (EditorState.dragging) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (EditorState.dragging && EditorState.dragging.type === 'dessin') {
      const d = EditorState.drawings.find((dr) => dr.id === EditorState.dragging.id);
      const frac = d && pointerToFraction(canvas, e, d.z ?? 9);
      if (d && frac) d.points.push({ x: frac.fx, y: frac.fy });
      return;
    }
    if (!EditorState.dragging) {
      const survole =
        !EditorState.modeDessin &&
        raycastLayer(canvas, e, [...nomsTextLayerNames(), ...nomsFormeLayerNames(), ...nomsSousMediaLayerNames(), 'caption', 'photo']) !== null;
      canvas.style.cursor = EditorState.modeDessin ? 'crosshair' : survole ? 'grab' : 'default';
      return;
    }
    canvas.style.cursor = 'grabbing';
    if (EditorState.dragging.type === 'textblock') {
      const b = EditorState.textBlocks.find((tb) => tb.id === EditorState.dragging.id);
      const frac = b && pointerToFraction(canvas, e, b.z ?? 10);
      if (b && frac) {
        const snap = appliquerSnapEtGuides(frac.fx, frac.fy);
        b.x = snap.fx;
        b.y = snap.fy;
      }
    } else if (EditorState.dragging.type === 'sousmedia') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.parentId);
      const sm = p && (p.sousMedias || []).find((s) => s.id === EditorState.dragging.id);
      const frac = sm && pointerToFraction(canvas, e, sm.z ?? 0);
      if (sm && frac) {
        const snap = appliquerSnapEtGuides(frac.fx, frac.fy);
        sm.x = snap.fx;
        sm.y = snap.fy;
      }
    } else if (EditorState.dragging.type === 'forme') {
      const f = EditorState.shapes.find((s) => s.id === EditorState.dragging.id);
      const frac = f && pointerToFraction(canvas, e, f.z ?? 8);
      if (f && frac) {
        const snap = appliquerSnapEtGuides(frac.fx, frac.fy);
        f.x = snap.fx;
        f.y = snap.fy;
      }
    } else if (EditorState.dragging.type === 'photo') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      const frac = p && pointerToFraction(canvas, e, p.z || 0);
      if (p && frac) {
        const snap = appliquerSnapEtGuides(frac.fx, frac.fy);
        p.x = snap.fx;
        p.y = snap.fy;
      }
    } else if (EditorState.dragging.type === 'caption') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      const frac = p && pointerToFraction(canvas, e, (p.z || 0) + 2);
      if (p && frac) {
        const snap = appliquerSnapEtGuides(frac.fx, frac.fy);
        p.texteX = snap.fx;
        p.texteY = snap.fy;
      }
    }
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evtName) => {
    canvas.addEventListener(evtName, () => {
      if (EditorState.dragging && EditorState.dragging.type === 'dessin') {
        // Un simple clic sans glisser ne produit qu'un point (ou zéro) : pas
        // un trait exploitable, on le retire plutôt que de polluer l'historique.
        const index = EditorState.drawings.findIndex((d) => d.id === EditorState.dragging.id);
        if (index !== -1 && EditorState.drawings[index].points.length < 2) {
          EditorState.drawings.splice(index, 1);
        } else {
          pousserHistorique();
        }
        rafraichirPanneauDessin();
      } else if (EditorState.dragging) {
        pousserHistorique();
      }
      EditorState.dragging = null;
      canvas.style.cursor = EditorState.modeDessin ? 'crosshair' : 'default';
      masquerGuidesAlignement();
    });
  });
}

function calquePhotoActif() {
  const { segments } = calculerTimeline();
  const seg = segmentAuTemps(segments, EditorState.playback.currentTime);
  return seg && seg.type === 'photo' ? seg.data : null;
}

/* -------------------------------------------------------------------- */
/* Export PNG (formats verticaux Play Store)                             */
/* -------------------------------------------------------------------- */
// Rend une image PNG au format d'export choisi (Play Store vertical ou
// carré) et retourne une Promise<Blob> — séparé du déclenchement du
// download pour être réutilisable tel quel par PlayTesteurAPI.
function rendreImagePng() {
  const dims = EditorState.imageExportFormat === 'square' ? { w: 1080, h: 1080 } : { w: 1080, h: 1920 };
  const ts = EditorState.three;
  const canvas = ts.renderer.domElement;
  const tailleOriginale = { w: ts.width, h: ts.height };

  ts.renderer.setSize(dims.w, dims.h, false);
  ts.camera.aspect = dims.w / dims.h;
  const distance = dims.h / 2 / Math.tan((ts.camera.fov * Math.PI) / 360);
  ts.camera.position.z = distance;
  ts.camera.updateProjectionMatrix();
  ts.width = dims.w;
  ts.height = dims.h;
  ts.bgMesh.scale.set(dims.w, dims.h, 1);

  renderEditorFrame();

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      // Restaure la taille d'aperçu normale.
      ts.renderer.setSize(tailleOriginale.w, tailleOriginale.h, false);
      ts.camera.aspect = tailleOriginale.w / tailleOriginale.h;
      ts.camera.position.z = ts.distance;
      ts.camera.updateProjectionMatrix();
      ts.width = tailleOriginale.w;
      ts.height = tailleOriginale.h;
      ts.bgMesh.scale.set(tailleOriginale.w, tailleOriginale.h, 1);
      resolve(blob);
    }, 'image/png');
  });
}

function exportEditeurPng() {
  rendreImagePng().then((blob) => {
    if (blob) downloadBlob(blob, `${obtenirNomExport('playtesteur-visuel')}.png`);
  });
}

/* -------------------------------------------------------------------- */
/* Export MP4 (MediaRecorder 60fps -> webm, puis ffmpeg.wasm haute       */
/* qualité, preset lent)                                                 */
/* -------------------------------------------------------------------- */
let ffmpegInstance = null;

async function getFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  // Fichiers de @ffmpeg/ffmpeg, @ffmpeg/core et @ffmpeg/util hébergés sur
  // ce site (public/vendor/ffmpeg) plutôt que chargés depuis unpkg.com :
  // en passant par le CDN, le Worker interne devait être bricolé en blob
  // URL pour éviter le blocage "Worker cross-origin" (voir historique),
  // mais ce montage restait instable : le Worker se bloquait ensuite
  // indéfiniment en tentant de fetch le .wasm (également en blob),
  // laissant l'export figé sans jamais aboutir ni échouer. Servir ces
  // fichiers depuis la même origine que le site élimine le problème à la
  // racine — plus besoin de blob URL du tout.
  const { FFmpeg } = await import('/vendor/ffmpeg/ffmpeg/index.js');
  const ffmpeg = new FFmpeg();
  const baseURL = '/vendor/ffmpeg/core';
  await ffmpeg.load({
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
    classWorkerURL: '/vendor/ffmpeg/ffmpeg/worker.js',
  });
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

async function transcoderEnMp4(webmBlob, fps, onProgress) {
  const ffmpeg = await getFfmpeg();
  const onFfmpegProgress = ({ progress }) => onProgress(Math.min(1, Math.max(0, progress)));
  ffmpeg.on('progress', onFfmpegProgress);
  try {
    const donneesEntree = new Uint8Array(await webmBlob.arrayBuffer());
    await ffmpeg.writeFile('entree.webm', donneesEntree);
    // Preset "slow" + CRF bas : encodage plus lent mais meilleure qualité,
    // conforme au 1920x1080 et au FPS choisi par l'utilisateur pour la
    // capture.
    await ffmpeg.exec([
      '-i', 'entree.webm',
      '-r', String(fps || 60),
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      'sortie.mp4',
    ]);
    const donneesSortie = await ffmpeg.readFile('sortie.mp4');
    return new Blob([donneesSortie.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', onFfmpegProgress);
  }
}

// GIF avec palette optimisée (palettegen + paletteuse) : bien meilleure
// qualité de couleurs qu'un GIF encodé directement en 256 couleurs fixes.
// Largeur limitée à 720px pour garder un poids de fichier raisonnable.
async function transcoderEnGif(webmBlob, fps, onProgress) {
  const ffmpeg = await getFfmpeg();
  const onFfmpegProgress = ({ progress }) => onProgress(Math.min(1, Math.max(0, progress)));
  ffmpeg.on('progress', onFfmpegProgress);
  try {
    const donneesEntree = new Uint8Array(await webmBlob.arrayBuffer());
    await ffmpeg.writeFile('entree.webm', donneesEntree);
    await ffmpeg.exec([
      '-i', 'entree.webm',
      '-filter_complex',
      `fps=${fps || 15},scale=w=720:h=-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer`,
      'sortie.gif',
    ]);
    const donneesSortie = await ffmpeg.readFile('sortie.gif');
    return new Blob([donneesSortie.buffer], { type: 'image/gif' });
  } finally {
    ffmpeg.off('progress', onFfmpegProgress);
  }
}

function getSharedAudioCtx() {
  if (!EditorState.audioCtx) {
    EditorState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    EditorState.audioSourceCache = new WeakMap();
  }
  return EditorState.audioCtx;
}

function getOrCreateSourceNode(ctx, mediaEl) {
  if (EditorState.audioSourceCache.has(mediaEl)) return EditorState.audioSourceCache.get(mediaEl);
  const node = ctx.createMediaElementSource(mediaEl);
  EditorState.audioSourceCache.set(mediaEl, node);
  return node;
}

// Branche un AnalyserNode sur la musique de fond pour le spectre réactif
// (aperçu ET export, car le graphe Web Audio reste connecté). Une fois
// qu'un <audio> passe par createMediaElementSource(), sa sortie native
// est coupée : il faut le reconnecter explicitement à audioCtx.destination
// pour continuer à l'entendre pendant l'édition.
function brancherAnalyseurAudio(mediaEl) {
  const audioCtx = getSharedAudioCtx();
  const source = getOrCreateSourceNode(audioCtx, mediaEl);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = EditorState.audioVolume;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512; // 256 bins de fréquence, assez pour jusqu'à ~300 barres sans motif trop répétitif
  analyser.smoothingTimeConstant = 0.75;
  source.connect(gainNode);
  gainNode.connect(analyser);
  gainNode.connect(audioCtx.destination);
  EditorState.audioGainNode = gainNode;
  EditorState.audioAnalyser = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
}

// Piste voix-off : indépendante de la musique de fond, pas de bouclage,
// son propre GainNode pour le volume, pas connectée à l'analyser (le
// spectre audio suit uniquement la musique).
function brancherVoixOff(mediaEl) {
  const audioCtx = getSharedAudioCtx();
  const source = getOrCreateSourceNode(audioCtx, mediaEl);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = EditorState.voiceVolume;
  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  EditorState.voiceGainNode = gainNode;
}

// Fade in/out de la musique de fond sur la durée totale de la timeline
// (pas de la piste elle-même, qui boucle) : à appeler chaque frame.
function appliquerFadeAudio(now, dureeTotale) {
  if (!EditorState.audioGainNode) return;
  let mul = 1;
  const fadeIn = Number(EditorState.audioFadeIn) || 0;
  const fadeOut = Number(EditorState.audioFadeOut) || 0;
  if (fadeIn > 0 && now < fadeIn) mul = Math.min(mul, now / fadeIn);
  if (fadeOut > 0 && dureeTotale - now < fadeOut) mul = Math.min(mul, (dureeTotale - now) / fadeOut);
  EditorState.audioGainNode.gain.value = EditorState.audioVolume * Math.max(0, mul);
}

// Décode la piste pour en tirer une waveform simplifiée (niveaux RMS par
// segment), affichée sous la timeline.
async function calculerWaveform(file) {
  try {
    const audioCtx = getSharedAudioCtx();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const data = audioBuffer.getChannelData(0);
    const buckets = 200;
    const bucketSize = Math.floor(data.length / buckets);
    const levels = new Float32Array(buckets);
    let max = 0;
    for (let i = 0; i < buckets; i++) {
      let sum = 0;
      const start = i * bucketSize;
      for (let j = 0; j < bucketSize; j++) {
        const v = data[start + j] || 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / bucketSize);
      levels[i] = rms;
      if (rms > max) max = rms;
    }
    if (max > 0) for (let i = 0; i < buckets; i++) levels[i] /= max;
    EditorState.audioWaveform = levels;
    dessinerWaveform();
  } catch (err) {
    console.error('[editeur] décodage waveform échoué', err);
  }
}

function dessinerWaveform() {
  const canvas = document.getElementById('editor-waveform');
  const levels = EditorState.audioWaveform;
  if (!canvas || !levels) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const barW = w / levels.length;
  ctx.fillStyle = 'rgba(0,230,118,0.55)';
  for (let i = 0; i < levels.length; i++) {
    const barH = Math.max(1, levels[i] * h);
    ctx.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1), barH);
  }
}

function lireFpsExportChoisi() {
  const select = document.getElementById('editor-export-fps');
  return (select && Number(select.value)) || 30;
}

function basculerBoutonsExport(actifs) {
  ['editor-export-mp4', 'editor-export-png', 'editor-export-gif'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !actifs;
  });
}

// Capture la timeline en webm (vidéo + audio) au FPS demandé, en temps réel
// (comme le ferait une lecture normale) : `captureStream(fps)` échantillonne
// le canvas à un rythme réel fixe et répète la dernière image dessinée si le
// rendu (bloom, particules…) n'a pas eu le temps de produire la suivante —
// jamais de perte de durée ni de désynchronisation audio, tout au plus une
// image répétée sur une scène très chargée. Réutilisé par les exports MP4 et
// GIF.
async function capturerFluxWebm({ fps, setProgress }) {
  const { dureeTotale } = calculerTimeline();
  let audioCtx = null;
  const canvas = document.getElementById('editor-canvas');
  const canvasStream = canvas.captureStream(fps);
  const tracks = [...canvasStream.getVideoTracks()];

  if (EditorState.audioEl || EditorState.bgVideoEl || EditorState.voiceEl) {
    audioCtx = getSharedAudioCtx();
    const dest = audioCtx.createMediaStreamDestination();
    // Se brancher sur le GainNode (volume/fade) déjà en place plutôt que
    // sur la source brute, sinon l'export ignore ces réglages.
    if (EditorState.audioGainNode) EditorState.audioGainNode.connect(dest);
    else if (EditorState.audioEl) getOrCreateSourceNode(audioCtx, EditorState.audioEl).connect(dest);
    if (EditorState.voiceGainNode) EditorState.voiceGainNode.connect(dest);
    else if (EditorState.voiceEl) getOrCreateSourceNode(audioCtx, EditorState.voiceEl).connect(dest);
    if (EditorState.bgVideoEl) getOrCreateSourceNode(audioCtx, EditorState.bgVideoEl).connect(dest);
    tracks.push(...dest.stream.getAudioTracks());
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }

  const finalStream = new MediaStream(tracks);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';
  const recorder = new MediaRecorder(finalStream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  if (EditorState.bgVideoEl) {
    EditorState.bgVideoEl.currentTime = 0;
    await EditorState.bgVideoEl.play().catch(() => {});
  }
  if (EditorState.audioEl) {
    EditorState.audioEl.currentTime = EditorState.audioTrimStart;
    await EditorState.audioEl.play().catch(() => {});
  }
  if (EditorState.voiceEl) {
    EditorState.voiceEl.currentTime = 0;
    await EditorState.voiceEl.play().catch(() => {});
  }

  EditorState.exporting = true;
  EditorState.exportFps = fps;
  EditorState.playback.currentTime = 0;
  EditorState.playback.lastFrameTs = null;
  EditorState.playback.playing = true;

  const finEnregistrement = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const tick = setInterval(() => {
    const frac = dureeTotale > 0 ? EditorState.playback.currentTime / dureeTotale : 0;
    setProgress(Math.min(0.5, frac * 0.5));
  }, 100);

  await new Promise((resolve) => {
    const attendreFin = () => {
      if (!EditorState.playback.playing) {
        resolve();
        return;
      }
      requestAnimationFrame(attendreFin);
    };
    requestAnimationFrame(attendreFin);
  });
  clearInterval(tick);
  recorder.stop();
  if (EditorState.audioEl) EditorState.audioEl.pause();
  if (EditorState.voiceEl) EditorState.voiceEl.pause();
  EditorState.exporting = false;
  await finEnregistrement;

  return new Blob(chunks, { type: 'video/webm' });
}

async function exportEditeurMp4() {
  const progressWrap = document.getElementById('editor-export-progress');
  const fill = document.getElementById('editor-progress-fill');
  const label = document.getElementById('editor-progress-label');

  const { dureeTotale } = calculerTimeline();
  if (dureeTotale <= 0) {
    toast("Ajoutez au moins une intro, une photo ou une outro avant d'exporter.", 'error');
    return;
  }

  const setProgress = (frac, texte) => {
    const pct = Math.round(frac * 100);
    fill.style.width = `${pct}%`;
    label.textContent = texte || `Export en cours… ${pct}%`;
  };

  basculerBoutonsExport(false);
  progressWrap.classList.remove('hidden');
  setProgress(0, 'Préparation…');

  try {
    const fps = lireFpsExportChoisi();
    const webmBlob = await capturerFluxWebm({ fps, setProgress });

    setProgress(0.5, 'Conversion en MP4 (qualité haute, encodage lent)…');
    const mp4Blob = await transcoderEnMp4(webmBlob, fps, (p) =>
      setProgress(0.5 + p * 0.5, `Conversion en MP4… ${Math.round(p * 100)}%`)
    );

    setProgress(1, 'Terminé !');
    downloadBlob(mp4Blob, `${obtenirNomExport('playtesteur-promo')}.mp4`);
  } catch (err) {
    console.error('[editeur] export MP4 échoué', err);
    toast("Échec de l'export MP4 : " + err.message, 'error');
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 1200);
    basculerBoutonsExport(true);
  }
}

async function exportEditeurGif() {
  const progressWrap = document.getElementById('editor-export-progress');
  const fill = document.getElementById('editor-progress-fill');
  const label = document.getElementById('editor-progress-label');

  const { dureeTotale } = calculerTimeline();
  if (dureeTotale <= 0) {
    toast("Ajoutez au moins une intro, une photo ou une outro avant d'exporter.", 'error');
    return;
  }

  const setProgress = (frac, texte) => {
    const pct = Math.round(frac * 100);
    fill.style.width = `${pct}%`;
    label.textContent = texte || `Export en cours… ${pct}%`;
  };

  basculerBoutonsExport(false);
  progressWrap.classList.remove('hidden');
  setProgress(0, 'Préparation…');

  try {
    // Un GIF n'a pas d'intérêt à dépasser ~20 im/s (poids du fichier), même
    // si un FPS plus élevé a été choisi pour la vidéo.
    const fps = Math.min(20, lireFpsExportChoisi());
    const webmBlob = await capturerFluxWebm({ fps, setProgress });

    setProgress(0.5, 'Conversion en GIF (palette optimisée)…');
    const gifBlob = await transcoderEnGif(webmBlob, fps, (p) =>
      setProgress(0.5 + p * 0.5, `Conversion en GIF… ${Math.round(p * 100)}%`)
    );

    setProgress(1, 'Terminé !');
    downloadBlob(gifBlob, `${obtenirNomExport('playtesteur-promo')}.gif`);
  } catch (err) {
    console.error('[editeur] export GIF échoué', err);
    toast("Échec de l'export GIF : " + err.message, 'error');
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 1200);
    basculerBoutonsExport(true);
  }
}

/* ==========================================================================
   PlayTesteurAPI — pilotage programmatique complet de l'éditeur.

   Conçue pour qu'une IA (ou tout script d'automatisation navigateur —
   Playwright/Puppeteer/CDP) pilote l'éditeur via de vraies fonctions
   plutôt qu'en cliquant sur des sélecteurs CSS fragiles. Chaque opération :
     1. modifie EditorState directement (mêmes objets que l'UI manipule),
     2. rafraîchit le panneau DOM correspondant (rafraichirListePhotos,
        rafraichirListeTextBlocks, rafraichirPanneauApresRestauration),
     3. pousse un instantané dans l'historique undo/redo,
   de sorte qu'un humain gardant l'onglet ouvert voit l'éditeur se mettre
   à jour normalement et reste libre d'intervenir à tout moment — piloter
   par API n'est pas un mode exclusif, juste une autre façon d'agir sur le
   même état que l'UI.
   ========================================================================== */

// Télécharge une URL et la restitue comme File (même type MIME que la
// réponse HTTP), pour réutiliser telle quelle les mêmes chargeurs que les
// <input type="file"> (chargerImage/chargerMediaPhoto/chargerFondDepuisFichier).
async function chargerFichierDepuisUrl(url, nomSuggere) {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`Téléchargement échoué (${reponse.status}) : ${url}`);
  const blob = await reponse.blob();
  return new File([blob], nomSuggere || 'asset', { type: blob.type });
}

function trouverPhoto(id) {
  const p = EditorState.photos.find((x) => x.id === id);
  if (!p) throw new Error(`Aucune photo avec l'id ${id}`);
  return p;
}

function trouverTextBlock(id) {
  const b = EditorState.textBlocks.find((x) => x.id === id);
  if (!b) throw new Error(`Aucun bloc de texte avec l'id ${id}`);
  return b;
}

// Rend une frame à un champ de vision élargi (recul de la caméra) pour
// révéler les calques positionnés hors du cadre normal d'export (x/y en
// dehors de 0..1) — invisibles dans l'export final mais bien présents dans
// le projet. zoomOut=1 = cadre normal, 2.2 ≈ voit de -0.5 à 1.5 sur chaque
// axe. Restaure la caméra normale immédiatement après capture.
function rendreVueEtendue(zoomOut) {
  const ts = EditorState.three;
  if (!ts) return null;
  const distanceNormale = ts.camera.position.z;
  ts.camera.position.z = ts.distance * (zoomOut || 1);
  ts.camera.updateProjectionMatrix();
  renderEditorFrame();
  const dataUrl = ts.renderer.domElement.toDataURL('image/png');
  ts.camera.position.z = distanceNormale;
  ts.camera.updateProjectionMatrix();
  return dataUrl;
}

function serialiserPhoto(p) {
  const { img, bgOverrideVideoEl, bgOverrideImageEl, sousMedias, ...donnees } = p;
  return {
    ...donnees,
    hasMedia: !!img,
    bgOverrideHasMedia: !!(bgOverrideVideoEl || bgOverrideImageEl),
    sousMedias: (sousMedias || []).map(serialiserPhoto),
  };
}

function serialiserTextBlock(b) {
  return { ...b };
}

function serialiserSegmentIntroOutro(seg) {
  const { logoImg, img, ...donnees } = seg;
  return { ...donnees, hasLogo: !!logoImg, hasImg: !!img };
}

window.PlayTesteurAPI = {
  version: '1.0',

  /* ---- État / lecture ------------------------------------------------ */

  // Snapshot JSON-sérialisable complet de l'état du projet (aucun élément
  // DOM/média — utiliser hasMedia/hasLogo/hasImg pour savoir si un média
  // est chargé sans transmettre l'objet lui-même).
  getState() {
    const { dureeTotale } = calculerTimeline();
    return {
      bgType: EditorState.bgType,
      bgColor: EditorState.bgColor,
      bgGradient: { ...EditorState.bgGradient },
      bgAdjust: { ...EditorState.bgAdjust },
      overlay: { ...EditorState.overlay },
      bgChromaKey: { ...EditorState.bgChromaKey },
      hasBgMedia: !!(EditorState.bgVideoEl || EditorState.bgImageEl),
      audioVolume: EditorState.audioVolume,
      audioFadeIn: EditorState.audioFadeIn,
      audioFadeOut: EditorState.audioFadeOut,
      audioTrimStart: EditorState.audioTrimStart,
      hasAudio: !!EditorState.audioEl,
      voiceVolume: EditorState.voiceVolume,
      hasVoice: !!EditorState.voiceEl,
      hasCustomFont: !!EditorState.fontFamily,
      intro: serialiserSegmentIntroOutro(EditorState.intro),
      outro: serialiserSegmentIntroOutro(EditorState.outro),
      photos: EditorState.photos.map(serialiserPhoto),
      textBlocks: EditorState.textBlocks.map(serialiserTextBlock),
      effects: { ...EditorState.effects },
      transitionType: EditorState.transitionType,
      imageExportFormat: EditorState.imageExportFormat,
      exportFps: EditorState.exportFps,
      modeContours: EditorState.modeContours,
      dureeTotale,
      playback: { currentTime: EditorState.playback.currentTime, playing: EditorState.playback.playing },
      historique: { peutAnnuler: Historique.index > 0, peutRefaire: Historique.index < Historique.pile.length - 1 },
    };
  },

  /* ---- Fond & musique -------------------------------------------------- */

  async setBackground({ type, url, color, gradient } = {}) {
    if (url) {
      const file = await chargerFichierDepuisUrl(url, 'fond');
      await chargerFondDepuisFichier(file);
    } else if (type === 'color') {
      EditorState.bgType = 'color';
    } else if (type === 'gradient') {
      EditorState.bgType = 'gradient';
    }
    if (color) EditorState.bgColor = color;
    if (gradient) Object.assign(EditorState.bgGradient, gradient);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  setBackgroundAdjust(patch) {
    Object.assign(EditorState.bgAdjust, patch);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  setOverlay(patch) {
    Object.assign(EditorState.overlay, patch);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  setBackgroundChromaKey(patch) {
    Object.assign(EditorState.bgChromaKey, patch);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  async setMusic(url, { volume, fadeIn, fadeOut, trimStart } = {}) {
    const file = await chargerFichierDepuisUrl(url, 'musique.mp3');
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    EditorState.audioEl = audio;
    brancherAnalyseurAudio(audio);
    calculerWaveform(file);
    if (volume != null) EditorState.audioVolume = volume;
    if (fadeIn != null) EditorState.audioFadeIn = fadeIn;
    if (fadeOut != null) EditorState.audioFadeOut = fadeOut;
    if (trimStart != null) EditorState.audioTrimStart = trimStart;
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  async setVoiceOver(url, { volume } = {}) {
    const file = await chargerFichierDepuisUrl(url, 'voix.mp3');
    const voice = new Audio();
    voice.src = URL.createObjectURL(file);
    voice.crossOrigin = 'anonymous';
    EditorState.voiceEl = voice;
    brancherVoixOff(voice);
    if (volume != null) EditorState.voiceVolume = volume;
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  /* ---- Intro / outro ---------------------------------------------------- */

  async setIntro({ active, texte, duree, logoUrl, imgUrl } = {}) {
    if (active != null) EditorState.intro.active = active;
    if (texte != null) EditorState.intro.texte = texte;
    if (duree != null) EditorState.intro.duree = Math.max(0.5, Number(duree) || 3);
    if (logoUrl) EditorState.intro.logoImg = await chargerImage(await chargerFichierDepuisUrl(logoUrl, 'logo'));
    if (imgUrl) EditorState.intro.img = await chargerImage(await chargerFichierDepuisUrl(imgUrl, 'intro'));
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  async setOutro({ active, texte, duree, logoUrl, imgUrl } = {}) {
    if (active != null) EditorState.outro.active = active;
    if (texte != null) EditorState.outro.texte = texte;
    if (duree != null) EditorState.outro.duree = Math.max(0.5, Number(duree) || 3);
    if (logoUrl) EditorState.outro.logoImg = await chargerImage(await chargerFichierDepuisUrl(logoUrl, 'logo'));
    if (imgUrl) EditorState.outro.img = await chargerImage(await chargerFichierDepuisUrl(imgUrl, 'outro'));
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  /* ---- Calques photo (couvre tous les champs : forme, filtres, crop,   */
  /* fond par calque, clé chromatique, rotation 3D, Saber, spectre,       */
  /* particules — voir creerPhotoParDefaut pour la liste exhaustive) ---- */

  // options.url (requis) : image ou vidéo. Le reste des champs de
  // creerPhotoParDefaut() peut être fourni directement (x, y, z, rotX,
  // rotY, rotZ, scale, texte, duree, saberActive, spectrumActive,
  // chromaKeyActive, maskShape, borderColor, imgBrightness, cropX...).
  async addPhoto({ url, ...patch } = {}) {
    if (!url) throw new Error('addPhoto requiert options.url');
    const id = ++elementIdCounter;
    const photo = creerPhotoParDefaut(id);
    Object.assign(photo, patch);
    photo.img = await chargerMediaPhoto(await chargerFichierDepuisUrl(url, 'photo'));
    EditorState.photos.push(photo);
    rafraichirListePhotos();
    pousserHistorique();
    return id;
  },

  async updatePhoto(id, patch = {}) {
    const p = trouverPhoto(id);
    if (patch.url) {
      p.img = await chargerMediaPhoto(await chargerFichierDepuisUrl(patch.url, 'photo'));
    }
    if (patch.bgOverrideUrl) {
      const file = await chargerFichierDepuisUrl(patch.bgOverrideUrl, 'fond-photo');
      if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        try { await video.play(); } catch (_) {}
        p.bgOverrideVideoEl = video;
      } else {
        p.bgOverrideImageEl = await chargerImage(file);
      }
    }
    const { url, bgOverrideUrl, id: _ignoreId, ...reste } = patch;
    Object.assign(p, reste);
    rafraichirListePhotos();
    pousserHistorique();
  },

  removePhoto(id) {
    trouverPhoto(id); // lève si absent
    supprimerCalquePhoto(id);
  },

  reorderPhotos(idsDansLOrdre) {
    const parId = new Map(EditorState.photos.map((p) => [p.id, p]));
    const reordonnes = idsDansLOrdre.map((id) => parId.get(id)).filter(Boolean);
    if (reordonnes.length !== EditorState.photos.length) {
      throw new Error('reorderPhotos: la liste doit contenir exactement tous les id de photos existants');
    }
    EditorState.photos = reordonnes;
    rafraichirListePhotos();
    pousserHistorique();
  },

  /* ---- Blocs de texte (couvre tous les champs : police, style,        */
  /* animation, fenêtre temporelle, rotation 3D, glow, Saber, particules) */

  addTextBlock({ ...patch } = {}) {
    const id = ++elementIdCounter;
    const decalage = (EditorState.textBlocks.length % 5) * 0.06;
    const bloc = creerTextBlockParDefaut(id, decalage);
    Object.assign(bloc, patch);
    EditorState.textBlocks.push(bloc);
    rafraichirListeTextBlocks();
    pousserHistorique();
    return id;
  },

  updateTextBlock(id, patch = {}) {
    const b = trouverTextBlock(id);
    const { id: _ignoreId, ...reste } = patch;
    Object.assign(b, reste);
    rafraichirListeTextBlocks();
    pousserHistorique();
  },

  removeTextBlock(id) {
    trouverTextBlock(id);
    supprimerBlocTexte(id);
  },

  /* ---- Effets globaux, transition, format --------------------------- */

  setEffects(patch) {
    Object.assign(EditorState.effects, patch);
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  setTransition(type) {
    EditorState.transitionType = type;
    rafraichirPanneauApresRestauration();
    pousserHistorique();
  },

  setImageExportFormat(format) {
    EditorState.imageExportFormat = format;
    rafraichirPanneauApresRestauration();
  },

  setExportFps(fps) {
    EditorState.exportFps = fps;
    const select = document.getElementById('editor-export-fps');
    if (select) select.value = String(fps);
  },

  /* ---- Lecture / navigation timeline ---------------------------------- */

  play() {
    EditorState.playback.playing = true;
  },
  pause() {
    EditorState.playback.playing = false;
  },
  seek(t) {
    EditorState.playback.currentTime = Math.max(0, t);
  },

  /* ---- Historique ------------------------------------------------------ */

  undo() {
    annulerHistorique();
  },
  redo() {
    refaireHistorique();
  },

  /* ---- Export : chaque fonction retourne le Blob produit (aucun       */
  /* download automatique déclenché — laisse l'appelant décider quoi en   */
  /* faire : sauvegarde, envoi réseau, inspection...). ------------------- */

  async exportPng() {
    return rendreImagePng();
  },

  async exportMp4({ fps, onProgress } = {}) {
    const fpsFinal = fps || EditorState.exportFps || 30;
    const webmBlob = await capturerFluxWebm({ fps: fpsFinal, setProgress: (f, t) => onProgress && onProgress(f * 0.5, t) });
    return transcoderEnMp4(webmBlob, fpsFinal, (p) => onProgress && onProgress(0.5 + p * 0.5, `Conversion… ${Math.round(p * 100)}%`));
  },

  async exportGif({ fps, onProgress } = {}) {
    const fpsFinal = Math.min(20, fps || EditorState.exportFps || 30);
    const webmBlob = await capturerFluxWebm({ fps: fpsFinal, setProgress: (f, t) => onProgress && onProgress(f * 0.5, t) });
    return transcoderEnGif(webmBlob, fpsFinal, (p) => onProgress && onProgress(0.5 + p * 0.5, `Conversion… ${Math.round(p * 100)}%`));
  },

  // Déclenche un vrai téléchargement navigateur pour un Blob déjà produit
  // par exportMp4/exportGif/exportPng (utile si l'IA veut malgré tout
  // proposer le fichier à l'utilisateur humain).
  downloadBlob(blob, filename) {
    downloadBlob(blob, filename);
  },

  /* ---- Mode IA : contours + capture complète (y compris hors-cadre) -- */

  setModeContours(actif) {
    EditorState.modeContours = !!actif;
  },

  // Capture une frame au cadrage normal (ce qui sera dans l'export),
  // en PNG dataURL — reflète le mode contours si actif.
  captureApercu() {
    const ts = EditorState.three;
    if (!ts) return null;
    renderEditorFrame();
    return ts.renderer.domElement.toDataURL('image/png');
  },

  // Capture avec un champ de vision élargi (zoomOut, défaut 2.2) pour
  // révéler les calques positionnés hors du cadre normal d'export —
  // invisibles dans la vidéo/image finale mais bien présents dans le
  // projet (utile pour repérer un asset mal placé). N'affecte pas le
  // mode contours : combiner avec setModeContours(true) pour une vue
  // "plan du montage" complète, ou le laisser désactivé pour une vue
  // visuelle complète (rendu normal, juste dézoomé).
  captureVueComplete(zoomOut) {
    return rendreVueEtendue(zoomOut || 2.2);
  },

  // Enregistre une fonction rappelée à intervalle régulier avec le
  // résultat de captureVueComplete() — "envoi automatique" de captures
  // pour un pilotage IA qui surveille la disposition en continu sans
  // avoir à interroger explicitement à chaque étape. Retourne une
  // fonction pour arrêter l'envoi.
  demarrerCaptureAuto(callback, intervalleMs) {
    const id = setInterval(() => {
      try {
        callback({ apercu: this.captureApercu(), vueComplete: this.captureVueComplete(), etat: this.getState() });
      } catch (err) {
        console.error('[PlayTesteurAPI] erreur capture auto', err);
      }
    }, intervalleMs || 2000);
    return () => clearInterval(id);
  },
};
