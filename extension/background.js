/**
 * Checker for Weeek — background service worker.
 *
 * Опрашивает API api.weeek.net с сессионными cookies
 * пользователя и обновляет счётчик непрочитанных уведомлений на иконке.
 *
 * Правила прочтения:
 *  - открытие попапа НЕ помечает уведомления прочитанными (только GET-запросы);
 *  - клик по плитке в попапе = осознанное действие пользователя: уведомление
 *    помечается прочитанным (POST /notifications/{id}/read) и задача открывается
 *    в новой вкладке.
 * POST-запросы требуют CSRF-токен: берём cookie XSRF-TOKEN домена
 * api.weeek.net и передаём в заголовке X-XSRF-TOKEN.
 */

const API_BASE = 'https://api.weeek.net';
const APP_URL = 'https://app.weeek.net';
const POLL_ALARM = 'weeek-poll';
// Интервал опроса задаётся в настройках попапа (chrome.storage.sync,
// pollIntervalSec в секундах; 0 — автопроверка отключена). 30 секунд —
// минимальный период chrome.alarms (с Chromium 120; устаревшие сборки
// молча округлят до минуты).
const DEFAULT_POLL_SEC = 30;
// Собственный звук уведомления (синтезирован с нуля: два «блика» F5 -> C6
// с быстрым спадом), файл sounds/notification.wav
const SOUND_VOLUME = 0.4;
// Список запрашивается с limit=15 — рабочий лимит,
// чтобы не рисковать серверной валидацией лимита.
const LIST_LIMIT = 15;
// Цвет бейджа — акцентный (#6C78F4); текст всегда белый.
const BADGE_BG = '#6C78F4';
const BADGE_TEXT = '#FFFFFF';

// true → сырой JSON первого уведомления логируется один раз за жизнь service worker
// (edge://extensions → Checker for Weeek → Служебная программа: Inspect).
// Маппинг полей подтверждён на живой сессии, поэтому выключен.
const DEBUG = false;

/* ------------------------------------------------------------------ */
/* Хранилище (chrome.storage.session):                                 */
/*   authState: 'ok' | 'unauthorized' | 'error'                        */
/*   unreadCount: number                                               */
/*   weekNotifications: Array<Tile>                                    */
/*                                                                     */
/* Настройки (chrome.storage.sync, меняются в попапе):                 */
/*   pollIntervalSec: 30 | 60 | 300 | 600 | 1800 | 0 (0 — выкл.)       */
/*   soundEnabled: boolean (по умолчанию true)                         */
/*   showTaskPath: boolean (по умолчанию true)                         */
/*   toastEnabled: boolean (по умолчанию true) — тосты Windows         */
/* ------------------------------------------------------------------ */

/* ------------------------------- API ------------------------------- */

/** Ответы API могут прийти в конверте {success, data} или напрямую. */
function unwrap(json) {
  if (
    json &&
    typeof json === 'object' &&
    Object.prototype.hasOwnProperty.call(json, 'success') &&
    Object.prototype.hasOwnProperty.call(json, 'data')
  ) {
    return json.data;
  }
  return json;
}

