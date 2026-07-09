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

  intro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  outro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  photos: [], // [{ id, img, x, y, z, rotX, rotY, rotZ, scale, texte, duree }]

  // [{ id, texte, x, y, z, fontFamily, size, color, bold, italic, align,
  //    anim, startTime, endTime }] — plusieurs blocs de texte libres
  // indépendants, chacun avec son propre style, sa fenêtre d'affichage
  // (null = du début/jusqu'à la fin) et son animation d'entrée/sortie.
  textBlocks: [],

  playback: { playing: false, currentTime: 0, lastFrameTs: null },
  // État de l'export : quand `exporting` est actif, `avancerPlayback` freine
  // l'avancée de la timeline (et des médias audio/vidéo) via
  // `exportPlaybackRate` si le rendu réel n'arrive pas à suivre le FPS
  // demandé, plutôt que de sacrifier des images — l'export prend alors
  // plus de temps réel mais reste complet et fluide au FPS choisi.
  exporting: false,
  exportFps: 30,
  exportPlaybackRate: 1,
  _exportRafTs: null,
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
  'fontFamily', 'intro', 'outro', 'photos', 'textBlocks', 'imageExportFormat',
  'effects', 'transitionType',
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
}

function restaurerSnapshot(snap) {
  Historique.enPause = true;
  for (const champ of CHAMPS_HISTORIQUE) EditorState[champ] = cloneProfondSansDom(snap[champ]);
  for (const champ of CHAMPS_HISTORIQUE_REFS) EditorState[champ] = snap[champ];
  rafraichirListePhotos();
  rafraichirListeTextBlocks();
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

  setVal('editor-audio-volume', Math.round(EditorState.audioVolume * 100));
  setVal('editor-audio-fadein', EditorState.audioFadeIn);
  setVal('editor-audio-fadeout', EditorState.audioFadeOut);
  setVal('editor-audio-trim', EditorState.audioTrimStart);
  setVal('editor-voice-volume', Math.round(EditorState.voiceVolume * 100));

  ['intro', 'outro'].forEach((prefix) => {
    const seg = EditorState[prefix];
    setChecked(`editor-${prefix}-toggle`, seg.active);
    toggleHidden(`editor-${prefix}-panel`, !seg.active);
    setVal(`editor-${prefix}-text`, seg.texte || '');
    setVal(`editor-${prefix}-duree`, seg.duree);
  });

  setVal('editor-transition-type', EditorState.transitionType);
  setChecked('editor-bloom-toggle', EditorState.effects.bloomActive);
  setVal('editor-bloom-strength', Math.round(EditorState.effects.bloomStrength * 20));
  setChecked('editor-bloom-audioreactive', EditorState.effects.bloomAudioReactive);

  const formatRadio = document.querySelector(`input[name="editor-img-format"][value="${EditorState.imageExportFormat}"]`);
  if (formatRadio) formatRadio.checked = true;

  document.querySelectorAll('.editor-controls input[type="range"]').forEach((input) => {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = ((Number(input.value) - min) / (max - min || 1)) * 100;
    input.style.setProperty('--range-progress', `${pct}%`);
  });
}

