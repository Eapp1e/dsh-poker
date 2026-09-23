/**
 * Opponent policy: the built-in heuristic brain every non-human seat uses, plus
 * a Monte-Carlo equity estimate the model can consult on demand.
 *
 * The brain is deliberately readable rather than optimal: each seat has a
 * personality expressed as four numbers (tightness, aggression, bluff
 * frequency, trap frequency), and the same decision function serves them all.
 * Randomness comes from the game's own seeded PRNG, so "why did the bot do
 * that?" is answerable by replaying the log.
 * @module dsh-plugin-poker/bots
 */
import { nextRandom, RANK_CHARS, rankOf, suitOf } from './cards.js';
import { evaluate7 } from './evaluator.js';
import { legalActions, potTotal } from './engine.js';

/** Personality presets. Every number is a probability or a 0..1 dial. */
export const BOT_STYLES = {
  rock: { label: '\u5ca9\u77f3', tightness: 0.82, aggression: 0.22, bluff: 0.03, trap: 0.18, desc: '\u53ea\u73a9\u597d\u724c\uff0c\u4e0d\u4e71\u6765' },
  tag: { label: '\u7d27\u51f6', tightness: 0.62, aggression: 0.58, bluff: 0.10, trap: 0.14, desc: '\u724c\u597d\u5c31\u653b\uff0c\u724c\u5dee\u5c31\u8d70' },
  lag: { label: '\u677e\u51f6', tightness: 0.30, aggression: 0.78, bluff: 0.26, trap: 0.08, desc: '\u4ec0\u4e48\u724c\u90fd\u6562\u6253' },
  station: { label: '\u8ddf\u6ce8\u7ad9', tightness: 0.20, aggression: 0.12, bluff: 0.02, trap: 0.30, desc: '\u4e0d\u7231\u5f03\u724c\uff0c\u96be\u903c\u8d70' },
  maniac: { label: '\u75af\u5b50', tightness: 0.10, aggression: 0.92, bluff: 0.40, trap: 0.04, desc: '\u5929\u5929\u5168\u4e0b\uff0c\u60ca\u5413\u4e13\u5bb6' },
  pro: { label: '\u8001\u7ec3', tightness: 0.55, aggression: 0.62, bluff: 0.16, trap: 0.22, desc: '\u4f4d\u7f6e\u4f18\u5148\uff0c\u7b97\u6bd4\u4f8b' },
};

/** Bot display names, assigned in order. */
export const BOT_NAMES = ['\u8001\u738b', '\u963f\u73cd', '\u77f3\u5934', '\u5927\u718a', '\u5c0f\u7f8e', '\u8001K', '\u963f\u98de', '\u94c1\u5934'];

/** Style rotation used when the caller asks for a mixed table. */
const STYLE_ROTATION = ['tag', 'station', 'lag', 'rock', 'maniac', 'pro'];

/** Taunt / flavour lines per situation, keyed by style mood. */
const TALK = {
  bet: ['\u8fd9\u628a\u6211\u613f\u610f\u73a9\u5927\u70b9', '\u8ddf\u4e0d\u8ddf\uff1f', '\u522b\u6015\uff0c\u6211\u4e0d\u662f\u6bcf\u6b21\u90fd\u6709\u724c', '\u52a0\u6ce8\u662f\u4e00\u79cd\u6001\u5ea6'],
  bluff: ['\u6211\u8fd9\u724c\u771f\u7684\u5f88\u5927', '\u4f60\u80fd\u4e0d\u80fd\u63a5\u5f97\u4f4f\uff1f', '\u8fd9\u5c40\u6211\u8d62\u5b9a\u4e86'],
  call: ['\u6211\u8ddf', '\u4ef7\u683c\u5408\u9002', '\u770b\u4e00\u773c\u4e0d\u4e8f'],
  fold: ['\u7b97\u4e86', '\u8fd9\u724c\u4e0d\u662f\u6211\u7684', '\u4f60\u8d62\u4e86\u8fd9\u4e00\u624b'],
  win: ['\u8c22\u8c22\u60e0\u987e', '\u8fd0\u6c14\u597d\u800c\u5df2'],
};

