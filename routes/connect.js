const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../data/mockDb');
const { geocodeLocation } = require('./geo');

const USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'dev-secret-utilisateur-a-changer-absolument';

/**
 * ============================================================================
 * ROUTE 1 — Création d'un compte Stripe Connect Express pour un cuisinier
 * ============================================================================
 * À appeler quand un cuisinier termine son inscription sur At'Chef (par ex.
 * depuis un futur formulaire "Devenir Cuisinier" côté frontend).
 *
 * Principe clé : At'Chef ne demande JAMAIS lui-même le RIB/IBAN ou une pièce
 * d'identité. C'est Stripe qui héberge ce formulaire sur ses propres pages
 * sécurisées (l'"Account Link" généré ci-dessous) — le cuisinier y est
 * redirigé, saisit ses coordonnées bancaires directement chez Stripe, puis
 * revient sur At'Chef. Cela nous dispense d'avoir à être nous-mêmes
 * conformes aux exigences KYC/DSP2, et rassure le cuisinier sur la sécurité
 * de ses données.
 *
 * POST /api/cooks/:cookId/stripe-account
 * → 200 { url: "https://connect.stripe.com/setup/e/acct_xxx/..." }
 *
 * Côté frontend, il faut REDIRIGER le navigateur vers cette url
 * (window.location.href = url), et non l'appeler en simple fetch/XHR :
 * c'est une vraie page que le cuisinier doit voir et remplir.
 * ============================================================================
 */
router.post('/cooks/:cookId/stripe-account', async (req, res) => {
  try {
    const cook = await db.findCookById(req.params.cookId);
    if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });

    // Idempotence : si un compte Connect existe déjà pour ce cuisinier
    // (même incomplet), on le RÉUTILISE au lieu d'en créer un second.
    let stripeAccountId = cook.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: 'FR', // At'Chef opère à Nantes ; à rendre dynamique si international un jour
          email: cook.email,
          business_type: 'individual', // la majorité des cuisiniers amateurs déclarent en nom propre / auto-entrepreneur
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }, // ⚠️ INDISPENSABLE : sans cette capability, impossible de leur transférer les 90 %
          },
          metadata: {
            atchefCookId: String(cook.id), // permet de retrouver le cuisinier depuis le Dashboard Stripe
          },
        },
        {
          // Empêche la création d'un 2e compte Connect si cette requête
          // était rejouée (double-clic, retry réseau, etc.)
          idempotencyKey: `connect-account-cook-${cook.id}`,
        }
      );

      stripeAccountId = account.id;
      await db.updateCook(cook.id, { stripeAccountId });
    }

    // Un Account Link est une URL À USAGE UNIQUE et à DURÉE DE VIE COURTE
    // (quelques minutes). Ne la stockez jamais en base : régénérez-en une
    // nouvelle à chaque fois que le cuisinier doit (re)commencer ou
    // compléter son inscription Stripe.
    // ⚠️ Le frontend est aujourd'hui une seule page (l'Artifact), sans sous-pages.
    // On revient donc sur CETTE MÊME page avec de simples paramètres, que le
    // script du frontend lit au chargement (voir onboarding=refresh/complete).
    // On transmet aussi cookId pour que le frontend sache de qui il s'agit.
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      // Stripe renvoie ici si le lien a expiré avant que le cuisinier ait fini
      // → le frontend rappelle alors automatiquement cette route pour un lien neuf.
      refresh_url: `${process.env.APP_URL}/?onboarding=refresh&cookId=${cook.id}`,
      // Stripe renvoie ici une fois le formulaire rempli — mais cela ne
      // garantit PAS que tout soit validé côté Stripe (vérifications
      // d'identité en cours, etc.) : voir /stripe-status ci-dessous.
      return_url: `${process.env.APP_URL}/?onboarding=complete&cookId=${cook.id}`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Erreur création compte Stripe Connect :', err);
    res.status(500).json({ error: 'Impossible de créer le compte de paiement du cuisinier' });
  }
});

