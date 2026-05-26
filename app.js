// ==========================================================================
// TURNOS - App de turnos con sincronización Firebase
// ==========================================================================

const DEFAULT_SHIFTS = [
  { id: 'M', code: 'M', name: 'Mañana', color: '#e11d48', hours: 8 },
  { id: 'T', code: 'T', name: 'Tarde', color: '#facc15', hours: 8 },
  { id: 'N', code: 'N', name: 'Noche', color: '#1e1e1e', hours: 10 },
  { id: 'S', code: 'S', name: 'Saliente', color: '#86efac', hours: 0 },
  { id: 'L', code: 'L', name: 'Libre', color: '#22c55e', hours: 0 },
  { id: 'V', code: 'V', name: 'Vacaciones', color: '#3b82f6', hours: 0 },
  { id: 'F', code: 'F', name: 'Festivo', color: '#1e3a8a', hours: 0 },
  { id: 'LD', code: 'LD', name: 'Libre Disp.', color: '#a855f7', hours: 0 },
];

const COLOR_PALETTE = [
  '#e11d48','#facc15','#1e1e1e','#86efac','#22c55e','#3b82f6',
  '#1e3a8a','#a855f7','#ec4899','#14b8a6','#f97316','#06b6d4',
  '#84cc16','#f43f5e','#8b5cf6','#10b981','#0ea5e9','#d946ef'
];

const STORAGE_KEY_CONFIG = 'turnos-firebase-config';
const STORAGE_KEY_LOCAL = 'turnos-local-data';
const STORAGE_KEY_LAST_USER = 'turnos-last-user';
const STORAGE_KEY_THEME = 'turnos-theme';
const STORAGE_KEY_NOTIF_TIME = 'turnos-notif-time';
const STORAGE_KEY_PIN_SESSION = 'turnos-pin-session';
const STORAGE_KEY_PIN_FAILS = 'turnos-pin-fails';
const STORAGE_KEY_PIN_LOCKED_UNTIL = 'turnos-pin-locked-until';

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 5;
const PIN_SESSION_MINUTES = 60 * 12; // re-pedir PIN tras 12h de inactividad

// ==========================================================================
// State
// ==========================================================================
let state = {
  users: {
    user1: { name: 'Persona 1', shifts: [...DEFAULT_SHIFTS], days: {}, notes: {}, payrolls: {}, tenure: { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} }, vacations: { totalPerYear: 22, ldPerYear: 0 } },
    user2: { name: 'Persona 2', shifts: [...DEFAULT_SHIFTS], days: {}, notes: {}, payrolls: {}, tenure: { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} }, vacations: { totalPerYear: 22, ldPerYear: 0 } },
  },
  events: {}, // shared events
  appConfig: { pinHash: null, pinEnabled: false }, // shared app config
  currentUser: 'user1',
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
  selectedDate: null,
  statsMode: 'month',
  statsYear: new Date().getFullYear(),
  statsMonth: new Date().getMonth(),
  evViewYear: new Date().getFullYear(),
  evViewMonth: new Date().getMonth(),
  evSelectedDate: null,
};

let firebase = null;
let firebaseApp = null;
let firebaseDb = null;
let firebaseStorage = null;
let firebaseConnected = false;
let unsubscribers = [];
let suppressFirebaseWrite = false;
let chartInstances = {};

// ==========================================================================
// INIT
// ==========================================================================
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('firebaseReady', () => { firebase = window.firebase; tryConnectFirebase(); });

function init() {
  applyTheme(localStorage.getItem(STORAGE_KEY_THEME) || 'dark');
  const cfg = localStorage.getItem(STORAGE_KEY_CONFIG);
  if (cfg) {
    document.getElementById('firebaseConfigInput').value = cfg;
    tryConnectFirebase();
  }
  
  // If no config and skipped before, load local
  const localData = localStorage.getItem(STORAGE_KEY_LOCAL);
  if (localData && !cfg) {
    try {
      const parsed = JSON.parse(localData);
      mergeStateData(parsed);
      showApp();
    } catch (e) { console.warn('Could not parse local data', e); }
  }
  
  // Ask for notification permission on first interaction
  setTimeout(checkNotificationPermission, 2000);
}

function tryConnectFirebase() {
  if (!firebase) return;
  const cfg = localStorage.getItem(STORAGE_KEY_CONFIG);
  if (!cfg) return;
  try {
    const config = JSON.parse(cfg);
    firebaseApp = firebase.initializeApp(config);
    firebaseDb = firebase.getDatabase(firebaseApp);
    try { firebaseStorage = firebase.getStorage(firebaseApp); } catch(e) { console.warn('Storage not available', e); }
    firebaseConnected = true;
    
    // Fetch initial appConfig BEFORE showing app, so we know if PIN is needed
    firebase.get(firebase.ref(firebaseDb, 'appConfig')).then(snap => {
      const val = snap.val();
      if (val) state.appConfig = { ...state.appConfig, ...val };
      // Also fetch users first to have them ready
      return Promise.all([
        firebase.get(firebase.ref(firebaseDb, 'users/user1')),
        firebase.get(firebase.ref(firebaseDb, 'users/user2')),
        firebase.get(firebase.ref(firebaseDb, 'events'))
      ]);
    }).then(([u1, u2, ev]) => {
      if (u1.val()) state.users.user1 = { ...state.users.user1, ...u1.val() };
      if (u2.val()) state.users.user2 = { ...state.users.user2, ...u2.val() };
      if (ev.val()) state.events = ev.val();
      // Ensure structure
      for (const uid of ['user1','user2']) {
        if (!state.users[uid].shifts || !state.users[uid].shifts.length) state.users[uid].shifts = [...DEFAULT_SHIFTS];
        if (!state.users[uid].tenure) state.users[uid].tenure = { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} };
        if (!state.users[uid].tenure.periods) state.users[uid].tenure.periods = [];
        normalizeDays(state.users[uid]);
      }
      setupFirebaseSync();
      showApp();
      updateSyncDot(true);
    }).catch(err => {
      console.error('Initial fetch error', err);
      setupFirebaseSync();
      showApp();
      updateSyncDot(true);
    });
  } catch (err) {
    console.error('Firebase connect error', err);
    toast('Error conectando a Firebase: ' + err.message, 'error');
  }
}

function saveFirebaseConfig() {
  const txt = document.getElementById('firebaseConfigInput').value.trim();
  if (!txt) { toast('Pega la configuración', 'error'); return; }
  try {
    const cfg = JSON.parse(txt);
    if (!cfg.databaseURL) { toast('Falta databaseURL en la config', 'error'); return; }
    localStorage.setItem(STORAGE_KEY_CONFIG, txt);
    tryConnectFirebase();
  } catch (err) {
    toast('JSON inválido. Comprueba el formato.', 'error');
  }
}

function skipFirebase() {
  showApp();
  updateSyncDot(false);
  toast('Modo local. Los datos solo se guardarán en este móvil.', 'info');
}

function showApp() {
  document.getElementById('setupScreen').style.display = 'none';
  
  // Check PIN before showing app
  if (state.appConfig?.pinEnabled && state.appConfig?.pinHash) {
    // Check if there's a valid session
    const session = localStorage.getItem(STORAGE_KEY_PIN_SESSION);
    if (session) {
      const sessionTs = parseInt(session);
      if (Date.now() - sessionTs < PIN_SESSION_MINUTES * 60 * 1000) {
        // Valid session, skip PIN
        showAppContent();
        return;
      }
    }
    showPinScreen();
    return;
  }
  
  showAppContent();
}

function showAppContent() {
  document.getElementById('pinScreen').style.display = 'none';
  document.getElementById('header').style.display = 'flex';
  document.getElementById('userTabs').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('navBottom').style.display = 'flex';
  
  const lastUser = localStorage.getItem(STORAGE_KEY_LAST_USER);
  if (lastUser && state.users[lastUser]) state.currentUser = lastUser;
  
  renderUserTabs();
  renderCalendar();
}

// ==========================================================================
// PIN (lock screen)
// ==========================================================================
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showPinScreen() {
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('header').style.display = 'none';
  document.getElementById('userTabs').style.display = 'none';
  document.getElementById('main').style.display = 'none';
  document.getElementById('navBottom').style.display = 'none';
  
  const pinScreen = document.getElementById('pinScreen');
  pinScreen.style.display = 'flex';
  
  const lockedUntil = parseInt(localStorage.getItem(STORAGE_KEY_PIN_LOCKED_UNTIL) || '0');
  const now = Date.now();
  
  if (lockedUntil > now) {
    renderPinLocked(lockedUntil);
    return;
  }
  
  renderPinPad();
}

