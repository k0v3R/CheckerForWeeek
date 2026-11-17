# Checker for Weeek — Developer Handoff

> Handoff date: 2026-11-17 · Version: 1.0.0 · Target: Chromium browsers — Microsoft Edge, Chrome, Opera (Manifest V3; developed and tested on Edge)
> Russian user-facing docs: [README.md](../README.md)
> Unofficial project — not affiliated with or endorsed by the service team. The service name is used only to indicate compatibility. Interface icons are based on Feather Icons (MIT). See the root README, NOTICE and PRIVACY.md.

## 1. What this is

An unpacked Chromium MV3 extension (runs in Microsoft Edge, Chrome, Opera; developed and tested on Edge) that tracks notifications for [app.weeek.net](https://app.weeek.net):

- Toolbar badge with the unread count (accent `#6C78F4`, white text, `99+` cap).
- Popup listing unread notifications (456px wide; Chromium caps popup height at 600px). Tile structure: **task name** (title, 1 line ellipsis) + an **info line** («who did what», 12px, one line ellipsis) + **snippet** (1–2 lines, CSS `-webkit-line-clamp` ellipsis) + optional **task path** row («Проект > Доска > Колонка», 9px, under a tile-wide divider). Ellipsized rows get tooltips with their OWN text only: hovering the title shows just the task name, hovering the message just the message. The tooltip is CUSTOM, not the native `title`: a singleton `.tooltip` div (fixed, `max-width: 320px`) fed from `data-tip` attributes on `.tile__title`, `.tile__snippet`, `.tile__info`, `.tile__path`. Text is FULL — no length or height cap. Shown via delegated `mouseover` ONLY when the row is actually truncated (`isRowTruncated`: scrollWidth for nowrap rows, scrollHeight for the line-clamped snippet), hidden on `mouseout`, list scroll and view switch; positioned under the row aligned to its LEFT edge, flipped above near the bottom edge. Only the kebab button keeps a native `title` («Действия»). Header h1: «Непрочитанные уведомления»; «Checker for Weeek» on the auth screen AND when the unread list is empty (context-driven `updateTitle()` in popup.js, called from `showState`/`showView`); «Настройки» on the settings view. The extension name is «Checker for Weeek».
- Clicking a tile (or a toast) **marks that notification read via POST** and opens the task in a new tab.
- Every tile has a hover-only `⋯` menu: `Прочитать` (POST read) and `Архивировать` (DELETE) — quiet actions that do NOT open any tab. Idle dots are gray (`var(--icon-idle)`), on button hover / open menu they turn accent `#6C78F4` (`var(--accent)`). No button background in either state. All three dots are identical, one color.
- **Settings view**: a settings button in the header (the Feather "sliders" icon, inline SVG, stroke `currentColor`) toggles between notifications and a settings screen in the SAME window (h1 «Настройки», counter hidden, `Esc` or a second click returns). Five settings stored in `chrome.storage.sync`, applied immediately, listed in popup.html row order:
  - poll interval (30s/1/5/10/30min/off → `pollIntervalSec`, 0 disables the alarm; hint under the label: «Расширение проверяет новые уведомления каждые:» while an interval is active, «Автопроверка выключена — уведомления проверяются при открытии попапа» when off);
  - theme picker (pills in a row under the interval → `theme`: «Системная»/«Светлая»/«Тёмная» = `auto`/`light`/`dark`; `auto` sets NO attribute — dark comes from the `prefers-color-scheme` media query alone, works even without JS; explicit choice → `applyTheme()` sets `data-theme="light|dark"` on `<html>`, the dark tokens are duplicated under `:root[data-theme="dark"]`, and every dark media selector is guarded with `:not([data-theme="light"])` so an explicit light theme wins on a dark system; dark theming touches ONLY the root token blocks — element-level dark rules are not used, recoloring flows through `--icon-idle`/`--skeleton-base`/`--scrollbar-track`/`--scrollbar-thumb`/`--surface-elevated` variables, enforced by `tests/test_css.py::test_dark_theme_overrides_variables_only` and `test_icon_idle_is_variable_and_hover_not_shadowed`; dark bg `#1A1B1D` is one step LIGHTER than surfaces `#131416`, `--surface-elevated` (dropdown/tooltip) steps above the bg at `#202225`; `tests/test_css.py::test_dark_bg_differs_from_surface` pins bg ≠ surface in both dark blocks);
  - sound on/off (`soundEnabled`);
  - browser toasts on/off (`toastEnabled`);
  - task path on/off (`showTaskPath`).
  
  Settings text is NOT selectable (`.settings` has `user-select: none` — same as header). Clicking ANYWHERE on a toggle row flips that row's switch: row-level click handlers call `input.click()` unless the click landed inside `.switch` — the `<label>` handles that natively, and the guard also swallows the synthetic click bubbling back from `input.click()`, so a click never double-toggles. Toggle rows show `cursor: pointer` and a hover highlight — `background: var(--surface-hover)` with a 0.15s transition. The interval picker is a one-row CSS grid (`grid-template-columns: repeat(5, 1fr) auto`): the five time pills share equal widths, «Отключить» sizes to content; pill padding is 8px horizontal so the equal pills fit the 414px row.
- Auth screen: single-line title «Войдите в Weeek» (plain text, `var(--text-1)` — follows the popup theme), hint text, and a plain «Войти» button that opens app.weeek.net; the header «Открыть Weeek» button is hidden on this screen (`showState()` in popup.js).
- Plays the project's own synthesized notification sound (two soft blips F5→C6) when the unread counter grows (unless disabled in settings).
- Shows native Windows toasts for new notifications (standard Windows duration, no timers).
- Thin 3px scrollbar (`::-webkit-scrollbar`, light: track `#e5e7ee` / thumb `#cacad2`; dark: transparent track / `rgba(217, 227, 242, 0.19)` thumb; colors flow through `--scrollbar-track`/`--scrollbar-thumb`); the scroll container is `main.body` (`body` is a flex column with a pinned header), so the bar lives strictly below the header.
- Popup theme follows `prefers-color-scheme` plus the explicit light/dark setting. UI strings use «Weeek» with a capital W everywhere (enforced by `test_brand_casing`); service references in code comments/identifiers stay lowercase «weeek»; only the `X-WEEEK-LANG` protocol header keeps its WEEEK casing.

**Hard invariant (product requirement):** showing the popup is GET-only and must never mark anything read. Reading happens exclusively on an explicit user click (tile/toast). Never add automatic read calls.

## 2. Layout

```
extension/            <- load THIS folder unpacked (edge://extensions, chrome://extensions, opera://extensions)
  manifest.json       <- MV3; description «Неофициальное расширение: счётчик и список непрочитанных уведомлений в Weeek (app.weeek.net).»; permissions: alarms, storage, cookies, offscreen, notifications
  background.js       <- service worker: polling, badge, cache, mark-read, sound, toasts
  popup/              <- popup.html / popup.css / popup.js (settings icon = inline SVG, the Feather "sliders" icon)
  offscreen/          <- offscreen document that plays audio (MV3 SW cannot play sound)
  sounds/             <- notification.wav (own synthesized sound: two blips F5→C6)
  icons/              <- PNG 16/32/48/128 — the project's own W mark (#016BFF)
docs/                 <- README.md (RU docs), this handoff
assets/               <- README screenshots (popup-*.png) + the W mark vector (logo-w.svg)
tests/                <- Python checks + HTML browser runners (see tests/README.md)
```

Root `README.md` is the public-facing page: features, screenshots, tests, legal notes.

## 3. How it talks to the service

The public API (`api.weeek.net/public/v1`, bearer-token) has **no notification endpoints**. The extension uses the cookie-authenticated API of `api.weeek.net` with the user's existing browser session:

| Call | Purpose | Notes |
|---|---|---|
| `GET https://api.weeek.net/user/profile/me` | unread counter | `notifications.unread.all` (and `.mentions`) |
| `GET https://api.weeek.net/notifications?limit=15&type=unread` | unread list | response body is `{success, data: [items], cursor: {nextToken}}` — **the payload IS the array**, not `{notifications: [...]}` |
| `POST https://api.weeek.net/notifications/{id}/read` | mark one read | requires CSRF (below) |
| `DELETE https://api.weeek.net/notifications/{id}` | archive one | requires CSRF (below); restore = `POST /{id}/restore` |

Other known endpoints (not used by the extension): `POST /notifications/{id}/unread`, `POST /notifications/{id}/restore`, `POST /notifications/read` (read all), `GET /notifications/channels`, settings under `/ws/{id}/notifications/settings`. Versioned prefixes (`/v1`, `/v2`, `/v3`) return 404 — the internal API has no version prefix.

**Auth/CSRF:** session cookies live on the `api.weeek.net` domain; every request uses `credentials: 'include'` plus header `X-WEEEK-LANG: ru`. POSTs additionally require the `X-XSRF-TOKEN` header — the extension reads the `XSRF-TOKEN` cookie via `chrome.cookies` (hence the `cookies` permission) and `decodeURIComponent`s its value.

**Notification object shape** (as returned by the list endpoint):

```
{
  id, type, isRead, createdAt,          // createdAt exists; store also uses it
  workspaceId,                          // TOP LEVEL, needed to build the task URL
  breadcrumbs: [                        // TOP LEVEL: the task path
    { type: 'entity', entity: { type: 'workspace'|'funnel'|'deal', title } },
    { type: 'task_locations', locations: [{ project: {id,title}, board?: {id,title}, boardColumn?: {id,title} }] }
  ],
  initiator: { name, type, user },
  body: { nodes: [                       // "lines" of the notification
    { type: 'initiator', initiator: { name } },
    { type: 'text',      text },
    { type: 'entity',    entity: { type: 'task', id, title } },  // <- task link
    { type: 'content',   content: { data: <editor doc>, mentions } },  // rich text (TipTap doc): comment body, reaction emoji
    { type: 'new_line' }, { type: 'task_locations' },            // breadcrumbs
    { type: 'datetime' | 'datetime_range' | 'task_priority' }
  ]}
}
```

- The task link is an `entity` node with `entity.type === 'task'` (`entity.id`, `entity.title`). There is no `data.task` field.
- A `content` node is a rich-text editor document (`content.data`), NOT a plain `text` field — `normalizeNotification()` walks the doc tree (`collectDocText`) collecting string `text` leaves; bare objects are skipped so tiles never show `[object Object]`. A `task_priority` node carries only a priority ID, so it stays skipped and the snippet is empty on priority-change tiles.
- Reaction notifications are type `task.comment.reacted` — the popup matches `/react/` for the heart icon.
- Task page SPA route: `/ws/{workspaceId}/task/{taskId}`.
- `normalizeNotification()` in background.js parses this into popup tiles `{id, type, title, info, snippet, taskPath, taskId, workspaceId, createdAt}` with fallbacks for older shapes; `DEBUG = true` logs one raw sample per SW lifetime.
- **Title/info split:** the task entity's title is captured into `taskName` and EXCLUDED from the parsed lines — `title` = task name only; the rest of line 1 becomes `info` («who did what») after `cleanInfoLine()` strips dangling quotes and the trailing task reference («…задачи», «…в задаче:»). NB: JS `\b` is ASCII-only and never matches around Cyrillic — the regex uses a space/preposition anchor instead. If the name arrives as a trailing `«…»` TEXT node instead of `entity.title`, it is extracted from the line tail. A de-dup drops `info` when the snippet repeats the same sentence.
- **Task path:** `extractTaskPath()` flattens top-level `breadcrumbs` into «Проект > Доска > Колонка» (`" > "` separator; a «Задачи» service word and the `workspace` entity are dropped; multiple locations → first + `+N`), capped at 200 chars; empty → no path row.

## 4. Behavior details

- **Polling:** `chrome.alarms` on an interval from settings (default 30s; `applyPollSchedule()` reads `pollIntervalSec` from `chrome.storage.sync`, 0 clears the alarm; 30s is the chrome.alarms floor, requires Chromium 120+) + immediate check on `onInstalled`/`onStartup`/every SW wake + on popup open (the popup sends a `week:refresh` message, which wakes the SW and triggers a fresh check; concurrent checks are guarded by `pollInFlight`). Settings changes reach the SW twice: the popup sends `week:settings-changed` AND `chrome.storage.onChanged` (sync) reschedules — covers cross-device sync. `401/403` → badge cleared, popup shows "log in" state; network errors leave badge/cache untouched. The popup itself always refreshes on open, even with polling off.
- **Sound:** `maybePlaySound()` compares the unread counter with `lastUnreadCount` (storage.session); plays only on an INCREASE, first check is silent, and only when `soundEnabled !== false` (chrome.storage.sync — the counter still updates so nothing accumulates). Playback goes through the offscreen document (permission `offscreen`; MV3 SW cannot play audio). Sound file is the project's own synthesized `notification.wav` (two soft blips F5→C6, peak ≈ −18 dBFS), volume 0.4.
- **Toasts:** `notifyNewItems()` compares tile ids with `seenIds` (first check silent), max 3 toasts per check, native Windows duration (NO setTimeout/clear anywhere — by design), `toastUrls` map (last 20) connects toastId → {apiId, taskId, workspaceId}. `onClicked` reuses the tile-click flow: `markNotificationRead()` → `markReadLocally()` (badge drops immediately) → `chrome.tabs.create`. If the POST fails, the badge is left alone and corrected by the next poll. When `toastEnabled` is false (chrome.storage.sync), toasts are skipped — BUT `seenIds` still absorbs the fresh ids, so re-enabling never floods old notifications retroactively.
- **Badge:** `#6C78F4` + white text, style applied at SW startup; empty text when count is 0; `99+` above 99. The pill shape is browser-controlled (no API).
- **Mark-read flow:** reads `XSRF-TOKEN` cookie → POST → on success removes the item from the cached list and decrements the cached counter/badge.
- **Tile kebab menu:** every tile has a hover-only `⋯` trigger (`.tile__menu`, top-right corner; the tile's timestamp fades out to make room). Click opens a dropdown (`Прочитать` with a check icon, `Архивировать` with an archive icon). Items `stopPropagation` + `runTileAction(item, 'week:mark-read' | 'week:archive')`: message to background, NO tab; the popup re-renders from `storage.session` (the background replies only after the request + local cache cleanup, so a failed request leaves the tile in place). Menus close on any other click (`closeAllMenus` on a document-level listener). Dropdown placement: the menu is SHOWN first, then measured (`hidden = false` and `tile--menu-open` are applied before measuring — a hidden element has no boxes): default is DOWNWARD; if its bottom would be clipped by the scrollable body, `tile__dropdown--up` flips it upward; if it doesn't fit upward either, the class is removed and `scrollIntoView({ block: 'nearest' })` brings the downward menu into view.
- **Popup layout:** `body` is a flex column — the header is PINNED, `main.body` scrolls (`flex:1; min-height:0`), so the thin scrollbar lives strictly below it. The icon sits flush in the 12px padding (`column-gap: 12px` — note: never combine `row-gap: 0` with a later `gap:` shorthand, the shorthand re-enables row-gap and silently pushed the path row down); text block is raised (`margin-top: -3px`); header text is non-selectable.
- **`hidden` vs author `display`:** the UA rule `[hidden] { display: none }` loses to ANY author rule that declares `display` on the element — `.list { display: flex }` silently defeats `showState()`'s `els.list.hidden = true`. Fixed with an explicit `.list[hidden] { display: none }` override; regression-guarded by `tests/test_css.py`. If you ever add a `display` declaration to `.state` or `.btn`, add the matching `[hidden]` override in the same breath.
- **Archive endpoint:** archiving is `DELETE /notifications/{id}` (NOT POST /archive; restore is `POST /{id}/restore`) — same CSRF headers as the read POST. After a successful DELETE the local cleanup is identical to read (`removeNotificationLocally`).

## 5. Flags (current state)

In `extension/background.js`:

- `DEBUG = false` — flips to `true` to log one raw notification sample per SW lifetime (`[weeek-ext] raw notification sample`) plus toast-flow lines (`toast flow: fresh = N`, `toast created`). Ships off.
- Polling is `chrome.alarms` 30 seconds only, plus the checks on SW wake and popup open. Note: 30s is the `chrome.alarms` floor; if a faster poll is ever needed, it must be an interval with the SW-lifetime caveats.

## 6. Development environment notes

- **No Node/npm toolchain by design** — Python 3.12 stdlib covers all checks; nothing to install.
- Git Bash mangles `$_` inside inline `powershell.exe -Command "..."` strings — write `.ps1` files instead of inline commands.
- Local preview of the popup: `python -m http.server 8741` from the repo root, open `http://127.0.0.1:8741/extension/popup/popup.html` (renders with demo data when `chrome.runtime` is absent); dark theme preview: set `data-theme="dark"` on `<html>` in devtools (or pick «Тёмная» in the popup settings).
- Icons: the popup carries no SVG brand assets (text-only header; the settings icon is the Feather "sliders" icon; plain-text «Войдите в Weeek» on the auth screen). Chromium rejects SVG in `manifest.icons`, so 16/32/48/128 PNGs are the project's own W logo (`#016BFF`, vector committed at `assets/logo-w.svg`).
- Releases: version ZIPs are published as GitHub Releases (see the repo's Releases page).

## 7. If the API changes

All requests live in `extension/background.js` (`fetchJSON`, `extractUnread`, `normalizeNotification`). The internal API is undocumented and may change — fix mapping there only. `DEBUG = true` logs one raw sample for field-mapping checks.

## 8. Legal / privacy pointers

- Unofficial project; see root README, NOTICE, PRIVACY.md.
- MIT for the code, the W mark and the notification sound; Feather Icons (MIT) for interface icons.
- No analytics, no telemetry; requests go only to `api.weeek.net` and `app.weeek.net` with the user's session cookies.
- The internal API is undocumented. [Weeek Terms of Use](https://weeek.net/ru/documents/useofagreement) (cl. 3.5–3.6) allow access via the Site or the official Application; a third-party browser extension is not in that list. Default poll is 30 s (cl. 4.9.7 — do not disrupt the site). Use at your own risk; MIT does not cover the Weeek brand or the internal API.
