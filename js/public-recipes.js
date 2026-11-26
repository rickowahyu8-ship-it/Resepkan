// public-recipes.js
// Tanggung jawab: menggabungkan resep publik dari DUA sumber
//   1. Hugging Face (via js/recipes.js) -- ID numerik, source: 'huggingface'
//   2. Supabase tabel `recipes` status 'approved' -- ID UUID, source: 'supabase'
//
// Batasan yang dijaga:
// - Identitas sumber TIDAK dihilangkan: setiap objek membawa `source` dan
//   `sourceId`. `id` tetap seperti aslinya (number untuk HF, string UUID untuk
//   Supabase) sehingga UUID tidak pernah diubah menjadi angka.
// - `recipesCache` (js/recipes.js) tidak diubah isinya; Supabase disimpan di
//   daftar terpisah di modul ini.
// - Kegagalan salah satu sumber tidak menjatuhkan sumber lain.
// - Hanya satu permintaan Supabase per siklus muat (tidak memuat berulang).
// - Deduplikasi lintas sumber TIDAK dilakukan (judul sama di dua sumber tetap
//   tampil sebagai dua resep berbeda karena sumbernya berbeda).

import { supabase } from './supabase.js';
import { normalizeTitle } from './recipes.js';

export const SOURCE_HF = 'huggingface';
export const SOURCE_SUPABASE = 'supabase';

/** Kunci identitas gabungan: sumber + id asli (UUID tetap string). */
export function recipeKey(recipe) {
  if (!recipe) return '';
  const source = recipe.source || SOURCE_HF;
  return `${source}:${String(recipe.id)}`;
}

// ---------------------------------------------------------------------------
// Supabase: resep publik (status approved)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000; // batas aman per permintaan PostgREST
const PUBLIC_SELECT =
  'id, user_id, title, category, description, ingredients, steps, image_url, status, created_at, updated_at';

let supabasePublicCache = null; // array resep publik (sudah dinormalisasi)
let supabasePublicPromise = null; // permintaan yang sedang berjalan
let supabasePublicError = null;  // error terakhir (untuk status UI, tidak fatal)

function cleanTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * Ubah satu baris Supabase menjadi bentuk yang SAMA dengan resep Hugging Face
 * (title, titleKey, category, ingredientsFull, ingredientsCore, stepsFull, ...)
 * supaya generator/kategori/detail bisa memakainya tanpa perubahan khusus.
 * Hanya baris berstatus approved dan ber-UUID yang diterima.
 */
