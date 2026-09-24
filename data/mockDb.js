/**
 * ============================================================================
 * BASE DE DONNÉES — PostgreSQL réel (remplace l'ancienne version en mémoire)
 * ============================================================================
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CUISINE_TYPES = ['Française & Bistrot', 'Italienne', 'Orientale & Méditerranéenne', 'Asiatique', 'Végétarienne & Vegan', 'Pâtisserie & Desserts'];
const REGIME_TAGS = ['vegan', 'vegetarien', 'sans_gluten', 'sans_lactose', 'proteine_sportif'];

const NEW_COOK_GRADIENTS = [
  'linear-gradient(135deg,#E2725B,#A64A34)',
  'linear-gradient(135deg,#8CA888,#4F6B4C)',
  'linear-gradient(135deg,#D9A441,#A64A34)',
  'linear-gradient(135deg,#E2725B,#7A3524)',
];

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cooks (
      id BIGINT PRIMARY KEY,
      email TEXT UNIQUE,
      stripe_account_id TEXT,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGINT PRIMARY KEY,
      cook_id BIGINT,
      host_email TEXT,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS host_verifications (
      email TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosts (
      email TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGINT PRIMARY KEY,
      host_email TEXT,
      cook_id BIGINT,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGINT PRIMARY KEY,
      booking_id BIGINT,
      rater_role TEXT,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS landing_signups (
      id BIGINT PRIMARY KEY,
      email TEXT NOT NULL,
      data JSONB NOT NULL
    )
  `);
  /**
   * Table des abonnements batch cooking. Distincte de `bookings` (qui reste
   * pour l'offre événementielle ponctuelle, conservée en option secondaire).
   * Un abonnement porte un jour de la semaine + un créneau horaire récurrent,
   * défini d'après le modèle hebdomadaire type du cuisinier.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGINT PRIMARY KEY,
      cook_id BIGINT,
      host_email TEXT,
      data JSONB NOT NULL
    )
  `);

  const existing = await pool.query('SELECT id FROM cooks WHERE id IN (1, 2)');
  const existingIds = existing.rows.map((r) => Number(r.id));

  if (!existingIds.includes(1)) {
    const amelie = {
      id: 1, name: 'Amélie R.', email: 'amelie.r@example.com', passwordHash: null,
      lat: 47.2184, lng: -1.5536,
      stripeAccountId: null, identityVerified: false,
      formulas: [
        { id: 'f1', name: 'Menu Découverte', price: 25 },
        { id: 'f2', name: 'Menu Terroir Breton', price: 32 },
      ],
      discountTiers: [{ minGuests: 6, discountPercent: 10 }],
    };
    await pool.query(
      'INSERT INTO cooks (id, email, stripe_account_id, data) VALUES ($1,$2,$3,$4)',
      [1, amelie.email, null, JSON.stringify(amelie)]
    );
  }
  if (!existingIds.includes(2)) {
    const karim = {
      id: 2, name: 'Karim B.', email: 'karim.b@example.com', passwordHash: null,
      lat: 47.2065, lng: -1.5490,
      stripeAccountId: null, identityVerified: false,
      formulas: [
        { id: 'f1', name: 'Menu Mezzé', price: 28 },
        { id: 'f2', name: 'Menu Fête', price: 38 },
      ],
      discountTiers: [],
    };
    await pool.query(
      'INSERT INTO cooks (id, email, stripe_account_id, data) VALUES ($1,$2,$3,$4)',
      [2, karim.email, null, JSON.stringify(karim)]
    );
  }
}

module.exports = {
  initSchema,
  CUISINE_TYPES,
  REGIME_TAGS,

  async findCookById(id) {
    const res = await pool.query('SELECT data FROM cooks WHERE id = $1', [Number(id)]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async updateCook(id, patch) {
    const current = await this.findCookById(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query(
      'UPDATE cooks SET data = $1, email = $2, stripe_account_id = $3 WHERE id = $4',
      [JSON.stringify(updated), updated.email, updated.stripeAccountId, Number(id)]
    );
    return updated;
  },

  async deleteCook(id) {
    await pool.query('DELETE FROM cooks WHERE id = $1', [Number(id)]);
    return true;
  },

  async findCookByStripeAccountId(stripeAccountId) {
    const res = await pool.query('SELECT data FROM cooks WHERE stripe_account_id = $1', [stripeAccountId]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async findCookByEmail(email) {
    const res = await pool.query('SELECT data FROM cooks WHERE email = $1', [email]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async createCook(data) {
    const id = Date.now();
    const cook = {
      id,
      name: data.name,
      email: data.email,
      passwordHash: data.passwordHash || null,
      cuisine: data.cuisine,
      location: data.location,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lng: typeof data.lng === 'number' ? data.lng : null,
      unavailableDates: [],
      // Modèle hebdomadaire type de disponibilité pour le batch cooking :
      // ex. [{ day: 'lundi', startTime: '09:00', endTime: '12:00' }]
      weeklyAvailability: [],
      // Dates précises où le cuisinier bloque une exception ponctuelle,
      // même si son modèle hebdomadaire le rendrait normalement disponible.
      availabilityExceptions: [],
      // Étiquettes de régime pour le filtrage par préférences de l'hôte.
      regimes: [],
      // Prix libre de la formule batch cooking hebdomadaire (optionnel :
      // un cuisinier peut proposer l'événementiel, le batch cooking, ou les deux).
      batchCookingPrice: null,
      dishPhotos: [],
      stripeAccountId: null,
      identityVerified: false,
      quote: data.bio
        ? data.bio.slice(0, 140)
        : `Nouveau sur At'Chef, hâte de vous régaler avec ma cuisine ${data.cuisine.toLowerCase()} !`,
      bio: data.bio || `Cuisinier passionné, récemment inscrit sur At'Chef. Spécialité : ${data.specialty}.`,
      specialties: [data.specialty],
      tags: [],
      photo: '/no-photo-yet.jpg',
      gradient: NEW_COOK_GRADIENTS[id % NEW_COOK_GRADIENTS.length],
      rating: 0,
      reviews: 0,
      training: null,
      selfTaughtNote: "Nouveau cuisinier sur At'Chef.",
      formulas: [{ id: 'f1', name: data.formulaName, price: data.formulaPrice, description: '', includes: [] }],
      discountTiers: [],
      testimonials: [],
    };
    await pool.query(
      'INSERT INTO cooks (id, email, stripe_account_id, data) VALUES ($1,$2,$3,$4)',
      [id, cook.email, null, JSON.stringify(cook)]
    );
    return cook;
  },

  async getAllCooks() {
    const res = await pool.query('SELECT data FROM cooks');
    return res.rows.map((r) => r.data);
  },

  async createBooking(data) {
    const id = Date.now();
    const booking = {
      id,
      status: 'pending_payment',
      createdAt: new Date().toISOString(),
      ...data,
    };
    await pool.query(
      'INSERT INTO bookings (id, cook_id, host_email, data) VALUES ($1,$2,$3,$4)',
      [id, data.cookId || null, data.hostEmail || null, JSON.stringify(booking)]
    );
    return booking;
  },

  async findBookingById(id) {
    const res = await pool.query('SELECT data FROM bookings WHERE id = $1', [Number(id)]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async updateBooking(id, patch) {
    const current = await this.findBookingById(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query('UPDATE bookings SET data = $1 WHERE id = $2', [JSON.stringify(updated), Number(id)]);
    return updated;
  },

  async getAllBookings() {
    const res = await pool.query('SELECT data FROM bookings ORDER BY id DESC');
    return res.rows.map((r) => r.data);
  },

  async createTicket(data) {
    const id = Date.now();
    const ticket = {
      id,
      name: data.name,
      email: data.email,
      role: data.role || 'non précisé',
      subject: data.subject,
      message: data.message,
      priority: data.priority === 'urgent' ? 'urgent' : 'normal',
      bookingId: data.bookingId || null,
      status: 'ouvert',
      adminNote: '',
      createdAt: new Date().toISOString(),
    };
    await pool.query('INSERT INTO tickets (id, data) VALUES ($1,$2)', [id, JSON.stringify(ticket)]);
    return ticket;
  },

  async getAllTickets() {
    const res = await pool.query('SELECT data FROM tickets ORDER BY id DESC');
    const tickets = res.rows.map((r) => r.data);
    return tickets.sort((a, b) => {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (a.priority !== 'urgent' && b.priority === 'urgent') return 1;
      return 0;
    });
  },

  async findTicketById(id) {
    const res = await pool.query('SELECT data FROM tickets WHERE id = $1', [Number(id)]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async updateTicket(id, patch) {
    const current = await this.findTicketById(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query('UPDATE tickets SET data = $1 WHERE id = $2', [JSON.stringify(updated), Number(id)]);
    return updated;
  },

  async createHostVerification(data) {
    const record = {
      email: data.email,
      verificationSessionId: data.verificationSessionId,
      status: data.status,
      updatedAt: new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO host_verifications (email, data) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET data = $2`,
      [data.email, JSON.stringify(record)]
    );
    return record;
  },

  async findHostVerificationByEmail(email) {
    const res = await pool.query('SELECT data FROM host_verifications WHERE email = $1', [email]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async updateHostVerificationBySessionId(sessionId, patch) {
    const res = await pool.query(
      `SELECT email, data FROM host_verifications WHERE data->>'verificationSessionId' = $1`,
      [sessionId]
    );
    if (!res.rows[0]) return null;
    const updated = { ...res.rows[0].data, ...patch, updatedAt: new Date().toISOString() };
    await pool.query('UPDATE host_verifications SET data = $1 WHERE email = $2', [JSON.stringify(updated), res.rows[0].email]);
    return updated;
  },

  async createHost(data) {
    const host = {
      id: Date.now(),
      name: data.name,
      email: data.email,
      passwordHash: data.passwordHash,
      createdAt: new Date().toISOString(),
    };
    await pool.query('INSERT INTO hosts (email, data) VALUES ($1,$2)', [data.email, JSON.stringify(host)]);
    return host;
  },

  async findHostByEmail(email) {
    const res = await pool.query('SELECT data FROM hosts WHERE email = $1', [email]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async getAllHosts() {
    const res = await pool.query('SELECT data FROM hosts');
    return res.rows.map((r) => r.data);
  },

  async deleteHost(email) {
    await pool.query('DELETE FROM hosts WHERE email = $1', [email]);
    return true;
  },

  async updateHost(email, patch) {
    const current = await this.findHostByEmail(email);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query('UPDATE hosts SET data = $1 WHERE email = $2', [JSON.stringify(updated), email]);
    return updated;
  },

  async findConversationByPair(hostEmail, cookId) {
    const res = await pool.query(
      'SELECT data FROM conversations WHERE host_email = $1 AND cook_id = $2',
      [hostEmail, Number(cookId)]
    );
    return res.rows[0] ? res.rows[0].data : null;
  },

  async findConversationById(id) {
    const res = await pool.query('SELECT data FROM conversations WHERE id = $1', [Number(id)]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async createConversation(data) {
    const id = Date.now();
    const conversation = {
      id,
      hostEmail: data.hostEmail,
      cookId: Number(data.cookId),
      hostName: data.hostName || '',
      cookName: data.cookName || '',
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    await pool.query(
      'INSERT INTO conversations (id, host_email, cook_id, data) VALUES ($1,$2,$3,$4)',
      [id, conversation.hostEmail, conversation.cookId, JSON.stringify(conversation)]
    );
    return conversation;
  },

  async addMessageToConversation(id, sender, text) {
    const current = await this.findConversationById(id);
    if (!current) return null;
    const message = { sender, text, createdAt: new Date().toISOString() };
    const updated = {
      ...current,
      messages: [...current.messages, message],
      updatedAt: message.createdAt,
    };
    await pool.query('UPDATE conversations SET data = $1 WHERE id = $2', [JSON.stringify(updated), Number(id)]);
    return updated;
  },

  async getConversationsForHost(hostEmail) {
    const res = await pool.query(
      `SELECT data FROM conversations WHERE host_email = $1 ORDER BY (data->>'updatedAt') DESC`,
      [hostEmail]
    );
    return res.rows.map((r) => r.data);
  },

  async getConversationsForCook(cookId) {
    const res = await pool.query(
      `SELECT data FROM conversations WHERE cook_id = $1 ORDER BY (data->>'updatedAt') DESC`,
      [Number(cookId)]
    );
    return res.rows.map((r) => r.data);
  },

  async findReviewByBookingAndRater(bookingId, raterRole) {
    const res = await pool.query(
      'SELECT data FROM reviews WHERE booking_id = $1 AND rater_role = $2',
      [Number(bookingId), raterRole]
    );
    return res.rows[0] ? res.rows[0].data : null;
  },

  async createReview(data) {
    const id = Date.now();
    const review = {
      id,
      bookingId: data.bookingId,
      raterRole: data.raterRole,
      cookId: data.cookId,
      hostEmail: data.hostEmail,
      rating: data.rating,
      comment: data.comment || '',
      createdAt: new Date().toISOString(),
    };
    await pool.query(
      'INSERT INTO reviews (id, booking_id, rater_role, data) VALUES ($1,$2,$3,$4)',
      [id, review.bookingId, review.raterRole, JSON.stringify(review)]
    );
    return review;
  },

  async getReviewsForCook(cookId) {
    const res = await pool.query(
      `SELECT data FROM reviews WHERE (data->>'cookId')::bigint = $1 AND rater_role = 'host' ORDER BY (data->>'createdAt') DESC`,
      [Number(cookId)]
    );
    return res.rows.map((r) => r.data);
  },

  async getReviewsForHost(hostEmail) {
    const res = await pool.query(
      `SELECT data FROM reviews WHERE data->>'hostEmail' = $1 AND rater_role = 'cook' ORDER BY (data->>'createdAt') DESC`,
      [hostEmail]
    );
    return res.rows.map((r) => r.data);
  },

  async createLandingSignup(data) {
    const id = Date.now();
    const signup = {
      id,
      email: data.email,
      role: data.role === 'cook' ? 'cook' : 'host',
      answers: data.answers || {},
      createdAt: new Date().toISOString(),
    };
    await pool.query(
      'INSERT INTO landing_signups (id, email, data) VALUES ($1,$2,$3)',
      [id, signup.email, JSON.stringify(signup)]
    );
    return signup;
  },

  async getAllLandingSignups() {
    const res = await pool.query('SELECT data FROM landing_signups ORDER BY id DESC');
    return res.rows.map((r) => r.data);
  },

  /**
   * ============================================================================
   * ABONNEMENTS BATCH COOKING
   * ============================================================================
   * Un abonnement = un jour de semaine + un créneau horaire récurrent, chez un
   * cuisinier donné, pour un hôte donné. Distinct de `bookings` (offre
   * événementielle ponctuelle, conservée en option secondaire sur la plateforme).
   *
   * Prix stocké en deux lignes séparées et transparentes (jamais fusionnées) :
   * - cookPrice : la prestation du cuisinier, éligible au crédit d'impôt CESU
   * - serviceFee : les frais de service At'Chef (10%), non éligibles
   */
  async createSubscription(data) {
    const id = Date.now();
    const cookPrice = Number(data.cookPrice);
    const serviceFee = Math.round(cookPrice * 0.10 * 100) / 100;
    const subscription = {
      id,
      cookId: Number(data.cookId),
      hostEmail: data.hostEmail,
      dayOfWeek: data.dayOfWeek, // 'lundi', 'mardi', ...
      startTime: data.startTime, // '09:00'
      endTime: data.endTime,     // '12:00'
      cookPrice,
      serviceFee,
      totalPrice: Math.round((cookPrice + serviceFee) * 100) / 100,
      status: 'active', // 'active' | 'paused' | 'cancelled'
      skippedWeeks: [], // dates (lundi de la semaine) où l'hôte a reporté/sauté
      startDate: data.startDate,
      createdAt: new Date().toISOString(),
    };
    await pool.query(
      'INSERT INTO subscriptions (id, cook_id, host_email, data) VALUES ($1,$2,$3,$4)',
      [id, subscription.cookId, subscription.hostEmail, JSON.stringify(subscription)]
    );
    return subscription;
  },

  async findSubscriptionById(id) {
    const res = await pool.query('SELECT data FROM subscriptions WHERE id = $1', [Number(id)]);
    return res.rows[0] ? res.rows[0].data : null;
  },

  async updateSubscription(id, patch) {
    const current = await this.findSubscriptionById(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query('UPDATE subscriptions SET data = $1 WHERE id = $2', [JSON.stringify(updated), Number(id)]);
    return updated;
  },

  async getSubscriptionsForHost(hostEmail) {
    const res = await pool.query(
      `SELECT data FROM subscriptions WHERE host_email = $1 ORDER BY id DESC`,
      [hostEmail]
    );
    return res.rows.map((r) => r.data);
  },

  async getSubscriptionsForCook(cookId) {
    const res = await pool.query(
      `SELECT data FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC`,
      [Number(cookId)]
    );
    return res.rows.map((r) => r.data);
  },

  async getAllSubscriptions() {
    const res = await pool.query('SELECT data FROM subscriptions ORDER BY id DESC');
    return res.rows.map((r) => r.data);
  },
};
