# PlayTesteur

Plateforme d'entraide entre développeurs Android : réciprocité stricte et
gamification automatisée pour obtenir les 12 testeurs uniques exigés par
Google Play en test fermé.

## Démarrage rapide

```bash
npm install
npm start
```

Le serveur démarre sur `http://localhost:8090` (configurable via `PORT`).
Sans configuration Google (voir plus bas), l'application démarre en **mode
dev** : la connexion Google, les Google Groups et la détection d'avis Play
Store sont simulés (formulaire `/api/auth/dev-login` à la place du bouton
Google), ce qui permet de tester tout le parcours (connexion, score,
paliers, sanctions de minuit) sans compte Google Workspace / Play Console.

## Architecture

- **Serveur** : Node.js + Express (`server.js`, routes dans `src/routes/`)
- **Base de données** : `node:sqlite` (module natif Node ≥ 22.5, zéro
  dépendance native à compiler), fichier `data/playtesteur.db`
- **Frontend** : SPA vanilla JS (`public/`), aucun framework, style repris du
  design system sombre/orange de l'Anime Tracker VF (police Outfit)
- **Cron** : `node-cron`, job de minuit dans `src/jobs/midnightJob.js`
- **Intégrations Google** : `googleapis`, services dans `src/services/`

## Moteur de scoring

Barème 0-100 points / 0-12 mails actifs, décroissance de 100/12 ≈ 8,33
points par palier (formule dans `src/services/scoring.js`) :

1. **Ticket d'entrée** : les 9 premiers tests validés ne rapportent ni
   score ni mail (seul le compteur anti-doublon avance). Le 10ᵉ test
   distinct valide le profil et débloque le 1er mail actif.
2. **Routine quotidienne** : une fois le profil validé, chaque jour où un
   nouveau test est validé rapporte +1 mail (max 12) et ~+8,33 points
   (max 100), plafonné à un gain par jour calendaire.
3. **Sanction de minuit** : chaque nuit, tout utilisateur validé n'ayant
   validé aucun test la veille perd 5 points. Si son score descend sous le
   palier correspondant à son nombre de mails, les mails excédentaires
   (les plus récemment acquis) sont retirés et l'utilisateur est éjecté des
   Google Groups correspondants. À 0 mail, le profil repasse en attente et
   tous les groupes actifs (y compris les tests en cours) sont quittés.
4. **Clôture réciproque** : une application ayant atteint 12/12 mails est
   clôturée (`Terminé_Inactif`) si son créateur n'a plus lui-même validé de
   test depuis 3 jours consécutifs.
5. **Anti-doublon** : contrainte unique `(testeur_id, application_id)` —
   une application testée disparaît définitivement du catalogue du testeur.

## Authentification

Seul mode de connexion : **"Continuer avec Google"** (OAuth 2.0 /
OpenID Connect, aucun mot de passe stocké). La page de connexion affiche un
avertissement explicite : l'utilisateur doit se connecter avec le **même
compte Google que celui lié à sa Google Play Console**, car c'est cet email
qui est ajouté aux Google Groups de test (voir `src/services/googleAuth.js`).

Configuration (Console Cloud > API et services > Identifiants > ID client
OAuth > Application Web) :

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8090/api/auth/google/callback
```

Ajoutez `GOOGLE_OAUTH_REDIRECT_URI` dans les "URI de redirection autorisés"
du client OAuth. Sans ces variables, le bouton Google est remplacé par un
formulaire de connexion simulée (`/api/auth/dev-login`).

## Configuration Google (Groups / Play Reviews)

Deux intégrations optionnelles supplémentaires dans `.env` :

- **Google Groups (Admin SDK Directory)** : nécessite un domaine **Google
  Workspace** (les Google Groups ne sont pas disponibles sur un compte
  Gmail gratuit) et un compte de service avec délégation domaine-wide,
  scopes `admin.directory.group` et `admin.directory.group.member`.
- **Google Play Developer API (Android Publisher - reviews.list)** :
  nécessite que le même compte de service (ou un autre) soit ajouté dans
  Play Console > Utilisateurs et autorisations avec accès à l'API activé.

Sans ces variables, `src/services/googleGroups.js` et
`src/services/playReviews.js` basculent automatiquement en mode simulé
(log `MODE DEV` au démarrage) — visible aussi dans le tableau de bord
admin (`État de l'API Google`).

## Comptes administrateur

Il n'y a pas d'inscription admin dédiée : promouvoir un compte existant
(après une première connexion Google) directement en base :

```bash
node -e "require('./src/db/init').prepare(\"UPDATE users SET role='administrator' WHERE email = ?\").run('vous@exemple.com')"
```

## Structure

```
server.js                  point d'entrée (Express, sessions, cron)
src/db/init.js              schéma SQLite (users, applications, historique_tests, fraud_log)
src/services/scoring.js     barème paliers / gains / sanctions
src/services/googleAuth.js    OAuth "Se connecter avec Google" + mode dev
src/services/googleGroups.js  Admin SDK Directory + mode dev
src/services/playReviews.js   Android Publisher reviews.list + mode dev
src/routes/                 auth, profile, apps, admin
src/jobs/midnightJob.js     cron de minuit
public/                     SPA (index.html, css/styles.css, js/app.js, js/api.js)
```
