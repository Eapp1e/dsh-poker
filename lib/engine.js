/**
 * The Texas Hold'em table engine: a deterministic, dependency-free state machine
 * over plain JSON.
 *
 * Everything the game needs lives in one serializable state object -cards,
 * stacks, the PRNG state, the action log -so a hand can be logged, replayed,
 * and projected to a UI without any hidden process state. All functions return
 * a NEW state object; nothing here mutates its input.
 *
 * Betting rules implemented: no-limit hold'em, blinds (heads-up blinds swap
 * roles correctly), a minimum raise equal to the previous raise size, a
 * short all-in raise that does NOT reopen the betting, side pots with odd-chip
 * awards to the earliest seat left of the button, uncalled-bet refunds, and
 * run-out of the board when everyone is all-in.
 * @module dsh-plugin-poker/engine
 */
import { cardsLabel, draw, makeDeck, randomSeed, shuffle } from './cards.js';
import { describeHand, evaluate7 } from './evaluator.js';

/** Streets in order. */
export const STREETS = ['preflop', 'flop', 'turn', 'river'];

/** Chinese street labels for display. */
export const STREET_ZH = {
  preflop: '\u7ffb\u724c\u524d',
  flop: '\u7ffb\u724c',
  turn: '\u8f6c\u724c',
  river: '\u6cb3\u724c',
  showdown: '\u644a\u724c',
  idle: '\u672a\u5f00\u59cb',
};

/** Cards dealt on each street. */
const STREET_CARDS = { flop: 3, turn: 1, river: 1 };

/** Default table configuration. */
export const DEFAULT_CONFIG = {
  startingStack: 10000,
  smallBlind: 50,
  bigBlind: 100,
  botCount: 2,
  botBrain: 'auto',
};

/**
 * Largest table the engine will seat: the hero plus eight opponents is the
 * classic nine-handed full ring. Seat order, blinds, and pot math are all
 * derived from `players.length`, so this is a naming/capacity choice, not a
 * structural limit.
 */
export const MAX_BOTS = 8;

/** Deep clone of plain JSON state. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Human default name when the caller supplies none. */
const DEFAULT_HERO_NAME = '\u4f60';

/**
 * Create a table. The returned state has no hand in progress; call
 * {@link startHand} to deal one.
 * @param options - table configuration.
 * @returns a fresh game state.
 */
export function createGame(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const seed = (config.seed ?? randomSeed()) >>> 0;
  const heroName = config.heroName ?? DEFAULT_HERO_NAME;
  // Nine seats is the full ring; the engine is seat-count agnostic, so this cap
  // only bounds the roster the plugin names. Keep it in step with the plugin's
  // own MAX_BOTS - a stray slice here silently shrank nine-handed tables to six.
  const bots = (config.bots ?? []).slice(0, MAX_BOTS);
  const roster = [{ name: heroName, isHuman: true, style: 'hero' }, ...bots];
  return {
    version: 1,
    createdAt: config.createdAt ?? null,
    seed,
    rng: seed,
    config: {
      startingStack: config.startingStack,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      botBrain: config.botBrain,
    },
    handNumber: 0,
    street: 'idle',
    phase: 'idle',
    board: [],
    deck: [],
    burn: [],
    buttonSeat: -1,
    smallBlindSeat: null,
    bigBlindSeat: null,
    currentBet: 0,
    lastRaiseSize: config.bigBlind,
    actorSeat: null,
    lastAggressorSeat: null,
    players: roster.map((entry, seat) => ({
      seat,
      name: entry.name,
      isHuman: entry.isHuman === true,
      style: entry.style ?? 'pro',
      stack: config.startingStack,
      cards: [],
      folded: false,
      allIn: false,
      out: false,
      streetCommitted: 0,
      handCommitted: 0,
      hasActed: false,
      lastAction: null,
      talk: null,
      revealed: false,
      wonLastHand: 0,
    })),
    showdown: null,
    pendingDecision: null,
    botBrain: config.botBrain,
    log: [],
    handLog: [],
    actionLog: [],
    actionSeq: 0,
    stats: { handsPlayed: 0, showdowns: 0, biggestPot: 0, heroWins: 0, botWins: 0 },
    gameOver: false,
  };
}

/** Seats that can still be dealt into a hand. */
function liveSeats(state) {
  return state.players.filter((player) => player.stack > 0 && !player.out).map((player) => player.seat);
}

/** Append one line to the hand log and the durable log. */
function logLine(state, text) {
  state.log.push(text);
  state.handLog.push(text);
  if (state.log.length > 400) state.log = state.log.slice(-200);
}

/** The seat after `seat` that can still act, or null when nobody can. */
function nextToAct(state, seat) {
  const total = state.players.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (seat + step) % total;
    const player = state.players[index];
    if (!player || player.out || player.folded || player.allIn) continue;
    if (player.stack <= 0) continue;
    return index;
  }
  return null;
}

