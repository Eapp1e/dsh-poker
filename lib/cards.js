/**
 * Card primitives for the poker plugin: deck construction, a seeded
 * deterministic PRNG, and card code formatting.
 *
 * A card is a two-character code: rank char (one of `23456789TJQKA`) followed by
 * suit char (one of `shdc`). Codes are plain strings so every game state stays
 * lossless JSON that can be logged, replayed, and shipped to a browser UI.
 * @module dsh-plugin-poker/cards
 */

/** Rank characters, weakest (2) to strongest (A); the index IS the rank value. */
export const RANK_CHARS = '23456789TJQKA';

/** Suit characters in a fixed order; the index IS the suit value. */
export const SUIT_CHARS = 'shdc';

/** Display glyph per suit char. */
export const SUIT_SYMBOLS = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };

/** Chinese suit names, used in match narration. */
export const SUIT_NAMES_ZH = { s: '\u9ed1\u6843', h: '\u7ea2\u6843', d: '\u65b9\u5757', c: '\u6885\u82b1' };

/** Rank index (0 = deuce .. 12 = ace) of a card code. */
export function rankOf(code) {
  return RANK_CHARS.indexOf(code[0].toUpperCase());
}

/** Suit index (0 = spade, 1 = heart, 2 = diamond, 3 = club) of a card code. */
export function suitOf(code) {
  return SUIT_CHARS.indexOf(code[1].toLowerCase());
}

/** Human-readable rank: `T` renders as `10` for display, everything else as-is. */
export function rankLabel(code) {
  const rank = rankOf(code);
  return rank === 8 ? '10' : RANK_CHARS[rank];
}

/** Display form of a card, e.g. `A\u2660`. */
export function cardLabel(code) {
  return rankLabel(code) + (SUIT_SYMBOLS[code[1].toLowerCase()] ?? code[1]);
}

/** Display form of a two-card hand, e.g. `A\u2660 K\u2665`. */
export function cardsLabel(codes) {
  return codes.map(cardLabel).join(' ');
}

/** A fresh, ordered 52-card deck. */
export function makeDeck() {
  const deck = [];
  for (let r = 0; r < RANK_CHARS.length; r += 1) {
    for (let s = 0; s < SUIT_CHARS.length; s += 1) deck.push(RANK_CHARS[r] + SUIT_CHARS[s]);
  }
  return deck;
}

/**
 * One step of a mulberry32 PRNG. The state is a plain uint32 carried inside the
 * game state, so a hand is fully reproducible from its logged seed: no hidden
 * entropy, no platform randomness — replaying the log deals the same cards.
 * @param state - current uint32 PRNG state.
 * @returns the sample in [0,1) and the next PRNG state.
 */
export function nextRandom(state) {
  const next = (state + 0x6d2b79f5) >>> 0;
  let x = next;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

/**
 * Fisher-Yates shuffle against the deterministic PRNG.
 * @param deck - cards to shuffle (not mutated).
 * @param rng - current PRNG state.
 * @returns the shuffled deck and the advanced PRNG state.
 */
export function shuffle(deck, rng) {
  const out = deck.slice();
  let state = rng >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const step = nextRandom(state);
    state = step.state;
    const j = Math.floor(step.value * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return { deck: out, rng: state };
}

/** Draw the top card, returning both the card and the shortened pile. */
export function draw(deck) {
  const card = deck[0];
  return { card, rest: deck.slice(1) };
}

/** A fresh random seed (used only when the caller does not pin one). */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}
