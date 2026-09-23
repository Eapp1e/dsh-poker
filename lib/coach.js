/**
 * The coach: the analysis a good player would give you at the table.
 *
 * Everything here is derived from the engine's own state, so the advice can
 * never disagree with the game the player is actually in:
 *
 * - **What you have**: made hand, kicker context, draws and their outs, plus the
 *   rule of 2 and 4 next to a real Monte-Carlo number (the simulation is the
 *   authority; the outs are the explanation).
 * - **What they have**: every opponent's actions this hand are read into a
 *   range, with the position, the size of the bet relative to the pot and their
 *   personality all narrowing it. That range is then SAMPLED - the equity the
 *   coach quotes is "against the hands this player would actually play this way",
 *   not against two random cards.
 * - **What to do and why**: pot odds, required equity, MDF, SPR and commitment,
 *   turned into a recommendation with its reasons and its risks.
 * - **What you did**: the hero's own actions this hand, annotated against the
 *   standard at that spot.
 * - **What to learn**: one concept card chosen for the spot, and the vocabulary
 *   the advice just used.
 *
 * It is a model of a coach, not an oracle: the ranges are heuristics, and the
 * text says so. It is also entirely optional in the UI - a player who wants to
 * work it out alone can hide the whole layer.
 * @module dsh-plugin-poker/coach
 */
import { RANK_CHARS, SUIT_CHARS, SUIT_NAMES_ZH, cardsLabel, nextRandom, rankOf, suitOf } from './cards.js';
import { CATEGORY, describeHand, evaluate7 } from './evaluator.js';
import { BOT_STYLES, estimateEquity, playsTheBoard, preflopPercentile, preflopStrength } from './bots.js';
import { legalActions, potTotal } from './engine.js';

/** Percentages are shown to one decimal; whole numbers lose nothing here. */
function pct(value) {
  return `${Math.round(value * 10) / 10}%`;
}

/** The four suits as an array, in the order the card codes use. */
const SUITS = [...SUIT_CHARS];

/**
 * The suit character of a card code.
 *
 * {@link suitOf} answers with an index into `SUIT_CHARS`, which is what rank and
 * suit counting wants; anything that spells a suit out (a flush draw, a suit
 * count keyed by letter) has to come back through here.
 */
function suitChar(code) {
  return SUIT_CHARS[suitOf(code)];
}

/**
 * Every two-card combination, best first. Built once: a range is then just the
 * top slice of this list, which is what makes "he is on the top 15%" cheap to
 * sample from on every decision.
 */
const ALL_COMBOS = (() => {
  const combos = [];
  for (let high = 0; high < RANK_CHARS.length; high += 1) {
    for (let low = 0; low <= high; low += 1) {
      for (const suitHigh of SUITS) {
        for (const suitLow of SUITS) {
          if (high === low && suitLow <= suitHigh) continue;
          combos.push([RANK_CHARS[high] + suitHigh, RANK_CHARS[low] + suitLow]);
        }
      }
    }
  }
  const strength = new Map(combos.map((cards) => [cards.join(''), preflopStrength(cards)]));
  return combos.sort((left, right) => strength.get(right.join('')) - strength.get(left.join('')));
})();

/** Range pools by width, so a table of the same ranges is built once. */
const RANGE_POOLS = new Map();

/** A chip amount with its big-blind equivalent, e.g. `300 (3BB)`. */
function money(amount, bigBlind) {
  const value = Math.round(amount);
  if (!bigBlind || bigBlind <= 0) return String(value);
  const bb = Math.round((value / bigBlind) * 10) / 10;
  return `${value} (${Number.isInteger(bb) ? bb : bb.toFixed(1)}BB)`;
}

/** Rank characters from a rank index. */
function rankText(rank) {
  return RANK_CHARS[rank] ?? '?';
}

// ---- position -------------------------------------------------------------

/**
 * Standard position name for one seat, from the blinds backwards.
 * @param state - game state.
 * @param seat - the seat to name.
 * @returns e.g. `按钮位 BTN`, `大盲 BB`, `枪口 UTG`.
 */
export function positionName(state, seat) {
  const dealt = state.players.filter((player) => !player.out).map((player) => player.seat);
  const count = dealt.length;
  if (count < 2) return '—';
  const from = dealt.indexOf(state.bigBlindSeat ?? dealt[1]);
  if (from < 0) return '—';
  const relative = (dealt.indexOf(seat) - from + count) % count;
  if (count === 2) return relative === 0 ? '大盲 BB' : '按钮/小盲 BTN·SB';
  if (relative === 0) return '大盲 BB';
  if (relative === count - 1) return '小盲 SB';
  if (relative === count - 2) return '按钮位 BTN';
  if (relative === count - 3) return '关池位 CO';
  if (relative === count - 4) return '劫位 HJ';
  if (relative === 1) return '枪口位 UTG';
  return '中间位 MP';
}

/** How many seats still have to act behind this one this street. */
function seatsBehind(state, seat) {
  if (state.actorSeat === null) return 0;
  const live = state.players.filter((player) => !player.out && !player.folded && !player.allIn && player.stack > 0);
  const order = [...live].sort((a, b) => a.seat - b.seat).map((player) => player.seat);
  const start = order.indexOf(seat);
  if (start < 0) return 0;
  return order.length - 1 - start;
}

// ---- what you have --------------------------------------------------------

/** Distinct ranks in a set of cards. */
function rankSet(cards) {
  const set = new Set();
  for (const code of cards) set.add(rankOf(code));
  return set;
}

/** Cards per suit, keyed by suit letter. */
function suitCounts(cards) {
  const counts = { s: 0, h: 0, d: 0, c: 0 };
  for (const code of cards) {
    const suit = suitChar(code);
    counts[suit] = (counts[suit] ?? 0) + 1;
  }
  return counts;
}

/** The ten five-rank straight windows, ace-low first. */
const STRAIGHT_WINDOWS = (() => {
  const windows = [[12, 0, 1, 2, 3]];
  for (let low = 0; low <= 8; low += 1) windows.push([low, low + 1, low + 2, low + 3, low + 4]);
  return windows;
})();

/**
 * How a made hand relates to the board, in the words a coach uses: top pair
 * with a kicker, an overpair, a set, and so on.
 * @param cards - the two hole cards.
 * @param board - the community cards.
 * @returns `{ name, label, note }`.
 */
