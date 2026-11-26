// my-recipes.js
// Tanggung jawab: mengambil daftar resep milik pengguna yang sedang login dari
// tabel Supabase `recipes`, lalu menormalkannya menjadi bentuk yang aman untuk UI.
//
// Batasan yang dijaga:
// - Identitas pengguna HANYA dari supabase.auth.getUser() (bukan DOM/input).
// - `user_id` tidak pernah diterima dari input pengguna; filter selalu memakai
//   user.id dari sesi, dan RLS tetap menjadi pertahanan utamanya di server.
// - ID resep Supabase adalah UUID -> dipertahankan sebagai STRING. Modul ini
//   tidak memakai normalizeRecipe()/getRecipeById() yang ditujukan untuk ID
//   numerik Hugging Face, dan tidak menyentuh recipesCache/js/recipes.js.
// - Tidak mengubah status `approved` maupun kolom apa pun (read-only).

import { supabase } from './supabase.js';
import { validateRecipeInput } from './add-recipe.js';

export const MY_ERR_NOT_SIGNED_IN = 'not-signed-in';
export const MY_ERR_NETWORK = 'network';
export const MY_ERR_UNKNOWN = 'unknown';

export const MY_RECIPE_SELECT =
  'id, title, category, description, ingredients, steps, image_url, status, created_at, updated_at';

const NETWORK_ERROR_PATTERN = /fetch|network|load failed|timed out|failed to connect|abort/i;

const MSG_NOT_SIGNED_IN = 'Silakan masuk terlebih dahulu untuk melihat resepmu.';
const MSG_NETWORK = 'Tidak dapat terhubung ke server. Periksa koneksi internet dan coba lagi.';
const MSG_UNKNOWN = 'Resepmu belum dapat dimuat. Silakan coba lagi.';

function isNetworkError(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status) return false; // server menjawab -> bukan kegagalan jaringan
  return NETWORK_ERROR_PATTERN.test(`${error.name || ''} ${error.message || ''}`);
}

/**
 * Ambil pengguna aktif (diverifikasi ke server, bukan dari localStorage).
 * @returns {Promise<{ user: object } | { user: null, code: string, message: string }>}
 */
export async function getActiveUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.warn('[my-recipes] Pemeriksaan sesi gagal:', {
        code: error.code || '',
        message: error.message || '',
      });
      if (isNetworkError(error)) return { user: null, code: MY_ERR_NETWORK, message: MSG_NETWORK };
      return { user: null, code: MY_ERR_NOT_SIGNED_IN, message: MSG_NOT_SIGNED_IN };
    }
    const user = data && data.user ? data.user : null;
    if (!user || !user.id) return { user: null, code: MY_ERR_NOT_SIGNED_IN, message: MSG_NOT_SIGNED_IN };
    return { user };
  } catch (err) {
    console.warn('[my-recipes] Pemeriksaan sesi error:', (err && err.message) || err);
    return { user: null, code: MY_ERR_NETWORK, message: MSG_NETWORK };
  }
}

/** String aman untuk dirender (non-string -> ''). */
function asText(value) {
  return typeof value === 'string' ? value : '';
}

/** Array string ter-trim; elemen non-string/kosong dibuang. */
function asTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Ubah satu baris Supabase menjadi bentuk tampilan.
 * Baris tanpa UUID string ditolak (return null) supaya renderer tidak pernah
 * menerima `data-id` kosong.
 */
