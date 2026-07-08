// Résout les credentials d'un compte de service Google soit depuis un
// fichier JSON local (développement), soit depuis le JSON brut collé dans
// une variable d'environnement (déploiement cloud, où il n'y a pas de
// fichier sur le disque — Railway, Render, Fly.io...).
const fs = require('fs');
const path = require('path');

function resoudreCredentials(pathEnvVar, jsonEnvVar) {
  const jsonInline = process.env[jsonEnvVar];
  if (jsonInline) {
    try {
      return JSON.parse(jsonInline);
    } catch (err) {
      throw new Error(`${jsonEnvVar} contient un JSON invalide : ${err.message}`);
    }
  }

  const keyPath = process.env[pathEnvVar];
  if (keyPath && fs.existsSync(path.resolve(keyPath))) {
    return JSON.parse(fs.readFileSync(path.resolve(keyPath), 'utf8'));
  }

  return null;
}

module.exports = { resoudreCredentials };
