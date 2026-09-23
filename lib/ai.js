/**
 * AI opponents: an OpenAI-compatible brain for the seats the player asks for.
 *
 * The heuristic policy in `bots.js` stays the default and the fallback - this module
 * only adds a second way to answer the same question ("what does seat N do now?").
 * Everything here is deliberately defensive: a model that is slow, offline, rude or
 * wrong must never break a hand, so every failure path degrades to the heuristic
 * decision the engine would have made anyway.
 * @module dsh-plugin-poker/ai
 */
import { renderTable } from './render.js';

/** The settings namespace this plugin owns in the host user-settings document. */
export const SETTINGS_NAMESPACE = 'poker';

/** Defaults for every field, and the source of the settings UI's shape. */
export const AI_DEFAULTS = {
  enabled: false,
  /** How many opponent seats the AI plays (0 = all heuristics). */
  seats: 1,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.6,
  timeoutMs: 8000,
  jsonMode: false,
  maxTokens: 200,
};

/** Field names the settings UI edits, in display order. */
export const AI_FIELDS = [
  'enabled',
  'seats',
  'baseUrl',
  'apiKey',
  'model',
  'temperature',
  'timeoutMs',
  'jsonMode',
];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Coerce anything the settings document (or an HTTP body) carries into a usable
 * configuration. This doubles as the settings service's "schema": the service calls
 * it with the merged section, so the same function validates the file and the form.
 * @param section - a partial settings object.
 * @returns a complete, bounded configuration.
 */
export function normaliseSettings(section) {
  const raw = section && typeof section === 'object' ? section : {};
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  return {
    enabled: raw.enabled === true || raw.enabled === 'true',
    seats: clamp(Math.round(number(raw.seats, AI_DEFAULTS.seats)), 0, 8),
    // Trailing slashes are stripped once, here, so every caller can just append a path.
    baseUrl: text(raw.baseUrl, AI_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : AI_DEFAULTS.apiKey,
    model: text(raw.model, AI_DEFAULTS.model),
    temperature: clamp(number(raw.temperature, AI_DEFAULTS.temperature), 0, 2),
    timeoutMs: clamp(Math.round(number(raw.timeoutMs, AI_DEFAULTS.timeoutMs)), 500, 60000),
    jsonMode: raw.jsonMode === true || raw.jsonMode === 'true',
    maxTokens: clamp(Math.round(number(raw.maxTokens, AI_DEFAULTS.maxTokens)), 16, 2000),
  };
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
 *
 * @param ctx - host context (may or may not carry the settings service).
 * @param fallback - an in-memory override used when the service is absent.
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
  const scope = registerSettings(ctx);
  if (scope && typeof scope.update === 'function') {
    await scope.update(merged);
    return readSettings(ctx, merged);
  }
  return merged;
}

/** The system prompt: one job, one shape of answer. */
export const AI_SYSTEM_PROMPT = [
  'You are one seat at a no-limit Texas Hold\'em table, playing against a human.',
  'Decide the action for your seat only. Answer with ONE JSON object and nothing else:',
  '{"action":"fold"|"check"|"call"|"bet"|"raise"|"allin","amount":<number>,"talk":"<6 words max, optional>"}',
  '"amount" is the TOTAL your street commitment becomes ("raise TO"), never the increment.',
  'Use only actions the legal menu lists. Fold when the price is bad, call when it is fair,',
  'raise for value or as a bluff. Never explain, never use markdown, never add other keys.',
].join(' ');

/**
 * The user prompt: the same table text the model in the conversation would see.
 * @param state - game state.
 * @param seat - the seat being asked.
 * @returns a compact, complete description of the decision.
 */
export function buildAiPrompt(state, seat) {
  const player = state.players[seat];
  const lines = [
    renderTable(state, seat),
    '',
    `You are seat ${seat} (${player ? player.name : '?'}), style ${player ? player.style : 'pro'}.`,
    'Reply with the JSON object only.',
  ];
  return lines.join('\n');
}

/**
 * Pull one decision out of whatever the endpoint returned.
 *
 * Tolerates code fences and surrounding prose, and rejects anything the engine would
 * refuse: the caller falls back to the heuristic rather than throwing mid-hand.
 * @param text - the assistant message.
 * @param legal - the seat's legal menu.
 * @returns `{ action, amount?, talk? }` or null when nothing usable came back.
 */
export function parseAiDecision(text, legal) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const cleaned = text.replace(/```json/gi, '```').split('```').join('\n');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const action = String(parsed.action ?? '').toLowerCase();
  const allowed = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);
  if (!allowed.has(action)) return null;
  if (action === 'check' && !legal.canCheck) return null;
  if (action === 'call' && !legal.canCall) return null;
  if (action === 'fold' && legal.toCall === 0) return null;
  if (action === 'raise' && !legal.canRaise) return null;
  if (action === 'bet' && !legal.canRaise) return null;
  if (action === 'allin' && legal.canAllIn === false) return null;
  const decision = { action };
  if (action === 'bet' || action === 'raise') {
    const amount = Number(parsed.amount);
    if (!Number.isFinite(amount)) return null;
    decision.amount = clamp(Math.round(amount), legal.minRaiseTo, legal.maxRaiseTo);
  }
  if (action === 'allin' && legal.canRaise && Number.isFinite(Number(legal.maxRaiseTo))) {
    decision.amount = legal.maxRaiseTo;
  }
  if (typeof parsed.talk === 'string' && parsed.talk.trim() !== '') {
    decision.talk = parsed.talk.trim().slice(0, 40);
  }
  return decision;
}

/**
 * Ask the configured endpoint what this seat should do.
 * @param options - `{ settings, state, seat, fetchImpl }`.
 * @returns the decision, or null on ANY failure (the caller then plays the heuristics).
 */
export async function askAi(options) {
  const { settings, state, seat } = options;
  const doFetch = options.fetchImpl
    ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch || !settings || settings.enabled !== true) return null;
  const legal = options.legal;
  const body = {
    model: settings.model,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    messages: [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: buildAiPrompt(state, seat) },
    ],
  };
  if (settings.jsonMode) body.response_format = { type: 'json_object' };
  const headers = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  try {
    const response = await doFetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(settings.timeoutMs)
        : undefined,
    });
    if (!response || response.ok !== true) return null;
    const payload = await response.json();
    const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    const content = message ? message.content : null;
    return parseAiDecision(content, legal);
  } catch {
    // Offline, timed out, wrong shape, refused: the heuristic takes the seat.
    return null;
  }
}
