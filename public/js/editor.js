/* ==========================================================================
   ÉDITEUR (vidéo/photo promo) — 100% côté navigateur, rien n'est envoyé
   au serveur. Composition sur <canvas> en timeline (intro -> photos ->
   outro, chaque segment ayant sa propre durée), aperçu temps réel avec
   lecture/pause, export PNG (formats Play Store) et export MP4 haute
   qualité (1920x1080, 60 im/s) via MediaRecorder puis ffmpeg.wasm.
   ========================================================================== */

const EditorState = {
  bgType: null, // 'video' | 'image' | null
  bgVideoEl: null,
  bgImageEl: null,
  audioEl: null,
  fontFamily: null,

  intro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  outro: { active: false, logoImg: null, img: null, texte: '', duree: 3 },
  photos: [], // [{ id, img, x, y, scale, texte, duree }]

  text: '',
  textStyle: { color: '#ffffff', size: 56, x: 0.5, y: 0.85 },

  playback: { playing: false, currentTime: 0, lastFrameTs: null },
  _scrubbing: false,

  imageExportFormat: 'playstore', // 'playstore' (1080x1920) | 'square' (1080x1080)

  dragging: null, // null | 'text' | { type:'photo', id } | { type:'caption', id }
  _photoBoxes: {}, // id -> { x, y, w, h }
  _captionBoxes: {}, // id -> { x, y, w, h }
  _textBox: null,
  audioCtx: null,
  audioSourceCache: null,
};

let editorRafId = null;
let photoLayerCounter = 0;

function arreterEditeur() {
  if (editorRafId) {
    cancelAnimationFrame(editorRafId);
    editorRafId = null;
  }
}

