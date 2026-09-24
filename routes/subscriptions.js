const express = require('express');
const router = express.Router();
const db = require('../data/mockDb');
const { requireAuth } = require('./auth');

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/**
 * ============================================================================
 * PATCH /api/my/weekly-availability — réservé aux cuisiniers
 * ============================================================================
 * Définit le modèle hebdomadaire type de disponibilité pour le batch cooking.
 * Corps attendu :
 * { weeklyAvailability: [{ day: 'lundi', startTime: '09:00', endTime: '12:00' }, ...],
 *   availabilityExceptions: ['2026-09-01', ...] }
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

/** GET /api/cooks/:cookId/weekly-availability — PUBLIC, pour afficher les créneaux au moment de la réservation. */
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
 * Définit les étiquettes de régime proposées et le prix libre de la formule
 * hebdomadaire. Un cuisinier peut laisser batchCookingPrice à null s'il ne
 * propose que l'offre événementielle ponctuelle.
 */
router.patch('/my/batch-cooking', requireAuth, async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  const { regimes, batchCookingPrice } = req.body;

  if (regimes && !Array.isArray(regimes)) {
    return res.status(400).json({ error: 'regimes doit être un tableau' });
  }
  const validRegimes = regimes ? regimes.every((r) => db.REGIME_TAGS.includes(r)) : true;
  if (!validRegimes) {
    return res.status(400).json({ error: 'Une ou plusieurs étiquettes de régime sont invalides' });
  }
  if (batchCookingPrice !== undefined && batchCookingPrice !== null) {
    const price = parseFloat(batchCookingPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 1000) {
      return res.status(400).json({ error: 'Prix de formule batch cooking invalide' });
    }
  }

  const patch = {};
  if (regimes) patch.regimes = regimes;
  if (batchCookingPrice !== undefined) patch.batchCookingPrice = batchCookingPrice;

  const updated = await db.updateCook(req.user.id, patch);
  if (!updated) return res.status(404).json({ error: 'Profil introuvable' });
  res.json({ regimes: updated.regimes, batchCookingPrice: updated.batchCookingPrice });
});

/**
 * ============================================================================
 * POST /api/subscriptions — réservé aux hôtes, vérification d'identité requise
 * ============================================================================
 * Crée un abonnement batch cooking récurrent (jour + créneau horaire), chez
 * un cuisinier donné. Corps attendu :
 * { cookId, dayOfWeek: 'lundi', startTime: '09:00', endTime: '12:00', startDate: '2026-10-06' }
 * Le prix du cuisinier (cookPrice) est lu depuis son profil, jamais transmis
 * par le client, pour éviter toute manipulation du prix depuis le navigateur.
 * ============================================================================
 */
router.post('/subscriptions', requireAuth, async (req, res) => {
  if (req.user.role !== 'host') {
    return res.status(403).json({ error: 'Réservé aux hôtes' });
  }
  const { cookId, dayOfWeek, startTime, endTime, startDate } = req.body;
  if (!cookId || !dayOfWeek || !startTime || !endTime || !startDate) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs obligatoires' });
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
  if (!cook.batchCookingPrice) {
    return res.status(400).json({ error: 'Ce cuisinier ne propose pas encore de formule batch cooking' });
  }

  const slotExists = (cook.weeklyAvailability || []).some(
    (s) => s.day === dayOfWeek && s.startTime <= startTime && s.endTime >= endTime
  );
  if (!slotExists) {
    return res.status(409).json({ error: 'Ce créneau ne fait pas partie des disponibilités actuelles du cuisinier' });
  }

  const subscription = await db.createSubscription({
    cookId,
    hostEmail: req.user.email,
    dayOfWeek,
    startTime,
    endTime,
    startDate,
    cookPrice: cook.batchCookingPrice,
  });
  res.json(subscription);
});

/** GET /api/my/subscriptions — liste les abonnements de l'utilisateur connecté, hôte ou cuisinier. */
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

/** PATCH /api/subscriptions/:id/pause — met en pause un abonnement (hôte ou cuisinier). */
router.patch('/subscriptions/:id/pause', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'paused' });
  res.json(updated);
});

/** PATCH /api/subscriptions/:id/resume — reprend un abonnement en pause. */
router.patch('/subscriptions/:id/resume', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'active' });
  res.json(updated);
});

/** PATCH /api/subscriptions/:id/cancel — arrête définitivement un abonnement, sans engagement. */
router.patch('/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  const subscription = await db.findSubscriptionById(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Abonnement introuvable' });
  if (!isOwner(subscription, req.user)) return res.status(403).json({ error: 'Non autorisé' });
  const updated = await db.updateSubscription(req.params.id, { status: 'cancelled' });
  res.json(updated);
});

/**
 * PATCH /api/subscriptions/:id/skip-week — reporte/saute une semaine précise.
 * Corps : { weekDate: '2026-10-13' } (le jour de la venue prévue cette semaine-là)
 * Refusé si la demande arrive à moins de 48h de la venue.
 */
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

module.exports = router;
