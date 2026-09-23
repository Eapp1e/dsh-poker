/**
 * Five-to-seven card hand evaluation for Texas Hold'em.
 *
 * `evaluate7` scores the best five-card hand out of seven by brute force over
 * the 21 combinations. That is a few microseconds per call, which is far cheaper
 * than the bugs a hand-rolled rank-counting evaluator invites, and it makes the
 * comparison rule obvious: a higher score is a strictly better hand.
 * @module dsh-plugin-poker/evaluator
 */
import { SUIT_SYMBOLS, rankLabel, suitOf } from './cards.js';

/** Category ranks, lowest to highest. */
export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

/** Chinese names per category. */
const NAMES_ZH = [
  '\u9ad8\u724c',
  '\u4e00\u5bf9',
  '\u4e24\u5bf9',
  '\u4e09\u6761',
  '\u987a\u5b50',
  '\u540c\u82b1',
  '\u846b\u82a6',
  '\u56db\u6761',
  '\u540c\u82b1\u987a',
];

/** English names per category. */
const NAMES_EN = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

/**
 * Pack a category and up to five tiebreak ranks into one comparable integer.
 * Four bits per rank leaves room for ranks 0..12, and twenty bits for the
 * category keeps the whole thing inside a safe integer.
 */
function pack(category, ranks) {
  let score = category * 0x100000;
  const padded = ranks.slice(0, 5);
  while (padded.length < 5) padded.push(0);
  for (let i = 0; i < 5; i += 1) score += padded[i] * 16 ** (4 - i);
  return score;
}

/** Decode a card code into rank and suit indices. */
function decode(code) {
  return { r: '23456789TJQKA'.indexOf(code[0].toUpperCase()), s: suitOf(code) };
}

/**
 * Score exactly five cards.
 * @param codes - five card codes.
 * @returns category and tiebreak ranks, packed as one comparable score.
 */
export function evaluate5(codes) {
  const cards = codes.map(decode);
  const ranks = cards.map((card) => card.r).sort((a, b) => b - a);
  const flush = cards.every((card) => card.s === cards[0].s);

  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  // Group order drives every non-flush category: count first, then rank.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = -1;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    // The wheel: A-5-4-3-2 plays as a five-high straight.
    else if (ranks[0] === 12 && ranks[1] === 3) straightHigh = 3;
  }

  if (straightHigh >= 0 && flush) return { score: pack(CATEGORY.STRAIGHT_FLUSH, [straightHigh]), category: CATEGORY.STRAIGHT_FLUSH, ranks: [straightHigh] };
  if (groups[0][1] === 4) {
    const ranksOut = [groups[0][0], groups[1][0]];
    return { score: pack(CATEGORY.QUADS, ranksOut), category: CATEGORY.QUADS, ranks: ranksOut };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    const ranksOut = [groups[0][0], groups[1][0]];
    return { score: pack(CATEGORY.FULL_HOUSE, ranksOut), category: CATEGORY.FULL_HOUSE, ranks: ranksOut };
  }
  if (flush) return { score: pack(CATEGORY.FLUSH, ranks), category: CATEGORY.FLUSH, ranks };
  if (straightHigh >= 0) return { score: pack(CATEGORY.STRAIGHT, [straightHigh]), category: CATEGORY.STRAIGHT, ranks: [straightHigh] };
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((group) => group[0]);
    const ranksOut = [groups[0][0], ...kickers];
    return { score: pack(CATEGORY.TRIPS, ranksOut), category: CATEGORY.TRIPS, ranks: ranksOut };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const kicker = groups[2][0];
    const ranksOut = [groups[0][0], groups[1][0], kicker];
    return { score: pack(CATEGORY.TWO_PAIR, ranksOut), category: CATEGORY.TWO_PAIR, ranks: ranksOut };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((group) => group[0]);
    const ranksOut = [groups[0][0], ...kickers];
    return { score: pack(CATEGORY.PAIR, ranksOut), category: CATEGORY.PAIR, ranks: ranksOut };
  }
  return { score: pack(CATEGORY.HIGH_CARD, ranks), category: CATEGORY.HIGH_CARD, ranks };
}

/** All k-sized index combinations of 0..n-1. */
function combinations(n, k) {
  const out = [];
  const current = [];
  const walk = (start) => {
    if (current.length === k) {
      out.push(current.slice());
      return;
    }
    for (let i = start; i < n; i += 1) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/** Cached index combinations per input size — the only two sizes in play. */
const COMBO_CACHE = new Map([
  [5, null],
  [6, combinations(6, 5)],
  [7, combinations(7, 5)],
]);

/**
 * Score the best five-card hand out of five, six, or seven cards.
 * @param codes - 5..7 card codes.
 * @returns `{ score, category, ranks, best }` where `best` is the winning five.
 */
export function evaluate7(codes) {
  if (codes.length < 5) throw new Error(`evaluate7 requires at least 5 cards, got ${codes.length}`);
  if (codes.length === 5) {
    const result = evaluate5(codes);
    return { ...result, best: codes.slice() };
  }
  const combos = COMBO_CACHE.get(codes.length) ?? combinations(codes.length, 5);
  let best = null;
  let bestCodes = null;
  for (const combo of combos) {
    const five = combo.map((index) => codes[index]);
    const result = evaluate5(five);
    if (best === null || result.score > best.score) {
      best = result;
      bestCodes = five;
    }
  }
  return { ...best, best: bestCodes };
}

/**
 * Readable hand description, e.g. `\u846b\u82a6 (Full House)`.
 * @param result - an {@link evaluate7} result.
 * @param locale - `zh`, `en`, or `both` (default).
 */
export function handName(result, locale = 'both') {
  const zh = NAMES_ZH[result.category];
  const en = NAMES_EN[result.category];
  if (locale === 'zh') return zh;
  if (locale === 'en') return en;
  return `${zh} (${en})`;
}

/**
 * A short, specific description that names the cards that matter, e.g.
 * `\u4e00\u5bf9 K (Pair of Kings)`. Used in showdown summaries.
 * @param codes - 5..7 card codes.
 */
export function describeHand(codes) {
  const result = evaluate7(codes);
  const ranks = result.ranks ?? [];
  const label = (rank) => rankLabel('23456789TJQKA'[rank] + 's');
  const category = result.category;
  let detail = '';
  if (category === CATEGORY.STRAIGHT_FLUSH || category === CATEGORY.STRAIGHT) detail = ranks[0] === 3 ? 'A-5' : `${label(ranks[0])} high`;
  else if (category === CATEGORY.QUADS) detail = `${label(ranks[0])}`;
  else if (category === CATEGORY.FULL_HOUSE) detail = `${label(ranks[0])} full of ${label(ranks[1])}`;
  else if (category === CATEGORY.FLUSH) detail = `${label(ranks[0])} high`;
  else if (category === CATEGORY.TRIPS) detail = `${label(ranks[0])}`;
  else if (category === CATEGORY.TWO_PAIR) detail = `${label(ranks[0])} & ${label(ranks[1])}`;
  else if (category === CATEGORY.PAIR) detail = `${label(ranks[0])}`;
  else detail = `${label(ranks[0])} high`;
  return `${NAMES_ZH[category]} ${detail} (${NAMES_EN[category]})`;
}

/** The five best cards as glyphs, e.g. `A\u2660 K\u2660 Q\u2660 J\u2660 T\u2660`. */
export function bestFiveLabel(result) {
  return result.best
    .map((code) => rankLabel(code) + (SUIT_SYMBOLS[code[1].toLowerCase()] ?? code[1]))
    .join(' ');
}
