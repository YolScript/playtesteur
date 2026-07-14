const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

// Allowlist stricte : l'extension du fichier écrit sur disque ne doit
// jamais dépendre directement du mimetype fourni par le client (sinon un
// data:text/html;base64,... ou data:image/svg+xml;base64,... écrirait un
// .html/.svg exécutable, servi tel quel par express.static -> XSS stockée).
const MIME_VERS_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

// Helper to save base64 image
function saveBase64Image(base64Str) {
  if (!base64Str) return null;
  const matches = base64Str.match(/^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Format d'image invalide. Seuls PNG, JPG, JPEG et WEBP sont acceptés.");
  }
  const ext = MIME_VERS_EXTENSION[matches[1].toLowerCase()];
  if (!ext) {
    throw new Error("Format d'image invalide. Seuls PNG, JPG, JPEG et WEBP sont acceptés.");
  }
  const buffer = Buffer.from(matches[2], 'base64');
  
  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error("L'image dépasse la taille maximale autorisée de 5 Mo.");
  }

  const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'tickets');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, buffer);
  
  return `/uploads/tickets/${fileName}`;
}

// ── Prepared statements ─────────────────────────────────────────────────
const insertTicket = db.prepare(
  `INSERT INTO tickets (user_id, categorie, sujet, message, image_url) VALUES (?, ?, ?, ?, ?)`
);
const findTicketById = db.prepare('SELECT * FROM tickets WHERE id = ?');
const listTicketsUser = db.prepare(
  `SELECT t.*, u.pseudo AS admin_pseudo
   FROM tickets t
   LEFT JOIN users u ON u.id = t.admin_id
   WHERE t.user_id = ?
   ORDER BY t.created_at DESC`
);
const listAllTickets = db.prepare(
  `SELECT t.*, u.pseudo AS user_pseudo, u.email AS user_email,
          a.pseudo AS admin_pseudo
   FROM tickets t
   JOIN users u ON u.id = t.user_id
   LEFT JOIN users a ON a.id = t.admin_id
   ORDER BY
     CASE t.statut WHEN 'Ouvert' THEN 0 WHEN 'En_Cours' THEN 1 ELSE 2 END,
     t.created_at DESC`
);
const updateTicketAdmin = db.prepare(
  `UPDATE tickets SET statut = ?, reponse_admin = ?, admin_id = ?, updated_at = datetime('now') WHERE id = ?`
);
const updateTicketStatut = db.prepare(
  `UPDATE tickets SET statut = ?, updated_at = datetime('now') WHERE id = ?`
);
const insertTicketMessage = db.prepare(
  `INSERT INTO ticket_messages (ticket_id, sender_id, message, image_url) VALUES (?, ?, ?, ?)`
);
// Un ticket fermé est supprimé plutôt que conservé (ses messages suivent
// via ON DELETE CASCADE sur ticket_messages.ticket_id).
const deleteTicket = db.prepare('DELETE FROM tickets WHERE id = ?');

// ── Routes utilisateur (authentifié) ────────────────────────────────────
router.use(requireAuth);

// Créer un ticket
router.post('/', (req, res) => {
  const { categorie, sujet, message, image_data } = req.body || {};
  if (!categorie || !['Bug', 'Information'].includes(categorie)) {
    return res.status(400).json({ erreur: 'Catégorie invalide (Bug ou Information).' });
  }
  if (!sujet || sujet.trim().length < 3 || sujet.trim().length > 120) {
    return res.status(400).json({ erreur: 'Le sujet doit contenir entre 3 et 120 caractères.' });
  }
  if (!message || message.trim().length < 10 || message.trim().length > 2000) {
    return res.status(400).json({ erreur: 'Le message doit contenir entre 10 et 2000 caractères.' });
  }

  try {
    const imageUrl = saveBase64Image(image_data);
    const result = insertTicket.run(
      req.session.userId, 
      categorie, 
      sujet.trim(), 
      message.trim(), 
      imageUrl
    );
    logActivity(req.session.userId, 'Ticket créé', `[${categorie}] ${sujet.trim()}`);
    res.json({ ticket: findTicketById.get(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ erreur: err.message });
  }
});

// Lister mes tickets
router.get('/mine', (req, res) => {
  const tickets = listTicketsUser.all(req.session.userId);
  res.json({ tickets });
});

// Récupérer le fil de discussion d'un ticket
router.get('/:id/messages', (req, res) => {
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ erreur: 'Ticket introuvable.' });

  const isAdmin = req.session.role === 'administrator';
  if (!isAdmin && ticket.user_id !== req.session.userId) {
    return res.status(403).json({ erreur: 'Accès non autorisé à ce ticket.' });
  }

  // Récupérer tous les messages enfants
  const replies = db.prepare(
    `SELECT tm.*, u.pseudo AS sender_pseudo, u.role AS sender_role
     FROM ticket_messages tm
     JOIN users u ON u.id = tm.sender_id
     WHERE tm.ticket_id = ?
     ORDER BY tm.created_at ASC`
  ).all(ticket.id);

  res.json({ ticket, replies });
});