/** The seat after `seat` still in the hand (for pot eligibility and button moves). */
function nextLive(state, seat) {
  const total = state.players.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (seat + step) % total;
    const player = state.players[index];
    if (player && !player.out && player.stack > 0) return index;
  }
  return null;
}

/** Total chips committed this hand by every seat -the displayed pot. */
export function potTotal(state) {
  return state.players.reduce((sum, player) => sum + player.handCommitted, 0);
}

/** Pay chips from a stack into the pot for this street and this hand. */
function commit(state, player, amount) {
  const paid = Math.max(0, Math.min(amount, player.stack));
  player.stack -= paid;
  player.streetCommitted += paid;
  player.handCommitted += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

/** Return an over-bet nobody could call, before the pot is awarded. */
function refundUncalled(state) {
  const committed = state.players.filter((player) => !player.folded && player.streetCommitted > 0);
  if (committed.length < 2) return;
  const sorted = committed.slice().sort((a, b) => b.streetCommitted - a.streetCommitted);
  const top = sorted[0];
  const second = sorted[1];
  if (top.streetCommitted <= second.streetCommitted) return;
  // A folded player can still hold the second-highest commitment; that chip is
  // live in the pot, so only a strict over-bet above EVERY other seat is refunded.
  const others = state.players.filter((player) => player !== top).map((player) => player.streetCommitted);
  const highestOther = Math.max(0, ...others);
  if (top.streetCommitted <= highestOther) return;
  const refund = top.streetCommitted - highestOther;
  top.streetCommitted -= refund;
  top.handCommitted -= refund;
  top.stack += refund;
  if (top.stack > 0) top.allIn = false;
  logLine(state, `${top.name} \u56de\u6536\u65e0\u4eba\u8ddf\u6ce8\u7684 ${refund} \u7801`);
}

/**
 * Legal actions for the seat on turn.
 * @param state - game state.
 * @returns the action menu, or null when no seat is on turn.
 */
export function legalActions(state) {
  if (state.actorSeat === null) return null;
  const player = state.players[state.actorSeat];
  if (!player) return null;
  const toCall = Math.max(0, state.currentBet - player.streetCommitted);
  const maxTo = player.streetCommitted + player.stack;
  const minRaiseTo = Math.min(state.currentBet + state.lastRaiseSize, maxTo);
  // A raise needs somebody who can still call it. When every live opponent is already
  // all-in, the extra chips come straight back, so offering "全下 20,850" over a 20,600
  // shove is an option that does nothing except confuse the player looking at it.
  const canBeCalled = state.players.some((other) => other.seat !== player.seat
    && other.out !== true && other.folded !== true && other.allIn !== true && other.stack > 0);
  const canRaise = canBeCalled && player.stack > toCall;
  return {
    seat: player.seat,
    name: player.name,
    toCall,
    callAmount: Math.min(toCall, player.stack),
    canCheck: toCall === 0,
    canCall: toCall > 0,
    canBet: canBeCalled && state.currentBet === 0 && player.stack > 0,
    canRaise,
    canFold: true,
    canAllIn: canBeCalled && player.stack > 0,
    minRaiseTo,
    maxRaiseTo: maxTo,
    isRaiseCapped: minRaiseTo >= maxTo,
    potIfCall: potTotal(state) + Math.min(toCall, player.stack),
  };
}

/** Whether every seat that can still act has acted and matched the bet. */
function roundComplete(state) {
  const contenders = state.players.filter((player) => !player.folded && !player.out);
  if (contenders.length <= 1) return true;
  const actors = contenders.filter((player) => !player.allIn && player.stack > 0);
  if (actors.length === 0) return true;
  // One seat left with chips against all-in opponents only needs to have matched.
  return actors.every((player) => player.hasActed && player.streetCommitted >= state.currentBet);
}

/** Deal one street's board cards, burning first like a real dealer. */
function dealBoard(state, street) {
  const count = STREET_CARDS[street] ?? 0;
  let deck = state.deck;
  const burned = draw(deck);
  deck = burned.rest;
  state.burn = [...state.burn, burned.card];
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    const picked = draw(deck);
    deck = picked.rest;
    cards.push(picked.card);
  }
  state.deck = deck;
  state.board = [...state.board, ...cards];
}

/** Reset the per-street betting state. */
function resetStreet(state) {
  for (const player of state.players) {
    player.streetCommitted = 0;
    player.hasActed = false;
    player.lastAction = null;
  }
  state.currentBet = 0;
  state.lastRaiseSize = state.config.bigBlind;
  state.lastAggressorSeat = null;
}

