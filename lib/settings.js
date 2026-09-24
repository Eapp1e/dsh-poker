/**
 * The plugin's settings: one schema, one namespace, one descriptor for the UI.
 *
 * Everything the player can configure lives here - the plugin switch, the coach, the
 * default table, the panel, and the AI opponents - because a settings surface that
 * grows in three places rots in three places. The descriptors in `GROUPS` are what the
 * browser renders, so adding a field is: add it to `DEFAULTS`, describe it in a group,
 * and the settings page shows it (with the right input type, bounds and help text)
 * without touching the client bundle.
 * @module dsh-plugin-poker/settings
 */
import { AI_DEFAULTS } from './ai.js';

/** The settings namespace this plugin owns in the host user-settings document. */
export const SETTINGS_NAMESPACE = 'poker';

/** Every setting, with the value used before anything is stored. */
export const DEFAULTS = {
  // ── general ───────────────────────────────────────────────────────────────
  /** The plugin switch: off hides the sidebar entry and the table cards. */
  pluginEnabled: true,
  /** The teaching layer: off means no coach payload, badge or window. */
  coachEnabled: true,
  /** `simple` = rule-of-thumb reasoning; `gto` = ranges, indifference points and EV. */
  coachMode: 'simple',
  /** The one-line recommendation above the action buttons. */
  showAdvice: true,
  /** The hand history column (and the showdown result above it). */
  showLog: true,
  // ── new-table defaults ────────────────────────────────────────────────────
  /** Used only when the caller does not pass its own value. */
  botCount: 5,
  botStyles: 'mixed',
  startingStack: 10000,
  smallBlind: 50,
  bigBlind: 100,
  // ── panel ─────────────────────────────────────────────────────────────────
  /** Replay pacing multiplier: 0.5 = brisk, 2 = slow and deliberate. */
  replaySpeed: 1,
  /** Open the panel as soon as the page loads. */
  autoOpen: false,
  // ── about / updates ───────────────────────────────────────────────────────
  /** Where the release check looks: `owner/repo`. */
  updateRepo: 'Eapp1e/dsh-poker',
  // ── AI opponents ──────────────────────────────────────────────────────────
  aiEnabled: AI_DEFAULTS.enabled,
  aiSeats: AI_DEFAULTS.seats,
  aiBaseUrl: AI_DEFAULTS.baseUrl,
  aiApiKey: AI_DEFAULTS.apiKey,
  aiModel: AI_DEFAULTS.model,
  aiTemperature: AI_DEFAULTS.temperature,
  aiTimeoutMs: AI_DEFAULTS.timeoutMs,
  aiJsonMode: AI_DEFAULTS.jsonMode,
  aiMaxTokens: AI_DEFAULTS.maxTokens,
};

/** Field kinds the settings page knows how to draw. */
const KINDS = new Set(['boolean', 'number', 'text', 'password', 'select', 'action', 'info']);

/**
 * The settings page layout: groups in order, each with its fields in order.
 *
 * `kind` picks the control, `hint` explains it, and the bounds/options carry the
 * validation the host enforces anyway (the UI is a convenience, not the gate).
 */
