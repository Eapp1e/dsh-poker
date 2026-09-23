/**
 * dsh-plugin-poker — the implementation half of the host plugin.
 *
 * This module holds all of the poker logic the host plugin needs: creating a
 * table, applying actions, advancing the bots, and building the payload each
 * tool answers with. Nothing here touches the Cordis context, the live-table
 * registry, or the HTTP route — those belong to the loader entry
 * (`lib/index.js`), which stays loaded for the whole host lifetime.
 *
 * That split is what makes the plugin edit-and-play: `lib/index.js` re-imports
 * this file (and, with it, engine/bots/cards/evaluator/render) from a staged
 * snapshot whenever any of them changes on disk, so a fix here takes effect on
 * the very next click instead of needing a host restart. Because the staging
 * copies the whole set and imports from that directory, every relative import
 * below resolves inside the SAME snapshot: a reload can never mix two revisions
 * of the engine.
 *
 * The engine remains the single source of truth. These functions translate
 * arguments, call the engine, and render the result — none of them computes
 * poker odds or rules on its own.
 * @module dsh-plugin-poker/impl
 */
import { BOT_NAMES, BOT_STYLES, decideBotAction, estimateEquity } from './bots.js';
import {
  advance,
  applyAction,
  createGame,
  legalActions,
  MAX_BOTS,
  potTotal,
  startHand,
  submitBotDecision,
  viewFor,
} from './engine.js';
import { cardsLabel } from './cards.js';
import { chips, renderSelf, renderSituation, renderTable } from './render.js';
import { coachFor } from './coach.js';

// The entry file's browser route answers with the model-facing text as well, so
// the renderer is part of this module's public surface too.
export { renderTable };

/** Style rotation for `botStyles: 'mixed'`. */
const MIXED = ['tag', 'station', 'lag', 'rock', 'maniac', 'pro'];

/**
 * How many opponents a table opens with when the caller does not say. Five
 * opponents is a six-handed table, the common online default; the engine's own
 * `MAX_BOTS` caps the full ring at nine players.
 */
const DEFAULT_BOTS = 5;

/** Human seat index: the hero always sits at seat 0. */
export const HERO_SEAT = 0;

/** The hero's display name when none was given. */
const DEFAULT_HERO = '\u73a9\u5bb6';

/** Comma list of the style keys, for tool descriptions and errors. */
export const STYLE_KEYS = Object.keys(BOT_STYLES).join('/');

/** Comma-joined bot style summary, e.g. `老王(紧凶)、阿珍(跟注站)`. */
export function roster(state) {
  return state.players
    .filter((player) => !player.isHuman)
    .map((player) => `${player.name}(${(BOT_STYLES[player.style] ?? BOT_STYLES.pro).label})`)
    .join('\u3001');
}

/** The model-facing "what now" trailer that tells the model how to continue. */
export function nextStepHint(state) {
  if (state.gameOver) return '\u724c\u5c40\u5df2\u7ed3\u675f\uff08\u53ea\u5269\u4e00\u4eba\u6709\u7b79\u7801\uff09\u3002\u5411\u73a9\u5bb6\u6c47\u62a5\u7ed3\u679c\u5373\u53ef\u3002';
  if (state.phase === 'handover') return '\u672c\u624b\u7ed3\u675f\u3002\u628a\u7ed3\u679c\u544a\u8bc9\u73a9\u5bb6\uff0c\u5e76\u8be2\u95ee\u662f\u5426\u5f00\u59cb\u4e0b\u4e00\u624b\uff08poker_next_hand\uff09\u3002';
  if (state.pendingDecision) {
    return `\u7b49\u5f85\u4f60\u4e3a\u673a\u5668\u4eba ${state.pendingDecision.name} \u51b3\u5b9a\u884c\u52a8\uff08poker_opponent\uff09\u3002`;
  }
  const actor = state.actorSeat === null ? null : state.players[state.actorSeat];
  if (actor && actor.isHuman) {
    return '\u8f6e\u5230\u73a9\u5bb6\u884c\u52a8\uff1a\u628a\u724c\u684c\u544a\u8bc9\u73a9\u5bb6\uff0c\u4e0d\u8981\u66ff\u4ed6\u51b3\u5b9a\uff1b\u4ed6\u8bf4\u51fa\u52a8\u4f5c\u540e\u8c03\u7528 poker_action\u3002';
  }
  return '\u7b49\u5f85\u52a8\u4f5c\u3002';
}