async function fetchJSON(path) {
  const res = await fetch(API_BASE + path, {
    credentials: 'include',
    headers: { 'X-WEEEK-LANG': 'ru' },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Счётчик непрочитанных из GET /user/profile/me. */
function extractUnread(me) {
  for (const candidate of [me, me?.user, me?.profile]) {
    const all = candidate?.notifications?.unread?.all;
    if (Number.isFinite(all)) return all;
  }
  return null;
}

function stripHtml(value) {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Строка из значения узла; объекты без текстовых полей молча пропускаем
 *  (иначе String(объект) даёт «[object Object]» в тексте тайла). */
function nodeText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const key of ['text', 'title', 'name']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '';
}

/**
 * Инфо-строка («кто и что сделал») после выемки названия задачи: убираем
 * огрызки кавычек по краям и опорные слова «задачи» / «в задаче:» на конце
 * (просили «без слова задачи, в задаче и т.д.»). Без \b — в JS он
 * ASCII-шный и на кириллице не работает; «подзадачи» и не зацепит, потому
 * что шаблон требует пробел (или предлог) ровно перед «задач…».
 */
function cleanInfoLine(s) {
  let out = String(s || '')
    .replace(/«\s*»/g, ' ')
    .replace(/^[\s«»"':.,]+/, '')
    .replace(/[\s«»"':.,]+$/, '');
  out = out.replace(/\s+(?:(?:в|во|на)\s+)?задач[а-яё]+\s*[.:,]?\s*$/i, '');
  return out.trim();
}

/**
 * content-узел — это rich-text документ (TipTap):
 * {type:'content', content:{data:<doc>, mentions:[...]}}. Обходим дерево
 * рекурсивно и собираем строковые text-поля листьев.
 */
function collectDocText(value, out) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.text === 'string') {
    out.push(value.text);
    return;
  }
  if (Array.isArray(value.content)) {
    for (const child of value.content) collectDocText(child, out);
  }
}

/** Человекочитаемая подпись по типу уведомления. */
function labelForType(type) {
  const t = String(type || '');
  if (t.includes('mention')) return 'Вас упомянули';
  if (t.includes('react')) return 'Реакция на комментарий';
  if (t.startsWith('task.comment')) return 'Комментарий к задаче';
  if (t.startsWith('task.')) return 'Обновление задачи';
  if (t.startsWith('workspace.')) return 'Рабочее пространство';
  return 'Уведомление';
}

/**
 * Путь до задачи — top-level breadcrumbs уведомления (НЕ body.nodes):
 *   [{type:'entity', entity:{type:'workspace'|'funnel'|'deal', title}},
 *    {type:'task_locations', locations:[{project:{title}, board?, boardColumn?}]}]
 * Несколько локаций сворачиваем в «первая +N». Слово
 * «задачи» (служебный сегмент пути) и само пространство
 * (entity workspace) в плитку не попадают — путь начинается с проекта,
 * сегменты соединяются « > ».
 */
const TASK_PATH_SERVICE_WORD = 'задачи';
const TASK_PATH_MAX_LEN = 200;

function extractTaskPath(n) {
  if (!Array.isArray(n?.breadcrumbs)) return '';
  const parts = [];
  let extraLocations = 0;
  for (const crumb of n.breadcrumbs) {
    if (crumb?.type === 'entity') {
      // пространство в путь не попадает (просили начать с проекта);
      // прочие entity (воронка, сделка) остаются
      if (crumb.entity?.type === 'workspace') continue;
      const title = crumb.entity?.title;
      if (
        typeof title === 'string' &&
        title.trim() &&
        title.trim().toLowerCase() !== TASK_PATH_SERVICE_WORD
      ) {
        parts.push(title.trim());
      }
    } else if (crumb?.type === 'task_locations' && Array.isArray(crumb.locations) && crumb.locations[0]) {
      const loc = crumb.locations[0];
      for (const seg of [loc.project?.title, loc.board?.title, loc.boardColumn?.title]) {
        if (typeof seg === 'string' && seg.trim()) parts.push(seg.trim());
      }
      if (crumb.locations.length > 1) extraLocations = crumb.locations.length - 1;
    }
  }
  if (!parts.length) return '';
  if (extraLocations) parts.push(`+${extraLocations}`);
  return parts.join(' > ').slice(0, TASK_PATH_MAX_LEN);
}

/**
 * Приводит уведомление API к компактному тайлу попапа.
 *
 * Реальный формат:
 *   {
 *     id, type, isRead, createdAt,
 *     workspaceId,                       — на верхнем уровне
 *     initiator: {name, type, user},
 *     body: { nodes: [                   — «строки» уведомления
 *       {type:'initiator', initiator:{name}},
 *       {type:'text', text},
 *       {type:'entity', entity:{type:'task', id, title}},   — ссылка на задачу
 *       {type:'content', content:{data:<doc редактора>}},     — rich-text: комментарий, эмодзи реакции
 *       {type:'new_line'} | {type:'task_locations'} | {type:'datetime'|...}
 *     ]}
 *   }
 * Для устойчивости к изменениям API сохранены запасные варианты полей.
 */
function normalizeNotification(n) {
  const nodes = Array.isArray(n?.body?.nodes) ? n.body.nodes : null;
  let title = '';
  let info = '';
  let snippet = '';
  let taskId = null;
  let workspaceId = n?.workspaceId ?? null;

  if (nodes) {
    const lines = [];
    let current = [];
    let taskName = '';
    const flush = () => {
      if (current.length) {
        lines.push(current.join(' ').replace(/\s+/g, ' ').trim());
        current = [];
      }
    };
    for (const node of nodes) {
      switch (node?.type) {
        case 'new_line':
          flush();
          break;
        case 'initiator': {
          const name = nodeText(node.initiator?.name);
          if (name) current.push(name);
          break;
        }
        case 'entity': {
          if (node.entity?.type === 'task' && node.entity.id != null) {
            taskId = node.entity.id;
            // название задачи вынимаем из строки: оно становится заголовком
            // тайла, остальная строка («кто и что сделал») — инфо-строкой
            const name =
              nodeText(node.entity?.title) || nodeText(node.text);
            taskName =
              name.replace(/^[«»"']+/, '').replace(/[«»"']+$/, '').trim() ||
              taskName;
            break;
          }
          const text = nodeText(node.entity?.title) || nodeText(node.text);
          if (text) current.push(text);
          break;
        }
        case 'content': {
          const parts = [];
          collectDocText(node.content?.data, parts);
          const text = parts.join(' ').trim() || nodeText(node.text);
          if (text) current.push(text);
          break;
        }
        // служебные узлы: крошки, даты, приоритет — в тексте тайла не нужны
        case 'task_locations':
        case 'datetime':
        case 'datetime_range':
        case 'task_priority':
          break;
        default:
          if (typeof node?.text === 'string' && node.text) current.push(node.text);
      }
    }
    flush();
    const linesClean = lines.filter(Boolean);
    const first = linesClean[0] ?? '';
    if (taskName) {
      // заголовок — только название задачи; всё, что шло до него в строке
      // (кто упомянул, ответил…) — отдельная инфо-строка основного текста
      title = taskName;
      info = cleanInfoLine(first);
    } else if (taskId != null) {
      // запасной путь: название пришло не в entity, а текстом в «кавычках»
      // в конце строки («…в задаче: «Название»»); если названия нет вовсе —
      // хотя бы убираем со строки-заголовка «…в задаче»
      const m = first.match(/«([^»]+)»\s*$/);
      if (m && m[1].trim()) {
        title = m[1].trim();
        info = cleanInfoLine(first.slice(0, m.index));
      } else {
        title = cleanInfoLine(first) || first;
      }
    } else {
      title = first;
    }
    snippet = linesClean.slice(1).join(' · ');
  }

  // Запасные варианты, если body.nodes нет (или парсинг ничего не дал).
  // Только строковые поля: n.body — это объект {nodes:[...]}, и String(n.body)
  // давал «[object Object]» в сниппете (плитка «изменил приоритет у задачи»).
  if (!title) title = stripHtml(nodeText(n.title) || nodeText(n.subject) || '');
  if (!snippet) snippet = stripHtml(nodeText(n.body) || nodeText(n.text) || nodeText(n.description) || '');
  if (!title) title = labelForType(n.type);

  // Сайт иногда повторяет всю фразу второй строкой («Франсиско Гарридо
  // изменил(-а) приоритет у задачи на Средний - #28223 …») — тогда
  // инфо-строка дублирует основной текст; оставляем только текст
  if (info && snippet) {
    const norm = (s) =>
      String(s)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[→⇒«».,:;!\s-]+$/, '');
    if (norm(snippet).startsWith(norm(info))) info = '';
  }

  // taskId — запасной вариант из data.*, если не нашли в body.nodes
  if (taskId == null) {
    const data = n?.data && typeof n.data === 'object' ? n.data : {};
    const task = data.task && typeof data.task === 'object' ? data.task : {};
    if (task.id != null) taskId = task.id;
    else if (typeof data.task === 'string' || typeof data.task === 'number') taskId = data.task;
    else if (data.task_id != null) taskId = data.task_id;
    else if (data.taskId != null) taskId = data.taskId;
    if (workspaceId == null) {
      const ws = data.workspace && typeof data.workspace === 'object' ? data.workspace : {};
      workspaceId = task.workspace_id ?? task.workspaceId ?? data.workspace_id ?? data.workspaceId ?? ws.id ?? null;
    }
  }

  return {
    id: String(n.id),
    type: String(n.type ?? ''),
    title: title.slice(0, 120),
    info: info.slice(0, 120),
    snippet: snippet.slice(0, 200),
    taskPath: extractTaskPath(n),
    taskId: taskId == null ? null : String(taskId),
    workspaceId: workspaceId == null ? null : String(workspaceId),
    createdAt: n.createdAt ?? n.created_at ?? n.date ?? null,
  };
}

/* ------------------------------ Бейдж ------------------------------ */

async function setBadge(count) {
  try {
    if (Number.isFinite(count) && count > 0) {
      await applyBadgeStyle();
      await chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    console.warn('badge update failed:', e);
  }
}

/** Фирменный стиль бейджа (цвет фона + белый текст). */
async function applyBadgeStyle() {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    /* setBadgeTextColor доступен с Chromium 110; на старых версиях молча пропускаем */
  }
}

// Стиль бейджа задаётся сразу при старте service worker, чтобы счётчик
// никогда не отрисовывался в дефолтном цвете.
applyBadgeStyle().catch(() => {});

/* --------------------------- Основной опрос ------------------------- */

let pollInFlight = false;
let debugSampleLogged = false; // DEBUG-сэмпл логируется один раз за жизнь service worker

async function checkNotifications() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    // 1. Профиль пользователя → счётчик непрочитанных
    let unreadCount;
    try {
      const me = unwrap(await fetchJSON('/user/profile/me'));
      unreadCount = extractUnread(me);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        await chrome.storage.session.set({
          authState: 'unauthorized',
          unreadCount: 0,
          weekNotifications: [],
        });
        await setBadge(0);
      } else {
        // Сеть или сервер недоступны — бейдж и кэш не трогаем
        await chrome.storage.session.set({ authState: 'error' });
      }
      return;
    }

    // 1a. Пришло новое уведомление → звук (см. maybePlaySound)
    await maybePlaySound(unreadCount);

    // 2. Список непрочитанных уведомлений.
    // Тело ответа: {success, data: [уведомления], cursor: {nextToken}} —
    // payload это МАССИВ напрямую
    // nextToken — курсор пагинации.
    let items = [];
    let listLoaded = false;
    try {
      const body = await fetchJSON(`/notifications?limit=${LIST_LIMIT}&type=unread`);
      const payload = unwrap(body);
      let raw = [];
      if (Array.isArray(payload)) {
        raw = payload;
      } else if (Array.isArray(payload?.notifications)) {
        raw = payload.notifications; // запасной вариант на случай смены формата
      }
      if (DEBUG && raw.length && !debugSampleLogged) {
        debugSampleLogged = true;
        console.log('[weeek-ext] raw notification sample:', JSON.stringify(raw[0]));
      }
      items = raw.map(normalizeNotification);
      listLoaded = true;
      // Новые уведомления → системные тосты Windows (стандартная длительность)
      await notifyNewItems(items);
    } catch (e) {
      // Список недоступен — кэш попапа не трогаем (его перезапишет успешный опрос)
      console.warn('notifications list fetch failed:', e);
    }

    const patch = {
      authState: 'ok',
      unreadCount: Number.isFinite(unreadCount) ? unreadCount : 0,
    };
    // Список получен → обновляем кэш попапа; нет → оставляем прежний, иначе
    // сетевой сбой покажет «Нет уведомлений» при живом бейдже со счётчиком.
    if (listLoaded) patch.weekNotifications = items;
    await chrome.storage.session.set(patch);
    await setBadge(unreadCount);
  } finally {
    pollInFlight = false;
  }
}

/* ------------------------ Звук нового уведомления -------------------- */

/**
 * Играет собственный звук, когда счётчик непрочитанных ВЫРОС по сравнению с
 * прошлой проверкой. Первую проверку не озвучиваем (чтобы не пищать при
 * запуске браузера на существующих непрочитанных).
 */
async function maybePlaySound(unreadCount) {
  if (!Number.isFinite(unreadCount)) return;
  try {
    const [{ lastUnreadCount }, { soundEnabled = true }] = await Promise.all([
      chrome.storage.session.get('lastUnreadCount'),
      chrome.storage.sync.get('soundEnabled'),
    ]);
    if (lastUnreadCount != null && unreadCount > lastUnreadCount && soundEnabled !== false) {
      await playNotificationSound();
    }
    if (unreadCount !== lastUnreadCount) {
      await chrome.storage.session.set({ lastUnreadCount: unreadCount });
    }
  } catch (e) {
    console.warn('sound check failed:', e);
  }
}

/** Гарантирует наличие offscreen-документа и командует ему играть звук. */
async function playNotificationSound() {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: 'weeek:play-sound', volume: SOUND_VOLUME });
  } catch (e) {
    console.warn('play sound failed:', e);
  }
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    // Chrome/Edge 116+: официальный способ проверить наличие offscreen-документа
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Проигрывание звука новых уведомлений Weeek',
    });
  } catch (e) {
    // Документ уже создан параллельным вызовом — это нормально
    if (!String(e).includes('single offscreen')) throw e;
  }
}

