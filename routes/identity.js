const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../data/mockDb');

/**
 * ============================================================================
 * ROUTE — Démarrer la vérification d'identité d'un hôte (Stripe Identity)
 * ============================================================================
 * Contrairement aux cuisiniers (déjà vérifiés via Stripe Connect au moment
 * de configurer leurs paiements — voir routes/connect.js), les hôtes n'ont
 * aujourd'hui aucun compte ni aucune vérification. Cette route crée une
 * session Stripe Identity distincte : l'hôte est redirigé vers une page
 * Stripe sécurisée où il prend en photo sa pièce d'identité et un selfie.
 *
 * ⚠️ At'Chef ne reçoit JAMAIS ces documents — uniquement un statut final
 * (vérifié / échec), transmis par le webhook
 * `identity.verification_session.verified` (voir webhooks/stripeWebhook.js).
 * C'est précisément ce qui évite à At'Chef d'avoir à stocker et sécuriser
 * elle-même des pièces d'identité, bien plus lourd à gérer correctement.
 *
 * ⚠️ NOTE TECHNIQUE : l'API Stripe Identity peut évoluer. Vérifiez les
 * paramètres exacts (`options.document`, etc.) dans la documentation
 * Stripe Identity à jour avant un usage en production — ce code n'a pas
 * pu être testé contre de vrais appels Stripe Identity dans cet
 * environnement de développement (accès réseau restreint).
 *
 * POST /api/identity/verify-host
 * Corps : { "email": "hote@example.com" }
 * → 200 { url: "https://verify.stripe.com/..." }
 * Le frontend doit rediriger le navigateur vers cette URL.
 * ============================================================================
 */
router.post('/identity/verify-host', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    // Si cet email a déjà une vérification réussie, pas besoin d'en
    // recréer une : on renvoie directement le statut existant.
    const existing = await db.findHostVerificationByEmail(email);
    if (existing && existing.status === 'verifie') {
      return res.json({ alreadyVerified: true });
    }

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          require_matching_selfie: true, // demande aussi un selfie, pas seulement la pièce d'identité
        },
      },
      metadata: { email },
      return_url: `${process.env.APP_URL}/?identity=complete&email=${encodeURIComponent(email)}`,
    });

    await db.createHostVerification({
      email,
      verificationSessionId: session.id,
      status: 'en_attente',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création vérification identité :', err);
    res.status(500).json({ error: "Impossible de démarrer la vérification d'identité" });
  }
});

/**
 * GET /api/identity/host-status?email=...
 * Vérifie si un hôte (identifié par son email) a déjà une identité
 * vérifiée. Appelé par le frontend avant d'autoriser une réservation, et
 * une seconde fois côté serveur dans routes/checkout.js (ne jamais faire
 * confiance uniquement à une vérification faite dans le navigateur).
 */
router.get('/identity/host-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  const record = await db.findHostVerificationByEmail(email);
  res.json({
    verified: !!(record && record.status === 'verifie'),
    status: record ? record.status : 'non_verifie',
  });
});

module.exports = router;
