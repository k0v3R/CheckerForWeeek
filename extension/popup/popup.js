/**
 * Checker for Weeek — логика попапа.
 * Рендерит кэш из chrome.storage.session мгновенно, затем запрашивает
 * свежие данные у background и перерисовывает.
 */

const APP_URL = 'https://app.weeek.net';

const els = {
  title: document.getElementById('title'),
  count: document.getElementById('count'),
  gear: document.getElementById('gear'),
  openWeeek: document.getElementById('open-weeek'),
  retry: document.getElementById('retry'),
  login: document.getElementById('login'),
  list: document.getElementById('list'),
  settingsView: document.getElementById('settings-view'),
  notificationsView: document.getElementById('notifications-view'),
  intervalGroup: document.getElementById('interval-group'),
  intervalHint: document.getElementById('interval-hint'),
  themeGroup: document.getElementById('theme-group'),
  themeHint: document.getElementById('theme-hint'),
  soundToggle: document.getElementById('sound-toggle'),
  pathToggle: document.getElementById('path-toggle'),
  toastToggle: document.getElementById('toast-toggle'),
  states: {
    loading: document.getElementById('state-loading'),
    error: document.getElementById('state-error'),
    auth: document.getElementById('state-auth'),
    empty: document.getElementById('state-empty'),
  },
};

/* SVG-иконки по типу уведомления (статические строки, Feather-стиль) */
const ICONS = {
  comment:
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  reaction:
    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  mention:
    '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>',
  task:
    '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  workspace:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell:
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  // меню «⋯» и его пункты,
  // точки одним цветом
  more:
    '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  archive:
    '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
};

/** SVG в стиле Feather (как все иконки попапа): контур 24×24, stroke 2. */
function featherSvg(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = paths;
  return svg;
}

/* ---------------- Всплывающая подсказка ----------------
   У системного title нельзя ограничить ширину, поэтому у обрезанных
   строк своя подсказка (CSS max-width 320px) с ПОЛНЫМ текстом строки —
   без ограничения по длине и по высоте. Показывается только когда
   строка реально обрезана. */
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
document.body.appendChild(tooltip);

/** Строка обрезана? Однострочные (nowrap + ellipsis) — по ширине,
    сниппет с line-clamp — по высоте. */
function isRowTruncated(row) {
  return row.scrollWidth > row.clientWidth + 1 ||
         row.scrollHeight > row.clientHeight + 1;
}

function showTooltip(row) {
  if (!isRowTruncated(row)) return;
  tooltip.textContent = row.dataset.tip; // полный текст, без обрезки
  tooltip.classList.add('tooltip--visible');
  const r = row.getBoundingClientRect();
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  // по левому краю строки; у краёв окна подсказка не выезжает
  // (центрирование по строке было и отменено пользователем)
  let x = Math.min(r.left, window.innerWidth - w - 8);
  let y = r.bottom + 4; // под строкой; не влезает снизу — над строкой
  if (y + h > window.innerHeight - 8) y = r.top - h - 4;
  tooltip.style.left = Math.max(8, x) + 'px';
  tooltip.style.top = Math.max(8, y) + 'px';
}

function hideTooltip() {
  tooltip.classList.remove('tooltip--visible');
}

// Делегирование: плитки перерисовываются целиком, слушатели на строках
// протухли бы. Нет data-tip под курсором — подсказка прячется.
document.addEventListener('mouseover', (e) => {
  const row = e.target.closest('[data-tip]');
  if (row) showTooltip(row);
  else hideTooltip();
});

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]')) hideTooltip();
});

// при прокрутке списка строка уезжает из-под курсора
els.notificationsView.addEventListener('scroll', hideTooltip, { passive: true });

/** Пункт выпадающего меню: иконка слева + подпись. */
function dropdownItem(paths, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tile__dropdown-item';
  btn.appendChild(featherSvg(paths));
  const span = document.createElement('span');
  span.textContent = label;
  btn.appendChild(span);
  return btn;
}

function iconKeyForType(type) {
  const t = String(type || '');
  // Реакция на комментарий: реальный тип — task.comment.reacted,
  // поэтому ловим 'react', а не 'reaction'.
  if (t.includes('react')) return 'reaction';
  if (t.includes('mention')) return 'mention';
  if (t.startsWith('task.comment')) return 'comment';
  if (t.startsWith('task.')) return 'task';
  if (t.startsWith('workspace.')) return 'workspace';
  return 'bell';
}

