// =================== STATE ===================
const VERSION = '1.6.4';
let _renameInProgress = false; // блокирует перезапись tech.projects autorefresh'ом во время rename
const STORE_KEY = 'kanban-techs-v2';
const FILTERS_KEY = 'kanban-view-filters-v1';
const LISTPREFS_KEY = 'kanban-list-prefs-v1';
const CUSTOM_COLORS_KEY = 'kanban-custom-colors-v1';

let techs = [];
let tasks = [];
let serverVersion = null;
let currentView = 'board';
let currentEditTaskId = null;

// Раздельные фильтры для каждого вида. Массивы = multi-select (OR между значениями).
const defaultFilters = () => ({
  priority: [],     // ["Высокий", "Средний"]
  deadline: null,   // "overdue" | "today" | "week" | "range"
  dateFrom: null,   // ISO date when deadline == "range"
  dateTo: null,
  tech: [],         // [techId1, techId2]
  project: []       // [name1, name2]
});

let viewFilters = { board: defaultFilters(), list: defaultFilters() };
try {
  const raw = localStorage.getItem(FILTERS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed.board) viewFilters.board = { ...defaultFilters(), ...parsed.board };
    if (parsed.list)  viewFilters.list  = { ...defaultFilters(), ...parsed.list };
  }
} catch(e) {}
function saveFilters() { localStorage.setItem(FILTERS_KEY, JSON.stringify(viewFilters)); }
function curFilters() { return viewFilters[currentView] || viewFilters.board; }

// Настройки списка и доски: группировка, сортировка, видимость статусов
let listPrefs = {
  groupBy: 'project',
  sortBy: 'deadline',
  sortDir: 'asc',
  boardSortBy: 'priority',
  statusFilter: { 'В работе': true, 'Выполнено': true, 'Отменена': true },
  // v1.2.0
  pinnedProjects: [],
  freeSort: false,
  taskOrder: [],
  groupOrder: [],
  // v1.6.2 — сортировка в окне Проекты
  projectsSortBy: 'name',
  projectsSortDir: 'asc'
};
try {
  const raw = localStorage.getItem(LISTPREFS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    listPrefs = { ...listPrefs, ...parsed };
    // Гарантируем что statusFilter — объект с тремя ключами
    listPrefs.statusFilter = { 'В работе': true, 'Выполнено': true, 'Отменена': true, ...(parsed.statusFilter || {}) };
  }
} catch(e) {}
function saveListPrefs() { localStorage.setItem(LISTPREFS_KEY, JSON.stringify(listPrefs)); }

// =================== COLORS (v1.3.0) ===================
// Кастомные цвета проектов и приоритетов. Хранятся per-tech (у каждого технаря свои), в localStorage.
let customColors = { projects: {}, priorities: {} };
const DEFAULT_PRIORITY_COLORS = {
  'Высокий': '#6f42c1',
  'Средний': '#d97757',
  'Низкий':  '#5fa463'
};
// Палитра-пресетов: подобрана так чтобы плашки читались на светлом фоне
const COLOR_PRESETS = [
  '#d97757', '#378add', '#5fa463', '#a766c4',
  '#c0392b', '#0f6e56', '#854f0b', '#993556',
  '#1f6d35', '#185fa5', '#6f42c1', '#b8860b',
  '#6c757d', '#e83e8c', '#20c997', '#fd7e14'
];

function loadCustomColors() {
  try {
    const raw = localStorage.getItem(CUSTOM_COLORS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      customColors = {
        projects: (parsed && parsed.projects) || {},
        priorities: (parsed && parsed.priorities) || {}
      };
    }
  } catch (e) { customColors = { projects: {}, priorities: {} }; }
}
function saveCustomColors() {
  localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customColors));
}

// Цвет проекта: кастомный, либо детерминированный из палитры
function projectColor(name) {
  if (!name) return '#6c757d';
  if (customColors.projects[name]) return customColors.projects[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLOR_PRESETS[Math.abs(hash) % 8]; // первые 8 — основная палитра
}
function priorityColor(level) {
  if (customColors.priorities[level]) return customColors.priorities[level];
  return DEFAULT_PRIORITY_COLORS[level] || '#6c757d';
}

// Превращаем hex-цвет в светлый фон (для плашек) — добавляем альфу
function colorBg(hex) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return 'rgba(' + r + ',' + g + ',' + b + ',0.14)';
}
// Контрастность: для очень светлых цветов используем более тёмный текст
function colorText(hex) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  // Тёмный вариант того же цвета: оставляем как есть, он уже достаточно тёмный для текста
  // если цвет слишком светлый (luma > 200) — затемним
  const luma = 0.299*r + 0.587*g + 0.114*b;
  if (luma > 200) {
    // Затемним до 30% яркости
    const f = 0.5;
    return 'rgb(' + Math.round(r*f) + ',' + Math.round(g*f) + ',' + Math.round(b*f) + ')';
  }
  return hex;
}
// HTML для плашки проекта с применённым цветом
function projectChipHtml(name, opts) {
  opts = opts || {};
  const c = projectColor(name);
  const extra = opts.style || '';
  const cls = opts.cls || 'mini-chip';
  return '<span class="' + cls + '" style="background:' + colorBg(c) + '; color:' + colorText(c) + ';' + extra + '">#' + escapeHtml(name) + '</span>';
}

// Применяем CSS-переменные для приоритетов (border-left, badge, etc.)
function applyCustomColorStyles() {
  let el = document.getElementById('customColorVars');
  if (!el) {
    el = document.createElement('style');
    el.id = 'customColorVars';
    document.head.appendChild(el);
  }
  const ph = priorityColor('Высокий');
  const pm = priorityColor('Средний');
  const pl = priorityColor('Низкий');
  el.textContent =
    ':root{' +
      '--prio-h:' + ph + ';--prio-h-bg:' + colorBg(ph) + ';--prio-h-text:' + colorText(ph) + ';' +
      '--prio-m:' + pm + ';--prio-m-bg:' + colorBg(pm) + ';--prio-m-text:' + colorText(pm) + ';' +
      '--prio-l:' + pl + ';--prio-l-bg:' + colorBg(pl) + ';--prio-l-text:' + colorText(pl) + ';' +
    '}';
}

// =================== STORAGE ===================
function loadTechs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) techs = JSON.parse(raw);
  } catch (e) { techs = []; }
}
function saveTechs() { localStorage.setItem(STORE_KEY, JSON.stringify(techs)); }

function renderActive() {
  renderBoard();
  if (currentView === 'list') renderList();
  if (currentView === 'stats') renderStats();
}

