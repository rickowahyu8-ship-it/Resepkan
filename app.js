// app.js
// Tanggung jawab: inisialisasi aplikasi, menu utama (2 metode pencarian +
// kategori), kelola input bahan (chip + picker), jalankan pencarian,
// pagination hasil, favorit, dark mode, dan seluruh event listener.

import {
  loadRecipes, getAllRecipes, getIngredientTokens, removeDuplicateRecipes,
} from './js/recipes.js';
import { parseUserIngredients, findRecipesByIngredients } from './js/generator.js';
import { findRecipeByName, isExactNameMatch } from './js/search.js';
import {
  CATEGORY_DEFS, getCategoryDef, filterRecipesByCategory, getCategoryCounts, getPrimaryCategoryDef,
} from './js/categories.js';
import { getFavorites, isFavorite, toggleFavorite, getFavoritesCount } from './js/favorites.js';
import {
  SOURCE_SUPABASE, loadSupabasePublicRecipes, mergePublicRecipes, recipeKey,
} from './js/public-recipes.js';
import { isSafeUrl, showToast, toTitleCase, formatCategoryLabel } from './js/utils.js';
import { supabase } from './js/supabase.js';
import { setupAuth } from './js/auth.js';
import { initSidebar } from './js/sidebar.js';
import { initRouter, navigate, hasAuthParams } from './js/router.js';
import {
  saveRecipe, cleanText, cleanItems, CATEGORY_OPTIONS, ITEM_MAX_LENGTH,
} from './js/add-recipe.js';
import {
  fetchMyRecipes, updateRecipe, deleteRecipe, MY_ERR_NOT_SIGNED_IN, MY_ERR_NETWORK,
} from './js/my-recipes.js';

const PAGE_SIZE = 9; // sesuai spesifikasi terbaru: maksimal 10 resep per halaman
const PICKER_MAX_SHOWN = 40; // batasi jumlah opsi yang dirender di panel picker demi performa

// ---- State ----
let ingredients = [];       // bahan yang sudah ditambahkan user (chip)
let currentResults = [];    // seluruh hasil (sudah bebas duplikat, belum dipotong per halaman)
let currentPage = 1;
let currentEmptyMessage = 'Tidak ditemukan resep yang cocok dengan bahan tersebut.';
let currentResultsKind = null; // 'ingredient' | 'name' | 'category': hasil apa yang sedang tampil
let currentCategoryKey = null; // key kategori yang hasilnya sedang tampil (untuk rute #/kategori/:key)
let activeCategoryKey = null; // kategori yang sedang dipilih (untuk highlight kartu)
let recipesReady = false;
let sidebarApi = null;        // diisi initSidebar (tetap null jika inisialisasi sidebar gagal)
let currentPageView = 'home'; // 'home' (beranda), 'search' (pencarian/kategori), atau 'favorites' (halaman Favorit)
let pendingSearchMethod = null; // metode yang langsung dibuka setelah halaman pencarian tampil
let pendingCategoryKey = null; // kategori dari URL yang menunggu data resep selesai dimuat

// ---- Gabungan sumber resep (T15) ----
// publicRecipes = resep Hugging Face + resep publik Supabase (status approved).
// recipesCache di js/recipes.js TIDAK diubah; Supabase disimpan terpisah.
let publicRecipes = [];
let supabasePublicReady = false;
let hfReady = false;      // true hanya bila Hugging Face benar-benar berhasil dan berisi data
let hfRetryNeeded = false; // true bila HF gagal walau sumber lain berhasil

function getPublicRecipes() {
  // Selalu bertanda sumber: resep Hugging Face dibungkus saat modul dimuat.
  // Fallback ke getAllRecipes() hanya bila daftar gabungan belum siap (mis. sebelum load).
  if (publicRecipes.length) return publicRecipes;
  return mergePublicRecipes(getAllRecipes(), []);
}

/** Cari resep gabungan berdasarkan sumber + id (UUID tetap string). */
function findPublicRecipe({ source, id }) {
  return getPublicRecipes().find((r) => recipeKey(r) === `${source}:${String(id)}`) || null;
}

/**
 * Muat ulang daftar publik: HF tetap lewat loadRecipes() yang sudah ada,
 * Supabase lewat modul terpisah. Kegagalan Supabase TIDAK menjatuhkan HF.
 * Mengembalikan true bila setidaknya satu sumber berhasil.
 */
async function loadPublicRecipes({ force = false } = {}) {
  let hfOk = true;
  try {
    await loadRecipes();
  } catch (err) {
    hfOk = false;
    console.warn('[public-recipes] Hugging Face gagal dimuat:', (err && err.message) || err);
  }

  let sbRecipes = [];
  let sbOk = false;
  try {
    const res = await loadSupabasePublicRecipes({ force });
    sbOk = res.ok;
    sbRecipes = res.recipes || [];
  } catch (err) {
    console.warn('[public-recipes] Supabase gagal dimuat:', (err && err.message) || err);
  }
  supabasePublicReady = sbOk;
  // Supabase kosong/gagal -> daftar berisi resep Hugging Face saja.
  publicRecipes = mergePublicRecipes(getAllRecipes(), sbRecipes);
  hfReady = hfOk && getAllRecipes().length > 0;
  return hfOk || sbOk;
}

// ---- Referensi elemen DOM ----
const el = (id) => document.getElementById(id);

// ==========================================================================
// PENGELOLAAN FOKUS MODAL (satu mekanisme untuk semua modal)
// ==========================================================================

const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Pemilik fokus disimpan per modal (bukan satu variabel global) supaya modal
// bertumpuk mengembalikan fokus ke pemicunya masing-masing.
const modalFocusReturn = new WeakMap();

/** Modal yang sedang tampil, urut sesuai urutan buka (paling akhir = teratas). */
function openModals() {
  return Array.from(document.querySelectorAll('.modal-overlay')).filter((m) => !m.hidden);
}

function topModal() {
  const list = openModals();
  return list.length ? list[list.length - 1] : null;
}

/** Latar dinonaktifkan selama ada modal; drawer ikut mati karena ada di dalam shell. */
function syncBackgroundInert() {
  const shell = el('appShell');
  if (!shell) return;
  shell.inert = openModals().length > 0;
}

function focusablesIn(modal) {
  return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/**
 * Siapkan modal yang baru dibuka: catat pemicu fokus, pindahkan fokus ke
 * elemen yang diminta (atau elemen focusable pertama), dan kunci latar.
 */
function enterModal(modal, preferredFocus, trigger) {
  if (!modal) return;
  // Catat pemicu SEBELUM inert dipasang (setelah inert, fokus sudah pindah ke body).
  // `trigger` dari event handler lebih andal daripada document.activeElement
  // ketika modal dibuka lewat klik programatik.
  if (!modalFocusReturn.has(modal)) {
    const active = document.activeElement;
    const owner = trigger || (active && active !== document.body ? active : null);
    modalFocusReturn.set(modal, owner);
  }
  syncBackgroundInert();
  const target = (preferredFocus && modal.contains(preferredFocus) && !preferredFocus.disabled)
    ? preferredFocus
    : (focusablesIn(modal)[0] || modal.querySelector('.modal') || modal);
  if (target && typeof target.focus === 'function') target.focus();
}

/** Selesaikan penutupan modal: lepaskan inert dan kembalikan fokus ke pemicu. */
function exitModal(modal) {
  if (!modal) return;
  const owner = modalFocusReturn.get(modal);
  modalFocusReturn.delete(modal);
  // Lepas inert DULU: elemen di dalam shell tidak bisa difokuskan selama inert.
  syncBackgroundInert();
  if (owner && owner.isConnected && !owner.closest('[inert]') && typeof owner.focus === 'function') {
    owner.focus();
  }
  // Fokuskan ulang setelah browser selesai memproses pelepasan inert
  // (Chromium memindahkan fokus ke <body> saat atribut inert dicabut).
  if (owner && owner.isConnected && !owner.closest('[inert]')) {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) owner.focus();
    });
  }
}

// Satu listener Tab untuk semua modal. Escape tetap ditangani handler lama.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = topModal();
  if (!modal) return;
  // Daftar diambil ulang tiap Tab agar elemen dinamis (chip, hasil render) ikut.
  const items = focusablesIn(modal);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!modal.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
});

// Modal akun dikelola js/auth.js (modul mandiri, tanpa import ke sini).
// Jangan memakai focusin untuk mengaktifkan inert: focusin juga terjadi SETELAH
// modal ditutup (saat fokus dipulihkan), sehingga inert terpasang lagi dan
// seluruh halaman menjadi tidak bisa diklik. Modal akun membuka/menutup secara
// eksplisit lewat callback onModalClose di bawah.

const themeToggle = el('themeToggle');
const homePage = el('homePage');
const searchPage = el('searchPage');
const appFooter = el('appFooter');
const startSearchBtn = el('startSearchBtn');
const backToHomeBtn = el('backToHomeBtn');
const nameRetryBtn = el('nameRetryBtn');
const ingredientRetryBtn = el('ingredientRetryBtn');
const favoritesNavBtn = el('favoritesNavBtn');
const favoritesCountBadge = el('favoritesCountBadge');

const ingredientInput = el('ingredientInput');
const addIngredientBtn = el('addIngredientBtn');
const ingredientChips = el('ingredientChips');
const generateBtn = el('generateBtn');
const generatorMessage = el('generatorMessage');

const pickerToggleBtn = el('pickerToggleBtn');
const pickerPanel = el('pickerPanel');
const pickerSearch = el('pickerSearch');
const pickerList = el('pickerList');

const openIngredientSearchBtn = el('openIngredientSearchBtn');
const openNameSearchBtn = el('openNameSearchBtn');
const optionIngredientCard = el('optionIngredientCard');
const optionNameCard = el('optionNameCard');
const ingredientPanel = el('ingredientPanel');
const namePanel = el('namePanel');
const nameSearchForm = el('nameSearchForm');
const nameSearchInput = el('nameSearchInput');
const nameSearchBtn = el('nameSearchBtn');
const nameSearchMessage = el('nameSearchMessage');

const categoryGrid = el('categoryGrid');
const seeAllCategoriesBtn = el('seeAllCategoriesBtn');
const searchOptionsSection = document.querySelector('#searchPage .search-options');
const categorySection = document.querySelector('#searchPage .category-section');

const resultsSection = el('resultsSection');
const resultsTitle = el('resultsTitle');
const resultsCount = el('resultsCount');
const resultsGrid = el('resultsGrid');
const pagination = el('pagination');
const paginationInfo = el('paginationInfo');
const prevPageBtn = el('prevPageBtn');
const nextPageBtn = el('nextPageBtn');

const detailModal = el('detailModal');
const closeDetailModal = el('closeDetailModal');
const detailModalTitle = el('detailModalTitle');
const detailModalBody = el('detailModalBody');

// ---- Halaman Favorit (C06: mandiri, menggantikan modal favorit) ----
const favoritesPage = el('favoritesPage');
const favoritesPageGrid = el('favoritesPageGrid');
const favoritesPageCount = el('favoritesPageCount');
const favoritesPagination = el('favoritesPagination');
const favoritesPaginationInfo = el('favoritesPaginationInfo');
const favoritesPrevPageBtn = el('favoritesPrevPageBtn');
const favoritesNextPageBtn = el('favoritesNextPageBtn');

const authModal = el('authModal');
let authApi = null; // diisi setupAuth() saat init