/** Deal a new hand: rotate the button, post blinds, deal hole cards. */
export function startHand(state) {
  const next = clone(state);
  next.showdown = null;
  next.pendingDecision = null;
  next.actionLog = [];
  next.handLog = [];
  next.board = [];
  next.burn = [];
  next.street = 'preflop';
  next.phase = 'betting';
  next.gameOver = false;

  for (const player of next.players) {
    player.out = player.stack <= 0;
    player.folded = false;
    player.allIn = false;
    player.cards = [];
    player.streetCommitted = 0;
    player.handCommitted = 0;
    player.hasActed = false;
    player.lastAction = null;
    player.talk = null;
    player.revealed = false;
    player.wonLastHand = 0;
    // What this seat has actually been doing, hand after hand. It survives the
    // per-hand reset on purpose: it is the table's history, and the opponents read
    // it back to adjust their own rates (see `bots.js`).
    player.observed = player.observed ?? emptyObservation();
    if (!player.out) player.observed.hands += 1;
  }

  const seats = liveSeats(next);
  if (seats.length < 2) {
    next.phase = 'gameover';
    next.gameOver = true;
    next.street = 'idle';
    return next;
  }

  next.handNumber += 1;
  next.stats.handsPlayed += 1;
  next.buttonSeat = nextLive(next, next.buttonSeat < 0 ? next.players.length - 1 : next.buttonSeat);

  const dealt = shuffle(makeDeck(), next.rng);
  next.deck = dealt.deck;
  next.rng = dealt.rng;

  // Two cards each, one at a time, starting left of the button.
  let deck = next.deck;
  const order = [];
  let cursor = next.buttonSeat;
  for (let i = 0; i < seats.length; i += 1) {
    cursor = nextLive(next, cursor);
    order.push(cursor);
  }
  for (let round = 0; round < 2; round += 1) {
    for (const seat of order) {
      const picked = draw(deck);
      deck = picked.rest;
      next.players[seat].cards = [...next.players[seat].cards, picked.card];
    }
  }
  next.deck = deck;

  const headsUp = seats.length === 2;
  const smallBlindSeat = headsUp ? next.buttonSeat : nextLive(next, next.buttonSeat);
  const bigBlindSeat = nextLive(next, smallBlindSeat);
  next.smallBlindSeat = smallBlindSeat;
  next.bigBlindSeat = bigBlindSeat;

  logLine(next, `\u2014\u2014 \u7b2c ${next.handNumber} \u624b\u724c\u5f00\u59cb\u2014\u2014`);
  commit(next, next.players[smallBlindSeat], next.config.smallBlind);
  next.players[smallBlindSeat].lastAction = `\u5c0f\u76f2 ${next.config.smallBlind}`;
  logLine(next, `${next.players[smallBlindSeat].name} \u4e0b\u5c0f\u76f2 ${next.config.smallBlind}`);
  commit(next, next.players[bigBlindSeat], next.config.bigBlind);
  next.players[bigBlindSeat].lastAction = `\u5927\u76f2 ${next.config.bigBlind}`;
  logLine(next, `${next.players[bigBlindSeat].name} \u4e0b\u5927\u76f2 ${next.config.bigBlind}`);

  next.currentBet = next.config.bigBlind;
  next.lastRaiseSize = next.config.bigBlind;
  next.actorSeat = nextToAct(next, bigBlindSeat);
  next.lastAggressorSeat = bigBlindSeat;
  // Blinds are forced, not voluntary: a blind poster may still raise.
  for (const player of next.players) player.hasActed = false;
  // A blind poster who is all-in from the blind cannot act.
  if (next.actorSeat !== null && next.players[next.actorSeat].allIn) next.actorSeat = nextToAct(next, next.actorSeat);
  return next;
}

/** Award every pot to its winner(s); returns the payout rows. */
function distributePots(state) {
  const pots = computePots(state);
  const payouts = [];
  const board = state.board;
  for (const pot of pots) {
    const contenders = pot.eligible.filter((seat) => !state.players[seat].folded);
    if (contenders.length === 0) continue;
    let best = null;
    const scored = contenders.map((seat) => {
      const result = evaluate7([...state.players[seat].cards, ...board]);
      if (best === null || result.score > best) best = result.score;
      return { seat, result };
    });
    const winners = scored.filter((entry) => entry.result.score === best);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    const ordered = winners
      .map((entry) => entry.seat)
      .sort((a, b) => seatOrderFromButton(state, a) - seatOrderFromButton(state, b));
    const awards = [];
    for (const seat of ordered) {
      let amount = share;
      if (remainder > 0) {
        amount += 1;
        remainder -= 1;
      }
      state.players[seat].stack += amount;
      state.players[seat].wonLastHand += amount;
      awards.push({ seat, name: state.players[seat].name, amount, hand: describeHand([...state.players[seat].cards, ...board]) });
    }
    payouts.push({ amount: pot.amount, eligible: pot.eligible, awards });
  }
  return payouts;
}