// =================== UTILS ===================
function uid() { return 'l' + Math.random().toString(36).slice(2, 10); }

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function avatarColor(name) {
  const colors = ['#d97757', '#378add', '#5fa463', '#a766c4', '#c0392b', '#0f6e56', '#854f0b', '#993556'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
function initials(name) {
  return name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function findTechByProject(project) {
  if (!project) return null;
  const p = String(project).toLowerCase();
  // 1) Сначала ищем по явной привязке (tech.projects)
  const explicit = techs.find(t => t.projects.some(pr => pr.toLowerCase() === p));
  if (explicit) return explicit;
  // 2) Fallback: смотрим в существующих задачах — если у этого проекта есть техник, берём его
  const task = tasks.find(t => t.project && t.project.toLowerCase() === p && t.techId);
  if (task) return getTech(task.techId) || null;
  return null;
}
function getTech(id) { return techs.find(t => t.id === id); }

// =================== DEADLINE PARSER ===================
const DOW_MAP = { пн:1,вт:2,ср:3,чт:4,пт:5,сб:6,вс:0,
  понедельник:1,вторник:2,среда:3,четверг:4,пятница:5,суббота:6,воскресенье:0 };

function parseDeadline(token) {
  const t = token.toLowerCase().trim();
  const today = new Date(); today.setHours(0,0,0,0);
  if (t === 'сегодня') return today;
  if (t === 'вчера') { const d = new Date(today); d.setDate(d.getDate()-1); return d; }
  if (t === 'позавчера') { const d = new Date(today); d.setDate(d.getDate()-2); return d; }
  if (t === 'завтра') { const d = new Date(today); d.setDate(d.getDate()+1); return d; }
  if (t === 'послезавтра') { const d = new Date(today); d.setDate(d.getDate()+2); return d; }
  if (t === 'неделя') { const d = new Date(today); d.setDate(d.getDate()+7); return d; }
  if (t === 'месяц') { const d = new Date(today); d.setMonth(d.getMonth()+1); return d; }
  if (DOW_MAP[t] !== undefined) {
    const target = DOW_MAP[t];
    const d = new Date(today);
    let diff = target - d.getDay();
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return d;
  }
  const m = t.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (m) {
    const day = parseInt(m[1],10);
    const mon = parseInt(m[2],10) - 1;
    let year = m[3] ? parseInt(m[3],10) : today.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, mon, day);
    if (!m[3] && d < today) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  return null;
}

function toIsoDate(d) {
  if (!d) return '';
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  if (diff < 0) return Math.abs(diff) + 'д назад';
  if (diff > 1 && diff <= 7) return 'через ' + diff + 'д';
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0');
}

function deadlineClass(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((d - today) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return '';
}

// =================== QUICK ADD PARSER ===================
// Получить список всех известных проектов (для матчинга многословных)
function getAllProjectNames() {
  const set = new Set();
  techs.forEach(t => t.projects.forEach(p => set.add(p)));
  tasks.forEach(t => { if (t.project) set.add(t.project); });
  return Array.from(set);
}

function parseQuickAdd(text) {
  let title = text;
  let project = null, priority = null, deadline = null;

  // Приоритет
  const prioM = title.match(/(?:^|\s)(!{1,3})(?=\s|$)/);
  if (prioM) {
    const p = prioM[1];
    priority = p === '!!!' ? 'Высокий' : p === '!!' ? 'Средний' : 'Низкий';
    title = title.replace(prioM[0], ' ');
  }

  // Дедлайн
  const dlM = title.match(/(?:^|\s)@([^\s]+)/);
  if (dlM) {
    const d = parseDeadline(dlM[1]);
    if (d) {
      deadline = toIsoDate(d);
      title = title.replace(dlM[0], ' ');
    }
  }

  // Проект — поддержка многословных (например, "Дима VR").
  // Берём от # до конца / до ! / до @ / до следующего # — это потенциальный регион проекта.
  // Внутри пытаемся сматчить самый длинный из known projects.
  const hashIdx = title.indexOf('#');
  if (hashIdx !== -1) {
    const before = title.slice(0, hashIdx);
    const afterHash = title.slice(hashIdx + 1);
    const stopM = afterHash.match(/[!@#]/);
    const region = (stopM ? afterHash.slice(0, stopM.index) : afterHash).replace(/\s+$/, '');
    const tail = stopM ? afterHash.slice(stopM.index) : '';

    // Ищем longest match (case-insensitive)
    const known = getAllProjectNames().sort((a, b) => b.length - a.length);
    let matched = null;
    const regionLower = region.toLowerCase();
    for (const p of known) {
      const pl = p.toLowerCase();
      if (regionLower === pl ||
          regionLower.startsWith(pl + ' ') ||
          regionLower.startsWith(pl + '\t')) {
        matched = p;
        break;
      }
    }

    if (matched) {
      project = matched;
      const leftover = region.slice(matched.length).trim();
      title = (before + ' ' + leftover + ' ' + tail).replace(/\s+/g, ' ').trim();
    } else {
      // Fallback: первое слово как проект (как было раньше)
      const firstWord = region.split(/\s+/)[0];
      if (firstWord) {
        project = firstWord;
        const leftover = region.slice(firstWord.length).trim();
        title = (before + ' ' + leftover + ' ' + tail).replace(/\s+/g, ' ').trim();
      }
    }
  }

  title = title.replace(/\s+/g, ' ').trim();
  return { title, project, priority, deadline };
}

// =================== AUTOCOMPLETE ===================
let acItems = [];
let acIndex = -1;
let acRange = null;

function getAllProjectsWithTechs() {
  const map = new Map(); // name → Set<techId>
  // Из явных привязок (tech.projects)
  techs.forEach(t => {
    t.projects.forEach(p => {
      if (!map.has(p)) map.set(p, new Set());
      map.get(p).add(t.id);
    });
  });
  // Из задач (на случай если в tech.projects нет, но задачи по проекту есть)
  tasks.forEach(task => {
    if (task.project && task.techId) {
      if (!map.has(task.project)) map.set(task.project, new Set());
      map.get(task.project).add(task.techId);
    }
  });
  return Array.from(map.entries()).map(([name, techIds]) => ({
    name,
    techs: Array.from(techIds).map(id => getTech(id)).filter(Boolean)
  }));
}

function findHashTokenAtCursor(input) {
  const val = input.value;
  const cursor = input.selectionStart;
  const left = val.slice(0, cursor);
  const hashIdx = left.lastIndexOf('#');
  if (hashIdx === -1) return null;
  // Между # и cursor не должно быть других специальных символов
  const between = val.slice(hashIdx + 1, cursor);
  if (/[!@#]/.test(between)) return null;
  // Справа от курсора — до !/@/# или конца
  const rest = val.slice(cursor);
  const stopM = rest.match(/[!@#]/);
  const endIdx = stopM ? cursor + stopM.index : val.length;
  // Query = текст от # до cursor (может содержать пробелы), trim
  const query = val.slice(hashIdx + 1, cursor).replace(/^\s+/, '').replace(/\s+$/, '');
  return { start: hashIdx, end: endIdx, query };
}

function renderAutocomplete() {
  const ac = document.getElementById('autocomplete');
  const range = findHashTokenAtCursor(quickAdd);
  if (!range) { ac.classList.remove('active'); acItems = []; return; }
  acRange = range;
  const q = range.query.toLowerCase();
  const all = getAllProjectsWithTechs();
  let items;
  if (q === '') {
    items = all.slice().sort((a,b) => a.name.localeCompare(b.name)).slice(0, 10);
  } else {
    items = all
      .map(p => {
        const n = p.name.toLowerCase();
        let score = 0;
        if (n === q) score = 100;
        else if (n.startsWith(q)) score = 80;
        else if (n.includes(q)) score = 50;
        return { ...p, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 10);
  }
  acItems = items;
  if (items.length === 0) { ac.classList.remove('active'); return; }
  acIndex = 0;
  ac.innerHTML = items.map((p, i) => {
    let nameHtml = escapeHtml(p.name);
    if (q) {
      const lower = p.name.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx >= 0) {
        nameHtml = escapeHtml(p.name.slice(0, idx)) + '<b>' + escapeHtml(p.name.slice(idx, idx + q.length)) + '</b>' + escapeHtml(p.name.slice(idx + q.length));
      }
    }
    const techsHtml = p.techs.map(t =>
      '<span class="avatar" style="width:16px;height:16px;font-size:8px;background:' + avatarColor(t.name) + '">' + initials(t.name) + '</span> ' + escapeHtml(t.name)
    ).join('  ');
    return '<div class="ac-item' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '">' +
      '<span class="ac-name">#' + nameHtml + '</span>' +
      '<span class="ac-tech">' + techsHtml + '</span>' +
    '</div>';
  }).join('') + '<div class="ac-hint">↑↓ выбрать · Enter или Tab — вставить · Esc — закрыть</div>';
  ac.classList.add('active');
  ac.querySelectorAll('.ac-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      acIndex = parseInt(el.dataset.idx);
      applyAutocomplete();
    });
  });
}

function applyAutocomplete() {
  if (!acRange || acIndex < 0 || acIndex >= acItems.length) return;
  const item = acItems[acIndex];
  const val = quickAdd.value;
  const before = val.slice(0, acRange.start);
  const after = val.slice(acRange.end);
  const trail = after.startsWith(' ') ? '' : ' ';
  const insert = '#' + item.name + trail;
  quickAdd.value = before + insert + after;
  const newPos = before.length + insert.length;
  quickAdd.setSelectionRange(newPos, newPos);
  document.getElementById('autocomplete').classList.remove('active');
  acItems = [];
  renderPreview(quickAdd.value);
}

function updateAcSelection() {
  document.querySelectorAll('.ac-item').forEach((el, i) => {
    el.classList.toggle('selected', i === acIndex);
  });
}

// =================== API ===================
async function apiGet(url) {
  const r = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

// =================== SYNC / TOAST ===================
function setSync(state, text) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  if (!dot) return;
  dot.classList.remove('syncing', 'error');
  if (state === 'syncing') dot.classList.add('syncing');
  if (state === 'error') dot.classList.add('error');
  txt.textContent = text || (state === 'syncing' ? 'обновляю' : state === 'error' ? 'ошибка' : 'синхрон');
}

function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// =================== LOAD ===================
async function reloadTasks(silent = false) {
  if (techs.length === 0) { tasks = []; renderActive(); return; }
  if (_renameInProgress) { return; } // не дёргаем сервер пока идёт переименование, иначе rebuilt tasks затрут локальные правки
  if (!silent) setSync('syncing');
  const results = await Promise.allSettled(
    techs.map(t => apiGet(t.url).then(r => ({tech: t, data: r})))
  );
  const allTasks = [];
  let errors = 0;
  let firstVersion = null;
  let techsUpdated = false;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data.ok) {
      const tech = r.value.tech;
      if (r.value.data.version && !firstVersion) firstVersion = r.value.data.version;
      // Обновляем проекты из таблицы — источник правды в Sheets, не в localStorage
      // Во время rename НЕ перетираем — иначе старое имя может вернуться, если Sheets ещё не закоммитил updateProjects
      if (!_renameInProgress && Array.isArray(r.value.data.projects)) {
        tech.projects = r.value.data.projects;
        techsUpdated = true;
      }
      r.value.data.tasks.forEach(task => {
        // Sheets иногда возвращает числа для текстовых ячеек — нормализуем строки.
        const norm = { ...task };
        for (const k of ['title','project','note','status','priority','deadline','createdAt','completedAt']) {
          if (norm[k] != null && typeof norm[k] !== 'string') norm[k] = String(norm[k]);
        }
        allTasks.push({ ...norm, techId: tech.id, synced: true });
      });
    } else {
      errors++;
      console.error('Failed to load tech', techs[i].name, r);
    }
  });
  if (techsUpdated) saveTechs(); // Сохраняем обновлённые проекты
  tasks = allTasks;
  if (firstVersion) serverVersion = firstVersion;
  updateVersionFooter();
  if (errors > 0) {
    setSync('error', errors + ' с ошибкой');
    if (!silent) toast('Не удалось загрузить ' + errors + ' таблиц', true);
  } else {
    setSync('idle');
  }
  renderActive();
  if (currentView === 'stats') renderStats();
  if (currentView === 'list') renderList();
}

// =================== RENDER PREVIEW ===================
function renderPreview(text) {
  const preview = document.getElementById('preview');
  if (!text.trim()) { preview.innerHTML = ''; return; }
  const p = parseQuickAdd(text);
  const parts = [];
  if (p.title) parts.push('<span class="chip"><strong>' + escapeHtml(p.title) + '</strong></span>');
  if (p.project) {
    const tech = findTechByProject(p.project);
    if (tech) parts.push('<span class="chip">#' + escapeHtml(p.project) + ' → ' + escapeHtml(tech.name) + '</span>');
    else parts.push('<span class="chip warn">#' + escapeHtml(p.project) + ' (выберешь технаря)</span>');
  }
  if (p.priority) parts.push('<span class="chip">' + p.priority + '</span>');
  if (p.deadline) parts.push('<span class="chip">' + formatDateShort(p.deadline) + '</span>');
  preview.innerHTML = parts.join('');
}

// =================== BOARD ===================
// Перерисовать фильтры обоих видов (вызывается когда меняются техники/проекты)
function renderTechFilters() {
  renderFilters('board');
  renderFilters('list');
}

function taskMatchesFilters(task) {
  const f = curFilters();
  if (f.priority && f.priority.length && !f.priority.includes(task.priority)) return false;
  if (f.tech && f.tech.length && !f.tech.includes(task.techId)) return false;
  if (f.project && f.project.length && !f.project.includes(task.project || '')) return false;
  if (f.deadline) {
    if (!task.deadline) return false;
    const d = new Date(task.deadline);
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((d - today) / 86400000);
    if (f.deadline === 'overdue' && diff >= 0) return false;
    if (f.deadline === 'today' && diff !== 0) return false;
    if (f.deadline === 'week' && (diff < 0 || diff > 7)) return false;
    if (f.deadline === 'range') {
      if (f.dateFrom) {
        const from = new Date(f.dateFrom); from.setHours(0,0,0,0);
        if (d < from) return false;
      }
      if (f.dateTo) {
        const to = new Date(f.dateTo); to.setHours(23,59,59,999);
        if (d > to) return false;
      }
    }
  }
  return true;
}

function renderBoard() {
  const statuses = ['В работе', 'Выполнено', 'Отменена'];
  const sortBy = listPrefs.boardSortBy || 'priority';
  const today = new Date(); today.setHours(0,0,0,0);
  const freeSortB = listPrefs.freeSort;
  const taskOrderB = listPrefs.taskOrder || [];
  const orderIdxB = (t) => {
    const k = t.id + '|' + t.techId;
    const i = taskOrderB.indexOf(k);
    return i === -1 ? 99999 : i;
  };
  const cmp = (a, b) => {
    if (freeSortB) return orderIdxB(a) - orderIdxB(b);
    if (sortBy === 'priority') {
      const r = { 'Высокий': 0, 'Средний': 1, 'Низкий': 2 };
      const pa = r[a.priority] ?? 3;
      const pb = r[b.priority] ?? 3;
      if (pa !== pb) return pa - pb;
    } else if (sortBy === 'overdue') {
      const isOv = t => t.deadline && new Date(t.deadline) < today && t.status === 'В работе';
      const ao = isOv(a) ? 0 : 1;
      const bo = isOv(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
    } else if (sortBy === 'created') {
      const ca = a.createdAt || '';
      const cb = b.createdAt || '';
      if (ca !== cb) return cb.localeCompare(ca);
    }
    // Tie-breaker / default — дедлайн
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  };
  statuses.forEach(status => {
    const col = document.querySelector('.column-tasks[data-status="' + status + '"]');
    const list = tasks
      .filter(t => (t.status || 'В работе') === status && taskMatchesFilters(t))
      .sort(cmp);
    document.getElementById('count-' + status).textContent = list.length;
    col.innerHTML = list.length === 0
      ? '<div class="empty-column">пусто</div>'
      : list.map(renderTaskCard).join('');
  });
  attachTaskHandlers();
}

// Локально обновить completedAt при смене статуса (сервер делает то же).
// Это нужно чтобы недельный отчёт сразу видел задачу как "сделано сегодня"
// без полной перезагрузки данных.
function applyStatusChange(task, newStatus) {
  task.status = newStatus;
  if (newStatus === 'Выполнено' && !task.completedAt) {
    task.completedAt = toIsoDate(new Date());
  } else if (newStatus !== 'Выполнено' && task.completedAt) {
    task.completedAt = '';
  }
}

// Просрочена ли задача (для подсветки)
function isOverdueTask(task) {
  if (!task.deadline || task.status !== 'В работе') return false;
  const d = new Date(task.deadline);
  const today = new Date(); today.setHours(0,0,0,0);
  return d < today;
}

function renderTaskCard(task) {
  const tech = getTech(task.techId);
  const prioMap = { 'Высокий': 'prio-h', 'Средний': 'prio-m', 'Низкий': 'prio-l' };
  const prioBadgeCls = { 'Высокий': 'h', 'Средний': 'm', 'Низкий': 'l' };
  const prioClass = prioMap[task.priority] || '';
  const dlClass = deadlineClass(task.deadline);
  const completedClass = task.status === 'Выполнено' || task.status === 'Отменена' ? 'completed' : '';
  const overdueClass = isOverdueTask(task) ? 'is-overdue' : '';
  return '<div class="task ' + prioClass + ' ' + completedClass + ' ' + overdueClass + '" draggable="true" data-id="' + task.id + '" data-tech="' + task.techId + '">' +
    '<div class="task-title">' + escapeHtml(task.title) + '</div>' +
    '<div class="task-meta">' +
      (task.priority ? '<span class="task-prio-badge ' + prioBadgeCls[task.priority] + '">' + escapeHtml(task.priority) + '</span>' : '') +
      (task.project ? ('<span class="task-tag project" style="background:' + colorBg(projectColor(task.project)) + ';color:' + colorText(projectColor(task.project)) + ';">#' + escapeHtml(task.project) + '</span>') : '') +
      (task.deadline ? '<span class="task-tag deadline ' + dlClass + '">' + formatDateShort(task.deadline) + '</span>' : '') +
      (task.note ? '<span class="task-tag note-marker" title="' + escapeHtml(task.note) + '">📝</span>' : '') +
      (tech ? '<span class="task-assignee"><span class="avatar" style="background:' + avatarColor(tech.name) + '">' + initials(tech.name) + '</span></span>' : '') +
    '</div>' +
  '</div>';
}

function attachTaskHandlers() {
  const freeSort = listPrefs.freeSort;
  document.querySelectorAll('.task').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.id, el.dataset.tech));
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: el.dataset.id, techId: el.dataset.tech }));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    if (freeSort) {
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
        const raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;
        let payload;
        try { payload = JSON.parse(raw); } catch(_) { return; }
        if (!payload || !payload.id) return;
        const srcKey = payload.id + '|' + payload.techId;
        const dstKey = el.dataset.id + '|' + el.dataset.tech;
        if (srcKey === dstKey) return;
        const srcTask = tasks.find(t => String(t.id) === String(payload.id) && t.techId === payload.techId);
        const dstTask = tasks.find(t => String(t.id) === String(el.dataset.id) && t.techId === el.dataset.tech);
        if (!srcTask || !dstTask) return;
        const rect = el.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        let statusChanged = false;
        if (srcTask.status !== dstTask.status) {
          applyStatusChange(srcTask, dstTask.status);
          statusChanged = true;
        }
        const allKeys = tasks.map(t => t.id + '|' + t.techId);
        let order = (listPrefs.taskOrder || []).slice();
        allKeys.forEach(k => { if (!order.includes(k)) order.push(k); });
        order = order.filter(k => k !== srcKey);
        let di = order.indexOf(dstKey);
        if (di < 0) di = order.length;
        if (after) di += 1;
        order.splice(di, 0, srcKey);
        listPrefs.taskOrder = order;
        saveListPrefs();
        renderActive();
        if (statusChanged) {
          try {
            setSync('syncing');
            const tech = getTech(srcTask.techId);
            const res = await apiPost(tech.url, { action: 'update', task: srcTask });
            if (!res.ok) throw new Error(res.error);
            setSync('idle');
          } catch (err) {
            setSync('error');
            toast('Не удалось обновить: ' + err.message, true);
          }
        }
      });
    }
  });
}

function initDragDrop() {
  document.querySelectorAll('.column-tasks').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      const { id, techId } = JSON.parse(raw);
      const task = tasks.find(t => String(t.id) === String(id) && t.techId === techId);
      if (!task) return;
      const newStatus = col.dataset.status;
      if (task.status === newStatus) return;
      applyStatusChange(task, newStatus);
      renderActive();
      try {
        setSync('syncing');
        const tech = getTech(techId);
        const res = await apiPost(tech.url, { action: 'update', task });
        if (!res.ok) throw new Error(res.error);
        setSync('idle');
      } catch (err) {
        setSync('error');
        toast('Не удалось обновить: ' + err.message, true);
      }
    });
  });
}

// =================== ADD TASK ===================
async function createTask(taskData, techId) {
  const tech = getTech(techId);
  if (!tech) { toast('Технарь не найден', true); return; }
  setSync('syncing');
  try {
    const res = await apiPost(tech.url, { action: 'add', task: taskData });
    if (!res.ok) throw new Error(res.error);
    tasks.push({ ...taskData, id: res.id, techId, synced: true });

    // Если проект новый для этого технаря — авто-зарегистрируем в Справочниках
    if (taskData.project && !tech.projects.includes(taskData.project)) {
      tech.projects.push(taskData.project);
      saveTechs();
      apiPost(tech.url, { action: 'updateProjects', projects: tech.projects }).catch(() => {});
    }

    setSync('idle');
    renderActive();
    toast('Добавлено: ' + tech.name);
  } catch (err) {
    setSync('error');
    toast('Не удалось добавить: ' + err.message, true);
  }
}

function chooseTechForTask(taskData) {
  const body = document.getElementById('chooseTechBody');
  if (techs.length === 0) {
    body.innerHTML = '<p>Сначала добавь технаря в настройках.</p>';
  } else {
    body.innerHTML = techs.map(t =>
      '<button class="btn" style="display:flex; align-items:center; gap:10px; width:100%; margin-bottom:6px; padding:10px;" data-tech="' + t.id + '">' +
        '<span class="avatar" style="background:' + avatarColor(t.name) + '">' + initials(t.name) + '</span>' +
        '<span>' + escapeHtml(t.name) + '</span>' +
      '</button>'
    ).join('');
    body.querySelectorAll('[data-tech]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('chooseTechModal').classList.remove('active');
        createTask(taskData, btn.dataset.tech);
      });
    });
  }
  document.getElementById('chooseTechModal').classList.add('active');
}

// =================== QUICK ADD ===================
const quickAdd = document.getElementById('quickAdd');

quickAdd.addEventListener('input', () => {
  renderPreview(quickAdd.value);
  renderAutocomplete();
});
quickAdd.addEventListener('click', () => renderAutocomplete());
quickAdd.addEventListener('keyup', e => {
  if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) renderAutocomplete();
});
quickAdd.addEventListener('blur', () => {
  setTimeout(() => document.getElementById('autocomplete').classList.remove('active'), 150);
});