export const GROUPS = [
  {
    id: 'general',
    label: '\u5e38\u89c4',
    hint: '\u63d2\u4ef6\u672c\u8eab\u7684\u5f00\u5173\u4e0e\u754c\u9762\u5143\u7d20',
    fields: [
      { key: 'pluginEnabled', kind: 'boolean', label: '\u542f\u7528\u63d2\u4ef6', hint: '\u5173\u95ed\u540e\u4fa7\u680f\u5165\u53e3\u4e0e\u724c\u684c\u5361\u7247\u9690\u85cf\uff08\u5de5\u5177\u4ecd\u53ef\u7528\uff0c\u4e0d\u4f1a\u628a\u5bf9\u8bdd\u641e\u65ad\uff09' },
      { key: 'coachEnabled', kind: 'boolean', label: '\u6559\u7ec3\u5c42', hint: '\u5173\u95ed\u540e\u4e0d\u518d\u8ba1\u7b97\u6559\u7ec3\u5efa\u8bae' },
      {
        key: 'coachMode',
        kind: 'select',
        label: '\u6559\u7ec3\u98ce\u683c',
        // Applying on change is what a style switch wants: there is nothing to review
        // before saving, and the coach window carries the same switch in its title bar.
        apply: 'change',
        options: [
          { value: 'simple', label: '\u7b80\u6d01\uff08\u7ecf\u9a8c\u89c4\u5219\uff09' },
          { value: 'gto', label: 'GTO\uff08\u8303\u56f4 / \u65e0\u5dee\u70b9 / EV\uff09' },
        ],
        hint: '\u6539\u5b8c\u7acb\u5373\u751f\u6548\uff08\u4e0d\u9700\u8981\u70b9\u4fdd\u5b58\uff09\uff1bGTO \u98ce\u683c\u4f1a\u7b97\u51fa\u6bcf\u4e2a\u5408\u6cd5\u52a8\u4f5c\u7684 EV \u4e0e\u8fd1\u4f3c\u6df7\u5408\u9891\u7387',
      },
      { key: 'showAdvice', kind: 'boolean', label: '\u5efa\u8bae\u5fbd\u7ae0', hint: '\u884c\u52a8\u6309\u94ae\u4e0a\u65b9\u90a3\u4e00\u884c\u5efa\u8bae' },
      { key: 'showLog', kind: 'boolean', label: '\u724c\u5c40\u8bb0\u5f55', hint: '\u724c\u684c\u4e0b\u65b9\u7684\u5386\u53f2\u5217' },
    ],
  },
  {
    id: 'table',
    label: '\u65b0\u724c\u684c\u9ed8\u8ba4\u503c',
    hint: '\u53ea\u5728\u8c03\u7528\u65b9\u6ca1\u6709\u81ea\u5df1\u6307\u5b9a\u65f6\u751f\u6548\uff08\u6a21\u578b\u8c03\u5de5\u5177\u65f6\u4ecd\u4ee5\u5b83\u4f20\u7684\u53c2\u6570\u4e3a\u51c6\uff09',
    fields: [
      { key: 'botCount', kind: 'number', label: '\u673a\u5668\u4eba\u6570\u91cf', min: 1, max: 8, step: 1, hint: '1-8\uff08\u5373 2-9 \u4eba\u684c\uff09' },
      {
        key: 'botStyles',
        kind: 'select',
        label: '\u5bf9\u624b\u6027\u683c',
        options: [
          { value: 'mixed', label: '\u6df7\u5408\uff08\u63a8\u8350\uff09' },
          { value: 'rock', label: '\u5168\u77f3\u5934' },
          { value: 'tag', label: '\u5168\u7d27\u51f6' },
          { value: 'lag', label: '\u5168\u677e\u51f6' },
          { value: 'station', label: '\u5168\u8ddf\u6ce8\u7ad9' },
          { value: 'maniac', label: '\u5168\u75af\u5b50' },
          { value: 'pro', label: '\u5168\u8001\u7ec3' },
        ],
        hint: '\u4e5f\u53ef\u4ee5\u5728\u5bf9\u8bdd\u91cc\u4f20\u9017\u53f7\u5217\u8868\uff0c\u5982 tag,lag',
      },
      { key: 'startingStack', kind: 'number', label: '\u8d77\u59cb\u7b79\u7801', min: 200, max: 100000000, step: 100, hint: '\u6bcf\u5bb6\u5e26\u4e0a\u684c\u7684\u7b79\u7801' },
      { key: 'smallBlind', kind: 'number', label: '\u5c0f\u76f2', min: 1, max: 1000000, step: 1 },
      { key: 'bigBlind', kind: 'number', label: '\u5927\u76f2', min: 2, max: 2000000, step: 1 },
    ],
  },
  {
    id: 'panel',
    label: '\u9762\u677f\u4e0e\u56de\u653e',
    hint: '\u53ea\u5f71\u54cd\u6d4f\u89c8\u5668\u91cc\u770b\u5230\u7684\u8282\u594f',
    fields: [
      {
        key: 'replaySpeed',
        kind: 'select',
        label: '\u56de\u653e\u8282\u594f',
        options: [
          { value: 0.5, label: '\u5feb\uff080.5\u00d7\uff09' },
          { value: 1, label: '\u6807\u51c6' },
          { value: 2, label: '\u6162\uff082\u00d7\uff09' },
        ],
        hint: '\u673a\u5668\u4eba\u884c\u52a8\u4e0e\u53d1\u724c\u7684\u6bcf\u4e00\u62cd',
      },
      { key: 'autoOpen', kind: 'boolean', label: '\u9875\u9762\u52a0\u8f7d\u65f6\u81ea\u52a8\u5c55\u5f00', hint: '\u6253\u5f00\u9875\u9762\u5c31\u628a\u724c\u684c\u9762\u677f\u5f39\u51fa\u6765' },
    ],
  },
  {
    id: 'ai',
    label: 'AI \u5bf9\u624b',
    hint: '\u628a\u90e8\u5206\u673a\u5668\u4eba\u4ea4\u7ed9\u4efb\u610f OpenAI \u517c\u5bb9\u63a5\u53e3\uff1b\u4efb\u4f55\u5931\u8d25\u90fd\u9000\u56de\u5185\u7f6e\u7b56\u7565',
    fields: [
      { key: 'aiEnabled', kind: 'boolean', label: '\u542f\u7528 AI \u5bf9\u624b' },
      { key: 'aiSeats', kind: 'number', label: 'AI \u5e2d\u4f4d\u6570', min: 0, max: 8, step: 1, hint: '\u4ece 1 \u53f7\u5e2d\u5f00\u59cb\u63a5\u7ba1' },
      { key: 'aiBaseUrl', kind: 'text', label: 'Base URL', hint: '\u4f8b\u5982 https://api.openai.com/v1\uff08\u4e0d\u5e26 /chat/completions\uff09' },
      { key: 'aiApiKey', kind: 'password', label: 'API Key', hint: '\u4ec5\u5b58\u5728\u672c\u673a\u7684\u7528\u6237\u914d\u7f6e\u91cc\uff0c\u4e0d\u4f1a\u56de\u4f20\u7ed9\u9875\u9762' },
      { key: 'aiModel', kind: 'text', label: '\u6a21\u578b', hint: '\u63a5\u53e3\u7aef\u63a5\u53d7\u7684\u6a21\u578b\u540d' },
      { key: 'aiTemperature', kind: 'number', label: '\u6e29\u5ea6', min: 0, max: 2, step: 0.1, hint: '0 = \u7a33\u5b9a\uff0c1 \u4ee5\u4e0a = \u968f\u673a' },
      { key: 'aiTimeoutMs', kind: 'number', label: '\u8d85\u65f6\uff08\u6beb\u79d2\uff09', min: 500, max: 60000, step: 500, hint: '\u8d85\u65f6\u540e\u8be5\u5e2d\u4f4d\u6539\u7528\u5185\u7f6e\u7b56\u7565' },
      { key: 'aiJsonMode', kind: 'boolean', label: 'JSON \u6a21\u5f0f', hint: '\u63a5\u53e3\u652f\u6301 response_format \u65f6\u6253\u5f00' },
      { key: 'aiMaxTokens', kind: 'number', label: '\u6700\u5927\u56de\u590d\u957f\u5ea6', min: 16, max: 2000, step: 8 },
      {
        // The test lives with the fields it tests, not in the page footer next to 保存: it is
        // about THIS configuration, and it sends the values currently on screen - including a
        // key that has not been saved yet.
        key: 'aiTest',
        kind: 'action',
        action: 'settings-test',
        label: '\u6d4b\u8bd5\u8fde\u901a',
        hint: '\u7528\u5c4f\u5e55\u4e0a\u5f53\u524d\u7684\u503c\uff08\u542b\u8fd8\u6ca1\u4fdd\u5b58\u7684 Key\uff09\u53d1\u4e00\u6b21\u6700\u5c0f\u8bf7\u6c42\uff1b\u4e0d\u843d\u5e93\u3001\u4e0d\u6539\u8bbe\u7f6e',
      },
    ],
  },
  {
    id: 'about',
    label: '\u5173\u4e8e\u4e0e\u66f4\u65b0',
    hint: '\u7248\u672c\u53f7\u8bfb\u81ea\u5b89\u88c5\u5305\u81ea\u5df1\u7684 package.json\uff0c\u4e0d\u9700\u8981\u624b\u586b',
    fields: [
      // Filled in by the host with the INSTALLED version, so the page never guesses.
      { key: 'pluginVersion', kind: 'info', label: '\u5b89\u88c5\u7248\u672c' },
      { key: 'updateRepo', kind: 'text', label: '\u4ed3\u5e93', hint: 'owner/repo\uff08\u6539\u6210\u4f60\u81ea\u5df1\u7684 fork \u4e5f\u80fd\u67e5\uff09' },
      {
        key: 'updateApply',
        kind: 'action',
        action: 'update-apply',
        label: '\u66f4\u65b0',
        // One control for both jobs: the check runs on page load by itself, so a separate
        // "check now" button was a second way to ask the same question. Pressing this when
        // there is nothing newer re-checks (bypassing the cache) and says so.
        confirm: '\u786e\u5b9a\u8981\u66f4\u65b0\u5230\u6700\u65b0\u7248\u672c\u5417\uff1f',
        hint: '\u6709\u65b0\u7248\u672c\u65f6\uff1agit \u68c0\u51fa\u5c31 `git pull`\uff0c\u5426\u5219\u6309 lock \u6587\u4ef6\u9009 npm / pnpm / yarn\uff1b\u5df2\u662f\u6700\u65b0\u65f6\u6309\u4e00\u4e0b\u5c31\u662f\u91cd\u65b0\u68c0\u67e5',
      },
    ],
  },
];

