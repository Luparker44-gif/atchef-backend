/**
 * ============================================================================
 * BASE DE DONNÉES — PostgreSQL réel (remplace l'ancienne version en mémoire)
 * ============================================================================
 * ⚠️ Ce fichier s'appelle toujours "mockDb.js" pour que routes/ et webhooks/
 * n'aient RIEN à changer (ils font tous `require('../data/mockDb')`), mais
 * il ne s'agit plus d'un mock : chaque fonction interroge une vraie base
 * PostgreSQL via la variable d'environnement DATABASE_URL. Les données
 * survivent désormais aux redémarrages du serveur.
 *
 * Choix de conception : chaque table a quelques colonnes "en dur" utiles
 * pour la recherche (id, email, stripeAccountId...) + une colonne JSONB
 * `data` qui contient l'objet complet. Ça évite d'avoir à lister et migrer
 * une colonne SQL par champ (formulas, discountTiers, tags...), au prix
 * d'un peu moins d'optimisation — largement suffisant à l'échelle d'un MVP.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // La plupart des fournisseurs hébergés (Supabase, Render Postgres...)
  // exigent une connexion SSL, avec un certificat non reconnu par défaut
  // par Node — sans cette option, la connexion échoue.
  ssl: { rejectUnauthorized: false },
});

const CUISINE_TYPES = ['Française & Bistrot', 'Italienne', 'Orientale & Méditerranéenne', 'Asiatique', 'Végétarienne & Vegan', 'Pâtisserie & Desserts'];

const NEW_COOK_GRADIENTS = [
  'linear-gradient(135deg,#E2725B,#A64A34)',
  'linear-gradient(135deg,#8CA888,#4F6B4C)',
  'linear-gradient(135deg,#D9A441,#A64A34)',
  'linear-gradient(135deg,#E2725B,#7A3524)',
];

/**
 * Crée les tables si elles n'existent pas encore, et insère les cuisiniers
 * de démonstration (Amélie, Karim) UNE SEULE FOIS. Appelée une fois au
 * démarrage du serveur (voir server.js), avant d'accepter des requêtes.
 */
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
      status: 'ouvert',
      adminNote: '',
      createdAt: new Date().toISOString(),
    };
    await pool.query('INSERT INTO tickets (id, data) VALUES ($1,$2)', [id, JSON.stringify(ticket)]);
    return ticket;
  },

  async getAllTickets() {
    const res = await pool.query('SELECT data FROM tickets ORDER BY id DESC');
    return res.rows.map((r) => r.data);
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

  async updateHost(email, patch) {
    const current = await this.findHostByEmail(email);
    if (!current) return null;
    const updated = { ...current, ...patch };
    await pool.query('UPDATE hosts SET data = $1 WHERE email = $2', [JSON.stringify(updated), email]);
    return updated;
  },
};