export function madeHand(cards, board) {
  if (board.length < 3) {
    const [high, low] = cards.map(rankOf).sort((a, b) => b - a);
    const suited = suitOf(cards[0]) === suitOf(cards[1]);
    const pair = high === low;
    const gap = high - low - 1;
    const shape = pair
      ? `对子 ${rankText(high)}${rankText(low)}`
      : `${rankText(high)}${rankText(low)}${suited ? 's（同花）' : 'o（不同花）'}`;
    const texture = pair
      ? '已经成对，翻牌中三条约 12%，不中也有摊牌价值'
      : gap === 0
        ? '连张，翻牌能听两头顺'
        : suited
          ? '同花牌，主要靠同花与顺子听牌兑现'
          : '不同花，只能靠成对或顺子';
    return { name: null, label: shape, note: texture };
  }
  const seven = [...cards, ...board];
  const result = evaluate7(seven);
  const name = describeHand(seven);
  const [a, b] = cards.map(rankOf);
  const boardRanks = board.map(rankOf);
  const paired = new Set(boardRanks).size !== boardRanks.length;
  const topBoard = Math.max(...boardRanks);
  const uses = playsTheBoard(cards, board);
  const kicker = (rank) => `${rankText(rank)} 踢脚`;
  let label = name;
  if (a === b) {
    if (boardRanks.includes(a)) label = `三条（暗三 set，${rankText(a)}）`;
    else label = a > topBoard ? `超对 overpair（${rankText(a)}${rankText(b)}）` : `口袋对子（低于牌面最大牌）`;
  } else if (boardRanks.includes(a) || boardRanks.includes(b)) {
    const matched = [a, b].filter((rank) => boardRanks.includes(rank));
    const other = [a, b].find((rank) => !boardRanks.includes(rank));
    const highest = Math.max(...matched);
    const twoPair = matched.length === 2 && !paired;
    if (twoPair) label = `两对 two pair（${rankText(matched[0])} 与 ${rankText(matched[1])}）`;
    else if (result.category === CATEGORY.TRIPS) label = `三条（明三 trips，${rankText(highest)}）`;
    else if (result.category === CATEGORY.FULL_HOUSE) label = `葫芦 full house（${rankText(highest)}）`;
    else if (highest === topBoard) label = `顶对 top pair，${kicker(other)}`;
    else if (highest === Math.max(...boardRanks.filter((rank) => rank < topBoard))) label = `中对 middle pair，${kicker(other)}`;
    else label = `底对 bottom pair，${kicker(other)}`;
  }
  const note = uses
    ? '公共牌自己就是完整牌型：你的底牌没帮上忙，最多只能平分底池'
    : result.category === CATEGORY.HIGH_CARD
      ? '还没成对：目前是高牌，只能靠继续听牌或诈唬'
      : '用上了底牌，是一手真实的成牌';
  return { name, label, note };
}

/**
 * Every draw the hand has, with its outs.
 * @param cards - the two hole cards.
 * @param board - the community cards (needs 3+ to have draws).
 * @returns `{ draws, outs, notes }`.
 */
export function drawsFor(cards, board) {
  const draws = [];
  const notes = [];
  if (board.length < 3 || board.length >= 5) return { draws, outs: 0, notes };
  const seven = [...cards, ...board];
  const suits = suitCounts(seven);
  const boardRanks = board.map(rankOf);
  const paired = new Set(boardRanks).size !== boardRanks.length;
  const flushSuit = SUITS.find((suit) => (suits[suit] ?? 0) === 4);
  const holeMatchesFlush = flushSuit ? cards.some((code) => suitChar(code) === flushSuit) : false;
  if (flushSuit && holeMatchesFlush) {
    draws.push({
      name: `同花听牌（${SUIT_NAMES_ZH[flushSuit]}）`,
      outs: paired ? 8 : 9,
      note: paired
        ? '公共牌成对：对手可能有葫芦或三条，补牌要打折（按 8 张算）'
        : '9 张补牌是同花听牌的标准数',
    });
  } else if (flushSuit) {
    notes.push(`公共牌上有 4 张${SUIT_NAMES_ZH[flushSuit]}，但你手上没有 —— 别人的同花听牌比你强`);
  } else {
    const threeSuit = SUITS.find((suit) => (suits[suit] ?? 0) === 3 && cards.some((code) => suitChar(code) === suit));
    if (threeSuit && board.length === 3) notes.push(`后门同花听牌（${SUIT_NAMES_ZH[threeSuit]}）：连续两张成牌约 4%，只能当小加成`);
  }
  const ranks = rankSet(seven);
  let straight = null;
  for (const window of STRAIGHT_WINDOWS) {
    const present = window.filter((rank) => ranks.has(rank));
    if (present.length !== 4) continue;
    const missing = window.find((rank) => !ranks.has(rank));
    const sorted = [...present].sort((left, right) => left - right);
    const run = sorted[3] - sorted[0] === 3 && (sorted[0] !== 12 || window[0] === 12);
    const open = run && (missing === Math.min(...window) || missing === Math.max(...window));
    if (open) {
      straight = { name: '两头顺听牌 OESD', outs: 8, note: '4 个低端 + 4 个高端，共 8 张补牌' };
      break;
    }
    if (!straight) straight = { name: '卡顺听牌 gutshot', outs: 4, note: '只有一张点数能成顺，通常要配合别的理由才继续' };
  }
  if (straight) draws.push(straight);
  const madeCategory = evaluate7(seven).category;
  const topBoard = Math.max(...boardRanks);
  if (madeCategory === CATEGORY.HIGH_CARD && !paired && cards.every((code) => rankOf(code) > topBoard)) {
    draws.push({ name: '两张高牌', outs: 6, note: '高牌不是强听牌：要小心对手已经成对' });
  }
  const outs = draws.reduce((sum, draw) => sum + draw.outs, 0);
  if (draws.length > 1) notes.push('多个听牌会共用补牌，别把每张都算一遍（同花 + 顺子通常 15 张左右）');
  return { draws, outs, notes };
}

// ---- what they have -------------------------------------------------------

/**
 * Preflop range width implied by an action and a personality, as a share of all
 * starting hands. These are the numbers a coach would quote for "how wide is he".
 */
const OPEN_WIDTH = { rock: 0.09, tag: 0.17, lag: 0.30, station: 0.24, maniac: 0.42, pro: 0.19 };
const CALL_WIDTH = { rock: 0.14, tag: 0.26, lag: 0.38, station: 0.46, maniac: 0.55, pro: 0.30 };
const THREE_BET_WIDTH = { rock: 0.04, tag: 0.08, lag: 0.16, station: 0.06, maniac: 0.26, pro: 0.10 };

/** The personality's label and one-line description, or a neutral default. */
function styleOf(player) {
  const table = BOT_STYLES[player.style] ?? BOT_STYLES.pro;
  return { key: player.style ?? 'pro', ...table };
}

/** The named actions one seat took this hand, as readable fragments. */
function actionsFor(state, seat) {
  const label = { fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', allin: '全下' };
  const entries = [];
  state.actionLog.forEach((entry, index) => {
    if (entry.seat !== seat) return;
    entries.push({
      index,
      street: entry.street,
      action: entry.action,
      amount: entry.amount ?? 0,
      pot: entry.pot ?? 0,
      // A bet or raise logs the TOTAL street commitment ("加注到 300"), and the
      // pot it carries already has those chips in it. Both the chips this action
      // added and the pot it was made into therefore have to be reconstructed.
      chips: chipsAdded(state.actionLog, index),
      potBefore: Math.max(1, (entry.pot ?? 0) - chipsAdded(state.actionLog, index)),
      text: `${label[entry.action] ?? entry.action}${entry.amount ? ' ' + entry.amount : ''}`,
    });
  });
  return entries;
}

/**
 * The chips one logged action actually added.
 *
 * For a bet or a raise the log records the running street total, so the chips
 * added are that total minus what the same seat had already put in this street.
 * @param log - the hand's action log.
 * @param index - the entry to measure.
 */
function chipsAdded(log, index) {
  const entry = log[index];
  if (!entry || (entry.action !== 'bet' && entry.action !== 'raise' && entry.action !== 'allin')) return 0;
  let previous = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const earlier = log[cursor];
    if (earlier.street !== entry.street) break;
    if (earlier.seat === entry.seat) {
      previous = earlier.streetCommitted ?? earlier.amount ?? 0;
      break;
    }
  }
  return Math.max(0, (entry.amount ?? 0) - previous);
}

/** How big one action was relative to the pot it was made into. */
function sizeShare(entry) {
  return entry.chips > 0 ? entry.chips / entry.potBefore : 0;
}

/**
 * Read every live opponent: what they did, what that implies, and how wide their
 * range still is. The width is what the range equity simulation samples from.
 * @param state - game state.
 * @param seat - the hero's seat.
 * @returns one read per live opponent.
 */