// ---- Tambah Resep ----
const addRecipeNavBtn = el('addRecipeNavBtn');
const addRecipeModal = el('addRecipeModal');
const addRecipeForm = el('addRecipeForm');
const addRecipeTitle = el('addRecipeTitle');
const addRecipeCategory = el('addRecipeCategory');
const addRecipeDescription = el('addRecipeDescription');
const addRecipeImageUrl = el('addRecipeImageUrl');
const closeAddRecipeModal = el('closeAddRecipeModal');
const addRecipeSubmitBtn = el('addRecipeSubmitBtn');
const addRecipeStatus = el('addRecipeStatus');

// ---- Resep Saya ----
const myRecipesNavBtn = el('myRecipesNavBtn');
const myRecipesModal = el('myRecipesModal');
const closeMyRecipesModal = el('closeMyRecipesModal');
const myRecipesStatus = el('myRecipesStatus');
const myRecipesGrid = el('myRecipesGrid');
const myRecipesRetryBtn = el('myRecipesRetryBtn');
const myRecipeDetailModal = el('myRecipeDetailModal');
const myRecipeDetailTitle = el('myRecipeDetailTitle');
const myRecipeDetailBody = el('myRecipeDetailBody');
const closeMyRecipeDetailModal = el('closeMyRecipeDetailModal');

// ==========================================================================
// CHIP BAHAN (input manual + dipilih dari picker, dua-duanya masuk ke sini)
// ==========================================================================

function renderChips() {
  ingredientChips.innerHTML = '';

  if (ingredients.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chips-empty';
    empty.textContent = 'Belum ada bahan ditambahkan.';
    ingredientChips.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  ingredients.forEach((ingredient, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';

    const label = document.createElement('span');
    label.textContent = ingredient; // textContent -> aman dari input pengguna

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.setAttribute('aria-label', `Hapus bahan ${ingredient}`);
    removeBtn.dataset.index = index;

    chip.append(label, removeBtn);
    fragment.appendChild(chip);
  });
  ingredientChips.appendChild(fragment);
}

function addIngredient(value) {
  // Satu input boleh berisi beberapa bahan dipisah koma ("nasi, telur").
  // parseUserIngredients melakukan hal yang sama dengan pencocokan nanti,
  // jadi chip dan query selalu konsisten.
  const parsed = parseUserIngredients(value);
  if (parsed.length === 0) return false;

  const added = [];
  const duplicates = [];
  for (const normalized of parsed) {
    if (ingredients.includes(normalized)) duplicates.push(normalized);
    else { ingredients.push(normalized); added.push(normalized); }
  }

  renderChips();
  if (added.length || !duplicates.length) clearGeneratorMessage();
  if (!added.length) {
    showToast(`"${duplicates[0]}" sudah ada di daftar bahan.`);
    return false;
  }
  if (duplicates.length) showToast(`Sebagian bahan sudah ada (${duplicates.join(', ')}).`);
  return true;
}

function removeIngredientAt(index) {
  ingredients.splice(index, 1);
  renderChips();
  syncPickerCheckboxes();
}

function removeIngredientValue(value) {
  removeIngredientAt(ingredients.indexOf(value));
}

function addIngredientFromInput() {
  const value = ingredientInput.value;
  ingredientInput.value = '';
  ingredientInput.focus();
  addIngredient(value);
}

// ==========================================================================
// FILTER BAHAN (picker: dropdown pencarian + checkbox)
// ==========================================================================

let ingredientTokens = []; // { token, count }[], diisi setelah loadRecipes()

function renderPickerList(query) {
  const q = (query || '').trim().toLowerCase();
  const source = q
    ? ingredientTokens.filter((t) => t.token.includes(q))
    : ingredientTokens;

  const shown = source.slice(0, PICKER_MAX_SHOWN);
  pickerList.innerHTML = '';

  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'picker-empty';
    empty.textContent = 'Bahan tidak ditemukan.';
    pickerList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const { token } of shown) {
    const optionLabel = document.createElement('label');
    optionLabel.className = 'picker-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.token = token;
    checkbox.checked = ingredients.includes(token);

    const text = document.createElement('span');
    text.textContent = token; // textContent -> aman dari data database

    optionLabel.append(checkbox, text);
    fragment.appendChild(optionLabel);
  }
  pickerList.appendChild(fragment);

  if (source.length > PICKER_MAX_SHOWN) {
    const note = document.createElement('p');
    note.className = 'picker-note';
    note.textContent = `Menampilkan ${PICKER_MAX_SHOWN} dari ${source.length} bahan. Ketik lebih spesifik untuk mempersempit.`;
    pickerList.appendChild(note);
  }
}

function syncPickerCheckboxes() {
  if (pickerPanel.hidden) return;
  pickerList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = ingredients.includes(cb.dataset.token);
  });
}

function openPicker() {
  pickerPanel.hidden = false;
  pickerToggleBtn.setAttribute('aria-expanded', 'true');
  renderPickerList(pickerSearch.value);
  pickerSearch.focus();
}
function closePicker() {
  pickerPanel.hidden = true;
  pickerToggleBtn.setAttribute('aria-expanded', 'false');
}
function togglePicker() {
  if (pickerPanel.hidden) openPicker();
  else closePicker();
}

// ==========================================================================
// GENERATOR + PAGINATION
// ==========================================================================

function setGeneratorMessage(text, isWarning = false) {
  generatorMessage.textContent = text;
  generatorMessage.classList.toggle('is-warning', isWarning);
}
function clearGeneratorMessage() {
  setGeneratorMessage('');
}

function dedupeAcrossSources(list) {
  // Dedup hanya di dalam sumber yang sama. Resep Supabase (UUID) tidak boleh
  // dihapus hanya karena judulnya sama dengan resep Hugging Face.
  const items = Array.isArray(list) ? list : [];
  const hf = items.filter((r) => !r.source || r.source === 'huggingface');
  const others = items.filter((r) => r.source && r.source !== 'huggingface');
  return [...removeDuplicateRecipes(hf), ...others];
}

/**
 * Satu pintu untuk menampilkan hasil apa pun (bahan / nama / kategori).
 * Dedup dilakukan DI SINI terhadap SELURUH list sebelum dipotong per halaman,
 * jadi resep yang sama tidak mungkin muncul di halaman 1 lalu muncul lagi
 * di halaman 2. Dedup dibatasi per sumber (T15).
 */
function showResults(list, { title, emptyMessage, kind = 'search', categoryKey = null }) {
  currentResults = dedupeAcrossSources(list);
  currentPage = 1; // pencarian/filter baru selalu kembali ke halaman pertama
  currentEmptyMessage = emptyMessage;
  currentResultsKind = kind;
  currentCategoryKey = kind === 'category' ? categoryKey : null;
  resultsTitle.textContent = title;
  // Status aktif sidebar TIDAK diubah di sini: pemanggil yang tahu konteksnya
  // (showCategory -> 'category', pencarian -> 'search'). Dulu baris ini selalu
  // menimpa status kategori menjadi 'search' tepat setelah showCategory().

  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  syncSearchMethodFromPanel();
  renderResultsPage();
}

// ---- A. Cari berdasarkan bahan ----
function runGenerate() {
  if (ingredients.length === 0) {
    setGeneratorMessage('Silakan masukkan minimal satu bahan.', true);
    resultsSection.hidden = true;
    return;
  }

  clearGeneratorMessage();
  setActiveCategory(null);
  sidebarApi?.setActive({ section: 'search' });

  // Tanpa batas artifisial di sini -- semua resep yang cocok diambil,
  // baru dipotong per halaman lewat pagination supaya tidak berat dirender sekaligus.
  // Daftar memakai gabungan HF + Supabase publik (T15).
  showResults(findRecipesByIngredients(ingredients, getPublicRecipes()), {
    title: 'Rekomendasi Resep dari Bahanmu',
    emptyMessage: 'Tidak ditemukan resep yang cocok dengan bahan tersebut.',
    kind: 'ingredient',
  });
}

// ---- B. Cari berdasarkan nama ----
function setNameSearchMessage(text, isWarning = false) {
  nameSearchMessage.textContent = text;
  nameSearchMessage.classList.toggle('is-warning', isWarning);
}

function runNameSearch() {
  const query = nameSearchInput.value.trim();
  if (!query) {
    setNameSearchMessage('Silakan ketik nama resep terlebih dahulu.', true);
    return;
  }
  if (!recipesReady) return;

  setNameSearchMessage('');
  setActiveCategory(null);
  sidebarApi?.setActive({ section: 'search' });

  const results = findRecipeByName(query, getPublicRecipes());
  showResults(results, {
    title: `Hasil pencarian "${query}"`,
    emptyMessage: `Resep "${query}" tidak ditemukan. Coba kata kunci lain.`,
    kind: 'name',
  });

  // Kalau namanya persis sama (atau hanya ada satu hasil), langsung buka detailnya.
  if (results.length === 1 || (results.length > 0 && isExactNameMatch(results[0], query))) {
    openDetailModal(results[0].id, results[0].source);
  }
}

// ---- C. Kategori (shortcut filter, bukan pencarian baru) ----
function setActiveCategory(key) {
  activeCategoryKey = key;
  categoryGrid.querySelectorAll('.category-card').forEach((card) => {
    const isActive = card.dataset.category === key;
    card.classList.toggle('is-active', isActive);
    card.setAttribute('aria-pressed', String(isActive));
  });
}

function showCategory(key) {
  if (!recipesReady) return;
  const def = key === 'all' ? null : getCategoryDef(key);
  if (key !== 'all' && !def) return;

  showPage('search'); // daftar kategori di dalam halaman pencarian yang bisa di-scroll
  // Mode kategori: kartu metode + blok kategori disembunyikan, jadi judul kategori
  // menjadi konten pertama setelah tombol kembali (bukan hanya soal posisi scroll).
  setSearchView('category');
  setActiveCategory(key === 'all' ? null : key);
  // Status aktif dipasang SEBELUM showResults(): showResults() memanggil
  // syncSearchMethodFromPanel() yang bisa menandai sidebar sebagai 'search'.
  sidebarApi?.setActive({ section: 'category', categoryKey: key === 'all' ? null : key });
  showResults(filterRecipesByCategory(key, getPublicRecipes()), {
    title: def ? `${def.icon} Kategori ${def.label}` : 'Semua Resep',
    emptyMessage: 'Belum ada resep di kategori ini.',
    kind: 'category',
    categoryKey: key,
  });
  // Setelah hasil dirender, pastikan highlight belum tertimpa (lihat showResults()).
  setActiveCategory(key === 'all' ? null : key);
  sidebarApi?.setActive({ section: 'category', categoryKey: key === 'all' ? null : key });
  syncCategoryRoute();
}

/** Rute kategori yang sesuai dengan kategori aktif ('#/kategori/all' untuk "Lihat Semua"). */
const categoryRouteOf = (key) => `${ROUTE_CATEGORY}/${key || 'all'}`;

/**
 * Samakan URL dengan kategori yang sedang tampil TANPA menambah entri riwayat.
 * Dipakai sebagai jaring pengaman bila status kategori berubah lewat jalur lain;
 * pemilihan kategori dari sidebar/kartu sudah menulis rute sendiri.
 */
function syncCategoryRoute() {
  if (currentResultsKind !== 'category') return;
  const expected = categoryRouteOf(currentCategoryKey);
  if (window.location.hash !== expected && !hasAuthParams()) navigate(expected, { replace: true });
}

