const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../data/mockDb');

// ⚠️ En production, changez impérativement ADMIN_JWT_SECRET (variable
// d'environnement sur Render) pour une valeur longue et aléatoire. La
// valeur ci-dessous n'est qu'un filet de sécurité pour le développement
// local, jamais à utiliser telle quelle en ligne.
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'dev-secret-a-changer-absolument';
const TOKEN_EXPIRY = '8h';

/**
 * ============================================================================
 * Middleware requireAdmin
 * ============================================================================
 * Protège toutes les routes admin ci-dessous. Vérifie un jeton JWT valide
 * dans l'en-tête HTTP `Authorization: Bearer <token>`. Contrairement au
 * formulaire "Devenir Cuisinier" (volontairement sans mot de passe pour
 * aller vite), l'accès aux réservations et aux comptes des utilisateurs
 * DOIT être protégé sérieusement : c'est ce que fait ce middleware.
 * ============================================================================
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session invalide ou expirée, merci de vous reconnecter' });
  }
}

/**
 * ============================================================================
 * POST /api/admin/login
 * ============================================================================
 * Les identifiants admin sont stockés dans les variables d'environnement
 * ADMIN_EMAIL / ADMIN_PASSWORD sur Render — jamais dans le code, jamais
 * sur GitHub. Pour changer le mot de passe : modifiez la variable sur
 * Render, aucun redéploiement de code n'est nécessaire.
 *
 * → 200 { token: "..." } à conserver côté frontend et à renvoyer dans
 * l'en-tête Authorization de chaque appel aux routes /api/admin/*.
 * ============================================================================
 */
router.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const validEmail = process.env.ADMIN_EMAIL;
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validEmail || !validPassword) {
    return res.status(500).json({ error: "Compte administrateur non configuré (variables d'environnement manquantes sur Render)" });
  }
  if (!email || !password || email !== validEmail || password !== validPassword) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }

  const token = jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token });
});

/** GET /api/admin/bookings — toutes les réservations, pour le suivi SAV. */
router.get('/admin/bookings', requireAdmin, async (req, res) => {
  const bookings = await db.getAllBookings();
  res.json(bookings);
});

/**
 * GET /api/admin/cooks — tous les cuisiniers, AVEC les champs privés
 * (email, identifiant Stripe). Contrairement à GET /api/cooks (public,
 * qui masque ces champs), cette route est réservée à l'administration.
 */
router.get('/admin/cooks', requireAdmin, async (req, res) => {
  const cooks = await db.getAllCooks();
  res.json(cooks);
});

/** GET /api/admin/tickets — tous les tickets de support, plus récents en premier. */
router.get('/admin/tickets', requireAdmin, async (req, res) => {
  const tickets = await db.getAllTickets();
  res.json(tickets);
});

/**
 * PATCH /api/admin/tickets/:id — met à jour le statut et/ou la note interne
 * d'un ticket (ex. après avoir rappelé la personne suite à un appel).
 */
router.patch('/admin/tickets/:id', requireAdmin, async (req, res) => {
  const { status, adminNote } = req.body;
  const patch = {};
  if (status) patch.status = status;
  if (adminNote !== undefined) patch.adminNote = adminNote;

  const ticket = await db.updateTicket(req.params.id, patch);
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
  res.json(ticket);
});

/**
 * ============================================================================
 * POST /api/tickets — PUBLIC (pas de requireAdmin)
 * ============================================================================
 * Permet à un hôte ou un cuisinier de signaler un problème depuis le site
 * (formulaire de contact), ou à l'administrateur de "logger" manuellement
 * un appel téléphonique reçu, en remplissage direct si besoin plus tard
 * depuis le tableau de bord.
 * ============================================================================
 */
router.post('/tickets', async (req, res) => {
  const { name, email, role, subject, message } = req.body;
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs obligatoires' });
  }
  const ticket = await db.createTicket({
    name: String(name).trim(),
    email: String(email).trim(),
    role: role || 'non précisé',
    subject: String(subject).trim(),
    message: String(message).trim(),
  });
  res.json({ ticketId: ticket.id });
});

module.exports = router;