export function readOpponents(state, seat) {
  const reads = [];
  for (const player of state.players) {
    if (player.seat === seat || player.out || player.folded) continue;
    const style = styleOf(player);
    const actions = actionsFor(state, player.seat);
    const preflop = actions.filter((entry) => entry.street === 'preflop');
    const postflop = actions.filter((entry) => entry.street !== 'preflop');
    let width = 0.35;
    const lines = [];
    const preflopRaise = preflop.find((entry) => entry.action === 'raise' || entry.action === 'bet' || entry.action === 'allin');
    const preflopCall = preflop.find((entry) => entry.action === 'call');
    if (preflopRaise) {
      const threeBet = preflop.filter((entry) => entry.action === 'raise').length > 1 || preflopRaise.amount > state.config.bigBlind * 6;
      width = threeBet ? THREE_BET_WIDTH[style.key] ?? 0.10 : OPEN_WIDTH[style.key] ?? 0.18;
      lines.push(`翻前${threeBet ? '再加注（3-bet）' : '主动加注'}到 ${preflopRaise.amount} —— 大致是前 ${pct(width * 100)} 的起手：大对子、强 A、强同花连张`);
    } else if (preflopCall) {
      width = CALL_WIDTH[style.key] ?? 0.30;
      lines.push(`翻前只是跟注 —— 前 ${pct(width * 100)} 左右：中小对子、同花连张、带 A 的同花牌，缺少 AA/KK 这种顶级牌`);
    } else if (preflop.some((entry) => entry.action === 'check')) {
      width = 0.72;
      lines.push('翻前在大盲过牌 —— 范围极宽，任何两张都可能');
    } else if (preflop.length > 0) {
      lines.push(`翻前${preflop[0].text}`);
    }
    const styleNote = `${style.label}（${style.desc}）`;
    for (const entry of postflop) {
      const size = sizeShare(entry);
      if (entry.action === 'bet' || entry.action === 'raise') {
        if (entry.action === 'raise') {
          lines.push(`${streetZh(entry.street)}加注到 ${money(entry.amount, state.config.bigBlind)}（加注额 ${money(entry.chips, state.config.bigBlind)}，约 ${pct(size * 100)} 池）—— 两极化的动作：要么比顶对更强，要么是纯诈唬，很少是中等牌`);
          width = Math.min(width, 0.12);
        } else if (size >= 0.75) {
          lines.push(`${streetZh(entry.street)}下注 ${money(entry.chips, state.config.bigBlind)}（约 ${pct(size * 100)} 池）—— 大注偏两极化：强牌要价值，或用大注施压`);
          width = Math.min(width, 0.16);
        } else if (size >= 0.4) {
          lines.push(`${streetZh(entry.street)}下注 ${money(entry.chips, state.config.bigBlind)}（约 ${pct(size * 100)} 池）—— 标准尺度：顶对以上拿价值，或听牌半诈唬`);
          width = Math.min(width, 0.22);
        } else {
          lines.push(`${streetZh(entry.street)}小注 ${money(entry.chips, state.config.bigBlind)}（约 ${pct(size * 100)} 池）—— 小注范围很宽：中等牌、封锁注、也可能是在试探`);
          width = Math.min(width, 0.35);
        }
      } else if (entry.action === 'call') {
        lines.push(`${streetZh(entry.street)}跟注 —— 中等牌或听牌；如果是 ${style.label}，也可能是慢打强牌`);
        width = Math.min(width, 0.30);
      } else if (entry.action === 'check') {
        lines.push(`${streetZh(entry.street)}过牌 —— 通常代表他愿意控池：中等牌、听牌，或者陷阱`);
        width = Math.min(width, 0.45);
      }
    }
    // Firing again on a later street is much stronger evidence than any single
    // bet: one bet can be a c-bet with air, two in a row cannot. This compounds.
    const barrels = postflop.filter((entry) => entry.action === 'bet' || entry.action === 'raise' || entry.action === 'allin').length;
    if (barrels >= 2) {
      width *= 0.72 ** (barrels - 1);
      lines.push(`连续 ${barrels} 条街主动下注（barrel）—— 一次下注可能是诈唬，连续开枪就不是了，范围大幅收窄`);
    }
    reads.push({
      seat: player.seat,
      name: player.name,
      style: styleNote,
      aggression: style.aggression,
      bluff: style.bluff,
      width: Math.max(0.03, Math.min(0.9, width)),
      stack: player.stack,
      committed: player.handCommitted,
      lines,
      allIn: player.allIn === true,
    });
  }
  return reads;
}

/** Chinese street name for a log entry. */
function streetZh(street) {
  return { preflop: '翻前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' }[street] ?? street;
}

// ---- equity against a read range -----------------------------------------

/**
 * The top `width` share of starting hands, best first.
 *
 * Card removal is deliberately NOT applied here: the pool is a range, and the
 * simulation rejects a sampled holding that collides with a known card. That
 * keeps one pool per width reusable across every decision.
 * @param width - share of all starting hands, 0..1.
 * @returns an array of two-card combinations.
 */
function combosFor(width) {
  const key = Math.max(0.02, Math.min(0.95, Math.round(width * 100) / 100));
  const cached = RANGE_POOLS.get(key);
  if (cached) return cached;
  const take = Math.max(12, Math.round(ALL_COMBOS.length * key));
  const pool = ALL_COMBOS.slice(0, take);
  RANGE_POOLS.set(key, pool);
  return pool;
}

/**
 * How likely a hand that holds this category would have taken that action. This
 * is the "range narrowing" step: a player who bets big rarely has air, and a
 * calling station rarely has nothing either.
 */
function actionWeight(category, read) {
  const strong = category >= CATEGORY.TWO_PAIR;
  const medium = category === CATEGORY.PAIR;
  const bluffShare = 0.06 + read.bluff * 0.5;
  if (strong) return 1;
  if (medium) return 0.45 + read.aggression * 0.35;
  return Math.max(0.05, bluffShare);
}