function renderCategoryCards() {
  const counts = recipesReady ? getCategoryCounts(getPublicRecipes()) : {};
  categoryGrid.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (const def of CATEGORY_DEFS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'category-card';
    card.dataset.category = def.key;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-pressed', String(activeCategoryKey === def.key));
    card.style.setProperty('--cat-color', def.color);
    card.classList.toggle('is-active', activeCategoryKey === def.key);
    card.disabled = !recipesReady;

    const icon = document.createElement('span');
    icon.className = 'category-card-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = def.icon;

    const name = document.createElement('span');
    name.className = 'category-card-name';
    name.textContent = def.label;

    const count = document.createElement('span');
    count.className = 'category-card-count';
    count.textContent = recipesReady ? `${counts[def.key] || 0} resep` : 'Memuat...';

    card.append(icon, name, count);
    fragment.appendChild(card);
  }
  categoryGrid.appendChild(fragment);
}

// ---- Panel pencarian (buka salah satu dari menu utama) ----
function openSearchPanel(which) {
  const isIngredient = which === 'ingredient';
  ingredientPanel.hidden = !isIngredient;
  namePanel.hidden = isIngredient;
  sidebarApi?.setActive({ section: 'search' });

  optionIngredientCard.classList.toggle('is-active', isIngredient);
  optionNameCard.classList.toggle('is-active', !isIngredient);
  openIngredientSearchBtn.setAttribute('aria-expanded', String(isIngredient));
  openNameSearchBtn.setAttribute('aria-expanded', String(!isIngredient));

  const panel = isIngredient ? ingredientPanel : namePanel;
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (isIngredient ? ingredientInput : nameSearchInput).focus({ preventScroll: true });
}

/** Sinkronkan highlight kartu metode dengan panel yang sedang terbuka (+ pastikan halaman pencarian tampil). */
function syncSearchMethodFromPanel() {
  if (ingredientPanel.hidden === namePanel.hidden) return; // dua-duanya tertutup
  const isIngredient = !ingredientPanel.hidden;
  ensureSearchPage();
  sidebarApi?.setActive({ section: 'search' });
  optionIngredientCard.classList.toggle('is-active', isIngredient);
  optionNameCard.classList.toggle('is-active', !isIngredient);
  openIngredientSearchBtn.setAttribute('aria-expanded', String(isIngredient));
  openNameSearchBtn.setAttribute('aria-expanded', String(!isIngredient));
}

/**
 * Tutup kedua panel metode pencarian.
 * Saat dipanggil oleh pemilihan kategori, `force` memastikan metode tertunda
 * (pendingSearchMethod) tidak membuka panel lagi -- lihat resetSearchPanelsForNavigation().
 */
function closeSearchPanels({ force = false } = {}) {
  ingredientPanel.hidden = true;
  namePanel.hidden = true;
  closePicker();
  if (force) pendingSearchMethod = null;
  optionIngredientCard.classList.remove('is-active');
  optionNameCard.classList.remove('is-active');
  openIngredientSearchBtn.setAttribute('aria-expanded', 'false');
  openNameSearchBtn.setAttribute('aria-expanded', 'false');
  // Mengganti metode selagi panel tertutup: panel tetap bersandar pada satu fungsi ini.
  if (!force && pendingSearchMethod) {
    const method = pendingSearchMethod;
    pendingSearchMethod = null;
    openSearchPanel(method);
  }
}

// ---- Rute (JS-03) ----
// '#/beranda'          = beranda
// '#/pencarian'        = halaman pencarian (dua metode + panel + kategori + hasil)
// '#/kategori/:key'    = halaman pencarian dengan kategori aktif (key dari CATEGORY_DEFS,
//                        atau 'all' untuk "Lihat Semua")
const ROUTE_HOME = '#/beranda';
const ROUTE_SEARCH = '#/pencarian';
const ROUTE_CATEGORY = '#/kategori';
const ROUTE_FAVORITES = '#/favorit';
// Key rute kategori diturunkan dari CATEGORY_DEFS + 'all' -- tidak ada daftar duplikat.
const CATEGORY_ROUTE_KEYS = new Set([...CATEGORY_DEFS.map(({ key }) => key), 'all']);

/**
 * Satu pintu perpindahan halaman di dalam main. Hanya men-toggle atribut hidden
 * (tanpa pushState/reload), jadi tidak menyentuh hash maupun parameter auth.
 */
function showPage(page) {
  const pages = { home: homePage, search: searchPage, favorites: favoritesPage };
  const target = pages[page] || homePage;
  currentPageView = pages[page] ? page : 'home';
  homePage.hidden = target !== homePage;
  searchPage.hidden = target !== searchPage;
  if (favoritesPage) favoritesPage.hidden = target !== favoritesPage;
  syncFooterVisibility();
  window.scrollTo({ top: 0, behavior: 'auto' });
  return target;
}

/**
 * Mode tampilan di dalam halaman pencarian (satu kontainer, tanpa halaman baru):
 *   'options'  : kartu metode + panel + enam kategori (rute #/pencarian)
 *   'category' : hasil kategori saja (rute #/kategori/:key)
 * Hanya toggle atribut hidden -- DOM, router, dan mekanisme scroll tidak berubah.
 */
function setSearchView(mode) {
  const categoryMode = mode === 'category';
  searchOptionsSection.hidden = categoryMode;
  categorySection.hidden = categoryMode;
  searchPage.dataset.view = categoryMode ? 'category' : 'options';
}

/** Kembali ke tampilan pilihan metode (dan pastikan panel tertutup). */
function restoreOptionsView() {
  setSearchView('options');
  // Panel tidak boleh terbuka sendiri saat kembali ke #/pencarian.
  if (!ingredientPanel.hidden || !namePanel.hidden || pendingSearchMethod) {
    closeSearchPanels({ force: true });
  }
}

/**
 * Tampilan awal halaman Pencarian: dua metode + enam kategori, tanpa hasil lama.
 * Dipakai saat masuk dari halaman lain (Beranda/Favorit) -- hasil pencarian/kategori
 * dari kunjungan sebelumnya tidak boleh menempel di bawah kartu metode.
 * Tidak menghapus data apa pun: hanya menyembunyikan #resultsSection, yang tetap
 * dipakai lagi oleh showResults() saat pengguna mencari atau memilih kategori.
 */
function resetResultsView() {
  resultsSection.hidden = true;
  currentResults = [];
  currentResultsKind = null;
  currentCategoryKey = null;
  resultsTitle.textContent = 'Hasil Pencocokan Resep';
  resultsCount.textContent = '';
  resultsGrid.innerHTML = '';
  pagination.hidden = true;
  setActiveCategory(null);
}

/** Footer tampil di halaman pencarian/kategori dan halaman Favorit (C06), bukan di beranda. */
function syncFooterVisibility() {
  if (appFooter) appFooter.hidden = currentPageView !== 'search' && currentPageView !== 'favorites';
}

/**
 * Sebelum berpindah ke kategori: tutup metode pencarian yang sedang terbuka
 * (panel + highlight + aria-expanded), bukan sekadar menyembunyikannya.
 * Panel yang tertutup tidak pernah dibuka ulang oleh state tertunda.
 */
function resetSearchPanelsForNavigation() {
  closeSearchPanels({ force: true });
}

/** Logo sidebar & mobile bar kembali ke beranda lewat router yang sudah ada. */
function goHomeFromLogo() {
  navigateToPage('home');
}

/**
 * Satu-satunya jalan berpindah halaman: lewat router yang sudah ada.
 * Router yang menulis hash (kecuali saat ada parameter auth) dan memanggil
 * penangan rute; kalau hash sudah sama, penangan tetap dijalankan.
 */
function navigateToPage(page) {
  if (page === 'favorites') return navigate(ROUTE_FAVORITES);
  return navigate(page === 'search' ? ROUTE_SEARCH : ROUTE_HOME);
}

/** Penangan rute '#/beranda'. */
function showHomePage() {
  const leavingSearch = currentPageView === 'search';
  showPage('home');
  // Meninggalkan halaman pencarian: mode pilihan metode dipulihkan untuk kunjungan berikutnya.
  restoreOptionsView();
  // Hasil kategori/pencarian tidak dibawa saat Beranda -> Pencarian berikutnya.
  if (leavingSearch) resetResultsView();
}

/**
 * Penangan rute '#/pencarian': tampilan pilihan metode + enam kategori, panel tertutup.
 * Saat masuk dari halaman lain (Beranda/Favorit), hasil kategori/pencarian lama
 * di-reset; kalau sudah berada di halaman pencarian (mis. dari hasil ke opsi),
 * hasil yang sedang tampil dibiarkan.
 */
function showSearchPage() {
  // Reload langsung di #/kategori/:key lalu pindah ke #/pencarian: halaman sudah
  // 'search', tapi yang tampil masih view kategori -> anggap masuk dari halaman lain.
  const enteringFromOtherPage = currentPageView !== 'search' || searchPage.dataset.view === 'category';
  showPage('search');
  restoreOptionsView();
  if (enteringFromOtherPage) resetResultsView();
  sidebarApi?.setActive({ section: 'search' });
}

/** Penangan rute '#/favorit': halaman mandiri (bukan modal), dari halaman 1. */
function showFavoritesPage() {
  showPage('favorites');
  renderFavoritesPage({ resetPage: true });
  sidebarApi?.setActive({ section: 'favorites' });
}

/**
 * Penangan rute '#/kategori/:key'. Key yang dikenal (termasuk 'all') dirender lewat
 * showCategory(); key tak dikenal hanya menampilkan halaman pencarian apa adanya.
 */
function showCategoryPage({ key } = {}) {
  // Reload / URL dibuka langsung: resep belum siap, jadi key diingat dulu dan
  // diterapkan setelah loadRecipes() selesai (lihat restorePendingCategory()).
  // Urutan ini diperiksa lebih dulu karena saat init belum ada hasil yang bisa dibandingkan.
  if (!recipesReady) {
    pendingCategoryKey = key;
    showPage('search');
    setSearchView('category'); // deep link kategori: blok metode/kategori tidak tampil di atas judul
    if (CATEGORY_ROUTE_KEYS.has(key) && key !== 'all') {
      sidebarApi?.setActive({ section: 'category', categoryKey: key });
    }
    return;
  }

  if (!CATEGORY_ROUTE_KEYS.has(key)) {
    // Key di luar data aplikasi: jangan redirect, tampilkan daftar kategori apa adanya.
    showPage('search');
    restoreOptionsView();
    if (currentResultsKind === 'category') {
      setActiveCategory(currentCategoryKey === 'all' ? null : currentCategoryKey);
      sidebarApi?.setActive({ section: 'category', categoryKey: currentCategoryKey === 'all' ? null : currentCategoryKey });
    } else {
      sidebarApi?.setActive({ section: 'search' });
    }
    return;
  }
  // 'all' diperlakukan sama seperti kategori lain: tampilkan seluruh resep
  // dengan judul "Semua Resep" (showCategory sudah menangani key 'all').

  // Kategori yang sama sudah tampil (mis. Forward ke kategori yang tidak berubah):
  // jangan render ulang, cukup pulihkan halaman + status aktif seperti kondisi semula.
  if (currentResultsKind === 'category' && currentCategoryKey === key) {
    showPage('search');
    setSearchView('category');
    setActiveCategory(key);
    sidebarApi?.setActive({ section: 'category', categoryKey: key });
    return;
  }
  showCategory(key);
}

/**
 * Terapkan kategori yang tertunda setelah data resep siap (reload pada #/kategori/:key).
 * - Hash sudah sesuai -> tidak perlu menulis URL lagi.
 * - Kategori ada di CATEGORY_DEFS (termasuk 'all') -> dirender lewat showCategory().
 * - Key tak dikenal -> kembali ke '#/pencarian' biasa.
 */
