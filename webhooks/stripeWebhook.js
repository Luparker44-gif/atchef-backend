const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../data/mockDb');
const { sendBookingConfirmationToHost, sendBookingConfirmationToCook } = require('../services/email');

/**
 * ============================================================================
 * ROUTE 3 (bonus indispensable) — Webhook Stripe
 * ============================================================================
 * Le `success_url` du Checkout (voir routes/checkout.js) ne suffit JAMAIS,
 * à lui seul, à confirmer qu'un paiement a réussi : l'hôte peut fermer son
 * navigateur, perdre sa connexion, etc. juste après avoir payé, avant même
 * d'atteindre cette page. Le webhook est le SEUL canal fiable : c'est
 * Stripe qui appelle directement VOTRE serveur, de serveur à serveur,
 * dès que l'événement se produit réellement.
 *
 * ⚠️ IMPORTANT — cette route a besoin du corps de requête BRUT (un Buffer,
 * pas un objet JSON déjà parsé) pour pouvoir vérifier la signature
 * cryptographique de Stripe. Voir server.js : ce routeur est monté AVANT
 * le middleware express.json() global, avec son propre express.raw().
 *
 * Pour tester en local, utilisez le Stripe CLI (voir README.md) :
 *   stripe listen --forward-to localhost:4242/api/stripe/webhook
 *
 * POST /api/stripe/webhook
 * ============================================================================
 */
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Signature invalide = soit quelqu'un essaie de nous envoyer un faux
    // événement, soit STRIPE_WEBHOOK_SECRET est mal configurée.
    console.error('⚠️ Signature de webhook invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // Le paiement a réussi : c'est LE moment où la réservation devient réelle.
      const session = event.data.object;
      const bookingId = session.metadata.bookingId; // posé lors de la création de la session
      const booking = await db.updateBooking(bookingId, {
        status: 'confirmed',
        stripePaymentIntentId: session.payment_intent,
      });
      console.log(`✅ Réservation #${bookingId} confirmée et payée.`);

      // Notification par email — n'empêche jamais la confirmation de la
      // réservation elle-même si l'envoi échoue (voir services/email.js).
      if (booking) {
        const cook = await db.findCookById(booking.cookId);
        if (cook) {
          await sendBookingConfirmationToHost(booking, cook);
          await sendBookingConfirmationToCook(booking, cook);
        }
      }
      break;
    }

    case 'account.updated': {
      // Se déclenche par ex. quand un cuisinier termine son onboarding
      // Stripe, ou si Stripe a besoin d'informations complémentaires
      // (pièce d'identité, justificatif...). Permet de garder votre
      // propre base synchronisée avec le vrai statut du compte Connect.
      const account = event.data.object;
      const cook = await db.findCookByStripeAccountId(account.id);
      if (cook) {
        // Le statut de vérification d'identité du représentant du compte
        // est déjà géré par Stripe Connect (pièce d'identité demandée
        // pendant l'onboarding) : on récupère juste ce statut, pas besoin
        // d'une vérification Stripe Identity séparée pour les cuisiniers.
        const identityVerified = !!(account.individual
          && account.individual.verification
          && account.individual.verification.status === 'verified');
        await db.updateCook(cook.id, {
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          identityVerified,
        });
      }
      break;
    }

    case 'identity.verification_session.verified': {
      // Un hôte vient de terminer sa vérification Stripe Identity avec succès.
      const session = event.data.object;
      await db.updateHostVerificationBySessionId(session.id, { status: 'verifie' });
      console.log(`✅ Identité vérifiée pour la session ${session.id}`);
      break;
    }

    case 'identity.verification_session.requires_input': {
      // La vérification a échoué ou nécessite une nouvelle tentative
      // (document illisible, selfie ne correspondant pas, etc.).
      const session = event.data.object;
      await db.updateHostVerificationBySessionId(session.id, { status: 'echec' });
      console.warn(`⚠️ Vérification d'identité à refaire pour la session ${session.id}`);
      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      console.warn(`❌ Paiement échoué pour le PaymentIntent ${intent.id}`);
      break;
    }

    default:
      // Types d'événements non traités ici : aucune action nécessaire,
      // mais le log aide à repérer si vous devez en gérer d'autres plus tard.
      console.log(`Événement Stripe reçu (non traité) : ${event.type}`);
  }

  // Toujours répondre 2xx rapidement : Stripe considère un webhook "en
  // échec" s'il ne reçoit pas de réponse sous quelques secondes, et le
  // retentera automatiquement (avec des risques de traitement en double
  // si votre logique n'est pas idempotente).
  res.json({ received: true });
});

module.exports = router;
