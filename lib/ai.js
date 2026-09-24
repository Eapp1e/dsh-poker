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

/** Defaults for the AI fields. The full settings schema lives in `settings.js`. */
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

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Translate the plugin's flat settings into the shape this module wants.
 * @param settings - `readSettings()` output (or anything shaped like it).
 * @returns `{ enabled, seats, baseUrl, apiKey, model, temperature, timeoutMs, jsonMode, maxTokens }`.
 */
export function aiConfig(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    enabled: raw.aiEnabled === true,
    seats: clamp(Math.round(number(raw.aiSeats, AI_DEFAULTS.seats)), 0, 8),
    baseUrl: String(raw.aiBaseUrl || AI_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: typeof raw.aiApiKey === 'string' ? raw.aiApiKey : '',
    model: String(raw.aiModel || AI_DEFAULTS.model),
    temperature: clamp(number(raw.aiTemperature, AI_DEFAULTS.temperature), 0, 2),
    timeoutMs: clamp(Math.round(number(raw.aiTimeoutMs, AI_DEFAULTS.timeoutMs)), 500, 60000),
    jsonMode: raw.aiJsonMode === true,
    maxTokens: clamp(Math.round(number(raw.aiMaxTokens, AI_DEFAULTS.maxTokens)), 16, 2000),
  };
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

/** The fetch implementation to use: an injected one (tests), or the platform's. */
function resolveFetch(provided) {
  if (provided) return provided;
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
}

/** A timeout signal, or undefined on a runtime without `AbortSignal.timeout`. */
function timeoutSignal(ms) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(ms);
}

/** The headers for one request, including the bearer token when one is set. */
function chatHeaders(config) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/**
 * Ask the configured endpoint what this seat should do.
 *
 * @param options - `{ settings, state, seat, legal, fetchImpl }`.
 * @returns the decision, or null on ANY failure (the caller then plays the heuristics).
 */
export async function askAi(options) {
  const config = aiConfig(options.settings);
  const doFetch = resolveFetch(options.fetchImpl);
  if (!doFetch || config.enabled !== true) return null;
  const body = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    messages: [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: buildAiPrompt(options.state, options.seat) },
    ],
  };
  if (config.jsonMode) body.response_format = { type: 'json_object' };
  try {
    const response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(config),
      body: JSON.stringify(body),
      signal: timeoutSignal(config.timeoutMs),
    });
    if (!response || response.ok !== true) return null;
    const payload = await response.json();
    const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    return parseAiDecision(message ? message.content : null, options.legal);
  } catch {
    // Offline, timed out, wrong shape, refused: the heuristic takes the seat.
    return null;
  }
}

/**
 * Probe the endpoint with the settings as they are on screen.
 *
 * A different job from {@link askAi}: nothing falls back here, because the player is
 * asking "does this work?" and needs the real reason when it does not. It sends a
 * tiny request, so testing costs almost nothing.
 * @param options - `{ settings, fetchImpl }`.
 * @returns `{ ok, ms, model?, reply?, error? }` - never throws.
 */
export async function testConnection(options) {
  const config = aiConfig(options.settings);
  const started = Date.now();
  const doFetch = resolveFetch(options.fetchImpl);
  const done = (result) => ({ ms: Date.now() - started, ...result });
  if (!config.baseUrl) return done({ ok: false, error: '\u8bf7\u5148\u586b Base URL' });
  if (!config.model) return done({ ok: false, error: '\u8bf7\u5148\u586b\u6a21\u578b\u540d' });
  if (!doFetch) return done({ ok: false, error: '\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709 fetch' });
  try {
    const response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(config),
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 8,
        messages: [
          { role: 'system', content: 'Reply with the single word: pong' },
          { role: 'user', content: 'ping' },
        ],
      }),
      signal: timeoutSignal(config.timeoutMs),
    });
    if (!response) return done({ ok: false, error: '\u6ca1\u6709\u54cd\u5e94' });
    if (response.ok !== true) {
      let detail = '';
      try {
        detail = String(await response.text()).slice(0, 200);
      } catch {
        detail = '';
      }
      return done({
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${detail ? ` \u00b7 ${detail}` : ''}`,
      });
    }
    const payload = await response.json();
    const choice = payload && payload.choices && payload.choices[0];
    const reply = choice && choice.message ? String(choice.message.content ?? '').trim() : '';
    return done({
      ok: true,
      model: payload && payload.model ? String(payload.model) : config.model,
      reply: reply.slice(0, 120),
    });
  } catch (error) {
    const name = error && error.name ? String(error.name) : '';
    const message = error && error.message ? String(error.message) : String(error);
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|abort/i.test(message);
    return done({ ok: false, error: timedOut ? `\u8d85\u65f6\uff08${config.timeoutMs}ms\uff09` : message.slice(0, 200) });
  }
}