/* ------------- Системные тосты о новых уведомлениях ----------------- */

const TOAST_MAX_PER_CHECK = 3; // не показываем лавину тостов за одну проверку
const TOAST_URLS_LIMIT = 20;   // размер сопоставления «тост → уведомление API»

/** Promise-обёртка над callback-based chrome.notifications.create. */
function createNotification(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });
}

/**
 * Показывает системные тосты (длительность — стандартная Windows) для
 * уведомлений, которых не было при прошлой проверке. Первая проверка
 * только запоминает ids: существующие непрочитанные не всплываем.
 */
async function notifyNewItems(items) {
  try {
    const [{ seenIds }, { toastEnabled = true }] = await Promise.all([
      chrome.storage.session.get('seenIds'),
      chrome.storage.sync.get('toastEnabled'),
    ]);
    if (!Array.isArray(seenIds)) {
      await chrome.storage.session.set({ seenIds: items.map((i) => i.id) });
      return;
    }
    const seen = new Set(seenIds);
    const fresh = items.filter((i) => !seen.has(i.id));
    if (DEBUG) console.log('[weeek-ext] toast flow: fresh =', fresh.length, 'of', items.length);
    if (!fresh.length) return;

    // Тосты выключены в настройках — ids всё равно запоминаем, чтобы после
    // включения старые уведомления не всплывали задним числом
    if (toastEnabled === false) {
      await chrome.storage.session.set({
        seenIds: [...seen, ...items.map((i) => i.id)].slice(-200),
      });
      return;
    }

    for (const item of fresh.slice(0, TOAST_MAX_PER_CHECK)) {
      await showToast(item);
    }
    const merged = [...seen, ...items.map((i) => i.id)];
    await chrome.storage.session.set({ seenIds: merged.slice(-200) });
  } catch (e) {
    console.warn('toast flow failed:', e);
  }
}

