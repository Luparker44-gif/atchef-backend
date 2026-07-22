/**
 * ============================================================================
 * SERVICE EMAIL — Resend
 * ============================================================================
 * Centralise tous les emails automatiques d'At'Chef : confirmation de
 * réservation (hôte + cuisinier) et réinitialisation de mot de passe.
 *
 * ⚠️ Chaque fonction est volontairement "silencieuse" en cas d'échec
 * (attrape l'erreur, la logge, ne la relance jamais) : un email qui ne
 * part pas ne doit JAMAIS faire échouer une réservation déjà payée ou une
 * inscription déjà réussie. C'est une notification, pas une étape critique.
 *
 * Configuration nécessaire (variables d'environnement) :
 * - RESEND_API_KEY : clé API de votre compte Resend (resend.com)
 * - EMAIL_FROM : adresse d'expédition. Tant que vous n'avez pas encore
 *   vérifié votre propre domaine sur Resend, utilisez la valeur par défaut
 *   'onboarding@resend.dev' (fournie par Resend pour démarrer sans
 *   configuration DNS). Une fois votre nom de domaine réel en place,
 *   remplacez par ex. par 'reservations@atchef.fr'.
 */

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || "At'Chef <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

async function safeSend(payload, label) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`⚠️ RESEND_API_KEY absente : email "${label}" non envoyé (fonctionnement normal si vous n'avez pas encore configuré Resend).`);
    return;
  }
  try {
    await resend.emails.send(payload);
    console.log(`✅ Email envoyé : ${label} → ${payload.to}`);
  } catch (err) {
    console.error(`❌ Échec envoi email "${label}" :`, err.message);
  }
}

/** Envoyée à l'HÔTE dès que son paiement est confirmé (webhook checkout.session.completed). */
async function sendBookingConfirmationToHost(booking, cook) {
  await safeSend({
    from: FROM_EMAIL,
    to: booking.hostEmail,
    subject: `Réservation confirmée avec ${cook.name} 🎉`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#A64A34;">Votre réservation est confirmée !</h2>
        <p>Bonjour,</p>
        <p>Votre réservation avec <strong>${cook.name}</strong> est bien confirmée et payée.</p>
        <ul>
          <li><strong>Formule :</strong> ${booking.formulaName || '—'}</li>
          <li><strong>Date :</strong> ${booking.eventDate || 'à confirmer avec le cuisinier'}</li>
          <li><strong>Convives :</strong> ${booking.guestCount}</li>
        </ul>
        <p>Le cuisinier a été notifié et se prépare à vous régaler.</p>
        <p style="color:#6b6b6b;font-size:0.85em;margin-top:24px;">
          Besoin d'annuler ? Rendez-vous dans "Mon espace" sur At'Chef.
        </p>
      </div>
    `,
  }, 'confirmation réservation (hôte)');
}

/** Envoyée au CUISINIER dès qu'une réservation chez lui est payée. */
async function sendBookingConfirmationToCook(booking, cook) {
  if (!cook.email) return;
  await safeSend({
    from: FROM_EMAIL,
    to: cook.email,
    subject: 'Nouvelle réservation payée 🎉',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#A64A34;">Vous avez une nouvelle réservation !</h2>
        <p>Bonjour ${cook.name},</p>
        <p>Une réservation vient d'être payée sur votre profil At'Chef.</p>
        <ul>
          <li><strong>Formule :</strong> ${booking.formulaName || '—'}</li>
          <li><strong>Date :</strong> ${booking.eventDate || 'non précisée'}</li>
          <li><strong>Convives :</strong> ${booking.guestCount}</li>
          <li><strong>Allergies signalées :</strong> ${booking.allergies || 'aucune'}</li>
        </ul>
        <p>Votre part a été automatiquement transférée sur votre compte Stripe.</p>
      </div>
    `,
  }, 'confirmation réservation (cuisinier)');
}

/** Envoyée quand un hôte ou cuisinier demande à réinitialiser son mot de passe. */
async function sendPasswordResetEmail(email, resetToken) {
  const resetLink = `${APP_URL}/?resetToken=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(email)}`;
  await safeSend({
    from: FROM_EMAIL,
    to: email,
    subject: 'Réinitialisation de votre mot de passe At\'Chef',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#A64A34;">Réinitialisation de mot de passe</h2>
        <p>Vous avez demandé à réinitialiser votre mot de passe At'Chef.</p>
        <p><a href="${resetLink}" style="background:#A64A34;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Choisir un nouveau mot de passe</a></p>
        <p style="color:#6b6b6b;font-size:0.85em;">Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>
      </div>
    `,
  }, 'réinitialisation mot de passe');
}

module.exports = {
  sendBookingConfirmationToHost,
  sendBookingConfirmationToCook,
  sendPasswordResetEmail,
};
