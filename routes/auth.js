const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../data/mockDb');

// ⚠️ Séparé de ADMIN_JWT_SECRET par principe : un compte hôte/cuisinier
// compromis ne doit jamais permettre de forger un jeton admin, et
// inversement. Changez cette valeur sur Render avant un vrai lancement.
const JWT_SECRET = process.env.USER_JWT_SECRET || 'dev-secret-utilisateur-a-changer-absolument';
// Les hôtes/cuisiniers restent connectés longtemps (30 jours), contrairement
// à l'admin (8h) : usage bien plus fréquent, moins sensible en cas de fuite.
const TOKEN_EXPIRY = '30d';

/**
 * Middleware de protection des routes "Mon espace". Vérifie un jeton JWT
 * valide dans l'en-tête Authorization: Bearer <token>, et attache
 * req.user = { role: 'host'|'cook', email, id, name }.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session invalide ou expirée, merci de vous reconnecter' });
  }
}

/**
 * ============================================================================
 * POST /api/auth/register-host
 * ============================================================================
 * Crée un compte hôte (nom, email, mot de passe). Contrairement à
 * l'inscription cuisinier (volontairement sans mot de passe au départ pour
 * aller vite), un compte hôte a vocation à être réutilisé pour suivre ses
 * réservations : un mot de passe est donc demandé, et haché avec bcrypt
 * avant stockage — jamais conservé en clair, même dans cette base de
 * démonstration en mémoire.
 * ============================================================================
 */
router.post('/auth/register-host', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Merci de remplir tous les champs' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }
    const existingHost = await db.findHostByEmail(email);
    if (existingHost) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const host = await db.createHost({ name: String(name).trim(), email: String(email).trim(), passwordHash });

    const token = jwt.sign({ role: 'host', email: host.email, id: host.id, name: host.name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token, role: 'host', name: host.name, email: host.email });
  } catch (err) {
    console.error('Erreur création compte hôte :', err);
    res.status(500).json({ error: 'Impossible de créer le compte' });
  }
});

/**
 * ============================================================================
 * POST /api/auth/login
 * ============================================================================
 * Connexion unifiée pour hôtes ET cuisiniers : on cherche d'abord un
 * compte hôte avec cet email, puis un cuisinier, et on compare le mot de
 * passe haché dans les deux cas avec bcrypt.compare (jamais de
 * comparaison directe de texte en clair).
 * ============================================================================
 */
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const host = await db.findHostByEmail(email);
    if (host && host.passwordHash) {
      const match = await bcrypt.compare(password, host.passwordHash);
      if (match) {
        const token = jwt.sign({ role: 'host', email: host.email, id: host.id, name: host.name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        return res.json({ token, role: 'host', name: host.name, email: host.email });
      }
    }

    const cook = await db.findCookByEmail(email);
    if (cook && cook.passwordHash) {
      const match = await bcrypt.compare(password, cook.passwordHash);
      if (match) {
        const token = jwt.sign({ role: 'cook', email: cook.email, id: cook.id, name: cook.name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        return res.json({ token, role: 'cook', name: cook.name, email: cook.email, cookId: cook.id });
      }
    }

    // Volontairement le même message dans tous les cas d'échec (mauvais
    // email OU mauvais mot de passe) : ne jamais révéler si un email existe.
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  } catch (err) {
    console.error('Erreur connexion :', err);
    res.status(500).json({ error: 'Impossible de vous connecter' });
  }
});

/**
 * GET /api/my/bookings
 * Réservations liées au compte connecté : pour un hôte, celles qu'il a
 * effectuées (retrouvées par email) ; pour un cuisinier, celles qu'il a
 * reçues (retrouvées par cookId).
 */
router.get('/my/bookings', requireAuth, async (req, res) => {
  const allBookings = await db.getAllBookings();
  const filtered = req.user.role === 'cook'
    ? allBookings.filter(b => String(b.cookId) === String(req.user.id))
    : allBookings.filter(b => b.hostEmail === req.user.email);
  res.json(filtered);
});

/**
 * GET /api/my/profile
 * Pour un cuisinier connecté : ses propres informations complètes (avec
 * les champs normalement privés, puisqu'il s'agit de lui-même). Pour un
 * hôte : ses informations de compte.
 */
router.get('/my/profile', requireAuth, async (req, res) => {
  if (req.user.role === 'cook') {
    const cook = await db.findCookById(req.user.id);
    if (!cook) return res.status(404).json({ error: 'Profil introuvable' });
    const { passwordHash, ...publicFields } = cook;
    return res.json({ role: 'cook', ...publicFields });
  }
  const host = await db.findHostByEmail(req.user.email);
  if (!host) return res.status(404).json({ error: 'Profil introuvable' });
  const { passwordHash, ...publicFields } = host;
  res.json({ role: 'host', ...publicFields });
});

module.exports = router;