/** Position order starting left of the button (odd chips go to the earliest). */
function seatOrderFromButton(state, seat) {
  const total = state.players.length;
  return (seat - state.buttonSeat + total) % total;
}

/**
 * Split commitments into main and side pots.
 * Every distinct commitment level forms one layer; consecutive layers with the
 * same eligible set merge, which is what makes "one pot per all-in" fall out.
 * @param state - game state.
 * @returns pots with their amounts and eligible seats.
 */
export function computePots(state) {
  const levels = [...new Set(state.players.map((player) => player.handCommitted).filter((amount) => amount > 0))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = state.players.filter((player) => player.handCommitted >= level);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter((player) => !player.folded).map((player) => player.seat);
    previous = level;
    if (amount <= 0 || eligible.length === 0) continue;
    const last = pots[pots.length - 1];
    const sameEligible = last && last.eligible.length === eligible.length && last.eligible.every((seat, index) => seat === eligible[index]);
    if (sameEligible) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  return pots;
}

/** Close the hand: showdown or award to the last player standing. */
function settleHand(state) {
  const contenders = state.players.filter((player) => !player.folded && !player.out);
  state.pendingDecision = null;
  if (contenders.length === 1) {
    const winner = contenders[0];
    const amount = potTotal(state);
    winner.stack += amount;
    winner.wonLastHand = amount;
    state.phase = 'handover';
    state.actorSeat = null;
    state.showdown = {
      kind: 'fold',
      pot: amount,
      payouts: [{ amount, eligible: [], awards: [{ seat: winner.seat, name: winner.name, amount, hand: null }] }],
      revealed: [],
    };
    logLine(state, `\u5176\u4ed6\u4eba\u90fd\u5f03\u724c\uff0c${winner.name} \u6536\u4e0b\u5e95\u6c60 ${amount}`);
    if (winner.isHuman) state.stats.heroWins += 1;
    else state.stats.botWins += 1;
    state.stats.biggestPot = Math.max(state.stats.biggestPot, amount);
    return state;
  }

  state.street = 'showdown';
  state.phase = 'showdown';
  state.actorSeat = null;
  for (const player of contenders) player.revealed = true;
  const payouts = distributePots(state);
  const total = payouts.reduce((sum, pot) => sum + pot.amount, 0);
  const winners = new Set();
  for (const pot of payouts) for (const award of pot.awards) winners.add(award.seat);
  for (const seat of winners) {
    if (state.players[seat].isHuman) state.stats.heroWins += 1;
    else state.stats.botWins += 1;
  }
  state.stats.showdowns += 1;
  state.stats.biggestPot = Math.max(state.stats.biggestPot, total);
  state.showdown = {
    kind: 'showdown',
    pot: total,
    payouts,
    revealed: contenders.map((player) => ({
      seat: player.seat,
      name: player.name,
      cards: player.cards.slice(),
      hand: describeHand([...player.cards, ...state.board]),
    })),
  };
  for (const pot of payouts) {
    for (const award of pot.awards) logLine(state, `${award.name} \u4ee5 ${award.hand} \u8d62\u4e0b ${award.amount}`);
  }
  state.phase = 'handover';
  return state;
}

/**
 * Advance out of a completed betting round: refund, then deal the next street
 * or run the board out to showdown when nobody can act any more.
 */
function closeStreet(state) {
  refundUncalled(state);
  if (state.street === 'river') {
    settleHand(state);
    return state;
  }
  const nextStreet = STREETS[STREETS.indexOf(state.street) + 1];
  resetStreet(state);
  state.street = nextStreet;
  dealBoard(state, nextStreet);
  const actors = state.players.filter((player) => !player.folded && !player.out && !player.allIn && player.stack > 0);
  logLine(state, `\u53d1\u724c\uff1a${STREET_ZH[nextStreet]} ${cardsLabel(state.board)}`);
  if (actors.length <= 1) {
    // Nobody can bet any more: run the remaining board out and show down.
    runOutBoard(state);
    return settleHand(state);
  }
  state.actorSeat = nextToAct(state, state.buttonSeat);
  return state;
}

/** Deal every remaining street without betting. */
function runOutBoard(state) {
  while (state.street !== 'river') {
    const nextStreet = STREETS[STREETS.indexOf(state.street) + 1];
    resetStreet(state);
    state.street = nextStreet;
    dealBoard(state, nextStreet);
    logLine(state, `\u53d1\u724c\uff1a${STREET_ZH[nextStreet]} ${cardsLabel(state.board)}`);
  }
}

/**
 * Append one action to the hand's action log, stamped for replay.
 *
 * `seq` is monotonic for the whole table (it survives a new hand), so a UI can
 * replay exactly the actions it has not shown yet - which is how bot moves get
 * their own beat instead of resolving in one jump. The entry also carries the
 * actor's resulting chips, so a replay needs no engine on the client.
 * @param state - game state (mutated).
 * @param entry - `{ seat, action, amount?, talk? }`.
 */
function recordAction(state, entry) {
  state.actionSeq = (state.actionSeq ?? 0) + 1;
  const player = state.players[entry.seat];
  state.actionLog.push({
    seq: state.actionSeq,
    seat: entry.seat,
    action: entry.action,
    amount: entry.amount ?? 0,
    talk: entry.talk ?? null,
    street: state.street,
    // The community cards as they stood for THIS action, so a replay can lay the
    // flop, turn and river out as the hand is replayed instead of at the end.
    board: state.board.slice(),
    pot: potTotal(state),
    currentBet: state.currentBet,
    stack: player ? player.stack : 0,
    streetCommitted: player ? player.streetCommitted : 0,
    folded: player ? player.folded === true : false,
    allIn: player ? player.allIn === true : false,
    label: player ? player.lastAction : null,
  });
}

/**
 * Apply one action and advance the hand.
 *
 * `amount` on a bet/raise is the TOTAL this street's commitment becomes
 * ("raise TO"), which is how players and models naturally speak about a raise.
 * @param state - game state.
 * @param action - `{ seat?, action, amount?, talk? }`.
 * @returns the next state.
 * @throws when the action is not legal for the seat on turn.
 */
export function applyAction(state, action, decide) {
  const next = clone(state);
  applyActionInPlace(next, action);
  advance(next, decide);
  return next;
}

/**
 * A fresh tendency tally for one seat.
 *
 * The opponents need to know what the table is DOING, not just what each seat is
 * declared to be: a rock that keeps calling is a station, and a maniac everyone
 * folds to should get bluffed more. These counters are what makes the policy
 * adjust, and they survive from hand to hand.
 * @returns a zeroed tally.
 */
export function emptyObservation() {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    bets: 0,
    calls: 0,
    folds: 0,
    facedBet: 0,
    foldedToBet: 0,
    // Postflop only, so a coach can estimate "does a flop bet get respect" instead of
    // averaging it with all the preflop folds to a raise.
    facedBetPost: 0,
    foldedToBetPost: 0,
    allIns: 0,
  };
}

