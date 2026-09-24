/**
 * dsh-plugin-poker — the host half's loader entry, and the reason editing this
 * plugin no longer needs a host restart.
 *
 * This file is deliberately small and stable. It owns everything that must
 * outlive an edit:
 *
 * - the live-table registry (`TABLES` + the one `CURRENT_TABLE` every session
 *   shares), so a reload keeps the hand in progress AND every conversation keeps
 *   looking at the same game;
 * - the six tool registrations and the browser route, which Cordis mounts once;
 * - a revision-stamped importer for `lib/impl.js`.
 *
 * Everything else — the operations, the text the model reads, the payloads —
 * lives in `lib/impl.js` and its imports (`engine.js`, `bots.js`, `cards.js`,
 * `evaluator.js`, `render.js`). Node caches ES modules for the life of the
 * process, so an edit used to require a full restart (which drops every table
 * and interrupts the session). Instead, every tool call and every browser request
 * checks the revision of those six files (mtime + size). When it changes they are
 * copied into a fresh snapshot directory under the OS temp dir and imported from
 * THERE, so the new code and all of its relative imports come from one consistent
 * revision — never a mix of old and new modules.
 *
 * What still needs a restart: a change to THIS file (the tool roster, the route,
 * the table registry) or to `cordis.patch.yml`'s row. Everything a player or a
 * fix touches is hot.
 * @module dsh-plugin-poker
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Cordis plugin name. */
export const name = 'poker';

/** The tool registry is required; the web server is optional (see `apply`). */
export const inject = ['tools'];

/** The same-origin route the browser panel acts through. */
export const POKER_PATH = '/poker';

/** This file's directory: the package's `lib/`. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The implementation files, in load order. Their revision decides when to
 * re-import; `impl.js` pulls the rest in through plain relative imports, which
 * the staged snapshot keeps on one revision.
 */
const IMPL_FILES = ['impl.js', 'ai.js', 'settings.js', 'gto.js', 'update.js', 'coach.js', 'engine.js', 'bots.js', 'cards.js', 'evaluator.js', 'render.js'];

/**
 * The version this install is running, read from the package's own manifest.
 *
 * Read once and cached: it cannot change without a host restart, and the settings page
 * compares it against GitHub's newest tag.
 * @returns a version string, or '0.0.0' when the manifest is unreadable.
 */
let installedVersion = null;
function currentVersion() {
  if (installedVersion !== null) return installedVersion;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    installedVersion = String(manifest.version || '0.0.0');
  } catch {
    installedVersion = '0.0.0';
  }
  return installedVersion;
}

/** How many staged revisions to keep for inspection before pruning the rest. */
const KEEP_STAGES = 4;

/** One stage root per install, so two copies of the plugin never share a snapshot. */
const STAGE_ROOT = path.join(os.tmpdir(), `dsh-plugin-poker-hot-${fingerprint(HERE)}`);

/**
 * The plugin's settings, used when the host has no settings service (a headless
 * profile). With the service present the values live in the host user-settings
 * document instead, and this is only the last-resort default.
 */
let memorySettings = {};

/**
 * Every live table, keyed by its opaque `tableId`.
 *
 * The browser panel holds this id and acts on the game through the plugin's own
 * HTTP route, so a click changes the table WITHOUT a chat message and without a
 * model turn. The id is random per table, which is what scopes the route: a
 * request can only reach a table whose id the page was already given.
 *
 * This map lives in the entry file on purpose: it survives every reload of the
 * implementation, so hot-reloading a strategy fix does not fold the hand.
 */
const TABLES = new Map();

/**
 * The table everything shares, as a table id.
 *
 * There is deliberately ONE live table per host, not one per session: the player
 * switches between chats, and a poker table that silently changed under them (or
 * vanished) because they moved to another conversation would be broken. Any
 * session may open a table (which replaces this one), any session may act on it,
 * and the model's tools answer about the same table the browser is showing.
 */
let CURRENT_TABLE = null;

/** The plugin's host context, captured at activation for the browser route. */
let hostCtx = null;

// ---- the live-code loader -------------------------------------------------

/** A short, stable hash of a path, for the per-install stage root. */
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** The current `{ file -> { mtime, size } }` map of the implementation files. */
function stamps() {
  const result = new Map();
  for (const file of IMPL_FILES) {
    try {
      const info = fs.statSync(path.join(HERE, file));
      result.set(file, { mtime: info.mtimeMs, size: info.size });
    } catch {
      // A file that is not there cannot pin the revision.
    }
  }
  return result;
}

/**
 * The revision string for one stamp map: every file's mtime and size, hashed.
 *
 * Every file contributes on purpose. Taking only the newest mtime would miss an
 * edit to a file whose clock lands below another one's (a touch, a checkout, a
 * clock that stepped), and a stage directory named after a revision that did not
 * change would keep serving the old code.
 */