const FONTS_DISPONIBLES = [
  { value: "'Space Grotesk', sans-serif", label: 'Space Grotesk' },
  { value: "'Roboto', sans-serif", label: 'Roboto' },
  { value: "'Bebas Neue', sans-serif", label: 'Bebas Neue' },
  { value: "'Anton', sans-serif", label: 'Anton' },
  { value: "'Caveat', cursive", label: 'Caveat (manuscrite)' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
];

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
  rafraichirListePhotos();
  rafraichirListeTextBlocks();

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
      const delta = ((now - EditorState.playback.lastFrameTs) / 1000) * (EditorState.exporting ? EditorState.exportPlaybackRate : 1);
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

  playBtn.addEventListener('click', () => {
    const { dureeTotale } = calculerTimeline();
    if (dureeTotale <= 0) return;
    if (EditorState.playback.currentTime >= dureeTotale - 0.02) EditorState.playback.currentTime = 0;
    EditorState.playback.playing = !EditorState.playback.playing;
    EditorState.playback.lastFrameTs = null;
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
// 'hexagon' = hexagone régulier inscrit.
function maskShapePath(ctx, shape, x, y, w, h, r) {
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === 'hexagon') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      const px = cx + (w / 2) * Math.cos(a);
      const py = cy + (h / 2) * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
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
  // Ombre portée qui déborde du masque, sans remplir l'intérieur en noir
  // opaque : sinon les PNG à fond transparent laissaient voir ce noir à
  // travers leurs zones transparentes au lieu du fond de la scène. On
  // peint le fill + son flou débordant, puis on efface la partie
  // intérieure (destination-out) — il ne reste que le halo qui dépasse.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = h * 0.14;
  ctx.shadowOffsetY = h * 0.08;
  maskShapePath(ctx, shape, ox, oy, w, h, radius);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'destination-out';
  maskShapePath(ctx, shape, ox, oy, w, h, radius);
  ctx.fill();
  ctx.restore();

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
    const size = Math.max(18, Math.round(width * 0.03));
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

function blocTexteActif(b, now) {
  if (b.startTime != null && now < b.startTime) return false;
  if (b.endTime != null && now > b.endTime) return false;
  return true;
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
// pour fondu/glissement/pop) — réutilisée pour le glow et le texte final.
function dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress) {
  if (anim === 'typewriter') {
    const texteComplet = lignes.join('\n');
    const nVisible = Math.round(progress * texteComplet.length);
    let compte = 0;
    lignes.forEach((ligne, i) => {
      const restant = Math.max(0, nVisible - compte);
      ctx.fillText(ligne.slice(0, restant), textX, padY + i * lineHeight);
      compte += ligne.length;
    });
  } else {
    const alphaAvant = ctx.globalAlpha;
    ctx.globalAlpha = (anim === 'fade' || anim === 'slide' || anim === 'pop' ? progress : 1) * alphaAvant;
    lignes.forEach((ligne, i) => ctx.fillText(ligne, textX, padY + i * lineHeight));
    ctx.globalAlpha = alphaAvant;
  }
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
  const maxWidth = width * (b.wrapWidth || 0.85);
  const lignes = wrapText(measureCtx, b.texte, maxWidth);
  const lineHeight = size * 1.2;
  const totalHeight = lineHeight * lignes.length;
  let boxW = 0;
  lignes.forEach((ligne) => {
    boxW = Math.max(boxW, measureCtx.measureText(ligne).width);
  });
  const padX = 26;
  const padY = 18;
  const panelW = boxW + padX * 2;
  const panelH = totalHeight + padY * 2;

  sizeLayerCanvas(layer, panelW, panelH);
  const ctx = layer.ctx;
  ctx.clearRect(0, 0, panelW, panelH);

  const anim = b.anim || 'none';
  const dureeAnim = 0.5;
  const progress = progressionAnimation(b.startTime, b.endTime, now, dureeAnim);

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
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const textX = align === 'left' ? padX : align === 'right' ? panelW - padX : panelW / 2;

  if (b.glowActive) {
    ctx.save();
    ctx.fillStyle = b.glowColor || '#00e5ff';
    ctx.shadowColor = b.glowColor || '#00e5ff';
    ctx.shadowBlur = 32;
    dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress);
    ctx.shadowBlur = 16;
    dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress);
    ctx.restore();
  }

  ctx.fillStyle = b.color || '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  dessinerPasseTexte(ctx, lignes, textX, padY, lineHeight, anim, progress);
  ctx.shadowBlur = 0;

  if (b.saberActive) {
    dessinerContourEnergetique(
      ctx, 0, 0, panelW, panelH, 18, b.saberColor || '#00e5ff', tGlobal || 0,
      b.saberCount, b.saberSize
    );
  }
  }

  let cx = b.x * width;
  let cy = b.y * height;
  let scaleMul = 1;
  if (anim === 'slide') {
    cx += (1 - progress) * width * 0.15;
  } else if (anim === 'pop') {
    scaleMul = 0.6 + 0.4 * progress;
  }

  const rotX = ((b.rotX || 0) * Math.PI) / 180;
  const rotY = ((b.rotY || 0) * Math.PI) / 180;
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

// Applique le ralentissement d'export à tous les médias en cours de
// lecture, pour qu'ils restent synchronisés avec la timeline freinée.
function appliquerExportPlaybackRate(rate) {
  const r = Math.max(0.1, Math.min(1, rate));
  if (EditorState.audioEl) EditorState.audioEl.playbackRate = r;
  if (EditorState.voiceEl) EditorState.voiceEl.playbackRate = r;
  if (EditorState.bgVideoEl) EditorState.bgVideoEl.playbackRate = r;
  EditorState.photos.forEach((p) => {
    if (p.img && p.img.tagName === 'VIDEO') p.img.playbackRate = r;
    if (p.bgOverrideVideoEl) p.bgOverrideVideoEl.playbackRate = r;
  });
}

// Mesure, pendant un export, l'écart entre le temps réel écoulé entre deux
// images et le budget du FPS demandé. Si le rendu (beaucoup de photos,
// d'effets Saber/spectre, de bloom…) est plus lent que ce budget, réduit
// `exportPlaybackRate` (lissé) pour ralentir la timeline et les médias en
// conséquence — l'export dure alors plus longtemps en temps réel, mais
// aucune image n'est sacrifiée et le FPS choisi est respecté.
function ajusterCadenceExport() {
  const nowRaf = performance.now();
  if (EditorState._exportRafTs != null) {
    const frameDelta = nowRaf - EditorState._exportRafTs;
    const budget = 1000 / (Number(EditorState.exportFps) || 30);
    const cible = Math.min(1, budget / Math.max(frameDelta, 0.001));
    EditorState.exportPlaybackRate = EditorState.exportPlaybackRate * 0.85 + cible * 0.15;
    appliquerExportPlaybackRate(EditorState.exportPlaybackRate);
  }
  EditorState._exportRafTs = nowRaf;
}

function renderEditorFrame() {
  const ts = EditorState.three;
  if (!ts) return;
  if (EditorState.exporting) ajusterCadenceExport();

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

  EditorState._textBoxes = mettreAJourBlocsTexte(EditorState.playback.currentTime, tGlobal);

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
      toast('Police chargée, appliquée au texte.', 'success');
    } catch (err) {
      toast('Impossible de charger cette police.', 'error');
    }
  });

  addTextBlockBtn.addEventListener('click', ajouterBlocTexte);

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
function markupFilePickerPhoto(inputId, filenameId) {
  return `
    <div class="editor-file-picker-wrap">
      <label class="editor-file-picker" for="${inputId}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        <span>Choisir un fichier</span>
      </label>
      <input type="file" id="${inputId}" accept="image/png,image/jpeg,video/mp4" class="editor-file-input">
      <span class="editor-file-name" id="${filenameId}">Aucun fichier choisi</span>
    </div>
  `;
}