/**
 * Fold one applied action into the actor's tally.
 * @param state - game state, before the action is applied.
 * @param player - the acting seat.
 * @param legal - the seat's legal menu at that moment (for "was there a bet to face").
 * @param kind - the action about to be applied.
 */
function observeAction(state, player, legal, kind) {
  if (!player.observed) player.observed = emptyObservation();
  const tally = player.observed;
  const facing = legal.toCall > 0;
  const postflop = state.street !== 'preflop';
  if (facing) {
    tally.facedBet += 1;
    // Kept separately: preflop folds to a raise are plentiful and say nothing about
    // whether a FLOP bet gets respect, and the coach's fold-equity estimate needs the
    // postflop number or every bluff looks free.
    if (postflop) tally.facedBetPost += 1;
  }
  if (kind === 'fold') {
    tally.folds += 1;
    if (facing) {
      tally.foldedToBet += 1;
      if (postflop) tally.foldedToBetPost += 1;
    }
    return;
  }
  if (kind === 'check') return;
  if (kind === 'call') {
    tally.calls += 1;
    if (state.street === 'preflop') tally.vpip += 1;
    return;
  }
  // A bet, a raise or a shove: all three are "put money in with intent".
  tally.bets += 1;
  if (state.street === 'preflop') {
    tally.vpip += 1;
    tally.pfr += 1;
  }
  if (kind === 'allin') tally.allIns += 1;
}