function restorePendingCategory() {
  if (!pendingCategoryKey) return;
  const key = pendingCategoryKey;
  pendingCategoryKey = null;

  if (!CATEGORY_ROUTE_KEYS.has(key)) {
    showSearchPage();
    return;
  }
  // Termasuk 'all': pulihkan daftar seluruh resep setelah reload.
  showCategory(key);
}

/** Tombol "Mulai Cari" di hero: beranda -> halaman pencarian. */
function startSearch() {
  navigateToPage('search');
}

/** Tombol kembali di halaman pencarian: pencarian -> beranda. */
function backToHome() {
  navigateToPage('home');
}

/** Turun ke bagian yang ada di bawah dua halaman (kategori / hasil). */
function scrollToSection(selector) {
  if (currentPageView !== 'search') showPage('search');
  // Menu Kategori di sidebar yang mengarah ke daftar kategori = tampilan pilihan metode.
  restoreOptionsView();
  document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sidebarApi?.setActive({ section: 'search' });
}

function goToCategoriesSection() {
  scrollToSection('.category-section');
}

/** Dipakai setelah hasil ditampilkan: kalau pengguna mengubah metode dari panel, tetap di halaman pencarian. */
function ensureSearchPage() {
  if (currentPageView !== 'search') showPage('search');
}



function totalPages() {
  return Math.max(1, Math.ceil(currentResults.length / PAGE_SIZE));
}

function renderResultsPage() {
  if (currentResults.length === 0) {
    // Live region tetap diisi supaya pembaca layar tahu hasil berubah menjadi kosong
    // (tanpa memasang aria-live pada grid kartu yang isinya banyak).
    resultsCount.textContent = `0 resep. ${currentEmptyMessage}`;
    pagination.hidden = true;
    renderRecipeGrid(resultsGrid, [], currentEmptyMessage);
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, currentResults.length);
  const pageItems = currentResults.slice(start, end);

  resultsCount.textContent = `Menampilkan ${start + 1}\u2013${end} dari ${currentResults.length} resep`;
  renderRecipeGrid(resultsGrid, pageItems, currentEmptyMessage);

  const pages = totalPages();
  pagination.hidden = pages <= 1;
  paginationInfo.textContent = `Halaman ${currentPage} dari ${pages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pages;
}

function goToPage(page) {
  const pages = totalPages();
  currentPage = Math.min(Math.max(1, page), pages);
  renderResultsPage();
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ==========================================================================
// RENDERING KARTU RESEP (dipakai untuk hasil generator & daftar favorit)
// ==========================================================================

function renderFavoriteButton(recipe) {
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'recipe-card-fav';
  favBtn.dataset.id = recipe.id;
  favBtn.dataset.source = recipe.source || 'huggingface';
  const fav = isFavorite(recipe.id);
  favBtn.textContent = fav ? '\u2665' : '\u2661'; // ♥ / ♡
  favBtn.classList.toggle('is-fav', fav);
  favBtn.setAttribute('aria-label', fav ? 'Hapus dari favorit' : 'Tambahkan ke favorit');
  return favBtn;
}

function renderRecipeCard(recipe) {
  const card = document.createElement('div');
  card.className = 'recipe-card';
  card.dataset.id = recipe.id;
  card.dataset.source = recipe.source || 'huggingface';

  const top = document.createElement('div');
  top.className = 'recipe-card-top';

  const catLabel = document.createElement('span');
  catLabel.className = 'recipe-card-category';
  catLabel.textContent = formatCategoryLabel(recipe.category);

  top.append(catLabel, renderFavoriteButton(recipe));

  const title = document.createElement('h3');
  title.className = 'recipe-card-title';
  title.textContent = recipe.title;

  card.append(top, title);

  if (typeof recipe.matchPercentage === 'number') {
    const match = document.createElement('div');
    match.className = 'recipe-card-match' + (recipe.matchPercentage < 100 ? ' partial' : '');
    match.textContent = `${recipe.matchPercentage}% Cocok`;
    card.appendChild(match);

    const meta = document.createElement('div');
    meta.className = 'recipe-card-meta';
    meta.textContent = `${recipe.matchedCount} dari ${recipe.totalCount} bahan cocok`;
    card.appendChild(meta);
  }

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'recipe-card-btn';
  viewBtn.dataset.id = recipe.id;
  viewBtn.dataset.source = recipe.source || 'huggingface';
  viewBtn.dataset.action = 'view';
  viewBtn.textContent = 'Lihat Resep';
  card.appendChild(viewBtn);

  return card;
}

function renderRecipeGrid(container, list, emptyMessage) {
  container.innerHTML = '';

  if (!list || list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.textContent = emptyMessage;
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  // Lapisan pengaman terakhir: dedup per sumber (lihat dedupeAcrossSources).
  const fragment = document.createDocumentFragment();
  for (const recipe of dedupeAcrossSources(list)) {
    fragment.appendChild(renderRecipeCard(recipe));
  }
  container.appendChild(fragment);
}

// ==========================================================================
// FAVORIT
// ==========================================================================

function updateFavoritesBadge() {
  favoritesCountBadge.textContent = getFavoritesCount();
}

function handleToggleFavorite(id) {
  const nowFav = toggleFavorite(id); // favorites.js menerima number maupun UUID string
  updateFavoritesBadge();
  showToast(nowFav ? 'Ditambahkan ke favorit' : 'Dihapus dari favorit');

  // Sinkronkan semua tombol hati yang sedang tampil untuk resep ini
  // (bisa muncul di grid hasil, grid favorit, dan modal detail sekaligus).
  document.querySelectorAll(`.recipe-card-fav[data-id="${id}"]`).forEach((btn) => {
    btn.textContent = nowFav ? '\u2665' : '\u2661';
    btn.classList.toggle('is-fav', nowFav);
    btn.setAttribute('aria-label', nowFav ? 'Hapus dari favorit' : 'Tambahkan ke favorit');
  });
  const detailFavBtn = document.getElementById('detailFavBtn');
  if (detailFavBtn && String(detailFavBtn.dataset.id) === String(id)) {
    syncDetailFavButton(detailFavBtn, id);
  }

  // Kalau halaman Favorit sedang tampil, re-render grid + pagination-nya.
  if (currentPageView === 'favorites') renderFavoritesPage();
}

const FAVORITES_PAGE_SIZE = 10; // maksimal 10 kartu per halaman di halaman Favorit
// Indeks halaman aktif (1-based). Sengaja dinamai berbeda dari elemen #favoritesPage
// supaya tidak membayangi/menimpa referensi DOM-nya.
let favoritesPageIndex = 1;

/** Daftar resep favorit (urutan sesuai penyimpanan), dicocokkan per ID & sumber. */
function getFavoriteRecipes() {
  const ids = getFavorites();
  const lookup = getPublicRecipes();
  // ID numerik = resep Hugging Face, UUID = resep Supabase. Dicocokkan per sumber
  // supaya tidak tertukar; dedup hanya di dalam sumber yang sama.
  return ids
    .map((id) => lookup.find((r) => r.id === id || String(r.id) === String(id)))
    .filter(Boolean);
}

/**
 * Render halaman Favorit: judul/count, grid (maks 10 kartu), dan pagination.
 * Kalau penghapusan membuat halaman aktif melewati batas, pindah ke halaman terakhir.
 */
function renderFavoritesPage({ resetPage = false } = {}) {
  const recipes = getFavoriteRecipes();
  const total = recipes.length;
  const pages = Math.max(1, Math.ceil(total / FAVORITES_PAGE_SIZE));

  if (resetPage) favoritesPageIndex = 1;
  favoritesPageIndex = Math.min(Math.max(1, favoritesPageIndex), pages); // tidak pernah halaman kosong

  const start = (favoritesPageIndex - 1) * FAVORITES_PAGE_SIZE;
  const pageItems = recipes.slice(start, start + FAVORITES_PAGE_SIZE);

  favoritesPageCount.textContent = total === 0 ? '' : `${total} resep favorit`;
  renderRecipeGrid(
    favoritesPageGrid,
    pageItems,
    'Belum ada resep favorit. Tekan ♡ pada kartu resep untuk menyimpannya.'
  );

  favoritesPagination.hidden = pages <= 1;
  favoritesPaginationInfo.textContent = `Halaman ${favoritesPageIndex} dari ${pages}`;
  favoritesPrevPageBtn.disabled = favoritesPageIndex <= 1;
  favoritesNextPageBtn.disabled = favoritesPageIndex >= pages;
}

function goToFavoritesPage(page) {
  const total = getFavoriteRecipes().length;
  const pages = Math.max(1, Math.ceil(total / FAVORITES_PAGE_SIZE));
  favoritesPageIndex = Math.min(Math.max(1, page), pages);
  renderFavoritesPage();
}

// ==========================================================================
// DETAIL MODAL
// ==========================================================================

function syncDetailFavButton(favBtn, id) {
  const fav = isFavorite(id);
  favBtn.textContent = fav ? '\u2665 Hapus dari Favorit' : '\u2661 Tambah ke Favorit';
  favBtn.classList.toggle('is-fav', fav);
}

/**
 * Gambar resep. Database saat ini TIDAK menyediakan gambar, jadi yang tampil
 * adalah ilustrasi placeholder (ikon + warna kategori) -- bukan gambar karangan.
 * Kalau suatu saat database punya field gambar, otomatis dipakai.
 */
function buildDetailMedia(recipe) {
  const media = document.createElement('div');
  media.className = 'detail-media';

  if (isSafeUrl(recipe.image)) {
    const img = document.createElement('img');
    img.src = recipe.image;
    img.alt = recipe.title;
    img.loading = 'lazy';
    media.appendChild(img);
    return media;
  }

  const def = getPrimaryCategoryDef(recipe);
  media.classList.add('is-placeholder');
  if (def) media.style.setProperty('--cat-color', def.color);
  media.setAttribute('role', 'img');
  media.setAttribute('aria-label', `Ilustrasi ${recipe.title}`);
  const icon = document.createElement('span');
  icon.className = 'detail-media-icon';
  icon.textContent = def ? def.icon : '\ud83c\udf7d\ufe0f';
  media.appendChild(icon);
  return media;
}

function buildDetailContent(recipe) {
  const wrap = document.createElement('div');
  wrap.appendChild(buildDetailMedia(recipe));

  const header = document.createElement('div');
  header.className = 'detail-header';

  const topRow = document.createElement('div');
  topRow.className = 'detail-top-row';

  const catBadge = document.createElement('span');
  catBadge.className = 'detail-category';
  catBadge.textContent = formatCategoryLabel(recipe.category);

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.id = 'detailFavBtn';
  favBtn.className = 'recipe-card-fav recipe-card-fav-labeled';
  favBtn.dataset.id = recipe.id;
  syncDetailFavButton(favBtn, recipe.id);
  favBtn.addEventListener('click', () => handleToggleFavorite(recipe.id));

  topRow.append(catBadge, favBtn);

  const title = document.createElement('h3');
  title.className = 'detail-title';
  title.textContent = recipe.title;

  const stats = document.createElement('div');
  stats.className = 'detail-stats';
  stats.innerHTML =
    (recipe.totalIngredients != null ? `<span>🧂 ${recipe.totalIngredients} bahan</span>` : '') +
    (recipe.totalSteps != null ? `<span>📋 ${recipe.totalSteps} langkah</span>` : '') +
    `<span>🏷️ ${formatCategoryLabel(recipe.category)}</span>` +
    (recipe.difficulty ? `<span>🎚️ ${toTitleCase(recipe.difficulty)}</span>` : '') +
    (recipe.timeMinutes != null ? `<span>⏱️ ${recipe.timeMinutes} menit</span>` : '') +
    (recipe.region ? `<span>📍 ${recipe.region}</span>` : '');

  header.append(topRow, title, stats);

  // Bahan -- data dari API sudah berupa array, tidak perlu di-parse lagi
  const ingredientsParsed = recipe.ingredientsFull || [];
  const ingSection = document.createElement('div');
  ingSection.className = 'detail-section';
  const ingHeading = document.createElement('h3');
  ingHeading.textContent = 'Bahan';
  const ingList = document.createElement('ul');
  ingList.className = 'ingredient-list';
  if (ingredientsParsed.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Data bahan tidak tersedia untuk resep ini.';
    ingList.appendChild(li);
  } else {
    for (const item of ingredientsParsed) {
      const li = document.createElement('li');
      li.textContent = item;
      ingList.appendChild(li);
    }
  }
  ingSection.append(ingHeading, ingList);

  // Langkah -- sama, sudah array langsung dari API
  const steps = recipe.stepsFull || [];
  const stepSection = document.createElement('div');
  stepSection.className = 'detail-section';
  const stepHeading = document.createElement('h3');
  stepHeading.textContent = 'Cara Memasak';
  const stepList = document.createElement('ol');
  stepList.className = 'step-list';
  if (steps.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Data langkah tidak tersedia untuk resep ini.';
    stepList.appendChild(li);
  } else {
    for (const step of steps) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = step;
      li.appendChild(span);
      stepList.appendChild(li);
    }
  }
  stepSection.append(stepHeading, stepList);

  // Aksi: sumber resep
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (isSafeUrl(recipe.url)) {
    const sourceLink = document.createElement('a');
    sourceLink.href = recipe.url;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.className = 'btn btn-primary';
    sourceLink.textContent = 'Lihat Sumber';
    actions.appendChild(sourceLink);
  }

  wrap.append(header, ingSection, stepSection, actions);
  return wrap;
}

function openDetailModal(id, source = 'huggingface', trigger) {
  // Sumber ikut menentukan identitas: ID numerik (HF) vs UUID (Supabase).
  const recipe = findPublicRecipe({ source, id });
  if (!recipe) {
    showToast('Resep tidak ditemukan.');
    return;
  }
  detailModalTitle.textContent = recipe.title;
  detailModalBody.innerHTML = '';
  detailModalBody.appendChild(buildDetailContent(recipe));
  detailModal.hidden = false;
  enterModal(detailModal, detailModal.querySelector('.modal-close'), trigger);
}

function closeDetail() {
  if (!detailModal || detailModal.hidden) return;
  detailModal.hidden = true;
  exitModal(detailModal);
}

// ==========================================================================
// TAMBAH RESEP (modal + form + chip). Tidak menyentuh cache/data Hugging Face.
// ==========================================================================

const addRecipeItems = { ingredients: [], steps: [] }; // state array form
let addRecipeSaving = false;

/** Isi pilihan kategori dari kategori aplikasi + nilai dataset yang dipakai. */
function fillCategoryOptions(target = addRecipeCategory) {
  if (!target || target.dataset.categoryFilled === '1') return;
  target.dataset.categoryFilled = '1';
  const fragment = document.createDocumentFragment();
  CATEGORY_OPTIONS.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fragment.appendChild(option);
  });
  target.appendChild(fragment);
}

/** Tampilkan pesan status di dalam modal Tambah Resep. */
function setAddRecipeStatus(text = '', type = 'is-info') {
  if (!addRecipeStatus) return;
  addRecipeStatus.textContent = text;
  ['is-error', 'is-success', 'is-info'].forEach((cls) => {
    addRecipeStatus.classList.toggle(cls, cls === type);
  });
}

function setAddRecipeBusy(isBusy) {
  if (addRecipeSubmitBtn) addRecipeSubmitBtn.disabled = isBusy;
  if (addRecipeModal) {
    if (isBusy) addRecipeModal.setAttribute('aria-busy', 'true');
    else addRecipeModal.removeAttribute('aria-busy');
  }
}

function renderAddRecipeItems(field) {
  const container = el(field === 'ingredients' ? 'addRecipeIngredientList' : 'addRecipeStepList');
  if (!container) return;
  container.innerHTML = '';
  const list = addRecipeItems[field];

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chips-empty';
    empty.textContent = field === 'ingredients' ? 'Belum ada bahan.' : 'Belum ada langkah.';
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  list.forEach((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';

    const label = document.createElement('span');
    label.textContent = item; // textContent -> aman dari input pengguna
    if (field === 'steps') label.textContent = `${index + 1}. ${item}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.setAttribute('aria-label', `Hapus ${field === 'ingredients' ? 'bahan' : 'langkah'} ${item}`);
    removeBtn.dataset.index = index;
    removeBtn.dataset.field = field;

    chip.append(label, removeBtn);
    fragment.appendChild(chip);
  });
  container.appendChild(fragment);
}

