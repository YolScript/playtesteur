// Système de titres basé sur le score (score_global, non plafonné — voir
// scoring.js). 10 rangs thématiques x 10 sous-niveaux (I à X) = 100 titres
// distincts, plus 3 titres uniques pour le podium du classement et 1 titre
// pour les administrateurs. Chaque rang a son propre palier visuel
// (tier CSS), de plus en plus épique.
const RANGS = [
  { nom: 'Novice', seuil: 0, tier: 1 },
  { nom: 'Apprenti', seuil: 100, tier: 2 },
  { nom: 'Testeur', seuil: 250, tier: 3 },
  { nom: 'Testeur Confirmé', seuil: 500, tier: 4 },
  { nom: 'Expert', seuil: 1000, tier: 5 },
  { nom: 'Vétéran', seuil: 2000, tier: 6 },
  { nom: 'Maître', seuil: 4000, tier: 7 },
  { nom: 'Champion', seuil: 8000, tier: 8 },
  { nom: 'Légende', seuil: 16000, tier: 9 },
  { nom: 'Mythique', seuil: 32000, tier: 10 },
];
const SOUS_NIVEAUX = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const TITRES_PODIUM = {
  1: { nom: '👑 Empereur du Test', tier: 'top1' },
  2: { nom: '🥈 Grand Maître Testeur', tier: 'top2' },
  3: { nom: '🥉 Chevalier d\'Élite', tier: 'top3' },
};
const TITRE_ADMIN = { nom: '⚡ Administrateur', tier: 'admin' };

// Titre dérivé uniquement du score (rang + sous-niveau I-X).
function titreParScore(score) {
  let rangIndex = 0;
  for (let i = 0; i < RANGS.length; i++) {
    if (score >= RANGS[i].seuil) rangIndex = i;
    else break;
  }
  const rang = RANGS[rangIndex];
  const rangSuivant = RANGS[rangIndex + 1];
  // Dernier rang (Mythique) : pas de palier suivant, on prolonge une
  // largeur de sous-niveau arbitraire (x4 l'écart précédent) pour que le
  // sous-niveau continue de progresser un moment avant de plafonner à X.
  const largeur = rangSuivant ? rangSuivant.seuil - rang.seuil : (rang.seuil - RANGS[rangIndex - 1].seuil) * 4;
  const sousNiveauIndex = Math.min(9, Math.max(0, Math.floor((score - rang.seuil) / (largeur / 10))));
  return {
    nom: `${rang.nom} ${SOUS_NIVEAUX[sousNiveauIndex]}`,
    tier: rang.tier,
  };
}

// Titre final d'un utilisateur : administrateur > podium (1-3 du
// classement) > titre de score. rangClassement est optionnel (seulement
// pertinent dans le contexte du classement).
function calculerTitre({ score, role, rangClassement }) {
  if (role === 'administrator') return TITRE_ADMIN;
  if (rangClassement && TITRES_PODIUM[rangClassement]) return TITRES_PODIUM[rangClassement];
  return titreParScore(score || 0);
}

module.exports = { calculerTitre, titreParScore, RANGS, SOUS_NIVEAUX, TITRES_PODIUM, TITRE_ADMIN };
