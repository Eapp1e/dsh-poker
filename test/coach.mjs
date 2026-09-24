/**
 * Coach harness: the analysis layer has to be right, or it teaches the wrong
 * thing. These checks pin the parts a player can verify by hand - position
 * names, made-hand labels, outs, pot odds - and the parts that must never
 * happen: leaking an opponent's cards, or quoting a number the simulation did
 * not produce.
 *
 *   node test/coach.mjs
 */
import { createGame, potTotal, startHand, advance, applyAction, legalActions } from '../lib/engine.js';
import { decideBotAction } from '../lib/bots.js';
import { coachFor, drawsFor, equityVsReads, madeHand, positionName, potMath, readOpponents } from '../lib/coach.js';
import * as coachModule from '../lib/coach.js';
import * as gto from '../lib/gto.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

/** A dealt table, advanced until the hero is to act. */
function table(bots, seed, options = {}) {
  const state = createGame({
    heroName: '玩家',
    bots,
    startingStack: options.startingStack ?? 10000,
    smallBlind: options.smallBlind ?? 50,
    bigBlind: options.bigBlind ?? 100,
    seed,
  });
  return advance(startHand(state), decideBotAction);
}

/** A hand-written state: no engine, just the fields the coach reads. */
function handState(config) {
  const players = config.players.map((player) => ({
    seat: player.seat,
    name: player.name,
    isHuman: player.seat === 0,
    style: player.style ?? 'pro',
    stack: player.stack ?? 10000,
    streetCommitted: player.streetCommitted ?? 0,
    handCommitted: player.handCommitted ?? 0,
    folded: player.folded === true,
    allIn: player.allIn === true,
    out: false,
    lastAction: player.lastAction ?? null,
    talk: null,
    cards: player.cards,
    wonLastHand: 0,
  }));
  return {
    players,
    board: config.board ?? [],
    street: config.street ?? 'preflop',
    phase: config.phase ?? 'betting',
    currentBet: config.currentBet ?? 0,
    lastRaiseSize: config.lastRaiseSize ?? config.bigBlind ?? 100,
    actorSeat: config.actorSeat ?? 0,
    buttonSeat: config.buttonSeat ?? 0,
    smallBlindSeat: config.smallBlindSeat ?? 1,
    bigBlindSeat: config.bigBlindSeat ?? 2,
    config: { smallBlind: config.smallBlind ?? 50, bigBlind: config.bigBlind ?? 100 },
    actionLog: config.actionLog ?? [],
    handLog: [],
    rng: 12345,
    showdown: null,
    stats: {},
    gameOver: false,
    pendingDecision: null,
  };
}

// ---- position -------------------------------------------------------------

const sixMax = table([{ name: 'a', style: 'tag' }, { name: 'b', style: 'tag' }, { name: 'c', style: 'tag' }, { name: 'd', style: 'tag' }, { name: 'e', style: 'tag' }], 4242);
const positions = sixMax.players.map((player) => positionName(sixMax, player.seat));
check('six-handed positions are named from the blinds', positions.length === 6 && positions.includes('按钮位 BTN') && positions.includes('大盲 BB'), positions.join(' | '));
check('the blinds are named on the right seats', positions[sixMax.smallBlindSeat] === '小盲 SB' && positions[sixMax.bigBlindSeat] === '大盲 BB', `${positions[sixMax.smallBlindSeat]} / ${positions[sixMax.bigBlindSeat]}`);
check('the button is one seat before the small blind', positions[(sixMax.buttonSeat + 1) % 6] === '小盲 SB', positions.join(' | '));

const heads = table([{ name: 'a', style: 'tag' }], 7);
const headsPositions = heads.players.map((player) => positionName(heads, player.seat));
check('heads-up calls the button the small blind', headsPositions.includes('按钮/小盲 BTN·SB') && headsPositions.includes('大盲 BB'), headsPositions.join(' | '));

const ring = table(Array.from({ length: 8 }, (_, index) => ({ name: 'b' + index, style: 'tag' })), 11);
const ringPositions = ring.players.map((player) => positionName(ring, player.seat));
check('nine-handed adds the early and middle seats', ringPositions.includes('枪口位 UTG') && ringPositions.some((name) => name.startsWith('中间位')), ringPositions.join(' | '));

// ---- made hands -----------------------------------------------------------

check('an overpair is named an overpair', madeHand(['As', 'Ad'], ['Kh', '7c', '2d']).label.includes('超对'), madeHand(['As', 'Ad'], ['Kh', '7c', '2d']).label);
check('a set is named a set', madeHand(['8s', '8d'], ['8h', '7c', '2d']).label.includes('暗三'), madeHand(['8s', '8d'], ['8h', '7c', '2d']).label);
check('top pair carries its kicker', madeHand(['As', 'Jd'], ['Ah', '7c', '2d']).label === '顶对 top pair，J 踢脚', madeHand(['As', 'Jd'], ['Ah', '7c', '2d']).label);
check('a middle pair is named a middle pair', madeHand(['9s', 'Jd'], ['Ah', '9c', '2d']).label.includes('中对'), madeHand(['9s', 'Jd'], ['Ah', '9c', '2d']).label);
check('two pair uses both hole cards', madeHand(['As', 'Jd'], ['Ah', 'Jc', '2d']).label.includes('两对'), madeHand(['As', 'Jd'], ['Ah', 'Jc', '2d']).label);
check('a hand played on the board says so', madeHand(['3s', '4d'], ['As', 'Kd', 'Qh', 'Js', 'Tc']).note.includes('没帮上忙'), madeHand(['3s', '4d'], ['As', 'Kd', 'Qh', 'Js', 'Tc']).note);
check('preflop hands are described by shape', madeHand(['As', 'Ks'], []).label === 'AKs（同花）' && madeHand(['8s', '8d'], []).label === '对子 88', `${madeHand(['As', 'Ks'], []).label} / ${madeHand(['8s', '8d'], []).label}`);
check('preflop hands have no made-hand name', madeHand(['As', 'Ks'], []).name === null, String(madeHand(['As', 'Ks'], []).name));