function renderPinPad() {
  const pinScreen = document.getElementById('pinScreen');
  const fails = parseInt(localStorage.getItem(STORAGE_KEY_PIN_FAILS) || '0');
  const remaining = PIN_MAX_FAILS - fails;
  
  pinScreen.innerHTML = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="width:64px;height:64px;background:linear-gradient(135deg,var(--accent),var(--accent-2));border-radius:18px;display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:16px;box-shadow:0 8px 32px var(--accent-glow);">🔒</div>
      <h1 style="margin:0 0 4px;font-size:24px;font-weight:700;">Introduce el PIN</h1>
      <p style="color:var(--text-dim);margin:0;font-size:13px;">${fails > 0 ? `${remaining} intento${remaining===1?'':'s'} restante${remaining===1?'':'s'}` : ''}</p>
    </div>
    <div id="pinDots" style="display:flex;gap:12px;margin-bottom:32px;"></div>
    <div id="pinPad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;width:280px;"></div>
    <div id="pinError" style="color:var(--danger);font-size:13px;margin-top:14px;height:18px;font-weight:500;"></div>
  `;
  
  window._pinEntry = '';
  window._pinLength = 0;
  renderPinDots();
  renderPinButtons();
}

function renderPinDots() {
  const dotsEl = document.getElementById('pinDots');
  if (!dotsEl) return;
  // Show 4-6 dots dynamically based on entry length, max we visualize 6
  const visualLen = Math.max(4, Math.min(6, window._pinEntry.length || 4));
  const entryLen = window._pinEntry.length;
  let html = '';
  for (let i = 0; i < Math.max(visualLen, entryLen); i++) {
    const filled = i < entryLen;
    html += `<div style="width:18px;height:18px;border-radius:50%;border:2px solid var(--accent);background:${filled ? 'var(--accent)' : 'transparent'};transition:all 0.15s;"></div>`;
  }
  dotsEl.innerHTML = html;
}

function renderPinButtons() {
  const padEl = document.getElementById('pinPad');
  if (!padEl) return;
  const layout = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  padEl.innerHTML = layout.map(key => {
    if (!key) return '<div></div>';
    if (key === '⌫') {
      return `<button onclick="pinDelete()" style="height:68px;background:transparent;border:none;color:var(--text);font-size:22px;cursor:pointer;border-radius:50%;">⌫</button>`;
    }
    return `<button onclick="pinPress('${key}')" style="height:68px;background:var(--panel);border:1px solid var(--border);color:var(--text);font-size:26px;font-weight:600;cursor:pointer;border-radius:50%;transition:transform 0.1s;font-family:'JetBrains Mono',monospace;" ontouchstart="this.style.transform='scale(0.92)';this.style.background='var(--panel-2)'" ontouchend="this.style.transform='';this.style.background='var(--panel)'">${key}</button>`;
  }).join('');
  
  // Add a "submit" hint area or use enter on 4+ digits
  // We auto-validate on 4-8 digits but require explicit submit only if pinSubmitMode
  // Let's auto-validate when length >= configured length (we save the length when set)
}

async function pinPress(digit) {
  if (window._pinEntry.length >= 8) return;
  window._pinEntry += digit;
  renderPinDots();
  
  // Auto-validate when length matches saved length
  const savedLen = state.appConfig?.pinLength || 4;
  if (window._pinEntry.length === savedLen) {
    setTimeout(() => validatePin(), 150);
  }
}

function pinDelete() {
  window._pinEntry = window._pinEntry.slice(0, -1);
  renderPinDots();
}

async function validatePin() {
  const entered = window._pinEntry;
  const hash = await sha256(entered);
  const expected = state.appConfig?.pinHash;
  
  if (hash === expected) {
    // Success
    localStorage.setItem(STORAGE_KEY_PIN_SESSION, String(Date.now()));
    localStorage.removeItem(STORAGE_KEY_PIN_FAILS);
    localStorage.removeItem(STORAGE_KEY_PIN_LOCKED_UNTIL);
    document.getElementById('pinScreen').style.display = 'none';
    showAppContent();
  } else {
    // Fail
    let fails = parseInt(localStorage.getItem(STORAGE_KEY_PIN_FAILS) || '0') + 1;
    localStorage.setItem(STORAGE_KEY_PIN_FAILS, String(fails));
    
    if (fails >= PIN_MAX_FAILS) {
      const lockedUntil = Date.now() + PIN_LOCK_MINUTES * 60 * 1000;
      localStorage.setItem(STORAGE_KEY_PIN_LOCKED_UNTIL, String(lockedUntil));
      renderPinLocked(lockedUntil);
    } else {
      // Shake and clear
      const dotsEl = document.getElementById('pinDots');
      const errEl = document.getElementById('pinError');
      if (dotsEl) {
        dotsEl.style.animation = 'shake 0.4s';
        setTimeout(() => { dotsEl.style.animation = ''; }, 400);
      }
      if (errEl) errEl.textContent = `PIN incorrecto · ${PIN_MAX_FAILS - fails} intento${PIN_MAX_FAILS - fails === 1 ? '' : 's'} restante${PIN_MAX_FAILS - fails === 1 ? '' : 's'}`;
      window._pinEntry = '';
      renderPinDots();
    }
  }
}

function renderPinLocked(lockedUntil) {
  const pinScreen = document.getElementById('pinScreen');
  pinScreen.innerHTML = `
    <div style="text-align:center;">
      <div style="width:64px;height:64px;background:var(--danger);border-radius:18px;display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:16px;">⛔</div>
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;">Bloqueado</h1>
      <p style="color:var(--text-dim);margin:0 0 20px;max-width:280px;">Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.</p>
      <div id="lockCountdown" style="font-size:48px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--danger);"></div>
    </div>
  `;
  
  const updateCountdown = () => {
    const remaining = lockedUntil - Date.now();
    if (remaining <= 0) {
      localStorage.removeItem(STORAGE_KEY_PIN_LOCKED_UNTIL);
      localStorage.removeItem(STORAGE_KEY_PIN_FAILS);
      renderPinPad();
      return;
    }
    const min = Math.floor(remaining / 60000);
    const sec = Math.floor((remaining % 60000) / 1000);
    const el = document.getElementById('lockCountdown');
    if (el) el.textContent = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    setTimeout(updateCountdown, 500);
  };
  updateCountdown();
}

async function setupPin() {
  const enteredPin = await new Promise(resolve => {
    openModal('Establecer PIN', `
      <p class="muted" style="margin-top:0;">Crea un PIN de 4 a 6 dígitos. Se pedirá al abrir la app.</p>
      <input type="password" inputmode="numeric" pattern="[0-9]*" class="input-field" id="newPinInput" placeholder="Nuevo PIN" maxlength="6" autocomplete="off">
      <input type="password" inputmode="numeric" pattern="[0-9]*" class="input-field mt-12" id="newPinConfirm" placeholder="Confirma PIN" maxlength="6" autocomplete="off">
      <div id="pinSetupError" style="color:var(--danger);font-size:13px;margin-top:8px;min-height:18px;"></div>
    `, [
      { text: 'Cancelar', class: 'btn-secondary', onClick: () => { resolve(null); closeModal(); } },
      { text: 'Establecer', onClick: () => {
        const a = document.getElementById('newPinInput').value;
        const b = document.getElementById('newPinConfirm').value;
        const err = document.getElementById('pinSetupError');
        if (!/^\d{4,6}$/.test(a)) { err.textContent = 'El PIN debe tener entre 4 y 6 dígitos'; return; }
        if (a !== b) { err.textContent = 'Los PINs no coinciden'; return; }
        resolve(a);
        closeModal();
      }}
    ]);
    setTimeout(() => document.getElementById('newPinInput')?.focus(), 100);
  });
  
  if (!enteredPin) return;
  
  const hash = await sha256(enteredPin);
  state.appConfig = state.appConfig || {};
  state.appConfig.pinHash = hash;
  state.appConfig.pinEnabled = true;
  state.appConfig.pinLength = enteredPin.length;
  saveAppConfig();
  // Mark current session as valid
  localStorage.setItem(STORAGE_KEY_PIN_SESSION, String(Date.now()));
  toast('PIN establecido. Se pedirá en ambos móviles.', 'success');
}

async function changePin() {
  // First verify current PIN
  if (state.appConfig?.pinEnabled && state.appConfig?.pinHash) {
    const cur = await new Promise(resolve => {
      openModal('Cambiar PIN', `
        <p class="muted" style="margin-top:0;">Introduce el PIN actual:</p>
        <input type="password" inputmode="numeric" pattern="[0-9]*" class="input-field" id="curPinInput" maxlength="6" autocomplete="off">
        <div id="curPinError" style="color:var(--danger);font-size:13px;margin-top:8px;min-height:18px;"></div>
      `, [
        { text: 'Cancelar', class: 'btn-secondary', onClick: () => { resolve(null); closeModal(); } },
        { text: 'Continuar', onClick: async () => {
          const val = document.getElementById('curPinInput').value;
          const h = await sha256(val);
          if (h === state.appConfig.pinHash) { resolve(val); closeModal(); }
          else { document.getElementById('curPinError').textContent = 'PIN incorrecto'; }
        }}
      ]);
      setTimeout(() => document.getElementById('curPinInput')?.focus(), 100);
    });
    if (!cur) return;
  }
  setupPin();
}

async function disablePin() {
  if (!confirm('¿Desactivar el PIN? La app dejará de pedirlo al abrirse.')) return;
  // Verify current PIN first
  if (state.appConfig?.pinHash) {
    const cur = prompt('Introduce el PIN actual para confirmar:');
    if (!cur) return;
    const h = await sha256(cur);
    if (h !== state.appConfig.pinHash) {
      toast('PIN incorrecto', 'error');
      return;
    }
  }
  state.appConfig.pinEnabled = false;
  state.appConfig.pinHash = null;
  state.appConfig.pinLength = null;
  saveAppConfig();
  localStorage.removeItem(STORAGE_KEY_PIN_SESSION);
  localStorage.removeItem(STORAGE_KEY_PIN_FAILS);
  localStorage.removeItem(STORAGE_KEY_PIN_LOCKED_UNTIL);
  toast('PIN desactivado', 'success');
  closeModal();
  setTimeout(openSettings, 100);
}

function lockNow() {
  localStorage.removeItem(STORAGE_KEY_PIN_SESSION);
  showPinScreen();
  toast('App bloqueada', 'info');
  closeModal();
}

function saveAppConfig() {
  if (!firebaseConnected) {
    localStorage.setItem(STORAGE_KEY_LOCAL, JSON.stringify({ users: state.users, events: state.events, appConfig: state.appConfig }));
    return;
  }
  suppressFirebaseWrite = true;
  firebase.set(firebase.ref(firebaseDb, 'appConfig'), state.appConfig)
    .then(() => { setTimeout(() => suppressFirebaseWrite = false, 200); })
    .catch(err => { console.error(err); toast('Error guardando: ' + err.message, 'error'); suppressFirebaseWrite = false; });
}

function updateSyncDot(connected) {
  const dot = document.getElementById('syncDot');
  if (connected) { dot.classList.remove('offline'); dot.title = 'Sincronizado'; }
  else { dot.classList.add('offline'); dot.title = 'Solo local'; }
}

// ==========================================================================
// FIREBASE SYNC
// ==========================================================================
function setupFirebaseSync() {
  if (!firebaseConnected) return;
  unsubscribers.forEach(u => u());
  unsubscribers = [];
  
  // Listen to users
  for (const uid of ['user1', 'user2']) {
    const r = firebase.ref(firebaseDb, `users/${uid}`);
    const unsub = firebase.onValue(r, snap => {
      const val = snap.val();
      if (val && !suppressFirebaseWrite) {
        state.users[uid] = { ...state.users[uid], ...val };
        if (!state.users[uid].shifts || !state.users[uid].shifts.length) state.users[uid].shifts = [...DEFAULT_SHIFTS];
        if (!state.users[uid].days) state.users[uid].days = {};
        if (!state.users[uid].notes) state.users[uid].notes = {};
        if (!state.users[uid].payrolls) state.users[uid].payrolls = {};
        if (!state.users[uid].tenure) state.users[uid].tenure = { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} };
        if (!state.users[uid].tenure.periods) state.users[uid].tenure.periods = [];
        if (!state.users[uid].vacations) state.users[uid].vacations = { totalPerYear: 22, ldPerYear: 0 };
        // Normalize days to multi-shift format
        normalizeDays(state.users[uid]);
        renderAll();
      }
    });
    unsubscribers.push(() => firebase.onValue(r, () => {}, { onlyOnce: true }));
  }
  
  // Listen to events
  const eR = firebase.ref(firebaseDb, 'events');
  firebase.onValue(eR, snap => {
    const val = snap.val();
    if (!suppressFirebaseWrite) {
      state.events = val || {};
      if (currentPage === 'events') renderEvents();
      renderCalendar();
    }
  });
  
  // Listen to app config (PIN)
  const cR = firebase.ref(firebaseDb, 'appConfig');
  firebase.onValue(cR, snap => {
    const val = snap.val();
    if (val && !suppressFirebaseWrite) {
      state.appConfig = { ...state.appConfig, ...val };
    }
  });
}

function normalizeDays(user) {
  // Convert legacy {shiftId, hours} format to {shifts: [{shiftId, hours}]}
  if (!user.days) return;
  for (const key of Object.keys(user.days)) {
    const d = user.days[key];
    if (!d) { delete user.days[key]; continue; }
    if (d.shifts && Array.isArray(d.shifts)) continue; // already new format
    if (d.shiftId) {
      user.days[key] = { shifts: [{ shiftId: d.shiftId, hours: d.hours || 0 }] };
    } else {
      delete user.days[key];
    }
  }
}

// Helper: get array of {shiftId, hours} for a day, or empty array
function getDayShifts(dayData) {
  if (!dayData) return [];
  if (dayData.shifts && Array.isArray(dayData.shifts)) return dayData.shifts;
  if (dayData.shiftId) return [{ shiftId: dayData.shiftId, hours: dayData.hours || 0 }];
  return [];
}

function saveUser(uid) {
  // Always cache locally
  localStorage.setItem(STORAGE_KEY_LOCAL, JSON.stringify({ users: state.users, events: state.events, appConfig: state.appConfig }));
  if (!firebaseConnected) return;
  suppressFirebaseWrite = true;
  firebase.set(firebase.ref(firebaseDb, `users/${uid}`), state.users[uid])
    .then(() => { setTimeout(() => suppressFirebaseWrite = false, 200); })
    .catch(err => { console.error(err); toast('Error guardando: ' + err.message, 'error'); suppressFirebaseWrite = false; });
}

function saveEvents() {
  localStorage.setItem(STORAGE_KEY_LOCAL, JSON.stringify({ users: state.users, events: state.events, appConfig: state.appConfig }));
  if (!firebaseConnected) return;
  suppressFirebaseWrite = true;
  firebase.set(firebase.ref(firebaseDb, 'events'), state.events)
    .then(() => { setTimeout(() => suppressFirebaseWrite = false, 200); })
    .catch(err => { console.error(err); toast('Error guardando: ' + err.message, 'error'); suppressFirebaseWrite = false; });
}

function mergeStateData(data) {
  if (data.users) {
    for (const uid of ['user1', 'user2']) {
      if (data.users[uid]) state.users[uid] = { ...state.users[uid], ...data.users[uid] };
      if (!state.users[uid].shifts || !state.users[uid].shifts.length) state.users[uid].shifts = [...DEFAULT_SHIFTS];
      if (!state.users[uid].tenure) state.users[uid].tenure = { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} };
      if (!state.users[uid].tenure.periods) state.users[uid].tenure.periods = [];
      normalizeDays(state.users[uid]);
    }
  }
  if (data.events) state.events = data.events;
  if (data.appConfig) state.appConfig = { ...state.appConfig, ...data.appConfig };
}

// ==========================================================================
// USER TABS
// ==========================================================================
function renderUserTabs() {
  const el = document.getElementById('userTabs');
  el.innerHTML = '';
  for (const uid of ['user1', 'user2']) {
    const btn = document.createElement('button');
    btn.className = 'user-tab' + (state.currentUser === uid ? ' active' : '');
    btn.textContent = state.users[uid].name || (uid === 'user1' ? 'Persona 1' : 'Persona 2');
    btn.onclick = () => switchUser(uid);
    btn.oncontextmenu = (e) => { e.preventDefault(); renameUser(uid); };
    btn.addEventListener('touchstart', () => { btn._longPressTimer = setTimeout(() => renameUser(uid), 600); });
    btn.addEventListener('touchend', () => clearTimeout(btn._longPressTimer));
    btn.addEventListener('touchmove', () => clearTimeout(btn._longPressTimer));
    el.appendChild(btn);
  }
}

function switchUser(uid) {
  state.currentUser = uid;
  localStorage.setItem(STORAGE_KEY_LAST_USER, uid);
  renderUserTabs();
  renderAll();
}

function renameUser(uid) {
  const current = state.users[uid].name;
  const name = prompt('Nombre de la persona:', current);
  if (name !== null && name.trim()) {
    state.users[uid].name = name.trim();
    saveUser(uid);
    renderUserTabs();
  }
}

// ==========================================================================
// CALENDAR
// ==========================================================================
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function renderCalendar() {
  document.getElementById('calMonth').textContent = `${MONTHS[state.viewMonth]} ${state.viewYear}`;
  
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  
  const firstDay = new Date(state.viewYear, state.viewMonth, 1);
  const lastDay = new Date(state.viewYear, state.viewMonth + 1, 0);
  // Monday-based week
  let startWeekday = firstDay.getDay() - 1;
  if (startWeekday < 0) startWeekday = 6;
  
  // Previous month days
  const prevLast = new Date(state.viewYear, state.viewMonth, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    grid.appendChild(buildDayCell(state.viewYear, state.viewMonth - 1, prevLast - i, true));
  }
  
  // Current month
  for (let d = 1; d <= lastDay.getDate(); d++) {
    grid.appendChild(buildDayCell(state.viewYear, state.viewMonth, d, false));
  }
  
  // Trailing days
  const totalCells = grid.children.length;
  const cellsNeeded = Math.ceil(totalCells / 7) * 7;
  for (let i = 1; i <= cellsNeeded - totalCells; i++) {
    grid.appendChild(buildDayCell(state.viewYear, state.viewMonth + 1, i, true));
  }
}

function buildDayCell(year, month, day, otherMonth) {
  const date = new Date(year, month, day);
  const dateKey = formatDate(date);
  const cell = document.createElement('div');
  cell.className = 'cal-day';
  if (otherMonth) cell.classList.add('other-month');
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) cell.classList.add('weekend');
  
  const today = new Date();
  if (date.toDateString() === today.toDateString()) cell.classList.add('today');
  
  const num = document.createElement('div');
  num.className = 'cal-day-num';
  num.textContent = day;
  cell.appendChild(num);
  
  const user = state.users[state.currentUser];
  const dayData = user.days[dateKey];
  const dayShifts = dayData?.shifts || [];
  
  if (dayShifts.length === 1) {
    // Single shift - paint whole cell
    const shift = user.shifts.find(s => s.id === dayShifts[0].shiftId);
    if (shift) {
      cell.style.background = shift.color;
      const isDark = isColorDark(shift.color);
      cell.style.setProperty('--shift-color', isDark ? '#ffffff' : '#0a0a0a');
      num.style.color = isDark ? '#ffffff' : '#0a0a0a';
      
      const codeEl = document.createElement('div');
      codeEl.className = 'cal-day-shift';
      codeEl.textContent = shift.code;
      cell.appendChild(codeEl);
    }
  } else if (dayShifts.length > 1) {
    // Multiple shifts - split horizontally (top half + bottom half)
    const shifts = dayShifts.map(ds => user.shifts.find(s => s.id === ds.shiftId)).filter(Boolean);
    if (shifts.length >= 2) {
      const s1 = shifts[0], s2 = shifts[1];
      cell.style.background = `linear-gradient(to bottom, ${s1.color} 0%, ${s1.color} 50%, ${s2.color} 50%, ${s2.color} 100%)`;
      
      const codesWrap = document.createElement('div');
      codesWrap.style.cssText = 'width:100%;flex:1;display:flex;flex-direction:column;justify-content:space-around;align-items:center;margin-top:2px;';
      
      shifts.forEach((sh, idx) => {
        const codeEl = document.createElement('div');
        codeEl.style.cssText = `font-size:13px;font-weight:700;color:${isColorDark(sh.color)?'#fff':'#0a0a0a'};text-shadow:0 1px 2px rgba(0,0,0,0.4);line-height:1;`;
        codeEl.textContent = sh.code;
        codesWrap.appendChild(codeEl);
      });
      cell.appendChild(codesWrap);
      // Number color - use top half color (s1)
      num.style.color = isColorDark(s1.color) ? '#fff' : '#0a0a0a';
    }
  }
  
  // Note dot
  if (user.notes[dateKey]) {
    const noteDot = document.createElement('div');
    noteDot.className = 'cal-day-note';
    cell.appendChild(noteDot);
  }
  
  // Event dot
  const dayEvents = Object.values(state.events).filter(e => e.date === dateKey);
  if (dayEvents.length) {
    const evDot = document.createElement('div');
    evDot.className = 'cal-day-event';
    cell.appendChild(evDot);
  }
  
  cell.onclick = () => openDaySheet(date);
  return cell;
}

function changeMonth(delta) {
  state.viewMonth += delta;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  else if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  renderCalendar();
  // Auto-check end of past month
  checkMonthEndPrompt();
}

function goToToday() {
  const t = new Date();
  state.viewYear = t.getFullYear();
  state.viewMonth = t.getMonth();
  renderCalendar();
}

// ==========================================================================
// DAY SHEET
// ==========================================================================
function openDaySheet(date) {
  state.selectedDate = date;
  const dateKey = formatDate(date);
  const user = state.users[state.currentUser];
  const dayData = user.days[dateKey] || {};
  const dayShifts = dayData.shifts || [];
  const note = user.notes[dateKey] || '';
  const dayEvents = Object.values(state.events).filter(e => e.date === dateKey);
  
  document.getElementById('daySheetTitle').textContent = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('daySheetSubtitle').textContent = date.getFullYear();
  
  // Working state for shifts (mutable)
  window._editingShifts = JSON.parse(JSON.stringify(dayShifts));
  if (!window._editingShifts.length) window._editingShifts = [];
  
  const body = document.getElementById('daySheetBody');
  body.innerHTML = `
    <div class="section">
      <div class="section-title flex-between"><span>Turnos del día</span><span class="muted" style="font-size:10px;text-transform:none;letter-spacing:0;">Hasta 2 turnos</span></div>
      <div id="daySlots"></div>
    </div>
    <div class="section">
      <div class="section-title">Nota del día</div>
      <textarea class="input-field" id="dayNoteInput" placeholder="Escribe una nota...">${escapeHtml(note)}</textarea>
    </div>
    <div class="section">
      <div class="section-title">Eventos de este día</div>
      <div id="dayEventsList"></div>
      <button class="btn btn-secondary btn-sm btn-block mt-8" onclick="openEventEditor(null, '${dateKey}')">+ Añadir evento</button>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="closeDaySheet()">Cancelar</button>
      <button class="btn btn-danger btn-sm" onclick="clearDay()">Limpiar</button>
      <button class="btn" onclick="saveDay()">Guardar</button>
    </div>
  `;
  
  renderDaySlots();
  
  // Render events for this day
  const evList = document.getElementById('dayEventsList');
  if (dayEvents.length) {
    dayEvents.forEach(ev => {
      const evEl = document.createElement('div');
      evEl.className = 'event-item';
      evEl.innerHTML = `
        <div class="event-item-title">${escapeHtml(ev.title)}</div>
        ${ev.time ? `<div class="event-item-time">⏰ ${ev.time}</div>` : ''}
        ${ev.description ? `<div class="event-item-desc">${escapeHtml(ev.description)}</div>` : ''}
      `;
      evEl.onclick = () => { closeDaySheet(); setTimeout(() => openEventEditor(ev.id), 100); };
      evList.appendChild(evEl);
    });
  } else {
    evList.innerHTML = '<div class="muted" style="font-size:12px;">Sin eventos</div>';
  }
  
  document.getElementById('dayOverlay').classList.add('active');
  document.getElementById('daySheet').classList.add('active');
}

function renderDaySlots() {
  const user = state.users[state.currentUser];
  const slotsEl = document.getElementById('daySlots');
  if (!slotsEl) return;
  
  let html = '';
  // Slot 1
  html += renderDaySlot(0, user, 'Turno 1');
  // Slot 2 (only if slot 1 has a shift, or already has data)
  if (window._editingShifts.length >= 1 && window._editingShifts[0]?.shiftId) {
    if (window._editingShifts.length >= 2) {
      html += renderDaySlot(1, user, 'Turno 2');
    } else {
      html += `<button class="btn btn-secondary btn-sm btn-block mt-12" onclick="addSecondShift()">+ Añadir 2º turno (turno doble)</button>`;
    }
  }
  
  slotsEl.innerHTML = html;
  
  // Attach click handlers to all shift options
  document.querySelectorAll('[data-slot]').forEach(opt => {
    opt.onclick = () => {
      const slot = parseInt(opt.dataset.slot);
      const shiftId = opt.dataset.shiftId;
      selectDaySlotShift(slot, shiftId);
    };
  });
}

function renderDaySlot(idx, user, label) {
  const slot = window._editingShifts[idx] || {};
  const currentShift = slot.shiftId ? user.shifts.find(s => s.id === slot.shiftId) : null;
  const hoursValue = slot.hours !== undefined ? slot.hours : (currentShift ? currentShift.hours : 0);
  
  const grid = user.shifts.map(s => `
    <div class="shift-option ${slot.shiftId === s.id ? 'selected' : ''}" data-slot="${idx}" data-shift-id="${s.id}" style="--shift-color:${s.color};">
      ${s.hours ? `<div class="shift-hours-tag">${s.hours}h</div>` : ''}
      <div class="shift-code">${escapeHtml(s.code)}</div>
      <div class="shift-name">${escapeHtml(s.name)}</div>
    </div>
  `).join('');
  
  return `
    <div style="margin-top:${idx===0?'0':'14px'};">
      <div class="flex-between" style="margin-bottom:8px;">
        <div style="font-size:13px;font-weight:600;color:var(--text-dim);">${label}</div>
        ${idx === 1 ? `<button class="btn-ghost" style="background:transparent;border:none;color:var(--danger);font-size:12px;cursor:pointer;padding:0;" onclick="removeSecondShift()">✕ Quitar</button>` : ''}
      </div>
      <div class="shift-grid">${grid}</div>
      <div style="margin-top:8px;">
        <label class="input-label">Horas</label>
        <input type="number" class="input-field" data-hours-slot="${idx}" value="${hoursValue}" step="0.5" min="0" max="24" placeholder="Horas" onchange="updateSlotHours(${idx}, this.value)">
      </div>
    </div>
  `;
}

function selectDaySlotShift(slot, shiftId) {
  const user = state.users[state.currentUser];
  const shift = user.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  // Toggle off if same
  if (window._editingShifts[slot]?.shiftId === shiftId) {
    if (slot === 1) {
      window._editingShifts.splice(1, 1);
    } else {
      window._editingShifts[0] = null;
    }
  } else {
    window._editingShifts[slot] = { shiftId, hours: shift.hours };
  }
  // Clean up nulls
  window._editingShifts = window._editingShifts.filter(x => x && x.shiftId);
  renderDaySlots();
}

function updateSlotHours(slot, val) {
  const h = parseFloat(val) || 0;
  if (window._editingShifts[slot]) {
    window._editingShifts[slot].hours = h;
  }
}

function addSecondShift() {
  // Show empty 2nd slot
  window._editingShifts.push({ shiftId: null, hours: 0 });
  // Use a placeholder so it renders the grid
  window._editingShifts[1] = { shiftId: '__placeholder__', hours: 0 };
  // Render and then clean
  const slotsEl = document.getElementById('daySlots');
  // Force render with placeholder visible
  const user = state.users[state.currentUser];
  // Render slot 0
  let html = renderDaySlot(0, user, 'Turno 1');
  // For slot 1 we need a custom render since shiftId is fake
  const fakeSlot = window._editingShifts[1];
  window._editingShifts[1] = { shiftId: null, hours: 0 };
  html += renderDaySlot(1, user, 'Turno 2');
  slotsEl.innerHTML = html;
  document.querySelectorAll('[data-slot]').forEach(opt => {
    opt.onclick = () => {
      const s = parseInt(opt.dataset.slot);
      selectDaySlotShift(s, opt.dataset.shiftId);
    };
  });
}

function removeSecondShift() {
  window._editingShifts.splice(1, 1);
  renderDaySlots();
}

function closeDaySheet() {
  document.getElementById('dayOverlay').classList.remove('active');
  document.getElementById('daySheet').classList.remove('active');
  state.selectedDate = null;
}

function saveDay() {
  if (!state.selectedDate) return;
  const dateKey = formatDate(state.selectedDate);
  const user = state.users[state.currentUser];
  
  // Get hours from inputs (in case user edited but didn't blur)
  document.querySelectorAll('[data-hours-slot]').forEach(inp => {
    const slot = parseInt(inp.dataset.hoursSlot);
    if (window._editingShifts[slot]) {
      window._editingShifts[slot].hours = parseFloat(inp.value) || 0;
    }
  });
  
  const validShifts = window._editingShifts.filter(s => s && s.shiftId);
  const note = document.getElementById('dayNoteInput').value.trim();
  
  if (validShifts.length) {
    user.days[dateKey] = { shifts: validShifts };
  } else {
    delete user.days[dateKey];
  }
  
  if (note) user.notes[dateKey] = note;
  else delete user.notes[dateKey];
  
  saveUser(state.currentUser);
  renderCalendar();
  closeDaySheet();
  toast('Guardado', 'success');
}

function clearDay() {
  if (!state.selectedDate) return;
  if (!confirm('¿Borrar turno, nota y horas de este día?')) return;
  const dateKey = formatDate(state.selectedDate);
  const user = state.users[state.currentUser];
  delete user.days[dateKey];
  delete user.notes[dateKey];
  saveUser(state.currentUser);
  renderCalendar();
  closeDaySheet();
}

// ==========================================================================
// SHIFT EDITOR (Settings)
// ==========================================================================
function openShiftEditor() {
  const user = state.users[state.currentUser];
  openModal('Tipos de turno', `
    <div class="muted" style="margin-bottom:10px;">Edita, añade o elimina tipos de turno para <strong>${escapeHtml(user.name)}</strong>.</div>
    <div class="shift-edit-list" id="shiftEditList"></div>
    <button class="btn btn-secondary btn-block mt-12" onclick="addShift()">+ Añadir turno</button>
  `, [
    { text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }
  ]);
  renderShiftEditList();
}

function renderShiftEditList() {
  const user = state.users[state.currentUser];
  const list = document.getElementById('shiftEditList');
  list.innerHTML = '';
  user.shifts.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'shift-edit-item';
    row.innerHTML = `
      <button class="shift-color-swatch" style="background:${s.color}" onclick="pickShiftColor(${idx})"></button>
      <input type="text" class="code-input" value="${escapeHtml(s.code)}" maxlength="3" onchange="updateShiftField(${idx}, 'code', this.value)">
      <input type="text" class="name-input" value="${escapeHtml(s.name)}" onchange="updateShiftField(${idx}, 'name', this.value)">
      <input type="number" class="hours-input" value="${s.hours}" step="0.5" min="0" max="24" onchange="updateShiftField(${idx}, 'hours', parseFloat(this.value)||0)">
      <button class="del-btn" onclick="deleteShift(${idx})">✕</button>
    `;
    list.appendChild(row);
  });
}

function updateShiftField(idx, field, value) {
  state.users[state.currentUser].shifts[idx][field] = value;
  saveUser(state.currentUser);
  renderCalendar();
}

function deleteShift(idx) {
  const user = state.users[state.currentUser];
  if (user.shifts.length <= 1) { toast('Debe haber al menos un turno', 'error'); return; }
  if (!confirm(`¿Eliminar el turno "${user.shifts[idx].name}"?`)) return;
  user.shifts.splice(idx, 1);
  saveUser(state.currentUser);
  renderShiftEditList();
  renderCalendar();
}

function addShift() {
  const user = state.users[state.currentUser];
  const id = 'S' + Date.now();
  user.shifts.push({ id, code: 'X', name: 'Nuevo', color: COLOR_PALETTE[user.shifts.length % COLOR_PALETTE.length], hours: 8 });
  saveUser(state.currentUser);
  renderShiftEditList();
}

function pickShiftColor(idx) {
  const grid = COLOR_PALETTE.map(c => `<div class="color-cell" style="background:${c}" onclick="selectShiftColor(${idx}, '${c}')"></div>`).join('');
  openModal('Color del turno', `<div class="color-grid">${grid}</div><div class="mt-12"><label class="input-label">Personalizado</label><input type="color" class="input-field" id="customColor" value="${state.users[state.currentUser].shifts[idx].color}" onchange="selectShiftColor(${idx}, this.value)"></div>`, [{ text: 'Cerrar', class: 'btn-secondary', onClick: openShiftEditor }]);
}

function selectShiftColor(idx, color) {
  state.users[state.currentUser].shifts[idx].color = color;
  saveUser(state.currentUser);
  openShiftEditor();
}

// ==========================================================================
// LEGEND
// ==========================================================================
function openLegend() {
  const user = state.users[state.currentUser];
  const items = user.shifts.map(s => `
    <div class="stat-row">
      <div class="shift-tag">
        <div class="shift-dot" style="background:${s.color}"></div>
        <strong>${escapeHtml(s.code)}</strong> · ${escapeHtml(s.name)}
      </div>
      <div class="stat-values"><span class="v1">${s.hours}h</span></div>
    </div>
  `).join('');
  openModal('Leyenda de turnos', `<div class="muted" style="margin-bottom:8px;">${escapeHtml(user.name)}</div>${items}<button class="btn btn-secondary btn-block mt-12" onclick="closeModal();openShiftEditor()">Editar tipos</button>`, [{ text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }]);
}

// ==========================================================================
// PATTERN AUTO-FILL
// ==========================================================================
function openPatternModal() {
  const user = state.users[state.currentUser];
  const shiftOptions = user.shifts.map(s => `<option value="${s.id}">${escapeHtml(s.code)} - ${escapeHtml(s.name)}</option>`).join('');
  
  openModal('Patrón automático', `
    <p class="muted" style="margin-top:0;">Define la secuencia (ej: M, M, T, T, N, N, Saliente, Libre, Libre) y rellena un periodo automáticamente.</p>
    <label class="input-label">Secuencia (de izq. a der.)</label>
    <div id="patternSequence" style="display:flex;flex-wrap:wrap;gap:6px;padding:10px;background:var(--panel);border-radius:8px;min-height:50px;margin-bottom:8px;"></div>
    <div style="display:flex;gap:6px;">
      <select class="input-field" id="patternAddSelect" style="flex:1;">${shiftOptions}</select>
      <button class="btn btn-sm" onclick="addPatternStep()">+</button>
    </div>
    <label class="input-label mt-12">Empezar desde</label>
    <input type="date" class="input-field" id="patternStart" value="${formatDate(new Date())}">
    <label class="input-label mt-12">Hasta</label>
    <input type="date" class="input-field" id="patternEnd" value="${formatDate(addMonths(new Date(), 3))}">
    <div class="mt-12 flex-row">
      <input type="checkbox" id="patternOverwrite">
      <label for="patternOverwrite" class="muted">Sobrescribir días ya rellenos</label>
    </div>
  `, [
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Aplicar', onClick: applyPattern }
  ]);
  
  window._patternSeq = [];
  renderPatternSequence();
}

function addPatternStep() {
  const id = document.getElementById('patternAddSelect').value;
  window._patternSeq.push(id);
  renderPatternSequence();
}

function renderPatternSequence() {
  const user = state.users[state.currentUser];
  const el = document.getElementById('patternSequence');
  if (!el) return;
  el.innerHTML = window._patternSeq.length ? window._patternSeq.map((id, i) => {
    const s = user.shifts.find(x => x.id === id);
    if (!s) return '';
    return `<div style="background:${s.color};color:${isColorDark(s.color)?'#fff':'#000'};padding:4px 8px;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;" onclick="removePatternStep(${i})">${escapeHtml(s.code)} ✕</div>`;
  }).join('') : '<div class="muted" style="font-size:12px;">Vacío. Añade pasos arriba.</div>';
}

function removePatternStep(i) {
  window._patternSeq.splice(i, 1);
  renderPatternSequence();
}

function applyPattern() {
  if (!window._patternSeq.length) { toast('La secuencia está vacía', 'error'); return; }
  const start = new Date(document.getElementById('patternStart').value);
  const end = new Date(document.getElementById('patternEnd').value);
  if (isNaN(start) || isNaN(end) || end < start) { toast('Fechas inválidas', 'error'); return; }
  const overwrite = document.getElementById('patternOverwrite').checked;
  const user = state.users[state.currentUser];
  
  let idx = 0;
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    const key = formatDate(d);
    if (overwrite || !user.days[key]) {
      const shiftId = window._patternSeq[idx % window._patternSeq.length];
      const shift = user.shifts.find(x => x.id === shiftId);
      if (shift) {
        user.days[key] = { shifts: [{ shiftId, hours: shift.hours }] };
        count++;
      }
    }
    idx++;
    d.setDate(d.getDate() + 1);
  }
  saveUser(state.currentUser);
  renderCalendar();
  closeModal();
  toast(`Patrón aplicado: ${count} días`, 'success');
}

// ==========================================================================
// EVENTS
// ==========================================================================
function renderEvents() {
  // Render the events calendar
  document.getElementById('evCalMonth').textContent = `${MONTHS[state.evViewMonth]} ${state.evViewYear}`;
  
  const grid = document.getElementById('evCalGrid');
  grid.innerHTML = '';
  
  const firstDay = new Date(state.evViewYear, state.evViewMonth, 1);
  const lastDay = new Date(state.evViewYear, state.evViewMonth + 1, 0);
  let startWeekday = firstDay.getDay() - 1;
  if (startWeekday < 0) startWeekday = 6;
  
  const prevLast = new Date(state.evViewYear, state.evViewMonth, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    grid.appendChild(buildEventDayCell(state.evViewYear, state.evViewMonth - 1, prevLast - i, true));
  }
  
  for (let d = 1; d <= lastDay.getDate(); d++) {
    grid.appendChild(buildEventDayCell(state.evViewYear, state.evViewMonth, d, false));
  }
  
  const totalCells = grid.children.length;
  const cellsNeeded = Math.ceil(totalCells / 7) * 7;
  for (let i = 1; i <= cellsNeeded - totalCells; i++) {
    grid.appendChild(buildEventDayCell(state.evViewYear, state.evViewMonth + 1, i, true));
  }
  
  // Render upcoming events list (only future ones, next 10)
  const list = document.getElementById('eventsList');
  list.innerHTML = '';
  const now = new Date();
  const futureEvents = Object.values(state.events)
    .filter(e => new Date(e.date + 'T' + (e.time || '23:59')) >= now)
    .sort((a,b) => {
      const ad = a.date + (a.time || '00:00');
      const bd = b.date + (b.time || '00:00');
      return ad.localeCompare(bd);
    })
    .slice(0, 10);
  
  if (!futureEvents.length) {
    list.innerHTML = '<div class="empty" style="padding:24px 12px;"><div class="empty-icon">📅</div><div class="empty-desc">Sin eventos próximos</div></div>';
    return;
  }
  
  futureEvents.forEach(ev => list.appendChild(buildEventEl(ev)));
}

function buildEventDayCell(year, month, day, otherMonth) {
  const date = new Date(year, month, day);
  const dateKey = formatDate(date);
  const cell = document.createElement('div');
  cell.className = 'cal-day';
  if (otherMonth) cell.classList.add('other-month');
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) cell.classList.add('weekend');
  
  const today = new Date();
  if (date.toDateString() === today.toDateString()) cell.classList.add('today');
  
  const num = document.createElement('div');
  num.className = 'cal-day-num';
  num.textContent = day;
  cell.appendChild(num);
  
  // Get events for this day
  const dayEvents = Object.values(state.events).filter(e => e.date === dateKey);
  
  if (dayEvents.length) {
    // Show event title(s) inside the cell
    const evWrap = document.createElement('div');
    evWrap.style.cssText = 'width:100%;margin-top:3px;display:flex;flex-direction:column;gap:2px;align-items:stretch;overflow:hidden;';
    dayEvents.slice(0, 2).forEach(ev => {
      const evChip = document.createElement('div');
      evChip.style.cssText = 'background:var(--info);color:#fff;font-size:9px;font-weight:600;padding:2px 4px;border-radius:4px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;';
      evChip.textContent = ev.title;
      evWrap.appendChild(evChip);
    });
    if (dayEvents.length > 2) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:9px;color:var(--text-dim);text-align:center;font-weight:600;';
      more.textContent = `+${dayEvents.length - 2}`;
      evWrap.appendChild(more);
    }
    cell.appendChild(evWrap);
  }
  
  cell.onclick = () => openEventDaySheet(date);
  return cell;
}

function changeEventMonth(delta) {
  state.evViewMonth += delta;
  if (state.evViewMonth < 0) { state.evViewMonth = 11; state.evViewYear--; }
  else if (state.evViewMonth > 11) { state.evViewMonth = 0; state.evViewYear++; }
  renderEvents();
}

function goToEventToday() {
  const t = new Date();
  state.evViewYear = t.getFullYear();
  state.evViewMonth = t.getMonth();
  renderEvents();
}

function openEventDaySheet(date) {
  state.evSelectedDate = date;
  const dateKey = formatDate(date);
  const dayEvents = Object.values(state.events).filter(e => e.date === dateKey);
  
  document.getElementById('daySheetTitle').textContent = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('daySheetSubtitle').textContent = date.getFullYear();
  
  const body = document.getElementById('daySheetBody');
  let evListHtml = '';
  if (dayEvents.length) {
    evListHtml = dayEvents.map(ev => `
      <div class="event-item" onclick="closeDaySheet();setTimeout(()=>openEventEditor('${ev.id}'),100);">
        <div class="event-item-title">${escapeHtml(ev.title)}</div>
        ${ev.time ? `<div class="event-item-time">⏰ ${ev.time}</div>` : ''}
        ${ev.description ? `<div class="event-item-desc">${escapeHtml(ev.description)}</div>` : ''}
        ${ev.notifyMinutes != null ? `<div class="event-item-desc">🔔 Aviso ${formatNotifyTime(ev.notifyMinutes)}</div>` : ''}
      </div>
    `).join('');
  } else {
    evListHtml = '<div class="muted" style="font-size:13px;text-align:center;padding:8px 0;">Sin eventos en este día</div>';
  }
  
  body.innerHTML = `
    <div class="section">
      <div class="section-title">Eventos</div>
      ${evListHtml}
    </div>
    <button class="btn btn-block" onclick="closeDaySheet();setTimeout(()=>openEventEditor(null, '${dateKey}'),100);">+ Añadir evento</button>
    <button class="btn btn-secondary btn-block mt-12" onclick="closeDaySheet()">Cerrar</button>
  `;
  
  document.getElementById('dayOverlay').classList.add('active');
  document.getElementById('daySheet').classList.add('active');
}

function buildEventEl(ev, past) {
  const d = new Date(ev.date + 'T00:00:00');
  const dateStr = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
  const el = document.createElement('div');
  el.className = 'event-item';
  if (past) el.style.opacity = '0.55';
  el.innerHTML = `
    <div class="flex-between">
      <div style="flex:1;min-width:0;">
        <div class="event-item-title">${escapeHtml(ev.title)}</div>
        <div class="event-item-time">📅 ${dateStr}${ev.time ? ' · ⏰ ' + ev.time : ''}</div>
        ${ev.description ? `<div class="event-item-desc">${escapeHtml(ev.description)}</div>` : ''}
        ${ev.notifyMinutes != null ? `<div class="event-item-desc">🔔 Aviso ${formatNotifyTime(ev.notifyMinutes)}</div>` : ''}
      </div>
    </div>
  `;
  el.onclick = () => openEventEditor(ev.id);
  return el;
}

function openEventEditor(eventId, prefilledDate) {
  const ev = eventId ? state.events[eventId] : null;
  const today = formatDate(new Date());
  openModal(ev ? 'Editar evento' : 'Nuevo evento', `
    <label class="input-label">Título</label>
    <input type="text" class="input-field" id="evTitle" value="${ev ? escapeHtml(ev.title) : ''}" placeholder="Cumpleaños, cita médica...">
    <label class="input-label mt-12">Fecha</label>
    <input type="date" class="input-field" id="evDate" value="${ev ? ev.date : (prefilledDate || today)}">
    <label class="input-label mt-12">Hora (opcional)</label>
    <input type="time" class="input-field" id="evTime" value="${ev && ev.time ? ev.time : ''}">
    <label class="input-label mt-12">Descripción</label>
    <textarea class="input-field" id="evDesc" placeholder="Detalles, lugar...">${ev && ev.description ? escapeHtml(ev.description) : ''}</textarea>
    <label class="input-label mt-12">Notificación</label>
    <select class="input-field" id="evNotify">
      <option value="">Sin notificación</option>
      <option value="0">A la hora del evento</option>
      <option value="5">5 minutos antes</option>
      <option value="10">10 minutos antes</option>
      <option value="15">15 minutos antes</option>
      <option value="30">30 minutos antes</option>
      <option value="60">1 hora antes</option>
      <option value="120">2 horas antes</option>
      <option value="1440">1 día antes</option>
      <option value="2880">2 días antes</option>
      <option value="10080">1 semana antes</option>
    </select>
  `, [
    ...(ev ? [{ text: 'Eliminar', class: 'btn-danger', onClick: () => deleteEvent(eventId) }] : []),
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Guardar', onClick: () => saveEvent(eventId) }
  ]);
  if (ev && ev.notifyMinutes != null) document.getElementById('evNotify').value = String(ev.notifyMinutes);
}

function saveEvent(eventId) {
  const title = document.getElementById('evTitle').value.trim();
  const date = document.getElementById('evDate').value;
  const time = document.getElementById('evTime').value;
  const desc = document.getElementById('evDesc').value.trim();
  const notify = document.getElementById('evNotify').value;
  if (!title || !date) { toast('Título y fecha son obligatorios', 'error'); return; }
  
  const id = eventId || ('e' + Date.now() + Math.floor(Math.random()*1000));
  state.events[id] = {
    id, title, date, time: time || null, description: desc || null,
    notifyMinutes: notify === '' ? null : parseInt(notify)
  };
  saveEvents();
  closeModal();
  renderEvents();
  renderCalendar();
  scheduleNotifications();
  toast('Guardado', 'success');
}

function deleteEvent(eventId) {
  if (!confirm('¿Eliminar este evento?')) return;
  delete state.events[eventId];
  saveEvents();
  closeModal();
  renderEvents();
  renderCalendar();
  toast('Eliminado', 'success');
}

// ==========================================================================
// STATS
// ==========================================================================
function switchStatsMode(mode, btnEl) {
  state.statsMode = mode;
  document.querySelectorAll('.stats-toggle button').forEach(b => b.classList.remove('active'));
  btnEl.classList.add('active');
  renderStats();
}

function changeStatsPeriod(delta) {
  if (state.statsMode === 'month') {
    state.statsMonth += delta;
    if (state.statsMonth < 0) { state.statsMonth = 11; state.statsYear--; }
    else if (state.statsMonth > 11) { state.statsMonth = 0; state.statsYear++; }
  } else {
    state.statsYear += delta;
  }
  renderStats();
}

function renderStats() {
  const user = state.users[state.currentUser];
  const isMonth = state.statsMode === 'month';
  document.getElementById('statsPeriod').textContent = isMonth ? `${MONTHS[state.statsMonth]} ${state.statsYear}` : `${state.statsYear}`;
  
  const counts = {}; // by shiftId
  let totalDays = 0;
  let totalHours = 0;
  
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    let dayHasWork = false;
    for (const ds of shifts) {
      counts[ds.shiftId] = counts[ds.shiftId] || { days: 0, hours: 0 };
      counts[ds.shiftId].days++;
      counts[ds.shiftId].hours += ds.hours || 0;
      totalHours += ds.hours || 0;
      dayHasWork = true;
    }
    if (dayHasWork) totalDays++;
  }
  
  const content = document.getElementById('statsContent');
  
  // Summary card
  let html = `
    <div class="stat-card">
      <div class="stat-card-title">Resumen ${isMonth ? 'mensual' : 'anual'}</div>
      <div class="stat-summary">
        <div class="stat-item"><div class="num">${totalDays}</div><div class="lbl">Días con turno</div></div>
        <div class="stat-item"><div class="num">${totalHours.toFixed(1)}</div><div class="lbl">Horas totales</div></div>
      </div>
    </div>
  `;
  
  // Breakdown by shift type
  if (totalDays > 0) {
    html += `<div class="stat-card"><div class="stat-card-title">Por tipo de turno</div>`;
    user.shifts.forEach(s => {
      const c = counts[s.id];
      if (!c) return;
      html += `
        <div class="stat-row">
          <div class="shift-tag">
            <div class="shift-dot" style="background:${s.color}"></div>
            <strong>${escapeHtml(s.code)}</strong> · ${escapeHtml(s.name)}
          </div>
          <div class="stat-values"><div class="v1">${c.days} día${c.days===1?'':'s'}</div><div class="v2">${c.hours.toFixed(1)}h</div></div>
        </div>
      `;
    });
    html += `</div>`;
    
    // Charts
    html += `<div class="stat-card"><div class="stat-card-title">Distribución de días</div><div class="chart-container"><canvas id="chartPie"></canvas></div></div>`;
    html += `<div class="stat-card"><div class="stat-card-title">Horas por tipo</div><div class="chart-container"><canvas id="chartBar"></canvas></div></div>`;
    
    // Annual chart for monthly view
    if (!isMonth) {
      html += `<div class="stat-card"><div class="stat-card-title">Horas por mes</div><div class="chart-container"><canvas id="chartLine"></canvas></div></div>`;
    }
  } else {
    html += `<div class="empty"><div class="empty-icon">📊</div><div class="empty-title">Sin datos</div><div class="empty-desc">No hay turnos registrados en este periodo</div></div>`;
  }
  
  // Export
  html += `<div style="padding:16px;"><div class="btn-row">
    <button class="btn btn-secondary" onclick="exportStatsPDF()">📄 PDF</button>
    <button class="btn btn-secondary" onclick="exportStatsExcel()">📊 Excel</button>
  </div></div>`;
  
  content.innerHTML = html;
  
  // Destroy old charts
  Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch(e){} });
  chartInstances = {};
  
  if (totalDays > 0) {
    const shiftEntries = user.shifts.filter(s => counts[s.id]);
    const labels = shiftEntries.map(s => s.code);
    const daysData = shiftEntries.map(s => counts[s.id].days);
    const hoursData = shiftEntries.map(s => counts[s.id].hours);
    const colors = shiftEntries.map(s => s.color);
    
    setTimeout(() => {
      const pieEl = document.getElementById('chartPie');
      if (pieEl) {
        chartInstances.pie = new Chart(pieEl, {
          type: 'doughnut',
          data: { labels, datasets: [{ data: daysData, backgroundColor: colors, borderColor: 'transparent', borderWidth: 0 }] },
          options: { plugins: { legend: { labels: { color: getCss('--text-dim') } } }, responsive: true, maintainAspectRatio: false }
        });
      }
      const barEl = document.getElementById('chartBar');
      if (barEl) {
        chartInstances.bar = new Chart(barEl, {
          type: 'bar',
          data: { labels, datasets: [{ data: hoursData, backgroundColor: colors, borderRadius: 6 }] },
          options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: getCss('--text-dim') }, grid: { color: getCss('--border') } }, x: { ticks: { color: getCss('--text-dim') }, grid: { display: false } } }, responsive: true, maintainAspectRatio: false }
        });
      }
      const lineEl = document.getElementById('chartLine');
      if (lineEl) {
        const monthlyHours = new Array(12).fill(0);
        for (const [key, val] of Object.entries(user.days)) {
          const shifts = getDayShifts(val);
          if (!shifts.length) continue;
          const d = new Date(key + 'T00:00:00');
          if (d.getFullYear() === state.statsYear) {
            for (const ds of shifts) monthlyHours[d.getMonth()] += ds.hours || 0;
          }
        }
        chartInstances.line = new Chart(lineEl, {
          type: 'line',
          data: { labels: MONTHS.map(m => m.slice(0,3)), datasets: [{ data: monthlyHours, borderColor: getCss('--accent'), backgroundColor: getCss('--accent-glow'), fill: true, tension: 0.4, borderWidth: 2, pointRadius: 3 }] },
          options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: getCss('--text-dim') }, grid: { color: getCss('--border') } }, x: { ticks: { color: getCss('--text-dim') }, grid: { display: false } } }, responsive: true, maintainAspectRatio: false }
        });
      }
    }, 50);
  }
}

// ==========================================================================
// PAYROLLS
// ==========================================================================
function renderPayrolls() {
  const user = state.users[state.currentUser];
  const all = Object.values(user.payrolls || {});
  
  // Summary - current year
  const currentYear = new Date().getFullYear();
  const yearItems = all.filter(p => p.year === currentYear);
  const yearGross = yearItems.reduce((sum, p) => sum + (parseFloat(p.gross)||0), 0);
  const yearNet = yearItems.reduce((sum, p) => sum + (parseFloat(p.net)||0), 0);
  const yearWith = yearItems.reduce((sum, p) => sum + (parseFloat(p.withheld)||0), 0);
  
  document.getElementById('payrollSummary').innerHTML = `
    <div class="stat-card" style="margin:0 0 12px;">
      <div class="stat-card-title">Total año ${currentYear}</div>
      <div class="payroll-amounts">
        <div class="payroll-amount"><div class="v">${formatMoney(yearGross)}</div><div class="l">Bruto</div></div>
        <div class="payroll-amount"><div class="v">${formatMoney(yearNet)}</div><div class="l">Neto</div></div>
        <div class="payroll-amount"><div class="v">${formatMoney(yearWith)}</div><div class="l">Retenido</div></div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-dim);text-align:center;">
        IRPF estimado: ${yearGross > 0 ? ((yearWith/yearGross)*100).toFixed(1) + '%' : '—'}
      </div>
      <button class="btn btn-secondary btn-sm btn-block mt-12" onclick="openPayrollChart()">📈 Comparativa mensual</button>
    </div>
  `;
  
  const list = document.getElementById('payrollList');
  list.innerHTML = '';
  
  if (!all.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">💼</div><div class="empty-title">Sin nóminas</div><div class="empty-desc">Añade tus nóminas para llevar el control</div></div>';
    return;
  }
  
  // Group by year/month
  const sorted = all.sort((a,b) => (b.year - a.year) || (b.month - a.month));
  const byYear = {};
  sorted.forEach(p => {
    if (!byYear[p.year]) byYear[p.year] = {};
    if (!byYear[p.year][p.month]) byYear[p.year][p.month] = [];
    byYear[p.year][p.month].push(p);
  });
  
  for (const year of Object.keys(byYear).sort((a,b) => b-a)) {
    const yh = document.createElement('div');
    yh.innerHTML = `<div class="section-title" style="margin:16px 0 8px;">${year}</div>`;
    list.appendChild(yh);
    
    // Iterate months in descending order
    const months = Object.keys(byYear[year]).map(Number).sort((a,b) => b-a);
    for (const m of months) {
      const monthItems = byYear[year][m];
      // If multiple payrolls in this month, show a month total header
      if (monthItems.length > 1) {
        const mGross = monthItems.reduce((sum, p) => sum + (parseFloat(p.gross) || 0), 0);
        const mNet = monthItems.reduce((sum, p) => sum + (parseFloat(p.net) || 0), 0);
        const mWith = monthItems.reduce((sum, p) => sum + (parseFloat(p.withheld) || 0), 0);
        const monthHeader = document.createElement('div');
        monthHeader.className = 'payroll-item';
        monthHeader.style.cssText = 'background:var(--panel-2);border:1px solid var(--accent);';
        monthHeader.innerHTML = `
          <div class="payroll-header" style="margin-bottom:6px;">
            <div>
              <div class="payroll-month" style="color:var(--accent-2);">📊 Total ${MONTHS[m]}</div>
              <div class="muted" style="font-size:11px;margin-top:2px;">${monthItems.length} nóminas acumuladas</div>
            </div>
          </div>
          <div class="payroll-amounts">
            <div class="payroll-amount"><div class="v">${formatMoney(mGross)}</div><div class="l">Bruto</div></div>
            <div class="payroll-amount"><div class="v">${formatMoney(mNet)}</div><div class="l">Neto</div></div>
            <div class="payroll-amount"><div class="v">${formatMoney(mWith)}</div><div class="l">Retenido</div></div>
          </div>
        `;
        list.appendChild(monthHeader);
      }
      monthItems.forEach(p => list.appendChild(buildPayrollEl(p)));
    }
  }
}

function buildPayrollEl(p) {
  const el = document.createElement('div');
  el.className = 'payroll-item';
  const monthName = MONTHS[p.month] || '';
  el.innerHTML = `
    <div class="payroll-header">
      <div>
        <div class="payroll-month">${monthName}${p.label ? ' · ' + escapeHtml(p.label) : ''}</div>
      </div>
      <button class="icon-btn" onclick="openPayrollEditor('${p.id}')"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>
    </div>
    <div class="payroll-amounts">
      <div class="payroll-amount"><div class="v">${formatMoney(p.gross)}</div><div class="l">Bruto</div></div>
      <div class="payroll-amount"><div class="v">${formatMoney(p.net)}</div><div class="l">Neto</div></div>
      <div class="payroll-amount"><div class="v">${formatMoney(p.withheld)}</div><div class="l">Retenido</div></div>
    </div>
    ${p.driveLink ? `<div class="payroll-file">
      🔗 <a href="${escapeHtml(p.driveLink)}" target="_blank" rel="noopener">Ver PDF en Drive</a>
    </div>` : ''}
  `;
  return el;
}

function openPayrollEditor(payrollId) {
  const user = state.users[state.currentUser];
  const p = payrollId ? user.payrolls[payrollId] : null;
  const now = new Date();
  
  const monthOptions = MONTHS.map((m, i) => `<option value="${i}"${p && p.month === i ? ' selected' : (!p && i === now.getMonth() ? ' selected' : '')}>${m}</option>`).join('');
  
  openModal(p ? 'Editar nómina' : 'Nueva nómina', `
    <div class="input-row">
      <div style="flex:1;">
        <label class="input-label">Mes</label>
        <select class="input-field" id="payMonth">${monthOptions}</select>
      </div>
      <div style="flex:1;">
        <label class="input-label">Año</label>
        <input type="number" class="input-field" id="payYear" value="${p ? p.year : now.getFullYear()}" min="2000" max="2099">
      </div>
    </div>
    <label class="input-label mt-12">Etiqueta (opcional)</label>
    <input type="text" class="input-field" id="payLabel" value="${p && p.label ? escapeHtml(p.label) : ''}" placeholder="Nómina, paga extra, finiquito...">
    
    <div style="margin-top:14px;padding:12px;background:var(--panel);border-radius:10px;border:1px dashed var(--border);">
      <div class="section-title" style="margin:0 0 8px;">📄 Lectura automática del PDF</div>
      <p class="muted" style="font-size:12px;margin:0 0 8px;">Sube el PDF, la app leerá los importes automáticamente. El archivo no se guarda — solo se usa para extraer los datos.</p>
      <input type="file" class="input-field" id="payFile" accept="application/pdf">
      <button class="btn btn-secondary btn-sm btn-block mt-8" onclick="tryReadPdfAmounts()">📄 Leer importes</button>
    </div>
    
    <label class="input-label mt-12">Bruto / Devengos (€)</label>
    <input type="number" class="input-field" id="payGross" value="${p ? p.gross : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">Neto / Líquido (€)</label>
    <input type="number" class="input-field" id="payNet" value="${p ? p.net : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">Importe retenido IRPF (€)</label>
    <input type="number" class="input-field" id="payWith" value="${p ? p.withheld : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">🔗 Enlace de Google Drive (recomendado)</label>
    <input type="url" class="input-field" id="payDrive" value="${p && p.driveLink ? escapeHtml(p.driveLink) : ''}" placeholder="https://drive.google.com/...">
    <p class="muted" style="font-size:11px;margin-top:6px;">Sube el PDF a Drive y pega el enlace compartido aquí. Así tendrás siempre acceso al archivo original.</p>
  `, [
    ...(p ? [{ text: 'Eliminar', class: 'btn-danger', onClick: () => deletePayroll(payrollId) }] : []),
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Guardar', onClick: () => savePayroll(payrollId) }
  ]);
}

async function tryReadPdfAmounts() {
  const fileInput = document.getElementById('payFile');
  if (!fileInput.files.length) { toast('Selecciona un PDF primero', 'error'); return; }
  toast('Leyendo PDF...', 'info');
  try {
    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    
    // Collect text items with position info for better extraction
    let allItems = [];
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      tc.items.forEach(it => {
        if (it.str.trim()) {
          allItems.push({ text: it.str, x: it.transform[4], y: it.transform[5] });
        }
      });
      fullText += tc.items.map(it => it.str).join(' ') + ' ';
    }
    
    // Save text for diagnostic mode
    window._lastPdfText = fullText;
    
    const result = extractPayrollNumbers(fullText, allItems);
    
    if (result.gross != null) document.getElementById('payGross').value = result.gross.toFixed(2);
    if (result.net != null) document.getElementById('payNet').value = result.net.toFixed(2);
    if (result.withheld != null) document.getElementById('payWith').value = result.withheld.toFixed(2);
    
    if (result.detectedMonth != null) {
      document.getElementById('payMonth').value = result.detectedMonth;
    }
    if (result.detectedYear != null) {
      document.getElementById('payYear').value = result.detectedYear;
    }
    
    const found = [];
    if (result.gross != null) found.push('Bruto');
    if (result.net != null) found.push('Neto');
    if (result.withheld != null) found.push('Retenido');
    if (result.detectedMonth != null || result.detectedYear != null) found.push('Fecha');
    
    if (found.length === 4) {
      toast(`✓ Todo leído correctamente. Revisa antes de guardar.`, 'success');
    } else if (found.length) {
      toast(`Leídos: ${found.join(', ')}. Si falta algo, pulsa "Ver números detectados".`, 'success');
      showDiagnosticButton();
    } else {
      toast('No se han extraído importes. Pulsa "Ver números detectados".', 'error');
      showDiagnosticButton();
    }
  } catch (err) {
    console.error(err);
    toast('Error leyendo PDF: ' + err.message, 'error');
  }
}

function showDiagnosticButton() {
  // Add a "Ver números detectados" button below the read button
  const existing = document.getElementById('diagBtn');
  if (existing) return;
  const readBtn = document.querySelector('button[onclick="tryReadPdfAmounts()"]');
  if (!readBtn) return;
  const btn = document.createElement('button');
  btn.id = 'diagBtn';
  btn.className = 'btn btn-secondary btn-sm btn-block mt-8';
  btn.textContent = '🔍 Ver números detectados';
  btn.onclick = openDiagnostic;
  readBtn.parentNode.insertBefore(btn, readBtn.nextSibling);
}

function openDiagnostic() {
  const text = window._lastPdfText || '';
  if (!text) { toast('Primero lee un PDF', 'error'); return; }
  
  // Extract all numbers
  const nums = [];
  const numRe = /([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g;
  let m;
  while ((m = numRe.exec(text)) !== null) {
    const n = parseSpanishNumber(m[1]);
    if (n != null && n > 0 && n < 100000) {
      // Get surrounding context (40 chars before)
      const start = Math.max(0, m.index - 40);
      const context = text.substring(start, m.index).trim().replace(/\s+/g, ' ');
      nums.push({ value: n, formatted: m[1], context: context.slice(-35) });
    }
  }
  
  // Deduplicate but keep distinct contexts
  const unique = [];
  const seen = new Map();
  nums.forEach(n => {
    if (!seen.has(n.value)) { seen.set(n.value, true); unique.push(n); }
  });
  
  // Sort descending
  unique.sort((a,b) => b.value - a.value);
  
  let html = '<p class="muted" style="margin-top:0;font-size:13px;">Pulsa un número para asignarlo al campo correcto:</p>';
  html += '<div style="max-height:300px;overflow-y:auto;">';
  unique.forEach(n => {
    html += `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-weight:700;font-family:'JetBrains Mono',monospace;font-size:15px;">${n.formatted} €</div>
          <div class="muted" style="font-size:11px;">${escapeHtml(n.context)}</div>
        </div>
        <div style="display:flex;gap:4px;flex-direction:column;">
          <button class="btn btn-sm" style="padding:4px 8px;font-size:11px;" onclick="assignDiag(${n.value}, 'gross')">Bruto</button>
          <button class="btn btn-sm" style="padding:4px 8px;font-size:11px;background:var(--info);" onclick="assignDiag(${n.value}, 'net')">Neto</button>
          <button class="btn btn-sm" style="padding:4px 8px;font-size:11px;background:var(--warning);color:#000;" onclick="assignDiag(${n.value}, 'withheld')">Retenido</button>
        </div>
      </div>
    `;
  });
  html += '</div>';
  
  openModal('Números detectados en el PDF', html, [{ text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }]);
}

function assignDiag(value, field) {
  const fieldMap = { gross: 'payGross', net: 'payNet', withheld: 'payWith' };
  const el = document.getElementById(fieldMap[field]);
  if (el) {
    el.value = value.toFixed(2);
    toast(`Asignado ${value.toFixed(2)}€ a ${field === 'gross' ? 'Bruto' : field === 'net' ? 'Neto' : 'Retenido'}`, 'success');
  }
}

function parseSpanishNumber(s) {
  if (!s) return null;
  // Spanish format: 1.592,00 → 1592.00
  const cleaned = String(s).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return (!isNaN(n) && isFinite(n)) ? n : null;
}

function extractPayrollNumbers(text, items) {
  const result = { gross: null, net: null, withheld: null, detectedMonth: null, detectedYear: null };
  
  // === Period detection ===
  const periodMatch = text.match(/(\d{2})\/(\d{4})\s*-?\s*Normal/i);
  if (periodMatch) {
    result.detectedMonth = parseInt(periodMatch[1]) - 1;
    result.detectedYear = parseInt(periodMatch[2]);
  } else {
    const rangeMatch = text.match(/\d{2}\/(\d{2})\/(\d{4})\s*-\s*\d{2}\/\d{2}\/\d{4}/);
    if (rangeMatch) {
      result.detectedMonth = parseInt(rangeMatch[1]) - 1;
      result.detectedYear = parseInt(rangeMatch[2]);
    }
  }
  
  // === Strategy A: Read directly from "TOTALS / Totales" and "LIQUID / Líquido" ===
  // Most reliable for Generalitat Valenciana format
  // After these labels, the next 2 numbers are gross and total deductions
  // After LIQUID, the next number is the net amount
  
  // Find position of "TOTALS / Totales" or "Totals" or "Totales"
  const totalsIdx = text.search(/TOTALS?\s*\/?\s*Totales/i);
  if (totalsIdx >= 0) {
    // Get the next 400 chars and find all numbers
    const after = text.substring(totalsIdx, totalsIdx + 500);
    const nums = [];
    const numRe = /([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g;
    let m;
    while ((m = numRe.exec(after)) !== null) {
      const n = parseSpanishNumber(m[1]);
      if (n != null && n > 0) nums.push(n);
    }
    // First 2 should be gross and total deductions
    if (nums.length >= 2) {
      // The larger of first two = gross, smaller = total deductions
      const a = nums[0], b = nums[1];
      if (a > b) { result.gross = a; result.withheld = b; }
      else { result.gross = b; result.withheld = a; }
    }
  }
  
  // Find LIQUID / Líquido for net
  const liquidIdx = text.search(/(?:LIQUID|L[ÍI]QUIDO)\s*\/?\s*L[ií]quido/i);
  if (liquidIdx >= 0) {
    const after = text.substring(liquidIdx, liquidIdx + 500);
    const nums = [];
    const numRe = /([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g;
    let m;
    while ((m = numRe.exec(after)) !== null) {
      const n = parseSpanishNumber(m[1]);
      if (n != null && n > 0) nums.push(n);
    }
    // The net is one of these numbers - if we have gross+withheld, find the match
    if (result.gross != null && result.withheld != null) {
      const computedNet = Math.round((result.gross - result.withheld) * 100) / 100;
      const found = nums.find(n => Math.abs(n - computedNet) < 0.1);
      result.net = found != null ? found : computedNet;
    } else if (nums.length > 0) {
      // Without gross/withheld, just take the first reasonable number
      result.net = nums[0];
    }
  }
  
  // === Strategy B: Fallback - sum line items if Strategy A failed ===
  if (result.gross == null || result.withheld == null) {
    let sumDevengos = 0;
    let sumDeducciones = 0;
    // More permissive: match "<code> <CONCEPT> <amount>" anywhere
    const lineRe = /(\d{1,3})\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\.\s/]{3,60}?)\s+([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g;
    let m;
    const seen = new Set();
    while ((m = lineRe.exec(text)) !== null) {
      const code = parseInt(m[1]);
      const concept = m[2].trim().toLowerCase();
      const amount = parseSpanishNumber(m[3]);
      if (amount == null || amount > 100000 || amount <= 0) continue;
      // Avoid duplicates (code+amount)
      const key = `${code}_${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isDeduction = code >= 90 || /retenci|irpf|contingenci|formaci[oó]n|cuota.*seg|seguridad social|desempleo/.test(concept);
      if (isDeduction) sumDeducciones += amount;
      else sumDevengos += amount;
    }
    if (result.gross == null && sumDevengos > 0) result.gross = Math.round(sumDevengos * 100) / 100;
    if (result.withheld == null && sumDeducciones > 0) result.withheld = Math.round(sumDeducciones * 100) / 100;
    if (result.net == null && result.gross != null && result.withheld != null) {
      result.net = Math.round((result.gross - result.withheld) * 100) / 100;
    }
  }
  
  return result;
}

