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

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} coach checks passed`);
}