function buildTile(item) {
  const li = document.createElement('li');
  li.className = 'tile';
  // подсказки — на самих строках: у заголовка только заголовок, у текста
  // только текст (комбинированная подсказка на всей плитке мешала читать)

  const iconWrap = document.createElement('span');
  iconWrap.className = 'tile__icon';
  iconWrap.appendChild(featherSvg(ICONS[iconKeyForType(item.type)] || ICONS.bell));
  li.appendChild(iconWrap);

  const content = document.createElement('div');
  content.className = 'tile__content';

  const top = document.createElement('div');
  top.className = 'tile__top';

  const title = document.createElement('p');
  title.className = 'tile__title';
  title.textContent = item.title;
  title.dataset.tip = item.title; // длинное название читает всплывающая подсказка
  top.appendChild(title);

  const time = document.createElement('span');
  time.className = 'tile__time';
  time.textContent = formatTime(item.createdAt);
  top.appendChild(time);

  content.appendChild(top);

  // «Кто и что сделал» (упомянул, ответил…) — под названием задачи, обычным
  // шрифтом основного текста; в данных строки может не быть (уведомления
  // без задачи), а при дублировании текста её убирает background
  if (item.info) {
    const info = document.createElement('span');
    info.className = 'tile__info';
    info.textContent = item.info;
    info.dataset.tip = item.info; // длинная строка читает всплывающая подсказка
    content.appendChild(info);
  }

  // Основной текст: 1–2 строки (минимум одна даже без текста)
  const snippet = document.createElement('p');
  snippet.className = 'tile__snippet';
  snippet.textContent = item.snippet || '';
  if (item.snippet) snippet.dataset.tip = item.snippet; // длинный текст читает всплывающая подсказка
  content.appendChild(snippet);

  li.appendChild(content);

  // Путь до задачи (настройка «Путь до задачи»): тонкий разделитель под
  // 3-й строкой текста и путь одной строкой — оба во всю ширину плитки,
  // поэтому блок живёт на уровне плитки, а не в колонке текста.
  // У плиток без пути (например, приглашение в пространство) строки нет вовсе.
  if (settings.showTaskPath && item.taskPath) {
    const path = document.createElement('span');
    path.className = 'tile__path';
    path.textContent = item.taskPath;
    path.dataset.tip = item.taskPath; // длинный путь читает всплывающая подсказка
    li.appendChild(path);
  }

  // Меню «⋯» в правом верхнем углу: появляется при наведении,
  // по клику — «Прочитать» и «Архивировать». В отличие от клика по плитке
  // ничего не открывает.
  const menuWrap = document.createElement('div');
  menuWrap.className = 'tile__menu';

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tile__menu-btn';
  menuBtn.title = 'Действия';
  menuBtn.appendChild(featherSvg(ICONS.more));
  menuWrap.appendChild(menuBtn);

  const dropdown = document.createElement('div');
  dropdown.className = 'tile__dropdown';
  dropdown.hidden = true;

  const readItem = dropdownItem(ICONS.check, 'Прочитать');
  readItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    runTileAction(item, 'week:mark-read');
  });
  dropdown.appendChild(readItem);

  const archiveItem = dropdownItem(ICONS.archive, 'Архивировать');
  archiveItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    runTileAction(item, 'week:archive');
  });
  dropdown.appendChild(archiveItem);

  menuWrap.appendChild(dropdown);

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // не провоцируем клик по самой плитке
    const wasOpen = !dropdown.hidden;
    closeAllMenus();
    if (!wasOpen) {
      dropdown.hidden = false;
      li.classList.add('tile--menu-open');
      // Направление — по реальному месту: по умолчанию вниз; вверх — только
      // если низ дропдауна вылезает за прокручиваемое тело, а над плиткой
      // он помещается целиком. По месту, а не по «нижним 60% тела»: окно
      // попапа жмётся по контенту, и у короткого списка (одна плитка) любая
      // плитка «в нижних 60%» — меню раскрывалось вверх и пряталось под шапку.
      const bodyRect = (li.closest('.body') ?? document.body).getBoundingClientRect();
      if (dropdown.getBoundingClientRect().bottom > bodyRect.bottom) {
        dropdown.classList.add('tile__dropdown--up');
        if (dropdown.getBoundingClientRect().top < bodyRect.top) {
          // вверх тоже не влезает — остаёмся внизу и доскролливаем тело
          dropdown.classList.remove('tile__dropdown--up');
          dropdown.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  });

  li.appendChild(menuWrap);

  li.addEventListener('click', (e) => {
    // клики по меню «⋯» (кнопка, дропдаун и его паддинг) плитку не открывают
    if (e.target.closest('.tile__menu')) return;
    openItem(item);
  });
  return li;
}