async function savePayroll(payrollId) {
  const month = parseInt(document.getElementById('payMonth').value);
  const year = parseInt(document.getElementById('payYear').value);
  const label = document.getElementById('payLabel').value.trim();
  const gross = parseFloat(document.getElementById('payGross').value) || 0;
  const net = parseFloat(document.getElementById('payNet').value) || 0;
  const withheld = parseFloat(document.getElementById('payWith').value) || 0;
  const driveLink = document.getElementById('payDrive').value.trim();
  
  if (gross === 0 && net === 0 && withheld === 0) {
    if (!confirm('Todos los importes están a 0. ¿Guardar igualmente?')) return;
  }
  
  const user = state.users[state.currentUser];
  const id = payrollId || ('p' + Date.now() + Math.floor(Math.random()*1000));
  
  // Note: file is NOT saved - only used for reading values
  user.payrolls[id] = { 
    id, month, year, 
    label: label || null, 
    gross, net, withheld, 
    driveLink: driveLink || null,
    updatedAt: Date.now()
  };
  saveUser(state.currentUser);
  closeModal();
  renderPayrolls();
  toast('Guardado', 'success');
}

function deletePayroll(payrollId) {
  if (!confirm('¿Eliminar esta nómina?')) return;
  const user = state.users[state.currentUser];
  delete user.payrolls[payrollId];
  saveUser(state.currentUser);
  closeModal();
  renderPayrolls();
  toast('Eliminada', 'success');
}