/** A random number in [0,1) drawn from, and advancing, the game's PRNG. */
function roll(state) {
  const step = nextRandom(state.rng);
  state.rng = step.state;
  return step.value;
}

/** Random integer in [low, high]. */
function rollInt(state, low, high) {
  return low + Math.floor(roll(state) * (high - low + 1));
}

/** Pick one line from a talk pool. */
function talkFrom(state, pool, style) {
  if (state.botsQuiet) return null;
  const table = BOT_STYLES[style] ?? BOT_STYLES.pro;
  const chance = 0.22 + table.aggression * 0.25;
  if (roll(state) > chance) return null;
  return pool[Math.floor(roll(state) * pool.length)];
}

/**
 * Chen-style preflop strength, normalised to 0..1. Pairs, high cards, suited
 * connectors and small gaps score higher, which is a good enough model of "is
 * this hand worth playing" for a heuristic opponent.
 * @param cards - the two hole cards.
 */
export function preflopStrength(cards) {
  if (cards.length < 2) return 0;
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const [high, low] = ranks;
  const suited = suitOf(cards[0]) === suitOf(cards[1]);
  const faceScore = { 12: 10, 11: 8, 10: 7 }[high] ?? (high + 2) / 2;
  const pair = high === low;
  // A pair gets a flat bonus on top of the doubled high card. Plain Chen rates 88
  // EQUAL to KQo, but a pair brings set value and already-made showdown value, so
  // the bots should treat it as the better hand it is.
  let score = pair ? Math.min(20, faceScore * 2 + 4) : faceScore;
  if (suited) score += 2;
  // Only unpaired hands have a gap. A pair used to compute gap = -1, fall through
  // to the widest-gap penalty and score BELOW KQo - which is why 88 never played.
  if (!pair) {
    const gap = high - low - 1;
    score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (high < 10 && gap <= 1) score += 1;
  }
  return Math.max(0, Math.min(1, score / 20));
}

/**
 * Every starting-hand strength, expanded by how many card combinations make it
 * and sorted ascending. Read as a percentile, strength becomes a RANGE: "the top
 * 20% of hands" is something a player can check, "0.42" is not.
 */
const PREFLOP_SORTED = (() => {
  const list = [];
  const ranks = '23456789TJQKA';
  for (let high = 12; high >= 0; high -= 1) {
    for (let low = high; low >= 0; low -= 1) {
      const pair = high === low;
      const strength = preflopStrength([ranks[high] + 's', ranks[low] + (pair ? 'h' : 's')]);
      const weight = pair ? 6 : 4 + 12;
      for (let index = 0; index < weight; index += 1) list.push(strength);
    }
  }
  return list.sort((a, b) => a - b);
})();

/**
 * Where one hand sits among all 1326 starting combinations: 1 is aces, 0 is the
 * worst hand.
 * @param strength - a {@link preflopStrength} value.
 * @returns the share of starting combinations at or below it.
 */
export function preflopPercentile(strength) {
  let low = 0;
  let high = PREFLOP_SORTED.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (PREFLOP_SORTED[mid] <= strength) low = mid + 1;
    else high = mid;
  }
  return low / PREFLOP_SORTED.length;
}

/**
 * How many players still act after this seat on the current street: position, in
 * the only form this policy needs.
 *
 * "Still act" excludes anyone who has already acted, which is what makes the big
 * blind's spot different from the first seat's: preflop the blinds post but have not
 * acted, and once the action comes back to the big blind everyone else HAS - so the
 * big blind closes the action with nobody behind it, and defends accordingly.
 * Counting seats alone made the big blind defend as tightly as under the gun.
 * @param state - game state.
 * @param seat - the seat being priced.
 */
