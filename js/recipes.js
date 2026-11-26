// recipes.js
// Tanggung jawab: mengambil data resep dari Hugging Face Dataset API
// (bukan lagi data/resep.json), menormalisasi, cache di memory, dan
// menyediakan fungsi bantu untuk mengambil/mengurutkan data.

const API_BASE = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'LorthGyu/indonesian-recipes';
const PAGE_LENGTH = 100; // sesuai batas maksimal API per request

let recipesCache = null;
let loadPromise = null;

// Peta "ID yang dibuang karena duplikat" -> "ID resep yang dipertahankan".
// Dipakai getRecipeById supaya favorit lama yang terlanjur menyimpan ID
// duplikat tetap mengarah ke resep yang benar (tidak hilang).
const duplicateIdAlias = new Map();

// ==========================================================================
// ANTI-DUPLIKASI
// ==========================================================================

/**
 * Normalisasi nama resep untuk keperluan PERBANDINGAN (bukan tampilan):
 * lowercase, trim, rapikan spasi ganda, buang tanda baca pemisah.
 *   "  Nasi  Goreng " -> "nasi goreng"
 *   "Rica-Rica Ayam"  -> "rica rica ayam"
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // buang aksen
    .replace(/[^a-z0-9\s]/g, ' ')                       // tanda baca -> spasi
    .trim()
    .replace(/\s+/g, ' ');
}

// Kata "pemanis" nama yang tidak mengubah identitas resep
// ("Nasi Goreng Spesial" vs "Nasi Goreng"). Hanya dipakai bersama
// pengecekan kemiripan bahan, jadi resep yang memang beda tetap aman.
const TITLE_FILLER_WORDS = new Set([
  'spesial', 'special', 'istimewa', 'enak', 'lezat', 'mantap', 'sederhana',
  'praktis', 'simple', 'simpel', 'mudah', 'favorit', 'ala', 'rumahan', 'resep',
]);

/** Versi nama tanpa kata pemanis: "nasi goreng spesial" -> "nasi goreng". */
function titleCoreKey(normalizedTitle) {
  const words = normalizedTitle.split(' ').filter((w) => w && !TITLE_FILLER_WORDS.has(w));
  return words.length ? words.join(' ') : normalizedTitle;
}

/** Kemiripan himpunan bahan inti (Jaccard 0..1). */
function ingredientSimilarity(a, b) {
  const setA = new Set(a.ingredientsCore || []);
  const setB = new Set(b.ingredientsCore || []);
  // Dua resep tanpa info bahan tidak boleh dianggap "mirip" -- kalau tidak,
  // semua resep tanpa bahan dengan nama inti sama akan saling menghapus.
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

const SIMILAR_INGREDIENT_THRESHOLD = 0.6;

/**
 * Bersihkan daftar resep dari duplikasi. Urutan asli dipertahankan,
 * kemunculan PERTAMA yang disimpan. Sebuah resep dianggap duplikat jika:
 *   1. ID-nya sudah pernah muncul (ID = identitas utama), ATAU
 *   2. Nama ternormalisasinya identik dengan resep yang sudah ada
 *      ("Nasi Goreng" = "nasi  goreng"), ATAU
 *   3. Nama tanpa kata pemanis sama ("Nasi Goreng Spesial" ~ "Nasi Goreng")
 *      DAN bahan intinya sangat mirip -- supaya resep berbeda yang
 *      kebetulan namanya mirip tidak ikut terbuang.
 *
 * Aman dipanggil berkali-kali (idempotent) dan untuk list apa pun:
 * hasil bahan, hasil nama, kategori, favorit, dsb.
 *
 * @param {Array} list
 * @param {(removed, kept) => void} [onDuplicate] callback opsional
 */
export function removeDuplicateRecipes(list, onDuplicate) {
  if (!Array.isArray(list)) return [];

  const seenIds = new Map();     // id -> resep yang disimpan
  const seenTitles = new Map();  // judul ternormalisasi -> resep
  const seenCores = new Map();   // judul inti -> resep[]
  const result = [];

  for (const recipe of list) {
    if (!recipe) continue;

    const hasId = recipe.id !== undefined && recipe.id !== null && recipe.id !== '';
    if (hasId && seenIds.has(recipe.id)) {
      if (onDuplicate) onDuplicate(recipe, seenIds.get(recipe.id));
      continue;
    }

    const titleKey = recipe.titleKey || normalizeTitle(recipe.title);
    const byTitle = titleKey ? seenTitles.get(titleKey) : null;
    if (byTitle) {
      if (onDuplicate) onDuplicate(recipe, byTitle);
      if (hasId) seenIds.set(recipe.id, byTitle);
      continue;
    }

    const coreKey = titleCoreKey(titleKey);
    const candidates = coreKey ? seenCores.get(coreKey) || [] : [];
    const similar = candidates.find(
      (c) => ingredientSimilarity(c, recipe) >= SIMILAR_INGREDIENT_THRESHOLD
    );
    if (similar) {
      if (onDuplicate) onDuplicate(recipe, similar);
      if (hasId) seenIds.set(recipe.id, similar);
      continue;
    }

    if (hasId) seenIds.set(recipe.id, recipe);
    if (titleKey) seenTitles.set(titleKey, recipe);
    if (coreKey) seenCores.set(coreKey, [...candidates, recipe]);
    result.push(recipe);
  }

  return result;
}

const FETCH_TIMEOUT_MS = 15000; // batas satu request, supaya UI tidak menggantung

/** Error yang pesannya memang sudah layak ditampilkan ke pengguna. */
class RecipeDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecipeDataError';
  }
}