// ---- draws and outs -------------------------------------------------------

const flush = drawsFor(['Ah', 'Kh'], ['Qh', '7h', '2c']);
check('a flush draw counts nine outs', flush.draws.some((draw) => draw.name.includes('同花听牌') && draw.outs === 9), JSON.stringify(flush.draws));
check('a paired board discounts the flush draw', drawsFor(['Ah', 'Kh'], ['Qh', '7h', '7c']).draws.some((draw) => draw.outs === 8), JSON.stringify(drawsFor(['Ah', 'Kh'], ['Qh', '7h', '7c']).draws));
const oesd = drawsFor(['9h', '8d'], ['7c', '6s', '2d']);
check('an open-ended draw counts eight outs', oesd.draws.some((draw) => draw.name.includes('两头顺') && draw.outs === 8), JSON.stringify(oesd.draws));
const gut = drawsFor(['9h', '5d'], ['7c', '6s', '2d']);
check('a gutshot counts four outs', gut.draws.some((draw) => draw.name.includes('卡顺') && draw.outs === 4), JSON.stringify(gut.draws));
const overcards = drawsFor(['Ah', 'Kd'], ['9c', '6s', '2d']);
check('overcards are counted but flagged', overcards.outs === 6 && overcards.draws.some((draw) => draw.note.includes('不是强听牌')), JSON.stringify(overcards.draws));
const fourFlush = drawsFor(['Ac', 'Kd'], ['Qh', '7h', '2h', '3h']).notes.join(' ');
check('a four-flush without a hole card warns instead of counting outs', fourFlush.includes('没有'), `draws=${JSON.stringify(drawsFor(['Ac', 'Kd'], ['Qh', '7h', '2h', '3h']))}`);
check('no draws are claimed preflop', drawsFor(['Ah', 'Kd'], []).outs === 0);
const turnFlush = drawsFor(['Ah', 'Kh'], ['Qh', '7h', '2c', '3d']);
check('the flush draw keeps its nine outs on the turn', turnFlush.draws.some((draw) => draw.name.includes('同花听牌') && draw.outs === 9), JSON.stringify(turnFlush.draws));
check('a draw and overcards add up', turnFlush.outs === 15, JSON.stringify(turnFlush.draws));

// ---- pot math -------------------------------------------------------------

const mathState = handState({
  players: [
    // handCommitted is what the engine's pot comes from: 100 each preflop, then
    // the opponent's 200 flop bet.
    { seat: 0, name: '英雄', cards: ['Ah', 'Kd'], handCommitted: 100, streetCommitted: 0, stack: 4900 },
    { seat: 1, name: '对手', cards: null, handCommitted: 300, streetCommitted: 200, stack: 4700 },
  ],
  board: ['Qh', '7h', '2c'],
  street: 'flop',
  currentBet: 200,
  bigBlind: 100,
  actionLog: [{ seat: 1, street: 'flop', action: 'bet', amount: 200, streetCommitted: 200, pot: 400 }],
});
const math = potMath(mathState, 0, legalActions(mathState));
check('the pot is what the seats have committed', potTotal(mathState) === 400, String(potTotal(mathState)));
check('pot odds are call over pot plus call', Math.abs(math.potOdds - 200 / (400 + 200)) < 1e-9, String(math.potOdds));
check('required equity equals pot odds', math.requiredEquity === math.potOdds, String(math.requiredEquity));
check('MDF is pot before the bet over pot plus bet', Math.abs(math.mdf - 200 / 400) < 1e-9, String(math.mdf));
check('SPR is effective stack over pot', Math.abs(math.spr - 4700 / 400) < 1e-9, String(math.spr));
check('the call amount comes from the legal menu', math.toCall === 200, String(math.toCall));

// ---- reading opponents ----------------------------------------------------

const reads = readOpponents(sixMax, 0);
const liveOpponents = sixMax.players.filter((player) => !player.isHuman && !player.folded && !player.out);
check('every live opponent gets a read', reads.length === liveOpponents.length, `${reads.length} reads for ${liveOpponents.length} live opponents`);
check('folded seats are not read', sixMax.players.some((player) => player.folded) ? reads.length < sixMax.players.length - 1 : true, String(reads.length));
check('every read has a usable range width', reads.every((read) => read.width >= 0.03 && read.width <= 0.9), JSON.stringify(reads.map((read) => read.width)));
const raiser = reads.find((read) => read.lines.some((line) => line.includes('主动加注')));
check('a preflop raise narrows the read', raiser === undefined || raiser.width <= 0.45, JSON.stringify(raiser && { name: raiser.name, width: raiser.width }));
check('a read never contains the opponent cards', JSON.stringify(reads).indexOf('"cards"') === -1, JSON.stringify(reads[0] ?? null).slice(0, 120));
const bigBetState = handState({
  players: [
    { seat: 0, name: '英雄', cards: ['Ah', 'Kd'], stack: 5000, streetCommitted: 0 },
    { seat: 1, name: '对手', cards: null, stack: 5000, streetCommitted: 500 },
  ],
  board: ['Qh', '7h', '2c'],
  street: 'flop',
  currentBet: 500,
  actionLog: [{ seat: 1, street: 'preflop', action: 'call', amount: 100, pot: 200 }, { seat: 1, street: 'flop', action: 'bet', amount: 500, pot: 700 }],
});
const bigBetRead = readOpponents(bigBetState, 0)[0];
check('a large bet narrows the range further than a call', bigBetRead.width <= 0.16, String(bigBetRead.width));
check('a large bet is described as polarised', bigBetRead.lines.join(' ').includes('两极化'), bigBetRead.lines.join(' | '));