export function playersBehind(state, seat) {
  const total = state.players.length;
  let count = 0;
  for (let step = 1; step < total; step += 1) {
    const player = state.players[(seat + step) % total];
    if (!player || player.folded || player.out || player.allIn) continue;
    if (player.hasActed) continue;
    count += 1;
  }
  return count;
}

/**
 * Typical opening ranges by how many players act behind: the button opens wide,
 * the first seat to act opens tight. Index is `playersBehind`.
 *
 * These are wider than a solver's on purpose. A heuristic table has no reads, so the
 * only thing that keeps a game alive is that somebody plays a hand: with the old,
 * tighter table the bots folded 72% of first-in decisions (the MANIAC folded 66% of
 * them) and only 28% of hands reached a flop, which the player quite reasonably reads
 * as "everyone folds, all the time".
 */
const OPEN_BY_BEHIND = [0.66, 0.56, 0.48, 0.40, 0.34, 0.29, 0.25, 0.22, 0.19];

/**
 * The preflop plan: open or fold by position, three-bet the top of the range,
 * and defend the blinds when the price is small.
 *
 * The old policy compared one absolute strength threshold in every seat, so in a
 * big field the early seats folded almost everything and a table could go dozens
 * of hands with no non-blind player entering a pot.
 * @param state - game state.
 * @param player - the acting seat.
 * @param style - its personality.
 * @param legal - its legal action menu.
 * @returns `{ action, amount?, talk? }`.
 */
function decidePreflop(state, player, style, legal) {
  const percentile = preflopPercentile(preflopStrength(player.cards));
  const behind = playersBehind(state, player.seat);
  // Personality as a multiplier on the positional range: a rock plays about a third
  // of what a maniac plays, and both keep the same positional shape.
  const looseness = 0.62 + (1 - style.tightness) * 1.05;
  const openRange = Math.min(0.75, OPEN_BY_BEHIND[Math.min(OPEN_BY_BEHIND.length - 1, behind)] * looseness);
  const bigBlind = state.config.bigBlind;
  const raised = state.currentBet > bigBlind;
  const pot = potTotal(state);
  const potOdds = legal.toCall > 0 ? legal.toCall / (pot + legal.toCall) : 0;
  /** A raise-to target rounded to clean blind multiples. */
  const size = (target) => Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, roundToBlind(target, bigBlind)));

  if (!raised) {
    if (percentile >= 1 - openRange && legal.canRaise) {
      const premium = percentile >= 0.94;
      // Raising when checking is free only makes sense with a real hand.
      if (legal.toCall === 0 && !premium) return { action: 'check' };
      // Opens sit in the standard 2.4-3BB band the coach quotes, and grow a
      // little with the number of players left to act.
      return {
        action: 'raise',
        amount: size(bigBlind * (2.4 + behind * 0.06 + style.aggression * 0.4)),
        talk: talkFrom(state, TALK.bet, player.style),
      };
    }
    if (legal.toCall === 0) return { action: 'check' };
    // Completing or limping is cheap. NOTE the direction: a percentile of 0.22
    // means "better than the worst 22%", so continuing ranges must be written as
    // `1 - range` - reading it the other way round is what let 78% of hands limp.
    const limpRange = 0.18 + (1 - style.tightness) * 0.34;
    if (legal.toCall <= bigBlind && percentile >= 1 - limpRange) return { action: 'call' };
    // Getting a real price with a hand that can flop something.
    if (potOdds < 0.2 && percentile >= 0.55) return { action: 'call' };
    return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
  }

  // Continuing against a raise is a NARROWER range than opening, always: the raiser
  // has shown strength. The old numbers had it backwards - they defended with 1.5x
  // the opening range, so 76% of bots continued against a big raise and 62% against
  // a stack-committing one, which is the "an all-in gets called by half the table"
  // half of the complaint.
  const raiseInBlinds = state.currentBet / bigBlind;
  const stackCommitted = legal.toCall >= player.stack * 0.55 || state.currentBet >= player.stack * 0.55;
  const continueRange = stackCommitted
    ? Math.min(0.1, openRange * 0.2)
    : raiseInBlinds <= 3.5
      ? Math.min(0.42, openRange * 0.75)
      : raiseInBlinds <= 7
        ? Math.min(0.28, openRange * 0.5)
        : Math.min(0.18, openRange * 0.35);
  // Re-raising over a raise needs the top of the range; over a SHOVE it needs a
  // premium, because the range it is attacking is already only strong hands.
  const threeBetRange = stackCommitted
    ? Math.min(0.05, openRange * 0.1)
    : Math.min(0.16, openRange * 0.22);
  if (percentile >= 1 - threeBetRange && legal.canRaise && roll(state) > style.trap) {
    // Three bets are bigger out of the blinds: acting first on every later street
    // is worth paying to avoid.
    const inBlinds = player.seat === state.smallBlindSeat || player.seat === state.bigBlindSeat;
    return {
      action: 'raise',
      amount: size(state.currentBet * ((inBlinds ? 3.9 : 2.9) + style.aggression * 0.4)),
      talk: talkFrom(state, TALK.bet, player.style),
    };
  }
  if (percentile >= 1 - continueRange) return { action: 'call', talk: talkFrom(state, TALK.call, player.style) };
  if (potOdds < 0.2 && percentile >= 0.55) return { action: 'call' };
  return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
}

