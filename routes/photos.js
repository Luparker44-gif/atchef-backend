const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../data/mockDb');
const { requireAuth } = require('./auth');
const { uploadDishPhoto } = require('../services/storage');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

router.post('/my/dish-photos', requireAuth, upload.single('photo'), async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Aucune image reçue' });
  }
  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ error: "Format d'image non supporté (JPEG, PNG ou WebP uniquement)" });
  }

  try {
    const url = await uploadDishPhoto(req.user.id, req.file.buffer, req.file.mimetype, req.file.originalname);

    const cook = await db.findCookById(req.user.id);
    if (!cook) return res.status(404).json({ error: 'Profil introuvable' });

    const caption = req.body.caption ? String(req.body.caption).trim().slice(0, 140) : '';
    const dishPhotos = [...(cook.dishPhotos || []), { url, caption }].slice(0, 12);

    const updated = await db.updateCook(req.user.id, { dishPhotos });
    res.json({ dishPhotos: updated.dishPhotos });
  } catch (err) {
    console.error('Erreur envoi photo de plat :', err.message);
    res.status(500).json({ error: err.message || "Impossible d'envoyer cette photo pour le moment" });
  }
});

router.delete('/my/dish-photos/:index', requireAuth, async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  const cook = await db.findCookById(req.user.id);
  if (!cook) return res.status(404).json({ error: 'Profil introuvable' });

  const idx = parseInt(req.params.index, 10);
  const dishPhotos = (cook.dishPhotos || []).filter((_, i) => i !== idx);

  const updated = await db.updateCook(req.user.id, { dishPhotos });
  res.json({ dishPhotos: updated.dishPhotos });
});

module.exports = router;/**
 * POST /api/my/profile-photo
 * Réservé aux cuisiniers : remplace leur photo de profil (une seule
 * photo, contrairement au feed qui en accepte plusieurs).
 */
router.post('/my/profile-photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (req.user.role !== 'cook') {
    return res.status(403).json({ error: 'Réservé aux cuisiniers' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Aucune image reçue' });
  }
  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ error: "Format d'image non supporté (JPEG, PNG ou WebP uniquement)" });
  }

  try {
    const url = await uploadDishPhoto(req.user.id, req.file.buffer, req.file.mimetype, req.file.originalname);
    const updated = await db.updateCook(req.user.id, { photo: url });
    res.json({ photo: updated.photo });
  } catch (err) {
    console.error('Erreur envoi photo de profil :', err.message);
    res.status(500).json({ error: err.message || "Impossible d'envoyer cette photo pour le moment" });
  }
});