// ---- equity against the read range ---------------------------------------

const equityState = handState({
  players: [
    { seat: 0, name: '英雄', cards: ['Ah', 'Jh'], stack: 5000, streetCommitted: 0 },
    { seat: 1, name: '对手', cards: null, stack: 5000, streetCommitted: 200 },
  ],
  board: ['Js', '7h', '2c'],
  street: 'flop',
  currentBet: 200,
  actionLog: [{ seat: 1, street: 'preflop', action: 'call', amount: 100, pot: 200 }, { seat: 1, street: 'flop', action: 'bet', amount: 200, pot: 400 }],
});
const wideRead = [{ seat: 1, name: '对手', style: '疯子（天天全下，惊吓专家）', aggression: 0.92, bluff: 0.4, width: 0.6, lines: [], allIn: false }];
const tightRead = [{ seat: 1, name: '对手', style: '岩石（只玩好牌，不乱来）', aggression: 0.22, bluff: 0.03, width: 0.06, lines: [], allIn: false }];
const vsWide = equityVsReads(equityState, 0, wideRead, 800);
const vsTight = equityVsReads(equityState, 0, tightRead, 800);
check('equity is a percentage with a stated error', vsWide.equity > 0 && vsWide.equity < 100 && vsWide.margin > 0, JSON.stringify(vsWide));
check('a tighter range means less equity for the same hand', vsTight.equity < vsWide.equity, `tight ${vsTight.equity} vs wide ${vsWide.equity}`);
check('the simulation honours the iteration count', vsWide.iterations === 800, String(vsWide.iterations));
const vsEmpty = equityVsReads(equityState, 0, [], 100);
check('a hand with no opponents wins the whole pot', vsEmpty.equity === 100, JSON.stringify(vsEmpty));

// ---- the whole payload ----------------------------------------------------

const hero = sixMax.players[0];
const coach = coachFor(sixMax, 0);
check('the coach builds sections for a live hand', coach && Array.isArray(coach.sections) && coach.sections.length >= 6, JSON.stringify(coach && coach.sections.map((section) => section.id)));
check('the sections cover the spot, the hand, the plan, the read and the math', ['spot', 'hand', 'plan', 'reads', 'math', 'lesson'].every((id) => coach.sections.some((section) => section.id === id)), JSON.stringify(coach.sections.map((section) => section.id)));
check('the plan comes before the reading', coach.sections.findIndex((section) => section.id === 'plan') < coach.sections.findIndex((section) => section.id === 'reads'), JSON.stringify(coach.sections.map((section) => section.id)));
check('every section has a title and content', coach.sections.every((section) => typeof section.title === 'string' && section.title.length > 0 && ((section.lines ?? []).length > 0 || (section.items ?? []).length > 0)), JSON.stringify(coach.sections.map((section) => section.id)));
check('the payload is serializable', JSON.stringify(coach).length > 200);
check('the brief names the position and the plan', coach.brief.includes('教练：') && coach.brief.includes('建议：'), coach.brief);
check('the math block carries the headline numbers', coach.math && typeof coach.math.potOdds === 'number' && typeof coach.math.spr === 'number', JSON.stringify(coach.math));

const opponentCards = sixMax.players.filter((player) => !player.isHuman).flatMap((player) => player.cards);
const serialized = JSON.stringify(coach);
check('the coach never leaks an opponent card', opponentCards.every((card) => !serialized.includes(card)), opponentCards.join(','));

const settled = table([{ name: 'a', style: 'tag' }, { name: 'b', style: 'lag' }], 999);
let played = settled;
let guard = 0;
while (played.phase === 'betting' && guard < 80) {
  guard += 1;
  const menu = legalActions(played);
  if (!menu) break;
  const action = menu.canCheck ? { action: 'check' } : menu.canCall ? { action: 'call' } : { action: 'fold' };
  played = advance(applyAction(played, { seat: 0, ...action }, decideBotAction), decideBotAction);
}
const settledCoach = coachFor(played, 0);
check('a settled hand reports the result instead of advice', played.phase !== 'betting' && settledCoach.sections.some((section) => section.id === 'plan' && section.title.includes('结果')), `${played.phase} :: ${settledCoach.sections.map((section) => section.title).join(' | ')}`);
check('the settled hand still teaches', settledCoach.sections.some((section) => section.id === 'lesson'), JSON.stringify(settledCoach.sections.map((section) => section.id)));