quickAdd.addEventListener('keydown', async e => {
  const acActive = document.getElementById('autocomplete').classList.contains('active');
  if (acActive && acItems.length > 0) {
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; updateAcSelection(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; updateAcSelection(); return; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const onlyAutocomplete = e.key === 'Tab' || (e.key === 'Enter' && findHashTokenAtCursor(quickAdd));
      if (onlyAutocomplete) {
        e.preventDefault();
        applyAutocomplete();
        return;
      }
    }
    if (e.key === 'Escape') {
      document.getElementById('autocomplete').classList.remove('active');
      acItems = [];
      return;
    }
  }
  if (e.key === 'Enter' && quickAdd.value.trim()) {
    e.preventDefault();
    const p = parseQuickAdd(quickAdd.value);
    if (!p.title) return;
    const taskData = {
      title: p.title,
      project: p.project || '',
      priority: p.priority || '',
      deadline: p.deadline || '',
      status: 'В работе',
      note: ''
    };
    const tech = p.project ? findTechByProject(p.project) : null;
    quickAdd.value = '';
    renderPreview('');
    document.getElementById('autocomplete').classList.remove('active');
    if (tech) await createTask(taskData, tech.id);
    else chooseTechForTask(taskData);
  }
});

// =================== FILTERS RENDER ===================
// Универсальная выпадайка-фильтр в едином стиле
function buildDropdown(opts) {
  // opts: { id, label, items: [{value, label, checked}], type: 'multi'|'radio', extra?: html }
  const activeCount = opts.items.filter(i => i.checked).length;
  let triggerLabel = opts.label;
  let triggerActive = false;
  if (opts.type === 'multi') {
    if (activeCount === 0) triggerLabel = opts.label;
    else if (activeCount === 1) {
      const item = opts.items.find(i => i.checked);
      triggerLabel = opts.label + ': ' + item.label;
      triggerActive = true;
    } else {
      triggerLabel = opts.label + ': ' + activeCount;
      triggerActive = true;
    }
  } else { // radio
    const sel = opts.items.find(i => i.checked);
    if (sel && sel.value !== '__all__') {
      triggerLabel = opts.label + ': ' + sel.label;
      triggerActive = true;
    }
  }

  let menu = '';
  opts.items.forEach(it => {
    if (it.value === '__divider__') {
      menu += '<div class="fdrop-item divider"></div>';
      return;
    }
    if (opts.type === 'multi') {
      menu += '<label class="fdrop-item"><input type="checkbox" data-fd-val="' + escapeHtml(it.value) + '"' + (it.checked ? ' checked' : '') + '> ' + it.label + '</label>';
    } else {
      menu += '<label class="fdrop-item"><input type="radio" name="' + opts.id + '" data-fd-val="' + escapeHtml(it.value) + '"' + (it.checked ? ' checked' : '') + '> ' + it.label + '</label>';
    }
  });
  if (opts.extra) menu += opts.extra;

  return '<div class="fdrop" id="' + opts.id + '">' +
    '<button class="fdrop-trigger' + (triggerActive ? ' active' : '') + '" data-fd-toggle>' + triggerLabel + ' ▾</button>' +
    '<div class="fdrop-menu">' + menu + '</div>' +
  '</div>';
}

function renderFilters(view) {
  const containerId = view === 'list' ? 'filtersList' : 'filtersBoard';
  const c = document.getElementById(containerId);
  if (!c) return;
  const f = viewFilters[view];

  const allProjects = new Set();
  techs.forEach(t => t.projects.forEach(p => allProjects.add(p)));
  tasks.forEach(t => { if (t.project) allProjects.add(t.project); });
  const projectList = Array.from(allProjects).sort();

  let html = '';

  // Сортировка (только для board — в list уже есть свой контрол сверху)
  if (view === 'board') {
    const sortOptions = [
      { value: 'priority', label: 'По приоритету' },
      { value: 'deadline', label: 'По дедлайну' },
      { value: 'overdue', label: 'Просроченные сверху' },
      { value: 'created', label: 'По дате создания' }
    ];
    html += buildDropdown({
      id: 'fd_sort_' + view,
      label: 'Сортировка',
      type: 'radio',
      items: sortOptions.map(o => ({ ...o, checked: listPrefs.boardSortBy === o.value }))
    });
  }

  // Приоритет
  html += buildDropdown({
    id: 'fd_priority_' + view,
    label: 'Приоритет',
    type: 'multi',
    items: ['Высокий', 'Средний', 'Низкий'].map(p => ({ value: p, label: p, checked: f.priority.includes(p) }))
  });

  // Дедлайн
  const deadlineItems = [
    { value: '__all__', label: 'Все', checked: !f.deadline },
    { value: 'overdue', label: 'Просрочено', checked: f.deadline === 'overdue' },
    { value: 'today', label: 'Сегодня', checked: f.deadline === 'today' },
    { value: 'week', label: 'Эта неделя', checked: f.deadline === 'week' },
    { value: 'range', label: 'Диапазон…', checked: f.deadline === 'range' }
  ];
  const dateExtra = f.deadline === 'range'
    ? '<div class="fdrop-dates"><input type="date" id="dateFrom_' + view + '" value="' + (f.dateFrom || '') + '"><span>—</span><input type="date" id="dateTo_' + view + '" value="' + (f.dateTo || '') + '"></div>'
    : '';
  html += buildDropdown({
    id: 'fd_deadline_' + view,
    label: 'Дедлайн',
    type: 'radio',
    items: deadlineItems,
    extra: dateExtra
  });

  // Технарь
  if (techs.length > 0) {
    html += buildDropdown({
      id: 'fd_tech_' + view,
      label: 'Технарь',
      type: 'multi',
      items: techs.map(t => ({ value: t.id, label: t.name, checked: f.tech.includes(t.id) }))
    });
  }

  // Проект
  if (projectList.length > 0) {
    html += buildDropdown({
      id: 'fd_project_' + view,
      label: 'Проект',
      type: 'multi',
      items: projectList.map(p => ({ value: p, label: '#' + p, checked: f.project.includes(p) }))
    });
  }

  // Свободная сортировка — общая для board и list
  html += '<label class="free-sort-toggle' + (listPrefs.freeSort ? ' active' : '') + '" style="margin-left:8px;">' +
    '<input type="checkbox" id="fd_freeSort_' + view + '"' + (listPrefs.freeSort ? ' checked' : '') + '>' +
    '<span>Свободная сортировка</span>' +
  '</label>';

  html += '<button class="clear-filters" data-clear-filters>Сбросить</button>';

  c.innerHTML = html;

  // Toggle открытия меню
  c.querySelectorAll('[data-fd-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const wasOpen = menu.classList.contains('open');
      document.querySelectorAll('.fdrop-menu.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) menu.classList.add('open');
    });
  });
  c.querySelectorAll('.fdrop-menu').forEach(m => m.addEventListener('click', e => e.stopPropagation()));

  // Multi-select чекбоксы
  c.querySelector('#fd_priority_' + view)?.querySelectorAll('[data-fd-val]').forEach(input => {
    input.addEventListener('change', () => {
      const v = input.dataset.fdVal;
      const idx = f.priority.indexOf(v);
      if (input.checked && idx === -1) f.priority.push(v);
      if (!input.checked && idx !== -1) f.priority.splice(idx, 1);
      saveFilters();
      // Не перерендериваем фильтры (dropdown должен остаться открытым) — только обновляем label
      const trig = c.querySelector('#fd_priority_' + view + ' .fdrop-trigger');
      if (trig) {
        const cnt = f.priority.length;
        trig.textContent = (cnt ? 'Приоритет: ' + f.priority.join(', ') : 'Приоритет') + ' ▾';
        trig.classList.toggle('active', cnt > 0);
      }
      renderActive();
    });
  });
  c.querySelector('#fd_tech_' + view)?.querySelectorAll('[data-fd-val]').forEach(input => {
    input.addEventListener('change', () => {
      const v = input.dataset.fdVal;
      const idx = f.tech.indexOf(v);
      if (input.checked && idx === -1) f.tech.push(v);
      if (!input.checked && idx !== -1) f.tech.splice(idx, 1);
      saveFilters();
      const trig = c.querySelector('#fd_tech_' + view + ' .fdrop-trigger');
      if (trig) {
        const cnt = f.tech.length;
        const names = f.tech.map(id => (getTech(id)?.name || '?')).join(', ');
        trig.textContent = (cnt ? 'Технарь: ' + names : 'Технарь') + ' ▾';
        trig.classList.toggle('active', cnt > 0);
      }
      renderActive();
    });
  });
  c.querySelector('#fd_project_' + view)?.querySelectorAll('[data-fd-val]').forEach(input => {
    input.addEventListener('change', () => {
      const v = input.dataset.fdVal;
      const idx = f.project.indexOf(v);
      if (input.checked && idx === -1) f.project.push(v);
      if (!input.checked && idx !== -1) f.project.splice(idx, 1);
      saveFilters();
      const trig = c.querySelector('#fd_project_' + view + ' .fdrop-trigger');
      if (trig) {
        const cnt = f.project.length;
        trig.textContent = (cnt ? 'Проект (' + cnt + ')' : 'Проект') + ' ▾';
        trig.classList.toggle('active', cnt > 0);
      }
      renderActive();
    });
  });

  // Radio: дедлайн
  c.querySelector('#fd_deadline_' + view)?.querySelectorAll('[data-fd-val]').forEach(input => {
    input.addEventListener('change', () => {
      const v = input.dataset.fdVal;
      if (v === '__all__') { f.deadline = null; f.dateFrom = null; f.dateTo = null; }
      else f.deadline = v;
      saveFilters();
      renderFilters(view);
      renderActive();
    });
  });
  const fromI = document.getElementById('dateFrom_' + view);
  const toI = document.getElementById('dateTo_' + view);
  if (fromI) fromI.addEventListener('change', e => { f.dateFrom = e.target.value || null; saveFilters(); renderActive(); });
  if (toI) toI.addEventListener('change', e => { f.dateTo = e.target.value || null; saveFilters(); renderActive(); });

  // Сортировка board
  if (view === 'board') {
    c.querySelector('#fd_sort_' + view)?.querySelectorAll('[data-fd-val]').forEach(input => {
      input.addEventListener('change', () => {
        listPrefs.boardSortBy = input.dataset.fdVal;
        saveListPrefs();
        renderFilters(view);
        renderActive();
      });
    });
  }

  // Чекбокс свободной сортировки (общий для всех видов)
  const fsChk = document.getElementById('fd_freeSort_' + view);
  if (fsChk) fsChk.addEventListener('change', e => {
    listPrefs.freeSort = e.target.checked;
    saveListPrefs();
    renderFilters(view);
    renderActive();
  });

  c.querySelectorAll('[data-clear-filters]').forEach(b => {
    b.addEventListener('click', () => {
      viewFilters[view] = defaultFilters();
      saveFilters();
      renderFilters(view);
      renderActive();
    });
  });
}

// Закрывать выпадайки при клике вне
document.addEventListener('click', () => {
  document.querySelectorAll('.fdrop-menu.open, .filter-md-menu.open').forEach(m => m.classList.remove('open'));
});

// =================== TASK MODAL ===================
function openNewTaskModal() {
  currentEditTaskId = null; // признак "новая задача"

  document.getElementById('editTitle').value = '';

  // Технарь — пустой по умолчанию
  const techSel = document.getElementById('editTech');
  techSel.innerHTML = '<option value="">— выбери —</option>' +
    techs.map(t => '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>').join('');

  // Все известные проекты
  const allP = new Set();
  techs.forEach(t => t.projects.forEach(p => allP.add(p)));
  tasks.forEach(t => { if (t.project) allP.add(t.project); });
  const projSel = document.getElementById('editProject');
  projSel.innerHTML = '<option value="">— нет —</option>' +
    Array.from(allP).sort().map(p =>
      '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>'
    ).join('');

  // Сброс приоритета, дедлайна, статуса, примечания
  document.querySelectorAll('#taskModal .priority-select .filter-chip').forEach(b => b.classList.remove('active'));
  document.getElementById('editDeadline').value = '';
  document.getElementById('editStatus').value = 'В работе';
  document.getElementById('editNote').value = '';

  // Меняем заголовок и скрываем кнопку удаления
  document.querySelector('#taskModal h2').textContent = 'Новая задача';
  document.getElementById('deleteTask').style.display = 'none';

  document.getElementById('taskModal').classList.add('active');
  setTimeout(() => document.getElementById('editTitle').focus(), 50);
}

function openTaskModal(id, techId) {
  const task = tasks.find(t => String(t.id) === String(id) && t.techId === techId);
  if (!task) return;
  currentEditTaskId = id + '|' + techId;
  document.getElementById('editTitle').value = task.title || '';
  const techSel = document.getElementById('editTech');
  techSel.innerHTML = techs.map(t => '<option value="' + t.id + '"' + (t.id === task.techId ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>').join('');
  const allP = new Set();
  techs.forEach(t => t.projects.forEach(p => allP.add(p)));
  if (task.project) allP.add(task.project);
  const projSel = document.getElementById('editProject');
  projSel.innerHTML = '<option value="">— нет —</option>' + Array.from(allP).sort().map(p =>
    '<option value="' + escapeHtml(p) + '"' + (p === task.project ? ' selected' : '') + '>' + escapeHtml(p) + '</option>'
  ).join('');
  document.querySelectorAll('#taskModal .priority-select .filter-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.prio === task.priority);
  });
  document.getElementById('editDeadline').value = task.deadline || '';
  document.getElementById('editStatus').value = task.status || 'В работе';
  document.getElementById('editNote').value = task.note || '';

  // Заголовок и кнопка удаления — для редактирования
  document.querySelector('#taskModal h2').textContent = 'Задача';
  document.getElementById('deleteTask').style.display = '';

  document.getElementById('taskModal').classList.add('active');
}

document.querySelectorAll('#taskModal .priority-select .filter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const same = btn.classList.contains('active');
    document.querySelectorAll('#taskModal .priority-select .filter-chip').forEach(b => b.classList.remove('active'));
    if (!same) btn.classList.add('active');
  });
});

document.getElementById('editProject').addEventListener('change', e => {
  const p = e.target.value;
  if (!p) return;
  const tech = findTechByProject(p);
  if (tech) document.getElementById('editTech').value = tech.id;
});