/** Does the hand hold a flush draw using at least one hole card? */
function hasFlushDraw(cards, board) {
  if (board.length < 3) return false;
  const all = [...cards, ...board];
  const counts = [0, 0, 0, 0];
  for (const code of all) counts[suitOf(code)] += 1;
  const suit = counts.findIndex((count) => count === 4);
  if (suit < 0) return false;
  return cards.some((code) => suitOf(code) === suit);
}

/** Rough straight-draw detection over the ranks present. */
function hasStraightDraw(cards, board) {
  if (board.length < 3) return 0;
  const ranks = new Set([...cards, ...board].map(rankOf));
  if (ranks.has(12)) ranks.add(-1); // ace plays low
  let best = 0;
  let bestStart = -1;
  for (let start = -1; start <= 8; start += 1) {
    let run = 0;
    for (let i = 0; i < 5; i += 1) if (ranks.has(start + i)) run += 1;
    if (run > best) {
      best = run;
      bestStart = start;
    }
  }
  if (best < 4) return 0;
  // Four to a straight inside a five-card window: open-ended when the missing
  // rank is at one end of the window, a gutshot when it is in the middle.
  const window = [0, 1, 2, 3, 4].map((offset) => bestStart + offset);
  const missing = window.filter((rank) => !ranks.has(rank));
  return missing.length === 1 && (missing[0] === window[0] || missing[0] === window[4]) ? 1 : 0.6;
}

/**
 * Does this hand fail to beat the board itself?
 *
 * On the river the board is a complete five-card hand, so a player whose best
 * seven-card hand is no better than the board is "playing the board": they beat
 * nobody who connected with it and can only chop. Treating that as a strong
 * made hand (the category alone says "two pair"!) is how a calling station ends
 * up paying off a river bet holding 2-3 on a paired board.
 * @param cards - hole cards.
 * @param board - community cards.
 * @returns true when the hole cards add nothing on the river.
 */
export function playsTheBoard(cards, board) {
  if (board.length !== 5 || cards.length !== 2) return false;
  return evaluate7([...cards, ...board]).score <= evaluate7(board).score;
}

/**
 * Postflop strength in 0..1, blending the made hand with draw equity.
 * @param cards - hole cards.
 * @param board - community cards.
 */