/** Один системный тост: заголовок + сниппет, клик открывает задачу. */
async function showToast(item) {
  const toastId = `weeek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createNotification(toastId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: item.title || 'Новое уведомление Weeek',
    message:
      item.snippet ||
      (item.taskId ? 'Открыть задачу в Weeek' : 'Открыть Weeek'),
  });
  if (DEBUG) console.log('[weeek-ext] toast created:', toastId, `«${item.title}»`);
  // Сопоставление тоста → уведомление API (для клика), храним последние 20
  const { toastUrls = {} } = await chrome.storage.session.get('toastUrls');
  toastUrls[toastId] = {
    apiId: item.id,
    taskId: item.taskId,
    workspaceId: item.workspaceId,
  };
  const entries = Object.entries(toastUrls).slice(-TOAST_URLS_LIMIT);
  await chrome.storage.session.set({ toastUrls: Object.fromEntries(entries) });
}

// Клик по тосту = клик по плитке в попапе: пометить прочитанным и открыть
// задачу в новой вкладке (уведомления без задачи → главная app.weeek.net).
// Баннер закрывает сама система — ничего не clear'им (стандарт Windows).
chrome.notifications.onClicked.addListener((toastId) => {
  (async () => {
    try {
      const { toastUrls = {} } = await chrome.storage.session.get('toastUrls');
      const info = toastUrls[toastId];
      if (!info) return;
      const url =
        info.taskId && info.workspaceId
          ? `${APP_URL}/ws/${info.workspaceId}/task/${info.taskId}`
          : APP_URL;
      markNotificationRead(info.apiId)
        .then((ok) => (ok ? removeNotificationLocally(info.apiId) : null))
        .catch((e) => console.warn('toast mark-read failed:', e));
      chrome.tabs.create({ url });
    } catch (e) {
      console.warn('toast click failed:', e);
    }
  })();
});

/* ------------------------- Жизненный цикл --------------------------- */

function ensureAlarm() {
  applyPollSchedule().catch((e) => console.warn('schedule poll failed:', e));
}

/** Интервал опроса из настроек (0 — автопроверка отключена). */
async function getPollIntervalSec() {
  try {
    const { pollIntervalSec } = await chrome.storage.sync.get('pollIntervalSec');
    if (pollIntervalSec === 0 || (Number.isFinite(pollIntervalSec) && pollIntervalSec >= 30)) {
      return pollIntervalSec;
    }
  } catch (e) {
    console.warn('cannot read poll interval setting:', e);
  }
  return DEFAULT_POLL_SEC;
}

/** Создаёт будильник опроса по настройкам (или убирает его, если 0). */
async function applyPollSchedule() {
  const sec = await getPollIntervalSec();
  if (!sec) {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }
  const period = sec / 60; // минуты
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (existing && Math.abs(existing.periodInMinutes - period) < 1e-9) return;
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: period });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  checkNotifications();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  checkNotifications();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) checkNotifications();
});

// Настройки меняются в попапе (или синкились с другого устройства) —
// пересобираем расписание, не дожидаясь перезапуска service worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.pollIntervalSec) {
    applyPollSchedule().catch((e) => console.warn('reschedule failed:', e));
  }
});

// Свежий опрос при каждом пробуждении service worker (открытие попапа и т.п.)
checkNotifications();

/* ------------- Прочтение уведомления по клику в попапе -------------- */

/** CSRF-токен из cookie XSRF-TOKEN домена api.weeek.net (нужен для POST). */
async function getXsrfToken() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'api.weeek.net' });
    const xsrf = cookies.find((c) => c.name.toLowerCase() === 'xsrf-token');
    return xsrf ? decodeURIComponent(xsrf.value) : null;
  } catch (e) {
    console.warn('cannot read XSRF-TOKEN cookie:', e);
    return null;
  }
}

/** POST /notifications/{id}/read — пометить уведомление прочитанным. */
async function markNotificationRead(id) {
  try {
    const headers = { 'X-WEEEK-LANG': 'ru', Accept: 'application/json' };
    const token = await getXsrfToken();
    if (token) headers['X-XSRF-TOKEN'] = token;
    const res = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      console.warn(`mark-read: HTTP ${res.status} for notification ${id}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('mark-read failed:', e);
    return false;
  }
}

