const { createClient } = require('@supabase/supabase-js');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const BUCKET_NAME = 'dish-photos';

async function ensureBucketExists() {
  if (!supabase) {
    console.warn('⚠️ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents : l\'envoi de photos de plats sera indisponible (fonctionnement normal si non configuré).');
    return;
  }
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    const exists = buckets && buckets.some((b) => b.name === BUCKET_NAME);
    if (!exists) {
      const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
      });
      if (createError) throw createError;
      console.log(`✅ Bucket de stockage "${BUCKET_NAME}" créé.`);
    }
  } catch (err) {
    console.warn('⚠️ Impossible de vérifier/créer le bucket de stockage :', err.message);
  }
}

async function uploadDishPhoto(cookId, fileBuffer, mimeType, originalName) {
  if (!supabase) {
    throw new Error("L'envoi de photos n'est pas configuré côté serveur (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants)");
  }
  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${cookId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET_NAME).upload(path, fileBuffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { ensureBucketExists, uploadDishPhoto };
