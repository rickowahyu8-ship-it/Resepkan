// favorites.js
// Tanggung jawab: kelola daftar resep favorit user di localStorage.
// Data favorit hanya menyimpan ID (id asli dari API) - tidak butuh backend/database baru.
//
// Sejak T15 dua bentuk ID didukung tanpa mengubah data lama:
//   - ID numerik Hugging Face  -> disimpan sebagai number (perilaku lama)
//   - UUID Supabase           -> disimpan apa adanya sebagai string
// Nilai non-numerik hanya diterima kalau berbentuk UUID, supaya data korup
// seperti "abc" tidak ikut tersimpan.

// PENTING: key storage sengaja diganti jadi "_v2" karena sumber data pindah
// dari resep.json (ID = index array) ke API Hugging Face (ID = field asli
// dari API). Kedua skema ID tidak kompatibel -- kalau tetap pakai key lama,
// favorit lama bisa "menempel" ke resep yang salah di database baru.
const STORAGE_KEY = 'resepin_favorites_v2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalisasi ID favorit: number bulat, atau UUID string; selain itu null. */
export function normalizeFavoriteId(id) {
  if (typeof id === 'number') return Number.isInteger(id) ? id : null;
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (UUID_PATTERN.test(trimmed)) return trimmed.toLowerCase();
    if (trimmed !== '' && /^\d+$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

/** Baca daftar ID favorit dari localStorage. Aman jika localStorage tidak tersedia. */
export function getFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Semua nilai lewat normalizeFavoriteId -- termasuk number -- supaya data
    // korup seperti 2.5 atau NaN tidak ikut terbawa sebagai "favorit".
    return parsed.map(normalizeFavoriteId).filter((id) => id !== null);
  } catch (err) {
    // localStorage penuh, dinonaktifkan browser, atau data korup -> anggap kosong
    return [];
  }
}

function saveFavorites(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    return true;
  } catch (err) {
    return false;
  }
}

/** Tambah resep ke favorit berdasarkan ID. Mencegah duplikasi. */
export function addFavorite(id) {
  const favId = normalizeFavoriteId(id);
  if (favId === null) return false;

  const current = getFavorites();
  if (current.includes(favId)) return true; // sudah ada, tidak perlu duplikat

  current.push(favId);
  return saveFavorites(current);
}

/** Hapus resep dari favorit berdasarkan ID. */
export function removeFavorite(id) {
  const favId = normalizeFavoriteId(id);
  const current = getFavorites();
  const next = current.filter((stored) => stored !== favId);
  return saveFavorites(next);
}

/** Cek apakah sebuah resep sudah difavoritkan. */
export function isFavorite(id) {
  const favId = normalizeFavoriteId(id);
  return favId !== null && getFavorites().includes(favId);
}

/** Toggle status favorit, kembalikan status baru (true = kini favorit). */
export function toggleFavorite(id) {
  if (isFavorite(id)) {
    removeFavorite(id);
    return false;
  }
  addFavorite(id);
  return true;
}

/** Jumlah total resep favorit -- dipakai untuk badge di navbar. */
export function getFavoritesCount() {
  return getFavorites().length;
}
