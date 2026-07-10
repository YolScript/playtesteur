const state = {
  user: null,
};

/* ==========================================================================
   UTILITAIRES
   ========================================================================== */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function initiales(pseudo) {
  return (pseudo || '?').trim().slice(0, 2).toUpperCase();
}

// Avatar Google si disponible, sinon pastille avec initiales.
function avatarHtml(user, className) {
  if (user.avatar_url) {
    return `<img class="${className}" src="${escapeHtml(user.avatar_url)}" alt="" referrerpolicy="no-referrer">`;
  }
  return `<div class="${className}">${initiales(user.pseudo)}</div>`;
}

const BADGE_PROFIL = {
  En_Attente: '<span class="badge badge-attente"><span class="badge-dot"></span>En attente</span>',
  Validé: '<span class="badge badge-valide"><span class="badge-dot"></span>Profil validé</span>',
};

const BADGE_APP = {
  En_Cours: '<span class="badge badge-en-cours"><span class="badge-dot"></span>En recrutement</span>',
  Complété: '<span class="badge badge-complete"><span class="badge-dot"></span>12/12 atteint</span>',
  Terminé_Inactif: '<span class="badge badge-termine"><span class="badge-dot"></span>Terminé</span>',
};

const BADGE_HISTORIQUE = {
  En_Cours: '<span class="badge badge-en-cours"><span class="badge-dot"></span>Test en cours</span>',
  'Complété': '<span class="badge badge-valide"><span class="badge-dot"></span>Test validé</span>',
  Suspendu: '<span class="badge badge-suspendu"><span class="badge-dot"></span>Suspendu</span>',
};

/* ==========================================================================
   ROUTEUR
   ========================================================================== */
const viewRoot = document.getElementById('view-root');

const PUBLIC_ROUTES = new Set(['login']);

async function router() {
  const hash = location.hash.replace('#/', '') || '';
  const [route, param] = hash.split('/');

  if (!PUBLIC_ROUTES.has(route) && !state.user) {
    location.hash = '#/login';
    return;
  }
  if (PUBLIC_ROUTES.has(route) && state.user) {
    location.hash = '#/dashboard';
    return;
  }

  renderHeader();
  arreterChat();
  if (typeof arreterEditeur === 'function') arreterEditeur();

  try {
    switch (route) {
      case 'login':
        return viewLogin();
      case 'catalogue':
        return viewCatalogue();
      case 'classement':
        return viewClassement();
      case 'mes-apps':
        return viewMesApps();
      case 'app':
        return viewAppDetail(param);
      case 'editeur':
        return viewEditeur();
      case 'admin':
        return viewAdmin();
      case 'dashboard':
      default:
        return viewDashboard();
    }
  } catch (err) {
    viewRoot.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${escapeHtml(err.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', router);

/* ==========================================================================
   HEADER
   ========================================================================== */
const NAV_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/></svg>',
  catalogue: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zm0 9h7v7h-7v-7zM4 13h7v7H4v-7z"/></svg>',
  classement: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 21h8v-2H8v2zM6 10H3V3h3v7zm12 0h-3V3h3v7zM12 15c-2.8 0-5-2.2-5-5V3h10v7c0 2.8-2.2 5-5 5z"/></svg>',
  'mes-apps': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM12 3l-6 6h4v6h4v-6h4l-6-6z"/></svg>',
  editeur: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3.5v6c0 5-3.4 8.9-8 10.5-4.6-1.6-8-5.5-8-10.5v-6L12 2z"/></svg>',
};

function renderHeader() {
  const nav = document.getElementById('main-nav');
  const bottomNav = document.getElementById('bottom-nav');
  const actions = document.getElementById('header-actions');
  const currentRoute = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];

  if (!state.user) {
    nav.innerHTML = '';
    bottomNav.innerHTML = '';
    actions.innerHTML = '';
    return;
  }

  const links = [
    { route: 'catalogue', label: 'Catalogue' },
    { route: 'classement', label: 'Classement' },
    { route: 'mes-apps', label: 'Mes apps' },
    { route: 'dashboard', label: 'Compte' },
    { route: 'editeur', label: 'Éditeur' },
  ];
  if (state.user.role === 'administrator') {
    links.push({ route: 'admin', label: 'Admin' });
  }

  nav.innerHTML = links
    .map(
      (l) =>
        `<button class="nav-link ${l.route === currentRoute ? 'active' : ''}" data-route="${l.route}">${l.label}</button>`
    )
    .join('');
  nav.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => (location.hash = `#/${btn.dataset.route}`));
  });

  bottomNav.innerHTML = links
    .map(
      (l) =>
        `<button class="bottom-nav-link ${l.route === currentRoute ? 'active' : ''}" data-route="${l.route}">
          <span class="bottom-nav-icon">${NAV_ICONS[l.route] || ''}</span>
          <span class="bottom-nav-label">${l.label}</span>
        </button>`
    )
    .join('');
  bottomNav.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => (location.hash = `#/${btn.dataset.route}`));
  });

  actions.innerHTML = `
    <div class="user-chip" id="user-chip" title="Cliquer pour se déconnecter">
      ${avatarHtml(state.user, 'user-avatar')}
      <span class="user-pseudo">${escapeHtml(state.user.pseudo)}</span>
    </div>
  `;
  document.getElementById('user-chip').addEventListener('click', async () => {
    await Api.post('/api/auth/logout');
    state.user = null;
    location.hash = '#/login';
  });
}

/* ==========================================================================
   AUTH : CONNEXION GOOGLE
   ========================================================================== */
const GOOGLE_ICON_SVG = `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.9 19 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3 16.3 3 9.7 7.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.6 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 40.5 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C39.9 36.9 43 31.4 43 24c0-1.2-.1-2.4-.4-3.5z"/></svg>`;

function viewLogin() {
  viewRoot.innerHTML = `
    <div class="form-card">
      <h1>Connexion</h1>
      <p class="form-hint">Accédez à votre tableau de bord de testeur avec votre compte Google.</p>
      <div class="auth-warning">
        <span class="warning-icon">⚠️</span>
        <span><strong>Utilisez impérativement le même compte Google que celui associé à votre Google Play Console.</strong></span>
      </div>
      <div id="form-msg"></div>
      <div id="auth-zone"><p class="form-hint">Chargement...</p></div>
      <p class="form-switch"><a href="/confidentialite.html">Quelles données sont récupérées, et pourquoi ?</a></p>
    </div>
  `;

  chargerZoneAuth();
}