/** The mutation core, shared by the public API and the bot loop. */
export function applyActionInPlace(state, action) {
  if (state.phase !== 'betting' || state.actorSeat === null) throw new Error('\u73b0\u5728\u4e0d\u662f\u884c\u52a8\u9636\u6bb5');
  const seat = action.seat ?? state.actorSeat;
  if (seat !== state.actorSeat) throw new Error(`\u73b0\u5728\u8f6e\u5230 ${state.players[state.actorSeat].name} \u884c\u52a8`);
  const player = state.players[seat];
  const legal = legalActions(state);
  const kind = String(action.action ?? '').toLowerCase();
  const talk = typeof action.talk === 'string' && action.talk.trim() !== '' ? action.talk.trim() : null;
  if (talk) player.talk = talk;
  // Count the tendency BEFORE the action lands, while the seat's own commitment and
  // the price it was facing are still the ones it decided against.
  observeAction(state, player, legal, kind);

  if (kind === 'fold') {
    player.folded = true;
    player.hasActed = true;
    player.lastAction = '\u5f03\u724c';
    logLine(state, `${player.name} \u5f03\u724c${talk ? `\uff1a\u201c${talk}\u201d` : ''}`);
    recordAction(state, { seat, action: 'fold', talk });
    finishTurn(state, seat);
    return state;
  }

  if (kind === 'check') {
    if (!legal.canCheck) throw new Error(`\u9762\u5bf9 ${legal.toCall} \u7684\u4e0b\u6ce8\u4e0d\u80fd\u8fc7\u724c\uff0c\u8bf7\u9009\u62e9 \u8ddf\u6ce8/\u52a0\u6ce8/\u5f03\u724c`);
    player.hasActed = true;
    player.lastAction = '\u8fc7\u724c';
    logLine(state, `${player.name} \u8fc7\u724c${talk ? `\uff1a\u201c${talk}\u201d` : ''}`);
    recordAction(state, { seat, action: 'check', talk });
    finishTurn(state, seat);
    return state;
  }

  if (kind === 'call') {
    if (legal.toCall === 0) throw new Error('\u65e0\u9700\u8ddf\u6ce8\uff0c\u53ef\u4ee5\u8fc7\u724c\u6216\u52a0\u6ce8');
    const paid = commit(state, player, legal.toCall);
    player.hasActed = true;
    player.lastAction = player.allIn ? `\u5168\u4e0b ${paid}` : `\u8ddf\u6ce8 ${paid}`;
    logLine(state, `${player.name} ${player.allIn ? '\u5168\u4e0b' : '\u8ddf\u6ce8'} ${paid}${talk ? `\uff1a\u201c${talk}\u201d` : ''}`);
    recordAction(state, { seat, action: 'call', amount: paid, talk });
    finishTurn(state, seat);
    return state;
  }

  // An all-in that cannot raise is a CALL for less - the ordinary short-stack shove,
  // and the action every player expects from a 全下 button. `canAllIn` is true for any
  // seat with chips, so without this the button offered an action the engine refused.
  if (kind === 'allin' && legal.toCall > 0 && player.stack <= legal.toCall) {
    const paid = commit(state, player, legal.toCall);
    player.hasActed = true;
    player.lastAction = `\u5168\u4e0b ${paid}`;
    logLine(state, `${player.name} \u5168\u4e0b ${paid}${talk ? `\uff1a\u201c${talk}\u201d` : ''}`);
    recordAction(state, { seat, action: 'call', amount: paid, talk });
    finishTurn(state, seat);
    return state;
  }

  if (kind === 'bet' || kind === 'raise' || kind === 'allin') {
    let target;
    if (kind === 'allin') target = legal.maxRaiseTo;
    else {
      if (typeof action.amount !== 'number' || !Number.isFinite(action.amount)) throw new Error('\u52a0\u6ce8\u5fc5\u987b\u7ed9\u51fa\u76ee\u6807\u603b\u989d amount');
      target = Math.floor(action.amount);
    }
    if (target > legal.maxRaiseTo) target = legal.maxRaiseTo;
    if (target < legal.maxRaiseTo && target < legal.minRaiseTo) throw new Error(`\u52a0\u6ce8\u81f3\u5c11\u8981\u5230 ${legal.minRaiseTo}\uff08\u6216\u5168\u4e0b ${legal.maxRaiseTo}\uff09`);
    if (legal.canCheck && target <= state.currentBet) throw new Error('\u5f53\u524d\u65e0\u4eba\u4e0b\u6ce8\uff0c\u8bf7\u4f7f\u7528 amount \u6307\u5b9a\u4e0b\u6ce8\u603b\u989d');
    if (!legal.canCheck && target <= state.currentBet) throw new Error(`\u52a0\u6ce8\u5fc5\u987b\u9ad8\u4e8e\u5f53\u524d\u4e0b\u6ce8 ${state.currentBet}\uff08\u6216\u9009\u62e9\u8ddf\u6ce8\uff09`);
    if (player.stack <= legal.toCall) throw new Error('\u7b79\u7801\u4e0d\u591f\u52a0\u6ce8\uff0c\u53ea\u80fd\u8ddf\u6ce8\u6216\u5f03\u724c');

    const openingBet = state.currentBet === 0;
    const raiseSize = target - state.currentBet;
    const isFullRaise = raiseSize >= state.lastRaiseSize;
    commit(state, player, target - player.streetCommitted);
    const wasAllIn = player.allIn;
    if (isFullRaise) {
      state.lastRaiseSize = raiseSize;
      state.currentBet = target;
      state.lastAggressorSeat = seat;
      // A full raise reopens the betting for everyone who already acted.
      for (const other of state.players) {
        if (other.seat === seat || other.folded || other.allIn || other.out) continue;
        other.hasActed = false;
      }
    } else if (target > state.currentBet) {
      // Short all-in raise: it raises the price but does not reopen betting.
      state.currentBet = target;
      state.lastAggressorSeat = seat;
    }
    player.hasActed = true;
    const verb = openingBet ? '\u4e0b\u6ce8' : '\u52a0\u6ce8';
    player.lastAction = wasAllIn ? `\u5168\u4e0b ${target}` : `${verb}\u5230 ${target}`;
    logLine(state, `${player.name} ${wasAllIn ? '\u5168\u4e0b' : verb}\u5230 ${target}${talk ? `\uff1a\u201c${talk}\u201d` : ''}`);
    recordAction(state, { seat, action: kind, amount: target, talk });
    finishTurn(state, seat);
    return state;
  }

  throw new Error(`\u65e0\u6cd5\u8bc6\u522b\u7684\u52a8\u4f5c\uff1a${action.action}\uff08\u53ef\u9009 fold/check/call/bet/raise/allin\uff09`);
}