/**
 * The structured snapshot every surface renders: {@link viewFor} plus the two
 * fields a browser needs to act - the opaque table id and the revision the
 * client merges on.
 *
 * It also carries the coaching analysis, so the optional teaching layer in the
 * GUI is one more field of the same snapshot rather than a second request. Pass
 * `{ coach: false }` to skip it (the engine's own tests do, to keep the raw
 * state machine cheap to assert on).
 * @param state - game state.
 * @param options - passed through to {@link viewFor} (`revealAll`), plus `coach`.
 */
export function buildView(state, options = {}) {
  const view = {
    ...viewFor(state, HERO_SEAT, options),
    tableId: state.tableId ?? null,
    revision: state.revision ?? 0,
    // How many actions this table has played in total: the browser uses it to
    // replay only what it has not shown yet.
    actionSeq: state.actionSeq ?? 0,
    // A table the browser opened waits for the player to press 开始 before the
    // opponents move (see `opStart`).
    awaitingStart: state.awaitingStart === true,
  };
  if (options.coach !== false) {
    const coach = coachFor(state, HERO_SEAT);
    if (coach) view.coach = coach;
  }
  // A paused table has not reached the hero yet: the action list on the state is
  // the BOT's, so it must not travel as the reader's options.
  if (state.awaitingStart === true) view.legal = null;
  return view;
}

/** The canonical tool payload: model-facing text plus the browser view. */
export function payload(state, extra = {}) {
  const viewer = buildView(state, extra.revealAll === true ? { revealAll: true } : {});
  const text = [
    renderTable(state, HERO_SEAT, extra.revealAll === true ? { revealAll: true } : {}),
    '',
    `\u72b6\u6001\uff1a${renderSituation(state, HERO_SEAT)}`,
    nextStepHint(state),
    // The coach's own summary travels with the table so the model explains the
    // decision with the same numbers the player can see in the panel, instead of
    // inventing poker theory of its own.
    viewer.coach && viewer.coach.brief ? `\n${viewer.coach.brief}` : '',
    extra.note ? `\u63d0\u793a\uff1a${extra.note}` : '',
  ].filter((line) => line !== '').join('\n');
  return { text, view: viewer, meta: extra.meta ?? null };
}

/**
 * Open a table and deal the first hand.
 * @param args - the `poker_new_table` arguments.
 * @param options.paused - leave the opponents to move after the player presses
 *   start (the browser's own route does this; the model's tool does not).
 * @returns the dealt state, carrying a fresh opaque `tableId`.
 */
export function opNew(args, options = {}) {
  const botCount = Math.max(1, Math.min(MAX_BOTS, Math.floor(args.botCount ?? DEFAULT_BOTS)));
  const rawStyles = String(args.botStyles ?? 'mixed').toLowerCase();
  const styles = rawStyles === 'mixed' || rawStyles === ''
    ? Array.from({ length: botCount }, (_, index) => MIXED[index % MIXED.length])
    : rawStyles.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const style of styles) {
    if (!BOT_STYLES[style]) throw new Error(`\u672a\u77e5\u7684\u673a\u5668\u4eba\u6027\u683c ${style}\uff0c\u53ef\u9009\uff1a${STYLE_KEYS}`);
  }
  const bots = Array.from({ length: botCount }, (_, index) => ({
    name: BOT_NAMES[index % BOT_NAMES.length],
    style: styles[index] ?? MIXED[index % MIXED.length],
  }));
  const seed = Number.isFinite(args.seed) ? Math.floor(args.seed) >>> 0 : undefined;
  const state = createGame({
    heroName: typeof args.heroName === 'string' && args.heroName.trim() !== '' ? args.heroName.trim() : DEFAULT_HERO,
    bots,
    startingStack: Math.max(200, Math.floor(args.startingStack ?? 10000)),
    smallBlind: Math.max(1, Math.floor(args.smallBlind ?? 50)),
    bigBlind: Math.max(2, Math.floor(args.bigBlind ?? 100)),
    botBrain: args.botBrain === 'model' ? 'model' : 'auto',
    seed,
  });
  state.tableId = newTableId();
  state.revision = 0;
  const dealt = startHand(state);
  if (options.paused === true) {
    // `startHand` clones, so the pause has to be set on the dealt state.
    dealt.awaitingStart = true;
    return dealt;
  }
  return advanceTable(dealt);
}

