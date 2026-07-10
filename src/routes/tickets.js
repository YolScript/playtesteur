const express = require('express');
const db = require('../db/init');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

// ── Prepared statements ─────────────────────────────────────────────────
const insertTicket = db.prepare(
  `INSERT INTO tickets (user_id, categorie, sujet, message) VALUES (?, ?, ?, ?)`
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

// ── Routes utilisateur (authentifié) ────────────────────────────────────
router.use(requireAuth);

// Créer un ticket
router.post('/', (req, res) => {
  const { categorie, sujet, message } = req.body || {};
  if (!categorie || !['Bug', 'Information'].includes(categorie)) {
    return res.status(400).json({ erreur: 'Catégorie invalide (Bug ou Information).' });
  }
  if (!sujet || sujet.trim().length < 3 || sujet.trim().length > 120) {
    return res.status(400).json({ erreur: 'Le sujet doit contenir entre 3 et 120 caractères.' });
  }
  if (!message || message.trim().length < 10 || message.trim().length > 2000) {
    return res.status(400).json({ erreur: 'Le message doit contenir entre 10 et 2000 caractères.' });
  }

  const result = insertTicket.run(req.session.userId, categorie, sujet.trim(), message.trim());
  logActivity(req.session.userId, 'Ticket créé', `[${categorie}] ${sujet.trim()}`);
  res.json({ ticket: findTicketById.get(result.lastInsertRowid) });
});

// Lister mes tickets
router.get('/mine', (req, res) => {
  const tickets = listTicketsUser.all(req.session.userId);
  res.json({ tickets });
});

// ── Routes admin ────────────────────────────────────────────────────────
router.get('/all', requireAdmin, (req, res) => {
  const tickets = listAllTickets.all();
  res.json({ tickets });
});

// Répondre à un ticket (admin)
router.post('/:id/reply', requireAdmin, (req, res) => {
  const { reponse, statut } = req.body || {};
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ erreur: 'Ticket introuvable.' });

  const nouveauStatut = statut && ['Ouvert', 'En_Cours', 'Fermé'].includes(statut)
    ? statut
    : 'En_Cours';

  const reponseText = reponse ? reponse.trim() : ticket.reponse_admin;
  updateTicketAdmin.run(nouveauStatut, reponseText, req.session.userId, ticket.id);
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

  updateTicketStatut.run(statut, ticket.id);
  logActivity(req.session.userId, `Ticket #${ticket.id} statut changé`, statut);

  res.json({ ticket: findTicketById.get(ticket.id) });
});

module.exports = router;
