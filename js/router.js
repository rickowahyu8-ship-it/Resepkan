// router.js
// Tanggung jawab: router hash minimal (T02.1).
//
// ATURAN KERAS (supaya konfirmasi email Supabase tidak terganggu):
//   1. Router TIDAK PERNAH menulis ke URL saat halaman dimuat (tanpa normalisasi).
//   2. Router TIDAK PERNAH menyentuh URL yang membawa parameter autentikasi Supabase,
//      baik di hash (#access_token=...) maupun di query (?code=...). Dalam kondisi itu
//      tidak ada pushState, replaceState, location.replace, atau perubahan location.hash.
//   3. URL baru ditulis hanya saat pengguna menavigasi (mis. menekan "Pencarian").
//   4. Hash yang tidak dikenal dibiarkan: tanpa pengalihan, tanpa halaman "tidak ditemukan".
//   5. Rute boleh berparameter (mis. '#/kategori/:key'); penangannya menerima nilai parameter.

const AUTH_KEYS = [
  'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token',
  'expires_in', 'expires_at', 'token_type', 'token_hash',
  'code', 'error', 'error_code', 'error_description', 'type',
];
const AUTH_PARAM = new RegExp(`(^|[?#&/])(${AUTH_KEYS.join('|')})=`);

const routes = new Map(); // '#/pencarian' -> { keys: [], handler }

/**
 * Ubah '#/kategori/:key' menjadi pola yang bisa dicocokkan dengan hash apa pun.
 * ':key' menangkap satu segmen (tanpa '/'), mis. '#/kategori/mie'.
 */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape karakter regex
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { keys, re: new RegExp(`^${source}$`) };
}

/** Cocokkan hash dengan pola rute. Mengembalikan { handler, params } atau null. */
function match(hash) {
  for (const [pattern, { keys, re, handler }] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    const params = {};
    keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
    return { handler, params };
  }
  return null;
}

/** true jika URL membawa parameter autentikasi (hash maupun query). */
export function hasAuthParams(loc = window.location) {
  return AUTH_PARAM.test(loc.search || '') || AUTH_PARAM.test(loc.hash || '');
}

/** Jalankan penangan untuk hash saat ini. Tidak menulis URL / tidak memicu navigasi. */
function dispatch(hash) {
  if (hasAuthParams()) return false; // callback auth dibiarkan utuh, tidak diproses sebagai rute
  const found = match(hash);
  if (!found) return false;
  found.handler(found.params);
  return true;
}

/**
 * Daftarkan penangan rute, terapkan hash awal SEKALI, lalu dengarkan perubahan hash.
 * - Hash awal diproses tanpa menulis/menormalkan URL (aturan 1 & 2 tetap utuh).
 * - 'hashchange' tetap jalur yang sama untuk klik pengguna maupun Back/Forward.
 * - Satu pemanggilan init = satu kali handler per hash (tidak dobel).
 */
export function initRouter(table) {
  Object.entries(table).forEach(([pattern, handler]) => {
    routes.set(pattern, { ...compile(pattern), handler });
  });
  // Hash berubah karena klik pengguna ATAU tombol Back/Forward browser; keduanya
  // lewat jalur yang sama ini, jadi tidak perlu listener popstate terpisah.
  window.addEventListener('hashchange', () => dispatch(window.location.hash));

  // Hash awal (buka langsung / reload): tanpa ini rute tidak pernah dijalankan,
  // karena dokumen baru tidak memicu 'hashchange'.
  dispatch(window.location.hash);
}

/**
 * Pindah ke rute atas permintaan pengguna. URL hanya ditulis jika tidak ada
 * parameter autentikasi; penangan rute tetap dijalankan agar tombol berfungsi.
 */
export function navigate(hash, options = {}) {
  const found = match(hash);
  if (!found) return false;

  if (!hasAuthParams() && window.location.hash !== hash) {
    if (options.replace && window.history && window.history.replaceState) {
      // Ganti entri riwayat saat ini (mis. pemulihan URL setelah data siap):
      // Back tidak perlu mengunjungi kategori yang tidak benar-benar dipilih.
      window.history.replaceState(null, '', hash);
      found.handler(found.params);
    } else {
      window.location.hash = hash; // memicu 'hashchange' -> penangan dipanggil sekali
    }
    return true;
  }

  found.handler(found.params);
  return true;
}