async function chargerZoneAuth() {
  const zone = document.getElementById('auth-zone');
  try {
    const { googleAuthDevMode } = await Api.get('/api/auth/config');

    if (!googleAuthDevMode) {
      zone.innerHTML = `
        <a class="btn-google" href="/api/auth/google">
          ${GOOGLE_ICON_SVG}
          <span>Continuer avec Google</span>
        </a>
      `;
      return;
    }

    // MODE DEV : pas d'OAuth Google configuré côté serveur, on simule.
    zone.innerHTML = `
      <div class="form-error" style="margin-bottom:16px;">Mode dev : OAuth Google non configuré côté serveur. Connexion simulée ci-dessous.</div>
      <form id="dev-login-form">
        <div class="form-group">
          <label>Email Google (simulé)</label>
          <input type="email" name="email" required autocomplete="email" />
        </div>
        <div class="form-group">
          <label>Nom</label>
          <input type="text" name="pseudo" required minlength="2" />
        </div>
        <button type="submit" class="btn-primary btn-block">Se connecter (dev)</button>
      </form>
    `;
    document.getElementById('dev-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const { user } = await Api.post('/api/auth/dev-login', {
          email: fd.get('email'),
          pseudo: fd.get('pseudo'),
        });
        state.user = user;
        location.hash = '#/dashboard';
      } catch (err) {
        showFormError(err.message);
      }
    });
  } catch (err) {
    zone.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

function showFormError(message) {
  document.getElementById('form-msg').innerHTML = `<div class="form-error">${escapeHtml(message)}</div>`;
}

/* ==========================================================================
   DASHBOARD
   ========================================================================== */
async function viewDashboard() {
  const { user, mails } = await Api.get('/api/profile');
  state.user = user;

  const pctScore = Math.round((user.score_global / 100) * 100);
  const pctMails = Math.round((user.mails_debloques / user.mails_max) * 100);

  const mailSlots = Array.from({ length: user.mails_max })
    .map((_, i) => {
      const mail = mails[i];
      if (!mail) return '<div class="mail-slot">✉</div>';
      const copiable = mail.statut_visuel === 'vert' || mail.statut_visuel === 'orange';
      const titre =
        mail.statut_visuel === 'rouge'
          ? `${mail.nom_application} — accès retiré`
          : mail.statut_visuel === 'orange'
            ? `${mail.nom_application} — risque de suppression : ${mail.raison || 'non précisée'}`
            : `${mail.nom_application} — actif`;
      return copiable
        ? `<button type="button" class="mail-slot filled ${mail.statut_visuel}" data-copy-mail="${escapeHtml(mail.google_group_email || '')}" title="${escapeHtml(titre)}">✉</button>`
        : `<div class="mail-slot filled ${mail.statut_visuel}" title="${escapeHtml(titre)}">✉</div>`;
    })
    .join('');

  viewRoot.innerHTML = `
    <h1 class="page-title">Tableau de bord</h1>
    <p class="page-subtitle">Suivez votre progression de testeur en temps réel.</p>

    <div class="profile-card">
      <div class="profile-top">
        <div class="profile-identity">
          ${avatarHtml(user, 'profile-avatar-big')}
          <div>
            <h2>${escapeHtml(user.pseudo)}</h2>
            <div class="profile-email" id="profile-email-value">${user.masquer_infos ? '••••••••@••••••.•••' : escapeHtml(user.email)}</div>
          </div>
        </div>
        ${BADGE_PROFIL[user.statut_profil] || ''}
      </div>

      <label class="editor-checkbox-row" style="margin-top:12px;">
        <input type="checkbox" id="masquer-infos-toggle" ${user.masquer_infos ? 'checked' : ''}>
        <span>Masquer mes informations personnelles (visuel uniquement, aussi masqué pour l'admin)</span>
      </label>

      <div class="gauges-grid">
        <div>
          <div class="gauge-row"><span class="gauge-label">Score global</span><span class="gauge-value">${user.score_global} / 100</span></div>
          <div class="gauge-bar-bg"><div class="gauge-bar-fill" style="width:${pctScore}%"></div></div>
          ${
            user.score_prochain_palier !== null
              ? `<p class="form-hint" style="margin-top:8px;">Encore ${Math.max(0, user.score_prochain_palier - user.score_global)} points pour débloquer le mail n°${user.mails_debloques + 1}.</p>`
              : `<p class="form-hint" style="margin-top:8px;">Palier maximum atteint 🎉</p>`
          }
        </div>
        <div>
          <div class="gauge-row"><span class="gauge-label">Mails actifs</span><span class="gauge-value">${user.mails_debloques} / ${user.mails_max}</span></div>
          <div class="gauge-bar-bg"><div class="gauge-bar-fill gauge-mails" style="width:${pctMails}%"></div></div>
          <div class="mails-grid">${mailSlots}</div>
        </div>
      </div>
    </div>

    <div class="section-title">Pseudo Google Play Store</div>
    <div class="profile-card" style="padding:20px;">
      <div class="form-group" style="margin-bottom:0;">
        <label>Pseudo affiché sur vos avis Play Store</label>
        <div style="font-size:15px; font-weight:600; padding:11px 14px; background:var(--bg-input); border:1px solid var(--border-color); border-radius:var(--radius-md);">${escapeHtml(user.pseudo_play_store || '—')}</div>
      </div>
    </div>

    <div class="section-title">Aller plus loin</div>
    <div class="card-grid">
      <div class="app-card">
        <div class="app-card-title">📲 Découvrir des applications à tester</div>
        <p class="app-card-desc">Testez de nouvelles apps pour gagner des mails actifs.</p>
        <button class="btn-primary" id="go-catalogue">Voir le catalogue</button>
      </div>
      <div class="app-card">
        <div class="app-card-title">🚀 Soumettre mon application</div>
        <p class="app-card-desc">Créez un groupe de test et recrutez jusqu'à 12 testeurs.</p>
        <button class="btn-secondary" id="go-mesapps">Gérer mes applications</button>
      </div>
      <div class="app-card">
        <div class="app-card-title">📱 Application Android</div>
        <p class="app-card-desc">Installez PlayTesteur directement sur votre téléphone.</p>
        <a class="btn-secondary" href="/downloads/playtesteur.apk" download style="display:inline-block; text-align:center; text-decoration:none;">Télécharger l'APK</a>
      </div>
    </div>
  `;

  document.getElementById('go-catalogue').addEventListener('click', () => (location.hash = '#/catalogue'));
  document.getElementById('go-mesapps').addEventListener('click', () => (location.hash = '#/mes-apps'));

  document.querySelectorAll('[data-copy-mail]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const email = btn.dataset.copyMail;
      if (!email) {
        toast('Adresse indisponible pour ce mail.', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(email);
        toast('Adresse copiée dans le presse-papier.', 'success');
      } catch (err) {
        toast("Impossible de copier l'adresse.", 'error');
      }
    });
  });

  document.getElementById('masquer-infos-toggle').addEventListener('change', async (e) => {
    const masquer = e.target.checked;
    try {
      const { user: updated } = await Api.post('/api/profile/masquer-infos', { masquer });
      state.user = updated;
      document.getElementById('profile-email-value').textContent = updated.masquer_infos
        ? '••••••••@••••••.•••'
        : updated.email;
      toast(masquer ? 'Informations personnelles masquées.' : 'Informations personnelles visibles.', 'success');
    } catch (err) {
      e.target.checked = !masquer;
      toast(err.message, 'error');
    }
  });
}

/* ==========================================================================
   CATALOGUE
   ========================================================================== */
async function viewCatalogue() {
  viewRoot.innerHTML = `
    <h1 class="page-title">Catalogue des applications</h1>
    <p class="page-subtitle">Testez une application, laissez un avis Play Store, gagnez un mail actif.</p>
    <div id="catalogue-grid" class="card-grid"><p class="page-subtitle">Chargement...</p></div>
  `;

  const { applications } = await Api.get('/api/apps');
  const grid = document.getElementById('catalogue-grid');

  if (applications.length === 0) {
    grid.outerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>Aucune nouvelle application à tester pour le moment. Revenez plus tard !</p></div>`;
    return;
  }

  grid.innerHTML = applications
    .map(
      (app) => `
      <div class="app-card">
        <div class="app-card-top">
          <div class="app-logo">${app.logo_url ? `<img src="${escapeHtml(app.logo_url)}" alt="" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;">` : '📱'}</div>
          <div>
            <div class="app-card-title">${escapeHtml(app.nom_application)}</div>
            ${BADGE_APP[app.statut] || ''}
          </div>
        </div>
        <p class="app-card-desc">${escapeHtml(app.description || 'Pas de description.')}</p>
        ${renderMiniGalerie(app.screenshots, app.video_url)}
        <div class="gauge-row"><span class="gauge-label">Testeurs</span><span class="gauge-value">${app.mails_recrutes} / ${app.mails_max}</span></div>
        <div class="gauge-bar-bg"><div class="gauge-bar-fill" style="width:${Math.round((app.mails_recrutes / app.mails_max) * 100)}%"></div></div>
        <div class="app-card-actions">
          <button class="btn-primary btn-block" data-app="${app.id}">Voir / Rejoindre</button>
        </div>
      </div>
    `
    )
    .join('');

  grid.querySelectorAll('[data-app]').forEach((btn) => {
    btn.addEventListener('click', () => (location.hash = `#/app/${btn.dataset.app}`));
  });
}

/* ==========================================================================
   CLASSEMENT DES TESTEURS
   ========================================================================== */
