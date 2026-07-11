// Moteur de scoring / paliers.
//
// Barème : 12 mails max, décroissance d'environ 100/12 ≈ 8,33 points par
// palier (règle donnée dans les specs). THRESHOLDS[n] = score minimum pour
// CONSERVER n mails actifs. Formule : floor((n-1) * 100/12) + 1.
const MAX_SCORE = 100;
const MAX_MAILS = 12;
const POINTS_PER_DAILY_TEST = MAX_SCORE / (MAX_MAILS - 1); // ≈ 8.3333
const MIDNIGHT_PENALTY = 5;

const THRESHOLDS = [0];
for (let n = 1; n <= MAX_MAILS; n++) {
  THRESHOLDS.push(Math.floor((n - 1) * (MAX_SCORE / MAX_MAILS)) + 1);
}
// THRESHOLDS = [0, 1, 9, 17, 26, 34, 42, 51, 59, 67, 76, 84, 92]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Nombre maximum de mails qu'un score donné autorise à conserver.
function palierMaxMails(score) {
  let max = 0;
  for (let n = MAX_MAILS; n >= 0; n--) {
    if (score >= THRESHOLDS[n]) {
      max = n;
      break;
    }
  }
  return max;
}

// Score minimum requis pour un nombre de mails donné (utile pour l'UI).
function scoreMinPour(mails) {
  return THRESHOLDS[clamp(mails, 0, MAX_MAILS)];
}

function isSameCalendarDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

// Applique le gain d'un test quotidien validé (installation + avis détecté).
// Retourne le nouvel état { score_global, mails_debloques, mailGagne }.
// score_global n'est PLUS plafonné à MAX_SCORE une fois ce seuil dépassé :
// les 12 mails sont déjà acquis à ce stade (palierMaxMails plafonne à
// MAX_MAILS de toute façon), le score continue de grimper sans limite pour
// le classement et pour financer les dépenses de points (éditeur, boutique).
function applyDailyTestGain(user, nowIso) {
  const dejaFaitAujourdhui = isSameCalendarDay(user.derniere_date_test, nowIso);
  if (dejaFaitAujourdhui) {
    return {
      score_global: user.score_global,
      mails_debloques: user.mails_debloques,
      mailGagne: false,
    };
  }
  const score_global = Math.max(0, Math.round(user.score_global + POINTS_PER_DAILY_TEST));
  const mails_debloques = clamp(user.mails_debloques + 1, 0, MAX_MAILS);
  return { score_global, mails_debloques, mailGagne: true };
}

module.exports = {
  MAX_SCORE,
  MAX_MAILS,
  POINTS_PER_DAILY_TEST,
  MIDNIGHT_PENALTY,
  THRESHOLDS,
  palierMaxMails,
  scoreMinPour,
  isSameCalendarDay,
  applyDailyTestGain,
};