export function postflopStrength(cards, board) {
  const all = [...cards, ...board];
  const result = evaluate7(all);
  const boardRanks = board.map(rankOf).sort((a, b) => b - a);
  const holeRanks = cards.map(rankOf);
  const category = result.category;
  // The board's own hand is not the player's hand.
  if (playsTheBoard(cards, board)) return 0.08;
  let strength;
  switch (category) {
    case 8:
      strength = 1;
      break;
    case 7:
      strength = 0.98;
      break;
    case 6:
      strength = 0.94;
      break;
    case 5:
      strength = 0.9;
      break;
    case 4:
      strength = 0.84;
      break;
    case 3:
      strength = 0.75;
      break;
    case 2:
      strength = 0.64;
      break;
    case 1: {
      const pairRank = result.ranks[0];
      const boardTop = Math.max(...boardRanks);
      const isPocket = holeRanks[0] === holeRanks[1];
      if (isPocket && pairRank > boardTop) strength = 0.58;
      else if (pairRank >= boardTop) strength = holeRanks.includes(pairRank) ? 0.54 : 0.44;
      else if (pairRank >= boardRanks[1] ?? 0) strength = 0.36;
      else strength = 0.24;
      break;
    }
    default: {
      const high = result.ranks[0];
      const usesHole = holeRanks.includes(high);
      // High card is worth something mainly through its overcards: an unpaired
      // ace-high hand is roughly a 20% hand, not the 34% the old flat scale gave
      // it, which is what let ace-high call three quarters of the pot.
      const boardTop = Math.max(...boardRanks);
      const overcards = holeRanks.filter((rank) => rank > boardTop).length;
      strength = (usesHole ? 0.1 + (high / 12) * 0.1 : 0.04) + (overcards === 2 ? 0.07 : overcards === 1 ? 0.03 : 0);
    }
  }
  // Draws are worth what they can actually make. The floors used to rate a
  // gutshot (four outs) nearly as high as an open-ender, which is how a LAG ended
  // up calling three quarters of the pot on the turn holding J-high: the draw was
  // worth ~8% but scored 0.34, and the call rule never looked at the price.
  //
  // On the RIVER there are no more cards to come, so a four-flush or a four-straight
  // is not a draw at all - it is the high card it busted to. Counting it as equity
  // made every miss "worth" a third of the pot on the last street.
  if (board.length <= 4) {
    const twoCardsToCome = board.length === 3;
    if (hasFlushDraw(cards, board)) strength = Math.max(strength, twoCardsToCome ? 0.45 : 0.33);
    const straightDraw = hasStraightDraw(cards, board);
    if (straightDraw === 1) strength = Math.max(strength, twoCardsToCome ? 0.42 : 0.31);
    else if (straightDraw === 0.6) strength = Math.max(strength, twoCardsToCome ? 0.22 : 0.16);
  }
  return Math.max(0, Math.min(1, strength));
}

/** Round a chip amount to a clean multiple of the big blind. */
function roundToBlind(amount, bigBlind) {
  const step = Math.max(1, Math.round(bigBlind / 2));
  return Math.max(step, Math.round(amount / step) * step);
}

/**
 * Stack-to-pot ratio for one seat: how many pots are still behind.
 *
 * Below about 3 the money is going in anyway, so a made hand should put it in
 * rather than bet a fraction that hands a draw the right price. This is exactly
 * what the coach tells the player ("SPR ≤ 3：顶对可以打到全下"), so the bots do it.
 * @param state - game state.
 * @param seat - the seat to measure.
 * @returns the effective stack divided by the pot.
 */
function sprOf(state, seat) {
  const pot = potTotal(state);
  if (pot <= 0) return Infinity;
  let effective = state.players[seat].stack;
  for (const other of state.players) {
    if (other.seat === seat || other.folded || other.out) continue;
    effective = Math.min(effective, other.stack);
  }
  return effective / pot;
}

/**
 * Read the board the way a bet size should be chosen: a DRY board needs a small
 * bet (nothing to deny, and small bets get called by worse), a WET one needs a
 * big bet (every extra card is someone's draw), and a PAIRED one wants something
 * in between (fewer draws, but the board already made hands).
 *
 * The coach tells the player exactly this, so the bots follow it too - advice the
 * opponents never take themselves is advice the player cannot trust.
 * @param board - the community cards.
 * @returns `{ wet, paired }`.
 */
