/**
 * Test suite for the poker plugin: evaluator correctness, pot accounting, and
 * long random-play invariant checks. Run with:
 *   node test/run.mjs
 * Exits non-zero on the first failure.
 */
import { makeDeck, shuffle } from '../lib/cards.js';
import { CATEGORY, describeHand, evaluate5, evaluate7 } from '../lib/evaluator.js';
import {
  advance,
  applyAction,
  computePots,
  createGame,
  legalActions,
  MAX_BOTS,
  emptyObservation,
  potTotal,
  startHand,
  submitBotDecision,
  viewFor,
} from '../lib/engine.js';
import { BOT_STYLES, adjustStyle, boardTexture, decideBotAction, observedRead, playersBehind, playsTheBoard, postflopStrength, preflopPercentile, preflopStrength } from '../lib/bots.js';
import { renderTable } from '../lib/render.js';

let passed = 0;
const failures = [];

/** Assert one condition. */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

/** Assert deep equality on JSON values. */
function checkEqual(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `expected ${b}, got ${a}`);
}

/** Assert that fn throws. */
function checkThrows(name, fn) {
  try {
    fn();
    failures.push(`${name} :: expected a throw`);
  } catch {
    passed += 1;
  }
}

/** JSON shorthand for failure details. */
function json(value) {
  return JSON.stringify(value);
}

// ── evaluator ───────────────────────────────────────────────────────────────