function openPayrollChart() {
  const user = state.users[state.currentUser];
  const currentYear = new Date().getFullYear();
  openModal(`Comparativa ${currentYear}`, `
    <div class="chart-container" style="height:280px;"><canvas id="payChart"></canvas></div>
    <div class="muted mt-12" style="font-size:12px;">Sumas mensuales (todas las nóminas por mes)</div>
  `, [{ text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }]);
  
  const grossByMonth = new Array(12).fill(0);
  const netByMonth = new Array(12).fill(0);
  Object.values(user.payrolls || {}).forEach(p => {
    if (p.year === currentYear) {
      grossByMonth[p.month] += parseFloat(p.gross) || 0;
      netByMonth[p.month] += parseFloat(p.net) || 0;
    }
  });
  
  setTimeout(() => {
    const el = document.getElementById('payChart');
    if (!el) return;
    new Chart(el, {
      type: 'bar',
      data: {
        labels: MONTHS.map(m => m.slice(0,3)),
        datasets: [
          { label: 'Bruto', data: grossByMonth, backgroundColor: getCss('--accent'), borderRadius: 4 },
          { label: 'Neto', data: netByMonth, backgroundColor: getCss('--accent-2'), borderRadius: 4 }
        ]
      },
      options: { plugins: { legend: { labels: { color: getCss('--text-dim') } } }, scales: { y: { ticks: { color: getCss('--text-dim') }, grid: { color: getCss('--border') } }, x: { ticks: { color: getCss('--text-dim') }, grid: { display: false } } }, responsive: true, maintainAspectRatio: false }
    });
  }, 50);
}