export function boardTexture(board) {
  if (board.length < 3) return { wet: false, paired: false };
  const suits = [0, 0, 0, 0];
  const ranks = [];
  for (const code of board) {
    suits[suitOf(code)] += 1;
    ranks.push(rankOf(code));
  }
  const paired = new Set(ranks).size !== ranks.length;
  const flushy = Math.max(...suits) >= 3;
  const sorted = [...new Set(ranks)].sort((a, b) => a - b);
  let connected = false;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] <= 2) connected = true;
  }
  const broadway = ranks.filter((rank) => rank >= 8).length >= 2;
  return { wet: flushy || (connected && !paired) || (broadway && connected), paired };
}

/**
 * What the table will do with a bet: calling stations pay off, rocks and tight
 * players do not, so the same hand is worth a bigger bet against one and no bluff
 * at all against the other.
 * @param state - game state.
 * @param seat - the betting seat.
 * @returns `{ stations, tight }` counts among the live opponents.
 */
function tableRead(state, seat) {
  let stations = 0;
  let tight = 0;
  for (const other of state.players) {
    if (other.seat === seat || other.folded || other.out) continue;
    const style = BOT_STYLES[other.style];
    if (!style) continue;
    if (style.tightness <= 0.25 && style.aggression <= 0.2) stations += 1;
    else if (style.tightness >= 0.6) tight += 1;
  }
  return { stations, tight };
}

/**
 * Choose an action for one bot seat.
 * @param state - the mutable game state (its PRNG carries the randomness).
 * @param seat - the acting seat.
 * @returns `{ action, amount?, talk? }` ready for the engine.
 */