document.getElementById('saveTask').addEventListener('click', async () => {
  // === Создание новой задачи (через большую кнопку) ===
  if (currentEditTaskId === null) {
    const techId = document.getElementById('editTech').value;
    const title = document.getElementById('editTitle').value.trim();
    if (!title) { toast('Заполни название', true); return; }
    if (!techId) { toast('Выбери технаря или проект', true); return; }

    const activePrio = document.querySelector('#taskModal .priority-select .filter-chip.active');
    const newTask = {
      title,
      project: document.getElementById('editProject').value || '',
      priority: activePrio ? activePrio.dataset.prio : '',
      deadline: document.getElementById('editDeadline').value || '',
      status: document.getElementById('editStatus').value || 'В работе',
      note: document.getElementById('editNote').value || ''
    };
    document.getElementById('taskModal').classList.remove('active');
    await createTask(newTask, techId);
    return;
  }

  // === Редактирование существующей ===
  const [oldId, oldTechId] = currentEditTaskId.split('|');
  const task = tasks.find(t => String(t.id) === String(oldId) && t.techId === oldTechId);
  if (!task) return;
  const newTechId = document.getElementById('editTech').value;
  const activePrio = document.querySelector('#taskModal .priority-select .filter-chip.active');
  const updated = {
    id: task.id,
    title: document.getElementById('editTitle').value.trim() || task.title,
    project: document.getElementById('editProject').value || '',
    priority: activePrio ? activePrio.dataset.prio : '',
    deadline: document.getElementById('editDeadline').value || '',
    status: document.getElementById('editStatus').value || 'В работе',
    note: document.getElementById('editNote').value || ''
  };
  setSync('syncing');
  try {
    if (newTechId !== oldTechId) {
      const oldTech = getTech(oldTechId);
      const newTech = getTech(newTechId);
      const addRes = await apiPost(newTech.url, { action: 'add', task: updated });
      if (!addRes.ok) throw new Error('add: ' + addRes.error);
      const delRes = await apiPost(oldTech.url, { action: 'delete', id: task.id });
      if (!delRes.ok) throw new Error('delete: ' + delRes.error);
      tasks = tasks.filter(t => !(String(t.id) === String(oldId) && t.techId === oldTechId));
      tasks.push({ ...updated, id: addRes.id, techId: newTechId, synced: true });
    } else {
      const tech = getTech(oldTechId);
      const res = await apiPost(tech.url, { action: 'update', task: updated });
      if (!res.ok) throw new Error(res.error);
      // Корректно обновим completedAt локально, если статус сменился
      const prevStatus = task.status;
      Object.assign(task, updated, { synced: true });
      if (task.status !== prevStatus) applyStatusChange(task, task.status);
    }
    setSync('idle');
    document.getElementById('taskModal').classList.remove('active');
    renderActive();
  } catch (err) {
    setSync('error');
    toast('Ошибка сохранения: ' + err.message, true);
  }
});

document.getElementById('deleteTask').addEventListener('click', async () => {
  if (!confirm('Удалить задачу?')) return;
  const [id, techId] = currentEditTaskId.split('|');
  const tech = getTech(techId);
  const task = tasks.find(t => String(t.id) === String(id) && t.techId === techId);
  setSync('syncing');
  try {
    const res = await apiPost(tech.url, { action: 'delete', id: task.id });
    if (!res.ok) throw new Error(res.error);
    tasks = tasks.filter(t => !(String(t.id) === String(id) && t.techId === techId));
    setSync('idle');
    document.getElementById('taskModal').classList.remove('active');
    renderActive();
  } catch (err) {
    setSync('error');
    toast('Ошибка удаления: ' + err.message, true);
  }
});

document.getElementById('cancelTask').addEventListener('click', () => document.getElementById('taskModal').classList.remove('active'));
document.getElementById('chooseTechCancel').addEventListener('click', () => document.getElementById('chooseTechModal').classList.remove('active'));

// =================== PROJECTS MODAL ===================
document.getElementById('projectsBtn').addEventListener('click', () => {
  renderProjectsModal();
  document.getElementById('projectsModal').classList.add('active');
});
document.getElementById('closeProjects').addEventListener('click', () => document.getElementById('projectsModal').classList.remove('active'));

function renderProjectsModal() {
  // Tech select
  const sel = document.getElementById('newProjectTech');
  sel.innerHTML = techs.map(t => '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>').join('');

  // List
  const list = document.getElementById('projectsList');
  const all = getAllProjectsWithTechs();
  if (all.length === 0) {
    list.innerHTML = '<div class="help-block">Пока нет проектов. Добавь выше.</div>';
    return;
  }
  // Сортировка
  const sortBy = listPrefs.projectsSortBy || 'name';
  const sortDir = listPrefs.projectsSortDir || 'asc';
  const dirMul = sortDir === 'desc' ? -1 : 1;
  all.sort((a, b) => {
    let r = 0;
    if (sortBy === 'tech') {
      const an = a.techs.map(t => t.name).join(', ');
      const bn = b.techs.map(t => t.name).join(', ');
      r = an.localeCompare(bn);
    } else {
      r = a.name.localeCompare(b.name);
    }
    return r * dirMul;
  });
  // Стрелка-индикатор активной сортировки
  const arrow = key => sortBy === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  // Header row — только Название и Исполнитель
  let html = '<div class="proj-head-row">';
  html += '<span class="proj-head-cell' + (sortBy === 'name' ? ' active' : '') + '" data-psort="name">Название' + arrow('name') + '</span>';
  html += '<span class="proj-head-cell' + (sortBy === 'tech' ? ' active' : '') + '" data-psort="tech">Исполнитель' + arrow('tech') + '</span>';
  html += '</div>';
  html += all.map(p => {
    const count = tasks.filter(t => t.project === p.name).length;
    const techsHtml = p.techs.map(t =>
      '<span class="proj-item-tech"><span class="avatar" style="width:18px;height:18px;font-size:9px;background:' + avatarColor(t.name) + '">' + initials(t.name) + '</span> ' + escapeHtml(t.name) + '</span>'
    ).join(', ');
    return '<div class="proj-item" data-proj="' + escapeHtml(p.name) + '">' +
      '<span class="proj-item-chip">' + projectChipHtml(p.name, {style:'font-size:13px;padding:3px 9px;'}) + '</span>' +
      '<span>' + techsHtml + '</span>' +
      '<span class="proj-item-count">' + count + ' задач</span>' +
      '<button class="btn-icon-mini" data-rename="' + escapeHtml(p.name) + '" title="Переименовать">✎</button>' +
      '<button class="btn btn-small btn-danger" data-del="' + escapeHtml(p.name) + '">×</button>' +
    '</div>';
  }).join('');
  list.innerHTML = html;

  // Sort header clicks
  list.querySelectorAll('[data-psort]').forEach(h => {
    h.addEventListener('click', () => {
      const key = h.dataset.psort;
      if (listPrefs.projectsSortBy === key) {
        listPrefs.projectsSortDir = listPrefs.projectsSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        listPrefs.projectsSortBy = key;
        listPrefs.projectsSortDir = 'asc';
      }
      saveListPrefs();
      renderProjectsModal();
    });
  });

  list.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', () => deleteProject(b.dataset.del));
  });
  list.querySelectorAll('[data-rename]').forEach(b => {
    b.addEventListener('click', () => startRenameProject(b.dataset.rename));
  });
}

// Inline rename UI
function startRenameProject(oldName) {
  const row = document.querySelector('.proj-item[data-proj="' + CSS.escape(oldName) + '"]');
  if (!row) return;
  const chipCell = row.querySelector('.proj-item-chip');
  if (!chipCell) return;
  // Заменяем плашку на инпут с двумя кнопками
  chipCell.innerHTML =
    '<input type="text" class="input proj-rename-input" value="' + escapeHtml(oldName) + '" style="height:28px;font-size:13px;max-width:200px;">' +
    '<button class="btn btn-small btn-primary proj-rename-save">✓</button>' +
    '<button class="btn btn-small proj-rename-cancel">×</button>';
  const inp = chipCell.querySelector('.proj-rename-input');
  inp.focus();
  inp.select();
  chipCell.querySelector('.proj-rename-cancel').addEventListener('click', renderProjectsModal);
  chipCell.querySelector('.proj-rename-save').addEventListener('click', () => commitRenameProject(oldName, inp.value.trim()));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitRenameProject(oldName, inp.value.trim());
    if (e.key === 'Escape') renderProjectsModal();
  });
}

async function commitRenameProject(oldName, newName) {
  if (!newName || newName === oldName) { renderProjectsModal(); return; }
  const existing = new Set();
  techs.forEach(t => (t.projects || []).forEach(p => existing.add(p)));
  tasks.forEach(t => { if (t.project) existing.add(t.project); });
  if (existing.has(newName)) {
    toast('Проект «' + newName + '» уже существует', true);
    return;
  }
  // СРАЗУ скрываем inline-input — показываем "обновляется..."
  const row = document.querySelector('.proj-item[data-proj="' + CSS.escape(oldName) + '"]');
  if (row) {
    const chipCell = row.querySelector('.proj-item-chip');
    if (chipCell) chipCell.innerHTML = '<span style="font-size:12px;color:#8b8b85;font-style:italic;">обновляется…</span>';
  }
  _renameInProgress = true;
  setSync('syncing');
  try {
    // 1) Обновляем справочники у всех затронутых технарей — параллельно
    const affectedTechs = techs.filter(t => (t.projects || []).includes(oldName));
    affectedTechs.forEach(t => { t.projects = t.projects.map(p => p === oldName ? newName : p); });
    saveTechs();
    const projResults = await Promise.allSettled(affectedTechs.map(tech =>
      apiPost(tech.url, { action: 'updateProjects', projects: tech.projects })
    ));
    const projFailed = projResults.filter(r => r.status !== 'fulfilled' || !r.value.ok).length;
    if (projFailed > 0) throw new Error('updateProjects: ' + projFailed + ' не удалось');

    // 2) Обновляем все задачи параллельно
    const affectedTasks = tasks.filter(t => t.project === oldName);
    affectedTasks.forEach(t => { t.project = newName; });
    const taskResults = await Promise.allSettled(affectedTasks.map(t => {
      const tech = getTech(t.techId);
      if (!tech) return Promise.resolve({ ok: false, error: 'no tech' });
      return apiPost(tech.url, { action: 'update', task: t });
    }));
    const taskFailed = taskResults.filter(r => r.status !== 'fulfilled' || !r.value.ok).length;
    // 3) Подчищаем все локальные ссылки на старое имя проекта
    if (listPrefs.pinnedProjects) {
      listPrefs.pinnedProjects = listPrefs.pinnedProjects.map(p => p === oldName ? newName : p);
    }
    if (listPrefs.groupOrder) {
      listPrefs.groupOrder = listPrefs.groupOrder.map(g => g === oldName ? newName : g);
    }
    saveListPrefs();
    if (customColors && customColors.projects && customColors.projects[oldName]) {
      customColors.projects[newName] = customColors.projects[oldName];
      delete customColors.projects[oldName];
      saveCustomColors();
      applyCustomColorStyles();
    }
    ['board','list'].forEach(v => {
      if (viewFilters[v] && Array.isArray(viewFilters[v].project)) {
        viewFilters[v].project = viewFilters[v].project.map(p => p === oldName ? newName : p);
      }
    });
    saveFilters();
    setSync('idle');
    toast('Переименовано: ' + (affectedTasks.length - taskFailed) + ' задач' + (taskFailed ? ', ошибок: ' + taskFailed : ''));
    renderProjectsModal();
    renderFilters && renderFilters('board');
    renderFilters && renderFilters('list');
    renderActive();
  } catch (err) {
    setSync('error');
    toast('Ошибка переименования: ' + err.message, true);
    renderProjectsModal();
  } finally {
    // Снимаем флаг через 3 сек — даём Sheets закоммитить updateProjects, чтобы следующий autorefresh уже видел чистое состояние
    setTimeout(() => { _renameInProgress = false; }, 3000);
  }
}

async function deleteProject(projectName) {
  const count = tasks.filter(t => t.project === projectName).length;
  const msg = count > 0
    ? 'Удалить проект «' + projectName + '»? Это также удалит ' + count + ' задач(у/и) во всех таблицах.'
    : 'Удалить проект «' + projectName + '»?';
  if (!confirm(msg)) return;

  setSync('syncing');
  const affectedTechs = techs.filter(t => t.projects.includes(projectName));
  try {
    for (const tech of affectedTechs) {
      // Удалить задачи по проекту
      if (count > 0) {
        const res = await apiPost(tech.url, { action: 'deleteByProject', project: projectName });
        if (!res.ok) throw new Error('delete tasks: ' + res.error);
      }
      // Обновить список проектов технаря
      tech.projects = tech.projects.filter(p => p !== projectName);
      await apiPost(tech.url, { action: 'updateProjects', projects: tech.projects });
    }
    saveTechs();
    tasks = tasks.filter(t => t.project !== projectName);
    setSync('idle');
    toast('Проект удалён');
    renderProjectsModal();
    renderTechFilters();
    renderActive();
  } catch (err) {
    setSync('error');
    toast('Ошибка удаления: ' + err.message, true);
  }
}

document.getElementById('addProject').addEventListener('click', async () => {
  const name = document.getElementById('newProjectName').value.trim();
  const techId = document.getElementById('newProjectTech').value;
  if (!name || !techId) { toast('Заполни название и выбери технаря', true); return; }
  const tech = getTech(techId);
  if (tech.projects.includes(name)) { toast('Проект уже есть у этого технаря', true); return; }
  tech.projects.push(name);
  saveTechs();
  setSync('syncing');
  try {
    await apiPost(tech.url, { action: 'updateProjects', projects: tech.projects });
    setSync('idle');
    document.getElementById('newProjectName').value = '';
    toast('Проект добавлен');
    renderProjectsModal();
  } catch (err) {
    setSync('error');
    toast('Ошибка: ' + err.message, true);
    tech.projects = tech.projects.filter(p => p !== name);
    saveTechs();
  }
});

// =================== SETTINGS ===================
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('active');
  renderTechSettings();
});
document.getElementById('closeSettings').addEventListener('click', () => document.getElementById('settingsModal').classList.remove('active'));

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'colors') renderColorSettings();
  });
});