// ==========================================================================
// TENURE / ANTIGÜEDAD
// ==========================================================================
function renderTenure() {
  const user = state.users[state.currentUser];
  const t = user.tenure || { startDate: null, manualDaysBefore: 0, periods: [], monthlyChecks: {} };
  if (!t.periods) t.periods = [];
  const content = document.getElementById('tenureContent');
  
  if (!t.startDate && (!t.periods || !t.periods.length)) {
    content.innerHTML = `
      <div class="empty">
        <div class="empty-icon">⏳</div>
        <div class="empty-title">Sin configurar</div>
        <div class="empty-desc">Configura tu fecha de inicio o añade periodos previos</div>
      </div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-block" onclick="openTenureSetup()">📅 Configurar fecha de inicio</button>
        <button class="btn btn-secondary btn-block" onclick="editTenurePeriod(null)">+ Añadir periodo previo</button>
      </div>
    `;
    return;
  }
  
  const today = new Date();
  
  // Days from periods (manually defined)
  let periodsDays = 0;
  (t.periods || []).forEach(p => {
    if (p.mode === 'manual') {
      periodsDays += parseInt(p.manualDays) || 0;
    } else {
      // Count days between start and end inclusive
      if (p.startDate && p.endDate) {
        const s = new Date(p.startDate + 'T00:00:00');
        const e = new Date(p.endDate + 'T00:00:00');
        if (!isNaN(s) && !isNaN(e) && e >= s) {
          periodsDays += Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
        }
      }
    }
  });
  
  // Days from app (worked days with hours > 0)
  let workedDaysFromApp = 0;
  const startDate = t.startDate ? new Date(t.startDate + 'T00:00:00') : null;
  const endDate = t.endDate ? new Date(t.endDate + 'T00:00:00') : null;
  
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    // Check if any shift counts as worked (hours > 0)
    const hasWorkedShift = shifts.some(ds => {
      const sh = user.shifts.find(s => s.id === ds.shiftId);
      return sh && sh.hours > 0;
    });
    if (!hasWorkedShift) continue;
    const d = new Date(key + 'T00:00:00');
    if (startDate && d < startDate) continue;
    if (endDate && d > endDate) continue;
    if (d > today) continue;
    // Apply monthly check
    const monthKey = key.slice(0, 7);
    const check = t.monthlyChecks?.[monthKey];
    if (check && check.excludedDays && check.excludedDays.includes(key)) continue;
    workedDaysFromApp++;
  }
  
  const totalDays = periodsDays + (t.manualDaysBefore || 0) + workedDaysFromApp;
  const years = Math.floor(totalDays / 365.25);
  const remainingDays = totalDays - Math.floor(years * 365.25);
  const months = Math.floor(remainingDays / 30.44);
  const days = Math.floor(remainingDays - months * 30.44);
  
  const trienios = Math.floor(years / 3);
  const nextTrienio = (trienios + 1) * 3;
  const daysToNextTrienio = Math.ceil((nextTrienio * 365.25) - totalDays);
  const progressToNextTrienio = ((totalDays - trienios * 3 * 365.25) / (3 * 365.25)) * 100;
  
  // Build periods list
  let periodsHtml = '';
  if (t.periods && t.periods.length) {
    periodsHtml = '<div style="padding:0 16px;"><div class="section-title" style="margin:10px 0 8px;">Periodos previos</div>';
    t.periods.forEach((p, idx) => {
      const sLabel = p.startDate ? new Date(p.startDate + 'T00:00:00').toLocaleDateString('es-ES') : '?';
      const eLabel = p.endDate ? new Date(p.endDate + 'T00:00:00').toLocaleDateString('es-ES') : '?';
      let pDays = 0;
      if (p.mode === 'manual') {
        pDays = parseInt(p.manualDays) || 0;
      } else if (p.startDate && p.endDate) {
        const s = new Date(p.startDate + 'T00:00:00');
        const e = new Date(p.endDate + 'T00:00:00');
        if (!isNaN(s) && !isNaN(e) && e >= s) pDays = Math.floor((e-s)/(1000*60*60*24)) + 1;
      }
      periodsHtml += `
        <div class="event-item" style="margin-bottom:8px;" onclick="editTenurePeriod(${idx})">
          <div class="flex-between">
            <div>
              <div style="font-weight:600;font-size:13px;">${sLabel} → ${eLabel}</div>
              <div class="muted" style="font-size:11px;margin-top:2px;">${p.mode === 'manual' ? 'Parcial' : 'Completo'} · ${pDays} día${pDays===1?'':'s'}${p.note ? ' · ' + escapeHtml(p.note) : ''}</div>
            </div>
            <div style="color:var(--text-dim);font-size:18px;">›</div>
          </div>
        </div>
      `;
    });
    periodsHtml += '</div>';
  }
  
  content.innerHTML = `
    <div class="tenure-card">
      <div class="tenure-label">Antigüedad total</div>
      <div class="tenure-big">${years}<span style="font-size:18px;color:var(--text-dim);"> años</span></div>
      <div class="muted mt-8" style="font-size:13px;">${months} meses, ${days} días</div>
      <div class="muted" style="font-size:12px;margin-top:6px;">${totalDays.toLocaleString('es-ES')} días en total</div>
    </div>
    
    <div class="tenure-card">
      <div class="tenure-label">Trienios cumplidos</div>
      <div class="tenure-big">${trienios}</div>
      <div class="tenure-progress"><div class="tenure-progress-fill" style="width:${Math.max(0, Math.min(100, progressToNextTrienio))}%"></div></div>
      <div class="muted mt-8" style="font-size:12px;">Próximo trienio (${nextTrienio} años): ${daysToNextTrienio > 0 ? `en ${daysToNextTrienio} días` : '¡cumplido!'}</div>
    </div>
    
    <div class="settings-section" style="margin-top:0;">
      <div class="settings-row" onclick="openTenureSetup()">
        <div>
          <div class="settings-row-title">Configuración general</div>
          <div class="settings-row-desc">Contrato actual: inicio y fin</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="editTenurePeriod(null)">
        <div>
          <div class="settings-row-title">+ Añadir periodo previo</div>
          <div class="settings-row-desc">Trabajo anterior, otra empresa, etc.</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="openMonthlyCheck()">
        <div>
          <div class="settings-row-title">Validación mensual</div>
          <div class="settings-row-desc">Confirmar días de alta del mes pasado</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
    </div>
    
    ${periodsHtml}
    
    <div style="padding:8px 16px 16px;">
      <div class="muted" style="font-size:11px;text-align:center;line-height:1.6;">
        ${startDate ? `Contrato actual: ${startDate.toLocaleDateString('es-ES')}${endDate ? ' → ' + endDate.toLocaleDateString('es-ES') : ' (sin fin)'}<br>` : ''}
        ${periodsDays ? `${periodsDays} días de periodos previos<br>` : ''}
        ${t.manualDaysBefore ? `${t.manualDaysBefore} días manuales extra<br>` : ''}
        ${workedDaysFromApp} días trabajados en la app
      </div>
    </div>
  `;
}