export function decideBotAction(state, seat) {
  const player = state.players[seat];
  const style = BOT_STYLES[player.style] ?? BOT_STYLES.pro;
  const legal = legalActions(state);
  if (!legal) return { action: 'check' };
  // Preflop is a range decision - position first, hand second - so it has its own
  // plan instead of the postflop street logic below.
  if (state.street === 'preflop') return decidePreflop(state, player, style, legal);
  const pot = potTotal(state);
  const toCall = legal.toCall;
  const bigBlind = state.config.bigBlind;
  const opponents = state.players.filter((other) => !other.folded && !other.out && other.seat !== seat).length;
  const strength = postflopStrength(player.cards, state.board);

  // Position: acting last among the remaining players is worth real equity.
  const seatCount = state.players.length;
  const order = state.players
    .filter((other) => !other.folded && !other.out)
    .map((other) => other.seat)
    .sort((a, b) => ((a - state.buttonSeat + seatCount) % seatCount) - ((b - state.buttonSeat + seatCount) % seatCount));
  const positionBonus = order[order.length - 1] === seat ? 0.05 : 0;
  const effective = Math.min(1, strength + positionBonus - (opponents > 1 ? 0.04 * (opponents - 1) : 0));

  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const stackPressure = toCall / Math.max(1, player.stack);
  const aggression = style.aggression;
  const tightness = style.tightness;
  // Money already committed on this street is no longer the player's, so a
  // blind or an earlier call discounts the price of continuing. Without this
  // the policy defended blinds far too rarely for its own personalities: a
  // calling station would fold a small blind for 50 into 150.
  const alreadyInvested = player.streetCommitted > 0;
  const committed = toCall / Math.max(1, pot + toCall);
  // Price may never buy a call on its own: a hand that does not beat the board
  // has no showdown value at all, so the loose rules below must not apply to it.
  const boardOnly = playsTheBoard(player.cards, state.board);

  const wantRaise = effective > 0.66 - aggression * 0.14;
  const texture = boardTexture(state.board);
  const read = tableRead(state, seat);
  // A real made hand with a small SPR is playing for stacks.
  const commit = strength >= 0.5 && sprOf(state, seat) <= 3;

  // Sizing: a pot-proportional bet, nudged by aggression, capped by the stack.
  const betSize = (candidate) => Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, roundToBlind(candidate, bigBlind)));

  if (toCall === 0) {
    if (commit && legal.canAllIn) {
      return { action: 'allin', talk: talkFrom(state, TALK.bet, player.style) };
    }
    // Bluffs are for tables that can fold: a station and a rock both kill the
    // idea (one calls with anything, the other only continues with a hand).
    const foldEquity = read.stations > 0 ? 0.35 : read.tight > 0 ? 0.7 : 1;
    const bluffing = roll(state) < style.bluff * (opponents === 1 ? 1 : 0.5) * foldEquity * (texture.wet ? 0.85 : 1.1);
    if (wantRaise || bluffing) {
      // Value bets have to deny equity on a wet board; bluffs want the cheapest
      // size that still folds the same hands. Against a station, value grows.
      const fraction = wantRaise
        ? (texture.wet ? 0.72 : texture.paired ? 0.5 : 0.55) + (read.stations > 0 ? 0.12 : 0)
        : (texture.wet ? 0.6 : 0.42);
      const target = betSize(pot * (fraction + aggression * 0.12));
      return {
        action: 'raise',
        amount: target,
        talk: talkFrom(state, bluffing && !wantRaise ? TALK.bluff : TALK.bet, player.style),
      };
    }
    return { action: 'check' };
  }

  // Facing a bet.
  //
  // A bet that puts a real stack in is not just "a price". The range that does it is
  // strong, so a hand that cannot beat that range must not buy a ticket on the odds
  // alone - comparing a made-hand score to pot odds is how half a table ended up
  // calling off four figures with ace-high.
  const shoveLike = toCall >= Math.max(bigBlind * 6, pot * 0.7);
  const largeBet = toCall >= pot * 0.55;
  // Against a shove the hand has to be a real one: two pair or better, or top pair
  // with a genuinely good price. This replaces a `commit` carve-out that let any
  // top-pair hand at a small SPR call off - which is most of them once the pot has
  // grown, so "the bots love calling all-ins" survived the first tightening.
  const strongEnoughForStacks = strength >= 0.62 || (strength >= 0.44 && potOdds <= 0.3 && effective >= 0.5);
  const raiseThreshold = 0.72 - aggression * 0.18;
  if (effective > raiseThreshold && legal.canRaise && roll(state) > style.trap
    && (!shoveLike || strongEnoughForStacks)) {
    if (commit && legal.canAllIn && (!shoveLike || strength >= 0.62)) {
      return { action: 'allin', talk: talkFrom(state, TALK.bet, player.style) };
    }
    // A raise has to charge the draws a wet board just created, and against a
    // station it is a pure value raise - so it goes bigger.
    const charge = (texture.wet ? 0.75 : 0.6) + (read.stations > 0 ? 0.12 : 0);
    const target = betSize(Math.max(state.currentBet * 2.5, state.currentBet + pot * charge));
    return { action: 'raise', amount: target, talk: talkFrom(state, TALK.bet, player.style) };
  }
  // A bluff raise needs someone who can fold.
  const bluffRaise = read.stations === 0 && roll(state) < style.bluff * 0.35 && opponents === 1 && effective < 0.3;
  if (bluffRaise && legal.canRaise && stackPressure < 0.35) {
    // Bluff raises are priced to fold a hand, not to build a pot.
    const target = betSize(Math.max(state.currentBet * 2.4, state.currentBet + pot * (texture.wet ? 0.55 : 0.42)));
    return { action: 'raise', amount: target, talk: talkFrom(state, TALK.bluff, player.style) };
  }
  // A cheap call is worth taking with almost anything that can still win
  // something. How often a personality takes it is a straight function of
  // tightness, which is what makes a rock and a maniac distinguishable when they
  // face the same 25%-pot bet.
  const continueChance = Math.min(0.85, 0.2 + (1 - tightness) * 0.9);
  // The PRICE decides how good the hand has to be. `effective` is a rough hand
  // value and `potOdds` the share of the final pot a call has to win, so the
  // comparison is "is this hand worth the price" - looseness buys a couple of
  // points of slop plus a little noise, it is not a licence to call a big bet
  // with a gutshot. (A fixed strength bar, which is what this used to be, said
  // yes to J-high facing two thirds of the pot.)
  const slop = 0.01
    + (1 - tightness) * 0.03
    + roll(state) * 0.02
    + (alreadyInvested ? 0.02 : 0)
    - positionBonus * 0.4;
  const worthThePrice = !boardOnly && effective - potOdds >= -slop;
  const cheapCall = !boardOnly
    && potOdds <= 0.22
    && stackPressure < 0.08
    && roll(state) < continueChance;
  // Playing the board, the best case is a chop, so only a small bluff-catch
  // remains - and only the loosest personalities bother.
  const bluffCatch = boardOnly && committed < 0.1 && roll(state) < continueChance * 0.25;
  if (worthThePrice || cheapCall || bluffCatch) {
    if (stackPressure > 0.5 && effective < 0.55 && roll(state) > 0.25) {
      return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
    }
    // Facing a stack-committing bet, the hand has to actually beat what shoves: a
    // hand that merely "out-earns the odds" is a losing call against a range that is
    // nothing but made hands and the top of the draws.
    if (shoveLike && (!strongEnoughForStacks || effective - potOdds < 0.05)) {
      return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
    }
    // A large bet needs a real edge over the price, not a break-even one: this is
    // where stacks die, and "worth the price" by a hair is a losing call.
    if (largeBet && !commit && effective - potOdds < 0.06) {
      return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
    }
    return { action: 'call', talk: talkFrom(state, TALK.call, player.style) };
  }
  return { action: 'fold', talk: talkFrom(state, TALK.fold, player.style) };
}