/** Tambah item dari input ke list; return true bila berhasil. */
function addRecipeItem(field) {
  const input = el(field === 'ingredients' ? 'addRecipeIngredientInput' : 'addRecipeStepInput');
  if (!input) return false;
  const value = cleanText(input.value);
  if (!value) return false;
  if (value.length > ITEM_MAX_LENGTH) {
    setAddRecipeStatus(`Setiap ${field === 'ingredients' ? 'bahan' : 'langkah'} maksimal ${ITEM_MAX_LENGTH} karakter.`, 'is-error');
    return false;
  }
  addRecipeItems[field].push(value);
  input.value = '';
  renderAddRecipeItems(field);
  setAddRecipeStatus('');
  return true;
}

function openAddRecipe(trigger) {
  if (!addRecipeModal) return;
  fillCategoryOptions();
  setAddRecipeStatus('');
  addRecipeModal.hidden = false;
  enterModal(addRecipeModal, addRecipeTitle, trigger);
}

function closeAddRecipe(force = false) {
  if (!addRecipeModal || addRecipeModal.hidden) return;
  // Jangan tutup saat proses simpan berjalan, KECUALI dipaksa oleh alur sukses
  // (force) yang memanggilnya selagi addRecipeSaving masih true.
  if (addRecipeSaving && !force) return;
  addRecipeModal.hidden = true;
  resetAddRecipeForm();
  exitModal(addRecipeModal);
}

function resetAddRecipeForm() {
  if (addRecipeForm) addRecipeForm.reset();
  addRecipeItems.ingredients = [];
  addRecipeItems.steps = [];
  renderAddRecipeItems('ingredients');
  renderAddRecipeItems('steps');
  setAddRecipeStatus('');
  setAddRecipeBusy(false);
}

async function handleAddRecipeSubmit(event) {
  event.preventDefault();
  if (addRecipeSaving) return; // cegah submit ganda

  const input = {
    title: addRecipeTitle ? addRecipeTitle.value : '',
    category: addRecipeCategory ? addRecipeCategory.value : '',
    description: addRecipeDescription ? addRecipeDescription.value : '',
    imageUrl: addRecipeImageUrl ? addRecipeImageUrl.value : '',
    ingredients: cleanItems(addRecipeItems.ingredients),
    steps: cleanItems(addRecipeItems.steps),
  };

  addRecipeSaving = true;
  setAddRecipeBusy(true);
  setAddRecipeStatus('Menyimpan resep...', 'is-info');

  try {
    const result = await saveRecipe(input);
    if (!result.ok) {
      setAddRecipeStatus(result.message, 'is-error');
      return;
    }
    // Sukses terverifikasi (status approved) -> satu notifikasi saja.
    // Tutup lewat closeAddRecipe() agar exitModal()/syncBackgroundInert() selalu
    // dijalankan. Jangan set hidden langsung: #appShell akan tetap inert.
    resetAddRecipeForm();
    closeAddRecipe(true);
    showToast('Resep berhasil ditambahkan.');
    refreshPublicSupabase();
  } catch (err) {
    console.warn('[add-recipe] Gagal menyimpan resep:', (err && err.message) || err);
    setAddRecipeStatus('Resep belum berhasil disimpan. Silakan coba lagi.', 'is-error');
  } finally {
    addRecipeSaving = false;
    setAddRecipeBusy(false);
  }
}

// ==========================================================================
// RESEP SAYA (Supabase)
// Daftar terpisah dari recipesCache: ID-nya UUID, bukan ID numerik Hugging Face.
// Tidak memakai getRecipeById/renderRecipeCard/renderRecipeGrid/dedup.
// ==========================================================================

let myRecipes = [];       // resep Supabase milik user (sudah dinormalisasi)
let myRecipesLoading = false;
let myRecipesRequestId = 0; // menandai request aktif; hasil request lama diabaikan

function setMyRecipesStatus(text = '', type = 'is-info') {
  if (!myRecipesStatus) return;
  myRecipesStatus.textContent = text;
  ['is-error', 'is-success', 'is-info'].forEach((cls) => {
    myRecipesStatus.classList.toggle(cls, cls === type);
  });
}

function setMyRecipesRetry(visible) {
  if (myRecipesRetryBtn) myRecipesRetryBtn.hidden = !visible;
}

function renderMyRecipesEmpty(text) {
  if (!myRecipesGrid) return;
  myRecipesGrid.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const p = document.createElement('p');
  p.textContent = text;
  empty.appendChild(p);
  myRecipesGrid.appendChild(empty);
}

const editRecipeModal = el('editRecipeModal');
const editRecipeForm = el('editRecipeForm');
const editRecipeTitle = el('editRecipeTitle');
const editRecipeCategory = el('editRecipeCategory');
const editRecipeDescription = el('editRecipeDescription');
const editRecipeImageUrl = el('editRecipeImageUrl');
const editRecipeSubmitBtn = el('editRecipeSubmitBtn');
const editRecipeStatus = el('editRecipeStatus');
const deleteRecipeModal = el('deleteRecipeModal');
const deleteRecipeName = el('deleteRecipeName');
const deleteRecipeStatus = el('deleteRecipeStatus');
const confirmDeleteRecipeBtn = el('confirmDeleteRecipeBtn');
const cancelDeleteRecipeBtn = el('cancelDeleteRecipeBtn');

function renderMyRecipeCard(recipe) {
  const card = document.createElement('div');
  card.className = 'recipe-card';
  card.dataset.id = recipe.id; // UUID tetap string

  const top = document.createElement('div');
  top.className = 'recipe-card-top';

  const catLabel = document.createElement('span');
  catLabel.className = 'recipe-card-category';
  catLabel.textContent = formatCategoryLabel(recipe.category);
  top.appendChild(catLabel);

  const title = document.createElement('h3');
  title.className = 'recipe-card-title';
  title.textContent = recipe.title;

  const meta = document.createElement('div');
  meta.className = 'recipe-card-meta';
  meta.textContent = `${recipe.ingredientsFull.length} bahan \u00b7 ${recipe.stepsFull.length} langkah`;

  const actions = document.createElement('div');
  actions.className = 'recipe-card-actions';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'recipe-card-btn btn btn-secondary btn-sm';
  viewBtn.dataset.id = recipe.id;
  viewBtn.dataset.action = 'view';
  viewBtn.textContent = 'Lihat Resep';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'recipe-card-btn btn btn-secondary btn-sm';
  editBtn.dataset.id = recipe.id;
  editBtn.dataset.action = 'edit';
  editBtn.textContent = 'Edit';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'recipe-card-btn btn btn-secondary btn-sm recipe-card-btn-danger';
  deleteBtn.dataset.id = recipe.id;
  deleteBtn.dataset.action = 'delete';
  deleteBtn.textContent = 'Hapus';

  actions.append(viewBtn, editBtn, deleteBtn);
  card.append(top, title, meta, actions);
  return card;
}

