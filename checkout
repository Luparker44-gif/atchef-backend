const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../data/mockDb');

// At'Chef prélève 10 % de commission sur chaque réservation.
// Centralisé ici pour ne jamais désynchroniser la logique de calcul.
const PLATFORM_FEE_PERCENT = 0.10;

/**
 * ============================================================================
 * ROUTE 2 — Création d'une session Stripe Checkout (paiement + split 90/10)
 * ============================================================================
 * Appelée quand l'hôte clique sur "Réserver" dans le module de réservation
 * du frontend (page de profil cuisinier). Le câblage exact avec ce bouton
 * est détaillé tout en bas de ce fichier.
 *
 * Corps de requête JSON attendu :
 * {
 *   "cookId": 1,                 // currentProfileChef.id
 *   "formulaIndex": 0,           // selectedFormulaIndex (ignoré si bookingType = "cooking_only")
 *   "guestCount": 4,             // profileGuestCount
 *   "allergies": "Aucune",       // valeur du champ obligatoire
 *   "eventDate": "2026-08-20",   // obligatoire (choisi dans le calendrier)
 *   "bookingType": "formula",    // "formula" (défaut) ou "cooking_only"
 *   "fridgeContents": "...",     // optionnel, texte libre si cooking_only
 *   "equipment": ["Four", ...]   // optionnel, équipement coché par l'hôte
 * }
 *
 * ⚠️ SÉCURITÉ — POINT CRUCIAL :
 * On ne reçoit ici QUE des références (id du cuisinier, index de formule,
 * nombre de convives, type de réservation) — JAMAIS un montant en euros.
 * Le prix est intégralement recalculé plus bas à partir de données que
 * NOUS contrôlons (formules + tarifs dégressifs stockés en base), en
 * reproduisant exactement la même logique que le calculateur du
 * frontend — y compris pour l'option "ingrédients du client", dont le
 * prix réduit est recalculé ici, jamais reçu tel quel. Ainsi, même si
 * quelqu'un modifiait le JavaScript de la page ou rejouait la requête
 * avec un montant trafiqué, il ne pourrait jamais payer moins que le
 * vrai prix : le serveur ne fait jamais confiance à un prix envoyé par
 * le client.
 *
 * POST /api/checkout/create-session
 * → 200 { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_..." }
 * ============================================================================
 */
// Même ratio que côté frontend (voir la constante COOKING_ONLY_RATIO dans
// l'Artifact) : le cuisinier ne facture plus que sa prestation quand
// l'hôte fournit ses propres ingrédients. Dupliqué ici volontairement car
// c'est LE calcul qui fait foi pour le paiement — le frontend n'est qu'un
// aperçu, ce fichier est la source de vérité.
const COOKING_ONLY_RATIO = 0.6;