/** Common turn tail: hand-over check, round-close check, next actor. */
function finishTurn(state, seat) {
  const contenders = state.players.filter((player) => !player.folded && !player.out);
  if (contenders.length === 1) {
    settleHand(state);
    return;
  }
  if (roundComplete(state)) {
    closeStreet(state);
    return;
  }
  state.actorSeat = nextToAct(state, seat);
  if (state.actorSeat === null) closeStreet(state);
}

/**
 * The safest action a stalled policy can take: check when it is free, else fold.
 * @param state - game state.
 * @param seat - the acting bot seat.
 * @param error - why the policy's own action was refused.
 * @returns a legal action for the seat.
 */
function fallbackAction(state, seat, error) {
  const legal = legalActions(state);
  state.stats.botFallbacks = (state.stats.botFallbacks ?? 0) + 1;
  const reason = error && error.message ? error.message : String(error);
  logLine(state, `${state.players[seat].name} \u51b3\u7b56\u5f02\u5e38\uff08${reason}\uff09\uff0c\u6539\u4e3a\u4fdd\u5b88\u884c\u52a8`);
  return { action: legal && legal.canCheck ? 'check' : 'fold' };
}

/**
 * Take one bot turn. BOTH failure modes fall back to {@link fallbackAction}: a
 * policy that throws, and an action the engine refuses. A heuristic brain must
 * never be able to stall a live table, and `stats.botFallbacks` keeps such a
 * bug visible in the statistics instead of silent.
 * @param state - game state (mutated).
 * @param seat - the acting bot seat.
 * @param decide - the opponent policy.
 */
function takeBotTurn(state, seat, decide) {
  let decision;
  try {
    decision = decide(state, seat);
    if (!decision || typeof decision.action !== 'string') throw new Error('policy returned no action');
  } catch (error) {
    decision = fallbackAction(state, seat, error);
  }
  try {
    applyActionInPlace(state, { seat, ...decision });
  } catch (error) {
    applyActionInPlace(state, { seat, ...fallbackAction(state, seat, error) });
  }
}

/**
 * Run the table forward: bot seats act until it is the human's turn, a
 * model-brain decision is needed, or the hand settles. Human seats always stop
 * the loop.
 * @param state - game state (mutated).
 * @param decide - the opponent policy, `(state, seat) => { action, amount?, talk? }`.
 * @returns the state.
 */
export function advance(state, decide) {
  const policy = decide ?? (() => ({ action: 'check' }));
  let guard = 0;
  while (state.phase === 'betting' && state.actorSeat !== null && guard < 2000) {
    guard += 1;
    const actor = state.players[state.actorSeat];
    if (actor.isHuman) break;
    // An AI seat is answered by an HTTP call, which cannot happen inside this
    // synchronous loop: pause exactly like the model brain does, and let the host
    // resume the table once the answer is in (`submitBotDecision`).
    if (Array.isArray(state.aiSeats) && state.aiSeats.includes(actor.seat)) {
      state.pendingDecision = {
        kind: 'ai',
        seat: actor.seat,
        name: actor.name,
        style: actor.style,
        cards: actor.cards.slice(),
        legal: legalActions(state),
        pot: potTotal(state),
        board: state.board.slice(),
        street: state.street,
        actionLog: state.actionLog.slice(-12),
      };
      break;
    }
    if (state.botBrain === 'model') {
      state.pendingDecision = {
        seat: actor.seat,
        name: actor.name,
        style: actor.style,
        cards: actor.cards.slice(),
        legal: legalActions(state),
        pot: potTotal(state),
        board: state.board.slice(),
        street: state.street,
        actionLog: state.actionLog.slice(-12),
      };
      break;
    }
    takeBotTurn(state, actor.seat, policy);
  }
  if (guard >= 2000) throw new Error('\u724c\u5c40\u63a8\u8fdb\u5931\u8d25\uff1a\u884c\u52a8\u5faa\u73af\u8d85\u51fa\u4e0a\u9650');
  return state;
}