// Latency: the coach runs on every click, so it has to stay cheap. The measured
// cost is ~40ms on a six-handed flop; this ceiling only catches a real blow-up.
const timed = table(Array.from({ length: 5 }, (_, index) => ({ name: 'b' + index, style: 'mixed' === index ? 'tag' : 'tag' })), 31337);
const started = Date.now();
const timedCoach = coachFor(timed, 0);
const elapsed = Date.now() - started;
check('a coach computation stays under the click budget', elapsed < 500, `${elapsed}ms`);
check('the timed coach still produced a plan', timedCoach.sections.some((section) => section.id === 'plan'), JSON.stringify(timedCoach.sections.map((section) => section.id)));

// The coach is optional: the engine state itself must be untouched by it.
const before = JSON.stringify(sixMax);
coachFor(sixMax, 0);
check('coaching does not mutate the game state', JSON.stringify(sixMax) === before, 'state changed');

// ---- the recommendation, as data ------------------------------------------

// The complaint this guards: a raise button sitting in the action row must never
// read like advice. With the literal worst hand facing a 3-bet, the coach has to
// say fold - and say it as an action, not only in prose.
const threeBetState = handState({
  players: [
    { seat: 0, name: '玩家', cards: ['2d', '4d'], handCommitted: 100, streetCommitted: 100, stack: 12476 },
    { seat: 1, name: '老王', cards: null, folded: true, handCommitted: 50 },
    { seat: 2, name: '阿珍', cards: null, folded: true, handCommitted: 100 },
    { seat: 3, name: '石头', cards: null, handCommitted: 350, streetCommitted: 350, stack: 9600 },
    { seat: 4, name: '大熊', cards: null, folded: true, handCommitted: 0 },
    { seat: 5, name: '小美', cards: null, handCommitted: 1100, streetCommitted: 1100, stack: 7141, style: 'maniac' },
  ],
  street: 'preflop',
  currentBet: 1100,
  lastRaiseSize: 750,
  buttonSeat: 0,
  smallBlindSeat: 5,
  bigBlindSeat: 0,
  actionLog: [
    { seat: 5, street: 'preflop', action: 'call', amount: 50, streetCommitted: 50, pot: 50 },
    { seat: 0, street: 'preflop', action: 'call', amount: 100, streetCommitted: 100, pot: 150 },
    { seat: 1, street: 'preflop', action: 'fold', amount: 0, pot: 150 },
    { seat: 2, street: 'preflop', action: 'fold', amount: 0, pot: 150 },
    { seat: 3, street: 'preflop', action: 'raise', amount: 350, streetCommitted: 350, pot: 500 },
    { seat: 4, street: 'preflop', action: 'fold', amount: 0, pot: 500 },
    { seat: 5, street: 'preflop', action: 'raise', amount: 1100, streetCommitted: 1100, pot: 1600 },
  ],
});
const trashCoach = coachFor(threeBetState, 0);
check('the worst hand facing a 3-bet is told to fold', trashCoach.plan.action === 'fold' && trashCoach.plan.headline.includes('弃牌'), JSON.stringify(trashCoach.plan));
check('the fold is the coach\u2019s tone for a bad spot', trashCoach.plan.tone === 'bad', JSON.stringify(trashCoach.plan));
check('the read explains why the range is narrow', trashCoach.sections.find((section) => section.id === 'reads').items.some((item) => item.text.includes('再加注') || item.text.includes('3-bet')), JSON.stringify(trashCoach.sections.find((section) => section.id === 'reads').items));

// The other direction: the same spot with aces is a raise, not a fold.
const acesState = {
  ...threeBetState,
  players: threeBetState.players.map((player) => (player.seat === 0 ? { ...player, cards: ['As', 'Ad'] } : player)),
};
const acesCoach = coachFor(acesState, 0);
check('aces facing a 3-bet are told to raise', acesCoach.plan.action === 'raise' && /\u518d\u52a0\u6ce8|3-bet/.test(acesCoach.plan.headline), JSON.stringify(acesCoach.plan));
check('the two plans differ on the same board and pot', trashCoach.plan.action !== acesCoach.plan.action, `${trashCoach.plan.action} vs ${acesCoach.plan.action}`);

// The same rule postflop: a gutshot facing three quarters of the pot is a fold,
// and it has to come back as an ACTION so the table can mark the fold button.
const gutshotTurn = handState({
  players: [
    { seat: 0, name: '石头', cards: ['Jd', 'Td'], streetCommitted: 0, handCommitted: 2900, stack: 9850 },
    { seat: 1, name: '小美', cards: null, streetCommitted: 4550, handCommitted: 10450, stack: 7141, style: 'maniac' },
  ],
  board: ['5d', '2c', 'Kh', '9s'],
  street: 'turn',
  currentBet: 4550,
  lastRaiseSize: 2650,
  buttonSeat: 1,
  smallBlindSeat: 0,
  bigBlindSeat: 1,
  actionLog: [{ seat: 1, street: 'turn', action: 'bet', amount: 4550, streetCommitted: 4550, pot: 10450 }],
});
const gutshotCoach = coachFor(gutshotTurn, 0);
check('a gutshot facing a big turn bet is told to fold', gutshotCoach.plan.action === 'fold' && gutshotCoach.plan.headline.includes('弃牌'), JSON.stringify(gutshotCoach.plan));
check('the fold quotes the price and the equity', gutshotCoach.sections.some((section) => section.id === 'plan' && section.lines.some((line) => /跟注需要.*胜率/.test(line))), JSON.stringify(gutshotCoach.sections.find((section) => section.id === 'plan')));

