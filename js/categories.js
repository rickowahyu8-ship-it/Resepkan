// categories.js
// Tanggung jawab: definisi kategori shortcut (Makanan, Mie, Dessert, Minuman,
// Pastry, Sehat) dan filter resep berdasarkan kategori tersebut.
//
// Catatan data: database hanya punya 4 nilai `category` asli
// (makanan_utama, makanan_pembuka, kue_camilan, minuman). Kategori shortcut
// di UI TIDAK mengubah database -- tiap kategori dipetakan ke field yang
// sudah ada (`category`, `title`, `ingredientsCore`) lewat aturan `match` di
// bawah. Satu resep boleh masuk lebih dari satu kategori (mis. Mie Ayam ada
// di "Makanan" dan "Mie"), tapi di dalam SATU kategori tidak pernah dobel.

import { getAllRecipes, normalizeTitle, removeDuplicateRecipes } from './recipes.js';

const titleOf = (r) => r.titleKey || normalizeTitle(r.title);
const hasIngredient = (r, pattern) => (r.ingredientsCore || []).some((t) => pattern.test(t));

const MIE_TITLE = /\b(mie|mi|bakmi|bihun|kwetiau|kwetiaw|soun|laksa|spaghetti|pasta|ramen|udon)\b/;
const MIE_INGREDIENT = /^(mie|mi|bakmi|bihun|kwetiau|kwetiaw|soun)\b/;

// Camilan gurih yang tidak termasuk dessert.
const SAVORY_SNACK_TITLE = /\b(risol|risoles|lumpia|combro|pastel|bakwan|tahu|tempe|keripik|emping)\b/;
const DESSERT_TITLE = /\b(kolak|puding|pudding|es campur|es teler|cendol|dawet|cincau|ronde|angsle|sekoteng|kopyor|podomoro|sagol|kacang merah|kacang hijau|bubur sumsum|klepon|srikaya|jenang|dodol|getuk|lupis|brownies|cake|es krim)\b/;

const PASTRY_TITLE = /\b(kue|lapis|bolu|roti|pastel|risol|risoles|lumpia|klapertart|tart|pie|bagea|wingko|martabak|donat|croissant|bika|serabi|ape|pancong|cubit|cucur|bangkit|lak lak)\b/;
const FLOUR_INGREDIENT = /tepung terigu/;

const HEALTHY_TITLE = /\b(plecing|pecel|gado gado|urap|lawar|sayur|sop|sup|tinutuan|rumpu rampe|serombotan|acar|rujak buah|pindang|kuah|pepes|bening|salad|ikan bakar|papeda|kohu kohu|wedang jahe|wedang uwuh|kelapa muda|jeruk peras|jamu)\b/;
const UNHEALTHY_TITLE = /\b(goreng|gulai|rendang|kari|babi|jengkol|balado|keripik)\b/;

/**
 * Daftar kategori shortcut. `color` wajib konsisten dengan desain
 * (dipakai sebagai CSS variable --cat-color pada kartu kategori).
 */
export const CATEGORY_DEFS = [
  {
    key: 'makanan',
    label: 'Makanan',
    icon: '🍛',
    color: '#E8B4B8', // Dusty Rose
    match: (r) => r.category === 'makanan_utama' || r.category === 'makanan_pembuka',
  },
  {
    key: 'mie',
    label: 'Mie',
    icon: '🍜',
    color: '#E8BFA8', // Soft Peach
    match: (r) => MIE_TITLE.test(titleOf(r)) || hasIngredient(r, MIE_INGREDIENT),
  },
  {
    key: 'dessert',
    label: 'Dessert',
    icon: '🍨',
    color: '#C8B8D8', // Soft Lavender
    match: (r) => {
      const t = titleOf(r);
      if (DESSERT_TITLE.test(t)) return true;
      return r.category === 'kue_camilan' && !SAVORY_SNACK_TITLE.test(t);
    },
  },
  {
    key: 'minuman',
    label: 'Minuman',
    icon: '🥤',
    color: '#AFC5CF', // Dusty Blue
    match: (r) => r.category === 'minuman',
  },
  {
    key: 'pastry',
    label: 'Pastry',
    icon: '🥐',
    color: '#D9C3A5', // Warm Beige
    match: (r) => {
      if (r.category === 'minuman') return false;
      if (PASTRY_TITLE.test(titleOf(r))) return true;
      return r.category === 'kue_camilan' && hasIngredient(r, FLOUR_INGREDIENT);
    },
  },
  {
    key: 'sehat',
    label: 'Sehat',
    icon: '🥗',
    color: '#B8C9B2', // Sage Green
    match: (r) => {
      const t = titleOf(r);
      return HEALTHY_TITLE.test(t) && !UNHEALTHY_TITLE.test(t);
    },
  },
];

/** Cari definisi kategori berdasarkan key ('makanan', 'mie', ...). */
export function getCategoryDef(key) {
  return CATEGORY_DEFS.find((c) => c.key === key) || null;
}

/**
 * Filter resep berdasarkan kategori shortcut.
 * key 'all' = seluruh resep (tombol "Lihat Semua").
 * Hasil selalu bebas duplikat & diurutkan A-Z supaya urutan pagination stabil.
 */
export function filterRecipesByCategory(key, recipes = getAllRecipes()) {
  const all = Array.isArray(recipes) ? recipes : [];
  const source = key === 'all'
    ? all
    : (() => {
      const def = getCategoryDef(key);
      return def ? all.filter(def.match) : [];
    })();

  // Dedup PER SUMBER: removeDuplicateRecipes membuang berdasarkan judul, jadi
  // tanpa pembatasan ini resep Supabase bisa hilang hanya karena ada resep
  // Hugging Face berjudul sama (aturan sama seperti pencarian, T04/T05).
  const hf = source.filter((r) => !r.source || r.source === 'huggingface');
  const others = source.filter((r) => r.source && r.source !== 'huggingface');

  return [...removeDuplicateRecipes(hf), ...others]
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'id'));
}

/** Jumlah resep per kategori, untuk label di kartu kategori. */
export function getCategoryCounts(recipes = getAllRecipes()) {
  const counts = {};
  for (const def of CATEGORY_DEFS) {
    counts[def.key] = filterRecipesByCategory(def.key, recipes).length;
  }
  counts.all = filterRecipesByCategory('all', recipes).length;
  return counts;
}

/** Kategori shortcut pertama yang cocok untuk sebuah resep (untuk warna/ikon placeholder). */
export function getPrimaryCategoryDef(recipe) {
  if (!recipe) return null;
  // Urutan prioritas: yang lebih spesifik dulu, baru yang umum.
  const priority = ['mie', 'minuman', 'pastry', 'dessert', 'sehat', 'makanan'];
  for (const key of priority) {
    const def = getCategoryDef(key);
    if (def && def.match(recipe)) return def;
  }
  return null;
}
