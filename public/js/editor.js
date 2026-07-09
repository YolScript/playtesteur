/* ==========================================================================
   ÉDITEUR (vidéo/photo promo) — 100% côté navigateur, rien n'est envoyé
   au serveur. Composition sur <canvas>, export PNG via toBlob, export MP4
   via MediaRecorder (webm) puis transcodage réel en MP4 avec ffmpeg.wasm.
   ========================================================================== */

const EditorState = {
  bgType: null, // 'video' | 'image' | null
  bgVideoEl: null,
  bgImageEl: null,
  audioEl: null,
  photos: [], // [{ id, img, x, y, scale, texte }] — chaque photo a son propre texte lié
  fontFamily: null,
  text: '',
  textStyle: { color: '#ffffff', size: 56, x: 0.5, y: 0.85 },
  dragging: null, // null | 'text' | { type:'photo', id }
  _photoBoxes: {}, // id -> { x, y, w, h }
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

  arreterEditeur();
  (function loop() {
    drawEditorFrame(ctx, canvas);
    editorRafId = requestAnimationFrame(loop);
  })();
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

function drawEditorFrame(ctx, canvas) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  if (EditorState.bgType === 'video' && EditorState.bgVideoEl && EditorState.bgVideoEl.readyState >= 2) {
    drawCover(ctx, EditorState.bgVideoEl, width, height);
  } else if (EditorState.bgType === 'image' && EditorState.bgImageEl) {
    drawCover(ctx, EditorState.bgImageEl, width, height);
  } else {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Importez un fond pour commencer', width / 2, height / 2);
  }

  EditorState._photoBoxes = {};
  EditorState.photos.forEach((p) => {
    if (!p.img) return;
    const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Roboto', sans-serif";
    const w = width * p.scale;
    const h = w * (p.img.naturalHeight / p.img.naturalWidth || 1);
    const x = p.x * width - w / 2;
    const y = p.y * height - h / 2;
    ctx.drawImage(p.img, x, y, w, h);
    let boiteHauteur = h;

    if (p.texte) {
      const size = Math.max(14, Math.round(width * 0.022));
      ctx.font = `600 ${size}px ${famille}`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 8;
      const lignes = wrapText(ctx, p.texte, w);
      const lineHeight = size * 1.25;
      lignes.forEach((ligne, i) => ctx.fillText(ligne, p.x * width, y + h + 8 + i * lineHeight));
      ctx.shadowBlur = 0;
      boiteHauteur = h + 8 + lineHeight * lignes.length;
    }

    EditorState._photoBoxes[p.id] = { x, y, w, h: boiteHauteur };
    if (EditorState.dragging && EditorState.dragging.type === 'photo' && EditorState.dragging.id === p.id) {
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, boiteHauteur);
    }
  });

  EditorState._textBox = null;
  if (EditorState.text) {
    const size = Number(EditorState.textStyle.size) || 56;
    const famille = EditorState.fontFamily ? `"${EditorState.fontFamily}"` : "'Space Grotesk', sans-serif";
    ctx.font = `700 ${size}px ${famille}`;
    ctx.fillStyle = EditorState.textStyle.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;

    const maxWidth = width * 0.85;
    const lignes = wrapText(ctx, EditorState.text, maxWidth);
    const lineHeight = size * 1.2;
    const totalHeight = lineHeight * lignes.length;
    const cx = EditorState.textStyle.x * width;
    const cy = EditorState.textStyle.y * height;
    let boxW = 0;
    lignes.forEach((ligne, i) => {
      boxW = Math.max(boxW, ctx.measureText(ligne).width);
      ctx.fillText(ligne, cx, cy - totalHeight / 2 + lineHeight * (i + 0.5));
    });
    ctx.shadowBlur = 0;

    EditorState._textBox = { x: cx - boxW / 2 - 10, y: cy - totalHeight / 2 - 10, w: boxW + 20, h: totalHeight + 20 };
    if (EditorState.dragging === 'text') {
      ctx.strokeStyle = '#2979ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(EditorState._textBox.x, EditorState._textBox.y, EditorState._textBox.w, EditorState._textBox.h);
    }
  }
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
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (_) {}
      EditorState.bgImageEl = img;
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

  addPhotoBtn.addEventListener('click', ajouterCalquePhoto);
  rafraichirListePhotos();

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

  exportPngBtn.addEventListener('click', exportEditeurPng);
  exportMp4Btn.addEventListener('click', exportEditeurMp4);
}

