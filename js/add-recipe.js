// add-recipe.js
// Tanggung jawab: validasi + normalisasi data form Tambah Resep, pemeriksaan
// pengguna aktif, INSERT ke tabel `recipes` di Supabase, dan pemetaan error
// menjadi pesan berbahasa Indonesia.
//
// Batasan yang dijaga:
// - `user_id` HANYA diambil dari hasil supabase.auth.getUser(), tidak pernah
//   dari input form (tidak ada field user_id di form).
// - `ingredients`/`steps` dikirim sebagai array JavaScript (JSONB), bukan string.
// - Tidak menyentuh cache/dedup/normalisasi resep Hugging Face (js/recipes.js).
// - Detail teknis error hanya ke console; pengguna menerima pesan yang jelas.

import { supabase } from './supabase.js';
import { isSafeUrl } from './utils.js';
import { CATEGORY_DEFS } from './categories.js';

export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const ITEM_MAX_LENGTH = 300;

export const ERR_EMPTY_ITEMS = 'empty-items';
export const ERR_NOT_SIGNED_IN = 'not-signed-in';
export const ERR_UNAUTHORIZED = 'unauthorized';
export const ERR_INVALID_DATA = 'invalid-data';
export const ERR_NETWORK = 'network';
export const ERR_UNKNOWN = 'unknown';

// Nilai `category` asli yang dipakai aplikasi (lihat catatan di js/categories.js):
// makanan_utama, makanan_pembuka, kue_camilan, minuman.
const DATASET_CATEGORIES = [
  { value: 'makanan_utama', label: 'Makanan Utama' },
  { value: 'makanan_pembuka', label: 'Makanan Pembuka' },
  { value: 'kue_camilan', label: 'Kue & Camilan' },
  { value: 'minuman', label: 'Minuman' },
];

// Kategori shortcut di UI (Makanan, Mie, Dessert, ...) dipetakan ke kategori
// dataset yang paling dekat supaya filter kategori aplikasi tetap bekerja.
// Nilai ini turunan dari CATEGORY_DEFS -- tidak menambah kategori baru.
const SHORTCUT_CATEGORY_TARGET = {
  makanan: 'makanan_utama',
  mie: 'makanan_utama',
  dessert: 'kue_camilan',
  minuman: 'minuman',
  pastry: 'kue_camilan',
  sehat: 'makanan_pembuka',
};

export const CATEGORY_OPTIONS = (() => {
  const byValue = new Map(DATASET_CATEGORIES.map((c) => [c.value, c]));
  const seen = new Set();
  const options = [];
  for (const def of CATEGORY_DEFS) {
    const value = SHORTCUT_CATEGORY_TARGET[def.key] || 'makanan_utama';
    if (seen.has(value)) continue;
    seen.add(value);
    options.push(byValue.get(value));
  }
  DATASET_CATEGORIES.forEach((c) => {
    if (seen.has(c.value)) return;
    seen.add(c.value);
    options.push(c);
  });
  return options.filter(Boolean);
})();

const VALID_CATEGORY_VALUES = new Set(CATEGORY_OPTIONS.map((c) => c.value));

/** Rapikan spasi berulang + trim. Non-string -> ''. */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Bersihkan array item (bahan/langkah): buang non-string, trim, buang kosong.
 * Urutan dipertahankan. Sumber non-array -> [].
 */
export function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Validasi + normalisasi data form.
 * @returns {{ ok: true, data: object } | { ok: false, message: string }}
 */
export function validateRecipeInput({ title, category, description, ingredients, steps, imageUrl } = {}) {
  const cleanTitle = cleanText(title);
  if (!cleanTitle) return { ok: false, message: 'Nama resep wajib diisi.' };
  if (cleanTitle.length > TITLE_MAX_LENGTH) {
    return { ok: false, message: `Nama resep maksimal ${TITLE_MAX_LENGTH} karakter.` };
  }

  const cleanCategory = typeof category === 'string' ? category.trim() : '';
  if (!cleanCategory) return { ok: false, message: 'Kategori resep wajib dipilih.' };
  if (!VALID_CATEGORY_VALUES.has(cleanCategory)) {
    return { ok: false, message: 'Kategori resep tidak dikenal. Silakan pilih kategori dari daftar.' };
  }

  const rawDescription = typeof description === 'string' ? description.trim() : '';
  if (rawDescription.length > DESCRIPTION_MAX_LENGTH) {
    return { ok: false, message: `Deskripsi maksimal ${DESCRIPTION_MAX_LENGTH} karakter.` };
  }

  const cleanIngredients = cleanItems(ingredients);
  if (cleanIngredients.length === 0) {
    return { ok: false, message: 'Tambahkan minimal satu bahan.' };
  }
  if (cleanIngredients.some((item) => item.length > ITEM_MAX_LENGTH)) {
    return { ok: false, message: `Setiap bahan maksimal ${ITEM_MAX_LENGTH} karakter.` };
  }

  const cleanSteps = cleanItems(steps);
  if (cleanSteps.length === 0) {
    return { ok: false, message: 'Tambahkan minimal satu langkah memasak.' };
  }
  if (cleanSteps.some((item) => item.length > ITEM_MAX_LENGTH)) {
    return { ok: false, message: `Setiap langkah maksimal ${ITEM_MAX_LENGTH} karakter.` };
  }

  const cleanImage = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (cleanImage && !isSafeUrl(cleanImage)) {
    return { ok: false, message: 'URL gambar tidak valid. Gunakan tautan yang diawali http:// atau https://.' };
  }

  return {
    ok: true,
    data: {
      title: cleanTitle,
      category: cleanCategory,
      description: rawDescription,
      ingredients: cleanIngredients,
      steps: cleanSteps,
      imageUrl: cleanImage || null,
    },
  };
}