async function viewClassement() {
  viewRoot.innerHTML = `
    <h1 class="page-title">Classement des testeurs</h1>
    <p class="page-subtitle">Applications testées et jours consécutifs d'activité.</p>
    <div id="classement-liste"><p class="page-subtitle">Chargement...</p></div>
  `;

  const { classement } = await Api.get('/api/classement');
  const container = document.getElementById('classement-liste');

  if (classement.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>Personne n'a encore validé de test. Soyez le premier !</p></div>`;
    return;
  }

  const medailles = ['🥇', '🥈', '🥉'];

  container.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Rang</th><th>Testeur</th><th>Applications testées</th><th>Jours consécutifs</th></tr></thead>
        <tbody>
          ${classement
            .map(
              (u, i) => `
            <tr>
              <td data-label="Rang" style="font-size:18px; font-weight:700;">${medailles[i] || `#${i + 1}`}</td>
              <td data-label="Testeur">${escapeHtml(u.pseudo)}</td>
              <td data-label="Applications testées">${u.apps_testees}</td>
              <td data-label="Jours consécutifs">${u.jours_consecutifs > 0 ? `🔥 ${u.jours_consecutifs}` : '—'}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* ==========================================================================
   DÉTAIL APPLICATION
   ========================================================================== */
async function viewAppDetail(id) {
  viewRoot.innerHTML = `<p class="page-subtitle">Chargement...</p>`;
  const { application: app, mon_historique } = await Api.get(`/api/apps/${id}`);

  const estMonApp = state.user.id === app.developpeur_id;
  const dejaRejoint = !!mon_historique;
  const dejaValide = mon_historique && mon_historique.statut === 'Complété';

  viewRoot.innerHTML = `
    <button class="btn-ghost" id="btn-back">&larr; Retour</button>
    <div class="detail-card" style="margin-top:16px;">
      <div class="detail-header">
        <div class="app-logo" style="width:64px;height:64px;font-size:26px;">${app.logo_url ? `<img src="${escapeHtml(app.logo_url)}" alt="" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;">` : '📱'}</div>
        <div>
          <h1 class="page-title" style="margin-bottom:6px;">${escapeHtml(app.nom_application)}</h1>
          ${BADGE_APP[app.statut] || ''}
          ${mon_historique ? BADGE_HISTORIQUE[mon_historique.statut] || '' : ''}
        </div>
      </div>
      <p class="page-subtitle">${escapeHtml(app.description || 'Pas de description fournie.')}</p>

      ${renderVideoPromo(app.video_url)}
      ${renderGalerieScreenshots(app.screenshots)}

      <div class="gauge-row"><span class="gauge-label">Testeurs actifs</span><span class="gauge-value">${app.mails_recrutes} / ${app.mails_max}</span></div>
      <div class="gauge-bar-bg"><div class="gauge-bar-fill" style="width:${Math.round((app.mails_recrutes / app.mails_max) * 100)}%"></div></div>

      <div id="detail-msg" style="margin-top:20px;"></div>

      ${estMonApp ? renderProprietaireBloc() : renderTesteurBloc(app, dejaRejoint, dejaValide)}

      <div class="section-title">Avis Play Store</div>
      <div id="app-avis"><p class="form-hint">Chargement des avis...</p></div>

      ${
        estMonApp || dejaRejoint
          ? `
      <div class="section-title">Chat avec ${estMonApp ? 'les testeurs' : 'le créateur'}</div>
      <div id="app-chat-messages" style="display:flex; flex-direction:column; gap:8px; max-height:320px; overflow-y:auto; padding:4px;"></div>
      <form id="chat-form" style="display:flex; gap:8px; margin-top:10px;">
        <input type="text" name="texte" placeholder="Écrire un message..." maxlength="1000" style="flex:1; background:var(--bg-input); border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 14px; color:var(--text-white); font-family:var(--font-sans);" />
        <button type="submit" class="btn-primary">Envoyer</button>
      </form>
      `
          : ''
      }
    </div>
  `;

  document.getElementById('btn-back').addEventListener('click', () => history.back());
  chargerAvisApp(app.id);

  if (estMonApp || dejaRejoint) {
    demarrerChat(app.id);
  }

  if (!estMonApp) {
    const joinBtn = document.getElementById('btn-join');
    if (joinBtn) {
      joinBtn.addEventListener('click', async () => {
        joinBtn.disabled = true;
        try {
          const r = await Api.post(`/api/apps/${app.id}/join`);
          toast(r.message || 'Accès accordé.', 'success');
          viewAppDetail(id);
        } catch (err) {
          document.getElementById('detail-msg').innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
          joinBtn.disabled = false;
        }
      });
    }
    const validerBtn = document.getElementById('btn-valider');
    if (validerBtn) {
      validerBtn.addEventListener('click', async () => {
        validerBtn.disabled = true;
        validerBtn.textContent = 'Vérification de votre avis...';
        try {
          const r = await Api.post(`/api/apps/${app.id}/valider`);
          state.user = r.user;
          toast('Test validé ! Mail actif mis à jour.', 'success');
          viewAppDetail(id);
        } catch (err) {
          document.getElementById('detail-msg').innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
          validerBtn.disabled = false;
          validerBtn.textContent = 'Vérifier mon avis Play Store';
        }
      });
    }
  }
}

function renderTesteurBloc(app, dejaRejoint, dejaValide) {
  return `
    <div class="detail-steps">
      <div class="detail-step ${dejaRejoint ? 'done' : ''}"><span class="step-num">1</span>Rejoindre le groupe de test (accès Play Store débloqué)</div>
      <div class="detail-step ${dejaRejoint ? '' : ''}"><span class="step-num">2</span>Installer l'application depuis le Play Store</div>
      <div class="detail-step ${dejaValide ? 'done' : ''}"><span class="step-num">3</span>Laisser un avis avec votre pseudo Play Store</div>
      <div class="detail-step ${dejaValide ? 'done' : ''}"><span class="step-num">4</span>Vérification automatique &amp; gain du mail actif</div>
    </div>
    ${
      dejaValide
        ? `<p class="form-success">Test validé pour cette application. Elle ne réapparaîtra plus dans votre catalogue.</p>`
        : dejaRejoint
        ? `<button class="btn-primary btn-block" id="btn-valider">Vérifier mon avis Play Store</button>`
        : `<button class="btn-primary btn-block" id="btn-join">Rejoindre le test</button>`
    }
  `;
}

function renderProprietaireBloc() {
  return `<p class="form-hint">C'est votre application. Rendez-vous sur "Mes applications" pour suivre son recrutement.</p>`;
}

function youtubeEmbedUrl(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{6,})/);
  return match ? `https://www.youtube.com/embed/${match[1]}` : null;
}

function renderVideoPromo(videoUrl) {
  if (!videoUrl) return '';
  const embedUrl = youtubeEmbedUrl(videoUrl);
  if (!embedUrl) {
    return `<p class="form-hint" style="margin:16px 0;"><a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">🎬 Voir la vidéo de présentation</a></p>`;
  }
  return `
    <div style="margin:16px 0; position:relative; padding-top:56.25%; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border-color);">
      <iframe src="${escapeHtml(embedUrl)}" style="position:absolute; inset:0; width:100%; height:100%; border:0;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
    </div>
  `;
}

function renderGalerieScreenshots(screenshots) {
  if (!screenshots || screenshots.length === 0) return '';
  return `
    <div style="display:flex; gap:10px; overflow-x:auto; padding:4px 0 16px;">
      ${screenshots
        .map(
          (url) =>
            `<img src="${escapeHtml(url)}" alt="" style="height:220px; border-radius:var(--radius-md); border:1px solid var(--border-color); flex-shrink:0;">`
        )
        .join('')}
    </div>
  `;
}

// Version compacte pour les cards (catalogue, mes applications) : quelques
// vignettes de captures + badge vidéo si une vidéo promo est disponible.
function renderMiniGalerie(screenshots, videoUrl) {
  if ((!screenshots || screenshots.length === 0) && !videoUrl) return '';
  const vignettes = (screenshots || [])
    .slice(0, 4)
    .map(
      (url) =>
        `<img src="${escapeHtml(url)}" alt="" style="height:70px; border-radius:var(--radius-sm); border:1px solid var(--border-color); flex-shrink:0;">`
    )
    .join('');
  return `
    <div style="display:flex; gap:6px; align-items:center; overflow-x:auto; padding:2px 0;">
      ${vignettes}
      ${videoUrl ? '<span class="badge badge-en-cours" style="flex-shrink:0;">🎬 Vidéo</span>' : ''}
    </div>
  `;
}

function etoiles(note) {
  if (!note) return '';
  return '★'.repeat(note) + '☆'.repeat(5 - note);
}

async function chargerAvisApp(appId) {
  const container = document.getElementById('app-avis');
  try {
    const { avis } = await Api.get(`/api/apps/${appId}/avis`);
    if (!avis || avis.length === 0) {
      container.innerHTML = `<p class="form-hint">Aucun avis Play Store pour le moment.</p>`;
      return;
    }
    container.innerHTML = avis
      .map(
        (a) => `
        <div style="padding:12px 0; border-bottom:1px solid var(--border-color);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
            <strong style="font-size:13px;">${escapeHtml(a.author)}</strong>
            <span style="color:var(--color-warning); font-size:13px;">${etoiles(a.rating)}</span>
          </div>
          ${a.text ? `<p style="font-size:13px; color:var(--text-muted); margin-top:4px;">${escapeHtml(a.text)}</p>` : ''}
        </div>
      `
      )
      .join('');
  } catch (err) {
    container.innerHTML = `<p class="form-hint">Avis indisponibles pour le moment.</p>`;
  }
}

/* ==========================================================================
   CHAT PAR APPLICATION
   ========================================================================== */
let chatInterval = null;

function arreterChat() {
  if (chatInterval) {
    clearInterval(chatInterval);
    chatInterval = null;
  }
}

async function chargerMessagesChat(appId) {
  const container = document.getElementById('app-chat-messages');
  if (!container) {
    arreterChat();
    return;
  }
  try {
    const { messages } = await Api.get(`/api/apps/${appId}/messages`);
    const étaitEnBas = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

    if (messages.length === 0) {
      container.innerHTML = `<p class="form-hint">Aucun message pour le moment. Lancez la conversation !</p>`;
      return;
    }

    container.innerHTML = messages
      .map(
        (m) => `
        <div style="align-self:${m.de_moi ? 'flex-end' : 'flex-start'}; max-width:75%;">
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px; ${m.de_moi ? 'text-align:right;' : ''}">
            ${escapeHtml(m.pseudo)}${m.du_createur ? ' <span class="badge badge-en-cours" style="padding:1px 6px;">Créateur</span>' : ''}
          </div>
          <div style="background:${m.de_moi ? 'var(--primary)' : 'var(--bg-input)'}; color:${m.de_moi ? 'var(--text-dark)' : 'var(--text-white)'}; border:1px solid var(--border-color); border-radius:var(--radius-md); padding:8px 12px; font-size:13px; word-break:break-word;">
            ${escapeHtml(m.texte)}
          </div>
        </div>
      `
      )
      .join('');

    if (étaitEnBas) container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<p class="form-hint">Chat indisponible pour le moment.</p>`;
  }
}

function demarrerChat(appId) {
  arreterChat();
  chargerMessagesChat(appId);
  chatInterval = setInterval(() => chargerMessagesChat(appId), 6000);

  const form = document.getElementById('chat-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.texte;
    const texte = input.value.trim();
    if (!texte) return;
    input.value = '';
    try {
      await Api.post(`/api/apps/${appId}/messages`, { texte });
      chargerMessagesChat(appId);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ==========================================================================
   MES APPLICATIONS
   ========================================================================== */
async function viewMesApps() {
  viewRoot.innerHTML = `
    <h1 class="page-title">Mes applications</h1>
    <p class="page-subtitle">Soumettez une application et suivez le recrutement de vos 12 testeurs.</p>

    <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; margin-top:0; flex-wrap:wrap; gap:10px;">
      <span>Mes applications soumises</span>
      <button class="btn-primary" id="btn-toggle-submit">+ Ajouter une application</button>
    </div>
    <div id="mine-grid" class="card-grid" style="margin-bottom:24px;"><p class="page-subtitle">Chargement...</p></div>

    <div class="profile-card hidden" id="submit-card">
      <div class="section-title" style="margin-top:0;" id="submit-card-title">Soumettre une nouvelle application</div>
      <div id="submit-msg"></div>
      <form id="submit-form">
        <div class="form-group">
          <label>Nom du package (com.exemple.app)</label>
          <div class="package-import-row">
            <input type="text" name="package_name" placeholder="com.exemple.app" />
            <button type="button" class="btn-secondary" id="btn-import-playconsole">Importer depuis Play Console</button>
          </div>
          <p class="form-hint" style="margin-top:6px;">Récupère automatiquement le titre, la description, l'icône, les captures d'écran et la vidéo promo depuis votre fiche Play Console.</p>
          <div id="service-account-hint"></div>
          <div id="import-preview"></div>
        </div>
        <input type="hidden" name="nom_application" />
        <input type="hidden" name="logo_url" />
        <input type="hidden" name="description" />
        <div class="form-group">
          <label>Nom de l'application</label>
          <div id="apercu-nom" class="readonly-field">—</div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <div id="apercu-description" class="readonly-field">—</div>
        </div>
        <div style="display:flex; gap:10px;">
          <button type="submit" class="btn-primary" id="submit-form-btn">Créer le groupe de test</button>
          <button type="button" class="btn-secondary" id="btn-cancel-submit">Annuler</button>
        </div>
      </form>
    </div>
  `;

  const submitCard = document.getElementById('submit-card');
  const submitForm = document.getElementById('submit-form');
  const submitCardTitle = document.getElementById('submit-card-title');
  const submitFormBtn = document.getElementById('submit-form-btn');

  function renderImportPreview(screenshots, videoUrl) {
    const preview = document.getElementById('import-preview');
    const vignettes = (screenshots || [])
      .slice(0, 6)
      .map((url) => `<img src="${escapeHtml(url)}" alt="" style="width:56px;height:100px;object-fit:cover;border-radius:6px;border:1px solid var(--border-color);">`)
      .join('');
    preview.innerHTML =
      vignettes || videoUrl
        ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; align-items:center;">
            ${vignettes}
            ${videoUrl ? `<span class="badge badge-en-cours">🎬 Vidéo promo importée</span>` : ''}
          </div>`
        : '';
  }

  function appliquerApercuFiche(fiche) {
    submitForm.nom_application.value = fiche.nom_application || '';
    submitForm.logo_url.value = fiche.logo_url || '';
    submitForm.description.value = fiche.description || '';
    document.getElementById('apercu-nom').textContent = fiche.nom_application || '—';
    document.getElementById('apercu-description').textContent = fiche.description || '—';
    submitForm.dataset.screenshots = JSON.stringify(fiche.screenshots || []);
    submitForm.dataset.videoUrl = fiche.video_url || '';
    renderImportPreview(fiche.screenshots || [], fiche.video_url || '');
  }

  function ouvrirFormulaireCreation() {
    submitForm.reset();
    delete submitForm.dataset.editingId;
    appliquerApercuFiche({});
    submitCardTitle.textContent = 'Soumettre une nouvelle application';
    submitFormBtn.textContent = 'Créer le groupe de test';
    document.getElementById('submit-msg').innerHTML = '';
    submitCard.classList.remove('hidden');
    submitCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function ouvrirFormulaireEdition(app) {
    submitForm.reset();
    submitForm.dataset.editingId = app.id;
    submitForm.package_name.value = app.package_name || '';
    appliquerApercuFiche(app);
    submitCardTitle.textContent = `Modifier "${app.nom_application}"`;
    submitFormBtn.textContent = 'Enregistrer les modifications';
    document.getElementById('submit-msg').innerHTML = '';
    submitCard.classList.remove('hidden');
    submitCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  document.getElementById('btn-toggle-submit').addEventListener('click', () => {
    if (!submitCard.classList.contains('hidden')) {
      submitCard.classList.add('hidden');
      return;
    }
    ouvrirFormulaireCreation();
  });

  document.getElementById('btn-cancel-submit').addEventListener('click', () => {
    submitCard.classList.add('hidden');
  });

  let dernierPackageImporte = '';

  async function lancerImportPlayConsole(packageName) {
    const btn = document.getElementById('btn-import-playconsole');
    if (!packageName) {
      document.getElementById('submit-msg').innerHTML = `<div class="form-error">Renseignez d'abord le nom du package.</div>`;
      return;
    }
    dernierPackageImporte = packageName;
    btn.disabled = true;
    btn.textContent = 'Import en cours...';
    try {
      const fiche = await Api.post('/api/apps/import', { package_name: packageName });
      appliquerApercuFiche(fiche);
      document.getElementById('submit-msg').innerHTML = '';
      toast('Fiche importée depuis Play Console.', 'success');
    } catch (err) {
      document.getElementById('submit-msg').innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Importer depuis Play Console';
    }
  }

  document.getElementById('btn-import-playconsole').addEventListener('click', () => {
    lancerImportPlayConsole(submitForm.package_name.value.trim());
  });

  // Import automatique dès que l'utilisateur quitte le champ package (sans
  // avoir à cliquer sur le bouton), tant que la valeur a changé.
  submitForm.package_name.addEventListener('blur', () => {
    const val = submitForm.package_name.value.trim();
    if (val && val !== dernierPackageImporte) {
      lancerImportPlayConsole(val);
    }
  });

  submitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      nom_application: fd.get('nom_application'),
      package_name: fd.get('package_name'),
      logo_url: fd.get('logo_url'),
      description: fd.get('description'),
      screenshots: JSON.parse(submitForm.dataset.screenshots || '[]'),
      video_url: submitForm.dataset.videoUrl || '',
    };
    const editingId = submitForm.dataset.editingId;
    try {
      if (editingId) {
        await Api.put(`/api/apps/${editingId}`, payload);
        toast('Application mise à jour.', 'success');
      } else {
        await Api.post('/api/apps', payload);
        toast('Application créée, groupe de test généré.', 'success');
      }
      submitCard.classList.add('hidden');
      chargerMesApps(ouvrirFormulaireEdition);
    } catch (err) {
      document.getElementById('submit-msg').innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  });

  chargerMesApps(ouvrirFormulaireEdition);
  afficherEmailCompteService();
}

async function afficherEmailCompteService() {
  const hint = document.getElementById('service-account-hint');
  try {
    const { email } = await Api.get('/api/apps/service-account');
    if (email) {
      hint.innerHTML = `<p class="form-hint" style="margin-top:4px;">Ajoutez <strong>${escapeHtml(email)}</strong> dans Play Console → Utilisateurs et autorisations pour que l'import fonctionne sur cette app.</p>`;
    }
  } catch (_) {
    // Silencieux : indication facultative.
  }
}

async function chargerMesApps(onEdit) {
  const { applications } = await Api.get('/api/apps/mine');
  const grid = document.getElementById('mine-grid');

  if (applications.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🚀</div><p>Vous n'avez encore soumis aucune application.</p></div>`;
    return;
  }

  grid.innerHTML = applications
    .map(
      (app) => `
      <div class="app-card">
        <div class="app-card-top">
          <div class="app-logo">${app.logo_url ? `<img src="${escapeHtml(app.logo_url)}" alt="" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;">` : '📱'}</div>
          <div>
            <div class="app-card-title">${escapeHtml(app.nom_application)}</div>
            ${BADGE_APP[app.statut] || ''}
          </div>
        </div>
        ${renderMiniGalerie(app.screenshots, app.video_url)}
        <div class="gauge-row"><span class="gauge-label">Testeurs recrutés</span><span class="gauge-value">${app.mails_recrutes} / ${app.mails_max}</span></div>
        <div class="gauge-bar-bg"><div class="gauge-bar-fill" style="width:${Math.round((app.mails_recrutes / app.mails_max) * 100)}%"></div></div>
        <div class="app-card-actions">
          <button class="btn-secondary btn-block" data-edit-app="${app.id}">Éditer</button>
        </div>
      </div>
    `
    )
    .join('');

  grid.querySelectorAll('[data-edit-app]').forEach((btn) => {
    const app = applications.find((a) => String(a.id) === btn.dataset.editApp);
    btn.addEventListener('click', () => onEdit(app));
  });
}

/* ==========================================================================
   ADMIN
   ========================================================================== */
async function viewAdmin() {
  viewRoot.innerHTML = `<p class="page-subtitle">Chargement...</p>`;

  const [{ utilisateurs, applications: appStats, api_google }, { users }, { applications }] = await Promise.all([
    Api.get('/api/admin/stats'),
    Api.get('/api/admin/users'),
    Api.get('/api/admin/apps'),
  ]);

  viewRoot.innerHTML = `
    <h1 class="page-title">Tableau de bord administrateur</h1>
    <p class="page-subtitle">État de la plateforme, files d'API Google et gestion des exclusions.</p>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Utilisateurs</div><div class="stat-value">${utilisateurs.total}</div><div class="stat-sub">${utilisateurs.valides} validés · ${utilisateurs.suspendus} suspendus</div></div>
      <div class="stat-card"><div class="stat-label">Applications</div><div class="stat-value">${appStats.total}</div><div class="stat-sub">${appStats.en_cours} en cours · ${appStats.completes} complètes · ${appStats.terminees} terminées</div></div>
      <div class="stat-card"><div class="stat-label">Connexion Google</div><div class="stat-value" style="font-size:16px;">${api_google.auth_mode}</div></div>
      <div class="stat-card"><div class="stat-label">API Google Groups</div><div class="stat-value" style="font-size:16px;">${api_google.groups_mode}</div></div>
      <div class="stat-card"><div class="stat-label">API Play Reviews</div><div class="stat-value" style="font-size:16px;">${api_google.reviews_mode}</div></div>
    </div>

    <div class="section-title">Utilisateurs</div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Pseudo</th><th>Email</th><th>Statut</th><th>Score</th><th>Mails</th><th>Avertissements</th><th>Activité</th><th>Actions</th></tr></thead>
        <tbody id="users-tbody"></tbody>
      </table>
    </div>

    <div class="section-title">Applications</div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Nom</th><th>Créateur</th><th>Statut</th><th>Testeurs</th><th>Créée le</th></tr></thead>
        <tbody id="apps-tbody"></tbody>
      </table>
    </div>

    <div class="section-title">Console d'activité</div>
    <div class="profile-card" style="padding:16px;">
      <div id="activity-console"><p class="form-hint">Chargement...</p></div>
    </div>
  `;

  chargerConsoleActivite();

  const usersTbody = document.getElementById('users-tbody');
  usersTbody.innerHTML = users
    .map(
      (u) => `
      <tr class="admin-user-row" id="user-row-${u.id}">
        <td data-label="Pseudo" class="row-summary">${escapeHtml(u.pseudo)}<span class="row-toggle-chevron">▾</span></td>
        <td data-label="Email" class="row-detail">${u.masquer_infos ? '<span class="form-hint" title="Masqué par l\'utilisateur">•••••••• (masqué)</span>' : escapeHtml(u.email)}</td>
        <td data-label="Statut" class="row-summary">${u.suspendu ? '<span class="badge badge-suspendu">Suspendu</span>' : BADGE_PROFIL[u.statut_profil] || ''}</td>
        <td data-label="Score" class="row-summary">${u.score_global}/100</td>
        <td data-label="Mails" class="row-detail">${u.mails_debloques}/${u.mails_max}</td>
        <td data-label="Avertissements" class="row-detail">${u.fraud_warnings}/3</td>
        <td data-label="Activité" class="row-detail"><button class="btn-ghost" data-toggle-activite="${u.id}">Voir activité</button></td>
        <td data-label="Actions" class="row-detail">
          <div class="admin-actions">
            <div class="action-group">
              <span class="action-group-label">Score</span>
              <div class="action-group-buttons">
                <button class="btn-xs btn-secondary" data-adjust="${u.id}" data-delta="1" ${u.id === state.user.id ? 'disabled' : ''}>+1</button>
                <button class="btn-xs btn-secondary" data-adjust="${u.id}" data-delta="5" ${u.id === state.user.id ? 'disabled' : ''}>+5</button>
                <button class="btn-xs btn-secondary" data-adjust="${u.id}" data-delta="10" ${u.id === state.user.id ? 'disabled' : ''}>+10</button>
                <button class="btn-xs btn-danger" data-adjust="${u.id}" data-delta="-20" ${u.id === state.user.id ? 'disabled' : ''}>-20</button>
                <button class="btn-xs btn-danger" data-ban="${u.id}" data-score="${u.score_global}" ${u.id === state.user.id ? 'disabled' : ''}>Ban</button>
              </div>
            </div>
            <div class="action-group">
              <span class="action-group-label">Modération</span>
              <div class="action-group-buttons">
                <button class="btn-xs btn-secondary" data-warn="${u.id}" ${u.id === state.user.id ? 'disabled' : ''}>Avertir</button>
                <button class="btn-xs btn-danger" data-exclude="${u.id}" ${u.id === state.user.id ? 'disabled' : ''}>Exclure</button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `
    )
    .join('');

  // Sur mobile, chaque ligne est une card repliée par défaut (résumé
  // Pseudo/Statut/Score) : un clic sur le résumé déplie le détail/actions.
  usersTbody.querySelectorAll('.admin-user-row').forEach((row) => {
    row.querySelectorAll('.row-summary').forEach((cell) => {
      cell.addEventListener('click', () => row.classList.toggle('expanded'));
    });
  });

  usersTbody.querySelectorAll('[data-adjust]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const delta = Number(btn.dataset.delta);
      try {
        await Api.post(`/api/admin/users/${btn.dataset.adjust}/adjust-score`, { delta });
        toast(`Score ajusté (${delta > 0 ? '+' : ''}${delta} pt).`, 'success');
        viewAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  usersTbody.querySelectorAll('[data-ban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer tous les points (et les mails actifs) de cet utilisateur ?')) return;
      try {
        await Api.post(`/api/admin/users/${btn.dataset.ban}/adjust-score`, { delta: -Number(btn.dataset.score) });
        toast('Tous les points ont été retirés.', 'success');
        viewAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  usersTbody.querySelectorAll('[data-warn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const raison = prompt('Raison de l\'avertissement (tentative de fraude) :');
      if (raison === null) return;
      try {
        await Api.post(`/api/admin/users/${btn.dataset.warn}/warn`, { raison });
        toast('Avertissement enregistré.', 'success');
        viewAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  usersTbody.querySelectorAll('[data-exclude]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Exclure définitivement cet utilisateur et le retirer de tous les groupes ?')) return;
      try {
        await Api.post(`/api/admin/users/${btn.dataset.exclude}/exclude`, {});
        toast('Utilisateur exclu.', 'success');
        viewAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  usersTbody.querySelectorAll('[data-toggle-activite]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.toggleActivite;
      const existing = document.getElementById(`user-activite-${userId}`);
      if (existing) {
        existing.remove();
        btn.textContent = 'Voir activité';
        return;
      }
      document.querySelectorAll('[id^="user-activite-"]').forEach((el) => el.remove());
      usersTbody.querySelectorAll('[data-toggle-activite]').forEach((b) => (b.textContent = 'Voir activité'));

      try {
        const { logs } = await Api.get(`/api/admin/users/${userId}/logs`);
        const row = document.getElementById(`user-row-${userId}`);
        row.insertAdjacentHTML(
          'afterend',
          `<tr id="user-activite-${userId}"><td colspan="8" style="background:var(--bg-input);">${renderLogsList(logs)}</td></tr>`
        );
        btn.textContent = 'Masquer activité';
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  document.getElementById('apps-tbody').innerHTML = applications
    .map(
      (a) => `
      <tr id="app-row-${a.id}">
        <td data-label="Nom">${escapeHtml(a.nom_application)}</td>
        <td data-label="Créateur">${escapeHtml(a.developpeur?.pseudo || '—')}<br><span class="form-hint">${escapeHtml(a.developpeur?.email || '')}</span></td>
        <td data-label="Statut">${BADGE_APP[a.statut] || ''}</td>
        <td data-label="Testeurs">${a.mails_recrutes}/${a.mails_max} <button class="btn-ghost" data-toggle-testeurs="${a.id}">Voir testeurs</button></td>
        <td data-label="Créée le">${escapeHtml(a.created_at)}</td>
      </tr>
    `
    )
    .join('');

  document.querySelectorAll('[data-toggle-testeurs]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const appId = btn.dataset.toggleTesteurs;
      const existing = document.getElementById(`app-testeurs-${appId}`);
      if (existing) {
        existing.remove();
        btn.textContent = 'Voir testeurs';
        return;
      }
      document.querySelectorAll('[id^="app-testeurs-"]').forEach((el) => el.remove());
      document.querySelectorAll('[data-toggle-testeurs]').forEach((b) => (b.textContent = 'Voir testeurs'));

      try {
        const { testeurs } = await Api.get(`/api/admin/apps/${appId}/testeurs`);
        const contenu = testeurs.length
          ? testeurs
              .map(
                (t) => `
              <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--border-color);">
                <span>${escapeHtml(t.pseudo)} — ${t.masquer_infos ? '•••••••• (masqué)' : escapeHtml(t.email)}</span>
                ${BADGE_HISTORIQUE[t.statut] || ''}
              </div>
            `
              )
              .join('')
          : '<p class="form-hint">Aucun testeur pour cette application.</p>';

        document
          .getElementById(`app-row-${appId}`)
          .insertAdjacentHTML(
            'afterend',
            `<tr id="app-testeurs-${appId}"><td colspan="5" style="background:var(--bg-input);">${contenu}</td></tr>`
          );
        btn.textContent = 'Masquer testeurs';
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function tempsRelatif(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z');
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

function renderLogsList(logs, avecUtilisateur) {
  if (!logs || logs.length === 0) {
    return '<p class="form-hint">Aucune activité enregistrée.</p>';
  }
  return `
    <div style="display:flex; flex-direction:column; gap:2px; max-height:360px; overflow-y:auto;">
      ${logs
        .map(
          (l) => `
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:8px 0; border-bottom:1px solid var(--border-color); font-size:13px;">
          <span>${avecUtilisateur ? `<strong>${escapeHtml(l.pseudo)}</strong> — ` : ''}${escapeHtml(l.action)}${l.details ? ` <span class="form-hint">(${escapeHtml(l.details)})</span>` : ''}</span>
          <span class="form-hint" style="white-space:nowrap;">${tempsRelatif(l.created_at)}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

async function chargerConsoleActivite() {
  const container = document.getElementById('activity-console');
  try {
    const { logs } = await Api.get('/api/admin/logs');
    container.innerHTML = renderLogsList(logs, true);
  } catch (err) {
    container.innerHTML = `<p class="form-hint">Impossible de charger la console d'activité.</p>`;
  }
}

/* ==========================================================================
   ÉDITEUR (vidéo/photo promo)
   ========================================================================== */
function renderFilePicker(inputId, accept, filenameId) {
  return `
    <div class="editor-file-picker-wrap">
      <label class="editor-file-picker" for="${inputId}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        <span>Choisir un fichier</span>
      </label>
      <input type="file" id="${inputId}" accept="${accept}" class="editor-file-input">
      <span class="editor-file-name" id="${filenameId}">Aucun fichier choisi</span>
    </div>
  `;
}

function viewEditeur() {
  viewRoot.innerHTML = `
    <h1 class="page-title">Éditeur</h1>
    <p class="page-subtitle">Composez une vidéo ou une image promo : intro, photos (chacune avec sa durée et son texte), outro, musique et police perso. Tout se passe dans votre navigateur, rien n'est envoyé au serveur.
      <a href="/api-docs.html" target="_blank" rel="noopener" style="margin-left:10px; white-space:nowrap;">📄 Documentation API (pilotage IA)</a>
    </p>

    <div class="editor-layout">
      <div class="editor-canvas-wrap">
        <div class="editor-canvas-stage">
          <canvas id="editor-canvas" width="1920" height="1080"></canvas>
          <div class="editor-crop-overlay hidden" id="editor-crop-overlay">
            <div class="editor-crop-overlay-frame" id="editor-crop-overlay-frame"></div>
            <span class="editor-crop-overlay-label" id="editor-crop-overlay-label"></span>
          </div>
          <div class="editor-align-guides" id="editor-align-guides">
            <div class="editor-align-guide editor-align-guide-v" data-guide="center-v" style="left:50%;"></div>
            <div class="editor-align-guide editor-align-guide-h" data-guide="center-h" style="top:50%;"></div>
            <div class="editor-align-guide editor-align-guide-v" data-guide="third-v1" style="left:33.333%;"></div>
            <div class="editor-align-guide editor-align-guide-v" data-guide="third-v2" style="left:66.667%;"></div>
            <div class="editor-align-guide editor-align-guide-h" data-guide="third-h1" style="top:33.333%;"></div>
            <div class="editor-align-guide editor-align-guide-h" data-guide="third-h2" style="top:66.667%;"></div>
          </div>
        </div>
        <div class="editor-hint">Glissez le texte fixe, la photo active ou sa légende directement sur l'aperçu pour les repositionner.</div>
        <div class="editor-timeline">
          <button type="button" id="editor-play-btn" class="editor-play-btn" title="Lecture / Pause">▶</button>
          <input type="range" id="editor-scrubber" min="0" max="100" step="0.5" value="0">
          <span class="editor-time-label" id="editor-time-label">0.0s / 0.0s</span>
          <button type="button" id="editor-undo-btn" class="btn-secondary" title="Annuler (Ctrl+Z)" disabled>↺</button>
          <button type="button" id="editor-redo-btn" class="btn-secondary" title="Rétablir (Ctrl+Y)" disabled>↻</button>
        </div>
        <div class="editor-progress hidden" id="editor-export-progress">
          <div class="editor-progress-bar"><div class="editor-progress-fill" id="editor-progress-fill"></div></div>
          <span class="editor-progress-label" id="editor-progress-label">Export en cours… 0%</span>
        </div>
      </div>

      <div class="editor-controls">
        <details class="editor-accordion" open>
          <summary>Projet</summary>
          <div class="editor-accordion-body">
            <div class="editor-projet-autosave-banner hidden" id="editor-projet-autosave-banner">
              <span>Un brouillon a été sauvegardé automatiquement lors d'une session précédente.</span>
              <div class="editor-row" style="justify-content:flex-end;">
                <button type="button" id="editor-projet-ignorer-autosave" class="btn-secondary">Ignorer</button>
                <button type="button" id="editor-projet-restaurer-autosave" class="btn-primary">Restaurer le brouillon</button>
              </div>
            </div>
            <div class="editor-section">
              <label class="editor-label">Nom du projet</label>
              <input type="text" id="editor-projet-nom" placeholder="Projet sans titre" maxlength="80">
            </div>
            <div class="editor-row">
              <button type="button" id="editor-projet-nouveau" class="btn-secondary">Nouveau</button>
              <button type="button" id="editor-projet-enregistrer-sous" class="btn-secondary">Enregistrer sous...</button>
              <button type="button" id="editor-projet-checkpoint" class="btn-secondary">+ Point de sauvegarde</button>
              <button type="button" id="editor-projet-enregistrer" class="btn-primary">Enregistrer</button>
            </div>
            <details class="editor-accordion-nested">
              <summary>Projets enregistrés</summary>
              <div class="editor-accordion-nested-body">
                <div id="editor-projet-liste" class="editor-projet-liste"></div>
              </div>
            </details>
            <details class="editor-accordion-nested">
              <summary>Points de sauvegarde de ce projet</summary>
              <div class="editor-accordion-nested-body">
                <div id="editor-projet-checkpoints" class="editor-projet-liste"></div>
              </div>
            </details>
            <details class="editor-accordion-nested">
              <summary>Fichier (export / import)</summary>
              <div class="editor-accordion-nested-body">
                <div class="editor-row">
                  <button type="button" id="editor-projet-export" class="btn-secondary">Exporter le projet (.json)</button>
                  <label class="editor-file-picker" for="editor-projet-import-input">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
                    <span>Importer un projet</span>
                  </label>
                  <input type="file" id="editor-projet-import-input" accept=".json,application/json" class="editor-file-input">
                </div>
                <span class="form-hint">Le fichier exporté contient tout le projet (réglages + médias). Pratique pour le sauvegarder hors navigateur ou le transférer sur un autre appareil.</span>
              </div>
            </details>
          </div>
        </details>

        <details class="editor-accordion" open>
          <summary>Fond &amp; musique</summary>
          <div class="editor-accordion-body">
            <div class="editor-section">
              <label class="editor-label">Type de fond</label>
              <div class="editor-row">
                <select id="editor-bg-type">
                  <option value="media">Vidéo / image</option>
                  <option value="color">Couleur unie</option>
                  <option value="gradient">Dégradé</option>
                </select>
              </div>
            </div>
            <div class="editor-section" id="editor-bg-media-panel">
              <label class="editor-label">Fond (vidéo MP4 ou image)</label>
              ${renderFilePicker('editor-bg-input', 'video/mp4,image/png,image/jpeg', 'editor-bg-filename')}
            </div>
            <details class="editor-accordion-nested">
              <summary>Bibliothèque Pixabay (vidéos &amp; images libres de droits)</summary>
              <div class="editor-accordion-nested-body">
                <span class="form-hint">Nécessite une clé API Pixabay (section "Clés API IA" plus bas, gratuite). Le résultat choisi remplace le fond ci-dessus.</span>
                <div class="editor-row">
                  <input type="text" id="editor-pixabay-recherche" placeholder="Ex : anime fight, ville, nature...">
                  <select id="editor-pixabay-type">
                    <option value="videos">Vidéos</option>
                    <option value="photos">Images</option>
                  </select>
                  <button type="button" id="editor-pixabay-chercher" class="editor-add-btn">Rechercher</button>
                </div>
                <div id="editor-pixabay-resultats" class="editor-pixabay-grille"></div>
              </div>
            </details>
            <div class="editor-section hidden" id="editor-bg-color-panel">
              <label class="editor-label">Couleur du fond</label>
              <input type="color" id="editor-bg-color" value="#12151c">
            </div>
            <div class="editor-section hidden" id="editor-bg-gradient-panel">
              <label class="editor-label">Dégradé du fond</label>
              <div class="editor-row">
                <input type="color" id="editor-bg-gradient1" value="#0f2027" title="Couleur 1">
                <input type="color" id="editor-bg-gradient2" value="#2c5364" title="Couleur 2">
                <label class="editor-mini-label">Angle<input type="range" id="editor-bg-gradient-angle" min="0" max="360" value="135"></label>
              </div>
            </div>
            <details class="editor-accordion-nested">
              <summary>Réglages &amp; overlay</summary>
              <div class="editor-accordion-nested-body">
                <div class="editor-row">
                  <label class="editor-mini-label">Luminosité<input type="range" id="editor-bg-brightness" min="30" max="160" value="100"></label>
                  <label class="editor-mini-label">Flou<input type="range" id="editor-bg-blur" min="0" max="15" value="0"></label>
                </div>
                <div class="editor-row">
                  <label class="editor-mini-label">Overlay
                    <select id="editor-overlay-type">
                      <option value="none">Aucun</option>
                      <option value="vignette">Vignette</option>
                      <option value="grain">Grain</option>
                    </select>
                  </label>
                  <label class="editor-mini-label">Intensité<input type="range" id="editor-overlay-strength" min="10" max="100" value="50"></label>
                </div>
                <div class="editor-row">
                  <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" id="editor-bg-chromakey-toggle"><span class="editor-toggle-switch"></span><span>Clé chromatique (fond vert)</span></label>
                  <input type="color" id="editor-bg-chromakey-color" value="#00ff00" title="Couleur à retirer">
                </div>
                <div class="editor-row">
                  <label class="editor-mini-label">Tolérance<input type="range" id="editor-bg-chromakey-tolerance" min="5" max="80" value="35"></label>
                </div>
              </div>
            </details>
            <div class="editor-section">
              <label class="editor-label">Musique de fond (MP3)</label>
              ${renderFilePicker('editor-audio-input', 'audio/mpeg,audio/mp3', 'editor-audio-filename')}
              <canvas id="editor-waveform" width="600" height="44" style="width:100%; height:44px; border-radius:var(--radius-sm); background:var(--bg-darker);"></canvas>
            </div>
            <details class="editor-accordion-nested">
              <summary>Volume, fondu &amp; extrait</summary>
              <div class="editor-accordion-nested-body">
                <div class="editor-row">
                  <label class="editor-mini-label">Volume<input type="range" id="editor-audio-volume" min="0" max="100" value="80"></label>
                  <label class="editor-mini-label">Départ dans la piste (s)<input type="number" id="editor-audio-trim" min="0" step="0.5" value="0" style="max-width:80px;"></label>
                </div>
                <div class="editor-row">
                  <label class="editor-mini-label">Fondu entrée (s)<input type="number" id="editor-audio-fadein" min="0" max="10" step="0.5" value="0" style="max-width:80px;"></label>
                  <label class="editor-mini-label">Fondu sortie (s)<input type="number" id="editor-audio-fadeout" min="0" max="10" step="0.5" value="0" style="max-width:80px;"></label>
                </div>
              </div>
            </details>
            <div class="editor-section">
              <label class="editor-label">Voix off (optionnelle, jouée une fois)</label>
              ${renderFilePicker('editor-voice-input', 'audio/mpeg,audio/mp3', 'editor-voice-filename')}
              <label class="editor-mini-label">Volume<input type="range" id="editor-voice-volume" min="0" max="100" value="100"></label>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Intro</summary>
          <div class="editor-accordion-body">
            <label class="editor-toggle-row"><input type="checkbox" id="editor-intro-toggle"><span class="editor-toggle-switch"></span><span>Ajouter une intro</span></label>
            <div class="editor-subpanel hidden" id="editor-intro-panel">
              <span class="editor-mini-heading">Logo</span>
              ${renderFilePicker('editor-intro-logo-input', 'image/png', 'editor-intro-logo-filename')}
              <span class="editor-mini-heading">Image</span>
              ${renderFilePicker('editor-intro-img-input', 'image/png', 'editor-intro-img-filename')}
              <textarea id="editor-intro-text" rows="2" placeholder="Texte de l'intro..."></textarea>
              <label class="editor-mini-label">Durée (s)<input type="number" id="editor-intro-duree" min="0.5" max="20" step="0.5" value="3" style="max-width:90px;"></label>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Photos / Vidéos</summary>
          <div class="editor-accordion-body">
            <div class="editor-row">
              <label class="editor-mini-label">Transition entre photos
                <select id="editor-transition-type">
                  <option value="none">Aucune (coupe franche)</option>
                  <option value="fade">Fondu</option>
                  <option value="slide">Glissement</option>
                  <option value="zoom">Zoom</option>
                </select>
              </label>
            </div>
            <div class="editor-row" style="justify-content:flex-end;">
              <button type="button" id="editor-add-photo" class="editor-add-btn">+ Ajouter une photo/vidéo</button>
            </div>
            <div class="editor-bulk-bar hidden" id="editor-photos-bulk-bar">
              <span id="editor-photos-bulk-count">0 sélectionné(s)</span>
              <div class="editor-row" style="gap:6px;">
                <button type="button" data-bulk="photo" data-bulk-action="lock">Verrouiller</button>
                <button type="button" data-bulk="photo" data-bulk-action="hide">Masquer</button>
                <button type="button" data-bulk="photo" data-bulk-action="duplicate">Dupliquer</button>
                <button type="button" data-bulk="photo" data-bulk-action="delete" class="editor-remove-btn">Supprimer</button>
              </div>
            </div>
            <div id="editor-photos-list" class="editor-photos-list"></div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Outro</summary>
          <div class="editor-accordion-body">
            <label class="editor-toggle-row"><input type="checkbox" id="editor-outro-toggle"><span class="editor-toggle-switch"></span><span>Ajouter une outro</span></label>
            <div class="editor-subpanel hidden" id="editor-outro-panel">
              <span class="editor-mini-heading">Logo</span>
              ${renderFilePicker('editor-outro-logo-input', 'image/png', 'editor-outro-logo-filename')}
              <span class="editor-mini-heading">Image</span>
              ${renderFilePicker('editor-outro-img-input', 'image/png', 'editor-outro-img-filename')}
              <textarea id="editor-outro-text" rows="2" placeholder="Texte de l'outro..."></textarea>
              <label class="editor-mini-label">Durée (s)<input type="number" id="editor-outro-duree" min="0.5" max="20" step="0.5" value="3" style="max-width:90px;"></label>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Textes</summary>
          <div class="editor-accordion-body">
            <div class="editor-section">
              <label class="editor-label">Police d'écriture personnalisée (optionnelle)</label>
              ${renderFilePicker('editor-font-input', '.ttf,.otf,.woff,.woff2', 'editor-font-filename')}
              <span class="form-hint">Utilisable pour un texte en sélectionnant "Police importée" dans son style.</span>
            </div>
            <div class="editor-row" style="justify-content:flex-end;">
              <button type="button" id="editor-add-textblock" class="editor-add-btn">+ Ajouter un texte</button>
            </div>
            <div class="editor-bulk-bar hidden" id="editor-textblocks-bulk-bar">
              <span id="editor-textblocks-bulk-count">0 sélectionné(s)</span>
              <div class="editor-row" style="gap:6px;">
                <button type="button" data-bulk="textblock" data-bulk-action="lock">Verrouiller</button>
                <button type="button" data-bulk="textblock" data-bulk-action="hide">Masquer</button>
                <button type="button" data-bulk="textblock" data-bulk-action="duplicate">Dupliquer</button>
                <button type="button" data-bulk="textblock" data-bulk-action="delete" class="editor-remove-btn">Supprimer</button>
              </div>
            </div>
            <div id="editor-textblocks-list" class="editor-photos-list"></div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Formes &amp; stickers</summary>
          <div class="editor-accordion-body">
            <span class="form-hint">Rectangles, cercles, étoiles, flèches... ou stickers emoji, superposés au visuel à tout moment (indépendants des photos, comme les blocs de texte).</span>
            <div class="editor-row" style="justify-content:flex-end;">
              <button type="button" id="editor-add-shape" class="editor-add-btn">+ Ajouter une forme/sticker</button>
            </div>
            <div class="editor-bulk-bar hidden" id="editor-shapes-bulk-bar">
              <span id="editor-shapes-bulk-count">0 sélectionné(s)</span>
              <div class="editor-row" style="gap:6px;">
                <button type="button" data-bulk="forme" data-bulk-action="lock">Verrouiller</button>
                <button type="button" data-bulk="forme" data-bulk-action="hide">Masquer</button>
                <button type="button" data-bulk="forme" data-bulk-action="duplicate">Dupliquer</button>
                <button type="button" data-bulk="forme" data-bulk-action="delete" class="editor-remove-btn">Supprimer</button>
              </div>
            </div>
            <div id="editor-shapes-list" class="editor-photos-list"></div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Dessin libre</summary>
          <div class="editor-accordion-body">
            <span class="form-hint">Dessinez directement sur l'aperçu au pinceau — pratique pour annoter, souligner ou pointer un détail à main levée.</span>
            <div class="editor-row">
              <button type="button" id="editor-dessin-toggle" class="editor-add-btn">Activer le dessin libre</button>
            </div>
            <div class="editor-row">
              <input type="color" id="editor-dessin-couleur" value="#ff2d95" title="Couleur du trait">
              <label class="editor-mini-label">Épaisseur<input type="range" id="editor-dessin-epaisseur" min="1" max="30" value="6"></label>
            </div>
            <div class="editor-row">
              <span id="editor-dessin-compte" class="form-hint">Aucun trait dessiné</span>
            </div>
            <div class="editor-row">
              <button type="button" id="editor-dessin-undo" class="btn-secondary">Annuler le dernier trait</button>
              <button type="button" id="editor-dessin-clear" class="editor-remove-btn">Tout effacer</button>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Cadre décoratif</summary>
          <div class="editor-accordion-body">
            <span class="form-hint">Bordure fixe superposée à tout le montage (au-dessus des photos, textes et effets).</span>
            <div class="editor-row">
              <select id="editor-cadre-type">
                <option value="none">Aucun</option>
                <option value="simple">Bordure simple</option>
                <option value="double">Bordure double</option>
                <option value="coins">Coins (repères d'angle)</option>
                <option value="pellicule">Pellicule (bandes + perforations)</option>
                <option value="polaroid">Polaroid</option>
              </select>
            </div>
            <div class="editor-row">
              <input type="color" id="editor-cadre-couleur" value="#ffffff" title="Couleur du cadre">
              <label class="editor-mini-label">Épaisseur<input type="range" id="editor-cadre-epaisseur" min="4" max="80" value="24"></label>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Effets lumineux (glow)</summary>
          <div class="editor-accordion-body">
            <label class="editor-toggle-row"><input type="checkbox" id="editor-bloom-toggle"><span class="editor-toggle-switch"></span><span>Activer le halo lumineux</span></label>
            <label class="editor-mini-label">Intensité<input type="range" id="editor-bloom-strength" min="0" max="30" value="8"></label>
            <label class="editor-toggle-row"><input type="checkbox" id="editor-bloom-audioreactive"><span class="editor-toggle-switch"></span><span>Lier l'intensité à la musique</span></label>
            <span class="form-hint">Amplifie les contours énergétiques et particules activés sur une photo. Coûteux en performance.</span>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Clés API IA</summary>
          <div class="editor-accordion-body">
            <span class="form-hint">Les fonctionnalités IA (sous-titres auto, suppression de fond, voix off...) appellent directement le fournisseur choisi depuis votre navigateur, avec votre propre clé. Rien n'est envoyé à nos serveurs, et rien n'est utilisable sans clé renseignée ici.</span>
            <div class="editor-section">
              <label class="editor-label">Clé API OpenAI (sous-titres, traduction, voix off, retouche)</label>
              <input type="password" id="editor-ai-key-openai" placeholder="sk-..." autocomplete="off">
            </div>
            <div class="editor-section">
              <label class="editor-label">Clé API remove.bg (suppression de fond automatique)</label>
              <input type="password" id="editor-ai-key-removebg" placeholder="Clé API remove.bg" autocomplete="off">
            </div>
            <div class="editor-section">
              <label class="editor-label">Clé API Pixabay (bibliothèque de vidéos/images pour le fond)</label>
              <input type="password" id="editor-ai-key-pixabay" placeholder="Clé API Pixabay" autocomplete="off">
              <span class="form-hint">Gratuite sur pixabay.com/api/docs/ (compte requis). Utilisée dans la section "Fond & musique" pour chercher des vidéos/images libres de droits.</span>
            </div>
          </div>
        </details>

        <details class="editor-accordion">
          <summary>Export</summary>
          <div class="editor-accordion-body">
            <div class="editor-section">
              <label class="editor-label">Format des images exportées</label>
              <div class="editor-row">
                <label class="editor-radio-row"><input type="radio" name="editor-img-format" value="playstore" checked> Vertical Play Store (1080×1920)</label>
                <label class="editor-radio-row"><input type="radio" name="editor-img-format" value="square"> Carré (1080×1080)</label>
              </div>
              <div class="editor-row">
                <label class="editor-toggle-row" style="margin:0;"><input type="checkbox" id="editor-crop-overlay-toggle"><span class="editor-toggle-switch"></span><span>Afficher la zone de capture (PNG/GIF) sur l'aperçu</span></label>
              </div>
              <span class="form-hint">Le PNG recadre selon le format choisi ci-dessus ; le GIF garde le cadre plein 1920×1080 (identique à la vidéo), sans recadrage.</span>
            </div>
            <div class="editor-section">
              <label class="editor-label">Nom du fichier</label>
              <input type="text" id="editor-filename" placeholder="playtesteur-promo" maxlength="80">
            </div>
            <div class="editor-section">
              <label class="editor-label">Images par seconde (vidéo/GIF)</label>
              <select id="editor-export-fps">
                <option value="24">24 im/s (le plus rapide à exporter)</option>
                <option value="30" selected>30 im/s (recommandé)</option>
                <option value="60">60 im/s (le plus fluide)</option>
              </select>
              <span class="form-hint">La vidéo exportée dure toujours exactement la durée de votre montage (intro + photos + outro), quel que soit le temps que prend le rendu. Sur une scène très chargée (beaucoup d'effets), certaines images peuvent être répétées à l'écran, mais la durée et l'audio restent corrects.</span>
            </div>
          </div>
        </details>

        <div class="editor-actions">
          <button id="editor-export-png" class="btn-secondary" type="button">Exporter en PNG</button>
          <button id="editor-export-gif" class="btn-secondary" type="button">Exporter en GIF</button>
          <button id="editor-export-mp4" class="btn-primary" type="button">Exporter en MP4 (1920×1080)</button>
        </div>
      </div>
    </div>
  `;
  if (typeof initEditeur === 'function') initEditeur();
}

/* ==========================================================================
   BOOTSTRAP
   ========================================================================== */
(async function init() {
  try {
    const { user } = await Api.get('/api/auth/me');
    state.user = user;
  } catch (_) {
    state.user = null;
  }
  router();
})();