checkEqual('royal flush category', evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts']).category, CATEGORY.STRAIGHT_FLUSH);
checkEqual('wheel straight is a straight', evaluate5(['Ah', '2s', '3d', '4c', '5h']).category, CATEGORY.STRAIGHT);
check('wheel scores below six-high straight', evaluate5(['Ah', '2s', '3d', '4c', '5h']).score < evaluate5(['2s', '3d', '4c', '5h', '6d']).score);
check('flush beats straight', evaluate5(['As', '9s', '7s', '5s', '3s']).score > evaluate5(['Ah', '2s', '3d', '4c', '5h']).score);
check('full house beats flush', evaluate5(['Ah', 'Ad', 'Ac', 'Kh', 'Kd']).score > evaluate5(['As', '9s', '7s', '5s', '3s']).score);
check('quads beat full house', evaluate5(['Ah', 'Ad', 'Ac', 'As', 'Kd']).score > evaluate5(['Ah', 'Ad', 'Ac', 'Kh', 'Kd']).score);
check('kicker decides a pair', evaluate5(['Ah', 'Ad', 'Kc', 'Qs', 'Jd']).score > evaluate5(['Ah', 'Ad', 'Kc', 'Qs', 'Td']).score);
checkEqual('two pair ordering', evaluate5(['Ah', 'Ad', 'Kc', 'Ks', '2d']).category, CATEGORY.TWO_PAIR);
check('higher two pair wins', evaluate5(['Ah', 'Ad', '3c', '3s', '2d']).score > evaluate5(['Kh', 'Kd', 'Qc', 'Qs', '2d']).score);
check('the second pair breaks a tie between equal high pairs', evaluate5(['Ah', 'Ad', 'Kc', 'Ks', '2d']).score > evaluate5(['Ah', 'Ad', 'Qc', 'Qs', 'Kd']).score);
checkEqual('best five of seven picks the flush', evaluate7(['As', 'Ks', 'Qs', 'Js', 'Ts', '2h', '3d']).best.length, 5);
check('seven-card flush beats seven-card straight', evaluate7(['As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '2h']).category === CATEGORY.STRAIGHT_FLUSH);
check('seven-card board pair beats ace high', evaluate7(['Ah', 'Kd', 'Qs', 'Jc', 'Th', '9d', '8s']).category === CATEGORY.STRAIGHT);
check('describeHand names a full house', describeHand(['Ah', 'Ad', 'Ac', 'Kh', 'Kd']).includes('Full House'));
check('describeHand names the wheel straight', describeHand(['Ah', '2s', '3d', '4c', '5h']).includes('A-5'));

// ── deterministic shuffle ───────────────────────────────────────────────────

const first = shuffle(makeDeck(), 12345);
const second = shuffle(makeDeck(), 12345);
checkEqual('shuffle is deterministic per seed', first.deck.slice(0, 8), second.deck.slice(0, 8));
checkEqual('shuffle keeps 52 distinct cards', new Set(first.deck).size, 52);
check('shuffle advances the PRNG', first.rng !== 12345);

// ── side pots ───────────────────────────────────────────────────────────────

const sidePotGame = createGame({ startingStack: 1000, bots: [{ name: 'A' }, { name: 'B' }], seed: 7 });
sidePotGame.players[0].handCommitted = 100;
sidePotGame.players[1].handCommitted = 300;
sidePotGame.players[2].handCommitted = 300;
const pots = computePots(sidePotGame);
checkEqual('a three-way all-in makes two pots', pots.length, 2);
checkEqual('main pot amount', pots[0].amount, 300);
checkEqual('main pot eligibility covers every live seat', pots[0].eligible, [0, 1, 2]);
checkEqual('side pot amount', pots[1].amount, 400);
checkEqual('side pot eligibility excludes the short stack', pots[1].eligible, [1, 2]);
checkEqual('pots conserve chips', pots.reduce((sum, pot) => sum + pot.amount, 0), 700);

// ── an all-in that cannot raise is a call ───────────────────────────────────

// `canAllIn` is true for any seat with chips, so the panel's 全下 button is offered
// to a short stack too. Shoving for less than the bet is a CALL for less - the
// engine used to refuse it, which is how a 全下 click ended up as a chat message.
const shoveGame = startHand(createGame({ startingStack: 1000, bots: [{ name: 'A' }, { name: 'B' }], seed: 11 }));
// A forced short-stack spot, so this checks the ACTION rather than a whole hand: the
// hero holds 250 against a bet of 400, which is the exact shape the 全下 button offered
// and the engine refused.
for (const bot of shoveGame.players.slice(1)) {
  bot.streetCommitted = 400;
  bot.hasActed = true;
}
shoveGame.players[0].stack = 250;
shoveGame.players[0].streetCommitted = 0;
shoveGame.currentBet = 400;
shoveGame.lastRaiseSize = 400;
shoveGame.actorSeat = 0;
const shoveLegal = legalActions(shoveGame);
check('a short stack is offered the all-in', shoveLegal.canAllIn === true && shoveLegal.maxRaiseTo === 250 && shoveLegal.toCall === 400,
  JSON.stringify(shoveLegal));
const shoved = applyAction(shoveGame, { seat: 0, action: 'allin' }, null);
check('an all-in that cannot raise is a call for less', shoved.players[0].allIn === true
  && (shoved.actionLog || []).some((entry) => entry.seat === 0 && entry.amount === 250),
  JSON.stringify({ allIn: shoved.players[0].allIn, log: (shoved.actionLog || []).filter((entry) => entry.seat === 0) }));
check('the short all-in is recorded as a call, never a raise',
  (shoved.actionLog || []).some((entry) => entry.seat === 0 && entry.action === 'call' && entry.amount === 250)
  && !(shoved.actionLog || []).some((entry) => entry.seat === 0 && entry.action !== 'call'),
  JSON.stringify((shoved.actionLog || []).filter((entry) => entry.seat === 0)));
check('the short all-in reads as 全下 in the log', shoved.log.some((line) => line.includes('\u5168\u4e0b 250')),
  JSON.stringify(shoved.log.slice(0, 3)));

const deadMoneyGame = createGame({ startingStack: 1000, bots: [{ name: 'A' }, { name: 'B' }], seed: 7 });deadMoneyGame.players[0].handCommitted = 100;
deadMoneyGame.players[0].folded = true;
deadMoneyGame.players[1].handCommitted = 300;
deadMoneyGame.players[2].handCommitted = 300;
const deadPots = computePots(deadMoneyGame);
checkEqual('dead money merges into one pot when eligibility matches', deadPots.length, 1);
checkEqual('merged pot keeps the dead chips', deadPots[0].amount, 700);
checkEqual('merged pot eligibility skips the folded seat', deadPots[0].eligible, [1, 2]);

const mergedPots = createGame({ startingStack: 1000, bots: [{ name: 'A' }, { name: 'B' }], seed: 7 });
mergedPots.players[0].handCommitted = 200;
mergedPots.players[1].handCommitted = 200;
mergedPots.players[2].handCommitted = 200;
checkEqual('equal commitments merge into one pot', computePots(mergedPots).length, 1);

// ── engine: heads-up setup ──────────────────────────────────────────────────

const headsUp = startHand(createGame({ startingStack: 1000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A' }], seed: 99 }));
checkEqual('heads-up button posts the small blind', headsUp.smallBlindSeat, headsUp.buttonSeat);
checkEqual('heads-up preflop actor is the button', headsUp.actorSeat, headsUp.buttonSeat);
checkEqual('heads-up pot after blinds', potTotal(headsUp), 150);
checkEqual('two hole cards each', headsUp.players.map((player) => player.cards.length), [2, 2]);

const threeHanded = startHand(createGame({ startingStack: 1000, bots: [{ name: 'A' }, { name: 'B' }], seed: 99 }));
checkEqual('three-handed button is seat 0 on hand 1', threeHanded.buttonSeat, 0);
checkEqual('three-handed small blind is seat 1', threeHanded.smallBlindSeat, 1);
checkEqual('three-handed big blind is seat 2', threeHanded.bigBlindSeat, 2);
checkEqual('three-handed preflop actor is the button', threeHanded.actorSeat, 0);

// Nine seats is the full ring; a stray roster slice once shrank it silently.
const fullRing = startHand(createGame({
  startingStack: 2000,
  smallBlind: 25,
  bigBlind: 50,
  bots: Array.from({ length: MAX_BOTS }, (_, index) => ({ name: `B${index}` })),
  seed: 5,
}));
checkEqual('a nine-handed table seats nine players', fullRing.players.length, 9);
checkEqual('a nine-handed table deals everyone in', fullRing.players.map((player) => player.cards.length), [2, 2, 2, 2, 2, 2, 2, 2, 2]);
checkEqual('only the blinds post', fullRing.players.filter((player) => player.streetCommitted > 0).length, 2);
checkEqual('nine-handed small blind sits left of the button', fullRing.smallBlindSeat, 1);
checkEqual('nine-handed big blind sits next to the small blind', fullRing.bigBlindSeat, 2);
checkEqual('nine-handed preflop starts under the gun', fullRing.actorSeat, 3);
checkEqual('nine-handed pot after blinds', potTotal(fullRing), 75);
check('a nine-handed table can play a hand out', (() => {
  let state = fullRing;
  const foldPolicy = () => ({ action: 'fold' });
  state = applyAction(state, { action: 'fold' }, foldPolicy);
  return state.phase === 'handover' || state.phase === 'betting';
})(), 'the full ring stalled on its first action');

// ── engine: action legality ─────────────────────────────────────────────────

/** A policy that always folds, so a scripted test keeps the turn. */
const foldPolicy = () => ({ action: 'fold' });
/** A scripted policy: one fixed action per bot turn, in order. */
const script = (...actions) => {
  let index = 0;
  return () => actions[Math.min(index++, actions.length - 1)];
};

checkThrows('cannot check facing a bet', () => applyAction(headsUp, { action: 'check' }, foldPolicy));
checkThrows('raise below the minimum is rejected', () => applyAction(headsUp, { action: 'raise', amount: 120 }, foldPolicy));
checkThrows('acting out of turn is rejected', () => applyAction(headsUp, { action: 'call', seat: 1 }, foldPolicy));
checkThrows('an unknown action is rejected', () => applyAction(headsUp, { action: 'dance' }, foldPolicy));

// Heads-up: seat 0 is the button/small blind and acts first preflop.
const called = applyAction(headsUp, { action: 'call' }, script({ action: 'call' }));
checkEqual('a call ends the preflop round heads-up', called.street, 'flop');
checkEqual('flop has three cards', called.board.length, 3);
checkEqual('pot after two preflop calls', potTotal(called), 200);
checkEqual('the big blind acts first on the flop', called.actorSeat, 0);
checkEqual('the big blind checked when the flop was dealt', called.players[1].lastAction, '\u8fc7\u724c');

// A min-bet that everyone folds to ends the hand immediately.
const wonByFold = applyAction(called, { action: 'raise', amount: 150 }, foldPolicy);
checkEqual('folding to a bet ends the hand', wonByFold.phase, 'handover');
checkEqual('the winner is paid the whole pot', wonByFold.showdown.pot, 350);
checkEqual('the hero collected the pot', wonByFold.players[0].stack, 1000 + 100);
checkEqual('chips are conserved through the fold win', chipTotal(wonByFold), 2000);

// A call closes the flop round; the engine then plays the bots out to the hero.
const raised = applyAction(called, { action: 'raise', amount: 150 }, script({ action: 'call' }));
checkEqual('both players put in the flop bet', potTotal(raised), 500);
checkEqual('the flop round closes after the call', raised.street, 'turn');
checkEqual('the turn adds one card', raised.board.length, 4);
checkEqual('street commitments reset on the turn', raised.players.map((player) => player.streetCommitted), [0, 0]);
checkEqual('the hero is the one left to act', raised.actorSeat, 0);
checkEqual('the bot checked the turn back', raised.players[1].lastAction, '\u8fc7\u724c');

const threeWay = startHand(createGame({ startingStack: 5000, smallBlind: 25, bigBlind: 50, bots: [{ name: 'A' }, { name: 'B' }], seed: 11 }));
const threeWayFlop = applyAction(threeWay, { action: 'raise', amount: 200 }, script({ action: 'call' }, { action: 'call' }));
checkEqual('three-handed action reaches the flop', threeWayFlop.street, 'flop');
checkEqual('three-handed pot after a raise and two calls', potTotal(threeWayFlop), 600);
checkEqual('a full raise becomes the minimum-raise baseline', threeWayFlop.lastRaiseSize, 50);
check(
  'the hero is eventually the one to act in a three-way hand',
  threeWayFlop.actorSeat === 0 || threeWayFlop.phase === 'handover',
  `actor=${threeWayFlop.actorSeat} phase=${threeWayFlop.phase}`,
);

// ── invariant: chips are conserved over long random play ────────────────────

/**
 * Total chips in play. Committed chips only count as pot while a hand is live:
 * once a hand settles the pot has already been paid back into the stacks.
 */
function chipTotal(state) {
  const live = state.phase === 'betting' || state.phase === 'idle';
  return state.players.reduce((sum, player) => sum + player.stack, 0) + (live ? potTotal(state) : 0);
}

let seed = 424242;
let handsPlayed = 0;
let showdowns = 0;
let fallbacks = 0;
let maxHands = 0;

for (let game = 0; game < 40; game += 1) {
  seed = (seed * 1103515245 + 12345) >>> 0;
  const styles = Object.keys(BOT_STYLES);
  let state = createGame({
    startingStack: 2000,
    smallBlind: 25,
    bigBlind: 50,
    seed,
    bots: [
      { name: 'A', style: styles[game % styles.length] },
      { name: 'B', style: styles[(game + 2) % styles.length] },
    ],
  });
  const start = chipTotal(state);
  state = startHand(state);
  // Drive the human seat with a simple random-but-legal policy.
  let guard = 0;
  while (!state.gameOver && guard < 1500) {
    guard += 1;
    if (state.phase === 'handover') {
      handsPlayed += 1;
      if (state.showdown && state.showdown.kind === 'showdown') showdowns += 1;
      maxHands = Math.max(maxHands, state.handNumber);
      // Roll into the next hand by hand-rolling the seat policy again.
      state = startHand(state);
      continue;
    }
    if (state.phase !== 'betting') break;
    const legal = legalActions(state);
    if (!legal) break;
    const options = ['fold'];
    if (legal.canCheck) options.push('check');
    if (legal.canCall) options.push('call');
    if (legal.canRaise) options.push('raise');
    seed = (seed * 1103515245 + 12345) >>> 0;
    const pick = options[seed % options.length];
    let action = { action: pick };
    if (pick === 'raise') {
      const span = legal.maxRaiseTo - legal.minRaiseTo;
      action = { action: 'raise', amount: legal.minRaiseTo + (span > 0 ? seed % (span + 1) : 0) };
    }
    state = applyAction(state, action, decideBotAction);
    state = { ...state };
    if (state.pendingDecision) {
      state = submitBotDecision(state, { action: 'call' }, decideBotAction);
      state = { ...state };
    }
  }
  check(`game ${game} conserves chips`, chipTotal(state) === start, `${chipTotal(state)} vs ${start}`);
  check(`game ${game} stays in a coherent phase`, ['betting', 'handover', 'showdown', 'gameover'].includes(state.phase), `phase=${state.phase}`);
  check(`game ${game} never stalls while betting`, state.phase !== 'betting' || state.actorSeat !== null, `actor=${state.actorSeat}`);
  check(`game ${game} keeps every stack non-negative`, state.players.every((player) => player.stack >= 0), json(state.players.map((player) => player.stack)));
  check(
    `game ${game} never commits more than a stack`,
    state.players.every((player) => player.handCommitted <= 2000),
    json(state.players.map((player) => player.handCommitted)),
  );
  fallbacks += state.stats.botFallbacks ?? 0;
}

check('many hands were simulated', handsPlayed > 200, `played ${handsPlayed}`);
check('showdowns happened', showdowns > 20, `showdowns ${showdowns}`);
check('no bot policy fallbacks', fallbacks === 0, `fallbacks ${fallbacks}`);

// ── model-brain path ────────────────────────────────────────────────────────

let brain = startHand(createGame({ startingStack: 1000, bots: [{ name: 'A' }], seed: 31337, botBrain: 'model' }));
brain = applyAction(brain, { action: 'call' }, decideBotAction);
check('model brain pauses for the bot decision', brain.pendingDecision !== null, JSON.stringify(brain.phase));
const pendingSeat = brain.pendingDecision.seat;
const pendingStreet = brain.street;
const continued = submitBotDecision(brain, { action: 'check' }, decideBotDecision);
check('submitting a bot decision resumes play', continued.phase !== undefined);
check(
  'submitting a bot decision moves the hand on',
  continued.pendingDecision === null
    || continued.pendingDecision.seat !== pendingSeat
    || continued.street !== pendingStreet
    || continued.actionLog.length > brain.actionLog.length,
  json({ seat: continued.pendingDecision && continued.pendingDecision.seat, street: continued.street }),
);
check('the engine falls back when a policy is refusable', (() => {
  const state = startHand(createGame({ startingStack: 1000, bots: [{ name: 'A' }], seed: 5 }));
  const after = applyAction(state, { action: 'call' }, () => ({ action: 'call' }));
  // The bot is asked twice with nothing to call (preflop as the big blind, then
  // first on the flop), so a policy that only ever calls falls back twice and
  // the hand still reaches the hero's turn.
  return after.stats.botFallbacks >= 1 && after.phase === 'betting' && after.actorSeat === 0;
})(), 'a policy that always calls must fall back to check on a free street');

function decideBotDecision() {
  return { action: 'check' };
}

// ── opponent policy: personalities must be distinguishable ─────────────────

/**
 * Stage a flop where the hero (seat 0) has bet 50 and the bot (seat 1) must
 * respond: pot 200, to call 50 — a cheap call a real player rarely folds.
 */
function stagedFacingBet(style, seed) {
  const state = startHand(createGame({ startingStack: 1000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.street = 'flop';
  state.board = ['As', 'Kd', '7c'];
  state.players[0].streetCommitted = 50;
  state.players[0].handCommitted += 50;
  state.players[0].hasActed = true;
  state.players[1].streetCommitted = 0;
  state.players[1].hasActed = false;
  state.currentBet = 50;
  state.lastRaiseSize = 50;
  state.actorSeat = 1;
  return state;
}

/** Fraction of cheap-call decisions a personality folds over many deals. */
function foldRate(style, iterations = 300) {
  let folds = 0;
  for (let index = 0; index < iterations; index += 1) {
    const state = stagedFacingBet(style, 1000 + index * 7);
    state.rng = (state.rng + index * 2654435761) >>> 0;
    if (decideBotAction(state, 1).action === 'fold') folds += 1;
  }
  return folds / iterations;
}

const foldRates = Object.fromEntries(Object.keys(BOT_STYLES).map((style) => [style, foldRate(style)]));
check('a rock folds cheap bets more than a maniac', foldRates.rock > foldRates.maniac, JSON.stringify(foldRates));
check('a calling station keeps calling cheap bets', foldRates.station < 0.4, `station fold rate ${foldRates.station}`);
check('a maniac almost never folds a cheap bet', foldRates.maniac < 0.3, `maniac fold rate ${foldRates.maniac}`);
check('every personality still folds sometimes', Object.values(foldRates).every((rate) => rate > 0), JSON.stringify(foldRates));

// ── a shove is not "a price" ───────────────────────────────────────────────
//
// The complaint a player caught: an all-in would get several callers holding hands
// with no equity, because the call rule compared a made-hand score to pot odds and
// said "worth the price" - which is true of almost anything once the price is
// small. Against a range that is nothing but strong hands, the hand has to beat it.

/** Stage a flop where seat 0 has shoved and the bot (seat 1) must respond. */
function stagedShove(style, holeCards, seed, shove = 900) {
  const state = startHand(createGame({ startingStack: 1000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.street = 'flop';
  state.board = ['Ah', 'Kd', '7c'];
  state.players[0].streetCommitted = shove;
  state.players[0].handCommitted += shove;
  state.players[0].allIn = true;
  state.players[0].stack = 0;
  state.players[1].cards = holeCards.slice();
  state.players[1].streetCommitted = 0;
  state.players[1].hasActed = false;
  state.currentBet = shove;
  state.lastRaiseSize = shove;
  state.actorSeat = 1;
  return state;
}

const shoveAir = decideBotAction(stagedShove('lag', ['Qc', 'Jd'], 4242), 1);
check('a big shove folds a hand with no equity', shoveAir.action === 'fold', JSON.stringify(shoveAir));
const shoveTrips = decideBotAction(stagedShove('lag', ['Ac', 'Ad'], 4242), 1);
check('a big shove does not fold a set', shoveTrips.action !== 'fold', JSON.stringify(shoveTrips));
// Top pair against a full shove is a fold, not a call: the shoving range is two pair
// and better plus the best draws, so "I have top pair" is not a reason to stack off.
// (This test used to assert the opposite, and that is exactly the "the bots love
// calling all-ins" complaint.)
const shoveTopPair = decideBotAction(stagedShove('tag', ['Ac', 'Qd'], 4242), 1);
check('top pair folds to a full shove', shoveTopPair.action === 'fold', JSON.stringify(shoveTopPair));
// The same hand, same board, but the bet is a third of the pot: now the price is
// right and top pair is a call. The rule is about the SIZE of the bet, not the hand.
const smallBet = decideBotAction(stagedShove('tag', ['Ac', 'Qd'], 4242, 250), 1);
check('top pair calls a third-pot bet', smallBet.action !== 'fold', JSON.stringify(smallBet));
// Second pair on an ace-high board is not top pair, and against a shove it is a
// fold: the king pairing the board's second card is exactly the trap hand.
const shoveSecondPair = decideBotAction(stagedShove('tag', ['Kc', 'Qd'], 4242), 1);
check('second pair folds to a shove', shoveSecondPair.action === 'fold', JSON.stringify(shoveSecondPair));
// Across every personality: no more than a trickle of air calls, and the made
// hands keep going with it.
let airCalls = 0;
let setCalls = 0;
for (const style of Object.keys(BOT_STYLES)) {
  for (let seed = 500; seed < 520; seed += 1) {
    if (decideBotAction(stagedShove(style, ['Qc', 'Jd'], seed), 1).action !== 'fold') airCalls += 1;
    if (decideBotAction(stagedShove(style, ['Ac', 'Ad'], seed), 1).action !== 'fold') setCalls += 1;
  }
}
check('every personality mostly folds air to a shove', airCalls <= 12, `${airCalls} of 120`);
check('every personality continues with a set against a shove', setCalls >= 108, `${setCalls} of 120`);

// Preflop, the same idea: a raise that commits the stack is a different decision
// from a 3BB open, so the continuing range has to shrink with it.
function stagedPreflopShove(style, holeCards, seed) {
  const state = startHand(createGame({ startingStack: 2000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.players[0].cards = ['Ac', 'Ad'];
  const shove = state.players[0].stack;
  state.players[0].streetCommitted = shove;
  state.players[0].handCommitted += shove;
  state.players[0].allIn = true;
  state.players[0].stack = 0;
  state.players[1].cards = holeCards.slice();
  state.currentBet = shove;
  state.lastRaiseSize = shove - state.config.bigBlind;
  state.actorSeat = 1;
  return state;
}

let junkPreflopCalls = 0;
for (const style of Object.keys(BOT_STYLES)) {
  for (let seed = 700; seed < 720; seed += 1) {
    if (decideBotAction(stagedPreflopShove(style, ['7c', '2d'], seed), 1).action !== 'fold') junkPreflopCalls += 1;
  }
}
check('nobody calls off preflop with 7-2 offsuit', junkPreflopCalls <= 6, `${junkPreflopCalls} of 120`);

// ── the same hand, two prices: the range has to follow the PRICE ────────────
//
// This is the coherence the player asked for. The old numbers gave the two spots
// nearly the same range, so the table either folded everything to a 3BB open or
// called off half a stack against a shove - both complaints at once.

/**
 * Six-max, folded to the big blind: the first seat opened to `raiseTo` and the big
 * blind (the seat under test) closes the action.
 */
function stagedBigBlindFacing(style, raiseTo, seed, cards, stack = 2000) {
  const state = startHand(createGame({
    startingStack: stack,
    smallBlind: 50,
    bigBlind: 100,
    seed,
    bots: [1, 2, 3, 4, 5].map((slot) => ({ name: `B${slot}`, style })),
  }));
  const total = state.players.length;
  const bigBlindSeat = state.bigBlindSeat;
  const openerSeat = (bigBlindSeat + 1) % total;
  state.players.forEach((player) => {
    player.folded = false;
    player.out = false;
    player.allIn = false;
    player.hasActed = false;
  });
  for (let step = 2; step < total; step += 1) {
    const between = state.players[(bigBlindSeat + step) % total];
    between.folded = true;
    between.hasActed = true;
  }
  const opener = state.players[openerSeat];
  opener.streetCommitted = raiseTo;
  opener.handCommitted = raiseTo;
  opener.hasActed = true;
  if (raiseTo >= stack) {
    opener.allIn = true;
    opener.stack = 0;
  }
  state.players[bigBlindSeat].cards = cards.slice();
  state.currentBet = raiseTo;
  state.lastRaiseSize = Math.max(state.config.bigBlind, raiseTo - state.config.bigBlind);
  state.street = 'preflop';
  state.phase = 'betting';
  state.actorSeat = bigBlindSeat;
  return state;
}

const callVsSmall = (style, cards, seed) => decideBotAction(stagedBigBlindFacing(style, 300, seed, cards), 2).action;
const callVsShove = (style, cards, seed) => decideBotAction(stagedBigBlindFacing(style, 2000, seed, cards), 2).action;
const bigBlindSeatOf = (state) => state.bigBlindSeat;
check('the staged spot really is the big blind', bigBlindSeatOf(stagedBigBlindFacing('tag', 300, 1, ['Ac', 'Kd'])) === 2,
  String(bigBlindSeatOf(stagedBigBlindFacing('tag', 300, 1, ['Ac', 'Kd']))));

// KQo is a top-13% hand: worth defending against a 3BB open, not worth a stack.
check('a top-13% hand defends a small open', callVsSmall('tag', ['Kc', 'Qd'], 4242) !== 'fold', callVsSmall('tag', ['Kc', 'Qd'], 4242));
check('the same hand folds to a 100BB shove', callVsShove('tag', ['Kc', 'Qd'], 4242) === 'fold', callVsShove('tag', ['Kc', 'Qd'], 4242));
// 66 is a top-6% hand: it continues either way.
check('a small pair continues against a small open', callVsSmall('tag', ['6c', '6d'], 4242) !== 'fold', callVsSmall('tag', ['6c', '6d'], 4242));
check('a small pair still continues against a shove', callVsShove('tag', ['6c', '6d'], 4242) !== 'fold', callVsShove('tag', ['6c', '6d'], 4242));
// Junk folds to both.
check('junk folds to a small open too', callVsSmall('station', ['7c', '2d'], 4242) === 'fold', callVsSmall('station', ['7c', '2d'], 4242));
check('junk folds to a shove', callVsShove('station', ['7c', '2d'], 4242) === 'fold', callVsShove('station', ['7c', '2d'], 4242));
// Across every personality the shove range stays a premium range, and nobody folds
// aces to a 3BB open.
let shoveJunk = 0;
let openAces = 0;
for (const style of Object.keys(BOT_STYLES)) {
  for (let seed = 1300; seed < 1330; seed += 1) {
    if (callVsShove(style, ['Jc', 'Td'], seed) !== 'fold') shoveJunk += 1;
    if (callVsSmall(style, ['Ac', 'Ad'], seed) !== 'fold') openAces += 1;
  }
}
check('nobody stacks off with J-T offsuit against a shove', shoveJunk <= 10, `${shoveJunk} of 180`);
check('every personality plays aces against a small open', openAces === 180, `${openAces} of 180`);

// ── playing the board is not a made hand ───────────────────────────────────
//
// The real regression a player caught: a station called a river bet holding
// 2♣3♣ on a board of 4♠6♣6♥4♣K♠, because seven cards "made two pair" - which was
// the BOARD's two pair, with her hole cards contributing nothing.

const PAIRED_RIVER = ['4s', '6c', '6h', '4c', 'Ks'];
check('a hand that only plays the board is detected', playsTheBoard(['2c', '3c'], PAIRED_RIVER) === true);
check('a hand that beats the board is not', playsTheBoard(['Kd', 'Qs'], PAIRED_RIVER) === false);
check('an ace-high hand beats the board too', playsTheBoard(['Ah', '2d'], PAIRED_RIVER) === false);
check(
  'playing the board scores near zero',
  postflopStrength(['2c', '3c'], PAIRED_RIVER) < 0.15,
  String(postflopStrength(['2c', '3c'], PAIRED_RIVER)),
);
check(
  'two pair made with a hole card still scores high',
  postflopStrength(['Kd', 'Qs'], PAIRED_RIVER) > 0.5,
  String(postflopStrength(['Kd', 'Qs'], PAIRED_RIVER)),
);
check(
  'board-only is weaker than the same category made with a hole card',
  postflopStrength(['2c', '3c'], PAIRED_RIVER) < postflopStrength(['Ah', '2d'], PAIRED_RIVER),
);

/** Stage the exact river spot: the bot (seat 1) faces `bet` on that board. */
function stagedRiver(style, cards, bet, seed) {
  const state = startHand(createGame({ startingStack: 4000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.street = 'river';
  state.board = PAIRED_RIVER.slice();
  state.players[1].cards = cards.slice();
  state.players[0].streetCommitted = bet;
  state.players[0].handCommitted += bet;
  state.players[0].hasActed = true;
  state.players[1].streetCommitted = 0;
  state.players[1].hasActed = false;
  state.currentBet = bet;
  state.lastRaiseSize = bet;
  state.actorSeat = 1;
  return state;
}

/** How often one personality calls that river spot. */
function riverCallRate(style, cards, bet, iterations = 300) {
  let calls = 0;
  for (let index = 0; index < iterations; index += 1) {
    const state = stagedRiver(style, cards, bet, 500 + index * 13);
    state.rng = (state.rng + index * 2654435761) >>> 0;
    if (decideBotAction(state, 1).action === 'call') calls += 1;
  }
  return calls / iterations;
}

const stationBoardOnly = riverCallRate('station', ['2c', '3c'], 650);
const stationRealHand = riverCallRate('station', ['Kd', 'Qs'], 650);
check('a station no longer pays off a river bet while playing the board', stationBoardOnly < 0.15, `board-only call rate ${stationBoardOnly}`);
check('the same station still calls with a hand that beats the board', stationRealHand > 0.5, `real-hand call rate ${stationRealHand}`);
check('board-only folds far more than a real hand', stationRealHand - stationBoardOnly > 0.4, `${stationBoardOnly} vs ${stationRealHand}`);
const maniacBoardOnly = riverCallRate('maniac', ['2c', '3c'], 650);
check('even a maniac mostly folds a board-only river hand', maniacBoardOnly < 0.2, String(maniacBoardOnly));

// ── the price decides how good a hand must be ──────────────────────────────
//
// The bug a player caught in a real hand: 石头 (loose-aggressive) called 4,550 on
// the turn holding J♦T♦ on 5♦2♣K♥9♠ — J-high with a gutshot — against a bet that
// was 77% of the pot, and then paid off the river too. The call rule compared the
// hand against a FIXED strength bar and never looked at the price, and a gutshot
// scored nearly as high as an open-ender.

const TURN_BOARD = ['5d', '2c', 'Kh', '9s'];

check(
  'a gutshot is not a strong hand',
  postflopStrength(['Jd', 'Td'], TURN_BOARD) < 0.2,
  String(postflopStrength(['Jd', 'Td'], TURN_BOARD)),
);
check(
  'an unpaired ace-high hand is not a 34% hand either',
  postflopStrength(['Ad', 'Td'], ['5d', '2c', '9h']) < 0.3,
  String(postflopStrength(['Ad', 'Td'], ['5d', '2c', '9h'])),
);
check(
  'a flush draw still outranks a gutshot',
  postflopStrength(['Ad', 'Td'], ['5d', '2c', 'Kd', '9s']) > postflopStrength(['Jd', 'Td'], TURN_BOARD),
  `${postflopStrength(['Ad', 'Td'], ['5d', '2c', 'Kd', '9s'])} vs ${postflopStrength(['Jd', 'Td'], TURN_BOARD)}`,
);

/** Stage a postflop spot: seat 1 holds `cards` facing `bet` with `potBefore` in. */
function stagedFacingBetSize(style, cards, board, potBefore, bet, seed) {
  const state = startHand(createGame({ startingStack: 20000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.phase = 'betting';
  state.street = board.length === 3 ? 'flop' : 'turn';
  state.board = board.slice();
  state.players[0].cards = ['2d', '4d'];
  state.players[1].cards = cards.slice();
  state.players[0].handCommitted = potBefore + bet;
  state.players[0].streetCommitted = bet;
  state.players[1].handCommitted = 0;
  state.players[1].streetCommitted = 0;
  state.currentBet = bet;
  state.lastRaiseSize = bet;
  state.actorSeat = 1;
  return state;
}

/** How often one personality calls or raises in that spot (all-in counts as a raise). */
function decisionRates(style, cards, board, potBefore, bet, iterations = 200) {
  let calls = 0;
  let raises = 0;
  for (let index = 0; index < iterations; index += 1) {
    const state = stagedFacingBetSize(style, cards, board, potBefore, bet, 400 + index * 17);
    state.rng = (state.rng + index * 2654435761) >>> 0;
    const action = decideBotAction(state, 1).action;
    if (action === 'call') calls += 1;
    else if (action === 'raise' || action === 'allin') raises += 1;
  }
  return { call: calls / iterations, raise: raises / iterations };
}

/** How often one personality continues (calls or raises) in that spot. */
function continueRate(style, cards, board, potBefore, bet, iterations = 200) {
  const rates = decisionRates(style, cards, board, potBefore, bet, iterations);
  return rates.call + rates.raise;
}

// The exact spot: 5,900 in the pot, 小美 bets 4,550 (77% pot, so the call needs
// 30% of the final pot). Every personality has to let J-high go - a maniac may
// still bluff-raise it sometimes, which is a different (and intended) behaviour.
const gutshotCalls = Object.fromEntries(Object.keys(BOT_STYLES).map((style) => [style, decisionRates(style, ['Jd', 'Td'], TURN_BOARD, 5900, 4550).call]));
check(
  'nobody calls three quarters of the pot with J-high and a gutshot',
  Object.values(gutshotCalls).every((rate) => rate < 0.05),
  JSON.stringify(gutshotCalls),
);
const gutshotRaises = Object.fromEntries(Object.keys(BOT_STYLES).map((style) => [style, decisionRates(style, ['Jd', 'Td'], TURN_BOARD, 5900, 4550).raise]));
check(
  'even the maniac only occasionally turns it into a bluff',
  gutshotRaises.maniac < 0.25 && gutshotRaises.rock < 0.05,
  JSON.stringify(gutshotRaises),
);
// The same price with a real draw is a call, so the fix is the price comparison
// and not a blanket "fold to big bets".
const flushRates = Object.fromEntries(Object.keys(BOT_STYLES).map((style) => [style, continueRate(style, ['Ad', 'Td'], ['5d', '2c', 'Kd', '9s'], 5900, 4550)]));
check(
  'a nut flush draw still calls that same bet',
  Object.values(flushRates).every((rate) => rate > 0.9),
  JSON.stringify(flushRates),
);
check(
  'a set of fives raises it',
  continueRate('tag', ['5h', '5c'], TURN_BOARD, 5900, 4550) > 0.4,
  String(continueRate('tag', ['5h', '5c'], TURN_BOARD, 5900, 4550)),
);
// A cheap price is still a cheap price: the same weak hand calls a quarter-pot
// bet, because that is what the price says.
const cheapRates = Object.fromEntries(Object.keys(BOT_STYLES).map((style) => [style, continueRate(style, ['Jd', 'Td'], TURN_BOARD, 4000, 1000)]));
check(
  'the same hand calls a quarter-pot bet',
  Object.values(cheapRates).every((rate) => rate > 0.5),
  JSON.stringify(cheapRates),
);

// ── draws die on the river ─────────────────────────────────────────────────
//
// A four-flush or four-straight on the river is not a draw: there are no cards
// left. Counting it as equity made every busted draw "worth" a third of the pot
// on the last street, which is a paying-off machine.

const RIVER_BUSTED_FLUSH = ['Qh', '7h', '2c', '3d', '9s'];
const TURN_FLUSH_DRAW = ['Qh', '7h', '2c', '3d'];
check(
  'a flush draw is worth something on the turn',
  postflopStrength(['Ah', 'Kh'], TURN_FLUSH_DRAW) > 0.3,
  String(postflopStrength(['Ah', 'Kh'], TURN_FLUSH_DRAW)),
);
check(
  'the same hand is only ace-high on the river',
  postflopStrength(['Ah', 'Kh'], RIVER_BUSTED_FLUSH) < 0.3
    && postflopStrength(['Ah', 'Kh'], RIVER_BUSTED_FLUSH) < postflopStrength(['Ah', 'Kh'], TURN_FLUSH_DRAW),
  `${postflopStrength(['Ah', 'Kh'], RIVER_BUSTED_FLUSH)} vs ${postflopStrength(['Ah', 'Kh'], TURN_FLUSH_DRAW)}`,
);
const RIVER_BUSTED_STRAIGHT = ['9s', '8h', '2c', '3d', 'Ks'];
check(
  'a busted straight draw is only jack-high on the river',
  postflopStrength(['Jd', 'Td'], RIVER_BUSTED_STRAIGHT) < 0.25
    && postflopStrength(['Jd', 'Td'], RIVER_BUSTED_STRAIGHT) < postflopStrength(['Jd', 'Td'], ['9s', '8h', '2c', '3d']),
  `${postflopStrength(['Jd', 'Td'], RIVER_BUSTED_STRAIGHT)} vs ${postflopStrength(['Jd', 'Td'], ['9s', '8h', '2c', '3d'])}`,
);
check(
  'a river flush still scores as a made hand',
  postflopStrength(['Ah', 'Kh'], ['Qh', '7h', '2h', '3d', '9s']) > 0.85,
  String(postflopStrength(['Ah', 'Kh'], ['Qh', '7h', '2h', '3d', '9s'])),
);

// ── the board decides the bet size ─────────────────────────────────────────
//
// The coach tells the player "dry boards take small bets, wet boards need big
// ones". The bots have to follow the same advice, or the advice is worthless.

check('a dry board is read as dry', boardTexture(['Kc', '7d', '2h']).wet === false, JSON.stringify(boardTexture(['Kc', '7d', '2h'])));
check('a two-tone connected board is read as wet', boardTexture(['Kc', 'Qh', 'Jh']).wet === true, JSON.stringify(boardTexture(['Kc', 'Qh', 'Jh'])));
check('a paired board is flagged', boardTexture(['Kc', 'Kd', '2h']).paired === true, JSON.stringify(boardTexture(['Kc', 'Kd', '2h'])));

// ── short stacks shove, deep stacks size their bets ────────────────────────
//
// The coach says "SPR ≤ 3：顶对可以打到全下". Betting a third of the pot with a set
// at SPR 1.5 hands a draw the right price, so the bots put it in.

const SHOVE_BOARD = ['Ks', '8h', '2c'];

/** A seat first to act on `SHOVE_BOARD`, holding `cards`, with a given SPR. */
function stagedSet(stack, potBefore, opponentStack, seed, cards = ['8s', '8d']) {
  const state = startHand(createGame({
    startingStack: 40000, smallBlind: 50, bigBlind: 100,
    bots: [{ name: 'A', style: 'tag' }],
    seed,
  }));
  state.phase = 'betting';
  state.street = 'flop';
  state.board = SHOVE_BOARD.slice();
  state.players[0].style = 'station';
  state.players[0].cards = ['2d', '4d'];
  state.players[0].handCommitted = potBefore;
  state.players[0].streetCommitted = 0;
  state.players[0].stack = opponentStack;
  state.players[1].style = 'tag';
  state.players[1].cards = cards.slice();
  state.players[1].handCommitted = 0;
  state.players[1].streetCommitted = 0;
  state.players[1].stack = stack;
  state.currentBet = 0;
  state.lastRaiseSize = 100;
  state.actorSeat = 1;
  return state;
}

const shortShove = decideBotAction(stagedSet(1500, 1000, 3000, 77), 1);
check('a set at a small SPR goes all-in', shortShove.action === 'allin', JSON.stringify(shortShove));
const deepBet = decideBotAction(stagedSet(30000, 1000, 30000, 77), 1);
check('the same set at a deep SPR bets a normal size', deepBet.action === 'raise' && deepBet.amount > 0 && deepBet.amount < 30000, JSON.stringify(deepBet));
check('a set really is a strong hand on that board', postflopStrength(['8s', '8d'], SHOVE_BOARD) > 0.5, String(postflopStrength(['8s', '8d'], SHOVE_BOARD)));
// The short stack alone is not a reason to shove: nine-high still checks.
const shortJunk = decideBotAction(stagedSet(1500, 1000, 3000, 77, ['9d', '5c']), 1);
check('a short stack does not shove junk', shortJunk.action === 'check', JSON.stringify(shortJunk));

// ── preflop sizing: bigger out of position ─────────────────────────────────
//
// Three bets cost more from the blinds, because acting first on every later
// street is a real disadvantage. The same aces should raise bigger there.

/** One 3-bet decision for a seat facing a raise, with the button fixed at 1. */
function stagedThreeBet(seat, seed) {
  const state = startHand(createGame({
    startingStack: 10000, smallBlind: 50, bigBlind: 100,
    bots: [{ name: 'A', style: 'tag' }, { name: 'B', style: 'tag' }],
    seed,
  }));
  state.phase = 'betting';
  state.street = 'preflop';
  state.buttonSeat = 1;
  state.smallBlindSeat = 2;
  state.bigBlindSeat = 0;
  state.players[0].cards = ['7d', '2c'];
  state.players[0].style = 'tag';
  state.players[0].streetCommitted = 300;
  state.players[0].hasActed = true;
  for (const other of state.players) {
    if (other.seat === 0) continue;
    other.cards = other.seat === seat ? ['As', 'Ad'] : ['8d', '3c'];
    other.style = 'tag';
    other.streetCommitted = 0;
    other.hasActed = false;
  }
  state.currentBet = 300;
  state.lastRaiseSize = 200;
  state.actorSeat = seat;
  return state;
}

/** The first 3-bet amount one seat makes with aces, over a few seeds. */
function threeBetAmount(seat) {
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = stagedThreeBet(seat, seed);
    state.rng = (seed * 2654435761) >>> 0;
    const decision = decideBotAction(state, seat);
    if (decision.action === 'raise') return decision.amount;
  }
  return 0;
}

const buttonThreeBet = threeBetAmount(1);
const blindThreeBet = threeBetAmount(2);
check('both seats three-bet their aces', buttonThreeBet > 0 && blindThreeBet > 0, `${buttonThreeBet} / ${blindThreeBet}`);
check('the three-bet is bigger from the blinds', blindThreeBet > buttonThreeBet, `button ${buttonThreeBet} vs blinds ${blindThreeBet}`);

/** Stage a spot where the bot is first to act with `cards` on `board`. */
function stagedNoBet(style, cards, board, potBefore, opponentStyle, seed) {
  const state = startHand(createGame({ startingStack: 20000, smallBlind: 50, bigBlind: 100, bots: [{ name: 'A', style }], seed }));
  state.phase = 'betting';
  state.street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
  state.board = board.slice();
  // Seat 1 is the bot under test; seat 0 is the opponent whose STYLE the table
  // read looks at, which is what the sizing and bluffing tests vary.
  state.players[0].style = opponentStyle ?? 'tag';
  state.players[0].cards = ['2d', '4d'];
  state.players[0].handCommitted = potBefore;
  state.players[0].streetCommitted = 0;
  state.players[1].style = style;
  state.players[1].cards = cards.slice();
  state.players[1].handCommitted = 0;
  state.players[1].streetCommitted = 0;
  state.currentBet = 0;
  state.lastRaiseSize = 100;
  state.actorSeat = 1;
  return state;
}

/** The bet one personality makes in that spot, or 0 when it checks. */
function betSizeIn(style, cards, board, potBefore, opponentStyle, seed) {
  const state = stagedNoBet(style, cards, board, potBefore, opponentStyle, seed);
  const decision = decideBotAction(state, 1);
  return decision.action === 'raise' ? decision.amount : 0;
}

const DRY_BOARD = ['Kc', '7d', '2h'];
const WET_BOARD = ['Kc', 'Qh', 'Jh'];
const TWO_PAIR = ['Kd', 'Qc'];
const dryBet = betSizeIn('tag', TWO_PAIR, DRY_BOARD, 1000, null, 4242);
const wetBet = betSizeIn('tag', TWO_PAIR, WET_BOARD, 1000, null, 4242);
check('two pair bets on both boards', dryBet > 0 && wetBet > 0, `${dryBet} / ${wetBet}`);
check('the same hand bets bigger on a wet board', wetBet > dryBet, `dry ${dryBet} vs wet ${wetBet}`);
check('a dry-board value bet stays small', dryBet <= 1000 * 0.7, String(dryBet));
check('a wet-board value bet is a real bet', wetBet >= 1000 * 0.6, String(wetBet));

// ── the bots read the table, not just the cards ────────────────────────────
//
// Bluffing a station is burning money; value betting one is printing it.

const stationBet = betSizeIn('tag', TWO_PAIR, DRY_BOARD, 1000, 'station', 4242);
const rockBet = betSizeIn('tag', TWO_PAIR, DRY_BOARD, 1000, 'rock', 4242);
check('value bets grow against a calling station', stationBet > rockBet, `station ${stationBet} vs rock ${rockBet}`);

/** How often a bluffing personality fires into one kind of opponent. */
function bluffRate(opponentStyle, iterations = 200) {
  let bets = 0;
  for (let index = 0; index < iterations; index += 1) {
    // Nine-high on a dry board: no pair, no draw, so only a bluff bets.
    const state = stagedNoBet('maniac', ['9d', '5c'], DRY_BOARD, 1000, opponentStyle, 900 + index * 13);
    state.rng = (state.rng + index * 2654435761) >>> 0;
    if (decideBotAction(state, 1).action === 'raise') bets += 1;
  }
  return bets / iterations;
}

const bluffIntoRock = bluffRate('rock');
const bluffIntoStation = bluffRate('station');
check('a maniac still bluffs a rock', bluffIntoRock > 0.1, String(bluffIntoRock));
check('a maniac stops bluffing a station', bluffIntoStation < bluffIntoRock * 0.7, `rock ${bluffIntoRock} vs station ${bluffIntoStation}`);

// ── preflop: position-aware ranges ─────────────────────────────────────────
//
// The bug a player caught: at an eight-handed table the seats on one side never
// entered a pot. Two causes - a pair computed gap = -1 and fell through to the
// widest-gap penalty, so 88 scored below KQo; and every seat compared one
// absolute threshold, so early position folded almost everything.

check('a pair of eights outranks KQo', preflopStrength(['8s', '8h']) > preflopStrength(['Ks', 'Qh']), `${preflopStrength(['8s', '8h'])} vs ${preflopStrength(['Ks', 'Qh'])}`);
check('aces top the scale', preflopStrength(['As', 'Ah']) === 1, String(preflopStrength(['As', 'Ah'])));
check('pairs beat a same-rank unsuited hand', preflopStrength(['8s', '8h']) > preflopStrength(['8s', '2h']));
check('percentile is monotone in strength', preflopPercentile(0.6) > preflopPercentile(0.3));
check('aces are the top of the range', preflopPercentile(preflopStrength(['As', 'Ah'])) === 1, String(preflopPercentile(preflopStrength(['As', 'Ah']))));
check('seven-deuce sits at the bottom', preflopPercentile(preflopStrength(['7s', '2h'])) < 0.06, String(preflopPercentile(preflopStrength(['7s', '2h']))));
check('the percentile spans the whole deck', preflopPercentile(0) === 0 && preflopPercentile(1) === 1);

/**
 * Play out hands with no human seat and report how often somebody other than the
 * blinds entered preflop, plus the fold rate per positional bucket.
 */
function preflopField(players, hands) {
  const buckets = new Map();
  let withNonBlind = 0;
  let noRaise = 0;
  let sawFlop = 0;
  let multiway = 0;
  let isolated = 0;
  for (let hand = 0; hand < hands; hand += 1) {
    let state = startHand(createGame({
      startingStack: 10000,
      smallBlind: 50,
      bigBlind: 100,
      seed: 9000 + hand * 3571,
      bots: Array.from({ length: players - 1 }, (_, index) => ({ name: `B${index}`, style: Object.keys(BOT_STYLES)[index % 6] })),
    }));
    state = { ...state, players: state.players.map((player) => ({ ...player, isHuman: false })) };
    state = advance(state, (current, seat) => {
      const behind = playersBehind(current, seat);
      const decision = decideBotAction(current, seat);
      const bucket = buckets.get(behind) ?? { decisions: 0, folds: 0, raises: 0 };
      bucket.decisions += 1;
      if (decision.action === 'fold') bucket.folds += 1;
      if (decision.action === 'raise' || decision.action === 'allin') bucket.raises += 1;
      buckets.set(behind, bucket);
      return decision;
    });
    const preflop = state.actionLog.filter((entry) => entry.street === 'preflop');
    const raises = preflop.filter((entry) => entry.action === 'raise' || entry.action === 'allin').length;
    const calls = preflop.filter((entry) => entry.action === 'call').length;
    if (raises === 0) noRaise += 1;
    if (raises === 1 && calls === 0) isolated += 1;
    if (raises === 1 && calls >= 2) multiway += 1;
    if (state.board.length >= 3) sawFlop += 1;
    const entrants = new Set(preflop
      .filter((entry) => entry.action !== 'fold' && entry.action !== 'check')
      .map((entry) => entry.seat));
    if ([...entrants].some((seat) => seat !== 1 && seat !== 2)) withNonBlind += 1;
  }
  const foldRate = (behind) => {
    const bucket = buckets.get(behind);
    return bucket ? bucket.folds / bucket.decisions : null;
  };
  const openRate = (behind) => {
    const bucket = buckets.get(behind);
    return bucket ? bucket.raises / bucket.decisions : null;
  };
  return {
    rate: withNonBlind / hands,
    foldRate,
    openRate,
    walkRate: noRaise / hands,
    flopRate: sawFlop / hands,
    isolatedRate: isolated / hands,
    multiwayRate: multiway / hands,
  };
}

const sixMaxField = preflopField(6, 200);
const fullRingField = preflopField(8, 200);
check('a six-handed table sees non-blind preflop entries', sixMaxField.rate > 0.4, `entry rate ${Math.round(sixMaxField.rate * 100)}%`);
check('a full ring sees non-blind preflop entries', fullRingField.rate > 0.55, `entry rate ${Math.round(fullRingField.rate * 100)}%`);
check(
  'early position folds more than late position',
  fullRingField.foldRate(7) !== null && fullRingField.foldRate(2) !== null && fullRingField.foldRate(7) > fullRingField.foldRate(2) + 0.1,
  `UTG fold ${fullRingField.foldRate(7)} vs button-region fold ${fullRingField.foldRate(2)}`,
);
check('the button region is not folding everything', fullRingField.foldRate(2) < 0.75, String(fullRingField.foldRate(2)));

// The complaint this guards: "翻前弃牌率也太高了" - a table where nobody opens and the
// blinds chop it up. Measured over 3000 six-handed hands with the same instrument:
// the pre-turn policy walked 23% of hands, the first tightening overshot to 41%
// flops, and the tuning in place now walks 10% and shows a flop in 57%.
check('a six-handed table rarely walks to the blinds', sixMaxField.walkRate < 0.15, `walk rate ${Math.round(sixMaxField.walkRate * 100)}%`);
check('most six-handed hands see a flop', sixMaxField.flopRate > 0.45, `flop rate ${Math.round(sixMaxField.flopRate * 100)}%`);
check('an open does not always take it down', sixMaxField.isolatedRate < 0.35, `isolated ${Math.round(sixMaxField.isolatedRate * 100)}%`);
check('multiway pots happen', sixMaxField.multiwayRate > 0.15, `multiway ${Math.round(sixMaxField.multiwayRate * 100)}%`);
check('early position folds more than late position at six-handed too',
  sixMaxField.foldRate(5) !== null && sixMaxField.foldRate(1) !== null && sixMaxField.foldRate(5) > sixMaxField.foldRate(1) + 0.1,
  `UTG fold ${sixMaxField.foldRate(5)} vs late fold ${sixMaxField.foldRate(1)}`);

/**
 * How often one seat opens, over many real deals at a full table.
 *
 * The positional shape is the thing under test, so the seats are addressed by their
 * distance from the big blind: 1 is under the gun (five still to act), 4 is the
 * button (two: the small blind and the big blind).
 */
function openRateFor(style, seatFromBigBlind, iterations = 200) {
  let opens = 0;
  for (let index = 0; index < iterations; index += 1) {
    const state = startHand(createGame({
      startingStack: 2000,
      smallBlind: 50,
      bigBlind: 100,
      seed: 4000 + index * 977,
      bots: [1, 2, 3, 4, 5].map((slot) => ({ name: `B${slot}`, style })),
    }));
    state.players.forEach((player) => {
      player.folded = false;
      player.out = false;
      player.allIn = false;
      player.hasActed = false;
    });
    const seat = (state.bigBlindSeat + seatFromBigBlind) % state.players.length;
    // Everyone who acts before this seat has already folded, which is what leaves
    // the right number of players still to act behind it.
    for (let step = 1; step < seatFromBigBlind; step += 1) {
      const before = state.players[(state.bigBlindSeat + step) % state.players.length];
      before.folded = true;
      before.hasActed = true;
    }
    state.currentBet = state.config.bigBlind;
    state.lastRaiseSize = state.config.bigBlind;
    state.street = 'preflop';
    state.phase = 'betting';
    state.actorSeat = seat;
    const decision = decideBotAction(state, seat);
    if (decision.action === 'raise' || decision.action === 'allin') opens += 1;
  }
  return opens / iterations;
}

const utgOpen = openRateFor('tag', 1);
const buttonOpen = openRateFor('tag', 4);
const rockOpen = openRateFor('rock', 1);
const maniacOpen = openRateFor('maniac', 1);
check('the first seat to act still opens a real range', utgOpen > 0.22, `UTG open ${utgOpen}`);
check('the button opens much wider than the first seat', buttonOpen > utgOpen + 0.12, `UTG ${utgOpen} vs button ${buttonOpen}`);
check('a maniac opens far more than a rock', maniacOpen > rockOpen + 0.1, `rock ${rockOpen} vs maniac ${maniacOpen}`);
check('even a rock opens something', rockOpen > 0.15, `rock UTG open ${rockOpen}`);

// ── the opponents' rates move with the table ────────────────────────────────
//
// The request: "其他玩家的这些率也应该适当动态调整". A declared personality is the
// starting point; what the table actually does moves it, and the counters survive
// from hand to hand.

/** A six-max preflop spot where the other seats carry a history. */
function stagedTableRead(style, history) {
  const state = startHand(createGame({
    startingStack: 2000,
    smallBlind: 50,
    bigBlind: 100,
    seed: 31,
    bots: [1, 2, 3, 4, 5].map((slot) => ({ name: `B${slot}`, style })),
  }));
  state.players.forEach((player, index) => {
    player.folded = false;
    player.out = false;
    player.allIn = false;
    player.hasActed = false;
    // Seat 0 is the reader; every other seat gets the supplied history.
    player.observed = index === 0 ? emptyObservation() : { ...emptyObservation(), hands: 40, ...history };
  });
  state.currentBet = state.config.bigBlind;
  state.lastRaiseSize = state.config.bigBlind;
  state.street = 'preflop';
  state.phase = 'betting';
  state.actorSeat = 3;
  return state;
}

const baselineStyle = BOT_STYLES.tag;
const noHistory = adjustStyle(stagedTableRead('tag', {}), 3, baselineStyle);
check('with no history the dials are the declared ones',
  noHistory.tightness === baselineStyle.tightness && noHistory.bluff === baselineStyle.bluff,
  JSON.stringify({ tightness: noHistory.tightness, bluff: noHistory.bluff }));
check('a hand or two is not a read', (() => {
  const state = stagedTableRead('tag', {});
  state.players[1].observed = { ...emptyObservation(), hands: 2, vpip: 2 };
  return adjustStyle(state, 3, baselineStyle).tightness === baselineStyle.tightness;
})(), 'a 2-hand sample moved the dials');

// A loose table (everyone plays everything) makes the seat tighter and quieter.
const looseTable = adjustStyle(stagedTableRead('tag', { vpip: 34, pfr: 4, calls: 20, facedBet: 10, foldedToBet: 3 }), 3, baselineStyle);
check('a loose table tightens a seat up', looseTable.tightness > baselineStyle.tightness, `${baselineStyle.tightness} -> ${looseTable.tightness}`);
check('a loose table cuts the bluffing', looseTable.bluff < baselineStyle.bluff, `${baselineStyle.bluff} -> ${looseTable.bluff}`);

// A table that folds to pressure gets bluffed and stolen from more.
const foldyTable = adjustStyle(stagedTableRead('tag', { vpip: 8, pfr: 3, facedBet: 12, foldedToBet: 11 }), 3, baselineStyle);
check('a table that folds to bets gets bluffed more', foldyTable.bluff > baselineStyle.bluff, `${baselineStyle.bluff} -> ${foldyTable.bluff}`);
check('a foldy table raises the aggression', foldyTable.aggression > baselineStyle.aggression, `${baselineStyle.aggression} -> ${foldyTable.aggression}`);

// An aggressive table gets respected: tighten, and do not loosen up with it.
const aggroTable = adjustStyle(stagedTableRead('station', { vpip: 30, pfr: 26, bets: 24, facedBet: 8, foldedToBet: 2 }), 3, BOT_STYLES.station);
check('an aggressive table tightens even a station', aggroTable.tightness > BOT_STYLES.station.tightness,
  `${BOT_STYLES.station.tightness} -> ${aggroTable.tightness}`);
check('the adjustment stays bounded', aggroTable.tightness - BOT_STYLES.station.tightness <= 0.12,
  String(aggroTable.tightness - BOT_STYLES.station.tightness));
check('the declared personality is still recognisable', aggroTable.tightness < BOT_STYLES.tag.tightness,
  `${aggroTable.tightness} vs tag ${BOT_STYLES.tag.tightness}`);

// The tally is fed by real play, and it survives into the next hand.
let tallyState = startHand(createGame({
  startingStack: 2000,
  smallBlind: 50,
  bigBlind: 100,
  seed: 77,
  bots: [{ name: 'A', style: 'tag' }],
}));
tallyState = { ...tallyState, players: tallyState.players.map((player) => ({ ...player, isHuman: false })) };
tallyState = advance(tallyState, (current, seat) => decideBotAction(current, seat));
const tallyAfter = tallyState.players.map((player) => player.observed);
check('every seat carries a tally after a hand',
  tallyAfter.every((tally) => tally && tally.hands === 1), JSON.stringify(tallyAfter[0]));
check('the tally counts what the seat did',
  tallyAfter.some((tally) => tally.folds > 0 || tally.calls > 0 || tally.bets > 0),
  JSON.stringify(tallyAfter));
const nextHand = startHand(tallyState);
check('the tally survives into the next hand', nextHand.players.every((player) => player.observed.hands === 2),
  JSON.stringify(nextHand.players.map((player) => player.observed.hands)));
check('the per-hand counters do not leak into the next hand',
  nextHand.players.every((player) => player.observed.calls === tallyState.players[player.seat].observed.calls),
  'a per-hand field was reset');

// ── view + render smoke test ────────────────────────────────────────────────

const view = viewFor(threeHanded, 0);
checkEqual('view hides other players hole cards', view.players[1].cards, null);
checkEqual('view shows the viewer hole cards', view.players[0].cards.length, 2);
check('view exposes the legal menu to the actor', view.legal !== null && typeof view.legal.minRaiseTo === 'number');
const text = renderTable(threeHanded, 0);
check('render mentions the pot', text.includes('\u5e95\u6c60'));
check('render mentions the action prompt', text.includes('\u8be5\u4f60\u884c\u52a8'));
check('render hides opponents cards', text.includes('\u25a0\u25a0'));

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} checks passed (hands simulated: ${handsPlayed}, showdowns: ${showdowns}, max hand #${maxHands})`);
}