// ── betting again is stronger evidence than betting once ───────────────────
//
// One bet can be a continuation bet with air; two streets in a row cannot. The
// read has to compound, and the equity the coach quotes has to follow it.

/** The same turn spot, with the opponent having fired the flop or not. */
function barrelState(withFlopBet) {
  const log = [];
  if (withFlopBet) log.push({ seat: 1, street: 'flop', action: 'bet', amount: 200, streetCommitted: 200, pot: 400 });
  log.push({ seat: 1, street: 'turn', action: 'bet', amount: 500, streetCommitted: 500, pot: 1200 });
  return handState({
    players: [
      { seat: 0, name: '玩家', cards: ['Ah', 'Qc'], handCommitted: 700, streetCommitted: 0, stack: 5000 },
      { seat: 1, name: '对手', cards: null, handCommitted: 700, streetCommitted: 500, stack: 5000, style: 'tag' },
    ],
    board: ['Kc', '7d', '2h', '9s'],
    street: 'turn',
    currentBet: 500,
    lastRaiseSize: 300,
    buttonSeat: 1,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    actionLog: log,
  });
}

const oneBetRead = readOpponents(barrelState(false), 0)[0];
const barrelRead = readOpponents(barrelState(true), 0)[0];
check('betting two streets narrows the range further than one', barrelRead.width < oneBetRead.width, `${barrelRead.width} vs ${oneBetRead.width}`);
check('the read names the barrel', barrelRead.lines.join(' ').includes('barrel'), barrelRead.lines.join(' | '));
const oneBetCoach = coachFor(barrelState(false), 0);
const barrelCoach = coachFor(barrelState(true), 0);
check(
  'the quoted equity drops against a barrelling range',
  barrelCoach.equity.equity + 1 < oneBetCoach.equity.equity,
  `barrel ${barrelCoach.equity.equity}% vs single ${oneBetCoach.equity.equity}%`,
);

// ---- the GTO layer --------------------------------------------------------

// The indifference arithmetic is the part a player can check by hand, so it has to be
// textbook: a pot-size bet means the caller needs 33%, the defender must continue 50%,
// and the bettor's range is 2:1 value:bluff.
const potBet = gto.indifference(100, 100);
check('a pot bet needs 33% to call', Math.abs(potBet.required - 1 / 3) < 0.001, String(potBet.required));
check('a pot bet means defending half the range', Math.abs(potBet.mdf - 0.5) < 0.001, String(potBet.mdf));
check('a pot bet is 2:1 value to bluff', Math.abs(potBet.bluffShare - 1 / 3) < 0.001, String(potBet.bluffShare));
check('alpha and MDF are complements', Math.abs(potBet.alpha + potBet.mdf - 1) < 0.001, `${potBet.alpha} + ${potBet.mdf}`);
const halfBet = gto.indifference(100, 50);
check('a half-pot bet needs 25% to call', Math.abs(halfBet.required - 0.25) < 0.001, String(halfBet.required));
check('a half-pot bet means defending two thirds', Math.abs(halfBet.mdf - 2 / 3) < 0.001, String(halfBet.mdf));
check('a half-pot bet bluffs a quarter of the time', Math.abs(halfBet.bluffShare - 0.25) < 0.001, String(halfBet.bluffShare));
check('a tiny bet is nearly free to call', gto.indifference(1000, 1).required < 0.002, String(gto.indifference(1000, 1).required));

// EV: folding is the zero, calling is equity x final pot minus the call, checking is
// equity x pot, and a bet trades the pot against equity when called.
const callEvs = gto.actionEvs({ pot: 100, toCall: 50, committed: 0, stack: 1000, equity: 0.5, foldEquity: 0.4, sizes: [] });
check('folding is the zero reference', callEvs.find((entry) => entry.action === 'fold').ev === 0,
  String(callEvs.find((entry) => entry.action === 'fold').ev));
check('a coin flip getting 2:1 calls',
  Math.abs(callEvs.find((entry) => entry.action === 'call').ev - (0.5 * 150 - 50)) < 0.001,
  String(callEvs.find((entry) => entry.action === 'call').ev));
const checkEvs = gto.actionEvs({ pot: 100, toCall: 0, committed: 0, stack: 1000, equity: 0.5, foldEquity: 0.4, sizes: [{ action: 'raise', amount: 50 }] });
check('checking through is worth equity x pot',
  Math.abs(checkEvs.find((entry) => entry.action === 'check').ev - 50) < 0.001,
  JSON.stringify(checkEvs.map((entry) => [entry.action, entry.ev])));
