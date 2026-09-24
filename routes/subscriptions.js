const express = require('express');
const router = express.Router();
const db = require('../data/mockDb');
const { requireAuth } = require('./auth');

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/**
 * ============================================================================
 * PATCH /api/my/weekly-availability — réservé aux cuisiniers
 * ============================================================================
 */
router.patch('/my/weekly-availability', requireAuth, async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  const { weeklyAvailability, availabilityExceptions } = req.body;

  if (weeklyAvailability) {
    for (const slot of weeklyAvailability) {
      if (!DAYS.includes(slot.day)) {
        return res.status(400).json({ error: `Jour invalide : ${slot.day}` });
      }
      if (!/^\d{2}:\d{2}$/.test(slot.startTime) || !/^\d{2}:\d{2}$/.test(slot.endTime)) {
        return res.status(400).json({ error: 'Format horaire invalide (attendu HH:MM)' });
      }
      if (slot.startTime >= slot.endTime) {
        return res.status(400).json({ error: 'L\'heure de début doit précéder l\'heure de fin' });
      }
    }
  }

  const patch = {};
  if (weeklyAvailability) patch.weeklyAvailability = weeklyAvailability;
  if (availabilityExceptions) patch.availabilityExceptions = availabilityExceptions;

  const updated = await db.updateCook(req.user.id, patch);
  if (!updated) return res.status(404).json({ error: 'Profil introuvable' });
  res.json({ weeklyAvailability: updated.weeklyAvailability, availabilityExceptions: updated.availabilityExceptions });
});

/** GET /api/cooks/:cookId/weekly-availability — PUBLIC. */
router.get('/cooks/:cookId/weekly-availability', async (req, res) => {
  const cook = await db.findCookById(req.params.cookId);
  if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });
  res.json({
    weeklyAvailability: cook.weeklyAvailability || [],
    availabilityExceptions: cook.availabilityExceptions || [],
  });
});

/**
 * PATCH /api/my/batch-cooking — réservé aux cuisiniers.
 * Deux prix indépendants : le cuisinier peut n'en fixer qu'un seul, les
 * deux, ou aucun (pas encore prêt à être listé).
 */
router.patch('/my/batch-cooking', requireAuth, async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  const { regimes, batchCookingPriceWeekly, batchCookingPriceMonthly } = req.body;

  if (regimes && !Array.isArray(regimes)) {
    return res.status(400).json({ error: 'regimes doit être un tableau' });
  }
  const validRegimes = regimes ? regimes.every((r) => db.REGIME_TAGS.includes(r)) : true;
  if (!validRegimes) {
    return res.status(400).json({ error: 'Une ou plusieurs étiquettes de régime sont invalides' });
  }

  function validatePrice(val, label) {
    if (val === undefined || val === null || val === '') return null;
    const price = parseFloat(val);
    if (!Number.isFinite(price) || price <= 0 || price > 2000) {
      throw new Error(`Prix ${label} invalide`);
    }
    return price;
  }

  const patch = {};
  try {
    if (batchCookingPriceWeekly !== undefined) patch.batchCookingPriceWeekly = validatePrice(batchCookingPriceWeekly, 'hebdomadaire');
    if (batchCookingPriceMonthly !== undefined) patch.batchCookingPriceMonthly = validatePrice(batchCookingPriceMonthly, 'mensuel');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (regimes) patch.regimes = regimes;

  const updated = await db.updateCook(req.user.id, patch);
  if (!updated) return res.status(404).json({ error: 'Profil introuvable' });
  res.json({
    regimes: updated.regimes,
    batchCookingPriceWeekly: updated.batchCookingPriceWeekly,
    batchCookingPriceMonthly: updated.batchCookingPriceMonthly,
  });
});

/**
 * ============================================================================
 * POST /api/subscriptions — réservé aux hôtes, identité vérifiée requise
 * ============================================================================
 * Corps attendu : { cookId, plan: 'weekly'|'monthly', dayOfWeek, startTime,
 * endTime, startDate }. Le prix (cookPrice) est lu depuis le profil du
 * cuisinier selon le plan choisi — jamais transmis par le client.
 * ============================================================================
 */
router.post('/subscriptions', requireAuth, async (req, res) => {
  if (req.user.role !== 'host') {
    return res.status(403).json({ error: 'Réservé aux hôtes' });
  }
  const { cookId, plan, dayOfWeek, startTime, endTime, startDate } = req.body;
  if (!cookId || !plan || !dayOfWeek || !startTime || !endTime || !startDate) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs obligatoires' });
  }
  if (plan !== 'weekly' && plan !== 'monthly') {
    return res.status(400).json({ error: 'Plan invalide (attendu weekly ou monthly)' });
  }
  if (!DAYS.includes(dayOfWeek)) {
    return res.status(400).json({ error: 'Jour invalide' });
  }

  const verification = await db.findHostVerificationByEmail(req.user.email);
  if (!verification || verification.status !== 'verifie') {
    return res.status(403).json({ error: "Vérification d'identité requise avant de réserver" });
  }

  const cook = await db.findCookById(cookId);
  if (!cook) return res.status(404).json({ error: 'Cuisinier introuvable' });

  const cookPrice = plan === 'monthly' ? cook.batchCookingPriceMonthly : cook.batchCookingPriceWeekly;
  if (!cookPrice) {
    return res.status(400).json({ error: `Ce cuisinier ne propose pas de formule ${plan === 'monthly' ? 'mensuelle' : 'hebdomadaire'}` });
  }

  const slotExists = (cook.weeklyAvailability || []).some(
    (s) => s.day === dayOfWeek && s.startTime <= startTime && s.endTime >= endTime
  );
  if (!slotExists) {
    return res.status(409).json({ error: 'Ce créneau ne fait pas partie des disponibilités actuelles du cuisinier' });
  }

  const subscription = await db.createSubscription({
    cookId, hostEmail: req.user.email, plan, dayOfWeek, startTime, endTime, startDate, cookPrice,
  });
  res.json(subscription);
});

/** GET /api/my/subscriptions — abonnements de l'utilisateur connecté. */
router.get('/my/subscriptions', requireAuth, async (req, res) => {
  const subscriptions = req.user.role === 'cook'
    ? await db.getSubscriptionsForCook(req.user.id)
    : await db.getSubscriptionsForHost(req.user.email);
  res.json(subscriptions);
});

function isOwner(subscription, user) {
  if (user.role === 'cook') return String(subscription.cookId) === String(user.id);
  return subscription.hostEmail === user.email;
}

router.patch('/subscriptions/:id/pause', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'paused' });
  res.json(updated);
});

router.patch('/subscriptions/:id/resume', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'active' });
  res.json(updated);
});

router.patch('/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'cancelled' });
  res.json(updated);
});

router.patch('/subscriptions/:id/skip-week', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });

  const { weekDate } = req.body;
  if (!weekDate) return res.status(400).json({ error: 'Date de la semaine requise' });

  const hoursUntil = (new Date(weekDate + 'T' + subscription.startTime) - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil < 48) {
    return res.status(409).json({ error: 'Le report n\'est possible que jusqu\'à 48h avant la venue prévue' });
  }

  const skippedWeeks = [...(subscription.skippedWeeks || []), weekDate];
  const updated = await db.updateSubscription(req.params.id, { skippedWeeks });
  res.json(updated);
});

/** GET /api/admin/subscriptions — pour le tableau de bord administrateur. */
router.get('/admin/subscriptions', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs' });
  const subscriptions = await db.getAllSubscriptions();
  res.json(subscriptions);
});

module.exports = router;