function initEditeur() {
  const canvas = document.getElementById('editor-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  bindEditorInputs();
  bindEditorDrag(canvas);
  bindTimelineControls();
  rafraichirListePhotos();

  arreterEditeur();
  (function loop() {
    drawEditorFrame(ctx, canvas);
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
/* Dessin                                                                 */
/* -------------------------------------------------------------------- */
function drawCover(ctx, media, dw, dh) {
  const mw = media.videoWidth || media.naturalWidth || media.width || 0;
  const mh = media.videoHeight || media.naturalHeight || media.height || 0;
  if (!mw || !mh) return;
  const scale = Math.max(dw / mw, dh / mh);
  const w = mw * scale;
  const h = mh * scale;
  ctx.drawImage(media, (dw - w) / 2, (dh - h) / 2, w, h);
}

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

function dessinerFond(ctx, width, height) {
  if (EditorState.bgType === 'video' && EditorState.bgVideoEl && EditorState.bgVideoEl.readyState >= 2) {
    drawCover(ctx, EditorState.bgVideoEl, width, height);
  } else if (EditorState.bgType === 'image' && EditorState.bgImageEl) {
    drawCover(ctx, EditorState.bgImageEl, width, height);
  } else {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = `${Math.round(width * 0.016)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Importez un fond pour commencer', width / 2, height / 2);
  }
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

// Panneau "verre dépoli" derrière un bloc de texte : coins arrondis,
// flou du fond déjà dessiné à cet endroit, voile semi-transparent.
// Rend le texte lisible sur n'importe quel fond sans dépendre de sa
// couleur ou de sa complexité (photo, vidéo, dégradé...).
function dessinerPanneauTexte(ctx, x, y, w, h, radius) {
  if (w <= 0 || h <= 0) return;
  const marge = 12;
  const iw = ctx.canvas.width;
  const ih = ctx.canvas.height;
  const sx = Math.max(0, Math.round(x - marge));
  const sy = Math.max(0, Math.round(y - marge));
  const sw = Math.max(1, Math.min(Math.round(w + marge * 2), iw - sx));
  const sh = Math.max(1, Math.min(Math.round(h + marge * 2), ih - sy));

  ctx.save();
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.clip();
  try {
    const off = document.createElement('canvas');
    off.width = sw;
    off.height = sh;
    off.getContext('2d').drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.filter = 'blur(14px)';
    ctx.drawImage(off, sx, sy, sw, sh);
    ctx.filter = 'none';
  } catch (_) {
    // Fond non capturable (média cross-origin) : on garde juste le voile.
  }
  ctx.fillStyle = 'rgba(8,10,14,0.42)';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// Photo "carte flottante" : coins arrondis, légère inclinaison et
// oscillation verticale douce et continue (aperçu comme export).
function dessinerPhotoImage(ctx, width, height, p, tGlobal) {
  if (!p.img) return null;
  const w = width * p.scale;
  const h = w * (p.img.naturalHeight / p.img.naturalWidth || 1);
  const baseX = p.x * width;
  const baseY = p.y * height;

  const phase = (p.id % 7) * 0.9;
  const floatY = Math.sin(tGlobal * 1.1 + phase) * h * 0.035;
  const tilt = Math.sin(tGlobal * 0.66 + phase) * 0.045;

  ctx.save();
  ctx.translate(baseX, baseY + floatY);
  ctx.rotate(tilt);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = h * 0.14;
  ctx.shadowOffsetY = h * 0.08;
  roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.clip();
  ctx.drawImage(p.img, -w / 2, -h / 2, w, h);
  ctx.restore();

  ctx.lineWidth = Math.max(1, w * 0.003);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.stroke();

  ctx.restore();

  return { x: baseX - w / 2, y: baseY - h / 2, w, h };
}

// Légende détachée de l'image : position libre (glissable), couleur
// choisie automatiquement pour rester lisible sur le fond à cet endroit.
function dessinerLegendePhoto(ctx, width, height, p) {
  if (!p.texte) return null;
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Roboto', sans-serif";
  const size = Math.max(14, Math.round(width * 0.022));
  ctx.font = `600 ${size}px ${famille}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const maxWidth = width * 0.7;
  const lignes = wrapText(ctx, p.texte, maxWidth);
  const lineHeight = size * 1.25;
  let boxW = 0;
  lignes.forEach((ligne) => {
    boxW = Math.max(boxW, ctx.measureText(ligne).width);
  });
  const boxH = lineHeight * lignes.length;

  const cx = (p.texteX ?? p.x) * width;
  const topY = (p.texteY ?? p.y) * height;
  const padX = 18;
  const padY = 12;
  const boxX = cx - boxW / 2 - padX;
  const boxY = topY - padY;
  const panelW = boxW + padX * 2;
  const panelH = boxH + padY * 2;

  dessinerPanneauTexte(ctx, boxX, boxY, panelW, panelH, 14);

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;
  lignes.forEach((ligne, i) => ctx.fillText(ligne, cx, topY + i * lineHeight));
  ctx.shadowBlur = 0;

  return { x: boxX, y: boxY, w: panelW, h: panelH };
}

function dessinerIntroOutro(ctx, width, height, seg) {
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Space Grotesk', sans-serif";
  if (seg.logoImg) {
    const lw = width * 0.16;
    const lh = lw * (seg.logoImg.naturalHeight / seg.logoImg.naturalWidth || 1);
    ctx.drawImage(seg.logoImg, width / 2 - lw / 2, height * 0.1, lw, lh);
  }
  if (seg.img) {
    const iw = width * 0.46;
    const ih = iw * (seg.img.naturalHeight / seg.img.naturalWidth || 1);
    ctx.drawImage(seg.img, width / 2 - iw / 2, height / 2 - ih / 2, iw, ih);
  }
  if (seg.texte) {
    const size = Math.max(18, Math.round(width * 0.03));
    ctx.font = `700 ${size}px ${famille}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lignes = wrapText(ctx, seg.texte, width * 0.8);
    const lineHeight = size * 1.25;
    const totalHeight = lineHeight * lignes.length;
    const y0 = height * 0.86 - totalHeight / 2;
    let boxW = 0;
    lignes.forEach((ligne) => {
      boxW = Math.max(boxW, ctx.measureText(ligne).width);
    });

    const padX = 26;
    const padY = 16;
    dessinerPanneauTexte(ctx, width / 2 - boxW / 2 - padX, y0 - padY, boxW + padX * 2, totalHeight + padY * 2, 16);

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    lignes.forEach((ligne, i) => ctx.fillText(ligne, width / 2, y0 + i * lineHeight));
    ctx.shadowBlur = 0;
  }
}

function dessinerTexteLibre(ctx, width, height) {
  if (!EditorState.text) return null;
  const size = Number(EditorState.textStyle.size) || 56;
  const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Space Grotesk', sans-serif";
  ctx.font = `700 ${size}px ${famille}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxWidth = width * 0.85;
  const lignes = wrapText(ctx, EditorState.text, maxWidth);
  const lineHeight = size * 1.2;
  const totalHeight = lineHeight * lignes.length;
  const cx = EditorState.textStyle.x * width;
  const cy = EditorState.textStyle.y * height;
  let boxW = 0;
  lignes.forEach((ligne) => {
    boxW = Math.max(boxW, ctx.measureText(ligne).width);
  });

  const padX = 26;
  const padY = 18;
  const boxX = cx - boxW / 2 - padX;
  const boxY = cy - totalHeight / 2 - padY;
  const panelW = boxW + padX * 2;
  const panelH = totalHeight + padY * 2;

  dessinerPanneauTexte(ctx, boxX, boxY, panelW, panelH, 18);

  ctx.fillStyle = EditorState.textStyle.color;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  lignes.forEach((ligne, i) => {
    ctx.fillText(ligne, cx, cy - totalHeight / 2 + lineHeight * (i + 0.5));
  });
  ctx.shadowBlur = 0;

  return { x: boxX, y: boxY, w: panelW, h: panelH };
}

function drawEditorFrame(ctx, canvas) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  dessinerFond(ctx, width, height);

  const { segments, dureeTotale } = calculerTimeline();
  avancerPlayback(dureeTotale);
  const segmentActif = segmentAuTemps(segments, EditorState.playback.currentTime);

  EditorState._photoBoxes = {};
  EditorState._captionBoxes = {};
  const tGlobal = performance.now() / 1000;
  if (segmentActif) {
    if (segmentActif.type === 'photo') {
      const p = segmentActif.data;
      const imgBox = dessinerPhotoImage(ctx, width, height, p, tGlobal);
      if (imgBox) {
        EditorState._photoBoxes[p.id] = imgBox;
        if (EditorState.dragging && EditorState.dragging.type === 'photo' && EditorState.dragging.id === p.id) {
          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = 2;
          ctx.strokeRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h);
        }
      }
      const capBox = dessinerLegendePhoto(ctx, width, height, p);
      if (capBox) {
        EditorState._captionBoxes[p.id] = capBox;
        if (EditorState.dragging && EditorState.dragging.type === 'caption' && EditorState.dragging.id === p.id) {
          ctx.strokeStyle = '#2979ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(capBox.x, capBox.y, capBox.w, capBox.h);
        }
      }
    } else {
      dessinerIntroOutro(ctx, width, height, segmentActif.data);
    }
  }

  EditorState._textBox = dessinerTexteLibre(ctx, width, height);
  if (EditorState._textBox && EditorState.dragging === 'text') {
    ctx.strokeStyle = '#2979ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(EditorState._textBox.x, EditorState._textBox.y, EditorState._textBox.w, EditorState._textBox.h);
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
    scale: 0.3,
    texte: '',
    duree: 3,
    texteX: 0.5,
    texteY: 0.72,
  });
  rafraichirListePhotos();
  allerAuSegment((s) => s.type === 'photo' && s.data.id === id);
}

function supprimerCalquePhoto(id) {
  EditorState.photos = EditorState.photos.filter((p) => p.id !== id);
  delete EditorState._photoBoxes[id];
  rafraichirListePhotos();
}

/* -------------------------------------------------------------------- */
/* Glisser-déposer sur le canvas (texte / photo active)                  */
/* -------------------------------------------------------------------- */
function toCanvasCoords(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
}

function pointInBox(x, y, box) {
  return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

function trouverCaptionSurvolee(x, y) {
  for (let i = EditorState.photos.length - 1; i >= 0; i--) {
    const p = EditorState.photos[i];
    if (pointInBox(x, y, EditorState._captionBoxes[p.id])) return p;
  }
  return null;
}

function trouverPhotoSurvolee(x, y) {
  for (let i = EditorState.photos.length - 1; i >= 0; i--) {
    const p = EditorState.photos[i];
    if (pointInBox(x, y, EditorState._photoBoxes[p.id])) return p;
  }
  return null;
}

function bindEditorDrag(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = toCanvasCoords(canvas, e);
    if (pointInBox(x, y, EditorState._textBox)) {
      EditorState.dragging = 'text';
    } else {
      const caption = trouverCaptionSurvolee(x, y);
      if (caption) {
        EditorState.dragging = { type: 'caption', id: caption.id };
      } else {
        const photo = trouverPhotoSurvolee(x, y);
        if (photo) EditorState.dragging = { type: 'photo', id: photo.id };
      }
    }
    if (EditorState.dragging) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = toCanvasCoords(canvas, e);
    if (!EditorState.dragging) {
      const survole =
        pointInBox(x, y, EditorState._textBox) || !!trouverCaptionSurvolee(x, y) || !!trouverPhotoSurvolee(x, y);
      canvas.style.cursor = survole ? 'grab' : 'default';
      return;
    }
    canvas.style.cursor = 'grabbing';
    const fx = Math.min(1, Math.max(0, x / canvas.width));
    const fy = Math.min(1, Math.max(0, y / canvas.height));
    if (EditorState.dragging === 'text') {
      EditorState.textStyle.x = fx;
      EditorState.textStyle.y = fy;
    } else if (EditorState.dragging.type === 'photo') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      if (p) {
        p.x = fx;
        p.y = fy;
      }
    } else if (EditorState.dragging.type === 'caption') {
      const p = EditorState.photos.find((ph) => ph.id === EditorState.dragging.id);
      if (p) {
        p.texteX = fx;
        p.texteY = fy;
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

/* -------------------------------------------------------------------- */
/* Export PNG (formats verticaux Play Store)                             */
/* -------------------------------------------------------------------- */
function exportEditeurPng() {
  const dims = EditorState.imageExportFormat === 'square' ? { w: 1080, h: 1080 } : { w: 1080, h: 1920 };
  const off = document.createElement('canvas');
  off.width = dims.w;
  off.height = dims.h;
  const ctx = off.getContext('2d');

  dessinerFond(ctx, dims.w, dims.h);
  const { segments } = calculerTimeline();
  const segmentActif = segmentAuTemps(segments, EditorState.playback.currentTime);
  if (segmentActif) {
    if (segmentActif.type === 'photo') {
      dessinerPhotoImage(ctx, dims.w, dims.h, segmentActif.data, performance.now() / 1000);
      dessinerLegendePhoto(ctx, dims.w, dims.h, segmentActif.data);
    } else {
      dessinerIntroOutro(ctx, dims.w, dims.h, segmentActif.data);
    }
  }
  dessinerTexteLibre(ctx, dims.w, dims.h);

  off.toBlob((blob) => {
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
  const { FFmpeg } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
  const { toBlobURL } = await import('https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js');
  const ffmpeg = new FFmpeg();
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
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