/** The bounds a number field accepts, so the host clamps exactly like the UI does. */
const BOUNDS = (() => {
  const map = new Map();
  for (const group of GROUPS) {
    for (const field of group.fields) {
      if (field.kind === 'number') map.set(field.key, { min: field.min, max: field.max, step: field.step });
      if (field.kind === 'select') map.set(field.key, { options: field.options.map((option) => option.value) });
    }
  }
  return map;
})();

/** The keys a settings patch is allowed to carry. */
export const SETTING_KEYS = Object.keys(DEFAULTS);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Coerce anything the settings document (or an HTTP body) carries into a usable
 * configuration. This doubles as the settings service's schema: the service calls it
 * with the merged section, so the same function validates the file and the form.
 * @param section - a partial settings object.
 * @returns a complete, bounded configuration.
 */
export function normaliseSettings(section) {
  const raw = section && typeof section === 'object' ? section : {};
  const out = {};
  for (const key of SETTING_KEYS) {
    const fallback = DEFAULTS[key];
    const value = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : fallback;
    if (typeof fallback === 'boolean') {
      out[key] = value === true || value === 'true';
      continue;
    }
    if (typeof fallback === 'number') {
      const number = Number(value);
      const bounds = BOUNDS.get(key);
      const next = Number.isFinite(number) ? number : fallback;
      // A select whose default is a number (replay speed) has options, not a range:
      // clamping against undefined bounds would turn it into NaN.
      if (bounds && Array.isArray(bounds.options)) {
        out[key] = bounds.options.includes(next) ? next : fallback;
        continue;
      }
      out[key] = bounds && Number.isFinite(bounds.min) && Number.isFinite(bounds.max)
        ? clamp(next, bounds.min, bounds.max)
        : next;
      continue;
    }
    // Strings: text fields, plus the enum-ish selects.
    const text = typeof value === 'string' ? value.trim() : String(value ?? '');
    const bounds = BOUNDS.get(key);
    if (bounds && bounds.options) {
      const allowed = bounds.options.map(String);
      out[key] = allowed.includes(text) ? text : String(fallback);
      continue;
    }
    out[key] = text === '' && typeof value !== 'string' ? fallback : text;
  }
  // A trailing slash here would double up when the client appends a path.
  out.aiBaseUrl = String(out.aiBaseUrl || '').replace(/\/+$/, '') || DEFAULTS.aiBaseUrl;
  // Blind sanity: the big blind is never smaller than the small blind.
  if (out.bigBlind < out.smallBlind) out.bigBlind = out.smallBlind;
  return out;
}

