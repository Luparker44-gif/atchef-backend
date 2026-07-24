const express = require('express');
const router = express.Router();

/**
 * ============================================================================
 * GÉOCODAGE — Nominatim (OpenStreetMap)
 * ============================================================================
 * Convertit une adresse ou un nom de lieu ("Nantes", "Chantenay"...) en
 * coordonnées GPS (latitude/longitude), nécessaires pour la recherche par
 * rayon géographique. Nominatim est gratuit et ne nécessite aucune clé
 * API, mais impose d'envoyer un en-tête User-Agent identifiable — sans
 * quoi les requêtes peuvent être bloquées.
 *
 * ⚠️ Politique d'usage Nominatim : pas plus d'une requête par seconde en
 * usage intensif. Largement suffisant ici, puisqu'on ne géocode qu'au
 * moment de l'inscription d'un cuisinier ou d'une recherche par lieu côté
 * hôte, pas en continu.
 * ============================================================================
 */
async function geocodeLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': "AtChef-Marketplace/1.0 (contact: contact@atchef.fr)" },
  });
  if (!res.ok) throw new Error('Service de géocodage indisponible');
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

/**
 * GET /api/geocode?q=<lieu>
 * Utilisé côté hôte quand il tape un lieu dans les filtres de recherche
 * (l'option "Autour de moi" n'a pas besoin de cette route : elle utilise
 * directement la géolocalisation du navigateur).
 */
router.get('/geocode', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !String(q).trim()) {
      return res.status(400).json({ error: 'Merci de préciser un lieu' });
    }
    const coords = await geocodeLocation(String(q).trim());
    if (!coords) {
      return res.status(404).json({ error: 'Lieu introuvable, essayez une autre formulation' });
    }
    res.json(coords);
  } catch (err) {
    console.error('Erreur géocodage :', err.message);
    res.status(500).json({ error: 'Impossible de géocoder ce lieu pour le moment' });
  }
});

module.exports = router;
module.exports.geocodeLocation = geocodeLocation;