function revisionOf(map) {
  return fingerprint(IMPL_FILES.map((file) => {
    const info = map.get(file);
    return info ? `${file}:${info.mtime}:${info.size}` : `${file}:-`;
  }).join('|'));
}

/** Copy the current implementation into `STAGE_ROOT/<rev>/` and return that dir. */
function stage(rev) {
  const dir = path.join(STAGE_ROOT, rev);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of IMPL_FILES) {
    const from = path.join(HERE, file);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, file));
  }
  // The copies are ESM, but a staged `.js` file does NOT inherit this package's
  // `"type": "module"` - module type is resolved from the file's OWN directory
  // upwards, and the stage lives under the OS temp dir, where the nearest
  // package.json is nothing of ours (usually none at all). Without this manifest
  // the import is treated as CommonJS and every `import` line is a syntax error -
  // which is exactly how a reload used to fail under some runners but not others.
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
  return dir;
}

/** Drop the oldest snapshots, keeping the most recent few for inspection. */
function prune() {
  let entries;
  try {
    entries = fs.readdirSync(STAGE_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      dirs.push({ name: entry.name, at: fs.statSync(path.join(STAGE_ROOT, entry.name)).mtimeMs });
    } catch {
      // A snapshot that vanished under us needs no pruning.
    }
  }
  if (dirs.length <= KEEP_STAGES) return;
  dirs.sort((left, right) => right.at - left.at);
  for (const stale of dirs.slice(KEEP_STAGES)) {
    try {
      fs.rmSync(path.join(STAGE_ROOT, stale.name), { recursive: true, force: true });
    } catch {
      // A busy snapshot is left for the next prune.
    }
  }
}

/** The implementation revision currently loaded, as `{ rev, stamps, module }`. */
let loaded = null;

/** An in-flight reload, so concurrent calls share one import. */
let loading = null;

/** The revision whose import failed last, so a half-saved file is reported once. */
let lastFailure = '';

/** The most recent load failure message, for diagnostics and tests. */
let lastError = '';

/** The most recent successful reload, reported to the player once. */
let reloadNotice = null;

/** Log through the host's logger, never letting logging break a game. */
function note(message, level = 'info') {
  try {
    const logger = (hostCtx && hostCtx.logger)
      || (hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('logger') : undefined);
    if (!logger) return;
    const write = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
    if (typeof write === 'function') write(message);
  } catch {
    // Ignored on purpose.
  }
}

/** Import one revision, staging a snapshot when that is possible. */
async function loadFromDisk(rev) {
  let dir = null;
  try {
    dir = stage(rev);
  } catch (error) {
    // A read-only or unwritable temp dir must not take the table down: importing
    // in place keeps the plugin working, only without the reload.
    note(`poker: 无法建立热重载快照（${error && error.message ? error.message : error}），改为原地加载`, 'warn');
  }
  const target = dir === null ? './impl.js' : pathToFileURL(path.join(dir, 'impl.js')).href;
  const module = await import(target);
  return { rev, module, staged: dir !== null };
}

/**
 * The implementation module for the code as it stands on disk right now.
 *
 * Cheap in the common case (six `statSync` calls and a string compare) and the
 * only entry point into the poker logic. A failed import keeps the last working
 * revision in place, so a syntax error mid-edit never breaks the running game.
 * @returns the implementation module.
 */