/** The scope returned by the settings service, kept so writes reuse one registration. */
let settingsScope = null;

/** Register the namespace so the values live in the host user-settings document. */
export function registerSettings(ctx) {
  if (settingsScope) return settingsScope;
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  if (!settings || typeof settings.register !== 'function') return null;
  try {
    settingsScope = settings.register(SETTINGS_NAMESPACE, normaliseSettings, { applies: 'live' });
  } catch {
    // An already-registered namespace (a hot reload re-running activate) is fine:
    // the service owns the values, not this module.
    settingsScope = null;
  }
  return settingsScope;
}

/**
 * Read the current configuration, wherever it lives.
 * @param ctx - host context (may or may not carry the settings service).
 * @param fallback - an in-memory value used when the service is absent.
 * @returns a complete configuration.
 */
export function readSettings(ctx, fallback) {
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  if (settings && typeof settings.get === 'function') {
    const section = settings.get(SETTINGS_NAMESPACE);
    if (section) return normaliseSettings(section);
  }
  return normaliseSettings(fallback);
}

/** Persist a partial update, returning the settings as they now stand. */
export async function writeSettings(ctx, patch, fallback) {
  const merged = normaliseSettings({ ...readSettings(ctx, fallback), ...(patch || {}) });
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  // Write through the SERVICE, not through the scope `register` handed back. That scope
  // belongs to one module instance, and this module is hot-reloadable: after any reload the
  // fresh instance cannot register the namespace again (it is already taken), so a
  // scope-based write returned the merged value WITHOUT persisting it. Settings READS kept
  // working and writes silently did nothing - which is exactly "switching back does not
  // stick", and why the answer came back looking saved. The provider itself is the stable
  // thing, so it is asked first.
  if (settings && typeof settings.update === 'function') {
    try {
      await settings.update(SETTINGS_NAMESPACE, merged);
      return readSettings(ctx, merged);
    } catch (error) {
      if (typeof console !== 'undefined') console.warn('poker: the settings service refused the merge write', error);
    }
  }
  if (settings && typeof settings.replace === 'function') {
    try {
      await settings.replace(SETTINGS_NAMESPACE, merged);
      return readSettings(ctx, merged);
    } catch {
      // Both service paths refused: fall back to the scope, then to memory.
    }
  }
  const scope = registerSettings(ctx);
  if (scope && typeof scope.update === 'function') {
    await scope.update(merged);
    return readSettings(ctx, merged);
  }
  return merged;
}

