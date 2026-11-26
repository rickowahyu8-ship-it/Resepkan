// auth.js
// Tanggung jawab: autentikasi Supabase (masuk, daftar, keluar, pemulihan sesi)
// dan semua hal yang berkaitan dengan UI akun: tombol navbar + modal akun.
//
// Batasan yang dijaga:
// - Profil TIDAK dibuat dari browser. Trigger `on_auth_user_created` di database
//   yang mengisi public.profiles dari metadata (display_name / full_name).
// - Password tidak pernah disimpan, dicatat ke console, atau dimasukkan ke tabel.
// - Metadata pengguna bukan sumber otoritatif; username tetap dijamin UNIQUE oleh
//   constraint database. Validasi di sini hanya untuk umpan balik cepat.
// - Tidak menjalankan query SQL / mengubah RLS.

const MIN_PASSWORD_LENGTH = 6; // batas minimum bawaan Supabase Auth
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const AUTH_STATUS_TYPES = ['is-error', 'is-success', 'is-info'];

// Notifikasi singkat dari utils.js (dipakai setelah profil berhasil disimpan).
import { showToast } from './utils.js';

/** Apakah error berasal dari pemeriksaan sesi (Supabase belum siap / offline). */
function isAuthUnavailableError(error) {
  if (!error) return false;
  // err.name === 'AbortError' dipakai SDK saat permintaan sesi dihentikan.
  if (error.name === 'AbortError') return true;
  return /fetch|network|load failed|timed out|failed to connect/i.test(`${error.name || ''} ${error.message || ''}`);
}

/**
 * Pasang tombol akun navbar + modal autentikasi.
 * Mengembalikan Promise yang SELALU resolve (tidak pernah reject), supaya
 * kegagalan auth tidak menghentikan init() aplikasi resep.
 */