/**
 * ============================================================================
 * Vérification du statut d'un compte Connect
 * ============================================================================
 * À appeler à deux moments clés :
 *  (a) sur la page où atterrit le cuisinier après le `return_url` ci-dessus,
 *      pour lui afficher "Configuration terminée ✅" ou "Il manque encore
 *      des informations" ;
 *  (b) juste avant d'autoriser une réservation chez ce cuisinier (voir
 *      routes/checkout.js) — impossible de lui transférer de l'argent tant
 *      que `charges_enabled` / `payouts_enabled` ne sont pas à `true`.
 *
 * GET /api/cooks/:cookId/stripe-status
 * ============================================================================
 */
router.get('/cooks/:cookId/stripe-status', async (req, res) => {
  try {
    const cook = await db.findCookById(req.params.cookId);
    if (!cook || !cook.stripeAccountId) {
      return res.json({ onboarded: false, chargesEnabled: false, payoutsEnabled: false });
    }

    const account = await stripe.accounts.retrieve(cook.stripeAccountId);

    res.json({
      onboarded: account.charges_enabled && account.payouts_enabled,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (err) {
    console.error('Erreur vérification statut Stripe :', err);
    res.status(500).json({ error: 'Impossible de vérifier le statut du compte' });
  }
});

/**
 * ============================================================================
 * ROUTE — Inscription d'un nouveau cuisinier (formulaire "Devenir Cuisinier")
 * ============================================================================
 * C'est la route qui manquait pour que "Devenir Cuisinier" fonctionne
 * réellement. Choix assumé pour cette phase de test : PAS de mot de passe,
 * pas de session, pas de connexion — on crée simplement une fiche cuisinier.
 * L'identité n'est donc pas protégée à ce stade ; à ajouter avant un vrai
 * lancement public (voir note en bas de fichier).
 *
 * Corps de requête JSON attendu :
 * {
 *   "name": "Amélie Rousseau",
 *   "email": "amelie@example.com",
 *   "cuisine": "Française & Bistrot",   // doit être l'une des CUISINE_TYPES
 *   "location": "Chantenay",
 *   "specialty": "Galettes bretonnes maison",
 *   "bio": "...",                        // optionnel
 *   "formulaName": "Menu Découverte",
 *   "formulaPrice": 25
 * }
 *
 * POST /api/cooks/register
 * → 200 { cookId: 1000 }
 * Le frontend enchaîne aussitôt avec POST /api/cooks/1000/stripe-account
 * pour rediriger le cuisinier vers la configuration de ses paiements.
 * ============================================================================
 */
router.post('/cooks/register', async (req, res) => {
  try {
    const { name, email, password, cuisine, location, specialty, bio, formulaName, formulaPrice } = req.body;

    if (!name || !email || !password || !cuisine || !location || !specialty || !formulaName || formulaPrice === undefined) {
      return res.status(400).json({ error: 'Merci de remplir tous les champs obligatoires.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (!db.CUISINE_TYPES.includes(cuisine)) {
      return res.status(400).json({ error: 'Type de cuisine invalide.' });
    }
    const price = parseFloat(formulaPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 500) {
      return res.status(400).json({ error: 'Prix de formule invalide.' });
    }
    const existingCook = await db.findCookByEmail(email);
    if (existingCook) {
      return res.status(409).json({ error: 'Un compte cuisinier existe déjà avec cet email.' });
    }

    // Le mot de passe est haché avec bcrypt avant stockage — jamais
    // conservé en clair, même dans cette base de démonstration en mémoire.
    const passwordHash = await bcrypt.hash(password, 10);

    // Géocodage du lieu saisi (ex. "Chantenay, Nantes") en coordonnées GPS,
    // nécessaires pour la recherche par rayon géographique. Si le
    // géocodage échoue (service indisponible, lieu mal formulé...),
    // l'inscription continue quand même : le cuisinier sera juste absent
    // des recherches par rayon tant qu'il n'aura pas précisé un lieu
    // reconnu, mais tout le reste fonctionne normalement.
    let coords = null;
    try {
      coords = await geocodeLocation(`${location}, Nantes, France`);
    } catch (geoErr) {
      console.warn('Géocodage indisponible pour', location, ':', geoErr.message);
    }

    const cook = await db.createCook({
      name: String(name).trim(),
      email: String(email).trim(),
      passwordHash,
      cuisine,
      location: String(location).trim(),
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      specialty: String(specialty).trim(),
      bio: bio ? String(bio).trim() : '',
      formulaName: String(formulaName).trim(),
      formulaPrice: price,
    });

    // Le cuisinier est connecté automatiquement dès son inscription : pas
    // besoin de se reconnecter juste après avoir créé son compte.
    const token = jwt.sign({ role: 'cook', email: cook.email, id: cook.id, name: cook.name }, USER_JWT_SECRET, { expiresIn: '30d' });

    res.json({ cookId: cook.id, token });
  } catch (err) {
    console.error('Erreur inscription cuisinier :', err);
    res.status(500).json({ error: "Impossible de créer votre profil pour le moment" });
  }
});

/**
 * ============================================================================
 * ROUTE — Liste publique des cuisiniers (pour la recherche du frontend)
 * ============================================================================
 * ⚠️ IMPORTANT — LIMITE ARCHITECTURALE ACTUELLE À CONNAÎTRE :
 * Le frontend affiche aujourd'hui 11 cuisiniers écrits EN DUR dans son propre
 * script (indépendants de ce backend). Cette route permet au frontend de
 * RÉCUPÉRER EN PLUS les cuisiniers inscrits via /cooks/register (id ≥ 1000)
 * et de les ajouter à l'affichage — mais elle ne remplace pas encore les 11
 * de démo. Le jour où vous aurez une vraie base de données, cette route
 * deviendra la SEULE source de vérité pour les deux.
 *
 * On ne renvoie JAMAIS `email` ni `stripeAccountId` : ce sont des
 * informations privées qui n'ont rien à faire dans une réponse publique.
 *
 * GET /api/cooks
 * ============================================================================
 */
router.get('/cooks', async (req, res) => {
  try {
    const allCooks = await db.getAllCooks();
    const publicCooks = allCooks.map(({ email, stripeAccountId, passwordHash, ...publicFields }) => publicFields);
    res.json(publicCooks);
  } catch (err) {
    console.error('Erreur récupération des cuisiniers :', err);
    res.status(500).json({ error: 'Impossible de récupérer la liste des cuisiniers' });
  }
});

/**
 * GET /api/cooks/:cookId/availability
 * PUBLIC — utilisée par le calendrier de réservation sur le profil du
 * cuisinier. Combine deux sources : les jours que le cuisinier a
 * manuellement marqués indisponibles, et les jours où il a déjà une
 * réservation CONFIRMÉE (payée) — un cuisinier ne peut assurer qu'un seul
 * repas par jour. Les réservations "en attente de paiement" ne bloquent
 * pas un jour, pour éviter qu'un paiement abandonné ne le bloque
 * indéfiniment.
 */
router.get('/cooks/:cookId/availability', async (req, res) => {
  try {
    const cook = await db.findCookById(req.params.cookId);
    if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });

    const allBookings = await db.getAllBookings();
    const bookedDates = allBookings
      .filter(b => String(b.cookId) === String(cook.id) && b.status === 'confirmed' && b.eventDate)
      .map(b => b.eventDate);

    const unavailableDates = Array.from(new Set([...(cook.unavailableDates || []), ...bookedDates]));
    res.json({ unavailableDates });
  } catch (err) {
    console.error('Erreur récupération disponibilité :', err);
    res.status(500).json({ error: 'Impossible de récupérer la disponibilité' });
  }
});

module.exports = router;