function renderPhotoLayerHtml(p, index) {
  return `
    <div class="editor-photo-layer" draggable="true" data-photo-drag="${p.id}">
      <div class="editor-photo-layer-head">
        <span class="editor-photo-layer-title" title="Glisser pour réordonner">&#9776; Photo ${index + 1}</span>
        <button type="button" class="editor-remove-btn" data-remove-photo="${p.id}" title="Supprimer cette photo">&times;</button>
      </div>
      ${markupFilePickerPhoto(`editor-photo-input-${p.id}`, `editor-photo-filename-${p.id}`)}
      <textarea class="editor-photo-caption" data-caption-for="${p.id}" rows="2" placeholder="Texte lié à cette photo...">${p.texte || ''}</textarea>
      <div class="editor-row">
        <label class="editor-mini-label">Taille<input type="range" data-scale-for="${p.id}" min="5" max="80" value="${Math.round(p.scale * 100)}"></label>
        <label class="editor-mini-label">Durée (s)<input type="number" data-duree-for="${p.id}" min="0.5" max="30" step="0.5" value="${p.duree}" style="max-width:80px;"></label>
      </div>

      <details class="editor-accordion-nested">
        <summary>Forme &amp; bordure</summary>
        <div class="editor-accordion-nested-body">
          <div class="editor-row">
            <select data-shape-for="${p.id}">
              <option value="rect" ${(!p.maskShape || p.maskShape === 'rect') ? 'selected' : ''}>Rectangle arrondi</option>
              <option value="circle" ${p.maskShape === 'circle' ? 'selected' : ''}>Cercle / ellipse</option>
              <option value="hexagon" ${p.maskShape === 'hexagon' ? 'selected' : ''}>Hexagone</option>
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
          <span class="form-hint">Haut/Gauche déplacent le point de départ du recadrage, Largeur/Hauteur ajustent la zone gardée de l'image originale.</span>
        </div>
      </details>

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
    </div>
  `;
}