function openTenureSetup() {
  const user = state.users[state.currentUser];
  const t = user.tenure || {};
  openModal('Configuración antigüedad', `
    <label class="input-label">Fecha de inicio del contrato actual</label>
    <input type="date" class="input-field" id="tenStart" value="${t.startDate || ''}">
    <p class="muted" style="font-size:12px;margin-top:6px;">Desde esta fecha contarán los turnos registrados en la app.</p>
    
    <label class="input-label mt-12">Fecha de fin (opcional, si es contrato temporal)</label>
    <input type="date" class="input-field" id="tenEnd" value="${t.endDate || ''}">
    <p class="muted" style="font-size:12px;margin-top:6px;">Solo contarán los turnos registrados hasta esta fecha. Déjalo vacío si tu contrato no tiene fin previsto.</p>
    
    <label class="input-label mt-12">Días manuales extra (opcional)</label>
    <input type="number" class="input-field" id="tenManual" value="${t.manualDaysBefore || 0}" min="0">
    <p class="muted" style="font-size:12px;margin-top:6px;">Días sueltos que no encajan en ningún periodo. Para periodos largos usa "Añadir periodo previo".</p>
  `, [
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Guardar', onClick: () => {
      const start = document.getElementById('tenStart').value;
      const end = document.getElementById('tenEnd').value;
      const manual = parseInt(document.getElementById('tenManual').value) || 0;
      if (start && end && new Date(end) < new Date(start)) {
        toast('La fecha fin debe ser posterior al inicio', 'error');
        return;
      }
      user.tenure.startDate = start || null;
      user.tenure.endDate = end || null;
      user.tenure.manualDaysBefore = manual;
      if (!user.tenure.periods) user.tenure.periods = [];
      saveUser(state.currentUser);
      closeModal();
      renderTenure();
      toast('Guardado', 'success');
    }}
  ]);
}