function renderMyRecipesGrid() {
  if (!myRecipesGrid) return;
  myRecipesGrid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  // Tanpa dedup: dua resep berjudul sama tetap tampil, kuncinya UUID.
  for (const recipe of myRecipes) fragment.appendChild(renderMyRecipeCard(recipe));
  myRecipesGrid.appendChild(fragment);
}

async function loadMyRecipes() {
  const requestId = ++myRecipesRequestId;
  myRecipesLoading = true;
  setMyRecipesStatus('Memuat resep...', 'is-info');
  setMyRecipesRetry(false);
  renderMyRecipesEmpty('Memuat resep...');

  const result = await fetchMyRecipes();

  // Modal ditutup / request lebih baru dimulai -> abaikan hasil request lama.
  if (requestId !== myRecipesRequestId || myRecipesLoading === false) return;
  myRecipesLoading = false;

  if (!result.ok) {
    setMyRecipesStatus(
      result.code === MY_ERR_NOT_SIGNED_IN ? 'Silakan masuk terlebih dahulu untuk melihat resepmu.' : result.message,
      'is-error'
    );
    setMyRecipesRetry(result.code !== MY_ERR_NOT_SIGNED_IN);
    const emptyText = result.code === MY_ERR_NOT_SIGNED_IN
      ? 'Kamu belum masuk ke akun.'
      : 'Resep belum dapat dimuat.';
    renderMyRecipesEmpty(emptyText);
    return;
  }

  myRecipes = result.recipes;
  if (myRecipes.length === 0) {
    setMyRecipesStatus('Kamu belum menambahkan resep.', 'is-info');
    renderMyRecipesEmpty('Kamu belum menambahkan resep. Gunakan menu Tambah Resep untuk memulai.');
    return;
  }

  setMyRecipesStatus(`${myRecipes.length} resep milikmu.`, 'is-success');
  renderMyRecipesGrid();
}

async function openMyRecipes(trigger) {
  if (!myRecipesModal) return;
  myRecipesModal.hidden = false;
  enterModal(myRecipesModal, myRecipesModal.querySelector('.modal-close'), trigger);
  // Sidebar tidak diubah: menu tidak diberi status aktif khusus untuk modal ini.
  await loadMyRecipes();
}

function closeMyRecipes() {
  if (!myRecipesModal || myRecipesModal.hidden) return;
  myRecipesModal.hidden = true;
  myRecipesRequestId += 1; // batalkan hasil request yang masih berjalan
  myRecipesLoading = false;
  myRecipes = [];
  if (myRecipesGrid) myRecipesGrid.innerHTML = '';
  setMyRecipesStatus('');
  setMyRecipesRetry(false);
  exitModal(myRecipesModal);
}

/** Detail resep Supabase: dibangun ulang, tidak memakai buildDetailContent() (kontrak ID numerik). */
function buildMyRecipeDetail(recipe) {
  const wrap = document.createElement('div');

  const media = document.createElement('div');
  media.className = 'detail-media';
  if (isSafeUrl(recipe.imageUrl)) {
    const img = document.createElement('img');
    img.src = recipe.imageUrl;
    img.alt = recipe.title;
    img.loading = 'lazy';
    media.appendChild(img);
  } else {
    const def = getPrimaryCategoryDef({ category: recipe.category, title: recipe.title, titleKey: recipe.title });
    media.classList.add('is-placeholder');
    if (def) media.style.setProperty('--cat-color', def.color);
    media.setAttribute('role', 'img');
    media.setAttribute('aria-label', `Ilustrasi ${recipe.title}`);
    const icon = document.createElement('span');
    icon.className = 'detail-media-icon';
    icon.textContent = def ? def.icon : '\ud83c\udf7d\ufe0f';
    media.appendChild(icon);
  }
  wrap.appendChild(media);

  const header = document.createElement('div');
  header.className = 'detail-header';
  const topRow = document.createElement('div');
  topRow.className = 'detail-top-row';
  const catBadge = document.createElement('span');
  catBadge.className = 'detail-category';
  catBadge.textContent = formatCategoryLabel(recipe.category);
  topRow.appendChild(catBadge);

  const title = document.createElement('h3');
  title.className = 'detail-title';
  title.textContent = recipe.title;

  const stats = document.createElement('div');
  stats.className = 'detail-stats';
  const statIng = document.createElement('span');
  statIng.textContent = `\ud83e\uddc2 ${recipe.ingredientsFull.length} bahan`;
  const statStep = document.createElement('span');
  statStep.textContent = `\ud83d\udccb ${recipe.stepsFull.length} langkah`;
  const statCat = document.createElement('span');
  statCat.textContent = `\ud83c\udff7\ufe0f ${formatCategoryLabel(recipe.category)}`;
  stats.append(statIng, statStep, statCat);

  header.append(topRow, title, stats);
  wrap.appendChild(header);

  if (recipe.description) {
    const descSection = document.createElement('div');
    descSection.className = 'detail-section';
    const descHeading = document.createElement('h3');
    descHeading.textContent = 'Deskripsi';
    const descText = document.createElement('p');
    descText.textContent = recipe.description;
    descSection.append(descHeading, descText);
    wrap.appendChild(descSection);
  }

  const ingSection = document.createElement('div');
  ingSection.className = 'detail-section';
  const ingHeading = document.createElement('h3');
  ingHeading.textContent = 'Bahan';
  const ingList = document.createElement('ul');
  ingList.className = 'ingredient-list';
  if (recipe.ingredientsFull.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Data bahan tidak tersedia untuk resep ini.';
    ingList.appendChild(li);
  } else {
    for (const item of recipe.ingredientsFull) {
      const li = document.createElement('li');
      li.textContent = item;
      ingList.appendChild(li);
    }
  }
  ingSection.append(ingHeading, ingList);
  wrap.appendChild(ingSection);

  const stepSection = document.createElement('div');
  stepSection.className = 'detail-section';
  const stepHeading = document.createElement('h3');
  stepHeading.textContent = 'Cara Memasak';
  const stepList = document.createElement('ol');
  stepList.className = 'step-list';
  if (recipe.stepsFull.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Data langkah tidak tersedia untuk resep ini.';
    stepList.appendChild(li);
  } else {
    for (const step of recipe.stepsFull) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = step;
      li.appendChild(span);
      stepList.appendChild(li);
    }
  }
  stepSection.append(stepHeading, stepList);
  wrap.appendChild(stepSection);

  return wrap;
}

function openMyRecipeDetail(id, trigger) {
  // Utamakan daftar milik pengguna; kalau detail dibuka dari hasil pencarian,
  // pakai resep publik Supabase yang sudah digabung.
  const recipe = myRecipes.find((r) => r.id === id)
    || getPublicRecipes().find((r) => r.source === 'supabase' && r.id === id);
  if (!recipe) {
    showToast('Resep tidak ditemukan.');
    return;
  }
  if (!myRecipeDetailModal) return;
  myRecipeDetailTitle.textContent = recipe.title;
  myRecipeDetailBody.innerHTML = '';
  myRecipeDetailBody.appendChild(buildMyRecipeDetail(recipe));
  myRecipeDetailModal.hidden = false;
  enterModal(myRecipeDetailModal, myRecipeDetailModal.querySelector('.modal-close'), trigger);
}

function closeMyRecipeDetail() {
  if (!myRecipeDetailModal || myRecipeDetailModal.hidden) return;
  myRecipeDetailModal.hidden = true;
  myRecipeDetailBody.innerHTML = '';
  exitModal(myRecipeDetailModal);
}

// ==========================================================================
// EDIT & HAPUS RESEP SAYA (UUID Supabase; hanya milik pengguna aktif)
// ==========================================================================

const editRecipeItems = { ingredients: [], steps: [] };
let editRecipeId = null;      // UUID resep yang sedang diedit
let editRecipeSaving = false;
let deleteRecipeId = null;    // UUID resep yang menunggu konfirmasi
let deleteRecipeBusy = false;

function setEditRecipeStatus(text = '', type = 'is-info') {
  if (!editRecipeStatus) return;
  editRecipeStatus.textContent = text;
  ['is-error', 'is-success', 'is-info'].forEach((cls) => editRecipeStatus.classList.toggle(cls, cls === type));
}

function setEditRecipeBusy(isBusy) {
  if (editRecipeSubmitBtn) editRecipeSubmitBtn.disabled = isBusy;
  if (editRecipeModal) {
    if (isBusy) editRecipeModal.setAttribute('aria-busy', 'true');
    else editRecipeModal.removeAttribute('aria-busy');
  }
}

function renderEditRecipeItems(field) {
  const container = el(field === 'ingredients' ? 'editRecipeIngredientList' : 'editRecipeStepList');
  if (!container) return;
  container.innerHTML = '';
  const list = editRecipeItems[field];
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chips-empty';
    empty.textContent = field === 'ingredients' ? 'Belum ada bahan.' : 'Belum ada langkah.';
    container.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  list.forEach((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = field === 'steps' ? `${index + 1}. ${item}` : item;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.setAttribute('aria-label', `Hapus ${field === 'ingredients' ? 'bahan' : 'langkah'} ${item}`);
    removeBtn.dataset.index = index;
    chip.append(label, removeBtn);
    fragment.appendChild(chip);
  });
  container.appendChild(fragment);
}

function addEditRecipeItem(field) {
  const input = el(field === 'ingredients' ? 'editRecipeIngredientInput' : 'editRecipeStepInput');
  if (!input) return false;
  const value = cleanText(input.value);
  if (!value) return false;
  if (value.length > ITEM_MAX_LENGTH) {
    setEditRecipeStatus(`Setiap ${field === 'ingredients' ? 'bahan' : 'langkah'} maksimal ${ITEM_MAX_LENGTH} karakter.`, 'is-error');
    return false;
  }
  editRecipeItems[field].push(value);
  input.value = '';
  renderEditRecipeItems(field);
  setEditRecipeStatus('');
  return true;
}

/** Buka form edit dengan data resep yang sudah ada di state myRecipes. */
function openEditRecipe(id, trigger) {
  const recipe = myRecipes.find((r) => r.id === id);
  if (!recipe || !editRecipeModal) return;
  editRecipeId = recipe.id;
  fillCategoryOptions(editRecipeCategory);
  editRecipeTitle.value = recipe.title === 'Resep Tanpa Nama' ? '' : recipe.title;
  editRecipeCategory.value = [...editRecipeCategory.options].some((o) => o.value === recipe.category)
    ? recipe.category
    : '';
  editRecipeDescription.value = recipe.description;
  editRecipeImageUrl.value = recipe.imageUrl;
  editRecipeItems.ingredients = [...recipe.ingredientsFull];
  editRecipeItems.steps = [...recipe.stepsFull];
  renderEditRecipeItems('ingredients');
  renderEditRecipeItems('steps');
  setEditRecipeStatus('');
  setEditRecipeBusy(false);
  editRecipeModal.hidden = false;
  enterModal(editRecipeModal, editRecipeTitle, trigger);
}

function closeEditRecipe() {
  if (!editRecipeModal || editRecipeModal.hidden) return;
  if (editRecipeSaving) return; // jangan tutup saat proses simpan berjalan
  editRecipeModal.hidden = true;
  editRecipeId = null;
  editRecipeItems.ingredients = [];
  editRecipeItems.steps = [];
  setEditRecipeStatus('');
  exitModal(editRecipeModal);
}