// =================== COLOR SETTINGS UI ===================
function renderColorSettings() {
  const c = document.getElementById('tab-colors');
  if (!c) return;
  // Собираем все проекты: из техников + из существующих задач
  const projSet = new Set();
  techs.forEach(t => (t.projects || []).forEach(p => projSet.add(p)));
  tasks.forEach(t => { if (t.project) projSet.add(t.project); });
  const projList = Array.from(projSet).sort((a,b)=>a.localeCompare(b,'ru'));

  // Палитра пресетов в виде HTML
  const presetSwatchesHtml = COLOR_PRESETS.map(col =>
    '<span class="color-preset" data-color="' + col + '" style="background:' + col + '" title="' + col + '"></span>'
  ).join('');

  // Строка для приоритета
  const prioRow = (level) => {
    const col = priorityColor(level);
    const isCustom = !!customColors.priorities[level];
    return '<div class="color-row" data-kind="priority" data-key="' + escapeHtml(level) + '">' +
      '<span class="color-row-label">' +
        '<span class="task-prio-badge ' + ({Высокий:'h',Средний:'m',Низкий:'l'}[level]) + '">' + level + '</span>' +
      '</span>' +
      '<span class="color-row-controls">' +
        '<input type="color" class="color-picker" value="' + col + '">' +
        '<span class="color-hex">' + col + '</span>' +
        (isCustom ? '<button class="btn btn-sm color-reset">↺ сброс</button>' : '<span class="color-default-hint">по умолчанию</span>') +
      '</span>' +
    '</div>';
  };

  // Строка для проекта
  const projRow = (name) => {
    const col = projectColor(name);
    const isCustom = !!customColors.projects[name];
    return '<div class="color-row" data-kind="project" data-key="' + escapeHtml(name) + '">' +
      '<span class="color-row-label">' + projectChipHtml(name) + '</span>' +
      '<span class="color-row-controls">' +
        '<input type="color" class="color-picker" value="' + col + '">' +
        '<span class="color-hex">' + col + '</span>' +
        (isCustom ? '<button class="btn btn-sm color-reset">↺ сброс</button>' : '<span class="color-default-hint">авто</span>') +
      '</span>' +
    '</div>';
  };

  c.innerHTML =
    '<div class="modal-section">' +
      '<div class="modal-section-title">Палитра пресетов</div>' +
      '<div class="color-presets-row">' + presetSwatchesHtml + '</div>' +
      '<p style="font-size:12px;color:#8b8b85;margin:6px 0 0;">Клик по пресету подставит цвет в активную строку. Активная строка — последняя, на которую ты кликнул.</p>' +
    '</div>' +
    '<div class="modal-section">' +
      '<div class="modal-section-title">Приоритеты</div>' +
      ['Высокий','Средний','Низкий'].map(prioRow).join('') +
    '</div>' +
    '<div class="modal-section">' +
      '<div class="modal-section-title">Проекты' + (projList.length ? ' (' + projList.length + ')' : '') + '</div>' +
      (projList.length ? projList.map(projRow).join('') : '<div class="help-block">Проектов пока нет — добавь их в📁</div>') +
      '<div style="margin-top:10px;">' +
        '<button class="btn" id="colorsResetAll">↺ Сбросить ВСЕ цвета к авто</button>' +
      '</div>' +
    '</div>';

  attachColorSettingsHandlers();
}

