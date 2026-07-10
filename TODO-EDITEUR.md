# Suivi — Ajouts éditeur vidéo/image

Liste de travail issue de la session en cours. Non versionnée par défaut (fichier local, pas encore ajouté à git).

Chaque tâche indique si elle a été commit + push sur `master`.

## Fait

- [x] Corriger export vidéo trop long/ralenti (bug `exportPlaybackRate`)
  - ✅ Commit + push fait — `4bfd1e7`
- [x] Panneau réglages IA (clé API utilisateur en localStorage)
  - ✅ Commit + push fait — `44d4e24`
- [x] Passage des panneaux en grille responsive (bonus, demandé en cours de route)
  - ✅ Commit + push fait — `c3910e7`
- [x] Projet : sauvegarde/chargement + auto-save + multi-projets + checkpoints nommés + export/import fichier (IndexedDB)
  - ✅ Commit + push fait — `c00c9ca`
- [x] Calques : verrouillage, masquage, renommage, duplication
  - ✅ Commit + push fait — `482e075`
- [x] Groupement de calques (sélection multiple + actions groupées)
  - ✅ Commit + push fait — `0ee92d0`
- [x] Alignement auto + grille/guides + snap magnétique
  - ✅ Commit + push fait — `f5df32e`
- [x] Verrouillage ratio redimensionnement (recadrage)
  - ✅ Commit + push fait — `79a0e64`
- [x] Copier/coller réglages de calque (paste style)
  - ✅ Commit + push fait — `62a1509`

- [x] Crop par glisser sur canvas
  - ✅ Commit + push fait — `f0b9d24`
- [x] Masques de découpe (pentagone, étoile, cœur — cercle/hexagone déjà présents)
  - ✅ Commit + push fait — `8824f8e`
- [x] Ombre portée + glow externe configurables
  - ✅ Commit + push fait — `a1c624d`
- [x] Renommage section "Photos" → "Photos / Vidéos" (demande hors-liste)
  - ✅ Commit + push fait — `eea2b33`
- [x] Texte : animations entrée/sortie étendues + easing (+ corrige le champ orphelin animDuree)
  - ✅ Commit + push fait — `d21bb57`