/**
 * Ambil satu "halaman" data mentah dari API Hugging Face.
 * Fungsi ini murni tugas jaringan -- tidak melakukan normalisasi apa pun,
 * supaya mudah dites/dipahami terpisah dari logic pengolahan data.
 * Melempar RecipeDataError berpesan Indonesia; penyebab asli dicatat di console.
 */
async function fetchRecipes(offset = 0, length = PAGE_LENGTH) {
  const url = `${API_BASE}?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${offset}&length=${length}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      console.warn(`[recipes] Request API gagal (offset ${offset}):`, timedOut ? 'timeout' : (err && err.message) || err);
      throw new RecipeDataError(
        timedOut
          ? 'Koneksi ke server resep terlalu lambat. Periksa jaringan lalu coba lagi.'
          : 'Tidak dapat terhubung ke server resep. Periksa koneksi internet lalu coba lagi.'
      );
    }

    if (!response.ok) {
      console.warn(`[recipes] API merespons status ${response.status} (offset ${offset}).`);
      throw new RecipeDataError(`Gagal mengambil data resep dari server (status ${response.status}). Silakan coba lagi.`);
    }

    try {
      return await response.json();
    } catch (err) {
      console.warn(`[recipes] Respons API bukan JSON valid (offset ${offset}):`, (err && err.message) || err);
      throw new RecipeDataError('Data resep dari server tidak dapat dibaca. Silakan coba lagi.');
    }
  } finally {
    clearTimeout(timer); // selalu dibersihkan, baik berhasil maupun gagal
  }
}

const FALLBACK_TITLE = 'Resep Tanpa Nama';

/**
 * Ambil ID dari baris mentah secara aman.
 * ID numerik valid (termasuk 0) dipertahankan; ID string yang berisi angka
 * diubah ke Number supaya konsisten dengan getRecipeById/sortRecipes.
 * Nilai null, undefined, string kosong, atau nonnumerik menjadi null.
 */
function normalizeRecipeId(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Ambil nama resep secara aman. Hanya string yang dipakai; null, undefined,
 * angka, object, atau tipe lain menjadi fallback. Tidak pernah memanggil
 * .trim() pada nilai non-string.
 */
function normalizeRecipeTitle(value) {
  if (typeof value !== 'string') return FALLBACK_TITLE;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned || FALLBACK_TITLE;
}

/**
 * Bersihkan array teks (bahan/langkah): hanya elemen string nonkosong yang
 * dipertahankan, di-trim, urutan asli tidak berubah. Sumber non-array -> [].
 * `rowIndex`/`field` hanya untuk log peringatan.
 */
function normalizeTextArray(value, field, rowIndex) {
  if (!Array.isArray(value)) return [];

  const result = [];
  const notString = [];  // indeks elemen yang tipenya bukan string
  const empty = [];      // indeks string yang kosong/whitespace saja

  // for klasik (bukan forEach) supaya lubang array tetap ikut diperiksa.
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (typeof item !== 'string') {
      notString.push(index);
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      empty.push(index);
      continue;
    }
    result.push(trimmed);
  }

  // Satu peringatan per baris+field, bukan satu per elemen, supaya log
  // tidak membanjiri console pada dataset besar.
  if (notString.length) {
    console.warn(
      `[recipes] Baris ${rowIndex}: ${notString.length} elemen ${field} bukan string, dibuang (indeks: ${notString.join(', ')}).`
    );
  }
  if (empty.length) {
    console.warn(
      `[recipes] Baris ${rowIndex}: ${empty.length} elemen ${field} kosong, dibuang (indeks: ${empty.join(', ')}).`
    );
  }

  return result;
}

/**
 * Ubah satu baris data mentah dari API menjadi bentuk yang dipakai UI.
 * Field yang tidak tersedia di API (Loves, URL) diberi nilai kosong/0,
 * bukan dikarang.
 */
function normalizeRecipe(raw, rowIndex) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rowLabel = rowIndex === undefined ? '?' : rowIndex;

  const ingredientsFull = normalizeTextArray(source.ingredients, 'ingredients', rowLabel);
  const stepsFull = normalizeTextArray(source.steps, 'steps', rowLabel);

  const title = normalizeRecipeTitle(source.name);
  const rawName = typeof source.name === 'string' ? source.name : '';

  return {
    id: normalizeRecipeId(source.id),
    title,
    titleCleaned: rawName.toLowerCase(),
    titleKey: normalizeTitle(rawName),                // kunci pembanding anti-duplikasi & pencarian nama
    // Gambar hanya dipakai kalau database memang menyediakannya (saat ini tidak ada).
    image: source.image || source.image_url || source.img || '',
    category: typeof source.category === 'string' && source.category.trim()
      ? source.category.trim().toLowerCase()
      : 'lainnya',
    ingredientsFull,                                   // teks asli lengkap, buat ditampilkan di detail
    ingredientsCore: ingredientsFull.flatMap(extractCoreIngredient), // "inti" bahan, buat matching & filter
    stepsFull,
    loves: 0,          // API tidak menyediakan field ini -- bukan dikarang, memang tidak ada
    url: '',           // API tidak menyediakan sumber resep
    difficulty: source.difficulty || '',
    timeMinutes: Number.isFinite(source.time_minutes) ? source.time_minutes : null,
    region: source.region || '',
    totalIngredients: ingredientsFull.length,
    totalSteps: stepsFull.length,
  };
}

/**
 * Ambil "inti" nama bahan dari satu baris teks bahan API. Contoh:
 *   "500 gram singkong, kupas dan cuci bersih" -> ["singkong"]
 *   "bumbu halus: 6 bawang merah, 4 bawang putih" -> ["bawang merah", "bawang putih"]
 *
 * Caranya:
 * 1. Kalau baris berformat "label: bahan1, bahan2, ..." (mis. "bumbu halus:",
 *    "pelengkap:"), pecah bagian setelah titik dua per koma -- baris ini
 *    memang berisi beberapa bahan sekaligus dalam satu elemen array.
 * 2. Baris biasa cukup ambil bagian SEBELUM koma pertama saja -- karena teks
 *    setelah koma di baris biasa umumnya instruksi ("kupas dan cuci bersih"),
 *    bukan bahan lain.
 * 3. Buang angka/pecahan/satuan takaran umum & isi dalam kurung di depannya.
 *
 * Ini heuristik sederhana (bukan parser sempurna) -- teks lengkap aslinya
 * tetap disimpan utuh di `ingredientsFull` untuk ditampilkan ke user.
 */
function extractCoreIngredient(text) {
  if (!text) return [];

  const parenPattern = /\([^)]*\)/g;
  const unitPattern = /^\s*\d+(\/\d+|[.,]\d+)?\s*(gram|kg|ml|liter|sdm|sdt|sendok\s+makan|sendok\s+teh|sendok|gelas|butir|buah|batang|lembar|siung|cm|ekor|potong|ruas|bungkus|papan|helai|ikat|genggam|biji|iris|ons)?\s*/i;
  const clean = (s) => s.replace(parenPattern, '').replace(unitPattern, '').trim().toLowerCase();

  const colonIndex = text.indexOf(':');
  const hasLabel = colonIndex !== -1 && colonIndex < 20; // batas 20 char supaya tidak salah kena kalimat panjang

  if (hasLabel) {
    return text.slice(colonIndex + 1).split(',').map(clean).filter(Boolean);
  }

  const core = clean(text.split(',')[0]);
  return core ? [core] : [];
}

/**
 * Muat SELURUH database resep dari API (bukan per halaman UI), lalu cache
 * di memory. Dilakukan sekali saja saat aplikasi start -- fitur generator
 * butuh membandingkan bahan ke seluruh data supaya persentase kecocokan
 * dan urutannya akurat, bukan cuma dari satu halaman API.
 */
export async function loadRecipes() {
  if (recipesCache) return recipesCache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let offset = 0;
    let total = Infinity;
    const allRows = [];

    while (offset < total) {
      let data;
      try {
        data = await fetchRecipes(offset, PAGE_LENGTH);
      } catch (err) {
        
        throw err instanceof RecipeDataError
          ? err
          : new RecipeDataError('Gagal memuat resep. Silakan coba lagi.');
      }

      if (!data || !Array.isArray(data.rows)) {
        console.warn('[recipes] Struktur respons API tidak valid:', data === null ? 'null' : typeof data);
        throw new RecipeDataError('Format data resep dari server tidak sesuai. Silakan coba lagi.');
      }

      total = Number.isFinite(data.num_rows_total) ? data.num_rows_total : data.rows.length;
      for (const item of data.rows) {
        if (item && item.row) allRows.push(item.row);
      }
      offset += PAGE_LENGTH;
    }

    if (allRows.length === 0) {
      throw new RecipeDataError('Database resep kosong.');
    }

    const normalized = allRows.map((raw, index) => {
      try {
        return normalizeRecipe(raw, index);
      } catch (err) {
        // satu baris rusak tidak boleh menjatuhkan seluruh aplikasi
        console.warn(`[recipes] Baris ${index} gagal dinormalisasi:`, err && err.message ? err.message : err);
        return null;
      }
    });
 
    duplicateIdAlias.clear();
    recipesCache = removeDuplicateRecipes(normalized.filter(Boolean), (removed, kept) => {
      if (removed.id !== kept.id && !duplicateIdAlias.has(removed.id)) {
        duplicateIdAlias.set(removed.id, kept.id);
      }
    });

    return recipesCache;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null; // izinkan retry di percobaan berikutnya
    throw err;
  }
}

/** Ambil seluruh resep dari cache (harus dipanggil setelah loadRecipes selesai). */
export function getAllRecipes() {
  return recipesCache || [];
}

/** Cari satu resep berdasarkan ID asli dari API. */
export function getRecipeById(id) {
  // Pakai validasi yang sama dengan normalisasi supaya input kosong/tidak valid
  // tidak pernah dianggap sebagai ID 0 (Number(null) dan Number('') = 0).
  const numId = normalizeRecipeId(id);
  if (numId === null || !recipesCache) return null;
  const targetId = duplicateIdAlias.has(numId) ? duplicateIdAlias.get(numId) : numId;
  return recipesCache.find((r) => r.id === targetId) || null;
}

/** Daftar kategori unik + jumlah resepnya, diambil dinamis dari data (tidak hardcode). */
export function getCategories() {
  const counts = new Map();
  for (const r of getAllRecipes()) {
    counts.set(r.category, (counts.get(r.category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Urutkan resep. mode: 'default' | 'az' | 'za' | 'match'
 * 'match' mengasumsikan tiap item punya properti matchPercentage (dari generator.js).
 * Loves tidak lagi dipakai sebagai secondary ranking karena API tidak menyediakannya --
 * secondary ranking-nya jadi urutan ID asli (stabil, bukan dikarang).
 */
export function sortRecipes(list, mode = 'default') {
  const arr = Array.isArray(list) ? [...list] : [];
  switch (mode) {
    case 'az':
      return arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'id'));
    case 'za':
      return arr.sort((a, b) => String(b.title).localeCompare(String(a.title), 'id'));
    case 'match':
      return arr.sort((a, b) => {
        const diff = (b.matchPercentage || 0) - (a.matchPercentage || 0);
        return diff !== 0 ? diff : compareRecipeIds(a.id, b.id);
      });
    case 'default':
    default:
      return arr.sort((a, b) => compareRecipeIds(a.id, b.id));
  }
}

/**
 * Bandingkan ID resep secara numerik. ID yang tidak valid (null) selalu
 * ditempatkan SETELAH ID valid. Dua ID null dianggap sama (urutan relatifnya
 * dibiarkan apa adanya -- Array.sort di V8 bersifat stabil), jadi urutan
 * tidak berubah-ubah antar pemanggilan dan tidak pernah menghasilkan NaN.
 */
function compareRecipeIds(aId, bId) {
  const aValid = typeof aId === 'number' && Number.isFinite(aId);
  const bValid = typeof bId === 'number' && Number.isFinite(bId);
  if (aValid && bValid) return aId - bId;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

let ingredientTokensCache = null;

/**
 * Daftar token bahan unik (versi "inti", lihat extractCoreIngredient) dari
 * seluruh database, diurutkan dari yang paling sering muncul. Dipakai
 * sebagai sumber data untuk filter bahan (dropdown/checkbox) di UI.
 */
export function getIngredientTokens() {
  if (ingredientTokensCache) return ingredientTokensCache;

  const counts = new Map();
  for (const r of getAllRecipes()) {
    for (const token of r.ingredientsCore) {
      if (!token) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  ingredientTokensCache = Array.from(counts.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token, 'id'));

  return ingredientTokensCache;
}