export async function setupAuth(supabase, options = {}) {
  // Callback dari app.js: memberi tahu bahwa modal akun ditutup supaya
  // pengelola fokus/inert bersama ikut melepas kunci latar.
  const onModalClose = typeof options.onModalClose === 'function' ? options.onModalClose : null;
  const onModalOpen = typeof options.onModalOpen === 'function' ? options.onModalOpen : null;
  const el = (id) => document.getElementById(id);

  const accountBtn = el('accountNavBtn');
  const authModal = el('authModal');
  const authModalTitle = el('authModalTitle');
  const closeAuthModalBtn = el('closeAuthModal');

  const loginForm = el('loginForm');
  const loginEmail = el('loginEmail');
  const loginPassword = el('loginPassword');
  const loginSubmitBtn = el('loginSubmitBtn');

  const registerForm = el('registerForm');
  const registerDisplayName = el('registerDisplayName');
  const registerUsername = el('registerUsername');
  const registerEmail = el('registerEmail');
  const registerPassword = el('registerPassword');
  const registerSubmitBtn = el('registerSubmitBtn');

  const verifyPanel = el('verifyPanel');
  const verifyResendBtn = el('verifyResendBtn');
  const verifyBackBtn = el('verifyBackBtn');
  const otpEmailText = el('otpEmailText');

  // ---- Lupa password (D03-B) ----
  const forgotPasswordLink = el('forgotPasswordLink');
  const forgotForm = el('forgotForm');
  const forgotEmail = el('forgotEmail');
  const forgotSubmitBtn = el('forgotSubmitBtn');
  const forgotBackBtn = el('forgotBackBtn');
  const resetSentPanel = el('resetSentPanel');
  const resetSentEmail = el('resetSentEmail');
  const resetResendBtn = el('resetResendBtn');
  const resetSentBackBtn = el('resetSentBackBtn');
  // Panel password baru hanya disiapkan (dipakai pada D03-C).
  const resetPasswordForm = el('resetPasswordForm');
  const resetPasswordInput = el('resetPasswordInput');
  const resetPasswordConfirm = el('resetPasswordConfirm');
  const resetPasswordSubmitBtn = el('resetPasswordSubmitBtn');
  const resetPasswordCancelBtn = el('resetPasswordCancelBtn');

  const switchToRegisterBtn = el('switchToRegisterBtn');
  const switchToLoginBtn = el('switchToLoginBtn');
  const authStatusMessage = el('authStatusMessage');
  const authAccountPanel = el('authAccountPanel');
  const authAccountInfo = el('authAccountInfo');
  const logoutBtn = el('logoutBtn');

  // ---- Profil (D04-B) ----
  const profileView = el('profileView');
  const profileAvatar = el('profileAvatar');
  const profileDisplayName = el('profileDisplayName');
  const profileUsername = el('profileUsername');
  const profileEmail = el('profileEmail');
  const profileStatus = el('profileStatus');
  const editProfileBtn = el('editProfileBtn');
  const profileEditForm = el('profileEditForm');
  const editDisplayName = el('editDisplayName');
  const editUsername = el('editUsername');
  const profileEditStatus = el('profileEditStatus');
  const saveProfileBtn = el('saveProfileBtn');
  const cancelProfileBtn = el('cancelProfileBtn');

  // Elemen navbar wajib ada. Kalau HTML-nya tidak sesuai, lewati tanpa melempar error.
  if (!accountBtn || !authModal || !loginForm || !registerForm || !logoutBtn) {
    console.warn('[auth] Elemen navbar/modal akun tidak lengkap; fitur akun dilewati.');
    return null;
  }

  // ---- State ----
  let emailConfirmRequired = false; // true selama menunggu konfirmasi email (panel tautan)
  let lastFocusedBeforeModal = null;
  let currentMode = 'login';      // 'login' | 'register' | 'verify' (sumber kebenaran tampilan modal)
  // Email yang benar-benar dikirim ke signUp() dan menunggu konfirmasi tautan.
  // Hanya email -- password TIDAK pernah disimpan di state.
  let pendingVerifyEmail = '';
  // ---- Kirim ulang tautan konfirmasi ----
  const RESEND_COOLDOWN_MS = 60 * 1000; // 60 detik antar permintaan kirim ulang
  const RESEND_LABEL = 'Kirim Ulang Tautan';
  let resendUntil = 0;     // timestamp kapan tombol kirim ulang boleh dipakai lagi
  let resendTimer = null;  // interval label hitung mundur
  let resending = false;   // flag sinkron: satu request kirim ulang dalam satu waktu

  // ---- Lupa password (D03-B): permintaan & pengiriman ulang tautan reset ----
  const RESET_RESEND_LABEL = 'Kirim Ulang Tautan';
  let pendingResetEmail = ''; // email yang diminta tautan resetnya (bukan rahasia)
  let resetRequesting = false; // flag sinkron: satu request reset dalam satu waktu
  let resetCooldownUntil = 0;
  let resetCooldownTimer = null;

  // ---- Sesi pemulihan password (D03-C) ----
  // true HANYA setelah event PASSWORD_RECOVERY diterima (bukan untuk login biasa).
  let recoveryMode = false;
  // Kunci profil yang sedang aktif: pengguna yang berbeda harus memicu muat ulang.
  let profileLoadedFor = null;
  let profileSaving = false; // flag sinkron: satu UPDATE profil dalam satu waktu
  // Sesi recovery yang diterima dari tautan. Disimpan di memori (bukan storage) karena
  // SDK tidak membuat sesi sendiri saat event di-push secara manual, dan applySession()
  // tidak boleh mengubah tampilan selama pemulihan.
  let recoverySession = null;
  let resetSubmitting = false; // flag sinkron: satu updateUser dalam satu waktu

  // ---------------------------------------------------------------------------
  // Pesan status (aria-live) + indikator loading form
  // ---------------------------------------------------------------------------

  function setStatus(text = '', type = 'is-info') {
    authStatusMessage.textContent = text;
    AUTH_STATUS_TYPES.forEach((cls) => authStatusMessage.classList.toggle(cls, cls === type));
  }

  function setBusy(isBusy) {
    loginSubmitBtn.disabled = isBusy;
    registerSubmitBtn.disabled = isBusy;
    logoutBtn.disabled = isBusy;
    if (forgotSubmitBtn) forgotSubmitBtn.disabled = isBusy;
    if (resetPasswordSubmitBtn) resetPasswordSubmitBtn.disabled = isBusy;

    // Kasus penting: email konfirmasi dikirim ulang -> perlu tunggu, tapi bukan error.
    switchToRegisterBtn.disabled = isBusy && emailConfirmRequired;
    switchToLoginBtn.disabled = isBusy && emailConfirmRequired;

    if (isBusy) authModal.setAttribute('aria-busy', 'true');
    else authModal.removeAttribute('aria-busy');
  }

  /** Terjemahkan pesan error Supabase menjadi teks yang jelas untuk pengguna. */
  function describeError(error, context) {
    const message = (error && error.message) || '';
    const code = (error && error.code) || '';
    const lower = message.toLowerCase();

    if (context === 'login') {
      if (code === 'email_not_confirmed' || lower.includes('email not confirmed')) {
        return 'Email belum dikonfirmasi. Buka tautan konfirmasi di kotak masuk email kamu, lalu coba masuk lagi.';
      }
      if (code === 'invalid_credentials' || lower.includes('invalid login credentials')) {
        return 'Email atau password salah. Periksa kembali, atau daftar jika belum punya akun.';
      }
      if (lower.includes('rate limit')) {
        return 'Terlalu banyak percobaan masuk. Coba lagi beberapa saat.';
      }
    }

    if (context === 'register') {
      if (lower.includes('at least') && lower.includes('password')) {
        return `Password terlalu lemah. Gunakan minimal ${MIN_PASSWORD_LENGTH} karakter.`;
      }
      if (code === 'user_already_exists' || lower.includes('already registered') || lower.includes('already exists')) {
        return 'Email sudah terdaftar. Gunakan mode Masuk, atau periksa email konfirmasi yang sudah dikirim.';
      }
      if (lower.includes('username') || lower.includes('duplicate') || code === '23505') {
        return 'Username sudah dipakai akun lain. Coba username lain.';
      }
      if (code === 'signup_disabled') {
        return 'Registrasi sedang dinonaktifkan pada proyek ini.';
      }
      if (lower.includes('rate limit') || lower.includes('too many')) {
        return 'Terlalu banyak percobaan mendaftar. Coba lagi beberapa saat.';
      }
    }

    if (context === 'resend') {
      if (lower.includes('rate limit') || lower.includes('too many') || code === 'over_email_send_rate_limit') {
        return 'Permintaan kirim ulang terlalu sering. Tunggu beberapa menit lalu coba lagi.';
      }
      if (code === 'email_not_found' || lower.includes('not found') || lower.includes('no user')) {
        return 'Email konfirmasi tidak ditemukan. Silakan daftar ulang atau periksa alamat email kamu.';
      }
      if (lower.includes('fetch') || lower.includes('network') || lower.includes('load failed') || lower.includes('timeout')) {
        return 'Tidak dapat menghubungi server. Periksa koneksi internet kamu, lalu coba lagi.';
      }
      return 'Tautan konfirmasi belum dapat dikirim ulang. Coba lagi beberapa saat lagi.';
    }

    if (context === 'reset') {
      if (lower.includes('rate limit') || lower.includes('too many') || code === 'over_email_send_rate_limit') {
        return 'Permintaan reset terlalu sering. Tunggu beberapa menit lalu coba lagi.';
      }
      if (lower.includes('fetch') || lower.includes('network') || lower.includes('load failed') || lower.includes('timeout')) {
        return 'Tidak dapat menghubungi server. Periksa koneksi internet kamu, lalu coba lagi.';
      }
      if (lower.includes('invalid email') || lower.includes('email address')) {
        return 'Format email tidak valid. Periksa kembali alamat email kamu.';
      }
      // Error lain sengaja tidak membedakan email terdaftar/tidak (cegah enumerasi akun).
      return 'Permintaan reset belum dapat diproses. Coba lagi beberapa saat lagi.';
    }

    if (context === 'update-password') {
      if (lower.includes('session missing') || lower.includes('auth session missing')) {
        return 'Sesi pemulihan sudah tidak valid. Silakan minta tautan reset baru.';
      }
      if (lower.includes('expired') || lower.includes('invalid') || lower.includes('jwt') || code === 'session_not_found') {
        return 'Sesi penggantian password sudah kedaluwarsa. Minta tautan reset baru dari form Lupa Password.';
      }
      if (lower.includes('at least') && lower.includes('password')) {
        return `Password terlalu lemah. Gunakan minimal ${MIN_PASSWORD_LENGTH} karakter.`;
      }
      if (lower.includes('same') && lower.includes('password')) {
        return 'Password baru tidak boleh sama dengan password lama. Gunakan password lain.';
      }
      if (lower.includes('rate limit') || lower.includes('too many')) {
        return 'Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.';
      }
      if (lower.includes('fetch') || lower.includes('network') || lower.includes('load failed') || lower.includes('timeout')) {
        return 'Tidak dapat menghubungi server. Periksa koneksi internet kamu, lalu coba lagi.';
      }
      return 'Password belum dapat disimpan. Minta tautan reset baru lalu coba lagi.';
    }

    if (context === 'profile') {
      if (code === '23505' || lower.includes('duplicate key') || lower.includes('profiles_username_key')) {
        return 'Username sudah digunakan. Silakan pilih username lain.';
      }
      if (code === '42501' || lower.includes('row-level security') || lower.includes('permission denied')) {
        return 'Perubahan profil tidak diizinkan untuk akun ini.';
      }
      if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('load failed') || lower.includes('timeout')) {
        return 'Tidak dapat menghubungi server. Periksa koneksi internet kamu, lalu coba lagi.';
      }
      return 'Profil belum dapat disimpan. Coba lagi beberapa saat lagi.';
    }

    if (context === 'logout') {
      return 'Gagal keluar. Periksa koneksi internet lalu coba lagi.';
    }

    if (lower.includes('fetch') || lower.includes('network') || lower.includes('load failed')) {
      return 'Tidak dapat menghubungi server. Periksa koneksi internet kamu.';
    }
    return message || 'Terjadi kesalahan. Coba lagi.';
  }

  // ---------------------------------------------------------------------------
  // Tampilan akun & navbar
  // ---------------------------------------------------------------------------

  function setSignedOutView() {
    accountBtn.textContent = 'Masuk / Daftar';
    accountBtn.setAttribute('aria-label', 'Masuk atau daftar akun');
    authAccountPanel.hidden = true;
    if (authAccountInfo) authAccountInfo.textContent = '';
    // Profil pengguna sebelumnya tidak boleh tertinggal di panel akun.
    profileLoadedFor = null;
    renderProfile(null, '');
    closeProfileEdit();
  }

  /** Inisial aman untuk avatar (maks. 2 huruf). */
  function initialsOf(name, email) {
    const source = String(name || '').trim() || String(email || '').trim();
    if (!source) return '?';
    if (source.includes('@') && !String(name || '').trim()) return source.charAt(0).toUpperCase();
    const words = source.split(/\s+/).filter(Boolean);
    const first = (words[0] || '').charAt(0) || '';
    const second = words.length > 1 ? (words[1] || '').charAt(0) : '';
    return (first + second).toUpperCase() || '?';
  }

  /** Isi panel profil dari data tabel (boleh null bila profil belum tersedia). */
  function renderProfile(profile, email) {
    const displayName = profile && profile.display_name ? String(profile.display_name).trim() : '';
    const username = profile && profile.username ? String(profile.username).trim() : '';
    const safeEmail = String(email || '').trim();

    if (profileAvatar) profileAvatar.textContent = initialsOf(displayName, safeEmail);
    if (profileDisplayName) profileDisplayName.textContent = displayName || 'Belum diatur';
    if (profileUsername) profileUsername.textContent = username ? `@${username}` : 'Username belum diatur';
    if (profileEmail) profileEmail.textContent = safeEmail;
  }

  /** Baca profil pengguna aktif dari public.profiles (hanya kolom yang diperlukan). */
  async function fetchProfile(userId) {
    if (!userId) return { ok: false, code: 'no-user', data: null };
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        console.warn('[auth] Profil gagal dibaca:', error.code || error.message);
        return { ok: false, code: error.code || 'error', data: null };
      }
      return { ok: true, data: data || null };
    } catch (err) {
      console.warn('[auth] Profil error:', (err && err.message) || err);
      return { ok: false, code: 'network', data: null };
    }
  }

  async function setSignedInView(user) {
    const email = String(user.email || '').trim();

    // Sumber utama: public.profiles. Metadata Auth hanya dipakai sebagai teks
    // tombol bila tabel belum bisa dibaca (mis. offline) - bukan sumber username.
    const result = await fetchProfile(user.id);
    const profile = result.ok ? result.data : null;
    profileLoadedFor = user.id;

    const displayName = (profile && profile.display_name) || '';
    const labelSource = displayName
      || String((user.user_metadata || {}).display_name || '').trim();
    accountBtn.textContent = labelSource || email || 'Akun';
    accountBtn.setAttribute('aria-label', `Akun ${labelSource || email || 'pengguna'}`);

    renderProfile(profile, email);
    if (profileStatus) {
      profileStatus.textContent = !result.ok
        ? 'Profil belum dapat dimuat. Beberapa informasi mungkin belum lengkap.'
        : (!profile ? 'Profil belum dibuat untuk akun ini.' : '');
    }
    authAccountPanel.hidden = false;
  }

  function applySession(session) {
    if (session && session.user) return setSignedInView(session.user);
    setSignedOutView();
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Modal: buka, tutup, ganti mode
  // ---------------------------------------------------------------------------

  /**
   * Ganti tampilan modal akun.
   * Mode: 'login' | 'register' | 'verify' | 'forgot' | 'resetSent' | 'reset'
   *   verify    : panel "tautan konfirmasi dikirim" (registrasi)
   *   forgot    : form email untuk meminta tautan reset password
   *   resetSent : panel netral "jika email terdaftar, tautan dikirim"
   *   reset     : form password baru setelah tautan reset dibuka (sesi recovery)
   */
  function setMode(mode) {
    const isRegister = mode === 'register';
    const isVerify = mode === 'verify';
    const isForgot = mode === 'forgot';
    const isResetSent = mode === 'resetSent';
    const isReset = mode === 'reset';
    const isCompact = isVerify || isForgot || isResetSent || isReset; // tanpa pengalih Masuk/Daftar
    currentMode = isVerify ? 'verify'
      : isForgot ? 'forgot'
        : isResetSent ? 'resetSent'
          : isReset ? 'reset'
            : isRegister ? 'register' : 'login';
    // Penanda "menunggu konfirmasi email" hanya berlaku selama panel konfirmasi tampil.
    emailConfirmRequired = isVerify;
    // Sesi recovery hanya dianggap aktif selama form reset ditampilkan.
    if (!isReset) {
      recoveryMode = false;
      recoverySession = null;
    }

    loginForm.hidden = currentMode !== 'login';
    registerForm.hidden = currentMode !== 'register';
    if (verifyPanel) verifyPanel.hidden = currentMode !== 'verify';
    if (forgotForm) forgotForm.hidden = currentMode !== 'forgot';
    if (resetSentPanel) resetSentPanel.hidden = currentMode !== 'resetSent';
    if (resetPasswordForm) resetPasswordForm.hidden = currentMode !== 'reset';
    // Panel akun tidak boleh tampil bersamaan dengan form reset / mode kompak.
    if (isReset) authAccountPanel.hidden = true;

    authModalTitle.textContent = isVerify ? 'Konfirmasi Email'
      : isForgot ? 'Lupa Password'
        : isResetSent ? 'Periksa Email'
          : isReset ? 'Atur Password Baru'
            : isRegister ? 'Daftar Akun' : 'Masuk';
    switchToRegisterBtn.setAttribute('aria-expanded', 'false');
    switchToLoginBtn.setAttribute('aria-expanded', 'false');
    if (forgotPasswordLink) forgotPasswordLink.setAttribute('aria-expanded', String(isForgot));
    // Mode tanpa pengalih: tombol Masuk/Daftar disembunyikan.
    switchToRegisterBtn.hidden = isCompact;
    switchToLoginBtn.hidden = isCompact;
    if (forgotPasswordLink) forgotPasswordLink.hidden = currentMode !== 'login';

    setStatus('');
    if (isVerify) {
      // Buka alur konfirmasi baru: cooldown dari registrasi sebelumnya (jika ada) tidak berlaku lagi.
      clearResendCooldown();
      if (otpEmailText) otpEmailText.textContent = pendingVerifyEmail;
      if (verifyResendBtn) verifyResendBtn.focus();
    } else if (isForgot) {
      clearResetCooldown();
      if (forgotEmail) {
        // Isi awal dari email login bila ada (memudahkan pengguna), tetap bisa diubah.
        if (!forgotEmail.value && loginEmail.value.trim()) forgotEmail.value = loginEmail.value.trim();
        forgotEmail.focus();
      }
    } else if (isResetSent) {
      if (resetSentEmail) resetSentEmail.textContent = pendingResetEmail;
      renderResetResendState();
      if (resetResendBtn) resetResendBtn.focus();
    } else if (isReset) {
      clearResendCooldown();
      clearResetCooldown();
      // Form password baru selalu dimulai kosong (tidak menyimpan password).
      if (resetPasswordInput) resetPasswordInput.value = '';
      if (resetPasswordConfirm) resetPasswordConfirm.value = '';
      if (resetPasswordInput) resetPasswordInput.focus();
    } else {
      if (isRegister) {
        // Memulai proses registrasi baru: email lama yang menunggu konfirmasi dibuang.
        pendingVerifyEmail = '';
        if (otpEmailText) otpEmailText.textContent = '';
      }
      // Keluar dari alur konfirmasi/OTP: cooldown kirim ulang dihentikan, flag request dilepas.
      clearResendCooldown();
      clearResetCooldown();
      (isRegister ? registerDisplayName : loginEmail).focus();
    }
  }

  function openAuthModal(event) {
    lastFocusedBeforeModal = document.activeElement;
    authModal.hidden = false;
    // Beri tahu pengelola fokus bersama agar #appShell dinonaktifkan (inert).
    // Teruskan elemen pemicu (event.currentTarget) supaya pemulihan fokus tidak
    // bergantung pada document.activeElement yang bisa sudah menjadi <body>
    // ketika modal dibuka lewat klik programatik / dari drawer.
    if (onModalOpen) onModalOpen(authModal, event && event.currentTarget ? event.currentTarget : null);
    setStatus('');
    if (recoveryMode) {
      // Prioritas tertinggi: sesi pemulihan password dari tautan email.
      // Panel akun harus tetap tersembunyi meskipun sesi recovery valid.
      authAccountPanel.hidden = true;
      setMode('reset');
    } else if (!authAccountPanel.hidden) {
      // Sudah login: tampilkan profil + tombol keluar, fokus ke tombol tutup.
      closeProfileEdit();
      closeAuthModalBtn.focus();
    } else if (emailConfirmRequired) {
      // Registrasi baru saja mengirim tautan konfirmasi: buka kembali panel konfirmasi,
      // jangan tertukar menjadi mode login/daftar.
      setMode('verify');
    } else {
      setMode('login');
    }
  }

  function closeAuthModal() {
    if (authModal.hidden) return;
    authModal.hidden = true;
    loginPassword.value = '';
    registerPassword.value = '';
    // Password baru tidak boleh tertinggal di input (tidak pernah disimpan di state/storage).
    if (resetPasswordInput) resetPasswordInput.value = '';
    if (resetPasswordConfirm) resetPasswordConfirm.value = '';
    // Cooldown & flag kirim ulang tidak boleh tertinggal saat modal ditutup.
    clearResendCooldown();
    clearResetCooldown();
    setBusy(false); // abort bila ada permintaan yang masih berjalan
    lastFocusedBeforeModal = null;
    // Beri tahu pengelola fokus bersama (app.js): melepas inert + memulihkan
    // fokus ke pemicu sebenarnya yang dicatat enterModal/onModalOpen. Ini harus
    // menjadi SATU-SATUNYA pemulihan fokus, supaya tetap benar ketika modal
    // dibuka dari drawer atau lewat klik programatik (activeElement = body).
    if (onModalClose) {
      onModalClose(authModal);
      return;
    }
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      lastFocusedBeforeModal.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Validasi klien (bukan pengganti validasi server)
  // ---------------------------------------------------------------------------

  function validateLogin({ email, password }) {
    if (!email) return 'Email wajib diisi.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Format email tidak valid.';
    if (!password) return 'Password wajib diisi.';
    return '';
  }

  /** Validasi email saja (dipakai form lupa password). */
  function validateEmailOnly(email) {
    if (!email) return 'Email wajib diisi.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Format email tidak valid.';
    return '';
  }

  /**
   * Validasi form Edit Profil. Aturannya sama dengan validateRegister()
   * (display name <=60 & tidak kosong setelah trim; username 3-30, A-Za-z0-9_).
   */
  function validateProfileEdit({ displayName, username }) {
    if (!displayName) return 'Nama tampilan wajib diisi.';
    if (displayName.length > 60) return 'Nama tampilan maksimal 60 karakter.';
    if (!username) return 'Username wajib diisi.';
    if (username.length < 3) return 'Username minimal 3 karakter.';
    if (username.length > 30) return 'Username maksimal 30 karakter.';
    if (!USERNAME_PATTERN.test(username)) return 'Username hanya boleh berisi huruf, angka, dan garis bawah.';
    return '';
  }

  /** Validasi form Atur Password Baru (validasi login tetap terpisah). */
  function validateNewPassword({ password, confirm }) {
    if (!password) return 'Password baru wajib diisi.';
    if (password.length < MIN_PASSWORD_LENGTH) return `Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.`;
    if (!confirm) return 'Konfirmasi password wajib diisi.';
    if (password !== confirm) return 'Konfirmasi password tidak sama dengan password baru.';
    return '';
  }

  function validateRegister({ displayName, username, email, password }) {
    if (!displayName) return 'Nama tampilan wajib diisi.';
    if (displayName.length > 60) return 'Nama tampilan maksimal 60 karakter.';
    if (!username) return 'Username wajib diisi.';
    if (username.length < 3) return 'Username minimal 3 karakter.';
    if (username.length > 30) return 'Username maksimal 30 karakter.';
    if (!USERNAME_PATTERN.test(username)) return 'Username hanya boleh berisi huruf, angka, dan garis bawah.';
    if (!email) return 'Email wajib diisi.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Format email tidak valid.';
    if (!password) return 'Password wajib diisi.';
    if (password.length < MIN_PASSWORD_LENGTH) return `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`;
    return '';
  }

  // ---------------------------------------------------------------------------
  // Aksi auth
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Kirim ulang tautan konfirmasi: cooldown 60 detik + label hitung mundur
  // ---------------------------------------------------------------------------

  /** Tampilkan sisa detik cooldown pada tombol dan atur status aktifnya. */
  function renderResendState() {
    if (!verifyResendBtn) return;
    const remaining = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
    if (remaining > 0) {
      verifyResendBtn.disabled = true;
      verifyResendBtn.textContent = `Kirim ulang dalam ${remaining} dtk`;
      return;
    }
    verifyResendBtn.disabled = resending || currentMode !== 'verify';
    // Kegagalan kirim ulang tidak boleh mengubah label tombol secara permanen.
    verifyResendBtn.textContent = resending ? 'Mengirim...' : RESEND_LABEL;
  }

  /** Hentikan timer dan kembalikan tombol kirim ulang ke keadaan awal. */
  function clearResendCooldown() {
    if (resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
    resendUntil = 0;
    resending = false;
    if (verifyResendBtn) {
      verifyResendBtn.disabled = currentMode !== 'verify';
      verifyResendBtn.textContent = RESEND_LABEL;
    }
  }

  /** Mulai cooldown 60 detik dan perbarui label setiap detik. */
  function startResendCooldown() {
    if (resendTimer) clearInterval(resendTimer);
    resendUntil = Date.now() + RESEND_COOLDOWN_MS;
    renderResendState();
    resendTimer = setInterval(() => {
      if (currentMode !== 'verify') {
        clearResendCooldown();
        return;
      }
      renderResendState();
      if (Date.now() >= resendUntil) {
        clearInterval(resendTimer);
        resendTimer = null;
        resendUntil = 0;
        renderResendState();
      }
    }, 1000);
  }

  /**
   * Kirim ulang tautan konfirmasi pendaftaran.
   * Flag sinkron `resending` (dipasang SEBELUM await) mencegah request bersamaan
   * walau tombol diklik dua kali beruntun.
   */
  async function handleResendLink() {
    if (currentMode !== 'verify' || resending) return;
    if (!pendingVerifyEmail) {
      setStatus('Email untuk konfirmasi tidak ditemukan. Silakan daftar ulang.', 'is-error');
      return;
    }
    if (Date.now() < resendUntil) {
      renderResendState();
      return;
    }

    resending = true;
    renderResendState(); // tombol nonaktif selama request berjalan
    setStatus('Mengirim ulang tautan konfirmasi...', 'is-info');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: pendingVerifyEmail });
      if (error) {
        setStatus(describeError(error, 'resend'), 'is-error');
        return;
      }
      setStatus(`Tautan konfirmasi baru sudah dikirim ke ${pendingVerifyEmail}. Periksa kotak masuk kamu.`, 'is-success');
      startResendCooldown();
    } catch (err) {
      setStatus(describeError(err, 'resend'), 'is-error');
    } finally {
      resending = false;
      renderResendState();
    }
  }

  // ---------------------------------------------------------------------------
  // Lupa password (D03-B): minta & kirim ulang tautan reset
  // ---------------------------------------------------------------------------

  /** Tampilkan sisa detik cooldown pada tombol kirim ulang tautan reset. */
  function renderResetResendState() {
    if (!resetResendBtn) return;
    const remaining = Math.max(0, Math.ceil((resetCooldownUntil - Date.now()) / 1000));
    if (remaining > 0) {
      resetResendBtn.disabled = true;
      resetResendBtn.textContent = `Kirim ulang dalam ${remaining} dtk`;
      return;
    }
    resetResendBtn.disabled = resetRequesting || currentMode !== 'resetSent';
    resetResendBtn.textContent = resetRequesting ? 'Mengirim...' : RESET_RESEND_LABEL;
  }

  function clearResetCooldown() {
    if (resetCooldownTimer) {
      clearInterval(resetCooldownTimer);
      resetCooldownTimer = null;
    }
    resetCooldownUntil = 0;
    resetRequesting = false;
    if (resetResendBtn) {
      resetResendBtn.disabled = currentMode !== 'resetSent';
      resetResendBtn.textContent = RESET_RESEND_LABEL;
    }
  }

  function startResetCooldown() {
    if (resetCooldownTimer) clearInterval(resetCooldownTimer);
    resetCooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
    renderResetResendState();
    resetCooldownTimer = setInterval(() => {
      if (currentMode !== 'resetSent') {
        clearResetCooldown();
        return;
      }
      renderResetResendState();
      if (Date.now() >= resetCooldownUntil) {
        clearInterval(resetCooldownTimer);
        resetCooldownTimer = null;
        resetCooldownUntil = 0;
        renderResetResendState();
      }
    }, 1000);
  }

  /**
   * Kirim permintaan tautan reset (juga dipakai tombol "Kirim Ulang Tautan").
   * Pesan hasil SELALU netral: tidak mengungkap apakah email terdaftar.
   * Flag sinkron `resetRequesting` dipasang sebelum await agar klik ganda
   * hanya menghasilkan satu request.
   */
  async function requestPasswordReset(email) {
    if (resetRequesting) return;
    if (Date.now() < resetCooldownUntil) {
      renderResetResendState();
      return;
    }

    pendingResetEmail = email;
    resetRequesting = true;
    renderResetResendState();
    setStatus('Memproses permintaan reset...', 'is-info');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      if (error) {
        console.warn('[auth] Permintaan reset gagal:', error.code || error.name || 'unknown');
        setStatus(describeError(error, 'reset'), 'is-error');
        return;
      }
      setMode('resetSent');
      setStatus('Jika email tersebut terdaftar, tautan reset sudah dikirim. Periksa kotak masuk dan folder spam.', 'is-success');
      startResetCooldown();
    } catch (err) {
      console.warn('[auth] Permintaan reset error:', (err && err.message) || err);
      setStatus(describeError(err, 'reset'), 'is-error');
    } finally {
      resetRequesting = false;
      renderResetResendState();
    }
  }

  async function handleForgotSubmit(event) {
    event.preventDefault();
    // Guard mode: Enter pada form lain tidak memicu permintaan reset tersembunyi.
    if (currentMode !== 'forgot' || resetRequesting) return;

    const email = String(forgotEmail ? forgotEmail.value : '').trim();
    const validationError = validateEmailOnly(email);
    if (validationError) {
      setStatus(validationError, 'is-error');
      if (forgotEmail) forgotEmail.focus();
      return;
    }

    setBusy(true);
    try {
      await requestPasswordReset(email);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetResend() {
    if (currentMode !== 'resetSent' || resetRequesting) return;
    if (!pendingResetEmail) {
      setStatus('Email untuk reset tidak ditemukan. Silakan minta tautan baru.', 'is-error');
      return;
    }
    if (Date.now() < resetCooldownUntil) {
      renderResetResendState();
      return;
    }
    await requestPasswordReset(pendingResetEmail);
  }

  // ---------------------------------------------------------------------------
  // Sesi pemulihan password (D03-C)
  // ---------------------------------------------------------------------------

  /**
   * Mulai alur "Atur Password Baru" dari event PASSWORD_RECOVERY.
   * Modal dibuka otomatis dalam mode reset; panel akun dipaksa tersembunyi.
   */
  function beginPasswordRecovery(session) {
    recoveryMode = true;
    recoverySession = session || null;
    // SDK hanya bisa updateUser bila sesi tersimpan di client. Bila sesi dari tautan
    // belum tersimpan (event dipancarkan sebelum storage siap), pasang sesinya dulu.
    // Kegagalan pemasangan sesi tidak fatal: submit akan memberi pesan sesi tidak valid.
    if (session && session.access_token && typeof supabase.auth.setSession === 'function') {
      Promise.resolve(supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      })).catch((err) => console.warn('[auth] Sesi pemulihan tidak dapat dipasang:', (err && err.message) || err));
    }
    // Buka modal lewat pintu yang sama dengan tombol akun agar inert/fokus tetap benar.
    if (authModal.hidden) openAuthModal(null);
    authAccountPanel.hidden = true;
    setMode('reset');
    setStatus('Tautan reset valid. Silakan buat password baru untuk akun kamu.', 'is-info');
  }

  /**
   * Tautan reset tidak valid / kedaluwarsa / tidak ada sesi: jangan buka form reset.
   * Arahkan pengguna ke mode forgot untuk meminta tautan baru.
   */
  function handleInvalidRecovery(message) {
    recoveryMode = false;
    recoverySession = null;
    if (authModal.hidden) openAuthModal(null);
    authAccountPanel.hidden = true;
    setMode('forgot');
    setStatus(message, 'is-error');
  }

  /** Simpan password baru dari form reset (hanya berlaku pada mode 'reset'). */
  async function handleResetPasswordSubmit(event) {
    event.preventDefault();
    // Guard mode: Enter pada form lain tidak memicu handler ini, dan submit hanya
    // berlaku selama sesi recovery ditampilkan.
    if (currentMode !== 'reset' || resetSubmitting) return;
    if (!recoveryMode) {
      handleInvalidRecovery('Sesi pemulihan tidak tersedia. Minta tautan reset baru dari form Lupa Password.');
      return;
    }

    const password = resetPasswordInput ? resetPasswordInput.value : '';
    const confirm = resetPasswordConfirm ? resetPasswordConfirm.value : '';
    const validationError = validateNewPassword({ password, confirm });
    if (validationError) {
      setStatus(validationError, 'is-error');
      if (resetPasswordInput) resetPasswordInput.focus();
      return;
    }

    resetSubmitting = true;
    setBusy(true);
    setStatus('Menyimpan password baru...', 'is-info');
    try {
      // Password baru dikirim bersama token sesi recovery. Token diteruskan eksplisit
      // karena alur pemulihan tidak selalu menghasilkan sesi tersimpan di client.
      const updateOptions = recoverySession && recoverySession.access_token
        ? { access_token: recoverySession.access_token }
        : undefined;
      const { error } = await supabase.auth.updateUser({ password }, updateOptions);
      if (error) {
        console.warn('[auth] Gagal menyimpan password baru:', error.code || error.name || 'unknown');
        if (error.name === 'AuthSessionMissingError') {
          // Hanya sesi yang benar-benar tidak tersedia yang dianggap "tautan tidak valid".
          setStatus(describeError(error, 'update-password'), 'is-error');
          if (!recoverySession || !recoverySession.access_token) {
            handleInvalidRecovery('Sesi pemulihan tidak tersedia. Minta tautan reset baru dari form Lupa Password.');
          }
          return;
        }
        if (error.code === 'session_not_found' || /jwt expired|invalid jwt|expired/i.test(`${error.message || ''}`)) {
          setStatus(describeError(error, 'update-password'), 'is-error');
          handleInvalidRecovery('Sesi pemulihan sudah kedaluwarsa. Minta tautan reset baru dari form Lupa Password.');
          return;
        }
        setStatus(describeError(error, 'update-password'), 'is-error');
        return;
      }

      // Password tidak disimpan: kosongkan input segera setelah server menerimanya.
      if (resetPasswordInput) resetPasswordInput.value = '';
      if (resetPasswordConfirm) resetPasswordConfirm.value = '';

      // Akhiri sesi recovery supaya pengguna masuk kembali dengan password baru.
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.warn('[auth] Sesi pemulihan gagal diakhiri:', (err && err.message) || err);
      }
      recoveryMode = false;
      recoverySession = null;
      setSignedOutView(); // panel akun tetap tersembunyi
      setMode('login');
      setStatus('Password berhasil diubah. Silakan masuk menggunakan password baru kamu.', 'is-success');
    } catch (err) {
      console.warn('[auth] Simpan password baru error:', (err && err.message) || err);
      setStatus(describeError(err, 'update-password'), 'is-error');
    } finally {
      resetSubmitting = false;
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit profil (D04-B)
  // ---------------------------------------------------------------------------

  function setProfileEditStatus(text = '', type = 'is-info') {
    if (!profileEditStatus) return;
    profileEditStatus.textContent = text;
    AUTH_STATUS_TYPES.forEach((cls) => profileEditStatus.classList.toggle(cls, cls === type));
  }

  /** Tampilkan form edit dengan nilai profil saat ini (dari panel yang sudah dimuat). */
  function openProfileEdit() {
    if (!profileEditForm) return;
    if (editDisplayName) {
      const shown = profileDisplayName ? profileDisplayName.textContent.trim() : '';
      editDisplayName.value = shown === 'Belum diatur' ? '' : shown;
    }
    if (editUsername) {
      const text = profileUsername ? profileUsername.textContent.trim() : '';
      editUsername.value = text.startsWith('@') ? text.slice(1) : '';
    }
    setProfileEditStatus('');
    profileEditForm.hidden = false;
    if (profileView) profileView.hidden = true;
    if (editProfileBtn) editProfileBtn.hidden = true;
    if (editDisplayName) editDisplayName.focus();
  }

  function closeProfileEdit() {
    if (profileEditForm) profileEditForm.hidden = true;
    if (profileView) profileView.hidden = false;
    if (editProfileBtn) editProfileBtn.hidden = false;
    setProfileEditStatus('');
  }

  /**
   * Simpan perubahan profil ke public.profiles.
   * Identitas HANYA dari sesi terverifikasi (getUser), tidak pernah dari input.
   */
  async function handleProfileSubmit(event) {
    event.preventDefault();
    if (profileSaving) return;

    const displayName = String(editDisplayName ? editDisplayName.value : '').trim();
    const username = String(editUsername ? editUsername.value : '').trim();
    const validationError = validateProfileEdit({ displayName, username });
    if (validationError) {
      setProfileEditStatus(validationError, 'is-error');
      if (editDisplayName) editDisplayName.focus();
      return;
    }

    profileSaving = true;
    if (saveProfileBtn) saveProfileBtn.disabled = true;
    setProfileEditStatus('Menyimpan perubahan...', 'is-info');
    try {
      // Sesi diverifikasi ke server; user.id dipakai sebagai filter, bukan dari form.
      const { data: authData, error: authError } = await supabase.auth.getUser();
      const user = authData && authData.user ? authData.user : null;
      if (authError || !user) {
        setProfileEditStatus('Sesi kamu sudah berakhir. Silakan masuk kembali untuk mengubah profil.', 'is-error');
        return;
      }

      const { data, error } = await supabase
        .from('profiles')
        .update({ display_name: displayName, username })
        .eq('id', user.id)
        .select('id, display_name, username')
        .maybeSingle();

      if (error) {
        console.warn('[auth] Simpan profil gagal:', error.code || error.message);
        setProfileEditStatus(describeError(error, 'profile'), 'is-error');
        return; // input tetap diisi agar pengguna bisa memperbaiki
      }
      if (!data) {
        setProfileEditStatus('Profil tidak ditemukan untuk akun ini. Coba masuk ulang.', 'is-error');
        return;
      }

      // Tampilkan hasil sebenarnya dari server (bukan sekadar nilai input).
      renderProfile(data, user.email);
      if (profileStatus) profileStatus.textContent = '';
      accountBtn.textContent = (data.display_name || '').trim() || user.email || 'Akun';
      accountBtn.setAttribute('aria-label', `Akun ${(data.display_name || '').trim() || user.email || 'pengguna'}`);
      closeProfileEdit();
      showToast('Profil berhasil diperbarui.');
    } catch (err) {
      console.warn('[auth] Simpan profil error:', (err && err.message) || err);
      setProfileEditStatus(describeError(err, 'profile'), 'is-error');
    } finally {
      profileSaving = false;
      if (saveProfileBtn) saveProfileBtn.disabled = false;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    // Mode daftar: Enter pada form lain tidak boleh memicu submit login tersembunyi.
    if (loginSubmitBtn.disabled || currentMode !== 'login') return;

    const email = loginEmail.value.trim();
    const password = loginPassword.value;

    const validationError = validateLogin({ email, password });
    if (validationError) {
      setStatus(validationError, 'is-error');
      return;
    }

    setBusy(true);
    setStatus('Memproses masuk...', 'is-info');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setStatus(describeError(error, 'login'), 'is-error');
        return;
      }
      loginPassword.value = '';
      await setSignedInView(data.user);
      setStatus('Berhasil masuk. Selamat memasak!', 'is-success');
    } catch (err) {
      setStatus(describeError(err, 'login'), 'is-error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    // Mode daftar: Enter pada form lain tidak boleh memicu submit registrasi tersembunyi.
    if (registerSubmitBtn.disabled || currentMode !== 'register') return;

    const displayName = registerDisplayName.value.trim();
    const username = registerUsername.value.trim();
    const email = registerEmail.value.trim();
    const password = registerPassword.value;

    const validationError = validateRegister({ displayName, username, email, password });
    if (validationError) {
      setStatus(validationError, 'is-error');
      return;
    }

    setBusy(true);
    setStatus('Mendaftarkan akun...', 'is-info');
    try {
      // Profil (display_name, username) dibuat oleh trigger database dari metadata ini.
      // Password HANYA dikirim ke Supabase Auth, tidak pernah ke tabel profiles.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName,
            username,
          },
        },
      });

      if (error) {
        setStatus(describeError(error, 'register'), 'is-error');
        return;
      }

      // Dengan "Confirm email" aktif: user dibuat, tetapi session = null.
      // Akun baru aktif setelah pengguna membuka tautan konfirmasi dari email (Supabase).
      if (!data.session) {
        // Simpan HANYA email yang benar-benar dikirim ke signUp() (variabel `email` di atas),
        // bukan dibaca ulang dari input yang mungkin sudah berubah. Password tidak disimpan.
        pendingVerifyEmail = email;
        registerPassword.value = '';
        setMode('verify');
        // Pesan netral: tidak mengungkap apakah email sudah terdaftar sebelumnya,
        // dan tidak menyebut kode (email konfirmasi berupa tautan).
        const text =
          'Tautan konfirmasi sudah dikirim. Buka email tersebut lalu klik tautannya untuk mengaktifkan akun. ' +
          'Jika email belum diterima, periksa folder spam atau kirim ulang tautan beberapa saat lagi.';
        setStatus(text, 'is-success');
        return;
      }

      registerPassword.value = '';
      await setSignedInView(data.user);
      setStatus('Pendaftaran berhasil. Kamu sudah masuk.', 'is-success');
    } catch (err) {
      setStatus(describeError(err, 'register'), 'is-error');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (logoutBtn.disabled) return;
    setBusy(true);
    setStatus('Keluar dari akun...', 'is-info');
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setStatus(describeError(error, 'logout'), 'is-error');
        return;
      }
      setSignedOutView();
      setMode('login'); // modal kembali ke mode masuk
      setStatus('Kamu sudah keluar dari akun.', 'is-info');
    } catch (err) {
      setStatus(describeError(err, 'logout'), 'is-error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Event listener (didaftarkan sekali lewat init di app.js)
  // ---------------------------------------------------------------------------

  accountBtn.addEventListener('click', (event) => openAuthModal(event));
  closeAuthModalBtn.addEventListener('click', closeAuthModal);
  authModal.addEventListener('click', (event) => {
    if (event.target === authModal) closeAuthModal(); // klik overlay saja
  });

  loginForm.addEventListener('submit', handleLogin);
  registerForm.addEventListener('submit', handleRegister);
  logoutBtn.addEventListener('click', handleLogout);

  switchToRegisterBtn.addEventListener('click', () => setMode('register'));
  switchToLoginBtn.addEventListener('click', () => setMode('login'));
  // Lupa password (D03-B)
  if (forgotPasswordLink) forgotPasswordLink.addEventListener('click', () => setMode('forgot'));
  if (forgotForm) forgotForm.addEventListener('submit', handleForgotSubmit);
  if (forgotBackBtn) forgotBackBtn.addEventListener('click', () => setMode('login'));
  if (resetSentBackBtn) resetSentBackBtn.addEventListener('click', () => setMode('login'));
  if (resetResendBtn) resetResendBtn.addEventListener('click', handleResetResend);
  // Panel password baru (D03-C)
  if (resetPasswordForm) resetPasswordForm.addEventListener('submit', handleResetPasswordSubmit);
  if (resetPasswordCancelBtn) resetPasswordCancelBtn.addEventListener('click', () => setMode('forgot'));

  // Profil (D04-B)
  if (editProfileBtn) editProfileBtn.addEventListener('click', openProfileEdit);
  if (cancelProfileBtn) cancelProfileBtn.addEventListener('click', closeProfileEdit);
  if (profileEditForm) profileEditForm.addEventListener('submit', handleProfileSubmit);
  // Panel konfirmasi -> kembali ke form daftar (satu-satunya jalan keluar dari panel).
  if (verifyBackBtn) verifyBackBtn.addEventListener('click', () => setMode('register'));
  if (verifyResendBtn) verifyResendBtn.addEventListener('click', handleResendLink);

  // Escape ditaruh di level modal, bukan document: handler Escape global di app.js
  // sengaja hanya menutup modal detail/favorit/picker, jadi tidak ada aksi ganda.
  authModal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // closeAuthModal() sudah mengembalikan fokus ke elemen pemicu sebenarnya
      // (lastFocusedBeforeModal); jangan menimpanya dengan accountBtn.
      closeAuthModal();
    }
  });

  // ---------------------------------------------------------------------------
  // Pemulihan sesi & listener auth
  // ---------------------------------------------------------------------------

  // Listener didaftarkan SEBELUM getSession() supaya tidak ada perubahan sesi
  // (mis. token di-refresh saat halaman dibuka) yang terlewat.
  // Catatan: callback dibuat NON-async. Panggilan supabase.auth di dalam
  // onAuthStateChange bisa macet; update nama profil ditunda lewat resolve().
  const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
    // Sesi pemulihan password (dibuka dari tautan email) menang atas kondisi "sudah login":
    // tampilkan form password baru, JANGAN tampilkan panel akun.
    if (event === 'PASSWORD_RECOVERY' && session && session.user) {
      const next = Promise.resolve(beginPasswordRecovery(session));
      return next;
    }
    // Sementara mode recovery aktif, event sesi lain (mis. INITIAL_SESSION / TOKEN_REFRESHED)
    // tidak boleh menimpa tampilan reset atau memunculkan panel akun.
    if (recoveryMode) return undefined;

    const next = Promise.resolve(applySession(session));
    // INITIAL_SESSION / TOKEN_REFRESHED perlu ditunggu sampai selesai.
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return next;
    return undefined;
  });

  try {
    // Mengembalikan sesi dari storage (localStorage) bila masih valid.
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('[auth] Gagal memulihkan sesi:', error.message || error.name || 'unknown');
      setSignedOutView();
    } else {
      await applySession(data.session);
    }
  } catch (err) {
    // Supabase belum siap / koneksi terputus -> aplikasi resep tetap jalan tanpa login.
    if (!isAuthUnavailableError(err)) {
      console.warn('[auth] Pemeriksaan sesi gagal:', (err && err.message) || err);
    }
    setSignedOutView();
  }

  return {
    close: closeAuthModal,
    // Untuk pemakaian lanjutan bila perlu melepas listener; app.js tidak memanggilnya
    // karena init() hanya berjalan sekali per muat halaman.
    unsubscribe: () => listener.subscription.unsubscribe(),
  };
}

// ==========================================================================
// Fallback untuk browser yang menganggap tombol Escape sebagai activation
// behavior (default Modernizr): "keydown Escape -> klik" pada elemen yang sedang
// fokus. Tanpa ini, Escape di input modal bisa memicu tombol "Daftar"/"Masuk".
// Target selalu elemen yang benar-benar aktif, jadi klik saat Escape di overlay
// tidak ikut memicu apa pun (overlay bukan elemen yang fokusable).
// Harus dipasang paling akhir supaya menangkap klik sintetis dari browser.
// ==========================================================================
document.addEventListener(
  'click',
  (event) => {
    const active = document.activeElement;
    if (!active || active === document.body) return;
    if (active.dataset.lastInteractionKey !== 'Escape') return;
    if (event.target !== active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
document.addEventListener('keyup', (event) => {
  if (event.key !== 'Escape') return;
  const active = document.activeElement;
  if (active && active !== document.body) active.dataset.lastInteractionKey = '';
});