router.post('/checkout/create-session', async (req, res) => {
  try {
    const { cookId, formulaIndex, guestCount, allergies, eventDate, bookingType, fridgeContents, equipment } = req.body;

    // --- Validations de base ---
    if (!cookId || guestCount === undefined) {
      return res.status(400).json({ error: 'Requête invalide : cookId et guestCount sont requis' });
    }
    if (!allergies || !String(allergies).trim()) {
      // Le champ est déjà obligatoire côté frontend ; on revérifie côté
      // serveur par principe (ne jamais faire confiance uniquement au JS client).
      return res.status(400).json({ error: 'Le champ allergies et restrictions alimentaires est obligatoire' });
    }
    if (!eventDate) {
      return res.status(400).json({ error: 'Merci de choisir une date' });
    }
    const guests = parseInt(guestCount, 10);
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) {
      return res.status(400).json({ error: 'Nombre de convives invalide' });
    }
    const type = (bookingType === 'cooking_only') ? 'cooking_only' : 'formula';

    const cook = await db.findCookById(cookId);
    if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });

    // --- Détermination de la formule facturée selon le type de réservation ---
    let formula;
    if (type === 'cooking_only') {
      // Pas de formule précise : l'hôte fournit ses propres ingrédients,
      // seule la prestation du cuisinier est facturée, à prix réduit.
      const cheapest = Math.min(...cook.formulas.map(f => f.price));
      formula = { id: 'cooking-only', name: 'Le chef cuisine avec vos ingrédients', price: Math.round(cheapest * COOKING_ONLY_RATIO) };
    } else {
      formula = cook.formulas[formulaIndex];
      if (!formula) return res.status(400).json({ error: 'Formule invalide' });
    }

    // Un cuisinier sans compte Stripe (ou dont l'onboarding est incomplet)
    // ne peut recevoir aucun transfert : on bloque la réservation ICI,
    // plutôt que de laisser Stripe échouer le transfert après le paiement.
    if (!cook.stripeAccountId) {
      return res.status(400).json({ error: "Ce cuisinier n'a pas encore configuré ses paiements" });
    }
    const account = await stripe.accounts.retrieve(cook.stripeAccountId);
    if (!account.charges_enabled || !account.payouts_enabled) {
      return res.status(400).json({ error: "Le compte de paiement de ce cuisinier n'est pas encore actif" });
    }

    // --- Recalcul du prix côté serveur (reproduit la logique du frontend) ---
    let discountPercent = 0;
    (cook.discountTiers || []).forEach((tier) => {
      if (guests >= tier.minGuests && tier.discountPercent > discountPercent) {
        discountPercent = tier.discountPercent;
      }
    });
    const perPersonPrice = formula.price * (1 - discountPercent / 100);

    // Stripe manipule les montants dans la plus petite unité monétaire
    // (les centimes, pour l'EUR). On arrondit pour obtenir un entier :
    // Stripe rejette tout montant non entier.
    const totalAmountInCents = Math.round(perPersonPrice * guests * 100);

    // --- Calcul de la commission At'Chef (10 %) ---
    // Toujours arrondir à partir du montant EN CENTIMES (jamais depuis des
    // euros flottants), pour que commission + part du cuisinier
    // correspondent exactement au total, sans écart d'arrondi.
    const applicationFeeAmount = Math.round(totalAmountInCents * PLATFORM_FEE_PERCENT);

    // --- Création de la réservation en base, statut "en attente de paiement" ---
    const booking = await db.createBooking({
      cookId: cook.id,
      formulaId: formula.id,
      bookingType: type,
      fridgeContents: type === 'cooking_only' ? String(fridgeContents || '').trim() : null,
      equipment: Array.isArray(equipment) ? equipment : [],
      formulaName: formula.name,
      guestCount: guests,
      allergies: String(allergies).trim(),
      eventDate: eventDate || null,
      totalAmountInCents,
      applicationFeeAmount,
    });

    // --- Création de la session Stripe Checkout ---
    // Modèle utilisé : la "destination charge". Concrètement, au moment
    // où l'hôte paie :
    //   1. Stripe encaisse le montant TOTAL sur le compte PLATEFORME (At'Chef).
    //   2. `application_fee_amount` reste sur notre compte : c'est notre commission.
    //   3. Le RESTE (total − commission, donc 90 %) est transféré
    //      AUTOMATIQUEMENT et IMMÉDIATEMENT vers le compte Connect du
    //      cuisinier, via `payment_intent_data.transfer_data.destination`.
    // → Aucun virement manuel à faire de notre côté : Stripe orchestre
    //   tout au moment même du paiement.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `${formula.name} — ${cook.name}`,
              description: `${guests} convive(s)` + (eventDate ? ` · ${eventDate}` : ''),
            },
            unit_amount: totalAmountInCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount, // ← notre commission de 10 %
        transfer_data: {
          destination: cook.stripeAccountId, // ← les 90 % restants partent automatiquement ici
        },
        // Dupliquée ici pour être visible directement sur le PaymentIntent
        // (pratique pour les remboursements ou le support client dans le Dashboard Stripe).
        metadata: {
          bookingId: String(booking.id),
          cookId: String(cook.id),
        },
      },
      // C'est CETTE metadata (au niveau de la Session) que vous lirez dans
      // le webhook `checkout.session.completed` — voir webhooks/stripeWebhook.js.
      metadata: {
        bookingId: String(booking.id),
      },
      // ⚠️ Le frontend est aujourd'hui une seule page (l'Artifact), sans sous-pages.
      // On revient donc sur CETTE MÊME page avec un simple paramètre `?payment=...`,
      // que le script du frontend lit au chargement pour afficher un message.
      // Le jour où vous aurez de vraies pages de confirmation/annulation, remplacez
      // ces deux lignes par leurs URLs respectives.
      success_url: `${process.env.APP_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/?payment=cancelled`,
    });

    await db.updateBooking(booking.id, { stripeCheckoutSessionId: session.id });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Erreur création session Checkout :', err);
    res.status(500).json({ error: 'Impossible de créer la session de paiement' });
  }
});

