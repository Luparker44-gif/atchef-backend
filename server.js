require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./data/mockDb');

const connectRoutes = require('./routes/connect');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');
const identityRoutes = require('./routes/identity');
const authRoutes = require('./routes/auth');
const geoRoutes = require('./routes/geo');
const stripeWebhookRoutes = require('./webhooks/stripeWebhook');

const app = express();

// CORS : autorise votre frontend (l'Artifact, une fois hébergé sur un vrai
// domaine) à appeler cette API depuis une origine différente. En
// production, remplacez la valeur par défaut par votre domaine exact
// (ex. 'https://atchef.fr') plutôt que de l'ouvrir à tout le monde.
// ⚠️ PHASE DE TEST/DÉMO : on autorise toutes les origines pour éviter les
// blocages liés à une correspondance exacte d'adresse (protocole, barre
// oblique finale, etc.). Avant un vrai lancement public, remplacez cette
// ligne par : cors({ origin: process.env.APP_URL }) avec votre vraie URL,
// pour ne plus autoriser que votre propre site.
app.use(cors());

// ⚠️ ORDRE CRITIQUE DES MIDDLEWARES ⚠️
// Le webhook Stripe a besoin du corps de requête BRUT (un Buffer non
// modifié) pour pouvoir vérifier sa signature cryptographique. On monte
// donc ses routes AVANT express.json() global : sinon, ce dernier aurait
// déjà transformé le corps en objet JavaScript et la vérification de
// signature échouerait systématiquement.
app.use('/api', stripeWebhookRoutes);

// Pour toutes les AUTRES routes, le JSON classique peut être parsé normalement.
app.use(express.json());
app.use('/api', connectRoutes);
app.use('/api', checkoutRoutes);
app.use('/api', adminRoutes);
app.use('/api', identityRoutes);
app.use('/api', authRoutes);
app.use('/api', geoRoutes);

app.get('/', (req, res) => {
  res.send("API At'Chef — paiements marketplace via Stripe Connect (Express).");
});

const PORT = process.env.PORT || 4242;

// On initialise la base de données (création des tables si elles
// n'existent pas encore, insertion des cuisiniers de démo) AVANT
// d'accepter la moindre requête HTTP. Si la connexion à la base échoue
// (mauvais DATABASE_URL, base injoignable...), le serveur s'arrête
// immédiatement avec un message clair plutôt que de tourner "à moitié".
db.initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Serveur At'Chef démarré sur http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Impossible de se connecter à la base de données (vérifiez DATABASE_URL) :', err.message);
    process.exit(1);
  });

module.exports = app;