/** Is there a five-card run in these rank counts (ace low included)? */
function hasRun(ranks) {
  const has = (rank) => ranks[rank] > 0;
  if (has(12) && has(0) && has(1) && has(2) && has(3)) return true;
  for (let low = 0; low <= 8; low += 1) {
    let ok = true;
    for (let step = 0; step < 5; step += 1) {
      if (!has(low + step)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * A cheap category for one holding on one board, used only to decide whether a
 * combo belongs in a narrowed range.
 *
 * It counts ranks and suits instead of enumerating five-card hands, so it costs
 * a fraction of {@link evaluate7}. The simulation's actual comparison still uses
 * the real evaluator - this only shapes the range.
 */
function quickCategory(cards, board) {
  const ranks = new Array(13).fill(0);
  const suits = [0, 0, 0, 0];
  for (const code of cards) {
    ranks[rankOf(code)] += 1;
    suits[suitOf(code)] += 1;
  }
  for (const code of board) {
    ranks[rankOf(code)] += 1;
    suits[suitOf(code)] += 1;
  }
  let pairs = 0;
  let trips = 0;
  let quads = 0;
  for (const count of ranks) {
    if (count === 2) pairs += 1;
    else if (count === 3) trips += 1;
    else if (count >= 4) quads += 1;
  }
  if (quads > 0) return CATEGORY.QUADS;
  if (trips > 0 && pairs > 0) return CATEGORY.FULL_HOUSE;
  if (Math.max(...suits) >= 5) return CATEGORY.FLUSH;
  if (hasRun(ranks)) return CATEGORY.STRAIGHT;
  if (trips > 0) return CATEGORY.TRIPS;
  if (pairs >= 2) return CATEGORY.TWO_PAIR;
  if (pairs === 1) return CATEGORY.PAIR;
  return CATEGORY.HIGH_CARD;
}

/**
 * Equity against the ranges the reads describe, not against random hands.
 *
 * Each opponent's range is narrowed ONCE against the board on show - a holding
 * they would not have played this way is thinned out before the first iteration -
 * and the remaining combos are sampled uniformly. That keeps the whole thing
 * affordable on every click while still answering the real question: "how do I
 * do against the hands he actually has here".
 * @param state - game state.
 * @param seat - the hero's seat.
 * @param reads - the output of {@link readOpponents}.
 * @param iterations - simulation count.
 * @returns `{ equity, win, tie, lose, iterations, opponents, margin }`, with
 *   `margin` the standard error of the estimate in percentage points.
 */
export function equityVsReads(state, seat, reads, iterations) {
  const hero = state.players[seat];
  const known = new Set([...hero.cards, ...state.board]);
  const deck = [];
  for (const rank of RANK_CHARS) for (const suit of SUITS) if (!known.has(rank + suit)) deck.push(rank + suit);
  const board = state.board.slice();
  const need = 5 - board.length;
  const pools = reads.map((read, readIndex) => {
    const pool = combosFor(read.width);
    if (board.length < 3) return pool;
    const kept = pool.filter((cards, index) => {
      if (known.has(cards[0]) || known.has(cards[1])) return false;
      const weight = actionWeight(quickCategory(cards, board), read);
      if (weight >= 0.5) return true;
      // Deterministic thinning, so one street's range does not flicker between
      // two decisions: the same combo always survives or not.
      const noise = ((index + 1) * 2654435761 + readIndex * 40503) % 1000 / 1000;
      return noise < weight;
    });
    return kept.length >= 6 ? kept : pool;
  });
  let rng = (state.rng ?? 1) >>> 0;
  const sample = () => {
    const step = nextRandom(rng);
    rng = step.state;
    return step.value;
  };
  const drawn = () => deck[Math.floor(sample() * deck.length)];
  let wins = 0;
  let ties = 0;
  const effective = Math.max(80, Math.round(iterations));
  for (let iteration = 0; iteration < effective; iteration += 1) {
    const used = new Set(known);
    const runout = [];
    for (let index = 0; index < need; index += 1) {
      let card = drawn();
      let guard = 0;
      while (used.has(card) && guard < 60) {
        card = drawn();
        guard += 1;
      }
      used.add(card);
      runout.push(card);
    }
    const full = [...board, ...runout];
    const heroScore = evaluate7([...hero.cards, ...full]).score;
    let best = -1;
    for (const pool of pools) {
      let opponentCards = null;
      for (let attempt = 0; attempt < 10 && opponentCards === null; attempt += 1) {
        const candidate = pool[Math.floor(sample() * pool.length)];
        if (used.has(candidate[0]) || used.has(candidate[1]) || candidate[0] === candidate[1]) continue;
        opponentCards = candidate;
      }
      if (opponentCards === null) {
        let first = drawn();
        while (used.has(first)) first = drawn();
        let second = drawn();
        while (used.has(second) || second === first) second = drawn();
        opponentCards = [first, second];
      }
      used.add(opponentCards[0]);
      used.add(opponentCards[1]);
      best = Math.max(best, evaluate7([...opponentCards, ...full]).score);
    }
    if (heroScore > best) wins += 1;
    else if (heroScore === best) ties += 1;
  }
  const equity = (wins + ties / 2) / effective;
  const margin = Math.sqrt(Math.max(0.0001, equity * (1 - equity)) / effective) * 100;
  return {
    win: Math.round((wins / effective) * 1000) / 10,
    tie: Math.round((ties / effective) * 1000) / 10,
    lose: Math.round(((effective - wins - ties) / effective) * 1000) / 10,
    equity: Math.round(equity * 1000) / 10,
    iterations: effective,
    opponents: reads.length,
    margin: Math.round(margin * 10) / 10,
  };
}

// ---- the money math -------------------------------------------------------

/**
 * The numbers a decision actually turns on.
 * @param state - game state.
 * @param seat - the hero's seat.
 * @param legal - the hero's legal menu (null when it is not their turn).
 */
export function potMath(state, seat, legal) {
  const hero = state.players[seat];
  const pot = potTotal(state);
  const bigBlind = state.config.bigBlind;
  const toCall = legal ? legal.toCall : Math.max(0, state.currentBet - hero.streetCommitted);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const opponents = state.players.filter((player) => !player.out && !player.folded && player.seat !== seat);
  const liveStacks = opponents.filter((player) => !player.allIn).map((player) => player.stack);
  const effective = liveStacks.length > 0 ? Math.min(hero.stack, Math.max(...liveStacks)) : hero.stack;
  const spr = pot > 0 ? effective / pot : 0;
  const potBeforeBet = Math.max(1, pot - toCall);
  const mdf = toCall > 0 ? potBeforeBet / (potBeforeBet + toCall) : 0;
  const committed = hero.handCommitted + hero.streetCommitted;
  return {
    pot,
    toCall,
    potOdds,
    requiredEquity: potOdds,
    mdf,
    spr,
    effective,
    committed,
    commitShare: hero.stack + committed > 0 ? committed / (hero.stack + committed) : 0,
    bigBlind,
    opponents: opponents.length,
  };
}

// ---- advice ---------------------------------------------------------------

/** A preflop hand's class, in the words players use at the table. */
function preflopClass(cards) {
  const [high, low] = cards.map(rankOf).sort((a, b) => b - a);
  const suited = suitOf(cards[0]) === suitOf(cards[1]);
  if (high === low) return `口袋对子 ${rankText(high)}${rankText(low)}`;
  return `${rankText(high)}${rankText(low)}${suited ? 's 同花' : 'o 不同花'}`;
}

/** Which concept the spot is really about. */
function pickLesson(spot) {
  if (spot.facingBet && spot.street !== 'preflop') return 'potOdds';
  if (spot.draws > 0) return 'outs';
  if (spot.street === 'preflop' && spot.unopened) return 'position';
  if (spot.street === 'preflop') return 'ranges';
  if (spot.checkedTo && spot.wasAggressor) return 'cbet';
  if (spot.facingBet && spot.street === 'river') return 'blockers';
  if (spot.spr > 6) return 'spr';
  if (spot.checkedTo) return 'valueBet';
  return 'mdf';
}

/** The concept cards, written to be read in ten seconds. */
const LESSONS = {
  potOdds: {
    title: '底池赔率（pot odds）',
    why: '跟注不是"我觉得能赢"，而是"赢的概率够不够覆盖这个价格"。',
    how: '需要的胜率 = 跟注额 ÷ (底池 + 跟注额)。把教练给的"实际胜率"和这个数比：大于就跟，明显小于就弃。',
    example: '底池 300，对手下注 100：需要 100 ÷ 400 = 25%。你的牌有 33% 胜率 → 长期是赚钱的跟注。',
  },
  outs: {
    title: '补牌与 2/4 法则',
    why: '听牌的价值来自"还有多少张牌能让我反超"，先把补牌数出来，再换成概率。',
    how: '翻牌圈：补牌 × 4 ≈ 成牌概率；转牌圈：补牌 × 2 ≈ 成牌概率。这个近似在补牌 8 张以内比较准。',
    example: '两头顺 8 张补牌，翻牌圈约 32%，转牌圈约 16%。但对手下注很大时，还要看隐含赔率够不够。',
  },
  position: {
    title: '位置就是信息',
    why: '最后一个行动的人能看到所有人怎么做，再用信息决定；先行动的人只能猜。',
    how: '按钮位（BTN）可以玩最多手牌；枪口位（UTG）要最紧。位置越靠后，同样一手牌越值得开池加注。',
    example: 'A9s 在按钮位是标准的开池加注；同样这手牌在枪口位通常只能弃牌。',
  },
  ranges: {
    title: '范围思维（range）',
    why: '不要问"他有什么牌"，要问"他这样打的时候，可能是哪些牌的集合"。',
    how: '用位置 + 动作 + 尺度把范围收窄：翻前加注≈前 15-20%，大注≈强牌或诈唬，小注≈很宽。范围变窄，你的胜率判断才准。',
    example: '对手翻前加注、翻牌继续下注 2/3 池：他的范围里 AA/顶对/强听牌占多数，纯空气很少。',
  },
  cbet: {
    title: '持续下注（c-bet）',
    why: '翻牌前加注的人有"范围优势"，翻牌后小注就能拿到弃牌收益，或者为强牌建立底池。',
    how: '干燥面（如 K72 彩虹）用 1/3 池高频下注；湿润面（同花 + 连张）要么大注保护，要么过牌控池。',
    example: 'A♣8♦2♥ 这种面，你在按钮位开池：小注 1/3 池几乎不会错，因为对手很难有 A。',
  },
  valueBet: {
    title: '价值下注：让更差的牌跟',
    why: '下注的目的只有三个：让更差的牌跟（价值）、让更好的牌弃（诈唬）、保护自己的equity（保护）。',
    how: '问自己"他会不会用更差的牌跟？"——会，就是价值下注；不会，但能让更好的牌弃，才是诈唬。',
    example: '你顶对 A 带好踢脚，对手是跟注站：下注 2/3 池，他 J 高也会跟，这就是价值。',
  },
  semiBluff: {
    title: '半诈唬（semi-bluff）',
    why: '听牌下注/加注同时有两种赢法：对手弃牌，或者你成牌。',
    how: '选那些"即使被跟也有补牌"的牌去诈唬；纯空气诈唬只在对手范围弱、能弃牌时才用。',
    example: '同花听牌在翻牌圈加注：他弃牌你直接赢，他跟注你还有 35% 左右翻盘。',
  },
  mdf: {
    title: 'MDF：不能被诈唬打穿',
    why: '如果你面对下注总是弃牌，对手用任意两张下注就能盈利。MDF 是"至少要防守多少比例"。',
    how: 'MDF = 底池 ÷ (底池 + 下注额)。对手下注半池时约 67%，一池时约 50%。',
    example: '底池 200、对手下注 100：你需要继续 200 ÷ 300 ≈ 67% 的牌，否则对手可以无脑诈唬。',
  },
  spr: {
    title: 'SPR：筹码与底池的比例',
    why: 'SPR 决定一手牌"能不能翻倍"：SPR 越小，强对子越值得全下；SPR 越大，听牌和位置越重要。',
    how: 'SPR = 有效筹码 ÷ 底池。SPR ≤ 3 时顶对通常可以全下；SPR ≥ 10 时不要用一对打光筹码。',
    example: '翻前 3-bet 后底池 900、剩 3000：SPR 3.3，顶对基本可以打到全下。',
  },
  blockers: {
    title: '阻断牌（blockers）',
    why: '你手上没有的牌，对手就更可能有——反过来，你手上的牌会"挡住"对手的强牌组合。',
    how: '河牌想诈唬时，手上拿着对手强牌需要的牌（比如 A 或同花的关键张）最好；想价值下注时，别拿掉他能跟注的牌。',
    example: '你手上是 A♥，牌面三张红桃：对手拿到坚果同花的组合少了很多，他的大注更可能是诈唬。',
  },
  implied: {
    title: '隐含赔率（implied odds）',
    why: '直接赔率不够时，成牌之后还能再赢到的筹码可以补上差距。',
    how: '看三点：你的听牌是否"隐蔽"（成牌后对手还会付钱）、筹码是否够深、补牌是否干净（不是对手的更强牌）。',
    example: '小对子翻前跟注：直接赔率很差，但中了三条往往能赢一个大底池，这就是隐含赔率。',
  },
};

// ---- review ---------------------------------------------------------------

/** The hero's own actions, annotated against the standard at that spot. */
function reviewActions(state, seat, pot) {
  const hero = state.players[seat];
  const entries = actionsFor(state, seat);
  const bigBlind = state.config.bigBlind;
  const items = [];
  for (const entry of entries) {
    const size = sizeShare(entry);
    let verdict = '可以';
    let note = '';
    if (entry.street === 'preflop') {
      if (entry.action === 'raise') {
        const opens = entry.amount / bigBlind;
        if (opens >= 2.2 && opens <= 3.2) {
          verdict = '标准';
          note = `${entry.amount} 是 ${Math.round(opens * 10) / 10}BB 的开池，2.5-3BB 是标准尺度`;
        } else if (opens < 2.2) {
          verdict = '偏小';
          note = `${entry.amount} 只有 ${Math.round(opens * 10) / 10}BB：加注太小，容易被跟注而且给对手好赔率`;
        } else {
          verdict = '偏大';
          note = `${entry.amount} 是 ${Math.round(opens * 10) / 10}BB：开池太大，通常只会被更强的牌跟`;
        }
      } else if (entry.action === 'call') {
        const strength = preflopStrength(hero.cards);
        const top = Math.round((1 - preflopPercentile(strength)) * 100);
        if (top > 55) {
          verdict = '偏松';
          note = `这手牌大约在前 ${top}%，跟注偏松；同位置更常见的是弃牌或加注入池`;
        } else {
          verdict = '合理';
          note = `这手牌约在前 ${top}%，跟注没什么问题`;
        }
      } else if (entry.action === 'check') {
        verdict = '免费看牌';
        note = '大盲过牌没有代价，但翻后你是第一个行动的人，位置最差';
      } else if (entry.action === 'fold') {
        verdict = '合理';
        note = '翻前弃牌永远没错到哪去，尤其是位置差的时候';
      }
    } else if (entry.action === 'bet' || entry.action === 'raise') {
      if (size >= 0.75) {
        verdict = '大注';
        note = `${money(entry.chips, bigBlind)} 约 ${pct(size * 100)} 池：大注应该是强牌或纯诈唬，中间牌别用这个尺度`;
      } else if (size >= 0.4) {
        verdict = '标准';
        note = `${money(entry.chips, bigBlind)} 约 ${pct(size * 100)} 池：这是最通用的价值/半诈唬尺度`;
      } else {
        verdict = '小注';
        note = `${money(entry.chips, bigBlind)} 约 ${pct(size * 100)} 池：小注适合干燥面持续下注或封锁注，但很难赶走听牌`;
      }
    } else if (entry.action === 'call') {
      verdict = '继续';
      note = `${money(entry.amount, bigBlind)} 的跟注：确认一下当时算过赔率——够就跟，不够就该弃`;
    } else if (entry.action === 'check') {
      verdict = '过牌';
      note = '过牌往往是控池：但如果你有成牌且对手爱跟注，过牌会少赢一笔';
    }
    items.push({
      label: `${streetZh(entry.street)} · ${entry.text}`,
      text: `${verdict} —— ${note}`,
    });
  }
  if (items.length === 0) items.push({ label: '本手还未行动', text: `底池 ${money(pot, bigBlind)}，轮到你时再复盘` });
  return items;
}

// ---- assembly -------------------------------------------------------------

/**
 * Build the whole coaching payload for one seat.
 *
 * Returns `null` when there is nothing to coach (no cards on screen yet).
 * @param state - game state.
 * @param seat - the hero's seat.
 * @param options - `{ iterations }` to trade accuracy for latency.
 * @returns `{ sections, brief, equity }` for the view and the model text.
 */
export function coachFor(state, seat, options = {}) {
  const hero = state.players[seat];
  if (!hero || hero.cards.length < 2) return null;
  const board = state.board.slice();
  const bigBlind = state.config.bigBlind;
  const street = state.street;
  const legal = state.actorSeat === seat ? legalActions(state) : null;
  const live = state.players.filter((player) => !player.out && !player.folded);
  const opponents = live.filter((player) => player.seat !== seat);
  const math = potMath(state, seat, legal);
  const made = madeHand(hero.cards, board);
  const draw = drawsFor(hero.cards, board);
  const reads = readOpponents(state, seat);
  // The simulation is the expensive part, so the budget scales with how many
  // ranges have to be drawn each iteration: about 600 evaluations per decision,
  // which keeps a click under ~50ms on a full ring.
  const iterations = Number.isFinite(options.iterations)
    ? options.iterations
    : Math.max(150, Math.round(600 / (opponents.length + 1)));
  const vsReads = reads.length > 0 ? equityVsReads(state, seat, reads, iterations) : null;
  const position = positionName(state, seat);
  const behind = seatsBehind(state, seat);
  const toCall = legal ? legal.toCall : math.toCall;
  const facingBet = toCall > 0;
  const unopened = street === 'preflop' && state.currentBet <= bigBlind;
  const strength = preflopStrength(hero.cards);
  const topShare = Math.round((1 - preflopPercentile(strength)) * 100);
  const sections = [];

  // 1. the situation
  const spotLines = [
    `你在${position}${board.length >= 3 ? `，${streetZh(street)}` : '，翻牌前'}：${live.length} 人还在手里${behind > 0 ? `，你后面还有 ${behind} 人要行动` : '，你是最后一个行动的人（位置最好）'}。`,
    `底池 ${money(math.pot, bigBlind)}${facingBet ? `，需要跟 ${money(toCall, bigBlind)}` : '，暂时没人下注'}；有效筹码 ${money(math.effective, bigBlind)}，SPR ${Math.round(math.spr * 10) / 10}。`,
  ];
  if (math.commitShare > 0.25) spotLines.push(`你已经投入了手上筹码的 ${pct(math.commitShare * 100)}：底池变大后，很多决定会变成"要么全下要么弃牌"。`);
  sections.push({ id: 'spot', icon: '🧭', title: '局面', lines: spotLines });

  // 2. what you hold
  const handLines = board.length >= 3
    ? [`底牌 ${cardsLabel(hero.cards)}：${made.label}（${made.name}）。`, made.note]
    : [`底牌 ${cardsLabel(hero.cards)}：${made.label} —— ${made.note}。`];
  for (const drawn of draw.draws) handLines.push(`${drawn.name}：约 ${drawn.outs} 张补牌 —— ${drawn.note}`);
  for (const note of draw.notes) handLines.push(note);
  if (draw.outs > 0) {
    const factor = board.length === 3 ? 4 : board.length === 4 ? 2 : 0;
    const rule = factor > 0 ? `${draw.outs} × ${factor} ≈ ${draw.outs * factor}%` : '—';
    handLines.push(`2/4 法则估算成牌概率：${rule}${vsReads ? `；把补牌兑现成胜率大约 ${Math.round(vsReads.equity)}%（蒙特卡罗对上他们的范围，更准）` : ''}。`);
  } else if (vsReads) {
    handLines.push(`当前胜率：约 ${Math.round(vsReads.equity)}%（模拟 ${vsReads.iterations} 次，误差 ±${vsReads.margin}%，对手按他们的动作收窄了范围）。`);
  }
  if (unopened && street === 'preflop') {
    handLines.push(`这手牌是 ${preflopClass(hero.cards)}，牌力大约在所有起手牌的前 ${topShare}%。`);
  }
  sections.push({ id: 'hand', icon: '🃏', title: '你的牌', lines: handLines });

  // 3. reading them
  const readItems = reads.map((read) => ({
    // The seat id travels with the read so a surface can attach it to the right
    // player without matching names (the table hovers a seat to show its read).
    seat: read.seat,
    label: `${read.name} · ${read.style}`,
    text: `${read.lines.join('；') || '还没有动作，暂时只能靠性格判断'}。当前估计范围宽度约 ${pct(read.width * 100)}${read.allIn ? '，且已经全下' : ''}。`,
  }));
  if (readItems.length === 0) readItems.push({ label: '没有还在手的对手', text: '对手都弃牌了，这一手不需要读牌。' });
  sections.push({
    id: 'reads',
    icon: '🔍',
    title: `读牌：对面可能是什么（${readItems.length} 家）`,
    lines: ['动作越强、尺度越大，范围越窄；范围越窄，你的胜率判断越准。'],
    items: readItems,
  });

  // 4. the money and the recommendation
  const mathItems = [
    { label: '底池赔率 pot odds', text: facingBet ? `${money(toCall, bigBlind)} ÷ (${money(math.pot, bigBlind)} + ${money(toCall, bigBlind)}) = ${pct(math.potOdds * 100)}` : '无人下注，不需要算赔率' },
    { label: '需要的胜率', text: facingBet ? `跟注至少要 ${pct(math.requiredEquity * 100)} 的胜率才不亏` : '过牌是免费的，胜率只影响你下不下注' },
  ];
  if (board.length >= 3 && facingBet) {
    mathItems.push({ label: 'MDF 最低防守频率', text: `底池 ÷ (底池 + 下注) = ${pct(math.mdf * 100)}：低于这个数，对手用任意两张诈唬就能赚（翻后概念，翻前不适用）` });
  }
  mathItems.push({ label: 'SPR', text: `${Math.round(math.spr * 10) / 10}（有效筹码 ÷ 底池）${math.spr <= 3 ? '：很小，顶对可以打到全下' : math.spr >= 8 ? '：很大，一对不值得打光筹码' : ''}` });
  mathItems.push({ label: '对抗实际范围', text: vsReads ? `约 ${Math.round(vsReads.equity)}%（±${vsReads.margin}%）：把对手的范围按他们的动作收窄后模拟 ${vsReads.iterations} 次` : '—' });
  sections.push({ id: 'math', icon: '🧮', title: '数学', items: mathItems });

  // 5. the plan - or, once the hand is settled, the result to learn from
  let plan = { headline: '', reasons: [], risks: [], tags: [], tone: 'info', action: null };
  if (state.phase === 'betting') {
    plan = planFor({ state, seat, legal, math, made, draw, reads, vsReads, position, unopened, topShare, street, board, facingBet, bigBlind, behind });
    sections.splice(2, 0, {
      id: 'plan',
      icon: '🎯',
      title: '下注逻辑与建议',
      tone: plan.tone,
      lines: [plan.headline, ...plan.reasons],
      items: plan.risks.length > 0 ? [{ label: '风险 / 反面', text: plan.risks.join('；') }] : [],
      tags: plan.tags,
    });
  } else {
    const won = Number(hero.wonLastHand) || 0;
    plan = {
      headline: won > 0 ? `你赢下 ${money(won, bigBlind)}` : '这一手没有赢下底池',
      reasons: [`你的最终牌型：${made.label}${made.name ? `（${made.name}）` : ''}。`, '复盘看下面「复盘」一栏：把每个决定和当时的赔率对一遍，比结果本身重要。'],
      tags: [],
      tone: won > 0 ? 'good' : 'info',
      action: null,
    };
    sections.splice(2, 0, {
      id: 'plan',
      icon: '🏁',
      title: '本手结果',
      tone: plan.tone,
      lines: [plan.headline, ...plan.reasons],
      items: [],
      tags: [],
    });
  }

  // 6. your own play, annotated
  sections.push({ id: 'review', icon: '📝', title: '复盘：你这几手', items: reviewActions(state, seat, math.pot) });

  // 7. one concept, chosen for this spot
  const lesson = LESSONS[pickLesson({
    street,
    facingBet,
    checkedTo: !facingBet,
    draws: draw.outs,
    wasAggressor: state.actionLog.some((entry) => entry.seat === seat && (entry.action === 'raise' || entry.action === 'bet')),
    spr: math.spr,
  })];
  sections.push({
    id: 'lesson',
    icon: '🎓',
    title: `本手概念：${lesson.title}`,
    lines: [`为什么重要：${lesson.why}`, `怎么用：${lesson.how}`, `例子：${lesson.example}`],
  });

  // Preflop, only the big blind is "in front of you": quoting a pot-odds number
  // for that would be noise, so the brief only does it against a real bet.
  const realBet = toCall > 0 && (board.length >= 3 || state.currentBet > bigBlind);
  const brief = [
    `教练：${position}｜${made.label}${draw.outs > 0 ? ` + ${draw.outs} 张补牌` : ''}｜对手 ${reads.length} 家`,
    vsReads ? `对抗他们的范围约 ${Math.round(vsReads.equity)}% 胜率（±${vsReads.margin}%）${realBet ? `，跟注需要 ${pct(math.requiredEquity * 100)}` : ''}。` : '',
    `建议：${plan.headline}`,
    `理由：${plan.reasons[0] ?? ''}`,
  ].filter(Boolean).join('\n');

  return {
    version: 1,
    sections,
    brief,
    tags: plan.tags,
    // The headline as data, so the table itself can show what the coach wants
    // ("教练建议：弃牌") next to the buttons that would do it.
    plan: { headline: plan.headline, action: plan.action, tone: plan.tone },
    equity: vsReads,
    math: { potOdds: math.potOdds, requiredEquity: math.requiredEquity, mdf: math.mdf, spr: math.spr },
  };
}

/**
 * Turn the analysis into one recommendation with reasons, risks and the terms a
 * learner should take away from the spot.
 */
function planFor(context) {
  const { state, math, made, draw, reads, vsReads, position, unopened, topShare, street, board, facingBet, bigBlind, seat, behind } = context;
  const hero = state.players[seat];
  const equity = vsReads ? vsReads.equity / 100 : null;
  const required = math.requiredEquity;
  const tags = [];
  const reasons = [];
  const risks = [];
  const style = reads.length > 0 ? reads[0] : null;
  const station = reads.some((read) => read.style.includes('跟注站'));
  const maniac = reads.some((read) => read.style.includes('疯子'));
  const raiser = reads.reduce((widest, read) => (widest === null || read.width < widest.width ? read : widest), null);
  const category = board.length >= 3 ? evaluate7([...hero.cards, ...board]).category : null;
  const strong = category !== null && category >= CATEGORY.TWO_PAIR;
  const topPair = category === CATEGORY.PAIR && made.label.startsWith('顶对');
  const canValue = strong || topPair;
  /** Whole percentages: the simulation does not deserve a decimal. */
  const show = (value) => `${Math.round(value * 100)}%`;
  let headline = '过牌，看看下一张';
  // The action the advice amounts to, so the table can mark the matching button.
  let action = null;
  let tone = 'info';

  if (street === 'preflop' && unopened) {
    if (topShare <= 20) {
      headline = `开池加注（open）到 ${Math.round(bigBlind * 3)} 左右`;
      action = 'raise';
      reasons.push(`这手牌在前 ${topShare}%，位置是${position}，加注入池能直接拿下盲注，也能在翻后继续代表强牌。`);
      tags.push({ term: 'open', zh: '开池加注', why: '无人入池时第一个加注，通常是 2.5-3 个大盲' });
      tone = 'good';
    } else if (topShare <= 45 && position.includes('BTN')) {
      headline = `开池加注（open）到 ${Math.round(bigBlind * 2.5)}`;
      action = 'raise';
      reasons.push(`这手牌在前 ${topShare}%，在按钮位可以放宽开池范围：位置好，翻后好收尾。`);
      tags.push({ term: 'open', zh: '开池加注', why: '位置好后，开池范围可以更宽' });
    } else {
      // The headline has to answer "why fold?" on its own: the table shows this
      // one line, and "等更好的位置或牌" left the reader asking what that meant.
      headline = `弃牌：${made.label} 在${position}太弱${behind > 0 ? `（后面还有 ${behind} 人）` : ''}`;
      action = 'fold';
      reasons.push(`翻前牌力排序里，${made.label} 大约排在前 ${topShare}%：比它强的牌有很多，而你在${position}，${behind > 0 ? `后面还有 ${behind} 个人没说话，随便谁加注你就得弃牌` : '已经是最后一个说话的人，没人陪你进池'}。用这种牌入池，长期是往底池里送钱。`);
      risks.push(`想玩这种边缘牌，要等到位置好（CO/BTN）或者前面的人都弃牌，那时它可以便宜地开池或偷盲。`);
      tone = 'warn';
    }
    risks.push('如果后面有人再加注（3-bet），最弱的那部分开池牌要果断放弃');
    if (facingBet && math.toCall <= bigBlind) {
      reasons.push(`不过你只需要补 ${money(math.toCall, bigBlind)} 就能看翻牌，盲注位用便宜价格看牌是可以接受的。`);
    }
  } else if (street === 'preflop' && facingBet) {
    // Preflop is a hand-versus-range question, not a pot-odds one: the decision
    // is "is my hand ahead of what he raises with, and can I realise it".
    const theirWidth = raiser ? raiser.width : 0.2;
    const theirShare = Math.round(theirWidth * 100);
    const inPosition = position.includes('BTN') || position.includes('CO');
    if (topShare <= 4) {
      headline = `再加注（3-bet）到 ${Math.round(state.currentBet * 3)} 左右`;
      action = 'raise';
      reasons.push(`这手牌在前 ${topShare}%，比他前 ${theirShare}% 的加注范围更强：再加注能把更差的牌赶走，把底池做大。`);
      tags.push({ term: '3-bet', zh: '再加注', why: '面对开池加注时再加注，通常是顶级牌或作为诈唬' });
      tone = 'good';
    } else if (topShare <= theirShare) {
      headline = inPosition ? '跟注，用位置打翻后' : '跟注，但要小心位置';
      action = 'call';
      reasons.push(`你的手牌在前 ${topShare}%，落在他的加注范围（前 ${theirShare}%）之内或附近：跟注能保住范围宽度，但要靠位置和翻后技术兑现。`);
      if (inPosition) reasons.push(`你在${position}，是翻后最后一个行动的人：同样的牌，位置好就值得多玩。`);
      else reasons.push(`你在${position}，翻后要先行动：这种情况下跟注要更谨慎，容易被压制。`);
      tone = 'info';
    } else if (math.toCall <= bigBlind && position.includes('大盲')) {
      headline = `跟注 ${money(math.toCall, bigBlind)}，大盲折扣价看翻牌`;
      action = 'call';
      reasons.push(`你的手牌只在前 ${topShare}%，但大盲已经投入了 ${money(state.config.bigBlind, bigBlind)}，补 ${money(math.toCall, bigBlind)} 就能看翻牌，直接赔率划算。`);
      tone = 'info';
    } else {
      headline = '弃牌';
      action = 'fold';
      reasons.push(`这手牌只在前 ${topShare}%，而他的加注范围是前 ${theirShare}%：继续玩等于用更差的范围打更大的底池。`);
      reasons.push('翻前弃牌省下的筹码，就是你在好位置、好牌力时的武器。');
      tone = 'bad';
    }
    risks.push('翻前跟注之后，翻牌没中就要准备放弃：别用"已经投了钱"当继续的理由');
  } else if (facingBet) {
    const margin = equity === null ? null : equity - required;
    const noise = vsReads ? vsReads.margin / 100 : 0.03;
    if (equity !== null && margin !== null && margin >= 0.15 + noise && canValue) {
      headline = `加注到 ${money(Math.round((math.pot + math.toCall) * 0.9 / bigBlind) * bigBlind, bigBlind)}，把价值做起来`;
      action = 'raise';
      reasons.push(`对抗他们的范围你有约 ${show(equity)} 胜率，远高于跟注需要的 ${show(required)}：与其跟注，不如加注从更差的成牌那里多拿钱。`);
      reasons.push(`${made.label} —— 属于值得做大底池的牌${topPair ? '（顶对）' : ''}。`);
      tags.push({ term: 'raise for value', zh: '价值加注', why: '胜率明显领先时加注，让更差的牌付更多钱' });
      tone = 'good';
    } else if (equity !== null && margin !== null && margin >= noise) {
      headline = `跟注 ${money(math.toCall, bigBlind)}`;
      action = 'call';
      reasons.push(`跟注需要 ${show(required)} 胜率，你大约有 ${show(equity)}（模拟误差 ±${vsReads ? vsReads.margin : 3}%）—— 领先得够多，长期跟注是赚的。`);
      if (draw.outs > 0) reasons.push(`${draw.draws.map((item) => item.name).join(' + ')} 还有 ${draw.outs} 张补牌，成牌后还能再赢一笔。`);
      tags.push({ term: 'pot odds', zh: '底池赔率', why: '跟注额 ÷ (底池 + 跟注额) = 需要的胜率' });
      tone = 'good';
    } else if (equity !== null && draw.outs >= 8 && math.spr >= 4) {
      headline = `跟注 ${money(math.toCall, bigBlind)}，靠听牌和隐含赔率`;
      action = 'call';
      reasons.push(`直接赔率差一点（需要 ${show(required)}，你有约 ${show(equity)}），但 ${draw.outs} 张补牌成牌后通常还能再赢到筹码，这就是隐含赔率。`);
      tags.push({ term: 'implied odds', zh: '隐含赔率', why: '成牌之后还能赢到的钱，可以补上直接赔率的不足' });
      tone = 'info';
    } else if (equity !== null && margin !== null && margin >= -noise) {
      headline = `跟注或弃牌都说得过去（边缘牌）`;
      action = 'mixed';
      reasons.push(`你需要 ${show(required)}，大约有 ${show(equity)}：差距在模拟误差（±${vsReads ? vsReads.margin : 3}%）之内。`);
      reasons.push('这种牌长期没什么差别，选让你后面更好打的那个：位置好、对手爱跟注就跟，位置差就弃。');
      tone = 'info';
    } else if (equity !== null) {
      headline = '弃牌';
      action = 'fold';
      reasons.push(`跟注需要 ${show(required)} 胜率，你只有约 ${show(equity)}，而且${draw.outs > 0 ? '补牌不够多' : '没有听牌可以反超'}。`);
      reasons.push('弃牌不是认输，是把筹码留给更清楚的机会。');
      tone = 'bad';
    } else {
      headline = `跟注 ${money(math.toCall, bigBlind)} 或弃牌`;
      action = 'mixed';
      reasons.push('还没有足够的牌面信息，先看对手的动作和尺度再决定。');
    }
    if (station) risks.push('对面是跟注站：诈唬和加注施压的效果都差，价值下注才是对的');
    if (maniac) risks.push('对面是疯子：他会用很宽的范围下注，别把一次大注当成绝对的强牌');
    if (math.mdf > 0 && math.mdf < 0.6) risks.push(`注意 MDF：面对这个尺度你需要继续约 ${pct(math.mdf * 100)} 的牌，否则对手可以无脑诈唬`);
  } else {
    // Checked to us, or we are first to act. How many players are still in the
    // hand decides whether one pair is a value bet or a bluff catcher: against
    // four opponents, top pair is not the hand to build a big pot with.
    const field = reads.length + 1;
    const multiway = field >= 3;
    const thinValue = canValue && (!multiway || (equity !== null && equity >= 0.45));
    if (thinValue) {
      headline = `下注 ${money(Math.round((math.pot * 0.66) / bigBlind) * bigBlind, bigBlind)}（约 2/3 池）`;
      action = 'bet';
      reasons.push(`${made.label} —— 值得收价值：更差的牌（更小的对子、听牌）会跟注。`);
      reasons.push(`用 2/3 池的尺度：太小吃不到价值，太大赶走你想要的跟注。`);
      tags.push({ term: 'value bet', zh: '价值下注', why: '为了让更差的牌跟注而下注' });
      tone = 'good';
    } else if (canValue && multiway && draw.outs < 8) {
      headline = '过牌，多人底池里控池';
      action = 'check';
      action = "check";
      reasons.push(`${field} 人还在手里，${made.label} 只能算中等强度${equity !== null ? `：对抗他们的范围只有约 ${show(equity)} 胜率` : ''}，大注只会被更好的牌跟注。`);
      reasons.push('多人底池的成牌门槛更高：两对以上才值得做大底池，一对要学会控池。');
      tone = 'warn';
    } else if (draw.outs >= 8) {
      headline = `下注 ${money(Math.round((math.pot * 0.5) / bigBlind) * bigBlind, bigBlind)}（半诈唬）`;
      action = 'bet';
      reasons.push(`${draw.draws.map((item) => item.name).join(' + ')}，被跟注也还有 ${draw.outs} 张补牌：这是半诈唬，两种赢法。`);
      reasons.push('半诈唬比纯诈唬好，因为它有后备方案。');
      tags.push({ term: 'semi-bluff', zh: '半诈唬', why: '听牌下注：对手弃牌你赢，被跟还有补牌' });
      tone = 'info';
    } else if (board.length >= 3 && board.length <= 3 && reads.length <= 2 && !station) {
      headline = `小注 ${money(Math.round((math.pot * 0.33) / bigBlind) * bigBlind, bigBlind)}（持续下注 c-bet）`;
      action = 'bet';
      reasons.push('翻牌圈你代表的范围更强（对手跟注范围里很少有你怕的牌），小注就能让大部分空气弃牌。');
      if (style) reasons.push(`${style.name} 是${style.style.split('（')[0]}，如果他很爱跟注，这手小注诈唬的价值会下降。`);
      tags.push({ term: 'c-bet', zh: '持续下注', why: '翻前加注者在翻牌圈继续下注，用小注施压' });
      tone = 'info';
    } else {
      headline = '过牌，控制底池';
      action = 'check';
      action = "check";
      reasons.push(`${made.label} 不够强，也没有足够的听牌：下注只会被更好的牌跟注。`);
      reasons.push('过牌可以便宜地看下一张，同时留着诈唬的机会。');
      tone = 'warn';
    }
    if (math.spr <= 3) risks.push(`SPR 只有 ${Math.round(math.spr * 10) / 10}：这种深度下，强牌应该直接往全下打，不要慢慢下注`);
    if (multiway) risks.push(`多人底池：诈唬的成功率明显下降，${field - 1} 个对手里通常总有人有牌`);
  }
  return { headline, reasons: reasons.slice(0, 4), risks: risks.slice(0, 3), tags, tone, action };
}