let activeColorRow = null;
function attachColorSettingsHandlers() {
  const c = document.getElementById('tab-colors');
  if (!c) return;

  // Клик по строке — делаем её активной (для применения пресета)
  c.querySelectorAll('.color-row').forEach(row => {
    row.addEventListener('click', () => {
      c.querySelectorAll('.color-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      activeColorRow = row;
    });
  });

  // Color-picker меняет цвет немедленно
  c.querySelectorAll('.color-picker').forEach(inp => {
    inp.addEventListener('input', e => {
      const row = inp.closest('.color-row');
      const kind = row.dataset.kind;
      const key = row.dataset.key;
      const val = inp.value;
      if (kind === 'priority') customColors.priorities[key] = val;
      if (kind === 'project')  customColors.projects[key]   = val;
      saveCustomColors();
      applyCustomColorStyles();
      renderActive();          // перерисуем доску/список со свежими цветами
      // обновим саму строку (hex, кнопка сброса)
      const hexSpan = row.querySelector('.color-hex');
      if (hexSpan) hexSpan.textContent = val;
      const ctrls = row.querySelector('.color-row-controls');
      const oldReset = ctrls.querySelector('.color-reset, .color-default-hint');
      if (oldReset) {
        const newBtn = document.createElement('button');
        newBtn.className = 'btn btn-sm color-reset';
        newBtn.textContent = '↺ сброс';
        ctrls.replaceChild(newBtn, oldReset);
        newBtn.addEventListener('click', () => resetOneColor(row));
      }
      // обновим левую часть (плашка проекта)
      if (kind === 'project') {
        const label = row.querySelector('.color-row-label');
        if (label) label.innerHTML = projectChipHtml(key);
      }
    });
  });

  // Reset кнопки (только у уже кастомизированных)
  c.querySelectorAll('.color-reset').forEach(btn => {
    btn.addEventListener('click', () => resetOneColor(btn.closest('.color-row')));
  });

  // Клик по пресету — подставить в активную строку
  c.querySelectorAll('.color-preset').forEach(sw => {
    sw.addEventListener('click', () => {
      if (!activeColorRow) {
        toast('Выбери строку (приоритет или проект), потом кликни пресет', true);
        return;
      }
      const inp = activeColorRow.querySelector('.color-picker');
      if (inp) {
        inp.value = sw.dataset.color;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });

  // Сбросить всё
  const resetAll = c.querySelector('#colorsResetAll');
  if (resetAll) {
    resetAll.addEventListener('click', () => {
      if (!confirm('Сбросить все цвета (проекты и приоритеты) к значениям по умолчанию?')) return;
      customColors = { projects: {}, priorities: {} };
      saveCustomColors();
      applyCustomColorStyles();
      renderActive();
      renderColorSettings();
      toast('Цвета сброшены');
    });
  }
}

function resetOneColor(row) {
  if (!row) return;
  const kind = row.dataset.kind;
  const key = row.dataset.key;
  if (kind === 'priority') delete customColors.priorities[key];
  if (kind === 'project')  delete customColors.projects[key];
  saveCustomColors();
  applyCustomColorStyles();
  renderActive();
  renderColorSettings();
}

function renderTechSettings() {
  const c = document.getElementById('techList');
  if (techs.length === 0) {
    c.innerHTML = '<div class="help-block">Пока нет технарей. Добавь первого выше.</div>';
    return;
  }
  c.innerHTML = techs.map(t =>
    '<div class="tech-card" data-id="' + t.id + '">' +
      '<div class="tech-card-head">' +
        '<div class="avatar" style="background:' + avatarColor(t.name) + '">' + initials(t.name) + '</div>' +
        '<div class="tech-card-name">' + escapeHtml(t.name) + '</div>' +
        '<button class="btn btn-small" data-action="edit" data-id="' + t.id + '">✎</button>' +
        '<button class="btn btn-small btn-danger" data-action="del" data-id="' + t.id + '">×</button>' +
      '</div>' +
      '<div class="tech-card-url">' + escapeHtml(t.url) + '</div>' +
      '<div>' + t.projects.map(p => projectChipHtml(p)).join('') + '</div>' +
    '</div>'
  ).join('');
  c.querySelectorAll('[data-action="del"]').forEach(b => {
    b.addEventListener('click', () => {
      const t = getTech(b.dataset.id);
      if (!confirm('Убрать ' + t.name + '? Таблица не удалится, только привязка.')) return;
      techs = techs.filter(x => x.id !== b.dataset.id);
      saveTechs();
      renderTechSettings();
      renderTechFilters();
      reloadTasks();
    });
  });
  c.querySelectorAll('[data-action="edit"]').forEach(b => {
    b.addEventListener('click', () => {
      const t = getTech(b.dataset.id);
      const name = prompt('Имя:', t.name); if (name === null) return;
      const projs = prompt('Проекты через запятую:', t.projects.join(', ')); if (projs === null) return;
      const url = prompt('URL Apps Script:', t.url); if (url === null) return;
      t.name = name.trim() || t.name;
      t.projects = projs.split(',').map(p => p.trim()).filter(Boolean);
      t.url = url.trim() || t.url;
      saveTechs();
      renderTechSettings();
      renderTechFilters();
      apiPost(t.url, { action: 'updateProjects', projects: t.projects }).catch(() => {});
      reloadTasks();
    });
  });
}

async function testAndAddTech(name, url, statusEl) {
  if (!name || !url) { statusEl.innerHTML = '<span style="color:#c0392b;">Заполни имя и URL</span>'; return false; }
  statusEl.innerHTML = '<span style="color:#5f5e5a;">Проверяю соединение...</span>';
  try {
    const r = await apiGet(url);
    if (!r.ok) throw new Error(r.error || 'Не ответил ok');
    // Проекты берём прямо из таблицы — не надо вводить руками
    const projects = (r.projects && r.projects.length > 0) ? r.projects : [];
    const tech = { id: uid(), name, url, projects };
    techs.push(tech);
    saveTechs();
    const projInfo = projects.length > 0
      ? ' · ' + projects.length + ' проектов из таблицы'
      : ' · проектов пока нет';
    statusEl.innerHTML = '<span style="color:#5fa463;">✓ ' + escapeHtml(name) + ' добавлен (' + r.tasks.length + ' задач' + projInfo + ')</span>';
    return true;
  } catch (err) {
    statusEl.innerHTML = '<span style="color:#c0392b;">Ошибка: ' + escapeHtml(err.message) + '</span>';
    return false;
  }
}

document.getElementById('addTech').addEventListener('click', async () => {
  const name = document.getElementById('newTechName').value.trim();
  const url = document.getElementById('newTechUrl').value.trim();
  if (await testAndAddTech(name, url, document.getElementById('addTechStatus'))) {
    document.getElementById('newTechName').value = '';
    document.getElementById('newTechUrl').value = '';
    renderTechSettings();
    renderTechFilters();
    reloadTasks();
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => reloadTasks());
document.getElementById('newTaskBtn').addEventListener('click', () => openCreateTaskModal());

// =================== WEEKLY REPORT ===================
function generateWeeklyReport() {
  const now = new Date();
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);

  const fmtDate = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0');
  };

  // Двойная группировка: технарь → проект → { done, inWork }
  // Если технарь неизвестен, попадает в "Без технаря"
  const byTech = new Map();
  const ensureTech = key => {
    if (!byTech.has(key)) byTech.set(key, new Map());
    return byTech.get(key);
  };
  const ensureProj = (techMap, project) => {
    if (!techMap.has(project)) techMap.set(project, { done: [], inWork: [] });
    return techMap.get(project);
  };

  tasks.forEach(t => {
    const techName = t.techId ? (getTech(t.techId)?.name || 'Без технаря') : 'Без технаря';
    const proj = t.project || 'Без проекта';
    if (t.status === 'Выполнено' && t.completedAt) {
      const cd = new Date(t.completedAt);
      if (cd >= weekAgo && cd <= now) {
        const techMap = ensureTech(techName);
        ensureProj(techMap, proj).done.push(t);
      }
    } else if (t.status === 'В работе') {
      const techMap = ensureTech(techName);
      ensureProj(techMap, proj).inWork.push(t);
    }
  });

  // Отбрасываем технарей без задач
  const techNames = Array.from(byTech.keys())
    .filter(tn => {
      const tm = byTech.get(tn);
      return Array.from(tm.values()).some(g => g.done.length + g.inWork.length > 0);
    })
    .sort();

  if (techNames.length === 0) return 'За последнюю неделю задач не было.';

  const periodStr = fmtDate(weekAgo.toISOString().slice(0,10)) + ' — ' + fmtDate(today.toISOString().slice(0,10));
  let out = 'Отчёт за период ' + periodStr + '\n';
  out += '═══════════════════════════════\n\n';

  techNames.forEach((techName, ti) => {
    if (ti > 0) out += '\n────────────────────────────────\n\n';
    out += '━━━ По проектам ' + techName + ' ━━━\n\n';

    const techMap = byTech.get(techName);
    const projects = Array.from(techMap.keys())
      .filter(p => {
        const g = techMap.get(p);
        return g.done.length + g.inWork.length > 0;
      })
      .sort();

    projects.forEach((project, pi) => {
      if (pi > 0) out += '\n· · · · · · · · · · · · · · · · ·\n\n';
      const g = techMap.get(project);
      out += project + '\n';

      if (g.done.length > 0) {
        out += 'сделали:\n';
        g.done.sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
        g.done.forEach(t => { out += '— ' + t.title + '\n'; });
      }

      if (g.inWork.length > 0) {
        if (g.done.length > 0) out += '\n';
        out += 'по планам:\n';
        g.inWork.sort((a, b) => {
          const ao = a.deadline && new Date(a.deadline) < today ? 0 : 1;
          const bo = b.deadline && new Date(b.deadline) < today ? 0 : 1;
          if (ao !== bo) return ao - bo;
          if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
          if (a.deadline) return -1;
          if (b.deadline) return 1;
          return 0;
        });
        g.inWork.forEach(t => {
          let line = '— ' + t.title;
          if (t.deadline) {
            const isOverdue = new Date(t.deadline) < today;
            line += ' ' + fmtDate(t.deadline);
            if (isOverdue) line += ' (просрочка)';
          }
          out += line + '\n';
        });
      }
    });
  });

  return out.trim();
}

document.getElementById('reportBtn').addEventListener('click', () => {
  document.getElementById('reportText').value = generateWeeklyReport();
  document.getElementById('reportModal').classList.add('active');
});
document.getElementById('reportRefresh').addEventListener('click', () => {
  document.getElementById('reportText').value = generateWeeklyReport();
  toast('Отчёт обновлён');
});
document.getElementById('reportCopy').addEventListener('click', async () => {
  const text = document.getElementById('reportText').value;
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  catch (e) {
    // fallback
    const ta = document.getElementById('reportText');
    ta.select();
    document.execCommand('copy');
    toast('Скопировано');
  }
});
document.getElementById('reportDownload').addEventListener('click', () => {
  const text = document.getElementById('reportText').value;
  const d = new Date();
  const fname = 'отчёт_' + d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '.txt';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById('reportClose').addEventListener('click', () => {
  document.getElementById('reportModal').classList.remove('active');
});

// =================== LIST VIEW ===================
const COLLAPSED_KEY = 'kanban-list-collapsed-v1';
let collapsedGroups = [];
try { collapsedGroups = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch(e) {}

function saveCollapsed() { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedGroups)); }

// Формат даты для списка: "сегодня" / "завтра 16.05" / "через 3д 18.05" / "вчера 14.05" / "- 2 мес. 12.03"
function formatDeadlineList(iso) {
  if (!iso) return { text: '—', cls: 'none' };
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((d - today) / 86400000);
  const day = String(d.getDate()).padStart(2,'0');
  const mon = String(d.getMonth()+1).padStart(2,'0');
  const dateStr = day + '.' + mon;

  if (diff === 0) return { text: 'сегодня', cls: 'today' };
  if (diff === 1) return { text: 'завтра ' + dateStr, cls: 'future' };
  if (diff === -1) return { text: 'вчера ' + dateStr, cls: 'overdue' };
  if (diff > 1 && diff <= 7) return { text: 'через ' + diff + 'д ' + dateStr, cls: 'future' };
  if (diff < -1 && diff >= -30) return { text: '- ' + Math.abs(diff) + ' дн. ' + dateStr, cls: 'overdue' };
  if (diff < -30) {
    const months = Math.round(Math.abs(diff) / 30);
    return { text: '- ' + months + ' мес. ' + dateStr, cls: 'overdue' };
  }
  return { text: dateStr, cls: 'future' };
}

// Формат даты создания: 15.05 или 15.05.24 (если другой год)
function formatCreatedShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2,'0');
  const mon = String(d.getMonth()+1).padStart(2,'0');
  const yr = d.getFullYear();
  const curYr = new Date().getFullYear();
  if (yr === curYr) return day + '.' + mon;
  return day + '.' + mon + '.' + String(yr).slice(2);
}

// =================== BULK SELECTION ===================
let selectedTasks = new Set(); // ключ: "id|techId"

function selectionKey(task) { return task.id + '|' + task.techId; }

function clearSelection() {
  selectedTasks.clear();
  updateBulkBar();
  document.querySelectorAll('.list-row.selected').forEach(r => r.classList.remove('selected'));
  document.querySelectorAll('.list-row-checkbox').forEach(c => c.checked = false);
  document.querySelectorAll('.list-group-checkbox').forEach(c => { c.checked = false; c.indeterminate = false; });
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  if (!bar) return;
  if (selectedTasks.size === 0) {
    bar.classList.remove('active');
  } else {
    bar.classList.add('active');
    document.getElementById('bulkCount').textContent = selectedTasks.size;
  }
}

function getSelectedTaskObjects() {
  const result = [];
  selectedTasks.forEach(key => {
    const [id, techId] = key.split('|');
    const t = tasks.find(x => String(x.id) === String(id) && x.techId === techId);
    if (t) result.push(t);
  });
  return result;
}

async function bulkUpdateStatus(newStatus) {
  const sel = getSelectedTaskObjects();
  if (sel.length === 0) return;
  setSync('syncing');
  let errors = 0;
  for (const task of sel) {
    try {
      applyStatusChange(task, newStatus);
      const tech = getTech(task.techId);
      const res = await apiPost(tech.url, { action: 'update', task });
      if (!res.ok) throw new Error(res.error);
    } catch (err) { errors++; console.error(err); }
  }
  setSync(errors ? 'error' : 'idle');
  toast(errors ? 'Ошибка для ' + errors + ' задач' : 'Готово: ' + sel.length + ' задач', !!errors);
  clearSelection();
  renderActive();
}

async function bulkDelete() {
  const sel = getSelectedTaskObjects();
  if (sel.length === 0) return;
  if (!confirm('Удалить ' + sel.length + ' задач? Это нельзя отменить.')) return;
  setSync('syncing');
  let errors = 0;
  for (const task of sel) {
    try {
      const tech = getTech(task.techId);
      const res = await apiPost(tech.url, { action: 'delete', id: task.id });
      if (!res.ok) throw new Error(res.error);
      tasks = tasks.filter(t => !(String(t.id) === String(task.id) && t.techId === task.techId));
    } catch (err) { errors++; console.error(err); }
  }
  setSync(errors ? 'error' : 'idle');
  toast(errors ? 'Ошибка для ' + errors + ' задач' : 'Удалено: ' + sel.length, !!errors);
  clearSelection();
  renderActive();
}

async function bulkUpdatePriority(priority) {
  const sel = getSelectedTaskObjects();
  if (sel.length === 0) return;
  setSync('syncing');
  let errors = 0;
  for (const task of sel) {
    task.priority = priority;
    try {
      const tech = getTech(task.techId);
      const res = await apiPost(tech.url, { action: 'update', task });
      if (!res.ok) throw new Error(res.error);
    } catch (err) { errors++; console.error(err); }
  }
  setSync(errors ? 'error' : 'idle');
  toast(errors ? 'Ошибка для ' + errors + ' задач' : 'Приоритет обновлён: ' + sel.length, !!errors);
  clearSelection();
  renderActive();
}

async function bulkSetDeadline(isoDate) {
  const sel = getSelectedTaskObjects();
  if (sel.length === 0) return;
  setSync('syncing');
  let errors = 0;
  for (const task of sel) {
    task.deadline = isoDate;
    try {
      const tech = getTech(task.techId);
      const res = await apiPost(tech.url, { action: 'update', task });
      if (!res.ok) throw new Error(res.error);
    } catch (err) { errors++; console.error(err); }
  }
  setSync(errors ? 'error' : 'idle');
  toast(errors ? 'Ошибка для ' + errors + ' задач' : 'Дедлайн обновлён: ' + sel.length, !!errors);
  clearSelection();
  renderActive();
}

async function bulkShiftDeadline(days) {
  const sel = getSelectedTaskObjects();
  if (sel.length === 0) return;
  setSync('syncing');
  let errors = 0;
  let shifted = 0;
  for (const task of sel) {
    try {
      // База: текущий дедлайн или сегодня если нет
      const base = task.deadline ? new Date(task.deadline) : (() => { const t = new Date(); t.setHours(0,0,0,0); return t; })();
      base.setDate(base.getDate() + days);
      task.deadline = toIsoDate(base);
      const tech = getTech(task.techId);
      const res = await apiPost(tech.url, { action: 'update', task });
      if (!res.ok) throw new Error(res.error);
      shifted++;
    } catch (err) { errors++; console.error(err); }
  }
  setSync(errors ? 'error' : 'idle');
  toast(errors ? 'Ошибка для ' + errors + ' задач' : 'Перенесено: ' + shifted, !!errors);
  clearSelection();
  renderActive();
}

// =================== LIST RENDER ===================
function renderList() {
  const container = document.getElementById('viewListBody');
  const sf = listPrefs.statusFilter || {};
  const filtered = tasks.filter(t => taskMatchesFilters(t) && sf[t.status || 'В работе'] !== false);

  // Группировка
  const groups = new Map();
  const groupBy = listPrefs.groupBy || 'project';
  filtered.forEach(task => {
    let key;
    if (groupBy === 'tech') {
      const t = getTech(task.techId);
      key = t ? '__tech__' + t.id : '__nogroup__';
    } else if (groupBy === 'none') {
      key = '__all__';
    } else {
      key = task.project || '__noproject__';
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  });

  // Controls: группировка + чекбоксы видимости статусов
  const stChk = (status, label) => {
    const on = sf[status] !== false;
    return '<label class="list-status-check' + (on ? '' : ' off') + '"><input type="checkbox" data-status-filter="' + status + '"' + (on ? ' checked' : '') + '>' + label + '</label>';
  };

  let html = '<div class="list-view">';
  html += '<div class="list-controls">' +
    '<div class="list-controls-group">' +
      '<span>Группировать:</span>' +
      '<select id="lst_groupBy">' +
        '<option value="project"' + (groupBy === 'project' ? ' selected' : '') + '>По проекту</option>' +
        '<option value="tech"' + (groupBy === 'tech' ? ' selected' : '') + '>По технарю</option>' +
        '<option value="none"' + (groupBy === 'none' ? ' selected' : '') + '>Без группировки</option>' +
      '</select>' +
    '</div>' +
    '<div class="list-controls-group">' +
      '<span>Показывать:</span>' +
      stChk('В работе', 'В работе') +
      stChk('Выполнено', 'Выполнено') +
      stChk('Отменена', 'Отменено') +
    '</div>' +
  '</div>';

  if (groups.size === 0) {
    html += '<div class="help-block" style="margin-top:14px;">Нет задач (или их скрыли фильтры)</div></div>';
    container.innerHTML = html;
    attachListControls();
    return;
  }

  const pinned = listPrefs.pinnedProjects || [];
  const groupOrder = listPrefs.groupOrder || [];
  const freeSort = listPrefs.freeSort;
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (freeSort) {
      const ia = groupOrder.indexOf(a);
      const ib = groupOrder.indexOf(b);
      const va = ia === -1 ? 99999 : ia;
      const vb = ib === -1 ? 99999 : ib;
      if (va !== vb) return va - vb;
    } else {
      if (groupBy === 'project') {
        const aPin = pinned.includes(a) ? 0 : 1;
        const bPin = pinned.includes(b) ? 0 : 1;
        if (aPin !== bPin) return aPin - bPin;
        if (aPin === 0) {
          return pinned.indexOf(a) - pinned.indexOf(b);
        }
      }
    }
    if (a === '__noproject__' || a === '__nogroup__') return 1;
    if (b === '__noproject__' || b === '__nogroup__') return -1;
    if (a === '__all__') return 0;
    if (groupBy === 'tech') {
      const ta = getTech(a.replace('__tech__', ''));
      const tb = getTech(b.replace('__tech__', ''));
      return (ta?.name || '').localeCompare(tb?.name || '');
    }
    return a.localeCompare(b);
  });

  // Bulk bar (v1.2.0)
  html += '<div class="bulk-bar" id="bulkBar">' +
    '<span class="bulk-bar-count"><span id="bulkCount">0</span> выделено</span>' +
    '<span class="bulk-btn-group">' +
      '<span class="bulk-label">Статус:</span>' +
      '<button class="bulk-btn" data-bulk-status="В работе" title="В работу">▶</button>' +
      '<button class="bulk-btn" data-bulk-status="Выполнено" title="Выполнено">✓</button>' +
      '<button class="bulk-btn" data-bulk-status="Отменена" title="Отменить">✗</button>' +
    '</span>' +
    '<span class="bulk-btn-group">' +
      '<span class="bulk-label">Приоритет:</span>' +
      '<button class="bulk-btn" data-bulk-prio="Высокий" title="Высокий">!!!</button>' +
      '<button class="bulk-btn" data-bulk-prio="Средний" title="Средний">!!</button>' +
      '<button class="bulk-btn" data-bulk-prio="Низкий" title="Низкий">!</button>' +
      '<button class="bulk-btn" data-bulk-prio="" title="Снять приоритет">—</button>' +
    '</span>' +
    '<span class="bulk-btn-group">' +
      '<span class="bulk-label">Дедлайн:</span>' +
      '<input type="date" class="bulk-date" id="bulkDateInput">' +
      '<button class="bulk-btn" data-bulk-deadline-apply>OK</button>' +
    '</span>' +
    '<span class="bulk-btn-group">' +
      '<span class="bulk-label">+</span>' +
      '<button class="bulk-btn" data-shift="1">1д</button>' +
      '<button class="bulk-btn" data-shift="3">3д</button>' +
      '<button class="bulk-btn" data-shift="7">нед</button>' +
      '<button class="bulk-btn" data-shift="30">мес</button>' +
    '</span>' +
    '<div class="bulk-bar-spacer"></div>' +
    '<button class="bulk-btn danger" data-bulk="delete" title="Удалить">🗑</button>' +
    '<button class="bulk-btn" data-bulk="clear">Снять</button>' +
  '</div>';

  // Toolbar
  html += '<div class="list-toolbar">' +
    '<span>' + filtered.length + ' задач в ' + sortedKeys.length + ' групп.</span>' +
    '<button id="expandAllBtn">развернуть все</button>' +
    '<button id="collapseAllBtn">свернуть все</button>' +
  '</div>';

  // Compараторы для каждой колонки
  const sortBy = listPrefs.sortBy || 'deadline';
  const sortDir = listPrefs.sortDir || 'asc';
  const dirMul = sortDir === 'desc' ? -1 : 1;
  const taskOrder = listPrefs.taskOrder || [];
  const taskOrderIdx = (t) => {
    const k = t.id + '|' + t.techId;
    const i = taskOrder.indexOf(k);
    return i === -1 ? 99999 : i;
  };
  const cmp = (a, b) => {
    if (freeSort) return taskOrderIdx(a) - taskOrderIdx(b);
    let r = 0;
    if (sortBy === 'title') {
      r = (a.title || '').localeCompare(b.title || '');
    } else if (sortBy === 'priority') {
      const pr = { 'Высокий': 0, 'Средний': 1, 'Низкий': 2 };
      r = (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3);
    } else if (sortBy === 'status') {
      const so = { 'В работе': 0, 'Выполнено': 1, 'Отменена': 2 };
      r = (so[a.status] ?? 3) - (so[b.status] ?? 3);
    } else if (sortBy === 'created') {
      r = (a.createdAt || '').localeCompare(b.createdAt || '');
    } else if (sortBy === 'tech') {
      const ta = getTech(a.techId)?.name || '';
      const tb = getTech(b.techId)?.name || '';
      r = ta.localeCompare(tb);
    } else if (sortBy === 'project') {
      r = (a.project || '').localeCompare(b.project || '');
    } else {
      // deadline по умолчанию: пустые в конце
      if (a.deadline && b.deadline) r = a.deadline.localeCompare(b.deadline);
      else if (a.deadline) r = -1;
      else if (b.deadline) r = 1;
    }
    return r * dirMul;
  };

  // Кликабельный заголовок таблицы (общий)
  function arrow(col) {
    if (sortBy !== col) return '<span class="sort-arrow">↕</span>';
    return '<span class="sort-arrow">' + (sortDir === 'asc' ? '↑' : '↓') + '</span>';
  }
  function activeCls(col) { return sortBy === col ? ' active' : ''; }

  const headerRow = '<div class="list-head-row">' +
    '<span></span>' +
    '<span class="list-head-cell' + activeCls('title') + '" data-sort="title">Название ' + arrow('title') + '</span>' +
    '<span class="list-head-cell' + activeCls('created') + '" data-sort="created">Создана ' + arrow('created') + '</span>' +
    '<span class="list-head-cell' + activeCls('deadline') + '" data-sort="deadline">Дедлайн ' + arrow('deadline') + '</span>' +
    '<span class="list-head-cell' + activeCls('priority') + '" data-sort="priority">Приоритет ' + arrow('priority') + '</span>' +
    '<span class="list-head-cell' + activeCls('tech') + '" data-sort="tech">Исполнитель ' + arrow('tech') + '</span>' +
    '<span class="list-head-cell' + activeCls('status') + '" data-sort="status">Статус ' + arrow('status') + '</span>' +
    '<span class="list-head-cell' + activeCls('project') + '" data-sort="project">Проект ' + arrow('project') + '</span>' +
  '</div>';

  html += '<div class="list-head-wrap">' + headerRow + '</div>';

  sortedKeys.forEach(key => {
    const taskList = groups.get(key);
    taskList.sort(cmp);

    const isCollapsed = collapsedGroups.includes(key);
    const isNoProject = key === '__noproject__';
    const isNoGroup = key === '__nogroup__';
    const isAll = key === '__all__';

    let groupLabel, groupExtra = '';
    if (isAll) {
      groupLabel = '<span class="list-group-name">Все задачи</span>';
    } else if (isNoProject) {
      groupLabel = '<span class="list-group-name no-project">Без проекта</span>';
    } else if (isNoGroup) {
      groupLabel = '<span class="list-group-name no-project">Без технаря</span>';
    } else if (groupBy === 'tech') {
      const techId = key.replace('__tech__', '');
      const t = getTech(techId);
      if (t) {
        groupLabel = '<span class="list-group-name" style="color:#1a1a19;">' +
          '<span class="avatar" style="display:inline-flex; vertical-align:middle; margin-right:6px; width:22px; height:22px; font-size:10px; background:' + avatarColor(t.name) + '">' + initials(t.name) + '</span>' +
          escapeHtml(t.name) +
          '</span>';
      } else {
        groupLabel = '<span class="list-group-name">' + escapeHtml(techId) + '</span>';
      }
    } else {
      groupLabel = projectChipHtml(key, {style:'font-size:14px;padding:3px 10px;font-weight:600;'});
      const tech = findTechByProject(key);
      if (tech) {
        groupExtra = '<span class="list-group-tech"><span class="avatar" style="width:18px;height:18px;font-size:9px;background:' + avatarColor(tech.name) + '">' + initials(tech.name) + '</span> ' + escapeHtml(tech.name) + '</span>';
      }
    }

    const groupSelected = taskList.filter(t => selectedTasks.has(selectionKey(t))).length;
    const allSelected = groupSelected === taskList.length && taskList.length > 0;

    const isPinnable = groupBy === 'project' && !isNoProject && !isAll && !isNoGroup;
    const isPinned = isPinnable && pinned.includes(key);
    const gCls = ['list-group'];
    if (isCollapsed) gCls.push('collapsed');
    if (isPinned) gCls.push('pinned');
    if (freeSort) gCls.push('free-sort');

    html += '<div class="' + gCls.join(' ') + '" data-key="' + escapeHtml(key) + '">';
    html += '<div class="list-group-header"' + (freeSort ? ' draggable="true" data-group-key="' + escapeHtml(key) + '"' : '') + '>';
    if (freeSort) html += '<span class="list-group-drag-handle" title="Тащи за заголовок группы">⋮⋮</span>';
    html += '<input type="checkbox" class="list-group-checkbox"' +
      (allSelected ? ' checked' : '') + ' data-group-key="' + escapeHtml(key) + '">';
    html += '<div class="gh-name-cell">';
    html += '<span class="list-group-toggle">▼</span>';
    html += groupLabel;
    html += '</div>';
    html += '<div class="gh-tech-cell">' + groupExtra + '</div>';
    html += '<div class="gh-count-cell"><span class="list-group-count">' + taskList.length + '</span></div>';
    html += '<div class="gh-pin-cell">';
    if (isPinnable) {
      html += '<button class="list-group-pin' + (isPinned ? ' active' : '') + '" data-pin-key="' + escapeHtml(key) + '" title="' + (isPinned ? 'Открепить' : 'Закрепить вверху') + '">📌</button>';
    }
    html += '</div>';
    html += '</div>';

    html += '<div class="list-group-body">';

    taskList.forEach(task => {
      const taskTech = getTech(task.techId);
      const completedClass = task.status === 'Выполнено' || task.status === 'Отменена' ? 'completed' : '';
      const overdueClass = isOverdueTask(task) ? 'is-overdue' : '';
      const statusClsMap = { 'В работе': 'work', 'Выполнено': 'done', 'Отменена': 'cancel' };
      const statusCls = statusClsMap[task.status] || 'work';
      const dl = formatDeadlineList(task.deadline);
      const prioPillCls = { 'Высокий': 'h', 'Средний': 'm', 'Низкий': 'l' };
      const prioCell = task.priority
        ? '<span class="list-prio-mini ' + prioPillCls[task.priority] + '">' + escapeHtml(task.priority) + '</span>'
        : '<span style="color:#b4b2a9">—</span>';
      const sk = selectionKey(task);
      const isSelected = selectedTasks.has(sk);

      html += '<div class="list-row ' + completedClass + ' ' + overdueClass + (isSelected ? ' selected' : '') + (freeSort ? ' free-sort' : '') + '" data-id="' + task.id + '" data-tech="' + task.techId + '" data-key="' + sk + '"' + (freeSort ? ' draggable="true"' : '') + '>';
      html += '<input type="checkbox" class="list-row-checkbox cell-check"' + (isSelected ? ' checked' : '') + '>';
      html += '<span class="list-task cell-title">' + escapeHtml(task.title) +
        (task.note ? ' <span class="task-tag note-marker" title="' + escapeHtml(task.note) + '">📝</span>' : '') +
        '</span>';
      html += '<span class="list-cell-created cell-created">' + formatCreatedShort(task.createdAt) + '</span>';
      html += '<span class="cell-deadline"><span class="list-deadline-pill ' + dl.cls + '">' + dl.text + '</span></span>';
      html += '<span class="cell-prio">' + prioCell + '</span>';
      html += '<span class="list-cell-tech cell-tech">' + (taskTech
        ? '<span class="avatar" style="background:' + avatarColor(taskTech.name) + '">' + initials(taskTech.name) + '</span> ' + escapeHtml(taskTech.name)
        : '<span style="color:#b4b2a9">—</span>'
      ) + '</span>';
      html += '<span class="cell-status"><span class="list-cell-status ' + statusCls + '">' + escapeHtml(task.status || 'В работе') + '</span></span>';
      html += '<span class="list-cell-project cell-project">' + (task.project
        ? projectChipHtml(task.project)
        : '<span style="color:#b4b2a9">—</span>'
      ) + '</span>';
      html += '</div>';
    });

    html += '</div></div>';
  });

  html += '</div>';
  container.innerHTML = html;
  attachListControls();
  attachListHandlers(groups);
  updateBulkBar();
}

function attachListControls() {
  const gby = document.getElementById('lst_groupBy');
  if (gby) gby.addEventListener('change', e => { listPrefs.groupBy = e.target.value; saveListPrefs(); renderList(); });

  // Чекбокс свободной сортировки
  const fsChk = document.getElementById('lst_freeSort');
  if (fsChk) fsChk.addEventListener('change', e => {
    listPrefs.freeSort = e.target.checked;
    saveListPrefs();
    renderList();
  });

  // Чекбоксы видимости статусов
  document.querySelectorAll('[data-status-filter]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (!listPrefs.statusFilter) listPrefs.statusFilter = {};
      listPrefs.statusFilter[cb.dataset.statusFilter] = cb.checked;
      saveListPrefs();
      renderList();
    });
  });

  // Клик по заголовку колонки — сортировка (отключена при свободной сортировке)
  document.querySelectorAll('.list-head-cell[data-sort]').forEach(h => {
    h.addEventListener('click', () => {
      if (listPrefs.freeSort) {
        toast('Сортировка по колонке недоступна при свободной сортировке', false);
        return;
      }
      const col = h.dataset.sort;
      if (listPrefs.sortBy === col) {
        listPrefs.sortDir = listPrefs.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        listPrefs.sortBy = col;
        listPrefs.sortDir = 'asc';
      }
      saveListPrefs();
      renderList();
    });
  });
}