/**
 * DELETE /notifications/{id} — архивировать
 * (именно DELETE, не POST /archive; восстановление — POST /{id}/restore).
 */
async function archiveNotification(id) {
  try {
    const headers = { 'X-WEEEK-LANG': 'ru', Accept: 'application/json' };
    const token = await getXsrfToken();
    if (token) headers['X-XSRF-TOKEN'] = token;
    const res = await fetch(`${API_BASE}/notifications/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      console.warn(`archive: HTTP ${res.status} for notification ${id}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('archive failed:', e);
    return false;
  }
}

/** Локально убирает уведомление из кэша и уменьшает бейдж (после прочтения
 *  ИЛИ архивирования — до следующего опроса). */
async function removeNotificationLocally(id) {
  const { unreadCount = 0, weekNotifications = [] } = await chrome.storage.session.get([
    'unreadCount',
    'weekNotifications',
  ]);
  const items = weekNotifications.filter((item) => item.id !== String(id));
  const next = Math.max(0, unreadCount - 1);
  await chrome.storage.session.set({ unreadCount: next, weekNotifications: items });
  await setBadge(next);
}

/* --------------------------- Сообщения ------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'week:mark-read' && msg.id) {
    markNotificationRead(msg.id)
      .then((ok) => (ok ? removeNotificationLocally(msg.id) : null))
      .catch((e) => console.warn('mark-read flow failed:', e))
      .finally(() => {
        try {
          sendResponse({ ok: true });
        } catch {
          /* попап уже закрыт — ответ некуда доставить */
        }
      });
    return true; // асинхронный ответ
  }
  if (msg?.type === 'week:archive' && msg.id) {
    archiveNotification(msg.id)
      .then((ok) => (ok ? removeNotificationLocally(msg.id) : null))
      .catch((e) => console.warn('archive flow failed:', e))
      .finally(() => {
        try {
          sendResponse({ ok: true });
        } catch {
          /* попап уже закрыт — ответ некуда доставить */
        }
      });
    return true; // асинхронный ответ
  }
  if (msg?.type === 'week:refresh') {
    checkNotifications()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // асинхронный ответ
  }
  if (msg?.type === 'week:settings-changed') {
    applyPollSchedule()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // асинхронный ответ
  }
  return undefined;
});
