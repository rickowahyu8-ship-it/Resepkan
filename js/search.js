// search.js
// Tanggung jawab: pencarian resep berdasarkan NAMA (fitur "Cari Berdasarkan Nama").
// Pencarian berdasarkan bahan tetap ada di generator.js (findRecipesByIngredients).

import { getAllRecipes, normalizeTitle, removeDuplicateRecipes } from './recipes.js';

/**
 * Cari resep berdasarkan nama. Pencocokan memakai judul ternormalisasi,
 * jadi "  NASI   goreng" tetap menemukan "Nasi Goreng Spesial".
 *
 * Urutan relevansi:
 *   1. nama persis sama
 *   2. nama diawali kata kunci
 *   3. nama mengandung kata kunci utuh
 *   4. semua kata kunci ada di nama (urutan bebas)
 *
 * @returns {Array} daftar resep terurut relevansi, bebas duplikat
 */
export function findRecipeByName(query, recipes = getAllRecipes()) {
  const q = normalizeTitle(query);
  if (!q) return [];

  const words = q.split(' ');
  const scored = [];

  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    const title = recipe.titleKey || normalizeTitle(recipe.title);
    let score = 0;
    if (title === q) score = 4;
    else if (title.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    else if (words.every((w) => title.includes(w))) score = 1;

    if (score > 0) scored.push({ recipe, score, title });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.length - b.title.length ||
      a.recipe.title.localeCompare(b.recipe.title, 'id')
  );

  // Dedup PER SUMBER. removeDuplicateRecipes membuang berdasarkan judul, jadi
  // tanpa pembatasan ini resep Supabase bisa hilang hanya karena ada resep
  // Hugging Face berjudul sama (aturan sama seperti pencarian bahan, T04-AB).
  const items = scored.map((s) => s.recipe);
  const hf = items.filter((r) => !r.source || r.source === 'huggingface');
  const others = items.filter((r) => r.source && r.source !== 'huggingface');
  return [...removeDuplicateRecipes(hf), ...others];
}

/** true jika resep punya nama yang persis sama dengan query (setelah normalisasi). */
export function isExactNameMatch(recipe, query) {
  if (!recipe) return false;
  return (recipe.titleKey || normalizeTitle(recipe.title)) === normalizeTitle(query);
}