function attachListHandlers(groups) {
  const container = document.getElementById('viewListBody');

  container.querySelectorAll('.list-group-header').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.classList.contains('list-group-checkbox')) return;
      const group = h.parentElement;
      const key = group.dataset.key;
      if (group.classList.contains('collapsed')) {
        collapsedGroups = collapsedGroups.filter(k => k !== key);
        group.classList.remove('collapsed');
      } else {
        if (!collapsedGroups.includes(key)) collapsedGroups.push(key);
        group.classList.add('collapsed');
      }
      saveCollapsed();
    });
  });

  container.querySelectorAll('.list-group-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const key = cb.dataset.groupKey;
      const taskList = groups.get(key);
      if (cb.checked) taskList.forEach(t => selectedTasks.add(selectionKey(t)));
      else taskList.forEach(t => selectedTasks.delete(selectionKey(t)));
      renderList();
    });
  });

  container.querySelectorAll('.list-task').forEach(t => {
    t.addEventListener('click', () => {
      const row = t.closest('.list-row');
      openTaskModal(row.dataset.id, row.dataset.tech);
    });
  });

  container.querySelectorAll('.list-row-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const row = cb.closest('.list-row');
      const sk = row.dataset.key;
      if (cb.checked) selectedTasks.add(sk);
      else selectedTasks.delete(sk);
      row.classList.toggle('selected', cb.checked);
      updateBulkBar();
      const group = row.closest('.list-group');
      const gKey = group.dataset.key;
      const gCb = group.querySelector('.list-group-checkbox');
      const tList = groups.get(gKey);
      const selectedInGroup = tList.filter(t => selectedTasks.has(selectionKey(t))).length;
      gCb.checked = selectedInGroup === tList.length;
      gCb.indeterminate = selectedInGroup > 0 && selectedInGroup < tList.length;
    });
  });

  container.querySelectorAll('[data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.bulk;
      if (action === 'delete') bulkDelete();
      else if (action === 'clear') clearSelection();
    });
  });
  container.querySelectorAll('[data-bulk-status]').forEach(btn => {
    btn.addEventListener('click', () => bulkUpdateStatus(btn.dataset.bulkStatus));
  });
  container.querySelectorAll('[data-bulk-prio]').forEach(btn => {
    btn.addEventListener('click', () => bulkUpdatePriority(btn.dataset.bulkPrio));
  });
  const dateApplyBtn = container.querySelector('[data-bulk-deadline-apply]');
  if (dateApplyBtn) {
    dateApplyBtn.addEventListener('click', () => {
      const input = document.getElementById('bulkDateInput');
      if (input && input.value) bulkSetDeadline(input.value);
      else toast('Выберите дату', false);
    });
  }
  container.querySelectorAll('[data-shift]').forEach(btn => {
    btn.addEventListener('click', () => bulkShiftDeadline(parseInt(btn.dataset.shift, 10)));
  });

  const expandBtn = document.getElementById('expandAllBtn');
  if (expandBtn) expandBtn.addEventListener('click', () => {
    collapsedGroups = [];
    saveCollapsed();
    renderList();
  });
  const collapseBtn = document.getElementById('collapseAllBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => {
    collapsedGroups = Array.from(groups.keys());
    saveCollapsed();
    renderList();
  });

  // Закрепление проектов
  container.querySelectorAll('.list-group-pin').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.pinKey;
      if (!listPrefs.pinnedProjects) listPrefs.pinnedProjects = [];
      const i = listPrefs.pinnedProjects.indexOf(key);
      if (i >= 0) listPrefs.pinnedProjects.splice(i, 1);
      else listPrefs.pinnedProjects.push(key);
      saveListPrefs();
      renderList();
    });
  });

  // Drag&drop при свободной сортировке
  if (listPrefs.freeSort) initListFreeSortDrag(container);
}

// Drag&drop для свободной сортировки в списке
function initListFreeSortDrag(container) {
  let draggedRow = null;
  let draggedGroup = null;

  container.querySelectorAll('.list-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      if (e.target.tagName === 'INPUT') { e.preventDefault(); return; }
      draggedRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', row.dataset.key); } catch(_) {}
      e.stopPropagation();
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); draggedRow = null; });
    row.addEventListener('dragover', e => {
      if (!draggedRow || draggedRow === row) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      // Если drop не от строки (тащим группу) — не перехватываем, чтобы drop группы сработал
      if (!draggedRow || draggedRow === row) {
        row.classList.remove('drag-over');
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      reorderTaskInOrder(draggedRow.dataset.key, row.dataset.key, after);
    });
  });

  // Drag за заголовок группы — header сам draggable (избегаем конфликт с draggable у строк)
  container.querySelectorAll('.list-group-header[draggable="true"]').forEach(header => {
    const group = header.closest('.list-group');
    if (!group) return;
    header.addEventListener('dragstart', e => {
      if (e.target.closest('.list-group-pin') || e.target.tagName === 'INPUT') {
        e.preventDefault();
        return;
      }
      draggedGroup = group;
      group.classList.add('dragging-group');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'group:' + header.dataset.groupKey); } catch(_) {}
      e.stopPropagation();
    });
    header.addEventListener('dragend', () => { group.classList.remove('dragging-group'); draggedGroup = null; });
  });
  container.querySelectorAll('.list-group.free-sort').forEach(group => {
    group.addEventListener('dragover', e => {
      if (!draggedGroup || draggedGroup === group) return;
      if (draggedRow) return;
      e.preventDefault();
      group.classList.add('drag-over-group');
    });
    group.addEventListener('dragleave', () => group.classList.remove('drag-over-group'));
    group.addEventListener('drop', e => {
      group.classList.remove('drag-over-group');
      if (!draggedGroup || draggedGroup === group) return;
      if (draggedRow) return;
      e.preventDefault();
      const rect = group.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      reorderGroupInOrder(draggedGroup.dataset.key, group.dataset.key, after);
    });
  });
}

function reorderTaskInOrder(srcKey, dstKey, after) {
  const allKeys = tasks.map(t => t.id + '|' + t.techId);
  let order = (listPrefs.taskOrder || []).slice();
  allKeys.forEach(k => { if (!order.includes(k)) order.push(k); });
  order = order.filter(k => k !== srcKey);
  let di = order.indexOf(dstKey);
  if (di < 0) di = order.length;
  if (after) di += 1;
  order.splice(di, 0, srcKey);
  listPrefs.taskOrder = order;
  saveListPrefs();
  renderActive();
}

function reorderGroupInOrder(srcKey, dstKey, after) {
  const allKeys = Array.from(document.querySelectorAll('.list-group[data-key]')).map(g => g.dataset.key);
  let order = (listPrefs.groupOrder || []).slice();
  allKeys.forEach(k => { if (!order.includes(k)) order.push(k); });
  order = order.filter(k => k !== srcKey);
  let di = order.indexOf(dstKey);
  if (di < 0) di = order.length;
  if (after) di += 1;
  order.splice(di, 0, srcKey);
  listPrefs.groupOrder = order;
  saveListPrefs();
  renderList();
}