export function normalizeMyRecipe(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;

  const ingredientsFull = asTextArray(row.ingredients);
  const stepsFull = asTextArray(row.steps);

  return {
    id,                                    // UUID sebagai string -- bukan Number
    title: asText(row.title).trim().replace(/\s+/g, ' ') || 'Resep Tanpa Nama',
    category: asText(row.category).trim().toLowerCase() || 'lainnya',
    description: asText(row.description).trim(),
    ingredientsFull,
    stepsFull,
    imageUrl: asText(row.image_url).trim(),
    status: asText(row.status).trim(),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

/**
 * Ambil seluruh resep milik pengguna aktif.
 * @returns {Promise<
 *   { ok: true, recipes: object[] } |
 *   { ok: false, code: string, message: string }
 * >}
 */
export async function fetchMyRecipes() {
  return runQuery(null);
}

/**
 * Inti pengambilan data; `onlyId` (opsional) membatasi ke satu resep.
 */
async function runQuery(onlyId) {
  const auth = await getActiveUser();
  if (!auth.user) return { ok: false, code: auth.code, message: auth.message };
  const user = auth.user;

  try {
    // Query PostgREST bersifat "thenable" (bukan Promise bawaan): `await` langsung
    // pada builder mengeksekusi query dan me-resolve ke { data, error }.
    let query = supabase
      .from('recipes')
      .select(MY_RECIPE_SELECT)
      .eq('user_id', user.id); // dari sesi, bukan input; RLS tetap penjaga utama
    if (onlyId) query = query.eq('id', onlyId);
    else query = query.order('created_at', { ascending: false });
    const { data, error } = await query;

    if (error) {
      console.warn('[my-recipes] Query resep gagal:', {
        code: error.code || '',
        status: error.status || '',
        message: error.message || '',
      });
      if (isNetworkError(error)) return { ok: false, code: MY_ERR_NETWORK, message: MSG_NETWORK };
      if (Number(error.status) === 401 || error.code === 'PGRST301') {
        return { ok: false, code: MY_ERR_NOT_SIGNED_IN, message: MSG_NOT_SIGNED_IN };
      }
      return { ok: false, code: MY_ERR_UNKNOWN, message: MSG_UNKNOWN };
    }

    const rows = Array.isArray(data) ? data : [];
    const recipes = rows.map(normalizeMyRecipe).filter(Boolean);
    if (rows.length && recipes.length < rows.length) {
      console.warn(`[my-recipes] ${rows.length - recipes.length} baris tanpa UUID valid diabaikan.`);
    }
    return { ok: true, recipes };
  } catch (err) {
    console.warn('[my-recipes] Query resep error:', (err && err.message) || err);
    return { ok: false, code: MY_ERR_NETWORK, message: MSG_NETWORK };
  }
}

const MSG_EDIT_FAILED = 'Resep belum berhasil diperbarui. Silakan coba lagi.';
const MSG_DELETE_FAILED = 'Resep belum berhasil dihapus. Silakan coba lagi.';

/** Pesan error untuk operasi tulis (update/delete) berdasarkan kode/status Supabase. */
function describeWriteError(error, fallbackMessage) {
  console.warn('[my-recipes] Operasi resep gagal:', {
    code: (error && error.code) || '',
    status: (error && error.status) || '',
    message: (error && error.message) || '',
  });
  if (isNetworkError(error)) return { code: MY_ERR_NETWORK, message: MSG_NETWORK };
  if (Number(error && error.status) === 401 || (error && error.code) === 'PGRST301') {
    return { code: MY_ERR_NOT_SIGNED_IN, message: MSG_NOT_SIGNED_IN };
  }
  if ((error && error.code) === '42501' || /row-level security|permission denied/i.test((error && error.message) || '')) {
    return { code: MY_ERR_UNKNOWN, message: 'Akunmu tidak memiliki izin untuk mengubah resep ini.' };
  }
  if (['23502', '23514', '22P02', '23503', 'PGRST204'].includes((error && error.code) || '')) {
    return { code: MY_ERR_UNKNOWN, message: 'Data resep belum lengkap atau tidak valid.' };
  }
  return { code: MY_ERR_UNKNOWN, message: fallbackMessage };
}

/**
 * Perbarui resep milik pengguna aktif.
 * Hanya kolom konten yang dikirim; `user_id`, `status`, `created_at`, `id` tidak disentuh.
 * @param {string} id UUID resep
 * @param {{ title, category, description, ingredients, steps, imageUrl }} input
 */
export async function updateRecipe(id, input) {
  const recipeId = typeof id === 'string' ? id.trim() : '';
  if (!recipeId) {
    return { ok: false, code: MY_ERR_UNKNOWN, message: MSG_EDIT_FAILED };
  }

  // Aturan validasi sama dengan Tambah Resep (satu sumber aturan).
  const validated = validateRecipeInput(input);
  if (!validated.ok) return { ok: false, code: MY_ERR_UNKNOWN, message: validated.message };

  const auth = await getActiveUser();
  if (!auth.user) return { ok: false, code: auth.code, message: auth.message };

  const d = validated.data;
  const payload = {
    title: d.title,
    category: d.category,
    description: d.description,
    ingredients: d.ingredients,
    steps: d.steps,
    image_url: d.imageUrl,
  };

  try {
    const { data, error } = await supabase
      .from('recipes')
      .update(payload)
      .eq('id', recipeId)
      .eq('user_id', auth.user.id) // kepemilikan; RLS tetap penjaga utama
      .select(MY_RECIPE_SELECT)
      .maybeSingle();

    if (error) return { ok: false, ...describeWriteError(error, MSG_EDIT_FAILED) };
    if (!data) {
      return { ok: false, code: MY_ERR_UNKNOWN, message: 'Resep tidak ditemukan atau bukan milik akunmu.' };
    }
    const recipe = normalizeMyRecipe(data);
    if (!recipe) return { ok: false, code: MY_ERR_UNKNOWN, message: MSG_EDIT_FAILED };
    return { ok: true, recipe };
  } catch (err) {
    console.warn('[my-recipes] Update resep error:', (err && err.message) || err);
    return { ok: false, code: MY_ERR_NETWORK, message: MSG_NETWORK };
  }
}

/**
 * Hapus resep milik pengguna aktif.
 * @param {string} id UUID resep
 */
export async function deleteRecipe(id) {
  const recipeId = typeof id === 'string' ? id.trim() : '';
  if (!recipeId) {
    return { ok: false, code: MY_ERR_UNKNOWN, message: MSG_DELETE_FAILED };
  }

  const auth = await getActiveUser();
  if (!auth.user) return { ok: false, code: auth.code, message: auth.message };

  try {
    const { data, error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', recipeId)
      .eq('user_id', auth.user.id) // kepemilikan; RLS tetap penjaga utama
      .select('id')
      .maybeSingle();

    if (error) return { ok: false, ...describeWriteError(error, MSG_DELETE_FAILED) };
    if (!data || !data.id) {
      return { ok: false, code: MY_ERR_UNKNOWN, message: 'Resep tidak ditemukan atau bukan milik akunmu.' };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.warn('[my-recipes] Hapus resep error:', (err && err.message) || err);
    return { ok: false, code: MY_ERR_NETWORK, message: MSG_NETWORK };
  }
}