// A bet is worth: the pot when they fold, plus the called branch. The called branch prices a
// TIGHTER range (the caller is not calling with everything) and the pot they actually build.
check('a bet is worth fold equity plus the called branch', (() => {
  const risk = 50;
  const called = 100 + risk + 50; // pot + our risk + what they still owe
  const discount = 0.03 + 0.35 * (risk / 1000); // scaled by the share of the stack committed
  const value = (0.5 - discount) * called - risk;
  const expected = 0.4 * 100 + 0.6 * value;
  const actual = checkEvs.find((entry) => entry.action === 'raise').ev;
  return Math.abs(actual - expected) < 0.5;
})(), String(checkEvs.find((entry) => entry.action === 'raise').ev));
check('a raise prices the pot the caller actually builds', (() => {
  const evs = gto.actionEvs({ pot: 100, toCall: 100, committed: 0, stack: 1000, equity: 0.5, foldEquity: 0.5, sizes: [{ action: 'raise', amount: 250 }] });
  const note = evs.find((entry) => entry.action === 'raise').note;
  // 100 in the middle, we add 250, they add 150 to match: 500, not the 600 that
  // `pot + 2*risk` invented.
  return /500/.test(note) && !/600/.test(note);
})(), JSON.stringify(gto.actionEvs({ pot: 100, toCall: 100, committed: 0, stack: 1000, equity: 0.5, foldEquity: 0.5, sizes: [{ action: 'raise', amount: 250 }] })));
check('a raise over a bet gets less fold equity than a bet into checked players', (() => {
  const facing = gto.actionEvs({ pot: 100, toCall: 100, committed: 100, stack: 1000, equity: 0.5, foldEquity: 0.6, raiseFoldEquity: 0.3, sizes: [{ action: 'raise', amount: 300 }] });
  return /弃牌率 30%/.test(facing.find((entry) => entry.action === 'raise').note);
})(), 'the raise must use raiseFoldEquity');
check('zero fold equity makes a zero-equity bet lose its own size', (() => {
  const evs = gto.actionEvs({ pot: 100, toCall: 0, committed: 0, stack: 1000, equity: 0, foldEquity: 0, sizes: [{ action: 'raise', amount: 50 }] });
  return Math.abs(evs.find((entry) => entry.action === 'raise').ev + 50) < 0.001;
})(), 'a hopeless bet should cost exactly what it risks');
check('a bet beyond the stack is not priced', gto.actionEvs({
  pot: 100, toCall: 0, committed: 0, stack: 40, equity: 0.9, foldEquity: 0.5, sizes: [{ action: 'raise', amount: 500 }],
}).length === 1, 'an illegal size was priced');

// The mix is over LINES, not over four sizes of the same line.
const lineEvs = gto.actionEvs({ pot: 100, toCall: 0, committed: 0, stack: 1000, equity: 0.7, foldEquity: 0.5,
  sizes: [{ action: 'raise', amount: 33 }, { action: 'raise', amount: 50 }, { action: 'raise', amount: 75 }] });
const mixed = gto.mixFrom(gto.bestPerLine(lineEvs), 10);
check('the mix collapses sizes into lines',
  mixed.length === 2 && mixed.every((entry) => entry.line === 'bet' || entry.line === 'check'),
  JSON.stringify(mixed.map((entry) => [entry.line, entry.share])));
check('the mix sums to one', Math.abs(mixed.reduce((sum, entry) => sum + entry.share, 0) - 1) < 0.001,
  JSON.stringify(mixed.map((entry) => entry.share)));
check('the best line takes the bulk', mixed[0].share > 0.5, JSON.stringify(mixed.map((entry) => entry.share)));
check('a clear winner is not diluted', (() => {
  const wide = gto.mixFrom(gto.bestPerLine(gto.actionEvs({ pot: 100, toCall: 0, committed: 0, stack: 1000, equity: 0.99, foldEquity: 0.9,
    sizes: [{ action: 'raise', amount: 100 }] })), 5);
  return wide[0].share > 0.9;
})(), 'a strong line should dominate the mix');

// A per-opponent fold rate is not a take-down rate.
check('two opponents folding 60% each take it down 36%', Math.abs(coachModule.takeDownProbability(0.6, 2) - 0.36) < 0.001,
  String(coachModule.takeDownProbability(0.6, 2)));
check('one opponent folding 60% takes it down 60%', Math.abs(coachModule.takeDownProbability(0.6, 1) - 0.6) < 0.001,
  String(coachModule.takeDownProbability(0.6, 1)));
check('a five-way flop needs everyone to fold', coachModule.takeDownProbability(0.6, 5) < 0.1,
  String(coachModule.takeDownProbability(0.6, 5)));

// The roles, which is what turns "I have a pair" into "I am at the top of my range".
check('a set is a value hand', gto.handRole({ equity: 0.9, outs: 0, made: { label: '三条' } }).id === 'value');
check('a flush draw with 9 outs is a semi-bluff', gto.handRole({ equity: 0.35, outs: 9, made: { label: '高牌' } }).id === 'semibluff');
check('a mid pair facing a bet is a bluff-catcher', gto.handRole({ equity: 0.4, outs: 0, made: { label: '中对' }, facingBet: true }).id === 'bluffcatcher');
check('nothing is air', gto.handRole({ equity: 0.12, outs: 0, made: { label: '高牌' } }).id === 'air');

// The whole layer, on a real spot: the plan comes from the EV table, the sections carry
// the arithmetic, and the mode is reported so a surface can label itself.
const gtoSpot = handState({
  board: ['Kh', '5c', '9s'],
  street: 'flop',
  currentBet: 300,
  players: [
    { seat: 0, name: '玩家', cards: ['Ac', '8c'], streetCommitted: 100, handCommitted: 200, stack: 9000 },
    { seat: 1, name: '石头', style: 'tag', cards: ['Ks', 'Qd'], streetCommitted: 300, handCommitted: 400, stack: 9000 },
  ],
  actorSeat: 0,
});
const gtoCoach = coachFor(gtoSpot, 0, { mode: 'gto', iterations: 200 });
const simpleCoach = coachFor(gtoSpot, 0, { mode: 'simple', iterations: 200 });
check('the coach reports which mode produced it', gtoCoach.mode === 'gto' && simpleCoach.mode === 'simple',
  `${gtoCoach.mode} / ${simpleCoach.mode}`);
