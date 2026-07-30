const express = require('express');
const router = express.Router();
const db = require('../data/mockDb');
const { requireAuth } = require('./auth');

/**
 * ============================================================================
 * AVIS À DOUBLE SENS
 * ============================================================================
 * L'hôte note le cuisinier (public, affiché sur son profil — comme avant).
 * Le cuisinier note AUSSI l'hôte (privé, jamais affiché publiquement —
 * les hôtes n'ont pas de profil public — mais consultable par les
 * cuisiniers avant d'accepter une réservation future du même hôte).
 * C'est ce deuxième sens qui permet de repérer un hôte qui se comporterait
 * mal avant qu'un autre cuisinier n'accepte sa prochaine réservation.
 * ============================================================================
 */

/**
 * POST /api/bookings/:id/review
 * Corps : { rating: 1-5, comment: "..." }
 * Chaque participant (hôte OU cuisinier) peut noter l'AUTRE, une seule
 * fois par réservation, une fois celle-ci confirmée (payée).
 */
router.post('/bookings/:id/review', requireAuth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const ratingNum = parseInt(rating, 10);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'La note doit être comprise entre 1 et 5' });
    }

    const booking = await db.findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Seule une réservation payée et confirmée peut être notée' });
    }

    const isParticipant = req.user.role === 'cook'
      ? booking.cookId === req.user.id
      : booking.hostEmail === req.user.email;
    if (!isParticipant) {
      return res.status(403).json({ error: "Vous ne faites pas partie de cette réservation" });
    }

    const existing = await db.findReviewByBookingAndRater(booking.id, req.user.role);
    if (existing) {
      return res.status(409).json({ error: 'Vous avez déjà noté cette réservation' });
    }

    const review = await db.createReview({
      bookingId: booking.id,
      raterRole: req.user.role, // 'host' note le cuisinier / 'cook' note l'hôte
      cookId: booking.cookId,
      hostEmail: booking.hostEmail,
      rating: ratingNum,
      comment: comment ? String(comment).trim().slice(0, 500) : '',
    });

    // Si c'est l'hôte qui note, on met à jour la note publique du cuisinier.
    if (req.user.role === 'host') {
      const allReviews = await db.getReviewsForCook(booking.cookId);
      const avg = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
      await db.updateCook(booking.cookId, {
        rating: Math.round(avg * 10) / 10,
        reviews: allReviews.length,
      });
    }

    res.json(review);
  } catch (err) {
    console.error('Erreur création avis :', err);
    res.status(500).json({ error: "Impossible d'enregistrer cet avis pour le moment" });
  }
});

/**
 * GET /api/cooks/:cookId/reviews
 * PUBLIC — avis déposés par des hôtes sur ce cuisinier (affichés sur son profil).
 */
router.get('/cooks/:cookId/reviews', async (req, res) => {
  try {
    const reviews = await db.getReviewsForCook(req.params.cookId);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: 'Impossible de récupérer les avis' });
  }
});

module.exports = router;