/** The actions the hero may submit, as a set for request validation. */
const HERO_ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);

/**
 * Apply one hero action.
 * @param table - current state.
 * @param args - `{ action, amount?, talk? }`, however malformed.
 */
export function opAction(table, args) {
  const action = String(args.action ?? '').toLowerCase();
  if (!HERO_ACTIONS.has(action)) {
    throw new Error(`\u65e0\u6548\u52a8\u4f5c ${args.action}\uff0c\u53ef\u9009\uff1a${[...HERO_ACTIONS].join('/')}`);
  }
  const amount = Number.isFinite(args.amount) ? Math.floor(args.amount) : undefined;
  const talk = typeof args.talk === 'string' && args.talk.trim() !== '' ? args.talk.trim() : undefined;
  return advanceTable(applyAction(table, { seat: HERO_SEAT, action, amount, talk }, decideBotAction));
}

/** Deal the next hand after one has settled. */
export function opNextHand(table) {
  if (table.phase === 'betting') throw new Error('\u672c\u624b\u8fd8\u6ca1\u7ed3\u675f\uff0c\u4e0d\u80fd\u53d1\u65b0\u724c');
  return advanceTable(startHand(table));
}

/**
 * Buy the hero back in after they busted.
 *
 * Only offered once the hero's stack is empty: it tops the stack up by the chosen
 * amount, clears the `out` flag, and returns the table to a deal-again state so
 * 发下一手 works. The amount is a whole number of chips, chosen by the panel.
 * @param table - current state.
 * @param args - `{ amount }` chips to add.
 * @returns the same table, ready for the next hand.
 */
export function opRebuy(table, args) {
  const hero = table.players[HERO_SEAT];
  if (!hero) throw new Error('\u6ca1\u6709\u73a9\u5bb6\u5e2d\u4f4d');
  if (Number(hero.stack) > 0) throw new Error('\u4f60\u8fd8\u6709\u7b79\u7801\uff0c\u65e0\u9700\u8865\u7801');
  const amount = Number.isFinite(args.amount) ? Math.floor(args.amount) : 0;
  if (amount <= 0) throw new Error('\u8865\u7801\u91d1\u989d\u5fc5\u987b\u5927\u4e8e 0');
  hero.stack += amount;
  hero.out = false;
  hero.allIn = false;
  table.awaitingStart = false;
  table.gameOver = false;
  if (table.phase === 'gameover') table.phase = 'handover';
  return table;
}

/**
 * Run the hands the opponents still owe for a table the browser opened.
 *
 * The GUI route deals a new table PAUSED (`awaitingStart`): the player sees the
 * blinds posted and their own cards, presses 开始, and only then do the bots move
 * one beat at a time. Without this a switch slammed a fully-played street onto
 * the screen before the reader could look at it.
 * @param table - the paused state.
 * @returns the advanced state, with the pause cleared.
 */
export function opStart(table) {
  if (table.awaitingStart !== true) return table;
  return advanceTable(Object.assign({}, table, { awaitingStart: false }));
}

/**
 * Switch the opponents' brain and/or submit one model-chosen bot decision.
 * @param table - current state.
 * @param args - `{ brain?, seat?, action?, amount?, talk? }`.
 * @returns `{ state, note }`.
 */
export function opOpponent(table, args) {
  let current = table;
  if (args.brain === 'auto' || args.brain === 'model') {
    current = advanceTable({ ...table, botBrain: args.brain, pendingDecision: null });
    if (args.action === undefined) {
      return { state: current, note: `\u673a\u5668\u4eba\u8111\u888b\u5df2\u5207\u6362\u4e3a ${args.brain}` };
    }
  }
  if (!current.pendingDecision) throw new Error('\u5f53\u524d\u6ca1\u6709\u7b49\u5f85\u51b3\u7b56\u7684\u673a\u5668\u4eba\uff08\u9700\u5148\u5207\u5230 model \u8111\u888b\uff09');
  if (typeof args.action !== 'string') throw new Error('\u8bf7\u63d0\u4f9b action');
  const decider = current.pendingDecision.name;
  const next = advanceTable(submitBotDecision(current, {
    seat: args.seat,
    action: args.action,
    amount: Number.isFinite(args.amount) ? Math.floor(args.amount) : undefined,
    talk: args.talk,
  }, decideBotAction));
  return { state: next, note: `${decider} \u7684\u51b3\u5b9a\u5df2\u63d0\u4ea4` };
}