async function impl() {
  const map = stamps();
  const rev = revisionOf(map);
  if (loaded && loaded.rev === rev) return loaded.module;
  if (loading) return loading;
  loading = (async () => {
    try {
      const next = await loadFromDisk(rev);
      const changed = loaded === null
        ? []
        : [...map].filter(([file, info]) => loaded.stamps.get(file)?.mtime !== info.mtime).map(([file]) => file);
      const previous = loaded;
      loaded = { ...next, stamps: map };
      lastFailure = '';
      lastError = '';
      if (previous !== null) {
        const at = new Date();
        const clock = at.toLocaleTimeString('zh-CN', { hour12: false });
        note(`poker: 已热重载 ${changed.length > 0 ? changed.join(', ') : 'lib/*.js'}（${clock}）——下一次点击/工具调用即生效`);
        reloadNotice = { at: at.getTime(), clock, files: changed };
        if (next.staged) prune();
      }
      return next.module;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      lastError = message;
      if (lastFailure !== rev) {
        lastFailure = rev;
        note(`poker: 改动无法加载，继续使用上一份可用代码 —— ${message}`, 'warn');
      }
      if (loaded) return loaded.module;
      throw error;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * What the live-code loader is doing, for tests and for a stuck reload.
 * @returns `{ revision, loaded, staged, lastError }`.
 */
export function hotState() {
  return {
    revision: revisionOf(stamps()),
    loaded: loaded === null ? null : loaded.rev,
    staged: loaded === null ? false : loaded.staged,
    lastError,
  };
}

/** Hand the "your edit is live" marker to the next payload, then forget it. */
function takeReloadNotice() {
  const notice = reloadNotice;
  reloadNotice = null;
  return notice;
}

// ---- live tables ----------------------------------------------------------

/** Monotonic counter behind {@link newTableId}. */
let tableCounter = 0;

/** A fresh opaque table id. */
function newTableId() {
  tableCounter += 1;
  return `t${tableCounter}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The live table, whichever session is asking.
 *
 * Sessions do not own tables: the table is a single shared object, so a tool call
 * from any conversation (and a click from any browser panel) acts on the same
 * game. Opening a new table replaces it for everyone.
 * @returns the current table.
 * @throws a model-readable error when no table has been opened yet.
 */
function requireTable() {
  const table = CURRENT_TABLE === null ? undefined : TABLES.get(CURRENT_TABLE);
  if (!table) throw new Error('\u8fd8\u6ca1\u6709\u724c\u684c\uff0c\u8bf7\u5148\u8c03\u7528 poker_new_table \u5f00\u5c40');
  return { table };
}

/** The current table, or undefined - used by the browser route's discovery op. */
function currentTable() {
  return CURRENT_TABLE === null ? undefined : TABLES.get(CURRENT_TABLE);
}

/** Resolve the table one browser request names. */
function tableById(tableId) {
  const table = typeof tableId === 'string' ? TABLES.get(tableId) : undefined;
  if (!table) throw new Error('\u724c\u684c\u5df2\u4e0d\u5b58\u5728\uff08\u5bbf\u4e3b\u91cd\u542f\u540e\u724c\u5c40\u4f1a\u6d88\u5931\uff09\uff0c\u8bf7\u91cd\u65b0\u5f00\u684c');
  return table;
}

/**
 * Whether the teaching layer is switched on, read straight from the settings.
 *
 * Read here rather than threaded through every call site: the flag rides on the
 * table, so every surface - tools, route, card payload - agrees without each of them
 * having to know about settings.
 * @returns true when the coach should be computed.
 */
function coachEnabledNow() {
  try {
    const settings = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('settings') : undefined;
    const section = settings && typeof settings.get === 'function' ? settings.get('poker') : undefined;
    if (section && section.coachEnabled === false) return false;
    if (memorySettings && memorySettings.coachEnabled === false) return false;
  } catch {
    // A settings service that throws is not a reason to lose the coach.
  }
  return true;
}

/**
 * Which coach the player asked for: `simple` (rule of thumb) or `gto` (ranges and EV).
 * @returns the mode string.
 */
function coachModeNow() {
  try {
    const settings = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('settings') : undefined;
    const section = settings && typeof settings.get === 'function' ? settings.get('poker') : undefined;
    const mode = (section && section.coachMode) || (memorySettings && memorySettings.coachMode);
    return mode === 'gto' ? 'gto' : 'simple';
  } catch {
    return 'simple';
  }
}

/**
 * Store one game back into the registry, advancing its revision and making it THE
 * current table (every session sees it).
 *
 * The revision is the client's merge key: the panel keeps whichever view it saw
 * is newest, whether that came from the session log or from this route.
 * @param table - the state to store.
 */
function saveTable(table) {
  table.revision = (table.revision ?? 0) + 1;
  // The plugin's own switches travel with the table, so the coach and the AI seats
  // are decided once per save instead of at each of the dozen call sites.
  table.coachEnabled = coachEnabledNow();
  table.coachMode = coachModeNow();
  TABLES.set(table.tableId, table);
  CURRENT_TABLE = table.tableId;
  return table;
}

// ---- the browser route ----------------------------------------------------

/** Largest accepted request body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Answer one request with JSON. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Read a small JSON request body. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('\u8bf7\u6c42\u4f53\u8fc7\u5927');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Serve `/poker/<op>`.
 *
 * This is how the browser panel plays without chatting: a click posts the
 * table id and one action, the engine advances, and the answer carries the new
 * view. The route is deliberately narrow — it only ever touches the one table
 * whose opaque id the caller already holds, and it never writes to a session.
 * @param req - incoming request.
 * @param res - response owned by this handler.
 */
export async function handlePokerRequest(req, res) {
  try {
    // Everything here is a POST - an action, a table read, a settings patch - except
    // reading the settings, which the settings page fetches with a GET.
    const method = (req.method ?? 'POST').toUpperCase();
    const settingsRead = method === 'GET' && /\/settings\/?$/.test(String(req.url ?? ''));
    if (method !== 'POST' && !settingsRead) {
      sendJson(res, 405, { ok: false, error: 'this route only serves POST' });
      return;
    }
    const url = new URL(req.url ?? POKER_PATH, 'http://dsh.invalid');
    const op = url.pathname.slice(POKER_PATH.length).replace(/^\/+/, '').replace(/\/+$/, '');
    const body = await readJsonBody(req);
    // Resolved per request: an edit is picked up by the next click.
    const m = await impl();
    if (op === 'settings') {
      // The plugin's settings surface. GET reports the values AND the field
      // descriptors (group, control kind, bounds, help) so the page draws itself -
      // adding a setting means adding it to `settings.js`, not to the client bundle.
      // The API key is never echoed back: only whether one is stored.
      if (!hasSettingsSurface(m)) {
        sendJson(res, 503, { ok: false, error: '\u8bbe\u7f6e\u6a21\u5757\u9700\u8981\u91cd\u65b0\u52a0\u8f7d\uff08\u91cd\u542f\u4e00\u6b21 dsh web\uff09' });
        return;
      }
      if ((req.method ?? 'GET').toUpperCase() === 'POST') {
        // Turning AI seats ON with no key configured is allowed (the player may be
        // about to type one); the seats simply fall back until the key works.
        const saved = await m.writeSettings(hostCtx, m.pickSettings(body), memorySettings);
        memorySettings = saved;
        await applySettingsToTable(saved);
        const publicView = m.publicSettings(saved);
        // `applied` is what the HOST is running right now, which is the only way a page
        // can tell "saved" from "saved and in force": a host that predates a setting
        // reports nothing here, and the page can say so instead of leaving the player
        // clicking a switch that appears to do nothing.
        sendJson(res, 200, {
          ok: true,
          settings: publicView,
          groups: m.settingsForm(publicView, { version: currentVersion() }),
          applied: { coachMode: coachModeNow(), coachEnabled: coachEnabledNow() },
        });
        return;
      }
      const current = settingsOf(m);
      const publicView = m.publicSettings ? m.publicSettings(current) : current;
      sendJson(res, 200, {
        ok: true,
        settings: publicView,
        version: currentVersion(),
        groups: m.settingsForm ? m.settingsForm(publicView, { version: currentVersion() }) : [],
      });
      return;
    }
    if (op === 'update-check') {
      // "Is there a newer release?" The answer is lines the page prints verbatim, so
      // the settings page never has to know anything about GitHub.
      if (typeof m.checkForUpdate !== 'function') {
        sendJson(res, 503, { ok: false, error: '\u66f4\u65b0\u68c0\u67e5\u9700\u8981\u91cd\u65b0\u52a0\u8f7d\uff08\u91cd\u542f\u4e00\u6b21 dsh web\uff09' });
        return;
      }
      const settings = body && Object.keys(body).length > 0
        ? m.normaliseSettings({ ...settingsOf(m), ...m.pickSettings(body) })
        : settingsOf(m);
      const result = await m.checkForUpdate({
        current: currentVersion(),
        repo: settings.updateRepo,
        force: body && body.force === true,
      });
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (op === 'settings-test') {
      // "Does this endpoint actually work?" The player is asking, so nothing falls
      // back here: the answer is either a round-trip time plus what the model said,
      // or the real error.
      if (!hasAiSurface(m)) {
        sendJson(res, 503, { ok: false, error: 'AI \u6a21\u5757\u9700\u8981\u91cd\u65b0\u52a0\u8f7d\uff08\u91cd\u542f\u4e00\u6b21 dsh web\uff09' });
        return;
      }
      const settings = body && Object.keys(body).length > 0
        ? m.normaliseSettings({ ...settingsOf(m), ...m.pickSettings(body) })
        : settingsOf(m);
      const result = await m.testConnection({ settings });
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (op === 'new') {
      // Opening a table straight from the GUI. The table is dealt PAUSED - the
      // player presses 开始 and only then do the opponents move, one beat at a
      // time, instead of a fully-played street landing before they can look at
      // their own cards. It becomes THE shared table, so every other session
      // (and the model's tools) immediately sees it too.
      const routeDefaults = settingsOf(m);
      const state = saveTable(m.opNew(body, {
        paused: true,
        aiSeats: routeDefaults.aiEnabled === true ? routeDefaults.aiSeats : 0,
        defaults: routeDefaults,
      }));
      sendJson(res, 200, {
        ok: true,
        view: m.buildView(state),
        text: m.renderTable(state, m.HERO_SEAT),
        steps: state.actionLog,
        note: `\u5bf9\u624b\uff1a${m.roster(state)}`,
      });
      driveAiSeats();
      return;
    }
    if (op === 'current') {
      // What the browser asks when a session has nothing of its own to show: the
      // one table this host is playing, or null when nobody has opened one. This
      // is what keeps two conversations looking at the same game.
      const table = currentTable();
      sendJson(res, 200, table
        ? { ok: true, view: m.buildView(table), text: m.renderTable(table, m.HERO_SEAT), steps: table.actionLog }
        : { ok: true, view: null });
      return;
    }
    if (op === 'table') {
      const table = tableById(body.tableId);
      sendJson(res, 200, { ok: true, view: m.buildView(table), text: m.renderTable(table, m.HERO_SEAT), steps: table.actionLog });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(m.POKER_OPS, op)) {
      sendJson(res, 404, { ok: false, error: `unknown poker operation: ${op}` });
      return;
    }
    const table = tableById(body.tableId);
    const next = saveTable(m.POKER_OPS[op](table, body));
    // `steps` is the whole hand's action log: the browser replays only the
    // entries whose `seq` it has not shown, so each opponent move gets its own
    // beat instead of the whole street resolving in one jump.
    sendJson(res, 200, { ok: true, view: m.buildView(next), text: m.renderTable(next, m.HERO_SEAT), steps: next.actionLog });
    // Any op can leave the table waiting on an AI seat; the answer arrives later, so
    // the browser polls `current` until the revision moves.
    driveAiSeats();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendJson(res, 400, { ok: false, error: message });
  }
}

/**
 * Point the live table at the configuration just saved.
 *
 * Settings that a RUNNING table cares about - the AI seats, the coach switch, the coach
 * style - only reach the table when it is saved, because `saveTable` is what stamps
 * them onto it. So a settings write re-saves the table on purpose: switching the coach
 * style from the coach window has to change the analysis on screen, not just the next
 * table. The revision bump is also what tells every open panel to re-read it.
 * @param settings - the configuration just saved.
 * @returns nothing.
 */
async function applySettingsToTable(settings) {
  const table = currentTable();
  if (!table) return;
  const seats = settings.aiEnabled === true ? settings.aiSeats : 0;
  const bots = Math.max(0, (Array.isArray(table.players) ? table.players.length : 1) - 1);
  table.aiSeats = Array.from({ length: Math.max(0, Math.min(bots, seats)) }, (_, index) => index + 1);
  saveTable(table);
  driveAiSeats();
}

/**
 * The settings view, tolerant of an implementation that predates the settings module.
 *
 * A hot reload can pair this entry with a staged `impl.js` that does not export the
 * helpers yet, and a missing export must never take the tools down: the defaults
 * simply apply (everything on, AI off).
 * @param m - the implementation module.
 * @returns a complete settings object.
 */
function settingsOf(m) {
  const fallback = { pluginEnabled: true, coachEnabled: true, aiEnabled: false, aiSeats: 0 };
  if (!m || typeof m.readSettings !== 'function') return fallback;
  try {
    return m.readSettings(hostCtx, memorySettings);
  } catch {
    return fallback;
  }
}

/** How many opponent seats the AI should own, per the current settings. */
function aiSeatCount(m) {
  const settings = settingsOf(m);
  return settings.aiEnabled === true ? Math.max(0, Number(settings.aiSeats) || 0) : 0;
}

/** Whether the implementation carries the settings surface at all. */
function hasSettingsSurface(m) {
  return Boolean(m)
    && typeof m.readSettings === 'function'
    && typeof m.writeSettings === 'function'
    && typeof m.pickSettings === 'function'
    && typeof m.publicSettings === 'function'
    && typeof m.settingsForm === 'function'
    && Array.isArray(m.SETTING_GROUPS);
}

/** Whether the implementation carries the AI surface at all. */
function hasAiSurface(m) {
  return Boolean(m)
    && typeof m.askAi === 'function'
    && typeof m.opResumeAi === 'function'
    && typeof m.testConnection === 'function';
}

/**
 * Play the seats the AI owns, one HTTP answer at a time.
 *
 * The engine stops when the seat on turn is an AI seat, so this walks the pauses:
 * ask, apply, advance - until the hero is on turn, the hand ends, or the endpoint
 * stops answering (in which case the heuristic policy takes each remaining seat).
 * Fire-and-forget by design: the player's click must return immediately, and the
 * browser polls until the table's revision moves.
 * @returns nothing; the table's revision moves as answers land.
 */
function driveAiSeats() {
  const table = currentTable();
  if (!table || table.aiDriving === true) return;
  const pending = table.pendingDecision;
  if (!pending || pending.kind !== 'ai') return;
  table.aiDriving = true;
  (async () => {
    let guard = 0;
    try {
      while (guard < 60) {
        guard += 1;
        const m = await impl();
        const waiting = table.pendingDecision;
        if (!waiting || waiting.kind !== 'ai') break;
        if (!hasAiSurface(m)) break;
        const settings = settingsOf(m);
        if (settings.aiEnabled !== true) break;
        const decision = await m.askAi({
          settings,
          state: table,
          seat: waiting.seat,
          legal: waiting.legal,
        });
        // A null answer is normal (offline, timeout, nonsense): the heuristic plays.
        const next = m.opResumeAi(table, decision);
        Object.assign(table, next);
        table.revision = (table.revision ?? 0) + 1;
      }
    } catch (error) {
      // Never let a background turn break the table: seats that were not answered
      // simply keep their heuristic policy.
      if (typeof console !== 'undefined') console.warn('poker: the AI turn stopped early', error);
    } finally {
      table.aiDriving = false;
      prune();
    }
  })();
}

/**
 * Mount the browser route when this deployment has a web server. Optional on
 * purpose: profiles without one (TUI, headless) keep every tool, and the panel
 * simply falls back to submitting prompts.
 * @param ctx - plugin context.
 * @param disposers - collector for the route disposer.
 */
function mountHttpRoute(ctx, disposers) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (!webServer || typeof webServer.register !== 'function') return;
  disposers.push(webServer.register({ kind: 'prefix', path: POKER_PATH, handler: handlePokerRequest }));
}

// ---- the tool roster ------------------------------------------------------

/**
 * Wrap a definition in the shared payload-based output contract.
 *
 * The roster, the schemas and the descriptions are the one part of the plugin
 * that still needs a restart to change: they are what Cordis registers. Every
 * word the MODEL reads about the current table comes from the payload the
 * implementation builds, so it reloads with the code.
 */
function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: { type: 'object', properties: definition.properties ?? {}, additionalProperties: false, ...(definition.required ? { required: definition.required } : {}) },
    output: {
      // The canonical value is this plugin's own view object; a permissive
      // schema keeps the value lossless without restating every field here.
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ view: value.view, kind: definition.name }),
    },
    execute: definition.execute,
    presentCall: definition.presentCall ?? ((args) => ({ card: 'generic', title: definition.title ?? definition.name, kind: 'other', rawInput: args })),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
    isConcurrencySafe: () => false,
  };
}

/** The bot style keys, mirrored from `lib/bots.js` for the tool description. */
const STYLE_HINT = 'rock/tag/lag/station/maniac/pro';

/** Register every poker tool on the shared tool registry. */
export function apply(ctx) {
  const registry = ctx.tools;
  const disposers = [];
  hostCtx = ctx;

  // The route is mounted through an optional injection so a profile without a
  // web server still activates the plugin (and its tools) normally.
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], () => mountHttpRoute(ctx, disposers));
    else mountHttpRoute(ctx, disposers);
  } catch {
    mountHttpRoute(ctx, disposers);
  }

  // The plugin's settings (AI opponents and their endpoint) live in the host
  // user-settings document when that service is composed, so they survive restarts
  // and show up in the settings UI. A headless profile keeps them in memory.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['settings'], () => { void impl().then((m) => m.registerSettings(ctx)).catch(() => {}); });
    }
  } catch {
    // Optional service: the defaults still apply.
  }

  const register = (definition) => {
    disposers.push(registry.register(tool(definition)));
  };

  register({
    name: 'poker_new_table',
    title: '\u5f00\u4e00\u684c\u5fb7\u5dde\u6251\u514b',
    description:
      '\u5f00\u4e00\u5f20\u5fb7\u5dde\u6251\u514b\u724c\u684c\uff08\u7121\u9650\u6ce8\u4e0d\u9650\u6ce8\uff09\u5e76\u53d1\u724c\u3002\u73a9\u5bb6\uff08\u4eba\u7c7b\uff09\u5750 0 \u53f7\u5e2d\u4f4d\uff0c\u5176\u4f59\u5e2d\u4f4d\u7531\u5185\u7f6e\u7b56\u7565\u673a\u5668\u4eba\u5360\u636e\u3002\u4e00\u4e2a\u4f1a\u8bdd\u53ea\u7ef4\u62a4\u4e00\u5f20\u724c\u684c\uff0c\u91cd\u65b0\u8c03\u7528\u4f1a\u91cd\u5f00\u4e00\u5c40\u3002\u8c03\u7528\u540e\u9ed8\u8ba4\u81ea\u52a8\u8dd1\u5b8c\u673a\u5668\u4eba\u7684\u884c\u52a8\uff0c\u76f4\u5230\u8f6e\u5230\u73a9\u5bb6\u3002',
    properties: {
      heroName: { type: 'string', description: '\u73a9\u5bb6\u6635\u79f0\uff0c\u9ed8\u8ba4\u201c\u73a9\u5bb6\u201d\u3002' },
      botCount: { type: 'integer', description: '\u673a\u5668\u4eba\u6570\u91cf 1-8\uff08\u5373 2-9 \u4eba\u684c\uff09\uff0c\u9ed8\u8ba4 5\uff08\u516d\u4eba\u684c\uff09\uff1b\u586b 8 \u5c31\u662f\u4e5d\u4eba\u5168\u73af\u3002' },
      botStyles: { type: 'string', description: `\u673a\u5668\u4eba\u6027\u683c\uff0cmixed \u6216\u9017\u53f7\u5217\u8868\uff08${STYLE_HINT}\uff09\uff0c\u9ed8\u8ba4 mixed\u3002` },
      startingStack: { type: 'integer', description: '\u8d77\u59cb\u7b79\u7801\uff0c\u9ed8\u8ba4 10000\u3002' },
      smallBlind: { type: 'integer', description: '\u5c0f\u76f2\uff0c\u9ed8\u8ba4 50\u3002' },
      bigBlind: { type: 'integer', description: '\u5927\u76f2\uff0c\u9ed8\u8ba4 100\u3002' },
      botBrain: { type: 'string', enum: ['auto', 'model'], description: 'auto=\u5185\u7f6e\u7b56\u7565\u81ea\u52a8\u51fa\u724c\uff1bmodel=\u7531\u4f60\u9010\u624b\u4e3a\u673a\u5668\u4eba\u51b3\u7b56\u3002\u9ed8\u8ba4 auto\u3002' },
      seed: { type: 'integer', description: '\u968f\u673a\u79cd\u5b50\uff08\u53ef\u590d\u73b0\u724c\u5c40\uff09\uff0c\u53ef\u9009\u3002' },
    },
    execute: async (args) => {
      const m = await impl();
      const defaults = settingsOf(m);
      const started = saveTable(m.opNew(args, {
        aiSeats: defaults.aiEnabled === true ? defaults.aiSeats : 0,
        defaults,
      }));
      const body = m.payload(started, { note: `\u5bf9\u624b\uff1a${m.roster(started)}\u3002\u724c\u684c\u5df2\u5f00\uff0c\u672c\u624b\u724c\u5df2\u53d1\u3002` });
      driveAiSeats();
      return withReloadNotice(body);
    },
  });

  register({
    name: 'poker_action',
    title: '\u73a9\u5bb6\u51fa\u724c',
    description:
      '\u4ee3\u8868\u73a9\u5bb6\uff08\u4eba\u7c7b\u5e2d\u4f4d\uff09\u6267\u884c\u4e00\u4e2a\u52a8\u4f5c\uff1a fold \u5f03\u724c\u3001check \u8fc7\u724c\u3001call \u8ddf\u6ce8\u3001bet/raise \u4e0b\u6ce8\u6216\u52a0\u6ce8\u3001allin \u5168\u4e0b\u3002raise/bet \u7684 amount \u662f\u201c\u672c\u8f6e\u603b\u989d\u201d\uff08\u5373\u201c\u52a0\u6ce8\u5230 X\u201d\uff09\uff0c\u4e0d\u662f\u52a0\u6ce8\u5dee\u989d\u3002\u4f60\u53ea\u80fd\u5728\u8f6e\u5230\u73a9\u5bb6\u65f6\u4ee3\u4ed6\u884c\u52a8\uff0c\u4e14\u5fc5\u987b\u5148\u5f81\u5f97\u73a9\u5bb6\u540c\u610f\u3002',
    properties: {
      action: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise', 'allin'], description: '\u52a8\u4f5c\u3002' },
      amount: { type: 'integer', description: 'bet/raise \u5fc5\u586b\uff1a\u672c\u8f6e\u603b\u6295\u6ce8\u989d\uff08\u201c\u52a0\u6ce8\u5230\u201d\uff09\u3002' },
      talk: { type: 'string', description: '\u73a9\u5bb6\u7684\u53e3\u5934\u5e72\u6270\uff08\u53ef\u9009\uff09\u3002' },
    },
    required: ['action'],
    execute: async (args) => {
      const m = await impl();
      const { table } = requireTable();
      return withReloadNotice(m.payload(saveTable(m.opAction(table, args))));
    },
  });

  register({
    name: 'poker_next_hand',
    title: '\u5f00\u59cb\u4e0b\u4e00\u624b\u724c',
    description:
      '\u5f53\u524d\u724c\u5c40\u5df2\u7ed3\u675f\uff08\u644a\u724c\u6216\u5f03\u724c\u5b9a\u80dc\u8d1f\uff09\u540e\uff0c\u53d1\u4e0b\u4e00\u624b\u724c\u3002\u82e5\u73a9\u5bb6\u6ca1\u724c\u4e86\uff0c\u6216\u53ea\u5269\u4e00\u4eba\u6709\u7b79\u7801\uff0c\u5219\u724c\u5c40\u7ed3\u675f\u3002',
    execute: async () => {
      const m = await impl();
      const { table } = requireTable();
      return withReloadNotice(m.payload(saveTable(m.opNextHand(table))));
    },
  });

  register({
    name: 'poker_table',
    title: '\u67e5\u770b\u724c\u684c',
    description:
      '\u8bfb\u53d6\u5f53\u524d\u724c\u684c\u72b6\u6001\uff1a\u5e95\u724c\u3001\u516c\u5171\u724c\u3001\u5e95\u6c60\u3001\u5404\u5bb6\u7b79\u7801\u4e0e\u672c\u8f6e\u52a8\u4f5c\u3001\u53ef\u9009\u884c\u52a8\u3001\u6700\u8fd1\u724c\u5c40\u8bb0\u5f55\u3002\u73a9\u5bb6\u95ee\u201c\u73b0\u5728\u4ec0\u4e48\u60c5\u51b5\u201d\u6216\u4f60\u9700\u8981\u786e\u8ba4\u72b6\u6001\u65f6\u8c03\u7528\u3002',
    properties: {
      reveal: { type: 'boolean', description: '\u4ec5\u4f9b\u8c03\u8bd5\uff1a\u663e\u793a\u6240\u6709\u673a\u5668\u4eba\u5e95\u724c\uff08\u4e0d\u8981\u5728\u6b63\u5e38\u5bf9\u5c40\u4e2d\u4f7f\u7528\uff09\u3002' },
    },
    execute: async (args) => {
      const m = await impl();
      const { table } = requireTable();
      return withReloadNotice(m.tablePayload(table, args));
    },
  });

  register({
    name: 'poker_opponent',
    title: '\u673a\u5668\u4eba\u51b3\u7b56',
    description:
      '\u4e24\u79cd\u7528\u6cd5\uff1a\uff081\uff09\u4ec5\u4f20 brain\uff1a\u5207\u6362\u673a\u5668\u4eba\u8111\u888b\uff0cmodel=\u6bcf\u4e2a\u673a\u5668\u4eba\u884c\u52a8\u90fd\u4ea4\u7ed9\u4f60\u51b3\u5b9a\uff08\u4f1a\u62ff\u5230\u5b83\u7684\u5e95\u724c\u4e0e\u5408\u6cd5\u9009\u9879\uff0c\u4e0d\u8981\u5411\u73a9\u5bb6\u6cc4\u9732\uff09\uff1bauto=\u4ea4\u56de\u5185\u7f6e\u7b56\u7565\u3002\uff082\uff09\u5e26 action\uff1a\u4e3a\u5f53\u524d\u7b49\u5f85\u51b3\u7b56\u7684\u673a\u5668\u4eba\u63d0\u4ea4\u4e00\u4e2a\u52a8\u4f5c\u5e76\u7ee7\u7eed\u724c\u5c40\u3002',
    properties: {
      brain: { type: 'string', enum: ['auto', 'model'], description: '\u5207\u6362\u673a\u5668\u4eba\u8111\u888b\u3002' },
      seat: { type: 'integer', description: '\u76ee\u6807\u5e2d\u4f4d\uff08\u7f3a\u7701\u5373\u5f53\u524d\u7b49\u5f85\u51b3\u7b56\u7684\u673a\u5668\u4eba\uff09\u3002' },
      action: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise', 'allin'], description: '\u4e3a\u673a\u5668\u4eba\u9009\u7684\u52a8\u4f5c\u3002' },
      amount: { type: 'integer', description: 'bet/raise \u7684\u672c\u8f6e\u603b\u989d\u3002' },
      talk: { type: 'string', description: '\u673a\u5668\u4eba\u7684\u53f0\u8bcd\uff08\u5e26\u70b9\u6027\u683c\uff09\u3002' },
    },
    execute: async (args) => {
      const m = await impl();
      const { table } = requireTable();
      const result = m.opOpponent(table, args);
      return withReloadNotice(m.payload(saveTable(result.state), { note: result.note }));
    },
  });

  register({
    name: 'poker_equity',
    title: '\u8ba1\u7b97\u80dc\u7387',
    description:
      '\u7528\u8499\u7279\u5361\u7f57\u6a21\u62df\u4f30\u7b97\u67d0\u5e2d\u5f53\u524d\u7684\u80dc\u7387\uff08\u5bf9\u6297\u672a\u77e5\u5e95\u724c\uff09\u3002\u73a9\u5bb6\u95ee\u201c\u6211\u73b0\u5728\u80dc\u7387\u591a\u5c11\u201d\u65f6\u8c03\u7528\u3002',
    properties: {
      seat: { type: 'integer', description: '\u5e2d\u4f4d\uff0c\u9ed8\u8ba4 0\uff08\u73a9\u5bb6\uff09\u3002' },
      iterations: { type: 'integer', description: '\u6a21\u62df\u6b21\u6570\uff08\u9ed8\u8ba4 1500\uff0c\u4e0a\u9650 20000\uff09\u3002' },
    },
    execute: async (args) => {
      const m = await impl();
      const { table } = requireTable();
      return withReloadNotice(m.equityPayload(table, args));
    },
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  }, 'poker: dispose registered tools');
}

/**
 * Mark a payload as produced by freshly reloaded code, once.
 * @param body - the payload the implementation built.
 */
function withReloadNotice(body) {
  const notice = takeReloadNotice();
  if (notice && body && body.view) body.view.reload = notice;
  return body;
}