check('GTO mode adds its two sections',
  gtoCoach.sections.some((section) => section.id === 'gto') && gtoCoach.sections.some((section) => section.id === 'range'),
  gtoCoach.sections.map((section) => section.id).join(','));
check('simple mode does not', !simpleCoach.sections.some((section) => section.id === 'gto'),
  simpleCoach.sections.map((section) => section.id).join(','));
check('the GTO numbers travel as data',
  gtoCoach.gto && gtoCoach.gto.mode === 'gto' && Number.isFinite(gtoCoach.gto.mdf) && gtoCoach.gto.ev.length > 0,
  JSON.stringify(gtoCoach.gto && { mdf: gtoCoach.gto.mdf, ev: gtoCoach.gto.ev }));
check('the GTO plan is the max-EV line',
  gtoCoach.gto.ev.every((entry, index, list) => index === 0 || entry.ev <= list[0].ev),
  JSON.stringify(gtoCoach.gto.ev));
check('the maths section quotes the indifference numbers',
  gtoCoach.sections.find((section) => section.id === 'gto').lines.some((line) => /MDF|防线/.test(line)),
  gtoCoach.sections.find((section) => section.id === 'gto').lines.join(' | ').slice(0, 120));
check('the brief says it is the GTO coach', /GTO/.test(gtoCoach.brief), gtoCoach.brief.slice(0, 60));
check('the plan headline names a concrete line',
  typeof gtoCoach.plan.headline === 'string' && gtoCoach.plan.headline.length > 0, gtoCoach.plan.headline);
check('the plan carries the range role', gtoCoach.plan.role !== undefined && gtoCoach.plan.role !== null, String(gtoCoach.plan.role));

// Preflop gets the GTO layer too. Leaving it out was the bug a player hit: most decisions
// ARE preflop, so switching the style appeared to do nothing at all.
const preflopGto = coachFor(sixMax, 0, { mode: 'gto', iterations: 100 });
const preflopSimple = coachFor(sixMax, 0, { mode: 'simple', iterations: 100 });
check('preflop gets a GTO plan as well', preflopGto.mode === 'gto' && preflopGto.gto !== null,
  `${preflopGto.mode} / ${Boolean(preflopGto.gto)}`);
check('the preflop GTO plan is a different plan',
  preflopGto.plan.headline !== preflopSimple.plan.headline,
  `${preflopGto.plan.headline} vs ${preflopSimple.plan.headline}`);
check('the preflop GTO sections are there',
  preflopGto.sections.some((section) => section.id === 'gto') && preflopGto.sections.some((section) => section.id === 'range'),
  preflopGto.sections.map((section) => section.id).join(','));
check('the preflop numbers name the range position',
  preflopGto.gto.street === 'preflop' && Number.isFinite(preflopGto.gto.topShare) && typeof preflopGto.gto.role === 'string',
  JSON.stringify({ street: preflopGto.gto.street, top: preflopGto.gto.topShare, role: preflopGto.gto.role }));
check('preflop says there is no MDF to speak of',
  preflopGto.gto.mdf === null
    && preflopGto.sections.find((section) => section.id === 'gto').lines.some((line) => /MDF/.test(line)),
  JSON.stringify(preflopGto.gto.mdf));
check('the preflop EV table has lines to compare',
  preflopGto.gto.ev.length >= 2 && preflopGto.gto.ev.every((entry, index, list) => index === 0 || entry.ev <= list[0].ev),
  JSON.stringify(preflopGto.gto.ev));
const preflopMenu = { canRaise: true, canAllIn: true, toCall: 100, minRaiseTo: 200, maxRaiseTo: 10000 };
check('preflop sizes are quoted in big blinds, not pot fractions',
  gto.priceSizes(preflopMenu, 150, 100, 'preflop').some((entry) => entry.amount === 250)
    && gto.priceSizes(preflopMenu, 150, 100, 'preflop').some((entry) => entry.amount === 300),
  JSON.stringify(gto.priceSizes(preflopMenu, 150, 100, 'preflop')));
const flopMenu = { canRaise: true, canAllIn: false, toCall: 0, minRaiseTo: 50, maxRaiseTo: 10000 };
check('a postflop size menu is still pot-relative',
  gto.priceSizes(flopMenu, 400, 100, 'flop').some((entry) => entry.amount === 200),
  JSON.stringify(gto.priceSizes(flopMenu, 400, 100, 'flop')));

// The rules that keep the recommendation honest. These exist because the first version
// mixed a -40 line at 30% and folded hands the range opens - "the strategy has big
// problems", reported from the table.
const band = gto.equivalenceBand(150, 100);
check('the equivalence band is small', band <= 20 && band >= 9, String(band));
const losingLines = [
  { line: 'fold', action: 'fold', amount: 0, ev: 0 },
  { line: 'bet', action: 'raise', amount: 250, ev: -40 },
  { line: 'call', action: 'call', amount: 100, ev: -44 },
];
check('a clearly losing line is never recommended while folding is free',
  gto.pickLine(losingLines, { pot: 150, bigBlind: 100 }).line === 'fold',
  JSON.stringify(gto.pickLine(losingLines, { pot: 150, bigBlind: 100 })));