/**
 * What the browser is allowed to see: everything, minus the secret, plus flags that
 * tell the form what is stored without ever sending it back.
 * @param settings - the full configuration.
 * @returns a JSON-safe copy.
 */
export function publicSettings(settings) {
  const out = {};
  for (const key of SETTING_KEYS) {
    if (key === 'aiApiKey') continue;
    out[key] = settings[key];
  }
  out.hasApiKey = typeof settings.aiApiKey === 'string' && settings.aiApiKey !== '';
  return out;
}

/**
 * Keep only the keys a patch may carry, so a stray field from the page cannot write
 * something the schema does not own.
 * @param body - a request body.
 * @returns a patch.
 */
export function pickSettings(body) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  }
  return patch;
}

/**
 * The descriptors the settings page renders, with the current values folded in.
 *
 * `context` carries the things a page needs but cannot edit: the installed version (an
 * `info` field), and anything else a future field wants to display.
 * @param settings - the full configuration.
 * @param context - `{ version }`.
 * @returns `[{ id, label, hint, fields: [{ key, kind, label, hint, value, ... }] }]`.
 */
export function settingsForm(settings, context = {}) {
  const isSecret = (key) => key === 'aiApiKey';
  const isInfo = (key) => key === 'pluginVersion';
  return GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    hint: group.hint,
    fields: group.fields
      .filter((field) => KINDS.has(field.kind))
      .map((field) => ({
        key: field.key,
        kind: field.kind,
        label: field.label,
        hint: field.hint ?? '',
        ...(field.action === undefined ? {} : { action: field.action }),
        ...(field.confirm === undefined ? {} : { confirm: field.confirm }),
        ...(field.apply === undefined ? {} : { apply: field.apply }),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.step === undefined ? {} : { step: field.step }),
        ...(field.options === undefined ? {} : { options: field.options }),
        // A stored secret is reported as "set", never as a value; an info field shows
        // what the host knows (the installed version) instead of a setting.
        value: isSecret(field.key)
          ? ''
          : isInfo(field.key)
            ? (context.version ? `v${context.version}` : '\u672a\u77e5')
            : settings[field.key],
        ...(isSecret(field.key) ? { hasValue: settings.hasApiKey === true || settings.aiApiKey !== '' } : {}),
      })),
  }));
}