/* -------------------------------------------------------------------- */
/* Calques photo multiples (chacun avec sa légende liée)                 */
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
      <label class="editor-mini-label">Taille<input type="range" data-scale-for="${p.id}" min="5" max="80" value="${Math.round(p.scale * 100)}"></label>
    </div>
  `;
}

function bindPhotoLayerEvents() {
  EditorState.photos.forEach((p) => {
    const fileInput = document.getElementById(`editor-photo-input-${p.id}`);
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        afficherNomFichier(`editor-photo-filename-${p.id}`, file);
        const img = new Image();
        img.src = URL.createObjectURL(file);
        try {
          await img.decode();
        } catch (_) {}
        p.img = img;
      });
    }
    const captionInput = document.querySelector(`[data-caption-for="${p.id}"]`);
    if (captionInput) {
      captionInput.addEventListener('input', (e) => {
        p.texte = e.target.value;
      });
    }
    const scaleInput = document.querySelector(`[data-scale-for="${p.id}"]`);
    if (scaleInput) {
      scaleInput.addEventListener('input', (e) => {
        p.scale = Number(e.target.value) / 100;
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
  EditorState.photos.push({ id: ++photoLayerCounter, img: null, x: 0.5, y: 0.5, scale: 0.3, texte: '' });
  rafraichirListePhotos();
}

function supprimerCalquePhoto(id) {
  EditorState.photos = EditorState.photos.filter((p) => p.id !== id);
  delete EditorState._photoBoxes[id];
  rafraichirListePhotos();
}

/* -------------------------------------------------------------------- */
/* Glisser-déposer sur le canvas (texte / photo)                         */
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
      const photo = trouverPhotoSurvolee(x, y);
      if (photo) EditorState.dragging = { type: 'photo', id: photo.id };
    }
    if (EditorState.dragging) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = toCanvasCoords(canvas, e);
    if (!EditorState.dragging) {
      const survole = pointInBox(x, y, EditorState._textBox) || !!trouverPhotoSurvolee(x, y);
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
/* Export PNG                                                            */
/* -------------------------------------------------------------------- */
function exportEditeurPng() {
  const canvas = document.getElementById('editor-canvas');
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, 'playtesteur-visuel.png');
  }, 'image/png');
}

/* -------------------------------------------------------------------- */
/* Export MP4 (MediaRecorder -> webm, puis transcodage ffmpeg.wasm)      */
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
    await ffmpeg.exec([
      '-i', 'entree.webm',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
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
  const duration = Math.max(1, Math.min(30, Number(document.getElementById('editor-duration').value) || 6));

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
    const canvasStream = canvas.captureStream(30);
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
    const recorder = new MediaRecorder(finalStream, { mimeType });
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

    const finEnregistrement = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start();

    const debut = Date.now();
    const tick = setInterval(() => {
      const ecoule = (Date.now() - debut) / 1000;
      setProgress(Math.min(0.5, (ecoule / duration) * 0.5));
    }, 100);

    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    clearInterval(tick);
    recorder.stop();
    if (EditorState.audioEl) EditorState.audioEl.pause();
    await finEnregistrement;

    setProgress(0.5, 'Conversion en MP4…');
    const webmBlob = new Blob(chunks, { type: 'video/webm' });
    const mp4Blob = await transcoderEnMp4(webmBlob, (p) =>
      setProgress(0.5 + p * 0.5, `Conversion en MP4… ${Math.round(p * 100)}%`)
    );

    setProgress(1, 'Terminé !');
    downloadBlob(mp4Blob, 'playtesteur-promo.mp4');
  } catch (err) {
    console.error('[editeur] export MP4 échoué', err);
    toast("Échec de l'export MP4 : " + err.message, 'error');
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 1200);
    btnMp4.disabled = false;
    btnPng.disabled = false;
  }
}