/**
 * Monte-Carlo equity for one seat against unknown opposing hands.
 * @param state - game state.
 * @param seat - the seat to price.
 * @param iterations - simulation count (default 1500).
 * @returns `{ win, tie, lose, equity, iterations }` as percentages.
 */
export function estimateEquity(state, seat, iterations = 1500) {
  const hero = state.players[seat];
  if (!hero || hero.cards.length < 2) throw new Error('\u6ca1\u6709\u5e95\u724c\u65e0\u6cd5\u8ba1\u7b97\u80dc\u7387');
  const opponents = state.players.filter((player) => !player.folded && !player.out && player.seat !== seat).length || 1;
  const known = new Set([...hero.cards, ...state.board]);
  const pool = [];
  for (const rank of RANK_CHARS) for (const suit of 'shdc') if (!known.has(rank + suit)) pool.push(rank + suit);
  let wins = 0;
  let ties = 0;
  let rng = state.rng >>> 0;
  const sample = () => {
    const step = nextRandom(rng);
    rng = step.state;
    return step.value;
  };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const deck = pool.slice();
    // Partial Fisher-Yates over only the cards this simulation needs.
    const need = (5 - state.board.length) + opponents * 2;
    for (let i = 0; i < need; i += 1) {
      const j = i + Math.floor(sample() * (deck.length - i));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    const board = [...state.board, ...deck.slice(0, 5 - state.board.length)];
    const heroScore = evaluate7([...hero.cards, ...board]).score;
    let bestOpponent = -1;
    for (let index = 0; index < opponents; index += 1) {
      const offset = 5 - state.board.length + index * 2;
      const opponentCards = deck.slice(offset, offset + 2);
      const score = evaluate7([...opponentCards, ...board]).score;
      bestOpponent = Math.max(bestOpponent, score);
    }
    if (heroScore > bestOpponent) wins += 1;
    else if (heroScore === bestOpponent) ties += 1;
  }
  const equity = (wins + ties / 2) / iterations;
  return {
    win: Math.round((wins / iterations) * 1000) / 10,
    tie: Math.round((ties / iterations) * 1000) / 10,
    lose: Math.round(((iterations - wins - ties) / iterations) * 1000) / 10,
    equity: Math.round(equity * 1000) / 10,
    iterations,
    opponents,
  };
}