function editTenurePeriod(idx) {
  const user = state.users[state.currentUser];
  if (!user.tenure.periods) user.tenure.periods = [];
  const p = idx !== null && idx !== undefined ? user.tenure.periods[idx] : null;
  
  const html = `
    <label class="input-label">Fecha inicio</label>
    <input type="date" class="input-field" id="prdStart" value="${p ? (p.startDate || '') : ''}">
    
    <label class="input-label mt-12">Fecha fin</label>
    <input type="date" class="input-field" id="prdEnd" value="${p ? (p.endDate || '') : ''}">
    
    <label class="input-label mt-12">¿Trabajaste a tiempo completo?</label>
    <div style="display:flex;gap:8px;margin-top:6px;">
      <button type="button" id="modeFullBtn" class="btn ${(!p || p.mode !== 'manual') ? '' : 'btn-secondary'}" style="flex:1;font-size:13px;" onclick="setPeriodMode('full')">Todos los días</button>
      <button type="button" id="modeManualBtn" class="btn ${p && p.mode === 'manual' ? '' : 'btn-secondary'}" style="flex:1;font-size:13px;" onclick="setPeriodMode('manual')">Tiempo parcial</button>
    </div>
    
    <div id="manualDaysWrap" style="display:${p && p.mode === 'manual' ? 'block' : 'none'};">
      <label class="input-label mt-12">Días trabajados en este periodo</label>
      <input type="number" class="input-field" id="prdManualDays" value="${p && p.manualDays ? p.manualDays : ''}" min="0" placeholder="Ej: 180">
      <p class="muted" style="font-size:12px;margin-top:6px;">Suma manual de días efectivamente trabajados.</p>
    </div>
    
    <label class="input-label mt-12">Nota (opcional)</label>
    <input type="text" class="input-field" id="prdNote" value="${p && p.note ? escapeHtml(p.note) : ''}" placeholder="Empresa, descripción...">
    
    <div id="prdSummary" class="muted mt-12" style="font-size:12px;text-align:center;padding:8px;background:var(--panel);border-radius:8px;"></div>
  `;
  
  window._editingPeriod = { mode: p ? (p.mode || 'full') : 'full' };
  
  const buttons = [];
  if (p) buttons.push({ text: 'Eliminar', class: 'btn-danger', onClick: () => { 
    if (confirm('¿Eliminar este periodo?')) {
      user.tenure.periods.splice(idx, 1);
      saveUser(state.currentUser);
      closeModal();
      renderTenure();
      toast('Eliminado', 'success');
    }
  }});
  buttons.push({ text: 'Cancelar', class: 'btn-secondary', onClick: closeModal });
  buttons.push({ text: 'Guardar', onClick: () => savePeriod(idx) });
  
  openModal(p ? 'Editar periodo' : 'Nuevo periodo previo', html, buttons);
  
  // Update summary live
  setTimeout(() => {
    const updateSummary = () => {
      const s = document.getElementById('prdStart').value;
      const e = document.getElementById('prdEnd').value;
      const mode = window._editingPeriod.mode;
      const sEl = document.getElementById('prdSummary');
      if (!s || !e) { sEl.textContent = ''; return; }
      const sd = new Date(s + 'T00:00:00');
      const ed = new Date(e + 'T00:00:00');
      if (ed < sd) { sEl.textContent = 'La fecha fin debe ser posterior'; sEl.style.color = 'var(--danger)'; return; }
      sEl.style.color = '';
      const totalRange = Math.floor((ed - sd)/(1000*60*60*24)) + 1;
      if (mode === 'manual') {
        const m = parseInt(document.getElementById('prdManualDays').value) || 0;
        sEl.innerHTML = `Rango de ${totalRange} días naturales · <strong>${m} días</strong> contarán para antigüedad`;
      } else {
        sEl.innerHTML = `<strong>${totalRange} días</strong> contarán para antigüedad`;
      }
    };
    ['prdStart','prdEnd','prdManualDays'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateSummary);
        el.addEventListener('change', updateSummary);
      }
    });
    updateSummary();
  }, 50);
}

function setPeriodMode(mode) {
  window._editingPeriod.mode = mode;
  document.getElementById('modeFullBtn').className = 'btn ' + (mode === 'full' ? '' : 'btn-secondary');
  document.getElementById('modeManualBtn').className = 'btn ' + (mode === 'manual' ? '' : 'btn-secondary');
  document.getElementById('manualDaysWrap').style.display = mode === 'manual' ? 'block' : 'none';
  // Update summary
  const ev = new Event('input');
  document.getElementById('prdStart').dispatchEvent(ev);
}

function savePeriod(idx) {
  const user = state.users[state.currentUser];
  const s = document.getElementById('prdStart').value;
  const e = document.getElementById('prdEnd').value;
  const mode = window._editingPeriod.mode;
  const manualDays = parseInt(document.getElementById('prdManualDays').value) || 0;
  const note = document.getElementById('prdNote').value.trim();
  
  if (!s || !e) { toast('Indica ambas fechas', 'error'); return; }
  if (new Date(e) < new Date(s)) { toast('Fecha fin debe ser posterior', 'error'); return; }
  if (mode === 'manual' && manualDays <= 0) { toast('Indica días trabajados', 'error'); return; }
  
  const p = { startDate: s, endDate: e, mode, manualDays: mode === 'manual' ? manualDays : null, note: note || null };
  
  if (!user.tenure.periods) user.tenure.periods = [];
  if (idx !== null && idx !== undefined) {
    user.tenure.periods[idx] = p;
  } else {
    user.tenure.periods.push(p);
  }
  // Sort by start date
  user.tenure.periods.sort((a,b) => (a.startDate || '').localeCompare(b.startDate || ''));
  saveUser(state.currentUser);
  closeModal();
  renderTenure();
  toast('Guardado', 'success');
}

function openMonthlyCheck(targetMonth) {
  const user = state.users[state.currentUser];
  const now = new Date();
  let year, month;
  if (targetMonth) {
    [year, month] = targetMonth.split('-').map(Number);
    month -= 1;
  } else {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    year = d.getFullYear(); month = d.getMonth();
  }
  const monthKey = `${year}-${String(month+1).padStart(2,'0')}`;
  const check = user.tenure.monthlyChecks?.[monthKey] || { excludedDays: [], confirmed: false };
  
  // List worked days in that month
  const workedDays = [];
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    if (!key.startsWith(monthKey)) continue;
    // Use first worked shift (with hours > 0)
    let workedShift = null;
    let totalHours = 0;
    for (const ds of shifts) {
      const sh = user.shifts.find(s => s.id === ds.shiftId);
      if (sh && sh.hours > 0) {
        if (!workedShift) workedShift = sh;
        totalHours += ds.hours || 0;
      }
    }
    if (!workedShift) continue;
    workedDays.push({ key, shift: workedShift, hours: totalHours });
  }
  
  let html = `<div class="muted" style="margin-bottom:10px;">${MONTHS[month]} ${year}: marca los días en los que <strong>no</strong> estabas de alta.</div>`;
  if (!workedDays.length) {
    html += `<div class="empty" style="padding:20px 0;"><div class="empty-desc">Sin días trabajados</div></div>`;
  } else {
    html += `<div style="max-height:300px;overflow-y:auto;">`;
    workedDays.sort((a,b) => a.key.localeCompare(b.key)).forEach(d => {
      const date = new Date(d.key + 'T00:00:00');
      const checked = check.excludedDays.includes(d.key);
      html += `
        <label style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);cursor:pointer;">
          <input type="checkbox" data-day="${d.key}" ${checked ? 'checked' : ''} style="width:18px;height:18px;">
          <div style="flex:1;">
            <div style="font-weight:500;">${date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
            <div class="muted" style="font-size:12px;">${escapeHtml(d.shift.code)} · ${d.hours}h</div>
          </div>
          <div style="width:12px;height:12px;border-radius:50%;background:${d.shift.color};"></div>
        </label>
      `;
    });
    html += `</div>`;
  }
  
  openModal('Validar antigüedad', html, [
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Confirmar', onClick: () => {
      const excluded = Array.from(document.querySelectorAll('[data-day]:checked')).map(c => c.dataset.day);
      if (!user.tenure.monthlyChecks) user.tenure.monthlyChecks = {};
      user.tenure.monthlyChecks[monthKey] = { excludedDays: excluded, confirmed: true, confirmedAt: Date.now() };
      saveUser(state.currentUser);
      closeModal();
      renderTenure();
      toast(`${MONTHS[month]} validado`, 'success');
    }}
  ]);
}

function checkMonthEndPrompt() {
  // If today is the 1st-5th of month, prompt for previous month if not confirmed
  const today = new Date();
  if (today.getDate() > 7) return;
  const user = state.users[state.currentUser];
  if (!user.tenure.startDate) return;
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const monthKey = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  const check = user.tenure.monthlyChecks?.[monthKey];
  if (check && check.confirmed) return;
  // Don't pester - only show once per session per user
  const sessKey = `prompted-${state.currentUser}-${monthKey}`;
  if (sessionStorage.getItem(sessKey)) return;
  sessionStorage.setItem(sessKey, '1');
  
  setTimeout(() => {
    if (confirm(`Validar antigüedad de ${MONTHS[prev.getMonth()]} ${prev.getFullYear()}?\n\nMarca los días en los que no estuviste de alta.`)) {
      openMonthlyCheck(monthKey);
    }
  }, 1000);
}

// ==========================================================================
// VACATIONS
// ==========================================================================
function renderVacations() {
  const user = state.users[state.currentUser];
  const v = user.vacations || { totalPerYear: 22, ldPerYear: 0 };
  const currentYear = new Date().getFullYear();
  
  // Count used in current year
  let usedVac = 0, usedLD = 0;
  const vacShifts = user.shifts.filter(s => s.code === 'V' || s.name.toLowerCase().includes('vacac'));
  const ldShifts = user.shifts.filter(s => s.code === 'LD' || s.name.toLowerCase().includes('libre disp'));
  
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    if (new Date(key + 'T00:00:00').getFullYear() !== currentYear) continue;
    for (const ds of shifts) {
      if (vacShifts.some(s => s.id === ds.shiftId)) usedVac++;
      if (ldShifts.some(s => s.id === ds.shiftId)) usedLD++;
    }
  }
  
  const content = document.getElementById('vacationsContent');
  const remainingVac = Math.max(0, v.totalPerYear - usedVac);
  const remainingLD = Math.max(0, v.ldPerYear - usedLD);
  
  content.innerHTML = `
    <div class="tenure-card">
      <div class="tenure-label">Vacaciones ${currentYear}</div>
      <div class="tenure-big">${remainingVac}<span style="font-size:18px;color:var(--text-dim);"> / ${v.totalPerYear}</span></div>
      <div class="muted mt-8">${usedVac} usadas · ${remainingVac} disponibles</div>
      <div class="tenure-progress"><div class="tenure-progress-fill" style="width:${(usedVac/Math.max(1,v.totalPerYear))*100}%"></div></div>
    </div>
    
    <div class="tenure-card">
      <div class="tenure-label">Libres de disposición (LD) ${currentYear}</div>
      <div class="tenure-big">${remainingLD}<span style="font-size:18px;color:var(--text-dim);"> / ${v.ldPerYear}</span></div>
      <div class="muted mt-8">${usedLD} usados · ${remainingLD} disponibles</div>
      ${v.ldPerYear > 0 ? `<div class="tenure-progress"><div class="tenure-progress-fill" style="width:${(usedLD/Math.max(1,v.ldPerYear))*100}%"></div></div>` : ''}
    </div>
    
    <div class="settings-section">
      <div class="settings-row" onclick="openVacationsConfig()">
        <div>
          <div class="settings-row-title">Configurar días anuales</div>
          <div class="settings-row-desc">Vacaciones y libres por año</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
    </div>
  `;
}

function openVacationsConfig() {
  const user = state.users[state.currentUser];
  const v = user.vacations;
  openModal('Días anuales', `
    <label class="input-label">Días de vacaciones al año</label>
    <input type="number" class="input-field" id="vacTotal" value="${v.totalPerYear}" min="0" max="365">
    <label class="input-label mt-12">Días de libre disposición (LD) al año</label>
    <input type="number" class="input-field" id="vacLD" value="${v.ldPerYear}" min="0" max="365">
  `, [
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Guardar', onClick: () => {
      user.vacations.totalPerYear = parseInt(document.getElementById('vacTotal').value) || 0;
      user.vacations.ldPerYear = parseInt(document.getElementById('vacLD').value) || 0;
      saveUser(state.currentUser);
      closeModal();
      renderVacations();
      toast('Guardado', 'success');
    }}
  ]);
}