// =================== STATS ===================
function renderStats() {
  const container = document.getElementById('viewStats');
  const total = tasks.length;
  const inWork = tasks.filter(t => t.status === 'В работе').length;
  const done = tasks.filter(t => t.status === 'Выполнено').length;
  const cancelled = tasks.filter(t => t.status === 'Отменена').length;
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const overdue = tasks.filter(t =>
    t.deadline && t.status === 'В работе' &&
    new Date(t.deadline) < today0
  ).length;

  let html = '<div class="stat-cards">' +
    statCard('Всего задач', total) +
    statCard('В работе', inWork, 'warn') +
    statCard('Выполнено', done, 'success') +
    statCard('Отменено', cancelled) +
    statCard('Просрочено', overdue, 'danger') +
  '</div>';

  // По технарям
  html += '<div class="stat-block"><h3>По технарям</h3>';
  if (techs.length === 0) {
    html += '<div class="help-block">Технари не настроены</div>';
  } else {
    html += techs.map(tech => {
      const my = tasks.filter(t => t.techId === tech.id);
      const w = my.filter(t => t.status === 'В работе').length;
      const d = my.filter(t => t.status === 'Выполнено').length;
      const c = my.filter(t => t.status === 'Отменена').length;
      const tot = my.length || 1;
      return '<div class="stat-row">' +
        '<span class="stat-row-name">' +
          '<span class="avatar" style="background:' + avatarColor(tech.name) + '">' + initials(tech.name) + '</span>' +
          escapeHtml(tech.name) +
        '</span>' +
        '<span style="font-size:11px; color:#8b8b85;">в работе: ' + w + ' · готово: ' + d + ' · отмена: ' + c + '</span>' +
        '<span class="stat-row-bar" title="' + w + ' в работе, ' + d + ' выполнено, ' + c + ' отменено">' +
          '<span class="stat-bar-seg work" style="width:' + (w/tot*100) + '%"></span>' +
          '<span class="stat-bar-seg done" style="width:' + (d/tot*100) + '%"></span>' +
          '<span class="stat-bar-seg cancel" style="width:' + (c/tot*100) + '%"></span>' +
        '</span>' +
        '<span class="stat-row-num">' + my.length + '</span>' +
      '</div>';
    }).join('');
  }
  html += '</div>';

  // По проектам и приоритетам
  html += '<div class="stat-grid">';

  // По проектам
  html += '<div class="stat-block"><h3>По проектам</h3>';
  const allProjects = getAllProjectsWithTechs();
  const projStats = allProjects.map(p => {
    const my = tasks.filter(t => t.project === p.name);
    const d = my.filter(t => t.status === 'Выполнено').length;
    return { name: p.name, total: my.length, done: d, pct: my.length ? Math.round(d/my.length*100) : 0 };
  }).filter(p => p.total > 0).sort((a, b) => b.total - a.total);

  if (projStats.length === 0) {
    html += '<div class="help-block">Нет задач по проектам</div>';
  } else {
    html += projStats.map(p =>
      '<div class="stat-row">' +
        '<span class="stat-row-name">' + projectChipHtml(p.name) + '</span>' +
        '<span class="stat-row-pct">' + p.pct + '%</span>' +
        '<span class="stat-row-num">' + p.total + '</span>' +
      '</div>'
    ).join('');
  }
  html += '</div>';

  // По приоритетам
  html += '<div class="stat-block"><h3>По приоритетам</h3>';
  const prios = [
    { key: 'Высокий', cls: 'prio-h', color: '#c0392b' },
    { key: 'Средний', cls: 'prio-m', color: '#d97757' },
    { key: 'Низкий', cls: 'prio-l', color: '#5fa463' },
    { key: '', cls: '', color: '#b4b2a9', label: 'Без приоритета' }
  ];
  const inWorkTasks = tasks.filter(t => t.status === 'В работе');
  html += prios.map(p => {
    const c = inWorkTasks.filter(t => (t.priority || '') === p.key).length;
    return '<div class="stat-row">' +
      '<span class="stat-row-name"><span style="width:8px; height:8px; border-radius:50%; background:' + p.color + '; display:inline-block;"></span> ' + escapeHtml(p.label || p.key) + '</span>' +
      '<span class="stat-row-num">' + c + '</span>' +
    '</div>';
  }).join('');
  html += '<div style="font-size:11px; color:#8b8b85; margin-top:6px;">только задачи «В работе»</div>';
  html += '</div>';

  html += '</div>'; // grid

  container.innerHTML = html;
}

function statCard(label, val, mod) {
  return '<div class="stat-card ' + (mod || '') + '">' +
    '<div class="stat-card-label">' + escapeHtml(label) + '</div>' +
    '<div class="stat-card-value">' + val + '</div>' +
  '</div>';
}

// =================== VIEW SWITCH ===================
document.querySelectorAll('.view-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    document.getElementById('viewBoard').style.display = currentView === 'board' ? '' : 'none';
    document.getElementById('viewList').style.display = currentView === 'list' ? '' : 'none';
    document.getElementById('viewStats').style.display = currentView === 'stats' ? '' : 'none';
    if (currentView === 'stats') renderStats();
    if (currentView === 'list') renderList();
  });
});

// =================== KEYBOARD / GLOBAL ===================
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.active').forEach(m => m.classList.remove('active'));
    document.getElementById('autocomplete').classList.remove('active');
  }
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    quickAdd.focus();
  }
});

document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('active'); });
});

// =================== ONBOARDING ===================
document.getElementById('onbAdd').addEventListener('click', async () => {
  const name = document.getElementById('onbName').value.trim();
  const url = document.getElementById('onbUrl').value.trim();
  const status = document.getElementById('onbStatus');
  if (await testAndAddTech(name, url, status)) {
    document.getElementById('onbName').value = '';
    document.getElementById('onbUrl').value = '';
    renderOnbList();
  }
});

function renderOnbList() {
  const c = document.getElementById('onbList');
  if (techs.length === 0) { c.innerHTML = ''; return; }
  c.innerHTML = '<div class="modal-section-title">Добавлены:</div>' + techs.map(t =>
    '<div class="tech-card" style="margin-bottom:6px;">' +
      '<div class="tech-card-head">' +
        '<div class="avatar" style="background:' + avatarColor(t.name) + '">' + initials(t.name) + '</div>' +
        '<div class="tech-card-name">' + escapeHtml(t.name) + '</div>' +
      '</div>' +
      '<div>' + t.projects.map(p => projectChipHtml(p)).join('') + '</div>' +
    '</div>'
  ).join('');
}

document.getElementById('onbDone').addEventListener('click', () => {
  document.getElementById('onboardingApp').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
  initMain();
});
document.getElementById('onbSkip').addEventListener('click', () => {
  document.getElementById('onboardingApp').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
  initMain();
});

// =================== INIT ===================
// Если ссылка содержит ?tech=Вова&url=https://... — настраиваем автоматически
async function initFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const techName = params.get('tech');
  const techUrl = params.get('url');
  if (!techName || !techUrl) return false;

  // Уже добавлен с таким URL — просто запускаем
  if (techs.find(t => t.url === techUrl)) return true;

  // Добавляем тихо (без UI)
  try {
    const r = await apiGet(techUrl);
    if (!r.ok) return false;
    const projects = (r.projects && r.projects.length > 0) ? r.projects : [];
    techs.push({ id: uid(), name: techName, url: techUrl, projects });
    saveTechs();
    return true;
  } catch (e) {
    return false;
  }
}
function updateVersionFooter() {
  const f = document.getElementById('footerVersion');
  if (!f) return;
  let text = 'Канбан · оболочка v' + VERSION;
  if (serverVersion) {
    text += ' · скрипт v' + serverVersion;
    // Сравниваем только MAJOR — MINOR и PATCH'и независимы.
    // UI часто патчится без изменений в Apps Script — варн только при breaking-change.
    const major = v => String(v).split('.')[0];
    if (major(serverVersion) !== major(VERSION)) text += ' ⚠ несовпадение, обнови deployment';
  }
  text += ' · by Артурыч';
  f.textContent = text;
}

function initMain() {
  renderFilters('board');
  renderFilters('list');
  initDragDrop();
  reloadTasks();
  quickAdd.focus();
  updateVersionFooter();
  startAutoRefresh();
}

let autoRefreshTimer = null;
let lastAutoRefresh = 0;
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  // Раз в 45 секунд тихо обновляем (если вкладка видима)
  autoRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && techs.length > 0) {
      lastAutoRefresh = Date.now();
      reloadTasks(true);
    }
  }, 45000);
}

// При возврате на вкладку — сразу обновить (но не чаще раза в 10 сек)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && techs.length > 0 && !_renameInProgress) {
    if (Date.now() - lastAutoRefresh > 10000) {
      lastAutoRefresh = Date.now();
      reloadTasks(true);
    }
  }
});

// При фокусе окна тоже обновляем (полезно когда переключился из другого окна)
window.addEventListener('focus', () => {
  if (techs.length > 0 && !_renameInProgress && Date.now() - lastAutoRefresh > 10000) {
    lastAutoRefresh = Date.now();
    reloadTasks(true);
  }
});



// =================== CREATE TASK MODAL (v1.6.0) ===================
function openCreateTaskModal() {
  const m = document.getElementById('createTaskModal');
  if (!m) { openNewTaskModal(); return; } // fallback
  // Reset to single-tab
  document.querySelectorAll('#createTaskModal .tab').forEach(t => t.classList.toggle('active', t.dataset.createTab === 'single'));
  document.querySelectorAll('#createTaskModal .tab-content').forEach(c => c.classList.toggle('active', c.id === 'ct-single'));
  ctRenderSingle();
  ctRenderMultiInitial();
  m.classList.add('active');
  setTimeout(() => document.getElementById('ctSingleTitle')?.focus(), 50);
}

// Tab switching
document.querySelectorAll('#createTaskModal .tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('#createTaskModal .tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('#createTaskModal .tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('ct-' + t.dataset.createTab).classList.add('active');
  });
});
document.getElementById('ctCancel')?.addEventListener('click', () => document.getElementById('createTaskModal').classList.remove('active'));

// ----- SINGLE -----
function ctRenderSingle() {
  // Tech select
  const techSel = document.getElementById('ctSingleTech');
  techSel.innerHTML = '<option value="">— выбери —</option>' + techs.map(t => '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>').join('');
  // Project select — все известные
  const allP = new Set();
  techs.forEach(t => t.projects.forEach(p => allP.add(p)));
  tasks.forEach(t => { if (t.project) allP.add(t.project); });
  const projSel = document.getElementById('ctSingleProject');
  projSel.innerHTML = '<option value="">— нет —</option>' +
    Array.from(allP).sort().map(p => '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>').join('');
  // При выборе проекта — авто-подставить тех
  projSel.onchange = () => {
    const t = findTechByProject(projSel.value);
    if (t) techSel.value = t.id;
  };
  // Reset поля
  document.getElementById('ctSingleTitle').value = '';
  document.getElementById('ctSingleDeadline').value = '';
  document.getElementById('ctSingleNote').value = '';
  document.querySelectorAll('#ct-single .priority-select .filter-chip').forEach(b => b.classList.remove('active'));
}
let ctSinglePriority = '';
document.querySelectorAll('#ct-single .priority-select .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#ct-single .priority-select .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    ctSinglePriority = chip.dataset.prio;
  });
});

// ----- MULTI -----
function ctRenderMultiInitial() {
  const rows = document.getElementById('ctMultiRows');
  rows.innerHTML = '';
  ctAddMultiRow();
  ctAddMultiRow();
  ctAddMultiRow();
}
function ctAddMultiRow() {
  const rows = document.getElementById('ctMultiRows');
  const allP = new Set();
  techs.forEach(t => t.projects.forEach(p => allP.add(p)));
  tasks.forEach(t => { if (t.project) allP.add(t.project); });
  const projOpts = '<option value="">— проект —</option>' +
    Array.from(allP).sort().map(p => '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>').join('');
  const row = document.createElement('div');
  row.className = 'ct-multi-row';
  row.innerHTML =
    '<input type="text" class="input ct-row-title" placeholder="Задача">' +
    '<select class="input ct-row-project">' + projOpts + '</select>' +
    '<span class="ct-row-tech" title="Технарь подставится автоматически">—</span>' +
    '<select class="input ct-row-priority">' +
      '<option value="">приоритет</option>' +
      '<option value="Низкий">Низкий</option>' +
      '<option value="Средний">Средний</option>' +
      '<option value="Высокий">Высокий</option>' +
    '</select>' +
    '<input type="date" class="input ct-row-deadline">' +
    '<button class="btn-x" title="Удалить строку">✕</button>';
  rows.appendChild(row);
  // Project change → auto tech
  row.querySelector('.ct-row-project').addEventListener('change', e => {
    const t = findTechByProject(e.target.value);
    row.querySelector('.ct-row-tech').textContent = t ? t.name : '—';
    row.dataset.techId = t ? t.id : '';
  });
  row.querySelector('.btn-x').addEventListener('click', () => row.remove());
}
document.getElementById('ctAddRow')?.addEventListener('click', ctAddMultiRow);

// ----- SAVE -----
document.getElementById('ctSave')?.addEventListener('click', async () => {
  const activeTab = document.querySelector('#createTaskModal .tab.active')?.dataset.createTab;
  if (activeTab === 'single') {
    const title = document.getElementById('ctSingleTitle').value.trim();
    if (!title) { toast('Введи название', true); return; }
    const techId = document.getElementById('ctSingleTech').value;
    const project = document.getElementById('ctSingleProject').value;
    const deadline = document.getElementById('ctSingleDeadline').value;
    const note = document.getElementById('ctSingleNote').value;
    const priority = ctSinglePriority || '';
    if (!techId) { toast('Выбери технаря', true); return; }
    await createTask({
      title, project, priority, deadline, note,
      status: 'В работе', createdAt: new Date().toISOString().slice(0,10), completedAt: ''
    }, techId);
    document.getElementById('createTaskModal').classList.remove('active');
    return;
  }
  // MULTI
  const rows = Array.from(document.querySelectorAll('#ctMultiRows .ct-multi-row'));
  const toCreate = [];
  for (const row of rows) {
    const title = row.querySelector('.ct-row-title').value.trim();
    if (!title) continue;
    const project = row.querySelector('.ct-row-project').value;
    const techId = row.dataset.techId || (findTechByProject(project)?.id);
    if (!techId) { toast('Не определён технарь для «' + title + '» (выбери проект)', true); return; }
    toCreate.push({
      techId,
      data: {
        title,
        project,
        priority: row.querySelector('.ct-row-priority').value || '',
        deadline: row.querySelector('.ct-row-deadline').value || '',
        note: '',
        status: 'В работе',
        createdAt: new Date().toISOString().slice(0,10),
        completedAt: ''
      }
    });
  }
  if (toCreate.length === 0) { toast('Нет задач для создания', true); return; }
  setSync('syncing');
  // Параллельно — один сетевой раунд вместо N
  const results = await Promise.allSettled(toCreate.map(item => {
    const tech = getTech(item.techId);
    return apiPost(tech.url, { action: 'add', task: item.data }).then(res => ({ res, item }));
  }));
  let created = 0, failed = 0;
  const projAdditions = new Map(); // techId -> Set новых проектов
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.res.ok) {
      const { res, item } = r.value;
      tasks.push({ ...item.data, id: res.id, techId: item.techId, synced: true });
      const tech = getTech(item.techId);
      if (item.data.project && !tech.projects.includes(item.data.project)) {
        if (!projAdditions.has(item.techId)) projAdditions.set(item.techId, new Set());
        projAdditions.get(item.techId).add(item.data.project);
      }
      created++;
    } else {
      failed++;
    }
  });
  // Обновляем справочники проектов (один раз на техника, тоже параллельно)
  if (projAdditions.size > 0) {
    projAdditions.forEach((newProjs, techId) => {
      const tech = getTech(techId);
      newProjs.forEach(p => { if (!tech.projects.includes(p)) tech.projects.push(p); });
    });
    saveTechs();
    Promise.allSettled(Array.from(projAdditions.keys()).map(techId => {
      const tech = getTech(techId);
      return apiPost(tech.url, { action: 'updateProjects', projects: tech.projects });
    })).catch(() => {});
  }
  setSync('idle');
  renderActive();
  toast('Создано: ' + created + (failed ? ', ошибок: ' + failed : ''));
  document.getElementById('createTaskModal').classList.remove('active');
});

(async function init() {
  loadCustomColors();
  applyCustomColorStyles();
  loadTechs();
  // Если ссылка с параметрами — тихо настраиваем технаря
  await initFromUrlParams();

  if (techs.length === 0) {
    document.getElementById('onboardingApp').style.display = '';
  } else {
    document.getElementById('mainApp').style.display = '';
    initMain();
  }
})();