check('a line far outside the band is never given a share', (() => {
  const mixed = gto.mixFrom(losingLines, band);
  return mixed[0].share === 1 && mixed.slice(1).every((entry) => entry.share === 0);
})(), JSON.stringify(gto.mixFrom(losingLines, band).map((entry) => [entry.line, entry.share])));
const equivalentLines = [
  { line: 'fold', action: 'fold', amount: 0, ev: 0 },
  { line: 'bet', action: 'raise', amount: 250, ev: -5 },
];
check('the range plan breaks a genuine tie', (() => {
  const chosen = gto.pickLine(equivalentLines, { pot: 150, bigBlind: 100, preferred: 'bet' });
  return chosen.line === 'bet';
})(), JSON.stringify(gto.pickLine(equivalentLines, { pot: 150, bigBlind: 100, preferred: 'bet' })));
check('without a preference the tie still folds', (() => {
  const chosen = gto.pickLine(equivalentLines, { pot: 150, bigBlind: 100, preferred: null });
  return chosen.line === 'fold';
})(), JSON.stringify(gto.pickLine(equivalentLines, { pot: 150, bigBlind: 100, preferred: null })));
check('a tie-break is presented as one plan, not a fake mix', (() => {
  const mixed = gto.mixFrom(equivalentLines, band);
  const chosen = gto.pickLine(mixed, { pot: 150, bigBlind: 100, preferred: 'bet' });
  const shown = gto.presentMix(mixed, chosen, true);
  return shown[0].line === 'bet' && shown[0].share === 1 && shown[1].share === 0;
})(), JSON.stringify(gto.presentMix(gto.mixFrom(equivalentLines, band), equivalentLines[0], true)));
check('a real mix keeps its shares and leads with the choice', (() => {
  const mixed = gto.mixFrom(equivalentLines, band);
  const shown = gto.presentMix(mixed, mixed[0], false);
  return Math.abs(shown.reduce((sum, entry) => sum + entry.share, 0) - 1) < 0.001;
})(), JSON.stringify(gto.presentMix(gto.mixFrom(equivalentLines, band), equivalentLines[0], false)));

// End to end: a hand the range opens must be opened, not folded, even when the one-street
// EV calls it a coin flip. This is the exact case a player reported.
const buttonTop21 = handState({
  street: 'preflop',
  currentBet: 100,
  players: [
    { seat: 0, name: '玩家', cards: ['Qd', '9d'], streetCommitted: 0, handCommitted: 0, stack: 10000 },
    { seat: 1, name: '大盲', style: 'tag', cards: ['??', '??'], streetCommitted: 100, handCommitted: 100, stack: 9900 },
  ],
  actorSeat: 0,
  buttonSeat: 0,
  smallBlindSeat: 0,
  bigBlindSeat: 1,
});
const buttonCoach = coachFor(buttonTop21, 0, { mode: 'gto', iterations: 200 });
check('a playable hand on the button is opened, not folded',
  buttonCoach.gto && buttonCoach.gto.role !== 'trash' && /开池|下注到|\u52a0\u6ce8/.test(buttonCoach.plan.headline),
  `${buttonCoach.plan.headline} | top${buttonCoach.gto && buttonCoach.gto.topShare} | ${buttonCoach.gto && buttonCoach.gto.role}`);
check('only EV-equivalent lines get a share of the mix',
  buttonCoach.gto.ev.every((entry, index, list) => entry.share === 0 || list[0].ev - entry.ev <= gto.equivalenceBand(150, 100)),
  JSON.stringify(buttonCoach.gto.ev));

// The screenshot case: two pair facing a huge shove. The coach recommended a 208BB re-raise
// because it priced the raise with the table's fold-to-a-bet rate - against a player who is
// already all-in and cannot fold. There is no raise here, only call or fold.
const facingShove = handState({
  board: ['Jd', 'Th', 'Tc', '7d'],
  street: 'turn',
  currentBet: 20600,
  lastRaiseSize: 18200,
  bigBlind: 1200,
  smallBlind: 600,
  players: [
    { seat: 0, name: '玩家', cards: ['Kc', 'Jh'], streetCommitted: 2400, handCommitted: 10400, stack: 18450 },
    { seat: 1, name: '石头', style: 'rock', cards: ['??', '??'], streetCommitted: 20600, handCommitted: 20600, stack: 0, allIn: true },
  ],
  actorSeat: 0,
});
const shoveCoach = coachFor(facingShove, 0, { mode: 'gto', iterations: 300 });
check('an all-in opponent leaves only call or fold',
  shoveCoach.gto.ev.length === 2
    && shoveCoach.gto.ev.every((entry) => entry.action === 'call' || entry.action === 'fold'),
  JSON.stringify(shoveCoach.gto.ev));
check('the recommendation is not a raise', !/加注|下注|全下/.test(shoveCoach.plan.headline),
  shoveCoach.plan.headline);
check('the fold equity is zero against an all-in', shoveCoach.gto.foldEquity === 0, String(shoveCoach.gto.foldEquity));
check('the section explains why there is no raise',
  shoveCoach.sections.find((section) => section.id === 'gto').lines.some((line) => /只有跟或弃/.test(line)),
  shoveCoach.sections.find((section) => section.id === 'gto').lines.join(' | ').slice(-160));
// Required equity for a call is bet / (pot + 2 x bet), where the pot is what the hand has
// put in so far (10,400 + 20,600 here), not the rounded figure the panel shows.
check('the call is priced against the shove',
  shoveCoach.gto.required !== null && Math.abs(shoveCoach.gto.required - 18200 / (31000 + 2 * 18200)) < 0.01,
  `${shoveCoach.gto.required} vs ${18200 / (31000 + 2 * 18200)}`);

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} coach checks passed`);
}