const NETWORK_ERROR_PATTERN = /fetch|network|load failed|timed out|failed to connect|abort/i;

/**
 * Petakan error Supabase/Auth menjadi pesan Indonesia untuk pengguna.
 * Penyebab asli tetap dicatat ke console.
 */
function describeInsertError(error) {
  console.warn('[add-recipe] Gagal menyimpan resep:', {
    code: (error && error.code) || '',
    status: (error && error.status) || '',
    message: (error && error.message) || '',
  });

  const message = (error && error.message) || '';
  const code = String((error && error.code) || '');
  const status = Number(error && error.status);

  if (code === 'PGRST301' || /jwt|token.*expired|session.*(missing|not found)/i.test(message)) {
    return { code: ERR_NOT_SIGNED_IN, message: 'Sesi kamu sudah berakhir. Silakan masuk kembali untuk menambahkan resep.' };
  }
  if (code === '42501' || /row-level security|permission denied|violates row-level/i.test(message)) {
    return { code: ERR_UNAUTHORIZED, message: 'Akunmu tidak memiliki izin untuk menyimpan resep.' };
  }
  if (
    code === '23502' || code === '23514' || code === '22P02' || code === '23503' || code === 'PGRST204'
    || /null value in column|violates (check|not-null|foreign key) constraint|invalid input syntax/i.test(message)
  ) {
    return { code: ERR_INVALID_DATA, message: 'Data resep belum lengkap atau tidak valid.' };
  }
  if (status === 401) {
    return { code: ERR_NOT_SIGNED_IN, message: 'Sesi kamu sudah berakhir. Silakan masuk kembali untuk menambahkan resep.' };
  }
  if (status === 403) {
    return { code: ERR_UNAUTHORIZED, message: 'Akunmu tidak memiliki izin untuk menyimpan resep.' };
  }
  if (NETWORK_ERROR_PATTERN.test(`${message} ${(error && error.name) || ''}`)) {
    return { code: ERR_NETWORK, message: 'Tidak dapat terhubung ke server. Periksa koneksi internet dan coba lagi.' };
  }
  return { code: ERR_UNKNOWN, message: 'Resep belum berhasil disimpan. Silakan coba lagi.' };
}
/**
 * Simpan resep baru ke Supabase.
 * @param {{ title, category, description, ingredients, steps, imageUrl }} input
 * @returns {Promise<{ ok: true, recipe: object } | { ok: false, code: string, message: string }>}
 */
export async function saveRecipe(input) {
  const validated = validateRecipeInput(input);
  if (!validated.ok) {
    return { ok: false, code: ERR_INVALID_DATA, message: validated.message };
  }

  // Sesi diverifikasi ke server (getUser), bukan hanya dari localStorage.
  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.warn('[add-recipe] Pemeriksaan sesi gagal:', {
        code: error.code || '',
        message: error.message || '',
      });
      if (!error.status || NETWORK_ERROR_PATTERN.test(`${error.message || ''} ${error.name || ''}`)) {
        return {
          ok: false,
          code: ERR_NETWORK,
          message: 'Tidak dapat terhubung ke server. Periksa koneksi internet dan coba lagi.',
        };
      }
      return {
        ok: false,
        code: ERR_NOT_SIGNED_IN,
        message: 'Sesi kamu sudah berakhir. Silakan masuk kembali untuk menambahkan resep.',
      };
    }
    user = data && data.user ? data.user : null;
  } catch (err) {
    console.warn('[add-recipe] Pemeriksaan sesi error:', (err && err.message) || err);
    return {
      ok: false,
      code: ERR_NETWORK,
      message: 'Tidak dapat terhubung ke server. Periksa koneksi internet dan coba lagi.',
    };
  }

  if (!user || !user.id) {
    return {
      ok: false,
      code: ERR_NOT_SIGNED_IN,
      message: 'Silakan masuk terlebih dahulu untuk menambahkan resep.',
    };
  }

  const { data: recipeInput } = validated;
  const payload = {
    user_id: user.id, // identitas pemilik dari sesi, bukan dari form
    title: recipeInput.title,
    category: recipeInput.category,
    description: recipeInput.description,
    ingredients: recipeInput.ingredients, // array JS -> JSONB
    steps: recipeInput.steps,             // array JS -> JSONB
    image_url: recipeInput.imageUrl,
    status: 'approved',
  };

  try {
    const { data, error } = await supabase
      .from('recipes')
      .insert(payload)
      .select('id, title, status, created_at')
      .single();

    if (error) return { ok: false, ...describeInsertError(error) };

    if (!data) {
      console.warn('[add-recipe] INSERT tidak mengembalikan baris hasil.');
      return { ok: false, code: ERR_UNKNOWN, message: 'Resep belum berhasil disimpan. Silakan coba lagi.' };
    }
    if (data.status !== 'approved') {
      console.warn('[add-recipe] Status hasil INSERT tidak sesuai:', data.status);
      return {
        ok: false,
        code: ERR_UNKNOWN,
        message: 'Resep tersimpan tetapi belum dapat dipublikasikan. Silakan hubungi admin.',
      };
    }

    return { ok: true, recipe: data };
  } catch (err) {
    console.warn('[add-recipe] INSERT gagal:', (err && err.message) || err);
    return {
      ok: false,
      code: ERR_NETWORK,
      message: 'Tidak dapat terhubung ke server. Periksa koneksi internet dan coba lagi.',
    };
  }
}