// ==========================================================================
// SETTINGS / MORE MENU
// ==========================================================================
function openMoreMenu() {
  openModal('Más opciones', `
    <div class="settings-section" style="margin:0;">
      <div class="settings-row" onclick="closeModal();switchPage('tenure', null, true)">
        <div>
          <div class="settings-row-title">⏳ Antigüedad</div>
          <div class="settings-row-desc">Tiempo en empresa, trienios</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="closeModal();switchPage('vacations', null, true)">
        <div>
          <div class="settings-row-title">🏖️ Vacaciones y libres</div>
          <div class="settings-row-desc">Control de días disponibles</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="closeModal();openShiftEditor()">
        <div>
          <div class="settings-row-title">🎨 Tipos de turno</div>
          <div class="settings-row-desc">Personalizar turnos</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="closeModal();openSettings()">
        <div>
          <div class="settings-row-title">⚙️ Ajustes</div>
          <div class="settings-row-desc">Tema, notificaciones, datos</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
    </div>
  `, [{ text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }]);
}

function openSettings() {
  const currentTheme = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
  const notifTime = localStorage.getItem(STORAGE_KEY_NOTIF_TIME) || '20:00';
  const notifEnabled = ('Notification' in window) && Notification.permission === 'granted';
  const pinEnabled = state.appConfig?.pinEnabled && state.appConfig?.pinHash;
  
  openModal('Ajustes', `
    <div class="settings-section" style="margin:0 0 12px;">
      <div class="settings-row" onclick="toggleTheme()">
        <div>
          <div class="settings-row-title">🌙 Tema</div>
          <div class="settings-row-desc">Modo oscuro / claro</div>
        </div>
        <div class="settings-row-value">${currentTheme === 'dark' ? 'Oscuro' : 'Claro'}</div>
      </div>
    </div>
    
    <div class="settings-section" style="margin:0 0 12px;">
      <div class="settings-row" onclick="${pinEnabled ? 'changePin()' : 'setupPin()'}">
        <div>
          <div class="settings-row-title">🔒 PIN de bloqueo</div>
          <div class="settings-row-desc">${pinEnabled ? 'Activado · pulsa para cambiar' : 'Pulsa para activar'}</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      ${pinEnabled ? `
      <div class="settings-row" onclick="disablePin()">
        <div><div class="settings-row-title">Desactivar PIN</div></div>
      </div>
      <div class="settings-row" onclick="lockNow()">
        <div><div class="settings-row-title">🔐 Bloquear ahora</div><div class="settings-row-desc">Pedir PIN inmediatamente</div></div>
      </div>` : ''}
    </div>
    
    <div class="settings-section" style="margin:0 0 12px;">
      <div class="settings-row">
        <div>
          <div class="settings-row-title">🔔 Notificaciones</div>
          <div class="settings-row-desc">${notifEnabled ? 'Activadas' : 'Pulsa para activar'}</div>
        </div>
        <div class="toggle ${notifEnabled ? 'on' : ''}" onclick="requestNotificationPermission()"></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">⏰ Hora aviso del turno</div>
          <div class="settings-row-desc">Recordatorio del día siguiente</div>
        </div>
        <input type="time" id="notifTimeInput" value="${notifTime}" style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px;color:var(--text);font-family:inherit;" onchange="setNotifTime(this.value)">
      </div>
    </div>
    
    <div class="settings-section" style="margin:0 0 12px;">
      <div class="settings-row" onclick="closeModal();openShiftEditor()">
        <div><div class="settings-row-title">🎨 Tipos de turno</div></div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="exportAllData()">
        <div><div class="settings-row-title">📤 Exportar todos los datos (JSON)</div></div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="importDataPrompt()">
        <div><div class="settings-row-title">📥 Importar datos</div></div>
        <div class="settings-row-value">›</div>
      </div>
    </div>
    
    <div class="settings-section" style="margin:0;">
      <div class="settings-row" onclick="changeFirebaseConfig()">
        <div>
          <div class="settings-row-title">☁️ Configuración Firebase</div>
          <div class="settings-row-desc">${firebaseConnected ? 'Conectado' : 'Sin conexión'}</div>
        </div>
        <div class="settings-row-value">›</div>
      </div>
      <div class="settings-row" onclick="resetAllData()">
        <div>
          <div class="settings-row-title" style="color:var(--danger);">🗑️ Borrar todos los datos</div>
        </div>
      </div>
    </div>
  `, [{ text: 'Cerrar', class: 'btn-secondary', onClick: closeModal }]);
}

function toggleTheme() {
  const cur = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem(STORAGE_KEY_THEME, next);
  closeModal();
  setTimeout(openSettings, 100);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0a0f0e' : '#f5f7f6';
}

function setNotifTime(time) {
  localStorage.setItem(STORAGE_KEY_NOTIF_TIME, time);
  scheduleNotifications();
  toast('Hora actualizada', 'success');
}

function changeFirebaseConfig() {
  if (confirm('¿Cambiar la configuración de Firebase?\n\nNota: se recargará la app.')) {
    localStorage.removeItem(STORAGE_KEY_CONFIG);
    location.reload();
  }
}

function resetAllData() {
  if (!confirm('¿Borrar TODOS los datos? Esta acción no se puede deshacer.')) return;
  if (!confirm('¿Estás seguro? Se eliminarán turnos, nóminas, eventos y configuración.')) return;
  localStorage.clear();
  if (firebaseConnected) {
    firebase.remove(firebase.ref(firebaseDb)).catch(()=>{});
  }
  location.reload();
}

function exportAllData() {
  const data = { users: state.users, events: state.events, appConfig: state.appConfig, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `turnos-backup-${formatDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Datos exportados', 'success');
}

function importDataPrompt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.users && !data.events) { toast('Formato no válido', 'error'); return; }
      if (!confirm('¿Sobrescribir los datos actuales con la copia de seguridad?')) return;
      mergeStateData(data);
      saveUser('user1');
      saveUser('user2');
      saveEvents();
      renderAll();
      closeModal();
      toast('Datos importados', 'success');
    } catch (err) {
      toast('Error: ' + err.message, 'error');
    }
  };
  input.click();
}

// ==========================================================================
// EXPORT
// ==========================================================================
function exportStatsPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const user = state.users[state.currentUser];
  const isMonth = state.statsMode === 'month';
  const period = isMonth ? `${MONTHS[state.statsMonth]} ${state.statsYear}` : `${state.statsYear}`;
  
  doc.setFontSize(20);
  doc.text(`Turnos · ${user.name}`, 14, 20);
  doc.setFontSize(14);
  doc.text(`Periodo: ${period}`, 14, 30);
  
  // Compute stats
  const counts = {};
  let totalDays = 0, totalHours = 0;
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    let dayHasWork = false;
    for (const ds of shifts) {
      counts[ds.shiftId] = counts[ds.shiftId] || { days: 0, hours: 0 };
      counts[ds.shiftId].days++;
      counts[ds.shiftId].hours += ds.hours || 0;
      totalHours += ds.hours || 0;
      dayHasWork = true;
    }
    if (dayHasWork) totalDays++;
  }
  
  doc.setFontSize(11);
  doc.text(`Total días con turno: ${totalDays}`, 14, 42);
  doc.text(`Total horas: ${totalHours.toFixed(1)}`, 14, 49);
  
  let y = 60;
  doc.setFontSize(12);
  doc.text('Desglose por turno:', 14, y); y += 8;
  doc.setFontSize(10);
  user.shifts.forEach(s => {
    const c = counts[s.id]; if (!c) return;
    doc.text(`${s.code} · ${s.name}: ${c.days} días · ${c.hours.toFixed(1)}h`, 14, y); y += 6;
  });
  
  doc.save(`turnos-${user.name}-${period}.pdf`);
  toast('PDF generado', 'success');
}

function exportStatsExcel() {
  const user = state.users[state.currentUser];
  const isMonth = state.statsMode === 'month';
  const period = isMonth ? `${MONTHS[state.statsMonth]}_${state.statsYear}` : `${state.statsYear}`;
  
  const rows = [['Fecha', 'Día semana', 'Turnos', 'Horas total', 'Nota']];
  const days = Object.entries(user.days).sort();
  for (const [key, val] of days) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    const shiftLabels = shifts.map(ds => {
      const sh = user.shifts.find(s => s.id === ds.shiftId);
      return sh ? `${sh.code} (${ds.hours}h)` : '';
    }).filter(Boolean).join(' + ');
    const totalH = shifts.reduce((sum, ds) => sum + (ds.hours || 0), 0);
    rows.push([
      key,
      d.toLocaleDateString('es-ES', { weekday: 'long' }),
      shiftLabels,
      totalH,
      user.notes[key] || ''
    ]);
  }
  
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Turnos');
  
  // Add summary sheet
  const sumRows = [['Turno', 'Nombre', 'Días', 'Horas']];
  const counts = {};
  for (const [key, val] of Object.entries(user.days)) {
    const shifts = getDayShifts(val);
    if (!shifts.length) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    for (const ds of shifts) {
      counts[ds.shiftId] = counts[ds.shiftId] || { days: 0, hours: 0 };
      counts[ds.shiftId].days++;
      counts[ds.shiftId].hours += ds.hours || 0;
    }
  }
  user.shifts.forEach(s => {
    const c = counts[s.id];
    if (c) sumRows.push([s.code, s.name, c.days, c.hours]);
  });
  
  const ws2 = XLSX.utils.aoa_to_sheet(sumRows);
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');
  
  // Payrolls sheet
  const payRows = [['Año', 'Mes', 'Etiqueta', 'Bruto', 'Neto', 'Retenido']];
  Object.values(user.payrolls || {}).sort((a,b) => (a.year-b.year)||(a.month-b.month)).forEach(p => {
    payRows.push([p.year, MONTHS[p.month], p.label || '', p.gross, p.net, p.withheld]);
  });
  if (payRows.length > 1) {
    const ws3 = XLSX.utils.aoa_to_sheet(payRows);
    XLSX.utils.book_append_sheet(wb, ws3, 'Nóminas');
  }
  
  XLSX.writeFile(wb, `turnos-${user.name}-${period}.xlsx`);
  toast('Excel generado', 'success');
}

// ==========================================================================
// NOTIFICATIONS
// ==========================================================================
function checkNotificationPermission() {
  if (!('Notification' in window)) return;
  // Don't auto-prompt; user can toggle from settings
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) { toast('Tu navegador no soporta notificaciones', 'error'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    toast('Notificaciones activadas', 'success');
    scheduleNotifications();
  } else {
    toast('Notificaciones rechazadas', 'error');
  }
  closeModal();
  setTimeout(openSettings, 100);
}

let notificationTimers = [];

function scheduleNotifications() {
  // Clear existing
  notificationTimers.forEach(t => clearTimeout(t));
  notificationTimers = [];
  
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  const now = Date.now();
  const notifTime = localStorage.getItem(STORAGE_KEY_NOTIF_TIME) || '20:00';
  const [h, m] = notifTime.split(':').map(Number);
  
  // Schedule shift notifications for next 14 days
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) continue;
    
    const tomorrowDate = new Date(d);
    tomorrowDate.setDate(d.getDate() + 1);
    const key = formatDate(tomorrowDate);
    
    const delay = d.getTime() - now;
    if (delay > 0 && delay < 2147483647) {
      const t = setTimeout(() => {
        const user = state.users[state.currentUser];
        const dayData = user.days[key];
        if (dayData?.shiftId) {
          const shift = user.shifts.find(s => s.id === dayData.shiftId);
          if (shift) {
            new Notification('Turno mañana', { body: `${shift.code} - ${shift.name} (${dayData.hours}h)`, tag: `shift-${key}` });
          }
        }
      }, delay);
      notificationTimers.push(t);
    }
  }
  
  // Schedule event notifications
  Object.values(state.events).forEach(ev => {
    if (ev.notifyMinutes == null) return;
    const evTime = ev.time || '09:00';
    const evDate = new Date(ev.date + 'T' + evTime);
    const notifyAt = evDate.getTime() - ev.notifyMinutes * 60 * 1000;
    const delay = notifyAt - now;
    if (delay > 0 && delay < 2147483647) {
      const t = setTimeout(() => {
        new Notification(ev.title, { body: `${ev.date}${ev.time ? ' a las ' + ev.time : ''}${ev.description ? '\n' + ev.description : ''}`, tag: `event-${ev.id}` });
      }, delay);
      notificationTimers.push(t);
    }
  });
}

// ==========================================================================
// PAGE SWITCHING
// ==========================================================================
let currentPage = 'calendar';

function switchPage(page, btnEl, fromMore) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');
  
  if (btnEl) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    btnEl.classList.add('active');
  } else if (fromMore) {
    // came from more menu - keep "more" highlighted or unhighlight all
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  }
  
  // Render
  if (page === 'calendar') renderCalendar();
  else if (page === 'events') renderEvents();
  else if (page === 'stats') renderStats();
  else if (page === 'payroll') renderPayrolls();
  else if (page === 'tenure') renderTenure();
  else if (page === 'vacations') renderVacations();
  
  document.getElementById('main').scrollTop = 0;
}

function renderAll() {
  renderUserTabs();
  if (currentPage === 'calendar') renderCalendar();
  else if (currentPage === 'events') renderEvents();
  else if (currentPage === 'stats') renderStats();
  else if (currentPage === 'payroll') renderPayrolls();
  else if (currentPage === 'tenure') renderTenure();
  else if (currentPage === 'vacations') renderVacations();
}

// ==========================================================================
// MODAL
// ==========================================================================
function openModal(title, bodyHtml, buttons) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  const footer = document.getElementById('modalFooter');
  footer.innerHTML = '';
  (buttons || []).forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.class || '');
    btn.textContent = b.text;
    btn.onclick = b.onClick;
    footer.appendChild(btn);
  });
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ==========================================================================
// TOAST
// ==========================================================================
let toastTimer;
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ==========================================================================
// HELPERS
// ==========================================================================
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function isColorDark(hex) {
  if (!hex) return false;
  const c = hex.replace('#','');
  const r = parseInt(c.substring(0,2), 16);
  const g = parseInt(c.substring(2,4), 16);
  const b = parseInt(c.substring(4,6), 16);
  const yiq = (r*299 + g*587 + b*114) / 1000;
  return yiq < 140;
}

function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function formatMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function formatNotifyTime(min) {
  if (min === 0) return 'a la hora del evento';
  if (min < 60) return `${min} min antes`;
  if (min < 1440) return `${min/60} h antes`;
  if (min === 1440) return '1 día antes';
  if (min < 10080) return `${min/1440} días antes`;
  return `${Math.round(min/10080)} semana${min/10080>1?'s':''} antes`;
}

// ==========================================================================
// SERVICE WORKER REGISTRATION (PWA)
// ==========================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW reg failed:', err));
  });
}