async function handleEditRecipeSubmit(event) {
  event.preventDefault();
  if (editRecipeSaving || !editRecipeId) return;

  const input = {
    title: editRecipeTitle ? editRecipeTitle.value : '',
    category: editRecipeCategory ? editRecipeCategory.value : '',
    description: editRecipeDescription ? editRecipeDescription.value : '',
    imageUrl: editRecipeImageUrl ? editRecipeImageUrl.value : '',
    ingredients: cleanItems(editRecipeItems.ingredients),
    steps: cleanItems(editRecipeItems.steps),
  };

  const id = editRecipeId;
  editRecipeSaving = true;
  setEditRecipeBusy(true);
  setEditRecipeStatus('Menyimpan perubahan...', 'is-info');

  try {
    const result = await updateRecipe(id, input);
    if (!result.ok) {
      setEditRecipeStatus(result.message, 'is-error');
      return;
    }
    // Ganti item di daftar Resep Saya tanpa memuat ulang semuanya.
    const index = myRecipes.findIndex((r) => r.id === result.recipe.id);
    if (index >= 0) myRecipes[index] = result.recipe;
    renderMyRecipesGrid();
    editRecipeSaving = false;
    closeEditRecipe();
    showToast('Perubahan resep disimpan.');
    refreshPublicSupabase();
  } catch (err) {
    console.warn('[my-recipes] Edit resep gagal:', (err && err.message) || err);
    setEditRecipeStatus('Resep belum berhasil diperbarui. Silakan coba lagi.', 'is-error');
  } finally {
    editRecipeSaving = false;
    setEditRecipeBusy(false);
  }
}

function setDeleteRecipeStatus(text = '', type = 'is-info') {
  if (!deleteRecipeStatus) return;
  deleteRecipeStatus.textContent = text;
  ['is-error', 'is-success', 'is-info'].forEach((cls) => deleteRecipeStatus.classList.toggle(cls, cls === type));
}

function setDeleteRecipeBusy(isBusy) {
  deleteRecipeBusy = isBusy;
  if (confirmDeleteRecipeBtn) confirmDeleteRecipeBtn.disabled = isBusy;
  if (cancelDeleteRecipeBtn) cancelDeleteRecipeBtn.disabled = isBusy;
  if (deleteRecipeModal) {
    if (isBusy) deleteRecipeModal.setAttribute('aria-busy', 'true');
    else deleteRecipeModal.removeAttribute('aria-busy');
  }
}

/** Tampilkan konfirmasi hapus (tidak menghapus apa pun sebelum dikonfirmasi). */
function openDeleteRecipe(id, trigger) {
  const recipe = myRecipes.find((r) => r.id === id);
  if (!recipe || !deleteRecipeModal) return;
  deleteRecipeId = recipe.id;
  if (deleteRecipeName) deleteRecipeName.textContent = recipe.title;
  setDeleteRecipeStatus('');
  setDeleteRecipeBusy(false);
  deleteRecipeModal.hidden = false;
  enterModal(deleteRecipeModal, cancelDeleteRecipeBtn, trigger); // default aman: Batal
}

function closeDeleteRecipe() {
  if (!deleteRecipeModal || deleteRecipeModal.hidden) return;
  if (deleteRecipeBusy) return;
  deleteRecipeModal.hidden = true;
  deleteRecipeId = null;
  setDeleteRecipeStatus('');
  exitModal(deleteRecipeModal);
}

async function handleConfirmDeleteRecipe() {
  if (deleteRecipeBusy || !deleteRecipeId) return;
  const id = deleteRecipeId;
  setDeleteRecipeBusy(true);
  setDeleteRecipeStatus('Menghapus resep...', 'is-info');

  try {
    const result = await deleteRecipe(id);
    if (!result.ok) {
      setDeleteRecipeStatus(result.message, 'is-error');
      return;
    }
    myRecipes = myRecipes.filter((r) => r.id !== id);
    if (myRecipes.length === 0) {
      setMyRecipesStatus('Kamu belum menambahkan resep.', 'is-info');
      renderMyRecipesEmpty('Kamu belum menambahkan resep. Gunakan menu Tambah Resep untuk memulai.');
    } else {
      setMyRecipesStatus(`${myRecipes.length} resep milikmu.`, 'is-success');
      renderMyRecipesGrid();
    }
    setDeleteRecipeBusy(false);
    closeDeleteRecipe();
    showToast('Resep berhasil dihapus.');
    refreshPublicSupabase();
  } catch (err) {
    console.warn('[my-recipes] Hapus resep gagal:', (err && err.message) || err);
    setDeleteRecipeStatus('Resep belum berhasil dihapus. Silakan coba lagi.', 'is-error');
  } finally {
    setDeleteRecipeBusy(false);
  }
}

// ==========================================================================
// DARK MODE
// ==========================================================================

const THEME_KEY = 'resepin_theme';

/**
 * Terapkan tema ke <html>. Satu-satunya tempat yang menulis atribut data-theme,
 * supaya sidebar (MutationObserver) dan skrip inline tidak berebut.
 */
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  themeToggle.querySelector('.theme-toggle-icon').textContent = isDark ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-label', isDark ? 'Ganti ke mode terang' : 'Ganti ke mode gelap');
  // Status tombol (bukan hanya aksinya) supaya pembaca layar tahu tema aktif.
  themeToggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Preferensi OS saat ini (false bila matchMedia tidak tersedia). */
function systemPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia(DARK_QUERY).matches);
  } catch (err) {
    return false;
  }
}

/**
 * Tentukan tema awal. Urutannya SAMA dengan skrip inline di index.html supaya
 * tidak ada perbedaan hasil antara render pertama dan init():
 *   1. pilihan manual tersimpan ('dark' / 'light')
 *   2. preferensi sistem
 *   3. terang
 */
function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (err) {
    saved = null; // localStorage diblokir -> jatuh ke preferensi sistem
  }
  const isDark = saved === 'dark' ? true : saved === 'light' ? false : systemPrefersDark();
  applyTheme(isDark);
  // Tema awal sudah terpasang -> izinkan transisi tema kembali normal.
  // Dipasang sekali di sini (bukan di toggleTheme) karena hanya menyangkut load.
  document.documentElement.setAttribute('data-theme-ready', '');
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'dark';
  applyTheme(isDark);
  try {
    localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  } catch (err) {
    // gagal simpan preferensi -> tidak masalah, cuma tidak diingat sesi berikutnya
  }
}

// ==========================================================================
// EVENT LISTENERS
// ==========================================================================

function bindEvents() {
  themeToggle.addEventListener('click', toggleTheme);

  // Beranda <-> halaman pencarian
  startSearchBtn.addEventListener('click', startSearch);
  backToHomeBtn.addEventListener('click', backToHome);

  // Menu utama: dua metode pencarian
  openIngredientSearchBtn.addEventListener('click', () => openSearchPanel('ingredient'));
  openNameSearchBtn.addEventListener('click', () => openSearchPanel('name'));
  // Panel ditutup lewat closeSearchPanels(). Bila mengganti metode saat panel
  // lain masih terbuka, panel lama ditutup di sini dan yang baru dibuka oleh
  // openSearchPanel di bawah -- cukup satu handler, tanpa duplikasi.
  document.querySelectorAll('.panel-close').forEach((btn) => {
    btn.addEventListener('click', closeSearchPanels);
  });

  nameSearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runNameSearch();
  });
  nameSearchInput.addEventListener('input', () => setNameSearchMessage(''));

  // Kategori (event delegation, kartu dirender dinamis)
  categoryGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.category-card');
    if (!card) return;
    resetSearchPanelsForNavigation(); // target C02: panel metode hilang saat kategori dipilih
    showCategory(card.dataset.category);
  });
  seeAllCategoriesBtn.addEventListener('click', () => {
    resetSearchPanelsForNavigation();
    navigate(categoryRouteOf('all'));
  });

  // Menu Favorit & logo Resepkan ditangani js/sidebar.js (drawer mobile ditutup di sana)
  // lewat callback onFavorites / onHome di initSidebar(). Tidak ada modal favorit lagi.

  addIngredientBtn.addEventListener('click', addIngredientFromInput);
  ingredientInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addIngredientFromInput();
    }
  });

  ingredientChips.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.chip-remove');
    if (removeBtn) removeIngredientAt(Number(removeBtn.dataset.index));
  });

  // Filter bahan (picker)
  pickerToggleBtn.addEventListener('click', togglePicker);
  pickerSearch.addEventListener('input', () => renderPickerList(pickerSearch.value));
  pickerList.addEventListener('change', (e) => {
    const checkbox = e.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    if (checkbox.checked) addIngredient(checkbox.dataset.token);
    else removeIngredientValue(checkbox.dataset.token);
  });
  document.addEventListener('click', (e) => {
    if (!pickerPanel.hidden && !e.target.closest('.ingredient-picker')) closePicker();
  });

  generateBtn.addEventListener('click', runGenerate);

  // Pemulihan bila data resep gagal dimuat (satu handler untuk kedua tombol).
  [nameRetryBtn, ingredientRetryBtn].forEach((btn) => {
    if (btn) btn.addEventListener('click', retryLoadRecipes);
  });

  prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
  nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));
  favoritesPrevPageBtn.addEventListener('click', () => goToFavoritesPage(favoritesPageIndex - 1));
  favoritesNextPageBtn.addEventListener('click', () => goToFavoritesPage(favoritesPageIndex + 1));

  // Event delegation: tombol favorit & "Lihat Resep" di grid hasil MAUPUN grid favorit
  document.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.recipe-card-fav:not(.recipe-card-fav-labeled)');
    if (favBtn && favBtn.dataset.id) {
      handleToggleFavorite(favBtn.dataset.id);
      return;
    }
    const viewBtn = e.target.closest('.recipe-card-btn');
    if (!viewBtn) return;
    if (viewBtn.dataset.source === 'supabase') {
      openMyRecipeDetail(viewBtn.dataset.id, viewBtn); // resep Supabase dibuka lewat state myRecipes
      return;
    }
    openDetailModal(viewBtn.dataset.id, 'huggingface', viewBtn);
  });

  // Tambah Resep: tombol sidebar membuka modal (drawer mobile ditutup oleh sidebar.js)
  fillCategoryOptions();
  if (addRecipeNavBtn) addRecipeNavBtn.addEventListener('click', (e) => openAddRecipe(e.currentTarget));
  if (closeAddRecipeModal) closeAddRecipeModal.addEventListener('click', closeAddRecipe);
  if (addRecipeModal) {
    addRecipeModal.addEventListener('click', (e) => {
      if (e.target === addRecipeModal) closeAddRecipe();
    });
  }
  if (addRecipeForm) addRecipeForm.addEventListener('submit', handleAddRecipeSubmit);
  ['ingredients', 'steps'].forEach((field) => {
    const btn = el(field === 'ingredients' ? 'addRecipeIngredientBtn' : 'addRecipeStepBtn');
    const input = el(field === 'ingredients' ? 'addRecipeIngredientInput' : 'addRecipeStepInput');
    if (btn) btn.addEventListener('click', () => addRecipeItem(field));
    if (input) {
      input.addEventListener('keydown', (e) => {
        // Enter menambah item, bukan mensubmit form.
        if (e.key === 'Enter') {
          e.preventDefault();
          addRecipeItem(field);
        }
      });
    }
    const list = el(field === 'ingredients' ? 'addRecipeIngredientList' : 'addRecipeStepList');
    if (list) {
      list.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.chip-remove');
        if (!removeBtn) return;
        const index = Number(removeBtn.dataset.index);
        if (Number.isInteger(index) && index >= 0) addRecipeItems[field].splice(index, 1);
        renderAddRecipeItems(field);
      });
    }
    renderAddRecipeItems(field);
  });

  // Resep Saya: tombol sidebar membuka modal daftar (drawer mobile ditutup sidebar.js)
  if (myRecipesNavBtn) myRecipesNavBtn.addEventListener('click', (e) => openMyRecipes(e.currentTarget));
  if (closeMyRecipesModal) closeMyRecipesModal.addEventListener('click', closeMyRecipes);
  if (myRecipesModal) {
    myRecipesModal.addEventListener('click', (e) => {
      if (e.target === myRecipesModal) closeMyRecipes();
    });
  }
  if (myRecipesRetryBtn) myRecipesRetryBtn.addEventListener('click', loadMyRecipes);
  if (myRecipesGrid) {
    myRecipesGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.recipe-card-btn');
      if (!btn || !btn.dataset.id) return;
      const action = btn.dataset.action || 'view';
      if (action === 'edit') openEditRecipe(btn.dataset.id, btn);
      else if (action === 'delete') openDeleteRecipe(btn.dataset.id, btn);
      else openMyRecipeDetail(btn.dataset.id, btn);
    });
  }
  if (closeMyRecipeDetailModal) closeMyRecipeDetailModal.addEventListener('click', closeMyRecipeDetail);
  if (myRecipeDetailModal) {
    myRecipeDetailModal.addEventListener('click', (e) => {
      if (e.target === myRecipeDetailModal) closeMyRecipeDetail();
    });
  }

  // Edit Resep
  if (el('closeEditRecipeModal')) el('closeEditRecipeModal').addEventListener('click', closeEditRecipe);
  if (editRecipeModal) {
    editRecipeModal.addEventListener('click', (e) => {
      if (e.target === editRecipeModal) closeEditRecipe();
    });
  }
  if (editRecipeForm) editRecipeForm.addEventListener('submit', handleEditRecipeSubmit);
  ['ingredients', 'steps'].forEach((field) => {
    const btn = el(field === 'ingredients' ? 'editRecipeIngredientBtn' : 'editRecipeStepBtn');
    const input = el(field === 'ingredients' ? 'editRecipeIngredientInput' : 'editRecipeStepInput');
    if (btn) btn.addEventListener('click', () => addEditRecipeItem(field));
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addEditRecipeItem(field);
        }
      });
    }
    const list = el(field === 'ingredients' ? 'editRecipeIngredientList' : 'editRecipeStepList');
    if (list) {
      list.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.chip-remove');
        if (!removeBtn) return;
        const index = Number(removeBtn.dataset.index);
        if (Number.isInteger(index) && index >= 0) editRecipeItems[field].splice(index, 1);
        renderEditRecipeItems(field);
      });
    }
  });

  // Konfirmasi Hapus
  if (el('closeDeleteRecipeModal')) el('closeDeleteRecipeModal').addEventListener('click', closeDeleteRecipe);
  if (cancelDeleteRecipeBtn) cancelDeleteRecipeBtn.addEventListener('click', closeDeleteRecipe);
  if (confirmDeleteRecipeBtn) confirmDeleteRecipeBtn.addEventListener('click', handleConfirmDeleteRecipe);
  if (deleteRecipeModal) {
    deleteRecipeModal.addEventListener('click', (e) => {
      if (e.target === deleteRecipeModal) closeDeleteRecipe();
    });
  }

  closeDetailModal.addEventListener('click', closeDetail);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Satu Escape = satu modal teratas saja.
    if (!detailModal.hidden) {
      closeDetail();
      return;
    }

    if (!pickerPanel.hidden) closePicker();
    // Modal teratas: konfirmasi hapus -> edit -> detail Resep Saya -> daftar Resep Saya -> Tambah Resep.
    if (deleteRecipeModal && !deleteRecipeModal.hidden) {
      closeDeleteRecipe();
      return;
    }
    if (editRecipeModal && !editRecipeModal.hidden) {
      closeEditRecipe();
      return;
    }
    if (myRecipeDetailModal && !myRecipeDetailModal.hidden) {
      closeMyRecipeDetail();
      return;
    }
    if (myRecipesModal && !myRecipesModal.hidden) {
      closeMyRecipes();
      return;
    }
    // Modal akun menangani Escape sendiri (lihat js/auth.js) supaya tidak dobel.
    if (authModal && !authModal.hidden) {
      authApi?.close();
      // closeAuthModal() memanggil onModalClose -> exitModal(). Bila api belum
      // siap (auth gagal init), pastikan inert tetap dilepas di sini.
      if (authModal.hidden && el('appShell') && el('appShell').inert) syncBackgroundInert();
      return; // modal lain jangan ikut tertutup oleh satu Escape yang sama
    }
    if (addRecipeModal && !addRecipeModal.hidden) closeAddRecipe();
  });
}