/**
 * The `poker_table` payload: the table plus the "what now" trailer.
 *
 * Kept beside the other operations so the tool definition in the entry file
 * stays a one-line delegation, and so every word the model reads lives in the
 * half that reloads.
 * @param table - current state.
 * @param args - `{ reveal? }`.
 */
export function tablePayload(table, args) {
  const revealAll = args.reveal === true;
  const options = revealAll ? { revealAll: true } : {};
  const text = [
    renderTable(table, HERO_SEAT, options),
    '',
    renderSelf(table, HERO_SEAT),
    nextStepHint(table),
  ].join('\n');
  return { text, view: buildView(table, options), meta: null };
}

/**
 * The `poker_equity` payload: a Monte-Carlo estimate for one seat.
 * @param table - current state.
 * @param args - `{ seat?, iterations? }`.
 */
export function equityPayload(table, args) {
  const seat = Number.isFinite(args.seat) ? Math.floor(args.seat) : HERO_SEAT;
  if (!table.players[seat]) throw new Error(`\u6ca1\u6709 ${seat} \u53f7\u5e2d\u4f4d`);
  const iterations = Math.max(100, Math.min(20000, Math.floor(args.iterations ?? 1500)));
  const result = estimateEquity(table, seat, iterations);
  const player = table.players[seat];
  const lines = [
    `**${player.name} \u80dc\u7387\u4f30\u7b97**\uff08${iterations} \u6b21\u6a21\u62df\uff0c\u5bf9\u624b ${result.opponents} \u5bb6\uff09`,
    '',
    renderSelf(table, HERO_SEAT),
    '',
    `- \u80dc\uff1a${result.win}%`,
    `- \u5e73\uff1a${result.tie}%`,
    `- \u8d1f\uff1a${result.lose}%`,
    `- \u671f\u671b\u80dc\u7387\uff08equity\uff09\uff1a**${result.equity}%**`,
  ];
  const view = viewFor(table, HERO_SEAT);
  return { text: lines.join('\n'), view: { ...view, equity: { ...result, seat } }, meta: null };
}

/**
 * The operations the browser route exposes, keyed by URL segment.
 *
 * The route itself lives in the entry file; this table is what it dispatches
 * into, so a click and a tool call can never drift apart.
 */
export const POKER_OPS = {
  action: (table, body) => opAction(table, body),
  next: (table) => opNextHand(table),
  start: (table) => opStart(table),
  rebuy: (table, body) => opRebuy(table, body),
  opponent: (table, body) => opOpponent(table, body).state,
};

/** Opaque table ids, unique per process. */
let tableCounter = 0;

/** A fresh opaque table id. */
function newTableId() {
  tableCounter += 1;
  return `t${tableCounter}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run the table forward with the built-in policy. Kept as one helper so every
 * entry point advances the game identically, and so a future non-heuristic
 * policy is a one-line change.
 * @param state - the game state to advance.
 * @returns the advanced state.
 */
export function advanceTable(state) {
  return advance(state, decideBotAction);
}

/** Exported for tests: total chips in play, a chip-conservation tripwire. */
export function totalChips(state) {
  return state.players.reduce((sum, player) => sum + player.stack, 0) + potTotal(state);
}

/** Exported for tests: the legal menu of whoever is on turn. */
export function menuFor(state) {
  return legalActions(state);
}

/** Exported for tests: a compact one-line summary. */
export function summary(state) {
  return `${renderSituation(state, HERO_SEAT)} | \u5e95\u724c ${cardsLabel(state.players[HERO_SEAT].cards)} | \u5e95\u6c60 ${chips(potTotal(state))}`;
}
