const express = require('express');
const router = express.Router();
const db = require('../data/mockDb');
const { requireAuth } = require('./auth');

/**
 * ============================================================================
 * MESSAGERIE — conversations entre hôtes et cuisiniers
 * ============================================================================
 * Une conversation est liée à une paire (hôte, cuisinier), pas à une
 * réservation précise : un hôte peut vouloir poser une question avant
 * même de réserver. Si une conversation existe déjà entre cette paire,
 * elle est réutilisée plutôt que d'en créer une nouvelle à chaque fois.
 * ============================================================================
 */

/**
 * POST /api/conversations
 * Réservé aux HÔTES connectés : démarre (ou récupère) une conversation
 * avec un cuisinier donné.
 * Corps : { cookId }
 */
router.post('/conversations', requireAuth, async (req, res) => {
  if (req.user.role !== 'host') {
    return res.status(403).json({ error: 'Réservé aux hôtes' });
  }
  const { cookId } = req.body;
  if (!cookId) return res.status(400).json({ error: 'cookId requis' });

  const cook = await db.findCookById(cookId);
  if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });

  let conversation = await db.findConversationByPair(req.user.email, cookId);
  if (!conversation) {
    conversation = await db.createConversation({
      hostEmail: req.user.email,
      cookId,
      hostName: req.user.name,
      cookName: cook.name,
    });
  }
  res.json(conversation);
});

/**
 * GET /api/conversations
 * Liste des conversations de l'utilisateur connecté (hôte ou cuisinier),
 * les plus récemment actives en premier.
 */
router.get('/conversations', requireAuth, async (req, res) => {
  const conversations = req.user.role === 'cook'
    ? await db.getConversationsForCook(req.user.id)
    : await db.getConversationsForHost(req.user.email);
  res.json(conversations);
});

/**
 * GET /api/conversations/:id
 * Détail d'une conversation (avec tous ses messages), à condition d'en
 * être l'un des deux participants.
 */
router.get('/conversations/:id', requireAuth, async (req, res) => {
  const conversation = await db.findConversationById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation introuvable' });

  const isParticipant = req.user.role === 'cook'
    ? conversation.cookId === req.user.id
    : conversation.hostEmail === req.user.email;
  if (!isParticipant) return res.status(403).json({ error: "Vous ne faites pas partie de cette conversation" });

  res.json(conversation);
});

/**
 * POST /api/conversations/:id/messages
 * Ajoute un message à la conversation, à condition d'en être participant.
 * Corps : { text }
 */
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Message vide' });
  }

  const conversation = await db.findConversationById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation introuvable' });

  const isParticipant = req.user.role === 'cook'
    ? conversation.cookId === req.user.id
    : conversation.hostEmail === req.user.email;
  if (!isParticipant) return res.status(403).json({ error: "Vous ne faites pas partie de cette conversation" });

  const updated = await db.addMessageToConversation(
    req.params.id,
    req.user.role, // 'host' ou 'cook'
    String(text).trim().slice(0, 2000)
  );
  res.json(updated);
});

module.exports = router;