// Répondre à un ticket (user ou admin)
router.post('/:id/messages', (req, res) => {
  const { message, image_data } = req.body || {};
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ erreur: 'Ticket introuvable.' });

  const isAdmin = req.session.role === 'administrator';
  if (!isAdmin && ticket.user_id !== req.session.userId) {
    return res.status(403).json({ erreur: 'Accès non autorisé à ce ticket.' });
  }

  if (!message || message.trim().length < 2 || message.trim().length > 2000) {
    return res.status(400).json({ erreur: 'Le message de réponse doit contenir entre 2 et 2000 caractères.' });
  }

  try {
    const imageUrl = saveBase64Image(image_data);
    insertTicketMessage.run(ticket.id, req.session.userId, message.trim(), imageUrl);

    // Mettre à jour le statut du ticket et la date de mise à jour
    // Si l'utilisateur répond, le statut repasse en 'Ouvert' pour que l'admin le traite.
    // Si l'admin répond, on le met en 'En_Cours' (ou on le laisse).
    const nouveauStatut = isAdmin ? 'En_Cours' : 'Ouvert';
    db.prepare(`UPDATE tickets SET statut = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nouveauStatut, ticket.id);

    logActivity(req.session.userId, `Réponse ticket #${ticket.id}`, message.trim().substring(0, 60));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erreur: err.message });
  }
});

// ── Routes admin ────────────────────────────────────────────────────────
router.get('/all', requireAdmin, (req, res) => {
  const tickets = listAllTickets.all();
  res.json({ tickets });
});

// Répondre à un ticket (admin) - Rétro-compatible avec le panel admin de base
router.post('/:id/reply', requireAdmin, (req, res) => {
  const { reponse, statut } = req.body || {};
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ erreur: 'Ticket introuvable.' });

  const nouveauStatut = statut && ['Ouvert', 'En_Cours', 'Fermé'].includes(statut)
    ? statut
    : 'En_Cours';

  const reponseText = reponse ? reponse.trim() : '';

  if (reponseText) {
    // Insérer dans ticket_messages pour que l'historique de discussion reste propre
    insertTicketMessage.run(ticket.id, req.session.userId, reponseText, null);
  }

  // Un ticket fermé est définitivement supprimé (avec son fil de discussion)
  // plutôt que conservé indéfiniment en base.
  if (nouveauStatut === 'Fermé') {
    deleteTicket.run(ticket.id);
    logActivity(req.session.userId, `Ticket #${ticket.id} fermé et supprimé`, ticket.sujet);
    return res.json({ deleted: true, id: ticket.id });
  }

  updateTicketAdmin.run(nouveauStatut, reponseText || ticket.reponse_admin, req.session.userId, ticket.id);
  logActivity(req.session.userId, `Ticket #${ticket.id} répondu`, `Statut: ${nouveauStatut}`);

  res.json({ ticket: findTicketById.get(ticket.id) });
});

// Changer le statut d'un ticket (admin)
router.post('/:id/status', requireAdmin, (req, res) => {
  const { statut } = req.body || {};
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ erreur: 'Ticket introuvable.' });
  if (!statut || !['Ouvert', 'En_Cours', 'Fermé'].includes(statut)) {
    return res.status(400).json({ erreur: 'Statut invalide.' });
  }

  if (statut === 'Fermé') {
    deleteTicket.run(ticket.id);
    logActivity(req.session.userId, `Ticket #${ticket.id} fermé et supprimé`, ticket.sujet);
    return res.json({ deleted: true, id: ticket.id });
  }

  updateTicketStatut.run(statut, ticket.id);
  logActivity(req.session.userId, `Ticket #${ticket.id} statut changé`, statut);

  res.json({ ticket: findTicketById.get(ticket.id) });
});

module.exports = router;