- [x] Sélection multiple de fichiers (ajouter plusieurs photos/vidéos d'un coup) (demande hors-liste)
  - ✅ Commit + push fait — `4cf2c27` (+ clarification/fix ergonomie — `78cab96`)
- [x] Texte le long d'un chemin courbe
  - ✅ Commit + push fait — `ba28df3`
- [x] Contour + dégradé texte
  - ✅ Commit + push fait — `298787a`
- [x] Interlignage/espacement/alignement texte
  - ✅ Commit + push fait — `1071130`
- [x] Regroupement visuel des médias multi-sélectionnés sur une même carte (fix retour utilisateur intermédiaire — `fcd2305`, remplacé ensuite)
- [x] Google Fonts liste + presets de style texte
  - ✅ Commit + push fait — `bda9053`
- [x] Composite multi-médias simultané sur un même visuel (clarification finale du retour utilisateur, remplace le regroupement séquentiel `fcd2305`)
  - ✅ Commit + push fait — `3c73496`
  - `p.sousMedias[]` : médias superposés affichés EN MÊME TEMPS que le calque principal, réglages indépendants, réutilise mettreAJourPhoto() sur des calques three.js dédiés
- [x] Fix drag canvas manquant pour médias superposés (hors-liste, retour utilisateur) — `b4c3201`
- [x] Nettoyage texte redondant cartes photo/vidéo (hors-liste, retour utilisateur) — `d04158e`
- [x] Formes vectorielles + stickers/icônes
  - ✅ Commit + push fait — `adfa399`
- [x] Outil flèche/annotation + dessin libre
  - ✅ Commit + push fait — `e341f9d` (flèche via formes `adfa399`, pinceau libre + parité fonctionnelle médias superposés dans `e341f9d`)
  - Refactor important au passage : `renderReglagesAvancesPhotoHtml()`/`bindReglagesAvancesPhotoEvents()` partagés entre calque photo principal et médias superposés (retour utilisateur : le 2e média n'avait qu'un panneau allégé)
- [x] Bibliothèque Pixabay (recherche vidéos/images libres de droits pour le fond) — `be14caf`
  - ⚠️ Nécessite une clé API Pixabay utilisateur ; le téléchargement du média via fetch() n'a pas pu être testé en conditions réelles (pas de navigateur dans cette session) — à confirmer côté CORS du CDN Pixabay
- [x] Fix particules inactives sur médias superposés (hors-liste, retour utilisateur) — `64d98bb`
- [x] Cadres décoratifs — `c3975ec`
  - Bordure simple/double, coins, pellicule, polaroid

## En cours / à faire
- [ ] Timeline multi-pistes visuelle + zoom + marqueurs
  - ⏳ Pas encore commit/push
- [ ] Split/trim par glisser + vitesse variable + ripple edit
  - ⏳ Pas encore commit/push
- [ ] Miniatures segments + boucle lecture plage
  - ⏳ Pas encore commit/push
- [ ] Colorimétrie avancée (courbes, balance blancs) + LUT .cube
  - ⏳ Pas encore commit/push
- [ ] Presets filtres one-click
  - ⏳ Pas encore commit/push
- [ ] Glitch/aberration chromatique/VHS/motion blur
  - ⏳ Pas encore commit/push
- [ ] Ken Burns automatique
  - ⏳ Pas encore commit/push
- [ ] Transitions supplémentaires + réactivité audio étendue + screen shake
  - ⏳ Pas encore commit/push
- [ ] Audio : pistes multiples + EQ/normalisation
  - ⏳ Pas encore commit/push
- [ ] Bibliothèque musiques/SFX libres (liens)
  - ⏳ Pas encore commit/push
- [ ] Détection silence auto-cut + auto-ducking + sync beat
  - ⏳ Pas encore commit/push
- [ ] Waveform éditable + effets audio (reverb/pitch/fade courbe)
  - ⏳ Pas encore commit/push
- [ ] IA : suppression fond auto
  - ⏳ Pas encore commit/push
- [ ] IA : sous-titres auto + traduction + TTS voix off
  - ⏳ Pas encore commit/push
- [ ] IA : recadrage intelligent + suggestions montage + retouche photo
  - ⏳ Pas encore commit/push
- [ ] Export : presets réseaux sociaux + résolution/ratio libre
  - ⏳ Pas encore commit/push
- [ ] Export : bitrate/qualité + WebM/MOV + par lots + watermark
  - ⏳ Pas encore commit/push
- [ ] Export : segment précis + estimation taille fichier
  - ⏳ Pas encore commit/push
- [ ] Ergonomie : raccourcis clavier étendus + zoom/pan canvas + plein écran
  - ⏳ Pas encore commit/push
- [ ] Ergonomie : templates montage + presets réglages sauvegardables
  - ⏳ Pas encore commit/push
- [ ] Ergonomie : drag&drop fichier sur canvas + aperçu qualité rapide/final
  - ⏳ Pas encore commit/push
- [ ] Ergonomie : mode sombre/clair UI + annulation groupée visible
  - ⏳ Pas encore commit/push
- [ ] Accessibilité : navigation clavier complète + contrastes WCAG
  - ⏳ Pas encore commit/push
- [ ] Vérification finale : syntaxe, lancement serveur, test navigateur
  - ⏳ Pas encore commit/push

## Phase 2 — après completion de la liste ci-dessus (demande explicite, différée)

- [ ] Utiliser Fable 5 + Claude Design pour s'entraîner à monter des vidéos avec l'éditeur du site.
  - Claude Design doit générer lui-même tous les assets (ou utiliser des captures localisées du sujet, à définir).
  - Enregistrer toutes les données d'entraînement dans la doc API (`public/api-docs.html`).
  - 3 exemples à produire : (1) tuto d'utilisation de l'éditeur, (2) présentation de l'éditeur, (3) vidéo YouTube sur le résultat de cette présentation.
  - ⏳ Non démarré — explicitement à faire seulement une fois toute la liste ci-dessus terminée.

## Notes de conception

- **"Groupement de calques"** : implémenté comme sélection multiple + actions groupées (verrouiller/masquer/dupliquer/supprimer), pas comme groupe à transform partagé — les photos sont des diapositives séquentielles (une seule active à la fois), un groupe au sens classique n'avait pas de sens dans ce modèle.
- **Sauvegarde de projet** : IndexedDB (pas localStorage) pour supporter les Blob volumineux (vidéos/audio) sans limite de taille pratique.
- **Clés API IA** : stockées uniquement côté navigateur (localStorage), jamais envoyées au serveur PlayTesteur — chaque feature IA appellera l'API du fournisseur directement depuis le navigateur.
- Chaque étape terminée est commit + push sur `master` au fur et à mesure (demande explicite).
