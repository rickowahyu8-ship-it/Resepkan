// sidebar.js
// Tanggung jawab: perilaku sidebar -- ciut/lebar (disimpan di localStorage),
// submenu Kategori, state aktif, drawer mobile, toggle tema, dan titik badge favorit.
// Tidak menyentuh data resep, pencarian, favorit, maupun autentikasi: aksi dikirim
// lewat callback dari app.js.

const STORAGE_KEY = 'resepin_sidebar';
const $ = (id) => document.getElementById(id);

export function initSidebar({ categories, onSearch, onHome, onFavorites, onCategory, onCategorySection }) {
  const shell = $('appShell');
  const sidebar = $('sidebar');
  const logoBtn = $('sidebarLogo');
  const barLogoBtn = $('mobileBarLogo');
  const navSearch = $('navSearch');
  const navCategory = $('navCategory');
  const catSub = $('catSub');
  const favBtn = $('favoritesNavBtn');
  const badge = $('favoritesCountBadge');
  const acctBtn = $('accountNavBtn');
  const collapseBtn = $('sidebarCollapseBtn');
  const toggleBtn = $('sidebarToggleBtn');
  const overlay = $('sidebarOverlay');
  const themeToggle = $('themeToggle');
  const lightBtn = $('themeLightBtn');
  const darkBtn = $('themeDarkBtn');
  if (!shell || !sidebar || !navSearch || !navCategory || !catSub) {
    throw new Error('Elemen sidebar tidak lengkap.');
  }

  const mqDrawer = window.matchMedia('(max-width: 640px)');
  const mqRail = window.matchMedia('(min-width: 641px) and (max-width: 1000px)');

  let userCollapsed = false;
  try { userCollapsed = localStorage.getItem(STORAGE_KEY) === 'collapsed'; } catch (err) { /* abaikan */ }
  let drawerOpen = false;
  let ready = false;
  let state = { section: 'search', categoryKey: null };
  let previous = null; // state sebelum modal Favorit dibuka
  // Status submenu TERPISAH dari status aktif: submenu hanya terbuka bila pengguna
  // menekan menu Kategori, dan tidak pernah terbuka sendiri saat aplikasi dimuat.
  let subOpen = false;

  const isCollapsed = () => !mqDrawer.matches && (userCollapsed || mqRail.matches);

  // ---------- Submenu Kategori ----------
  const subItems = new Map();
  categories.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sb-sub-item';
    btn.dataset.key = key;
    btn.disabled = true; // aktif setelah data resep dimuat (sama seperti kartu kategori)
    btn.style.setProperty('--a', `var(--cat-${key}, var(--primary))`);
    const dot = document.createElement('i');
    dot.className = 'sb-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'sb-sub-label';
    text.textContent = label;
    const count = document.createElement('em');
    count.className = 'sb-sub-count';
    btn.append(dot, text, count);
    btn.addEventListener('click', () => { closeDrawer(); if (onCategory) onCategory(key); });
    catSub.appendChild(btn);
    subItems.set(key, { btn, count });
  });

  function setSub(open) {
    subOpen = open;
    catSub.hidden = !open;
    navCategory.setAttribute('aria-expanded', String(open));
  }

  // ---------- State aktif ----------
  function render() {
    const mark = (el, on) => {
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    };
    mark(navSearch, state.section === 'search');
    mark(navCategory, state.section === 'category');
    if (favBtn) mark(favBtn, state.section === 'favorites');
    subItems.forEach(({ btn }, key) => mark(btn, state.section === 'category' && state.categoryKey === key));
    // Submenu mengikuti pilihan pengguna (subOpen), bukan status aktif kategori.
    // Saat sidebar ciut ruangnya tidak cukup, jadi submenu selalu ditutup.
    if (isCollapsed() && subOpen) setSub(false);
  }

  function setActive({ section, categoryKey = null }) {
    if (section === 'favorites') {
      if (state.section !== 'favorites') previous = state;
      state = { section: 'favorites', categoryKey: null };
    } else {
      previous = null;
      state = { section, categoryKey };
    }
    render();
  }

  function restoreActive() {
    if (state.section === 'favorites' && previous) {
      state = previous;
      previous = null;
      render();
    }
  }

  function setCounts(counts) {
    ready = true;
    subItems.forEach(({ btn, count }, key) => {
      btn.disabled = false;
      count.textContent = String(counts[key] || 0);
    });
  }

  // ---------- Ciut/lebar ----------
  function applyLayout() {
    const collapsed = isCollapsed();
    shell.classList.toggle('is-collapsed', collapsed);
    if (collapseBtn) {
      collapseBtn.setAttribute('aria-pressed', String(collapsed));
      const label = collapsed ? 'Perluas sidebar' : 'Ciutkan sidebar';
      collapseBtn.setAttribute('aria-label', label);
      collapseBtn.title = label;
    }
    if (collapsed) setSub(false);
    if (!mqDrawer.matches && drawerOpen) closeDrawer();
    render(); // status aktif tetap benar setelah ciut/lebar atau pindah breakpoint
  }

  // ---------- Drawer mobile ----------
  function openDrawer() {
    if (!mqDrawer.matches) return;
    drawerOpen = true;
    shell.classList.add('is-drawer-open');
    overlay.hidden = false;
    document.body.classList.add('sb-lock');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    navSearch.focus();
  }

  function closeDrawer({ restoreFocus = false } = {}) {
    if (!drawerOpen) return;
    drawerOpen = false;
    shell.classList.remove('is-drawer-open');
    overlay.hidden = true;
    document.body.classList.remove('sb-lock');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggleBtn.focus();
    }
  }

  // ---------- Event ----------
  // Menu yang berpindah halaman (tanpa modal): fokus kembali ke tombol hamburger.
  navSearch.addEventListener('click', () => { closeDrawer({ restoreFocus: true }); if (onSearch) onSearch(); });
  // Logo & nama Resepkan (sidebar + mobile bar) kembali ke beranda.
  // Tombol hamburger punya listener sendiri; logo bukan anaknya, jadi tidak bertumpuk.
  // Drawer ditutup DI SINI (tanpa memindah fokus) supaya klik logo tidak meninggalkan drawer terbuka.
  [logoBtn, barLogoBtn].forEach((logo) => {
    if (!logo) return;
    logo.addEventListener('click', () => { closeDrawer(); if (onHome) onHome(); });
  });
  navCategory.addEventListener('click', () => {
    if (isCollapsed()) {
      // Sidebar ciut: submenu tidak muat, jadi menu Kategori langsung membuka
      // daftar kategori di halaman (perilaku yang sudah ada).
      closeDrawer({ restoreFocus: true });
      setActive({ section: 'category', categoryKey: null });
      if (onCategorySection) onCategorySection();
    } else {
      setSub(!subOpen); // buka/tutup submenu saja, tanpa mengubah status aktif
    }
  });
  // Menu yang membuka MODAL: jangan kembalikan fokus ke hamburger -- modal akan
  // mengambil alih fokus, jadi memindahkannya dua kali hanya membuat fokus berkedip.
  // Favorit kini halaman mandiri (C06): tutup drawer lalu pindah rute lewat router.
  if (favBtn) favBtn.addEventListener('click', () => { closeDrawer(); if (onFavorites) onFavorites(); });
  if (acctBtn) acctBtn.addEventListener('click', () => closeDrawer()); // modal dibuka oleh auth.js
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      userCollapsed = !userCollapsed;
      try { localStorage.setItem(STORAGE_KEY, userCollapsed ? 'collapsed' : 'expanded'); } catch (err) { /* abaikan */ }
      applyLayout();
    });
  }
  if (toggleBtn) toggleBtn.addEventListener('click', () => (drawerOpen ? closeDrawer({ restoreFocus: true }) : openDrawer()));
  overlay.addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawerOpen) return;
    if (document.querySelector('.modal-overlay:not([hidden])')) return; // modal menangani Escape-nya sendiri
    closeDrawer({ restoreFocus: true });
  });
  mqDrawer.addEventListener('change', applyLayout);
  mqRail.addEventListener('change', applyLayout);

  // ---------- Toggle tema (memakai logika tema yang sudah ada lewat #themeToggle) ----------
  const syncTheme = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (lightBtn) lightBtn.setAttribute('aria-pressed', String(!dark));
    if (darkBtn) darkBtn.setAttribute('aria-pressed', String(dark));
  };
  const setTheme = (wantDark) => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark !== wantDark && themeToggle) themeToggle.click();
  };
  if (lightBtn) lightBtn.addEventListener('click', () => setTheme(false));
  if (darkBtn) darkBtn.addEventListener('click', () => setTheme(true));
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();

  // ---------- Titik badge favorit (saat ciut) mengikuti angka yang ditulis app.js ----------
  if (badge) {
    const syncBadge = () => { badge.dataset.count = String(parseInt(badge.textContent, 10) || 0); };
    new MutationObserver(syncBadge).observe(badge, { childList: true, characterData: true, subtree: true });
    syncBadge();
  }

  applyLayout();
  render();
  document.documentElement.classList.remove('sb-pre'); // .is-collapsed kini yang berlaku
  // Lepas penahan animasi setelah tata letak awal tergambar.
  requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.remove('sb-no-anim')));
  return { setActive, restoreActive, setCounts, isReady: () => ready, isSubOpen: () => subOpen };
}