function bindPhotoLayerEvents() {
  EditorState.photos.forEach((p) => {
    const jump = () => allerAuSegment((s) => s.type === 'photo' && s.data.id === p.id);

    const fileInput = document.getElementById(`editor-photo-input-${p.id}`);
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        afficherNomFichier(`editor-photo-filename-${p.id}`, file);
        p.img = await chargerMediaPhoto(file);
        jump();
      });
    }
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
    if (cropWInput) cropWInput.addEventListener('input', (e) => (p.cropW = Number(e.target.value) / 100));
    const cropHInput = document.querySelector(`[data-croph-for="${p.id}"]`);
    if (cropHInput) cropHInput.addEventListener('input', (e) => (p.cropH = Number(e.target.value) / 100));

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

function rafraichirListePhotos() {
  const container = document.getElementById('editor-photos-list');
  if (!container) return;
  container.innerHTML =
    EditorState.photos.map((p, i) => renderPhotoLayerHtml(p, i)).join('') ||
    '<p class="form-hint">Aucune photo ajoutée pour le moment.</p>';
  bindPhotoLayerEvents();
}

function creerPhotoParDefaut(id) {
  return {
    id,
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
    bgOverrideType: 'none', // 'none' | 'video' | 'image' | 'color'
    bgOverrideVideoEl: null,
    bgOverrideImageEl: null,
    bgOverrideColor: '#12151c',
    chromaKeyActive: false,
    chromaKeyColor: '#00ff00',
    chromaKeyTolerance: 0.35,
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
  EditorState.photos = EditorState.photos.filter((p) => p.id !== id);
  rafraichirListePhotos();
  pousserHistorique();
}

/* -------------------------------------------------------------------- */
/* Blocs de texte multiples (police, style, animation, fenêtre de temps) */
/* -------------------------------------------------------------------- */
function optionsFontsHtml(selected) {
  return FONTS_DISPONIBLES.map(
    (f) => `<option value="${f.value}" ${f.value === selected ? 'selected' : ''}>${f.label}</option>`
  ).join('') + `<option value="custom" ${selected === 'custom' ? 'selected' : ''}>Police importée</option>`;
}

function renderTextBlockHtml(b, index) {
  return `
    <div class="editor-photo-layer">
      <div class="editor-photo-layer-head">
        <span class="editor-photo-layer-title">Texte ${index + 1}</span>
        <button type="button" class="editor-remove-btn" data-remove-textblock="${b.id}" title="Supprimer ce texte">&times;</button>
      </div>
      <textarea data-texte-for="${b.id}" rows="2" placeholder="Votre texte...">${b.texte || ''}</textarea>

      <details class="editor-accordion-nested">
        <summary>Style</summary>
        <div class="editor-accordion-nested-body">
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
            <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" data-bgpanel-for="${b.id}" ${b.bgPanelActive !== false ? 'checked' : ''}><span class="editor-toggle-switch"></span><span>Fond derrière le texte</span></label>
          </div>
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
                <option value="typewriter" ${b.anim === 'typewriter' ? 'selected' : ''}>Machine à écrire</option>
              </select>
            </label>
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

    const bgPanelInput = document.querySelector(`[data-bgpanel-for="${b.id}"]`);
    if (bgPanelInput) bgPanelInput.addEventListener('change', (e) => (b.bgPanelActive = e.target.checked));

    const animInput = document.querySelector(`[data-anim-for="${b.id}"]`);
    if (animInput) animInput.addEventListener('change', (e) => (b.anim = e.target.value));

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
}

function creerTextBlockParDefaut(id, decalage) {
  return {
    id,
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
  EditorState.textBlocks = EditorState.textBlocks.filter((b) => b.id !== id);
  hideLayer(`text-${id}`);
  const ts = EditorState.three;
  if (ts && ts.particleSystems[`text-particles-${id}`]) {
    ts.particleSystems[`text-particles-${id}`].points.visible = false;
  }
  rafraichirListeTextBlocks();
  pousserHistorique();
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

function bindEditorDrag3D(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    const layers = EditorState.three.layers;
    const textLayerNames = nomsTextLayerNames();
    const textHit = raycastLayer(canvas, e, textLayerNames);
    if (textHit) {
      const id = Number(textLayerNames.find((n) => layers[n] && layers[n].mesh === textHit.object).replace('text-', ''));
      EditorState.dragging = { type: 'textblock', id };
    } else if (layers.caption && layers.caption.mesh.visible && raycastLayer(canvas, e, ['caption'])) {
      const p = calquePhotoActif();
      if (p) EditorState.dragging = { type: 'caption', id: p.id };
    } else if (layers.photo && layers.photo.mesh.visible && raycastLayer(canvas, e, ['photo'])) {
      const p = calquePhotoActif();
      if (p) EditorState.dragging = { type: 'photo', id: p.id };
    }
    if (EditorState.dragging) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!EditorState.dragging) {
      const survole =
        raycastLayer(canvas, e, [...nomsTextLayerNames(), 'caption', 'photo']) !== null;
      canvas.style.cursor = survole ? 'grab' : 'default';
      return;
    }
    canvas.style.cursor = 'grabbing';
    if (EditorState.dragging.type === 'textblock') {
      const b = EditorState.textBlocks.find((tb) => tb.id === EditorState.dragging.id);
      const frac = b && pointerToFraction(canvas, e, b.z ?? 10);
      if (b && frac) {
        b.x = frac.fx;
        b.y = frac.fy;
      }
    } else if (EditorState.dragging.type === 'photo') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      const frac = p && pointerToFraction(canvas, e, p.z || 0);
      if (p && frac) {
        p.x = frac.fx;
        p.y = frac.fy;
      }
    } else if (EditorState.dragging.type === 'caption') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      const frac = p && pointerToFraction(canvas, e, (p.z || 0) + 2);
      if (p && frac) {
        p.texteX = frac.fx;
        p.texteY = frac.fy;
      }
    }
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evtName) => {
    canvas.addEventListener(evtName, () => {
      if (EditorState.dragging) pousserHistorique();
      EditorState.dragging = null;
      canvas.style.cursor = 'default';
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

// Capture la timeline en webm (vidéo + audio) au FPS demandé, en freinant
// automatiquement la lecture (voir `ajusterCadenceExport`) si le rendu réel
// n'arrive pas à suivre — l'export dure alors plus longtemps en temps réel
// plutôt que de perdre des images. Réutilisé par les exports MP4 et GIF.
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
  EditorState.exportPlaybackRate = 1;
  EditorState._exportRafTs = null;
  EditorState.playback.currentTime = 0;
  EditorState.playback.lastFrameTs = null;
  EditorState.playback.playing = true;

  const finEnregistrement = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const tick = setInterval(() => {
    const frac = dureeTotale > 0 ? EditorState.playback.currentTime / dureeTotale : 0;
    const ralenti = EditorState.exportPlaybackRate < 0.92;
    setProgress(
      Math.min(0.5, frac * 0.5),
      ralenti
        ? `Rendu en cours (ralenti pour garder ${fps} im/s)… ${Math.round(frac * 100)}%`
        : undefined
    );
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
  appliquerExportPlaybackRate(1);
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
  const { img, bgOverrideVideoEl, bgOverrideImageEl, ...donnees } = p;
  return { ...donnees, hasMedia: !!img, bgOverrideHasMedia: !!(bgOverrideVideoEl || bgOverrideImageEl) };
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