/**
 * Submit a model-chosen action for the pending bot decision.
 * @param state - game state.
 * @param action - `{ seat?, action, amount?, talk? }`.
 * @param decide - the fallback opponent policy used to continue afterwards.
 */
export function submitBotDecision(state, action, decide) {
  const next = clone(state);
  if (!next.pendingDecision) throw new Error('\u5f53\u524d\u6ca1\u6709\u7b49\u5f85\u51b3\u7b56\u7684\u673a\u5668\u4eba');
  const seat = action.seat ?? next.pendingDecision.seat;
  if (seat !== next.pendingDecision.seat) throw new Error(`\u5f53\u524d\u7b49\u5f85 ${next.pendingDecision.name} \u51b3\u7b56`);
  const legal = legalActions(next);
  const kind = String(action.action ?? '').toLowerCase();
  if (kind !== 'fold' && kind !== 'check' && kind !== 'call' && kind !== 'bet' && kind !== 'raise' && kind !== 'allin') {
    throw new Error(`\u65e0\u6548\u52a8\u4f5c ${action.action}`);
  }
  if (kind === 'check' && !legal.canCheck) throw new Error('\u4e0d\u80fd\u8fc7\u724c\uff0c\u5fc5\u987b\u8ddf\u6ce8\u3001\u52a0\u6ce8\u6216\u5f03\u724c');
  if (kind === 'fold' && legal.toCall === 0) throw new Error('\u65e0\u4eba\u4e0b\u6ce8\u65f6\u4e0d\u5e94\u5f03\u724c\uff0c\u8bf7\u9009\u62e9\u8fc7\u724c\u6216\u4e0b\u6ce8');
  next.pendingDecision = null;
  applyActionInPlace(next, { seat, ...action, action: kind });
  return advance(next, decide);
}

/**
 * Seat-by-seat view of the table for one viewer. Other players' hole cards are
 * hidden unless they are revealed at showdown, are the viewer's own, or the
 * caller explicitly asks for every card (the model-brain path).
 * @param state - game state.
 * @param viewerSeat - whose eyes to render from.
 * @param options - `revealAll` to include every card.
 */
export function viewFor(state, viewerSeat, options = {}) {
  const revealAll = options.revealAll === true;
  const legal = state.actorSeat !== null ? legalActions(state) : null;
  return {
    handNumber: state.handNumber,
    street: state.street,
    streetLabel: STREET_ZH[state.street] ?? state.street,
    phase: state.phase,
    board: state.board.slice(),
    pot: potTotal(state),
    currentBet: state.currentBet,
    smallBlind: state.config.smallBlind,
    bigBlind: state.config.bigBlind,
    // The stack everybody started with, so a rematch can be the same game rather
    // than a default one.
    startingStack: state.config.startingStack,
    buttonSeat: state.buttonSeat,
    smallBlindSeat: state.smallBlindSeat ?? null,
    bigBlindSeat: state.bigBlindSeat ?? null,
    actorSeat: state.actorSeat,
    viewerSeat,
    botBrain: state.botBrain,
    gameOver: state.gameOver,
    players: state.players.map((player) => {
      const visible = revealAll || player.isHuman || player.revealed || (options.revealSeats ?? []).includes(player.seat);
      // The made hand is what a player actually needs to see, so it travels with
      // the cards whenever they are face up and the board has a shape.
      const hand = visible && player.cards.length === 2 && state.board.length >= 3
        ? describeHand([...player.cards, ...state.board])
        : null;
      return {
        seat: player.seat,
        name: player.name,
        isHuman: player.isHuman,
        style: player.style,
        stack: player.stack,
        streetCommitted: player.streetCommitted,
        handCommitted: player.handCommitted,
        folded: player.folded,
        allIn: player.allIn,
        out: player.out,
        lastAction: player.lastAction,
        talk: player.talk,
        cards: visible ? player.cards.slice() : null,
        cardCount: player.cards.length,
        hand,
        isButton: player.seat === state.buttonSeat,
        isActor: player.seat === state.actorSeat,
        wonLastHand: player.wonLastHand,
      };
    }),
    pots: computePots(state),
    legal: legal && legal.seat === viewerSeat ? legal : null,
    pending: state.pendingDecision
      ? {
          seat: state.pendingDecision.seat,
          name: state.pendingDecision.name,
          style: state.pendingDecision.style,
          legal: state.pendingDecision.legal,
        }
      : null,
    showdown: state.showdown,
    log: state.handLog.slice(-14),
    stats: state.stats,
    canDealNext: state.phase === 'handover' || state.phase === 'idle',
  };
}
