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

// ==========================================================================
// State
// ==========================================================================
let state = {
  users: {
    user1: { name: 'Persona 1', shifts: [...DEFAULT_SHIFTS], days: {}, notes: {}, payrolls: {}, tenure: { startDate: null, manualDaysBefore: 0, monthlyChecks: {} }, vacations: { totalPerYear: 22, ldPerYear: 0 } },
    user2: { name: 'Persona 2', shifts: [...DEFAULT_SHIFTS], days: {}, notes: {}, payrolls: {}, tenure: { startDate: null, manualDaysBefore: 0, monthlyChecks: {} }, vacations: { totalPerYear: 22, ldPerYear: 0 } },
  },
  events: {}, // shared events: events[id] = { id, date, time, title, description, notifyMinutes }
  currentUser: 'user1',
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
  selectedDate: null,
  statsMode: 'month',
  statsYear: new Date().getFullYear(),
  statsMonth: new Date().getMonth(),
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
    setupFirebaseSync();
    showApp();
    updateSyncDot(true);
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
  document.getElementById('header').style.display = 'flex';
  document.getElementById('userTabs').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('navBottom').style.display = 'flex';
  
  const lastUser = localStorage.getItem(STORAGE_KEY_LAST_USER);
  if (lastUser && state.users[lastUser]) state.currentUser = lastUser;
  
  renderUserTabs();
  renderCalendar();
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
        if (!state.users[uid].tenure) state.users[uid].tenure = { startDate: null, manualDaysBefore: 0, monthlyChecks: {} };
        if (!state.users[uid].vacations) state.users[uid].vacations = { totalPerYear: 22, ldPerYear: 0 };
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
}

function saveUser(uid) {
  // Always cache locally
  localStorage.setItem(STORAGE_KEY_LOCAL, JSON.stringify({ users: state.users, events: state.events }));
  if (!firebaseConnected) return;
  suppressFirebaseWrite = true;
  firebase.set(firebase.ref(firebaseDb, `users/${uid}`), state.users[uid])
    .then(() => { setTimeout(() => suppressFirebaseWrite = false, 200); })
    .catch(err => { console.error(err); toast('Error guardando: ' + err.message, 'error'); suppressFirebaseWrite = false; });
}