/**
 * Клик по плитке: пометить прочитанным
 * и открыть задачу в новой вкладке. Сообщение отправляется до создания
 * вкладки, чтобы точно ушло до закрытия попапа; ответ не ждём.
 */
function openItem(item) {
  const url =
    item.taskId && item.workspaceId
      ? `${APP_URL}/ws/${item.workspaceId}/task/${item.taskId}`
      : APP_URL;
  chrome.runtime.sendMessage({ type: 'week:mark-read', id: item.id }).catch(() => {});
  chrome.tabs.create({ url });
  window.close();
}

/**
 * Тихое действие из меню «⋯» («Прочитать» / «Архивировать») без открытия
 * задачи: шлём сообщение background (тот отвечает уже после запроса к API и
 * локальной чистки кэша) и перерисовываем попап из хранилища. Если запрос не
 * прошёл — кэш не изменился и плитка останется на месте; бейдж поправит
 * следующий опрос.
 */
async function runTileAction(item, messageType) {
  if (!isExtensionContext()) {
    // демо-режим: убираем элемент из демо-данных и перерисовываем превью
    const idx = DEMO_ITEMS.findIndex((i) => i.id === item.id);
    if (idx !== -1) DEMO_ITEMS.splice(idx, 1);
    renderDemo();
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: messageType, id: item.id });
  } catch (e) {
    console.warn(`${messageType} failed:`, e);
  }
  await renderCached();
}

/** Закрывает все открытые меню-«⋯» (клик в любом другом месте попапа). */
function closeAllMenus() {
  for (const el of document.querySelectorAll('.tile__dropdown')) {
    el.hidden = true;
    el.classList.remove('tile__dropdown--up');
  }
  for (const el of document.querySelectorAll('.tile--menu-open')) {
    el.classList.remove('tile--menu-open');
  }
}

document.addEventListener('click', closeAllMenus);

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h} ч`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} дн`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function showState(name) {
  currentState = name;
  for (const [key, el] of Object.entries(els.states)) {
    el.hidden = key !== name;
  }
  els.list.hidden = name !== null;
  // на экране входа кнопка не нужна — там есть «Войти»
  els.openWeeek.hidden = name === 'auth';
  updateTitle();
}

/** Заголовок шапки: «Настройки» на экране настроек, «Checker for Weeek» —
    на экране входа и при пустом списке, иначе «Непрочитанные уведомления». */
function updateTitle() {
  if (currentView === 'settings') {
    els.title.textContent = 'Настройки';
  } else if (currentState === 'auth' || currentState === 'empty') {
    els.title.textContent = 'Checker for Weeek';
  } else {
    els.title.textContent = 'Непрочитанные уведомления';
  }
}

/* ------------------------- Экран настроек --------------------------- */

// Интервалы опроса (сек; 0 — автопроверка отключена). 30 с — минимальный
// период chrome.alarms, меньшее расширение задать не может.
const POLL_INTERVALS = [
  { sec: 30, label: '30 с' },
  { sec: 60, label: '1 мин' },
  { sec: 300, label: '5 мин' },
  { sec: 600, label: '10 мин' },
  { sec: 1800, label: '30 мин' },
  { sec: 0, label: 'Отключить' },
];

