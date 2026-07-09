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
  bgType: null, // 'video' | 'image' | null
  bgVideoEl: null,
  bgImageEl: null,
  audioEl: null,
  fontFamily: null,

  intro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  outro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  photos: [], // [{ id, img, x, y, z, rotX, rotY, rotZ, scale, texte, duree }]

  text: '',
  textStyle: { color: '#ffffff', size: 56, x: 0.5, y: 0.85 },

  playback: { playing: false, currentTime: 0, lastFrameTs: null },
  _scrubbing: false,

  imageExportFormat: 'playstore', // 'playstore' (1080x1920) | 'square' (1080x1080)

  effects: { bloomActive: false, bloomStrength: 1.1 },

  dragging: null, // null | 'text' | { type:'photo', id } | { type:'caption', id }
  _textBox: null,
  audioCtx: null,
  audioSourceCache: null,

  three: null, // rempli par initMoteur3D()
};

let editorRafId = null;
let photoLayerCounter = 0;

function arreterEditeur() {
  if (editorRafId) {
    cancelAnimationFrame(editorRafId);
    editorRafId = null;
  }
}

async function initEditeur() {
  const canvas = document.getElementById('editor-canvas');
  if (!canvas) return;

  bindEditorInputs();
  bindTimelineControls();
  rafraichirListePhotos();

  arreterEditeur();
  await initMoteur3D(canvas);
  bindEditorDrag3D(canvas);

  (function loop() {
    renderEditorFrame();
    editorRafId = requestAnimationFrame(loop);
  })();
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
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.1, 0.55, 0.15);
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
      freeText: null,
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
  const mesh = new THREE.Mesh(geometry, material);
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