function saveEvents() {
  localStorage.setItem(STORAGE_KEY_LOCAL, JSON.stringify({ users: state.users, events: state.events }));
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
    }
  }
  if (data.events) state.events = data.events;
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
  if (dayData && dayData.shiftId) {
    const shift = user.shifts.find(s => s.id === dayData.shiftId);
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
  const note = user.notes[dateKey] || '';
  const dayEvents = Object.values(state.events).filter(e => e.date === dateKey);
  const currentShift = dayData.shiftId ? user.shifts.find(s => s.id === dayData.shiftId) : null;
  const hoursValue = dayData.hours !== undefined ? dayData.hours : (currentShift ? currentShift.hours : 0);
  
  document.getElementById('daySheetTitle').textContent = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('daySheetSubtitle').textContent = date.getFullYear();
  
  const body = document.getElementById('daySheetBody');
  body.innerHTML = `
    <div class="section">
      <div class="section-title">Turno</div>
      <div class="shift-grid" id="shiftGrid"></div>
    </div>
    <div class="section">
      <div class="section-title">Horas trabajadas</div>
      <input type="number" class="input-field" id="dayHoursInput" value="${hoursValue}" step="0.5" min="0" max="24" placeholder="Horas">
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
  
  // Render shift options
  const shiftGrid = document.getElementById('shiftGrid');
  user.shifts.forEach(s => {
    const opt = document.createElement('div');
    opt.className = 'shift-option';
    opt.style.setProperty('--shift-color', s.color);
    if (dayData.shiftId === s.id) opt.classList.add('selected');
    opt.innerHTML = `
      ${s.hours ? `<div class="shift-hours-tag">${s.hours}h</div>` : ''}
      <div class="shift-code">${escapeHtml(s.code)}</div>
      <div class="shift-name">${escapeHtml(s.name)}</div>
    `;
    opt.onclick = () => {
      shiftGrid.querySelectorAll('.shift-option').forEach(x => x.classList.remove('selected'));
      opt.classList.add('selected');
      opt.dataset.selected = s.id;
      // update hours field too
      document.getElementById('dayHoursInput').value = s.hours;
      shiftGrid.dataset.selectedShift = s.id;
    };
    if (dayData.shiftId === s.id) shiftGrid.dataset.selectedShift = s.id;
    shiftGrid.appendChild(opt);
  });
  
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

function closeDaySheet() {
  document.getElementById('dayOverlay').classList.remove('active');
  document.getElementById('daySheet').classList.remove('active');
  state.selectedDate = null;
}

function saveDay() {
  if (!state.selectedDate) return;
  const dateKey = formatDate(state.selectedDate);
  const user = state.users[state.currentUser];
  const shiftId = document.getElementById('shiftGrid').dataset.selectedShift;
  const hours = parseFloat(document.getElementById('dayHoursInput').value) || 0;
  const note = document.getElementById('dayNoteInput').value.trim();
  
  if (shiftId) {
    user.days[dateKey] = { shiftId, hours };
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
        user.days[key] = { shiftId, hours: shift.hours };
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
  const list = document.getElementById('eventsList');
  list.innerHTML = '';
  const events = Object.values(state.events).sort((a,b) => {
    const ad = a.date + (a.time || '00:00');
    const bd = b.date + (b.time || '00:00');
    return ad.localeCompare(bd);
  });
  
  if (!events.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📅</div><div class="empty-title">Sin eventos</div><div class="empty-desc">Pulsa "+ Nuevo evento" para añadir uno</div></div>';
    return;
  }
  
  const now = new Date();
  const futureEvents = events.filter(e => new Date(e.date + 'T' + (e.time || '23:59')) >= now);
  const pastEvents = events.filter(e => new Date(e.date + 'T' + (e.time || '23:59')) < now).reverse();
  
  if (futureEvents.length) {
    const h = document.createElement('div');
    h.innerHTML = '<div class="section-title" style="margin-bottom:8px;">Próximos</div>';
    list.appendChild(h);
    futureEvents.forEach(ev => list.appendChild(buildEventEl(ev)));
  }
  if (pastEvents.length) {
    const h = document.createElement('div');
    h.innerHTML = '<div class="section-title" style="margin-top:16px;margin-bottom:8px;">Pasados</div>';
    list.appendChild(h);
    pastEvents.slice(0, 10).forEach(ev => list.appendChild(buildEventEl(ev, true)));
  }
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
    if (!val.shiftId) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    counts[val.shiftId] = counts[val.shiftId] || { days: 0, hours: 0 };
    counts[val.shiftId].days++;
    counts[val.shiftId].hours += val.hours || 0;
    totalDays++;
    totalHours += val.hours || 0;
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
          const d = new Date(key + 'T00:00:00');
          if (d.getFullYear() === state.statsYear) monthlyHours[d.getMonth()] += val.hours || 0;
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
    if (!byYear[p.year]) byYear[p.year] = [];
    byYear[p.year].push(p);
  });
  
  for (const year of Object.keys(byYear).sort((a,b) => b-a)) {
    const yh = document.createElement('div');
    yh.innerHTML = `<div class="section-title" style="margin:16px 0 8px;">${year}</div>`;
    list.appendChild(yh);
    byYear[year].forEach(p => list.appendChild(buildPayrollEl(p)));
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
    ${p.fileUrl || p.driveLink ? `<div class="payroll-file">
      📎 ${p.fileUrl ? `<a href="${p.fileUrl}" target="_blank">${escapeHtml(p.fileName || 'Ver archivo')}</a>` : `<a href="${escapeHtml(p.driveLink)}" target="_blank">Ver en Drive</a>`}
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
    
    <label class="input-label mt-12">Bruto (€)</label>
    <input type="number" class="input-field" id="payGross" value="${p ? p.gross : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">Neto (€)</label>
    <input type="number" class="input-field" id="payNet" value="${p ? p.net : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">Importe retenido (€)</label>
    <input type="number" class="input-field" id="payWith" value="${p ? p.withheld : ''}" step="0.01" placeholder="0.00">
    
    <label class="input-label mt-12">📎 Archivo PDF (opcional)</label>
    <input type="file" class="input-field" id="payFile" accept="application/pdf">
    ${p && p.fileUrl ? `<div class="muted mt-8" style="font-size:11px;">Archivo actual: ${escapeHtml(p.fileName || 'archivo.pdf')}</div>` : ''}
    <button class="btn btn-secondary btn-sm btn-block mt-8" onclick="tryReadPdfAmounts()">📄 Leer importes del PDF</button>
    
    <label class="input-label mt-12">o enlace de Google Drive</label>
    <input type="url" class="input-field" id="payDrive" value="${p && p.driveLink ? escapeHtml(p.driveLink) : ''}" placeholder="https://drive.google.com/...">
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
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      fullText += tc.items.map(it => it.str).join(' ') + ' ';
    }
    
    // Heuristic search
    const lower = fullText.toLowerCase();
    const result = extractPayrollNumbers(fullText, lower);
    
    if (result.gross) document.getElementById('payGross').value = result.gross.toFixed(2);
    if (result.net) document.getElementById('payNet').value = result.net.toFixed(2);
    if (result.withheld) document.getElementById('payWith').value = result.withheld.toFixed(2);
    
    if (result.gross || result.net || result.withheld) {
      toast(`Leídos: ${[result.gross && 'Bruto', result.net && 'Neto', result.withheld && 'Retenido'].filter(Boolean).join(', ')}. Revisa antes de guardar.`, 'success');
    } else {
      toast('No se han podido extraer importes. Introdúcelos a mano.', 'error');
    }
  } catch (err) {
    console.error(err);
    toast('Error leyendo PDF: ' + err.message, 'error');
  }
}

