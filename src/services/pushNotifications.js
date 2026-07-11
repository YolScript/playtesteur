// Notifications push (Web Push standard, sans service tiers). Nécessite un
// contexte sécurisé (HTTPS, ou localhost) côté navigateur pour fonctionner :
// sur un déploiement en http:// simple, les navigateurs refusent l'abonnement.
const webpush = require('web-push');
const db = require('../db/init');

const lireVapid = db.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1');
const insererVapid = db.prepare('INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)');

function initialiserVapid() {
  let cles = lireVapid.get();
  if (!cles) {
    const generees = webpush.generateVAPIDKeys();
    insererVapid.run(generees.publicKey, generees.privateKey);
    cles = { public_key: generees.publicKey, private_key: generees.privateKey };
    console.log('[push] Clés VAPID générées et enregistrées.');
  }
  webpush.setVapidDetails('mailto:contact@playtesteur.invalid', cles.public_key, cles.private_key);
  return cles.public_key;
}

const publicKey = initialiserVapid();

const insererAbonnement = db.prepare(`
  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
`);
const supprimerAbonnement = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
const abonnementsTous = db.prepare('SELECT * FROM push_subscriptions');
const abonnementsAdmins = db.prepare(`
  SELECT ps.* FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.role = 'administrator'
`);

function sAbonner(userId, subscription) {
  insererAbonnement.run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
}

function seDesabonner(endpoint) {
  supprimerAbonnement.run(endpoint);
}

async function envoyer(subscriptions, payload) {
  const data = JSON.stringify(payload);
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        data
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Abonnement expiré/révoqué côté navigateur : on nettoie.
        supprimerAbonnement.run(sub.endpoint);
      } else {
        console.error('[push] échec envoi', err.message);
      }
    }
  }
}

// Visible par tous les abonnés (testeurs) : une nouvelle app à tester.
async function notifierNouvelleApplication(nomApplication) {
  await envoyer(abonnementsTous.all(), {
    title: '📱 Nouvelle application à tester',
    body: `"${nomApplication}" vient d'être ajoutée au catalogue.`,
    url: '/#/catalogue',
  });
}

// Visible uniquement par les administrateurs abonnés : un nouveau compte.
async function notifierNouvelUtilisateur(pseudo) {
  await envoyer(abonnementsAdmins.all(), {
    title: '👤 Nouvel utilisateur',
    body: `${pseudo} vient de créer son compte.`,
    url: '/#/admin',
  });
}

module.exports = {
  publicKey,
  sAbonner,
  seDesabonner,
  notifierNouvelleApplication,
  notifierNouvelUtilisateur,
};