// Fond : texture vidéo/image "cover" appliquée directement sur le plan
// de fond (pas besoin de composition hors-écran, three.js gère la
// texture vidéo nativement).
function mettreAJourFond() {
  const ts = EditorState.three;
  const { THREE } = ts;

  if (EditorState.bgType === 'video' && EditorState.bgVideoEl && EditorState.bgVideoEl.readyState >= 2) {
    if (ts.bgSourceEl !== EditorState.bgVideoEl) {
      ts.bgTexture = new THREE.VideoTexture(EditorState.bgVideoEl);
      ts.bgTexture.colorSpace = THREE.SRGBColorSpace;
      ts.bgMesh.material.map = ts.bgTexture;
      ts.bgMesh.material.color.set(0xffffff);
      ts.bgMesh.material.needsUpdate = true;
      ts.bgSourceEl = EditorState.bgVideoEl;
    }
    const mw = EditorState.bgVideoEl.videoWidth;
    const mh = EditorState.bgVideoEl.videoHeight;
    ajusterCoverUV(ts.bgTexture, mw, mh, ts.width, ts.height);
  } else if (EditorState.bgType === 'image' && EditorState.bgImageEl) {
    if (ts.bgSourceEl !== EditorState.bgImageEl) {
      ts.bgTexture = new THREE.Texture(EditorState.bgImageEl);
      ts.bgTexture.colorSpace = THREE.SRGBColorSpace;
      ts.bgTexture.needsUpdate = true;
      ts.bgMesh.material.map = ts.bgTexture;
      ts.bgMesh.material.color.set(0xffffff);
      ts.bgMesh.material.needsUpdate = true;
      ts.bgSourceEl = EditorState.bgImageEl;
    }
    ajusterCoverUV(ts.bgTexture, EditorState.bgImageEl.naturalWidth, EditorState.bgImageEl.naturalHeight, ts.width, ts.height);
  } else {
    ts.bgMesh.material.map = null;
    ts.bgMesh.material.color.set(0x12151c);
    ts.bgMesh.material.needsUpdate = true;
    ts.bgSourceEl = null;
  }
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
  return { px: x + w / 2, py: y };
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
// temps réel sur la musique de fond (Web Audio AnalyserNode).
function dessinerSpectreAudio(ctx, x, y, w, h, r, color, maxBarLen) {
  const analyserState = EditorState.audioAnalyser;
  if (!analyserState) return;
  analyserState.analyser.getByteFrequencyData(analyserState.dataArray);
  const data = analyserState.dataArray;
  const nBars = 48;
  ctx.save();
  for (let i = 0; i < nBars; i++) {
    const t = i / nBars;
    const { px, py } = pointOnRoundRect(x, y, w, h, r, t);
    const { nx, ny } = normaleSurRoundRect(x, y, w, h, r, t);
    const amp = data[i % data.length] / 255;
    const len = 4 + amp * maxBarLen;
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
// le bloom global si activé.
function dessinerContourEnergetique(ctx, x, y, w, h, r, color, tGlobal) {
  const nQueue = 26;
  const vitesse = 0.18; // tours par seconde
  ctx.save();
  for (let i = 0; i < nQueue; i++) {
    const tTete = (tGlobal * vitesse - i * 0.012) % 1;
    const { px, py } = pointOnRoundRect(x, y, w, h, r, tTete);
    const alpha = (1 - i / nQueue) * 0.9;
    const radius = Math.max(1.5, Math.min(w, h) * 0.018) * (1 - i / nQueue * 0.5);
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

// Photo "carte flottante" : coins arrondis, ombre douce, contour clair —
// composés sur un canvas hors-écran (comme avant) puis texturés sur un
// plan 3D. Flottement + tilt automatiques, plus rotation manuelle sur
// les 3 axes (p.rotX/rotY/rotZ, en degrés, ajoutés à l'auto-tilt).
function mettreAJourPhoto(p, tGlobal) {
  if (!p.img) {
    hideLayer('photo');
    hideLayer('caption');
    return null;
  }
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer('photo');

  const w = Math.round(width * p.scale);
  const h = Math.round(w * (p.img.naturalHeight / p.img.naturalWidth || 1));
  const margeBase = Math.ceil(Math.min(w, h) * 0.14) + 16;
  const margeSpectre = p.spectrumActive ? Math.ceil(Math.min(w, h) * 0.32) : 0;
  const marge = margeBase + margeSpectre;
  sizeLayerCanvas(layer, w + marge * 2, h + marge * 2);

  const ctx = layer.ctx;
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  const ox = marge;
  const oy = marge;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = h * 0.14;
  ctx.shadowOffsetY = h * 0.08;
  roundRectPath(ctx, ox, oy, w, h, Math.min(w, h) * 0.06);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, ox, oy, w, h, Math.min(w, h) * 0.06);
  ctx.clip();
  ctx.drawImage(p.img, ox, oy, w, h);
  ctx.restore();

  ctx.lineWidth = Math.max(1, w * 0.003);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  roundRectPath(ctx, ox, oy, w, h, Math.min(w, h) * 0.06);
  ctx.stroke();

  if (p.saberActive) {
    dessinerContourEnergetique(ctx, ox, oy, w, h, Math.min(w, h) * 0.06, p.saberColor || '#00e5ff', tGlobal);
  }
  if (p.spectrumActive) {
    dessinerSpectreAudio(ctx, ox, oy, w, h, Math.min(w, h) * 0.06, p.spectrumColor || '#ff2d95', margeSpectre * 0.85);
  }

  const phase = (p.id % 7) * 0.9;
  const floatY = Math.sin(tGlobal * 1.1 + phase) * h * 0.035;
  const autoTilt = Math.sin(tGlobal * 0.66 + phase) * 0.045;

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

function mettreAJourTexteLibre() {
  if (!EditorState.text) {
    hideLayer('freeText');
    return null;
  }
  const { width, height } = EditorState.three;
  const layer = getOrCreateCanvasLayer('freeText');
  const size = Number(EditorState.textStyle.size) || 56;
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Space Grotesk', sans-serif";

  const measureCtx = layer.ctx;
  measureCtx.font = `700 ${size}px ${famille}`;
  const maxWidth = width * 0.85;
  const lignes = wrapText(measureCtx, EditorState.text, maxWidth);
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
  roundRectPath(ctx, 0, 0, panelW, panelH, 18);
  ctx.fillStyle = 'rgba(8,10,14,0.5)';
  ctx.fill();

  ctx.font = `700 ${size}px ${famille}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = EditorState.textStyle.color;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  lignes.forEach((ligne, i) => ctx.fillText(ligne, panelW / 2, padY + i * lineHeight));
  ctx.shadowBlur = 0;

  const cx = EditorState.textStyle.x * width;
  const cy = EditorState.textStyle.y * height;
  placerLayer(layer, cx, cy, 3, 0, 0, 0);

  return { x: cx - panelW / 2, y: cy - panelH / 2, w: panelW, h: panelH, cx, cy, z: 3 };
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
function mettreAJourParticules(p, box, tGlobal) {
  const ts = EditorState.three;
  const { THREE, scene } = ts;
  const key = 'photoParticles';
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

function renderEditorFrame() {
  const ts = EditorState.three;
  if (!ts) return;

  mettreAJourFond();

  const { segments, dureeTotale } = calculerTimeline();
  avancerPlayback(dureeTotale);
  const segmentActif = segmentAuTemps(segments, EditorState.playback.currentTime);

  const tGlobal = performance.now() / 1000;
  let photoBox = null;
  if (segmentActif && segmentActif.type === 'photo') {
    hideLayer('introLogo');
    hideLayer('introImg');
    hideLayer('introText');
    photoBox = mettreAJourPhoto(segmentActif.data, tGlobal);
    mettreAJourLegende(segmentActif.data);
    mettreAJourParticules(segmentActif.data, photoBox, tGlobal);
  } else if (segmentActif) {
    hideLayer('photo');
    hideLayer('caption');
    mettreAJourIntroOutro(segmentActif.data);
    mettreAJourParticules(null, null, tGlobal);
  } else {
    hideLayer('photo');
    hideLayer('caption');
    hideLayer('introLogo');
    hideLayer('introImg');
    hideLayer('introText');
    mettreAJourParticules(null, null, tGlobal);
  }

  EditorState._textBox = mettreAJourTexteLibre();

  ts.bloomPass.enabled = EditorState.effects.bloomActive;
  ts.bloomPass.strength = Number(EditorState.effects.bloomStrength) || 0;
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
  const fontInput = document.getElementById('editor-font-input');
  const textInput = document.getElementById('editor-text-input');
  const colorInput = document.getElementById('editor-text-color');
  const sizeInput = document.getElementById('editor-text-size');
  const exportPngBtn = document.getElementById('editor-export-png');
  const exportMp4Btn = document.getElementById('editor-export-mp4');

  bgInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier('editor-bg-filename', file);
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
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
  });

  audioInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    afficherNomFichier('editor-audio-filename', file);
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    EditorState.audioEl = audio;
    audio.play().catch(() => {});
    brancherAnalyseurAudio(audio);
  });

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

  textInput.addEventListener('input', (e) => {
    EditorState.text = e.target.value;
  });
  colorInput.addEventListener('input', (e) => {
    EditorState.textStyle.color = e.target.value;
  });
  sizeInput.addEventListener('input', (e) => {
    EditorState.textStyle.size = Number(e.target.value);
  });

  const bloomToggle = document.getElementById('editor-bloom-toggle');
  const bloomStrength = document.getElementById('editor-bloom-strength');
  if (bloomToggle) {
    bloomToggle.addEventListener('change', (e) => {
      EditorState.effects.bloomActive = e.target.checked;
    });
  }
  if (bloomStrength) {
    bloomStrength.addEventListener('input', (e) => {
      EditorState.effects.bloomStrength = Number(e.target.value) / 10;
    });
  }

  document.querySelectorAll('input[name="editor-img-format"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) EditorState.imageExportFormat = e.target.value;
    });
  });

  exportPngBtn.addEventListener('click', exportEditeurPng);
  exportMp4Btn.addEventListener('click', exportEditeurMp4);
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
      <input type="file" id="${inputId}" accept="image/png" class="editor-file-input">
      <span class="editor-file-name" id="${filenameId}">Aucun fichier choisi</span>
    </div>
  `;
}

function renderPhotoLayerHtml(p, index) {
  return `
    <div class="editor-photo-layer">
      <div class="editor-photo-layer-head">
        <span class="editor-photo-layer-title">Photo ${index + 1}</span>
        <button type="button" class="editor-remove-btn" data-remove-photo="${p.id}" title="Supprimer cette photo">&times;</button>
      </div>
      ${markupFilePickerPhoto(`editor-photo-input-${p.id}`, `editor-photo-filename-${p.id}`)}
      <textarea class="editor-photo-caption" data-caption-for="${p.id}" rows="2" placeholder="Texte lié à cette photo...">${p.texte || ''}</textarea>
      <div class="editor-row">
        <label class="editor-mini-label">Taille<input type="range" data-scale-for="${p.id}" min="5" max="80" value="${Math.round(p.scale * 100)}"></label>
        <label class="editor-mini-label">Durée (s)<input type="number" data-duree-for="${p.id}" min="0.5" max="30" step="0.5" value="${p.duree}" style="max-width:80px;"></label>
      </div>
      <div class="editor-row">
        <label class="editor-mini-label">Rotation X<input type="range" data-rotx-for="${p.id}" min="-45" max="45" value="${p.rotX || 0}"></label>
        <label class="editor-mini-label">Rotation Y<input type="range" data-roty-for="${p.id}" min="-45" max="45" value="${p.rotY || 0}"></label>
        <label class="editor-mini-label">Rotation Z<input type="range" data-rotz-for="${p.id}" min="-45" max="45" value="${p.rotZ || 0}"></label>
      </div>
      <div class="editor-row">
        <label class="editor-checkbox-row" style="margin:0;"><input type="checkbox" data-saber-for="${p.id}" ${p.saberActive ? 'checked' : ''}><span>Contour énergétique</span></label>
        <input type="color" data-sabercolor-for="${p.id}" value="${p.saberColor || '#00e5ff'}" title="Couleur de l'effet">
        <label class="editor-checkbox-row" style="margin:0;"><input type="checkbox" data-particles-for="${p.id}" ${p.particlesActive ? 'checked' : ''}><span>Particules</span></label>
      </div>
      <div class="editor-row">
        <label class="editor-checkbox-row" style="margin:0;"><input type="checkbox" data-spectrum-for="${p.id}" ${p.spectrumActive ? 'checked' : ''}><span>Spectre audio (musique de fond)</span></label>
        <input type="color" data-spectrumcolor-for="${p.id}" value="${p.spectrumColor || '#ff2d95'}" title="Couleur du spectre">
      </div>
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
        p.img = await chargerImage(file);
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
  });
  document.querySelectorAll('[data-remove-photo]').forEach((btn) => {
    btn.addEventListener('click', () => supprimerCalquePhoto(Number(btn.dataset.removePhoto)));
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

function ajouterCalquePhoto() {
  const id = ++photoLayerCounter;
  EditorState.photos.push({
    id,
    img: null,
    x: 0.5,
    y: 0.45,
    z: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 0.3,
    texte: '',
    duree: 3,
    texteX: 0.5,
    texteY: 0.72,
    saberActive: false,
    saberColor: '#00e5ff',
    particlesActive: false,
    spectrumActive: false,
    spectrumColor: '#ff2d95',
  });
  rafraichirListePhotos();
  allerAuSegment((s) => s.type === 'photo' && s.data.id === id);
}

function supprimerCalquePhoto(id) {
  EditorState.photos = EditorState.photos.filter((p) => p.id !== id);
  rafraichirListePhotos();
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

function bindEditorDrag3D(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    const layers = EditorState.three.layers;
    if (layers.freeText && layers.freeText.mesh.visible && raycastLayer(canvas, e, ['freeText'])) {
      EditorState.dragging = 'text';
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
        raycastLayer(canvas, e, ['freeText', 'caption', 'photo']) !== null;
      canvas.style.cursor = survole ? 'grab' : 'default';
      return;
    }
    canvas.style.cursor = 'grabbing';
    if (EditorState.dragging === 'text') {
      const frac = pointerToFraction(canvas, e, 3);
      if (frac) {
        EditorState.textStyle.x = frac.fx;
        EditorState.textStyle.y = frac.fy;
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
function exportEditeurPng() {
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

  canvas.toBlob((blob) => {
    // Restaure la taille d'aperçu normale.
    ts.renderer.setSize(tailleOriginale.w, tailleOriginale.h, false);
    ts.camera.aspect = tailleOriginale.w / tailleOriginale.h;
    ts.camera.position.z = ts.distance;
    ts.camera.updateProjectionMatrix();
    ts.width = tailleOriginale.w;
    ts.height = tailleOriginale.h;
    ts.bgMesh.scale.set(tailleOriginale.w, tailleOriginale.h, 1);

    if (blob) downloadBlob(blob, `${obtenirNomExport('playtesteur-visuel')}.png`);
  }, 'image/png');
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

async function transcoderEnMp4(webmBlob, onProgress) {
  const ffmpeg = await getFfmpeg();
  const onFfmpegProgress = ({ progress }) => onProgress(Math.min(1, Math.max(0, progress)));
  ffmpeg.on('progress', onFfmpegProgress);
  try {
    const donneesEntree = new Uint8Array(await webmBlob.arrayBuffer());
    await ffmpeg.writeFile('entree.webm', donneesEntree);
    // Preset "slow" + CRF bas : encodage plus lent mais meilleure qualité,
    // conforme au 1920x1080/60fps de la capture.
    await ffmpeg.exec([
      '-i', 'entree.webm',
      '-r', '60',
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
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  source.connect(audioCtx.destination);
  EditorState.audioAnalyser = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
}

async function exportEditeurMp4() {
  const btnMp4 = document.getElementById('editor-export-mp4');
  const btnPng = document.getElementById('editor-export-png');
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

  btnMp4.disabled = true;
  btnPng.disabled = true;
  progressWrap.classList.remove('hidden');
  setProgress(0, 'Préparation…');

  let audioCtx = null;
  try {
    const canvas = document.getElementById('editor-canvas');
    const canvasStream = canvas.captureStream(60);
    const tracks = [...canvasStream.getVideoTracks()];

    if (EditorState.audioEl || EditorState.bgVideoEl) {
      audioCtx = getSharedAudioCtx();
      const dest = audioCtx.createMediaStreamDestination();
      if (EditorState.audioEl) getOrCreateSourceNode(audioCtx, EditorState.audioEl).connect(dest);
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
      EditorState.audioEl.currentTime = 0;
      await EditorState.audioEl.play().catch(() => {});
    }

    EditorState.playback.currentTime = 0;
    EditorState.playback.lastFrameTs = null;
    EditorState.playback.playing = true;

    const finEnregistrement = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start();

    const debut = Date.now();
    const tick = setInterval(() => {
      const ecoule = (Date.now() - debut) / 1000;
      setProgress(Math.min(0.5, (ecoule / dureeTotale) * 0.5));
    }, 100);

    await new Promise((resolve) => setTimeout(resolve, dureeTotale * 1000));
    clearInterval(tick);
    EditorState.playback.playing = false;
    recorder.stop();
    if (EditorState.audioEl) EditorState.audioEl.pause();
    await finEnregistrement;

    setProgress(0.5, 'Conversion en MP4 (qualité haute, encodage lent)…');
    const webmBlob = new Blob(chunks, { type: 'video/webm' });
    const mp4Blob = await transcoderEnMp4(webmBlob, (p) =>
      setProgress(0.5 + p * 0.5, `Conversion en MP4… ${Math.round(p * 100)}%`)
    );

    setProgress(1, 'Terminé !');
    downloadBlob(mp4Blob, `${obtenirNomExport('playtesteur-promo')}.mp4`);
  } catch (err) {
    console.error('[editeur] export MP4 échoué', err);
    toast("Échec de l'export MP4 : " + err.message, 'error');
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 1200);
    btnMp4.disabled = false;
    btnPng.disabled = false;
  }
}