function extractPayrollNumbers(text, lowerText) {
  // Try to find common Spanish payroll labels
  const findNumber = (patterns) => {
    for (const pat of patterns) {
      const regex = new RegExp(pat + '[^0-9]{0,40}([0-9]{1,3}(?:[\\.,][0-9]{3})*[\\.,][0-9]{2})', 'i');
      const m = text.match(regex);
      if (m) {
        const num = parseFloat(m[1].replace(/\./g,'').replace(',','.'));
        if (!isNaN(num) && num > 0 && num < 1000000) return num;
      }
    }
    return null;
  };
  
  return {
    gross: findNumber(['total devengado', 'total devengos', 'devengos totales', 'salario bruto', 'a\\s*deveng', 'íntegro', 'integro', 'bruto']),
    net: findNumber(['líquido a percibir', 'liquido a percibir', 'l[ií]quido total', 'total a percibir', 'neto a percibir', 'l[ií]quido']),
    withheld: findNumber(['i\\.?\\s*r\\.?\\s*p\\.?\\s*f', 'irpf', 'retenci[oó]n', 'total a deducir', 'total deducciones'])
  };
}

async function savePayroll(payrollId) {
  const month = parseInt(document.getElementById('payMonth').value);
  const year = parseInt(document.getElementById('payYear').value);
  const label = document.getElementById('payLabel').value.trim();
  const gross = parseFloat(document.getElementById('payGross').value) || 0;
  const net = parseFloat(document.getElementById('payNet').value) || 0;
  const withheld = parseFloat(document.getElementById('payWith').value) || 0;
  const driveLink = document.getElementById('payDrive').value.trim();
  const fileInput = document.getElementById('payFile');
  
  const user = state.users[state.currentUser];
  const id = payrollId || ('p' + Date.now() + Math.floor(Math.random()*1000));
  const existing = user.payrolls[id] || {};
  
  let fileUrl = existing.fileUrl;
  let fileName = existing.fileName;
  
  if (fileInput.files.length) {
    if (!firebaseStorage) { toast('Storage no disponible. Usa enlace de Drive.', 'error'); return; }
    try {
      toast('Subiendo archivo...', 'info');
      const file = fileInput.files[0];
      const path = `payrolls/${state.currentUser}/${id}_${file.name}`;
      const ref = firebase.sRef(firebaseStorage, path);
      await firebase.uploadBytes(ref, file);
      fileUrl = await firebase.getDownloadURL(ref);
      fileName = file.name;
    } catch (err) {
      console.error(err);
      toast('Error subiendo archivo: ' + err.message, 'error');
      return;
    }
  }
  
  user.payrolls[id] = { id, month, year, label: label || null, gross, net, withheld, fileUrl: fileUrl || null, fileName: fileName || null, driveLink: driveLink || null };
  saveUser(state.currentUser);
  closeModal();
  renderPayrolls();
  toast('Guardado', 'success');
}