// ==========================================================================
// PEMUATAN DATA RESEP + PEMULIHAN (dipakai init() dan tombol "Coba Lagi")
// ==========================================================================

let recipesLoading = false; // cegah klik ganda selama request berlangsung

/** Tampilkan/sembunyikan tombol "Coba Lagi" pada kedua panel pencarian. */
function setRetryVisible(visible) {
  [nameRetryBtn, ingredientRetryBtn].forEach((btn) => {
    if (btn) btn.hidden = !visible;
  });
}

function setRetryDisabled(disabled) {
  [nameRetryBtn, ingredientRetryBtn].forEach((btn) => {
    if (btn) btn.disabled = disabled;
  });
}

/**
 * Satu alur untuk memuat data resep dan menyiapkan seluruh UI yang bergantung
 * padanya. Dipanggil sekali saat init() dan lagi saat pengguna menekan
 * "Coba Lagi" -- tidak ada listener/router/modul yang dipasang ulang.
 *
 * @returns {Promise<boolean>} true bila data siap.
 */
let retryCount = 0;

async function loadRecipeData() {
  if (recipesLoading) return false; // satu klik = satu percobaan
  recipesLoading = true;

  generateBtn.disabled = true;
  nameSearchBtn.disabled = true;
  seeAllCategoriesBtn.disabled = true;
  setRetryVisible(false);
  setRetryDisabled(true); // tombol tidak bisa diklik selama loading
  setGeneratorMessage('Memuat resep...');
  setNameSearchMessage('Memuat resep...');

  try {
    const anySource = await loadPublicRecipes({ force: retryCount > 0 });
    if (!anySource) throw new Error('Gagal memuat resep. Silakan coba lagi.');
    // recipesReady = minimal satu sumber siap (pencarian/kategori tetap jalan
    // dengan Supabase saja). hfRetryNeeded menandai HF perlu dicoba lagi.
    recipesReady = true;
    hfRetryNeeded = !hfReady;
    ingredientTokens = getIngredientTokens();

    generateBtn.disabled = false;
    nameSearchBtn.disabled = false;
    seeAllCategoriesBtn.disabled = false;
    clearGeneratorMessage();
    setNameSearchMessage('');
    setRetryVisible(hfRetryNeeded);
    if (hfRetryNeeded) {
      setNameSearchMessage('Sebagian resep gagal dimuat. Coba lagi untuk memuat seluruh resep.', true);
    }
    renderCategoryCards();
    sidebarApi?.setCounts(getCategoryCounts(getPublicRecipes()));
    restorePendingCategory();
    return true;
  } catch (err) {
    const message = err.message || 'Gagal memuat resep. Silakan coba lagi.';
    generateBtn.disabled = true;
    nameSearchBtn.disabled = true;
    seeAllCategoriesBtn.disabled = true;
    setGeneratorMessage(message, true);
    setNameSearchMessage(message, true);
    setRetryVisible(true);
    return false;
  } finally {
    recipesLoading = false;
    retryCount += 1;
    setRetryDisabled(false);
  }
}

/** Segarkan daftar publik Supabase setelah tambah/edit/hapus (tanpa memuat ulang HF). */
async function refreshPublicSupabase() {
  try {
    const res = await loadSupabasePublicRecipes({ force: true });
    publicRecipes = mergePublicRecipes(getAllRecipes(), res.recipes || []);
    hfReady = getAllRecipes().length > 0;
    hfRetryNeeded = !hfReady;
    if (recipesReady) {
      renderCategoryCards();
      sidebarApi?.setCounts(getCategoryCounts(getPublicRecipes()));
    }
  } catch (err) {
    console.warn('[public-recipes] Gagal menyegarkan resep Supabase:', (err && err.message) || err);
  }
}

/** Handler tombol "Coba Lagi" (dipasang sekali di bindEvents). */
function retryLoadRecipes() {
  if (recipesLoading) return;
  if (recipesReady && !hfRetryNeeded) return; // semua sumber sudah siap
  loadRecipeData();
}

// ==========================================================================
// INIT
// ==========================================================================

async function init() {
  el('footerYear').textContent = new Date().getFullYear();
  initTheme();
  updateFavoritesBadge();
  bindEvents();
  // Sidebar dan router TIDAK boleh menggagalkan init: kegagalan hanya dicatat.
  try {
    sidebarApi = initSidebar({
      categories: CATEGORY_DEFS.map(({ key, label }) => ({ key, label })),
      onSearch: () => navigateToPage('search'),
      // Memilih kategori selalu menulis rute '#/kategori/:key' (entri riwayat baru),
      // sehingga Browser Back/Forward bisa kembali ke kategori sebelumnya.
      onCategory: (key) => navigate(categoryRouteOf(key)),
      onCategorySection: goToCategoriesSection,
      onHome: goHomeFromLogo,
      onFavorites: () => navigate(ROUTE_FAVORITES),
    });
    initRouter({
      [ROUTE_HOME]: showHomePage,
      [ROUTE_FAVORITES]: showFavoritesPage,
      [ROUTE_SEARCH]: showSearchPage,
      [`${ROUTE_CATEGORY}/:key`]: showCategoryPage,
    });
  } catch (err) {
    console.warn('[sidebar] Inisialisasi navigasi dilewati:', (err && err.message) || err);
  }
  renderChips();
  renderCategoryCards();
  // Status loading awal (tombol disabled, pesan "Memuat resep...") diatur
  // oleh loadRecipeData() supaya init dan retry memakai alur yang sama.

  // Autentikasi dipasang bersamaan dengan pemuatan resep dan TIDAK boleh
  // menggagalkan init: fungsi ini selalu resolve, error hanya dicatat.
  // onModalClose: beri tahu pengelola fokus bersama bahwa modal akun ditutup
  // (melepas inert + memulihkan fokus) tanpa membuat listener Escape duplikat.
  setupAuth(supabase, {
    onModalClose: (modal) => exitModal(modal),
    // Modal akun dibuka oleh auth.js; catat pemicunya dan kunci latar.
    onModalOpen: (modal, trigger) => {
      // Catat pemicu SEBELUM inert dipasang.
      if (modal && !modalFocusReturn.has(modal)) {
        const active = document.activeElement;
        let owner = trigger || (active && active !== document.body ? active : null);
        // Drawer mobile: pemicunya ada di dalam #sidebar yang akan ikut inert,
        // jadi tidak bisa difokuskan kembali. Pakai tombol hamburger.
        // Dicek lewat posisi DOM + lebar layar, bukan class is-drawer-open
        // (class itu sudah dilepas sebelum modal dibuka).
        if (owner && owner.closest && owner.closest('#sidebar')
            && window.matchMedia('(max-width: 640px)').matches
            && owner.id !== 'sidebarToggleBtn') {
          owner = el('sidebarToggleBtn') || owner;
        }
        modalFocusReturn.set(modal, owner);
      }
      syncBackgroundInert();
    },
  })
    .then((api) => { authApi = api; })
    .catch((err) => console.warn('[auth] Inisialisasi akun dilewati:', (err && err.message) || err));

  await loadRecipeData();
}

init();