module.exports = router;

/* ============================================================================
   CÂBLAGE AVEC LE BOUTON "RÉSERVER" DU FRONTEND (atchef-landing-page.html)
   ============================================================================
   ✅ DÉJÀ FAIT dans le fichier HTML de l'Artifact : le listener de #reserveBtn
   appelle déjà `fetch(BACKEND_URL + '/api/checkout/create-session', ...)` puis
   redirige vers `data.checkoutUrl`. Il ne vous reste qu'UNE SEULE chose à faire :

   Tout en haut du <script> du fichier HTML, remplacez :

     const BACKEND_URL = 'https://VOTRE-BACKEND.onrender.com';

   par l'URL réelle que Render vous donnera après le déploiement de CE backend,
   par exemple :

     const BACKEND_URL = 'https://atchef-backend.onrender.com';

   C'est tout — pas besoin de retoucher au reste du script. Rappel du code déjà
   en place dans l'Artifact, pour référence :

     document.getElementById('reserveBtn').addEventListener('click', async () => {
       const allergiesEl = document.getElementById('allergiesInput');
       const errorEl = document.getElementById('bookingError');
       const btn = document.getElementById('reserveBtn');

       // 1. Validation : le champ allergies reste obligatoire.
       if (!allergiesEl.value.trim()) {
         errorEl.textContent = "⚠️ Merci de renseigner ce champ (indiquez « Aucune » si vous n'avez pas de restriction).";
         errorEl.hidden = false;
         allergiesEl.classList.add('invalid');
         allergiesEl.focus();
         return;
       }
       errorEl.hidden = true;
       allergiesEl.classList.remove('invalid');

       // 2. On désactive le bouton pendant l'appel réseau (anti double-clic).
       btn.disabled = true;
       btn.textContent = 'Redirection vers le paiement…';

       try {
         // 3. Appel à CETTE route. On envoie uniquement des RÉFÉRENCES
         //    (id du cuisinier, index de formule, nombre de convives) —
         //    jamais un montant : le serveur recalcule le prix lui-même
         //    (voir le commentaire de sécurité en haut de ce fichier).
         const response = await fetch(BACKEND_URL + '/api/checkout/create-session', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             cookId: currentProfileChef.id,
             formulaIndex: selectedFormulaIndex,
             guestCount: profileGuestCount,
             allergies: allergiesEl.value.trim(),
           }),
         });

         if (!response.ok) throw new Error(await response.text());
         const data = await response.json();

         // 4. Redirection du NAVIGATEUR ENTIER vers la page de paiement
         //    hébergée par Stripe. L'hôte quitte temporairement l'Artifact,
         //    saisit sa carte sur checkout.stripe.com, puis Stripe le
         //    renvoie automatiquement vers success_url (ou cancel_url).
         window.location.href = data.checkoutUrl;

       } catch (err) {
         console.error(err);
         btn.disabled = false;
         btn.textContent = 'Réserver';
         errorEl.textContent = '❌ Une erreur est survenue, merci de réessayer.';
         errorEl.hidden = false;
       }
     });

   Points d'attention :
   • `currentProfileChef`, `selectedFormulaIndex` et `profileGuestCount` sont
     déjà des variables existantes du script de l'Artifact — rien de plus
     à collecter côté frontend.
   • showBookingConfirmation() (l'écran "Demande envoyée !" actuel, purement
     visuel) n'est plus appelée par ce bouton : la VRAIE confirmation doit
     désormais avoir lieu (a) sur la page success_url une fois le paiement
     effectué, et surtout (b) via le webhook `checkout.session.completed`
     (voir webhooks/stripeWebhook.js), qui est la seule source fiable —
     le navigateur peut se fermer avant d'atteindre success_url.
   • Remplacez 'https://VOTRE-BACKEND' par l'URL réelle de ce serveur une
     fois déployé (Railway, Render, Fly.io…) ; en local : http://localhost:4242.
   • CORS est déjà activé dans server.js pour que le domaine hébergeant
     l'Artifact soit autorisé à appeler cette API.
============================================================================ */
