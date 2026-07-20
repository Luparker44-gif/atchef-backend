/**
 * ⚠️ MOCK DE BASE DE DONNÉES — À REMPLACER EN PRODUCTION
 * ------------------------------------------------------------------------
 * Ce fichier simule une base de données en mémoire (tout est perdu au
 * redémarrage du serveur). Il existe uniquement pour que les routes de ce
 * dossier soient exécutables et testables telles quelles, sans avoir à
 * d'abord installer PostgreSQL/MongoDB.
 *
 * En production : remplacez le contenu de ces fonctions par de vraies
 * requêtes vers votre base, EN GARDANT LA MÊME FORME de données en retour
 * (mêmes champs) pour ne rien avoir à changer dans routes/ et webhooks/.
 *
 * Le champ le plus important pour Stripe Connect est `stripeAccountId` :
 * il vaut `null` tant que le cuisinier n'a pas créé/terminé son
 * onboarding Stripe (voir routes/connect.js).
 */

const CUISINE_TYPES = ['Française & Bistrot', 'Italienne', 'Orientale & Méditerranéenne', 'Asiatique', 'Végétarienne & Vegan', 'Pâtisserie & Desserts'];

// Petite rotation de dégradés pour l'avatar de secours (repris du frontend)
// des nouveaux cuisiniers, qui n'ont pas de vraie photo dans ce formulaire simplifié.
const NEW_COOK_GRADIENTS = [
  'linear-gradient(135deg,#E2725B,#A64A34)',
  'linear-gradient(135deg,#8CA888,#4F6B4C)',
  'linear-gradient(135deg,#D9A441,#A64A34)',
  'linear-gradient(135deg,#E2725B,#7A3524)',
];

const cooks = new Map([
  [1, {
    id: 1,
    name: 'Amélie R.',
    email: 'amelie.r@example.com',
    stripeAccountId: null,
    formulas: [
      { id: 'f1', name: 'Menu Découverte', price: 25 },
      { id: 'f2', name: 'Menu Terroir Breton', price: 32 },
    ],
    // Tarif dégressif optionnel : -10% dès 6 convives sur CETTE formule
    discountTiers: [{ minGuests: 6, discountPercent: 10 }],
  }],
  [2, {
    id: 2,
    name: 'Karim B.',
    email: 'karim.b@example.com',
    stripeAccountId: null,
    formulas: [
      { id: 'f1', name: 'Menu Mezzé', price: 28 },
      { id: 'f2', name: 'Menu Fête', price: 38 },
    ],
    discountTiers: [], // aucun tarif dégressif chez ce cuisinier
  }],
]);

const bookings = new Map();
let nextBookingId = 1;

// ⚠️ Démarre à 1000 : les cuisiniers d'exemple ci-dessus utilisent les id 1 et 2,
// qui existent AUSSI en dur dans le frontend (Amélie, Karim...). En partant de
// 1000, un nouveau cuisinier inscrit via le formulaire ne peut jamais entrer en
// collision avec un id déjà utilisé côté frontend (1 à 11).
// ⚠️ Ancien compteur simple retiré : il repartait à 1000 à chaque
// redémarrage du serveur (le serveur gratuit s'endort après 15 min
// d'inactivité), ce qui pouvait faire attribuer le MÊME identifiant à deux
// cuisiniers différents inscrits à des moments différents. On utilise
// désormais l'horodatage courant comme base : garanti unique, même après
// un redémarrage.

module.exports = {
  async findCookById(id) {
    return cooks.get(Number(id)) || null;
  },

  async updateCook(id, patch) {
    const cook = cooks.get(Number(id));
    if (!cook) return null;
    Object.assign(cook, patch);
    return cook;
  },

  async findCookByStripeAccountId(stripeAccountId) {
    for (const cook of cooks.values()) {
      if (cook.stripeAccountId === stripeAccountId) return cook;
    }
    return null;
  },

  async createBooking(data) {
    const id = nextBookingId++;
    const booking = {
      id,
      status: 'pending_payment', // → passera à 'confirmed' via le webhook après paiement réussi
      createdAt: new Date().toISOString(),
      ...data,
    };
    bookings.set(id, booking);
    return booking;
  },

  async findBookingById(id) {
    return bookings.get(Number(id)) || null;
  },

  async updateBooking(id, patch) {
    const booking = bookings.get(Number(id));
    if (!booking) return null;
    Object.assign(booking, patch);
    return booking;
  },

  CUISINE_TYPES,

  async createCook(data) {
    const id = Date.now();
    const cook = {
      id,
      name: data.name,
      email: data.email,
      cuisine: data.cuisine,
      location: data.location,
      stripeAccountId: null,
      quote: data.bio
        ? data.bio.slice(0, 140)
        : `Nouveau sur At'Chef, hâte de vous régaler avec ma cuisine ${data.cuisine.toLowerCase()} !`,
      bio: data.bio || `Cuisinier passionné, récemment inscrit sur At'Chef. Spécialité : ${data.specialty}.`,
      specialties: [data.specialty],
      tags: [],
      // Volontairement un chemin qui n'existe pas : ça déclenche le repli
      // automatique vers l'avatar en dégradé + initiales déjà géré par le frontend.
      photo: '/no-photo-yet.jpg',
      gradient: NEW_COOK_GRADIENTS[id % NEW_COOK_GRADIENTS.length],
      rating: 0,
      reviews: 0, // → le frontend affiche "Nouveau cuisinier" plutôt qu'une note tant que reviews = 0
      training: null,
      selfTaughtNote: "Nouveau cuisinier sur At'Chef.",
      formulas: [{ id: 'f1', name: data.formulaName, price: data.formulaPrice, description: '', includes: [] }],
      discountTiers: [],
      testimonials: [],
    };
    cooks.set(id, cook);
    return cook;
  },

  async getAllCooks() {
    return Array.from(cooks.values());
  },
};