function deletePayroll(payrollId) {
  if (!confirm('¿Eliminar esta nómina?')) return;
  const user = state.users[state.currentUser];
  const p = user.payrolls[payrollId];
  if (p && p.fileUrl && firebaseStorage) {
    // Try to delete file too
    try {
      const path = `payrolls/${state.currentUser}/${payrollId}_${p.fileName}`;
      firebase.deleteObject(firebase.sRef(firebaseStorage, path)).catch(()=>{});
    } catch(e) {}
  }
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
  const t = user.tenure || { startDate: null, manualDaysBefore: 0, monthlyChecks: {} };
  const content = document.getElementById('tenureContent');
  
  if (!t.startDate) {
    content.innerHTML = `
      <div class="empty">
        <div class="empty-icon">⏳</div>
        <div class="empty-title">Sin fecha de inicio</div>
        <div class="empty-desc">Configura tu fecha de entrada en la empresa</div>
      </div>
      <div style="padding:0 16px;"><button class="btn btn-block" onclick="openTenureSetup()">Configurar antigüedad</button></div>
    `;
    return;
  }
  
  const startDate = new Date(t.startDate + 'T00:00:00');
  const today = new Date();
  
  // Days from app (counts shifts that aren't libre/vac/fest etc - by default any day with a shift counts)
  let workedDaysFromApp = 0;
  for (const [key, val] of Object.entries(user.days)) {
    if (!val.shiftId) continue;
    const shift = user.shifts.find(s => s.id === val.shiftId);
    if (!shift) continue;
    const isWorkDay = shift.hours > 0; // shifts with hours count as worked
    if (!isWorkDay) continue;
    const d = new Date(key + 'T00:00:00');
    if (d < startDate || d > today) continue;
    // Apply monthly check: if a check exists for that month and the day is excluded, skip
    const monthKey = key.slice(0, 7); // YYYY-MM
    const check = t.monthlyChecks[monthKey];
    if (check && check.excludedDays && check.excludedDays.includes(key)) continue;
    workedDaysFromApp++;
  }
  
  const totalDays = (t.manualDaysBefore || 0) + workedDaysFromApp;
  const years = Math.floor(totalDays / 365.25);
  const remainingDays = totalDays - Math.floor(years * 365.25);
  const months = Math.floor(remainingDays / 30.44);
  const days = Math.floor(remainingDays - months * 30.44);
  
  const trienios = Math.floor(years / 3);
  const nextTrienio = (trienios + 1) * 3;
  const daysToNextTrienio = Math.ceil((nextTrienio * 365.25) - totalDays);
  const progressToNextTrienio = ((totalDays - trienios * 3 * 365.25) / (3 * 365.25)) * 100;
  
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
          <div class="settings-row-title">Configuración</div>
          <div class="settings-row-desc">Fecha inicio y días previos</div>
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
    
    <div style="padding:8px 16px 16px;">
      <div class="muted" style="font-size:12px;text-align:center;">
        Inicio: ${startDate.toLocaleDateString('es-ES')}<br>
        ${t.manualDaysBefore ? `${t.manualDaysBefore} días manuales + ` : ''}${workedDaysFromApp} días desde uso de la app
      </div>
    </div>
  `;
}

function openTenureSetup() {
  const user = state.users[state.currentUser];
  const t = user.tenure || {};
  openModal('Antigüedad', `
    <label class="input-label">Fecha de inicio en la empresa</label>
    <input type="date" class="input-field" id="tenStart" value="${t.startDate || ''}">
    <label class="input-label mt-12">Días trabajados antes de usar la app</label>
    <input type="number" class="input-field" id="tenManual" value="${t.manualDaysBefore || 0}" min="0">
    <p class="muted" style="font-size:12px;margin-top:6px;">Solo días de alta efectiva, sin contar bajas o interrupciones.</p>
  `, [
    { text: 'Cancelar', class: 'btn-secondary', onClick: closeModal },
    { text: 'Guardar', onClick: () => {
      const start = document.getElementById('tenStart').value;
      const manual = parseInt(document.getElementById('tenManual').value) || 0;
      user.tenure.startDate = start || null;
      user.tenure.manualDaysBefore = manual;
      saveUser(state.currentUser);
      closeModal();
      renderTenure();
      toast('Guardado', 'success');
    }}
  ]);
}

function openMonthlyCheck(targetMonth) {
  const user = state.users[state.currentUser];
  // Default to previous month
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
    if (!val.shiftId) continue;
    if (!key.startsWith(monthKey)) continue;
    const shift = user.shifts.find(s => s.id === val.shiftId);
    if (!shift || shift.hours <= 0) continue;
    workedDays.push({ key, shift, hours: val.hours });
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
    if (!val.shiftId) continue;
    if (new Date(key + 'T00:00:00').getFullYear() !== currentYear) continue;
    if (vacShifts.some(s => s.id === val.shiftId)) usedVac++;
    if (ldShifts.some(s => s.id === val.shiftId)) usedLD++;
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
  const data = { users: state.users, events: state.events, exportedAt: new Date().toISOString() };
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
    if (!val.shiftId) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    counts[val.shiftId] = counts[val.shiftId] || { days: 0, hours: 0 };
    counts[val.shiftId].days++;
    counts[val.shiftId].hours += val.hours || 0;
    totalDays++; totalHours += val.hours || 0;
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
  
  const rows = [['Fecha', 'Día semana', 'Turno', 'Nombre', 'Horas', 'Nota']];
  const days = Object.entries(user.days).sort();
  for (const [key, val] of days) {
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    const shift = user.shifts.find(s => s.id === val.shiftId);
    rows.push([
      key,
      d.toLocaleDateString('es-ES', { weekday: 'long' }),
      shift?.code || '',
      shift?.name || '',
      val.hours || 0,
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
    if (!val.shiftId) continue;
    const d = new Date(key + 'T00:00:00');
    if (isMonth) {
      if (d.getFullYear() !== state.statsYear || d.getMonth() !== state.statsMonth) continue;
    } else {
      if (d.getFullYear() !== state.statsYear) continue;
    }
    counts[val.shiftId] = counts[val.shiftId] || { days: 0, hours: 0 };
    counts[val.shiftId].days++;
    counts[val.shiftId].hours += val.hours || 0;
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