// Тема оформления. «Системная» (по умолчанию) — атрибут data-theme на <html>
// не ставится вовсе, тёмную включает CSS-медиазапрос (работает даже без JS);
// «Светлая»/«Тёмная» — popup.js ставит <html data-theme="light|dark">.
const THEME_OPTIONS = [
  { value: 'auto', label: 'Системная' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

const THEME_HINTS = {
  auto: 'Повторяет тему системы',
  light: 'Всегда светлая тема',
  dark: 'Всегда тёмная тема',
};

let currentView = 'notifications';
let currentState = null; // состояние тела: 'auth' | 'error' | 'empty' | null (список)
let lastRender = null; // последние данные уведомлений — для возврата из настроек
let settings = {
  pollIntervalSec: 30,
  soundEnabled: true,
  showTaskPath: true,
  toastEnabled: true,
  theme: 'auto',
};

/** Шапка остаётся общей: меняются заголовок, счётчик и тело попапа. */
function showView(view) {
  currentView = view;
  const isSettings = view === 'settings';
  hideTooltip(); // при смене вида строка уходит вместе с подсказкой
  els.settingsView.hidden = !isSettings;
  els.notificationsView.hidden = isSettings;
  updateTitle();
  els.gear.classList.toggle('header__gear--active', isSettings);
  els.gear.title = isSettings ? 'Вернуться к уведомлениям' : 'Настройки';
  els.gear.setAttribute('aria-pressed', String(isSettings));
  if (isSettings) {
    els.count.hidden = true;
  } else if (lastRender) {
    render(lastRender);
  }
}

function buildIntervalPills() {
  for (const { sec, label } of POLL_INTERVALS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill';
    btn.dataset.sec = String(sec);
    btn.textContent = label;
    btn.addEventListener('click', () => saveSettings({ pollIntervalSec: sec }));
    els.intervalGroup.appendChild(btn);
  }
}

function buildThemePills() {
  for (const { value, label } of THEME_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill';
    btn.dataset.value = value;
    btn.textContent = label;
    btn.addEventListener('click', () => saveSettings({ theme: value }));
    els.themeGroup.appendChild(btn);
  }
}

/** Тема попапа: явный выбор ставит data-theme на <html>, «Системная»
    снимает атрибут — тёмную тогда включает CSS-медиазапрос сам. */
function applyTheme() {
  if (settings.theme === 'auto') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = settings.theme;
  }
}

function renderSettings() {
  for (const btn of els.intervalGroup.children) {
    btn.classList.toggle('pill--active', Number(btn.dataset.sec) === settings.pollIntervalSec);
  }
  els.intervalHint.textContent = settings.pollIntervalSec
    ? 'Расширение проверяет новые уведомления каждые:'
    : 'Автопроверка выключена — уведомления проверяются при открытии попапа';
  for (const btn of els.themeGroup.children) {
    btn.classList.toggle('pill--active', btn.dataset.value === settings.theme);
  }
  els.themeHint.textContent = THEME_HINTS[settings.theme] || THEME_HINTS.auto;
  applyTheme();
  els.soundToggle.checked = settings.soundEnabled;
  els.pathToggle.checked = settings.showTaskPath;
  els.toastToggle.checked = settings.toastEnabled;
}

async function loadSettings() {
  if (!isExtensionContext()) return; // демо-режим — дефолтные значения
  try {
    const stored = await chrome.storage.sync.get([
      'pollIntervalSec',
      'soundEnabled',
      'showTaskPath',
      'toastEnabled',
      'theme',
    ]);
    if (POLL_INTERVALS.some((i) => i.sec === stored.pollIntervalSec)) {
      settings.pollIntervalSec = stored.pollIntervalSec;
    }
    if (THEME_OPTIONS.some((o) => o.value === stored.theme)) {
      settings.theme = stored.theme;
    }
    for (const key of ['soundEnabled', 'showTaskPath', 'toastEnabled']) {
      if (typeof stored[key] === 'boolean') {
        settings[key] = stored[key];
      }
    }
  } catch (e) {
    console.warn('load settings failed:', e);
  }
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  renderSettings();
  if (!isExtensionContext()) return; // демо-режим — настройки не сохраняются
  try {
    await chrome.storage.sync.set(patch);
    // будим service worker, чтобы он сразу пересобрал будильник опроса
    await chrome.runtime.sendMessage({ type: 'week:settings-changed' });
  } catch (e) {
    console.warn('save settings failed:', e);
  }
}

function render({ authState, unreadCount, items }) {
  lastRender = { authState, unreadCount, items };
  // на экране настроек данные просто запоминаем: счётчик скрыт, а список
  // перерисуется при возврате к уведомлениям (showView → render(lastRender))
  if (currentView === 'settings') return;
  els.count.hidden = !(Number.isFinite(unreadCount) && unreadCount > 0);
  if (!els.count.hidden) {
    const text = unreadCount > 99 ? '99+' : String(unreadCount);
    els.count.textContent = text;
    // одна цифра — идеальный круг; несколько — скруглённая «таблетка»
    els.count.classList.toggle('header__count--single', text.length === 1);
  }

  if (authState === 'unauthorized') {
    showState('auth');
    return;
  }
  if (authState === 'error' && !(items && items.length)) {
    showState('error');
    return;
  }
  if (!items || !items.length) {
    showState('empty');
    return;
  }

  showState(null);
  els.list.replaceChildren(...items.map(buildTile));
}

/* ------------------------- Демо-режим ------------------------------ */

// Массив на уровне модуля: меню «⋯» в демо-режиме убирает элемент из него
// и перерисовывает превью.
const now = Date.now();

const DEMO_ITEMS = [
  {
    id: '1',
    type: 'task.comment.reply_created',
    title: 'Обновить дизайн лендинга',
    info: 'Анна Соколова ответил(-а) в комментариях',
    snippet:
      'Посмотрите, пожалуйста, новый макет главной страницы — добавила комментарии к секции hero и футеру, поправила отступы и типографику во всех блоках, а также подготовила тёмную версию',
    taskPath: 'Дизайн сайта > В работе',
    taskId: '1024',
    workspaceId: '77',
    createdAt: new Date(now - 5 * 60000).toISOString(),
  },
  {
    id: '2',
    type: 'workspace.user.mentioned',
    title: 'Взять задачу в спринт',
    info: 'Дмитрий упомянул(-а) вас в комментариях',
    snippet: '@вы сможете взять эту задачу в спринт?',
    taskPath: 'Спринты > На согласовании',
    taskId: '1025',
    workspaceId: '77',
    createdAt: new Date(now - 47 * 60000).toISOString(),
  },
  {
    id: '3',
    type: 'task.unblocked',
    title: 'Настроить аналитику',
    info: 'Задача разблокирована',
    snippet: 'Все блокирующие задачи завершены',
    taskPath: 'Аналитика > Трекинг событий',
    taskId: '1018',
    workspaceId: '77',
    createdAt: new Date(now - 3 * 3600000).toISOString(),
  },
  {
    id: '4',
    type: 'task.comment.reacted',
    title: 'Обновить дизайн лендинга',
    info: 'Анна Соколова отреагировал(-а) на ваш комментарий',
    snippet: '',
    taskPath: 'Дизайн сайта > Длинное название доски для проверки обрезания пути',
    taskId: '1024',
    workspaceId: '77',
    createdAt: new Date(now - 2 * 3600000).toISOString(),
  },
];

function renderDemo() {
  render({
    authState: 'ok',
    unreadCount: DEMO_ITEMS.length,
    items: DEMO_ITEMS,
  });
}

/* --------------------------- Инициализация ------------------------- */

function isExtensionContext() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

/** Перерисовка из кэша storage.session (без запроса к API). */
async function renderCached() {
  const state = await chrome.storage.session.get([
    'authState',
    'unreadCount',
    'weekNotifications',
  ]);
  render({
    authState: state.authState,
    unreadCount: state.unreadCount,
    items: state.weekNotifications ?? [],
  });
}

async function refresh() {
  try {
    await chrome.runtime.sendMessage({ type: 'week:refresh' });
  } catch (e) {
    console.warn('refresh failed:', e);
  }
  await renderCached();
}

async function init() {
  els.openWeeek.addEventListener('click', () => {
    chrome.tabs.create({ url: APP_URL });
    window.close();
  });
  els.login.addEventListener('click', () => {
    chrome.tabs.create({ url: APP_URL });
    window.close();
  });
  els.retry.addEventListener('click', refresh);

  // Шестерёнка: открыть настройки / вернуться к уведомлениям
  els.gear.addEventListener('click', () => {
    showView(currentView === 'settings' ? 'notifications' : 'settings');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentView === 'settings') showView('notifications');
  });

  // Настройки: пилюли интервала и темы, тумблеры
  buildIntervalPills();
  buildThemePills();
  els.soundToggle.addEventListener('change', () => {
    saveSettings({ soundEnabled: els.soundToggle.checked });
  });
  els.pathToggle.addEventListener('change', () => {
    saveSettings({ showTaskPath: els.pathToggle.checked });
  });
  els.toastToggle.addEventListener('change', () => {
    saveSettings({ toastEnabled: els.toastToggle.checked });
  });

  // Щелчок по любой точке строки настроек переключает её тумблер.
  // Клик по самому тумблеру не дублируем: его обрабатывает label,
  // а синтетический click() всплывает с target внутри .switch.
  for (const [rowSel, input] of [
    ['.settings__row--sound', els.soundToggle],
    ['.settings__row--path', els.pathToggle],
    ['.settings__row--toast', els.toastToggle],
  ]) {
    const row = document.querySelector(rowSel);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      input.click();
    });
  }

  await loadSettings();
  renderSettings();

  if (!isExtensionContext()) {
    // Открыт не как расширение (локальная проверка дизайна) — демо-данные
    renderDemo();
    return;
  }

  // 1. Мгновенный рендер из кэша
  const cached = await chrome.storage.session.get([
    'authState',
    'unreadCount',
    'weekNotifications',
  ]);
  if (cached.authState) {
    render({
      authState: cached.authState,
      unreadCount: cached.unreadCount,
      items: cached.weekNotifications ?? [],
    });
  }

  // 2. Свежие данные от background
  await refresh();
}

init();