export function normalizeSupabaseRecipe(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  if (String(row.status || '').trim().toLowerCase() !== 'approved') return null;

  const ingredientsFull = cleanTextArray(row.ingredients);
  const stepsFull = cleanTextArray(row.steps);
  const title = (typeof row.title === 'string' ? row.title.trim().replace(/\s+/g, ' ') : '') || 'Resep Tanpa Nama';

  return {
    // Sama seperti normalizeRecipe(): ingredientsCore dipakai generator & filter.
    id,                                   // UUID tetap sebagai string
    source: SOURCE_SUPABASE,
    sourceId: id,
    userId: typeof row.user_id === 'string' ? row.user_id : '',
    title,
    titleCleaned: title.toLowerCase(),
    titleKey: normalizeTitle(title),      // kunci sama dengan resep Hugging Face
    image: typeof row.image_url === 'string' ? row.image_url : '',
    category: (typeof row.category === 'string' ? row.category.trim().toLowerCase() : '') || 'lainnya',
    description: typeof row.description === 'string' ? row.description.trim() : '',
    ingredientsFull,
    ingredientsCore: ingredientsFull.flatMap(extractCoreIngredient),
    stepsFull,
    loves: 0,
    url: '',
    difficulty: '',
    timeMinutes: null,
    region: '',
    totalIngredients: ingredientsFull.length,
    totalSteps: stepsFull.length,
    status: 'approved',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

/** Inti kata bahan, sama pendekatannya dengan js/recipes.js (heuristik ringkas). */
function extractCoreIngredient(text) {
  if (!text) return [];
  const parenPattern = /\([^)]*\)/g;
  const unitPattern = /^\s*\d+(\/\d+|[.,]\d+)?\s*(gram|kg|ml|liter|sdm|sdt|sendok\s+makan|sendok\s+teh|sendok|gelas|butir|buah|batang|lembar|siung|cm|ekor|potong|ruas|bungkus|papan|helai|ikat|genggam|biji|iris|ons)?\s*/i;
  const clean = (s) => s.replace(parenPattern, '').replace(unitPattern, '').trim().toLowerCase();
  const colonIndex = text.indexOf(':');
  if (colonIndex !== -1 && colonIndex < 20) {
    return text.slice(colonIndex + 1).split(',').map(clean).filter(Boolean);
  }
  const core = clean(text.split(',')[0]);
  return core ? [core] : [];
}

async function fetchApprovedPage(from, to) {
  const { data, error } = await supabase
    .from('recipes')
    .select(PUBLIC_SELECT)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * Muat resep publik Supabase SATU KALI (cache di modul ini).
 * Tidak pernah melempar: kegagalan dikembalikan sebagai { ok:false } agar
 * resep Hugging Face tetap bisa tampil.
 */
export async function loadSupabasePublicRecipes({ force = false } = {}) {
  if (!force && supabasePublicCache) return { ok: true, recipes: supabasePublicCache, cached: true };
  if (!force && supabasePublicPromise) return supabasePublicPromise;

  const run = (async () => {
    try {
      const rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const page = await fetchApprovedPage(from, from + PAGE_SIZE - 1);
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
        if (from > 100000) break; // pengaman tak terhingga
      }
      const recipes = rows.map(normalizeSupabaseRecipe).filter(Boolean);
      supabasePublicCache = recipes;
      supabasePublicError = null;
      return { ok: true, recipes };
    } catch (err) {
      // Sebagian besar penyebab: offline / RLS / tabel belum siap.
      console.warn('[public-recipes] Gagal memuat resep publik Supabase:', (err && err.message) || err);
      supabasePublicError = (err && err.message) || String(err);
      supabasePublicCache = null;
      return { ok: false, recipes: [], error: supabasePublicError };
    } finally {
      // Hanya lepaskan promise bila yang tersimpan masih promise milik run ini.
      if (supabasePublicPromise === run) supabasePublicPromise = null;
    }
  })();

  supabasePublicPromise = run;
  return run;
}

/** Error terakhir dari pemuatan Supabase (null bila sukses). */
export function getSupabasePublicError() {
  return supabasePublicError;
}

/** Ambil ulang dari server (dipakai setelah resep ditambah/diubah/dihapus). */
export async function refreshSupabasePublicRecipes() {
  supabasePublicCache = null;
  return loadSupabasePublicRecipes({ force: true });
}

/** Resep publik Supabase yang sudah dimuat (tanpa memicu permintaan baru). */
export function getSupabasePublicRecipes() {
  return supabasePublicCache || [];
}

/** Kosongkan cache (mis. saat logout). Tidak memuat ulang. */
export function clearSupabasePublicRecipes() {
  supabasePublicCache = null;
  supabasePublicError = null;
}

// ---------------------------------------------------------------------------
// Hugging Face: pembungkus tipis agar punya penanda sumber
// ---------------------------------------------------------------------------

/**
 * Tandai resep Hugging Face dengan `source`/`sourceId` tanpa mengubah id numerik.
 * Objek asli di recipesCache TIDAK dimutasi (dipakai modul lain); yang dikembalikan
 * adalah salinan ringan.
 */
export function withHuggingFaceSource(recipe) {
  if (!recipe) return null;
  if (recipe.source === SOURCE_HF) return recipe;
  return {
    ...recipe,
    source: SOURCE_HF,
    sourceId: recipe.id,
  };
}

/** Gabungkan daftar Hugging Face + daftar Supabase publik. */
export function mergePublicRecipes(hfRecipes, supabaseRecipes) {
  const hf = (Array.isArray(hfRecipes) ? hfRecipes : []).map(withHuggingFaceSource).filter(Boolean);
  const sb = (Array.isArray(supabaseRecipes) ? supabaseRecipes : []).filter(Boolean);
  return [...hf, ...sb];
}
