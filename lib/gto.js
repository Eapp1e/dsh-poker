/**
 * GTO-style coaching: the same spot, reasoned in ranges, indifference points and EV
 * instead of rules of thumb.
 *
 * What this is: the textbook layer that IS computable from one decision - pot odds and
 * required equity, the defender's minimum defence frequency, the bettor's alpha, the
 * value:bluff ratio each sizing implies, the EV of every legal action against the
 * range the opponents' actions actually imply, and the mixed frequency those EVs
 * suggest. What this is NOT: a Nash solver. A real solve needs the whole game tree and
 * a river-by-river range model; this is the arithmetic any player can check by hand,
 * applied to the ranges the coach already narrows - which is exactly what "GTO style"
 * means at the table.
 * @module dsh-plugin-poker/gto
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pct = (value) => `${Math.round(value)}%`;
const money = (amount, bigBlind) => `${Math.round(amount).toLocaleString('en-US')} (${Math.round((amount / bigBlind) * 10) / 10}BB)`;

/**
 * The indifference numbers for one bet size.
 *
 * With a pot `P` and a bet `B`:
 * - the caller risks `B` to win `P + B`, so they need `B / (P + 2B)` equity;
 * - the defender must continue `P / (P + B)` of the time (MDF) or a zero-equity bluff
 *   profits;
 * - the bettor's alpha is the fold frequency that makes the bluff break even, and the
 *   balanced bluff share of their betting range is `B / (P + 2B)` (a pot bet is 2:1
 *   value:bluff).
 * @param pot - the pot before the bet.
 * @param bet - the bet size.
 * @returns `{ mdf, alpha, required, bluffShare }`, each 0..1.
 */
export function indifference(pot, bet) {
  const size = Math.max(0, bet);
  const withBet = pot + size;
  return {
    mdf: withBet > 0 ? pot / withBet : 1,
    alpha: withBet > 0 ? size / withBet : 0,
    required: pot + 2 * size > 0 ? size / (pot + 2 * size) : 0,
    bluffShare: pot + 2 * size > 0 ? size / (pot + 2 * size) : 0,
  };
}

/**
 * Which job the hand does in a GTO plan.
 *
 * The plan is built per bucket, not per hand: value hands bet and raise, bluff-catchers
 * call a limited number of streets, semi-bluffs use equity plus fold equity, air gives
 * up. Naming the bucket is what turns "I have a pair" into "I am at the top of my
 * checking range".
 * @param input - `{ equity, outs, category, made, facingBet }` (equity 0..1).
 * @returns `{ id, label, note }`.
 */
export function handRole(input) {
  const equity = clamp(Number(input.equity) || 0, 0, 1);
  const outs = Number(input.outs) || 0;
  const made = input.made || {};
  const label = String(made.label || '');
  const strong = /三条|两对|顺子|同花|葫芦|四条|同花顺/.test(label);
  const pair = /对/.test(label);
  if (strong || equity >= 0.62) {
    return {
      id: 'value',
      label: '\u4ef7\u503c\u724c\uff08value\uff09',
      note: '\u6392\u5728\u8303\u56f4\u9876\u90e8\uff1a\u76ee\u6807\u662f\u628a\u94b1\u653e\u8fdb\u53bb\uff0c\u800c\u4e0d\u662f\u63a7\u6c60\u3002',
    };
  }
  if (outs >= 4 && equity >= 0.28 && equity < 0.5) {
    return {
      id: 'semibluff',
      label: '\u542c\u724c\uff08semi-bluff\uff09',
      note: '\u8d62\u7387\u4e0d\u591f\u5355\u72ec\u8ddf\uff0c\u4f46\u542c\u724c + \u5f03\u724c\u7387\u624d\u662f\u5b83\u7684\u4ef7\u503c\uff1a\u9002\u5408\u4e3b\u52a8\u4e0b\u6ce8\u3002',
    };
  }
  if (pair && equity >= 0.3) {
    return {
      id: 'bluffcatcher',
      label: '\u644a\u724c\u4ef7\u503c / \u6355\u8bc8\u724c\uff08bluff-catcher\uff09',
      note: input.facingBet
        ? '\u80fd\u8d62\u8bc8\u724c\u3001\u8f93\u7ed9\u4ef7\u503c\u724c\uff1a\u53ea\u503c\u5f97\u8ddf\u6709\u9650\u51e0\u6761\u8857\u3002'
        : '\u6709\u644a\u724c\u4ef7\u503c\u4f46\u4e0d\u503c\u5f97\u505a\u5927\u5e95\u6c60\uff1a\u63a7\u6c60\u4e0e\u5c0f\u6ce8\u6df7\u7528\u3002',
    };
  }
  if (equity < 0.3) {
    return {
      id: 'air',
      label: '\u7a7a\u6c14\uff08air\uff09',
      note: '\u6ca1\u6709\u644a\u724c\u4ef7\u503c\uff1a\u8981\u4e48\u5f53\u8bc8\u724c\u6253\uff0c\u8981\u4e48\u76f4\u63a5\u653e\u5f03\uff0c\u4e0d\u8981\u7528\u5b83\u53bb\u6355\u8bc8\u3002',
    };
  }
  return {
    id: 'marginal',
    label: '\u8fb9\u7f18\u724c\uff08marginal\uff09',
    note: '\u8d62\u5f97\u4e0d\u591a\u3001\u8f93\u5f97\u4e0d\u5c11\uff1a\u5c0f\u6ce8\u63a7\u6c60\uff0c\u9762\u5bf9\u5927\u6ce8\u5b81\u53ef\u5f03\u724c\u3002',
  };
}

/**
 * The EV of every action the seat can take, in chips, with folding as 0.
 *
 * These are one-street EVs: no future streets are modelled, the opponents' calling is
 * estimated from what the table has actually been doing (their observed fold-to-bet
 * rate, falling back to the indifferent frequency), and a raise is priced as a bet of
 * the same size. That is the honest limit of a spot calculation - and it is still
 * enough to see why two actions are close, which is what a mixed strategy IS.
 * @param input - `{ pot, toCall, committed, stack, equity, foldEquity, sizes }`.
 * @returns `[{ action, amount, ev, note }]`, best first.
 */
export function actionEvs(input) {
  const pot = Math.max(0, input.pot);
  const toCall = Math.max(0, input.toCall);
  const equity = clamp(Number(input.equity) || 0, 0, 1);
  const foldEquity = clamp(Number(input.foldEquity) || 0, 0, 1);
  // Raising over a bet gets folds far less often than betting into checked players: the
  // bettor has already put money in. Using one number for both made an all-in re-raise
  // look like a 45% chance of taking the pot, which is how the coach ended up advising a
  // 208BB shove over somebody's shove.
  const raiseFoldEquity = clamp(Number(input.raiseFoldEquity ?? input.foldEquity) || 0, 0, 1);
  const committed = Math.max(0, input.committed || 0);
  const stack = Math.max(0, input.stack || 0);
  const out = [];
  const callEv = equity * (pot + toCall) - toCall;
  const checkEv = equity * pot;
  if (toCall > 0) {
    out.push({ action: 'fold', amount: 0, ev: 0, note: '\u653e\u5f03\uff0c\u4e0d\u518d\u6295\u5165\uff08\u4f5c\u4e3a 0 \u57fa\u51c6\uff09' });
    out.push({
      action: 'call',
      amount: toCall,
      ev: callEv,
      note: `${pct(equity * 100)} \u00d7 \u6700\u7ec8\u5e95\u6c60 ${Math.round(pot + toCall)} \u2212 \u8ddf\u6ce8 ${Math.round(toCall)}`,
    });
  } else {
    out.push({
      action: 'check',
      amount: 0,
      ev: checkEv,
      note: `${pct(equity * 100)} \u00d7 \u5f53\u524d\u5e95\u6c60 ${Math.round(pot)}\uff08\u8fc7\u724c\u5230\u6cb3\u724c\u7684\u7c97\u7b97\uff09`,
    });
  }
  for (const size of input.sizes || []) {
    const target = size.amount;
    const risk = Math.max(0, target - committed);
    if (risk <= 0 || target > committed + stack) continue;
    // What the pot becomes if they call. `pot + 2 * risk` is only right when the opponent
    // still owes our whole raise: with 100 already in the middle and a raise TO 250 they
    // add 150, not 250, so the old formula invented 100 chips of extra pot on every raise.
    const opponentIn = committed + toCall;
    const called = pot + risk + Math.max(0, target - opponentIn);
    // When called, we are up against a STRONGER range than the one we priced our equity
    // against, and how much stronger depends on how much of the STACK the bet commits: a
    // 2.5BB open is called by almost everything, a 200BB shove only by the top of the range.
    // Scaling this by the pot ratio instead punished standard preflop opens (2.5BB into a
    // limped 1BB pot is "2.5x pot") with the same discount as a shove.
    const commitment = risk / Math.max(1, stack + committed);
    const discount = clamp(0.03 + 0.35 * commitment, 0.03, 0.3);
    // No floor above zero: a hopeless bet has to cost exactly what it risks, and a 2% floor
    // made it lose two chips less than its own size.
    const calledEquity = clamp(equity - discount, 0, 0.98);
    const value = calledEquity * called - risk;
    const fe = toCall > 0 ? raiseFoldEquity : foldEquity;
    const ev = fe * pot + (1 - fe) * value;
    out.push({
      action: size.action || 'bet',
      amount: target,
      ev,
      note: `\u5f03\u724c\u7387 ${pct(fe * 100)} \u00d7 ${Math.round(pot)} + ${pct((1 - fe) * 100)} \u00d7 (${pct(calledEquity * 100)} \u00d7 ${Math.round(called)} \u2212 ${Math.round(risk)})\uff08\u88ab\u8ddf\u540e\u80dc\u7387\u6309 ${pct(discount * 100)} \u6298\u7b97\uff09`,
    });
  }
  return out.sort((a, b) => b.ev - a.ev);
}

/**
 * Collapse the priced actions into LINES, then mix those.
 *
 * A mixed strategy is a frequency over lines - bet, check, call, raise, fold - not over
 * four sizes of the same line: "bet 54% / bet 34% / bet 11%" is not a strategy, it is
 * one action written three times. The best size within each family is the one that
 * carries it.
 * @param evs - the output of {@link actionEvs}.
 * @returns `[{ line, action, amount, ev }]`, best first.
 */
export function bestPerLine(evs) {
  const lines = new Map();
  for (const entry of evs) {
    const line = entry.action === 'raise' || entry.action === 'bet'
      ? (entry.amount > 0 ? 'bet' : 'check')
      : entry.action === 'allin'
        ? 'bet'
        : entry.action;
    const current = lines.get(line);
    if (!current || entry.ev > current.ev) lines.set(line, { ...entry, line });
  }
  return [...lines.values()].sort((a, b) => b.ev - a.ev);
}

/**
 * Turn line EVs into frequencies.
 *
 * Only lines within `band` of the best earn a share at all, and the band is small - a
 * fraction of the pot, not a multiple of the big blind. The first version used 3BB, which
 * on a 1.5BB pot meant a line losing 40 chips still got 30% of the range: a "mixed
 * strategy" recommending a worse hand 30% of the time is not a mix, it is a bug.
 * @param evs - the output of {@link bestPerLine}.
 * @param band - how close (in chips) a line has to be to earn a share.
 * @returns `[{ action, amount, ev, line, share }]`, best first, shares summing to 1.
 */
export function mixFrom(evs, band) {
  if (evs.length === 0) return [];
  const best = evs[0].ev;
  const width = Math.max(1, Number(band) || 1);
  const weights = evs.map((entry) => {
    const closeness = clamp(1 - (best - entry.ev) / width, 0, 1);
    return closeness > 0 ? closeness ** 2 : 0;
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return evs.map((entry, index) => ({ ...entry, share: weights[index] / total }));
}

/**
 * The band inside which two lines count as equivalent, in chips.
 *
 * Deliberately small - a sixteenth of the pot, floored at a fifth of a big blind. Anything
 * wider turns clear mistakes into "mixed strategies": at half a big blind, a hand that was
 * 27 chips (0.27BB) better than folding still got a 17% folding share, which reads as
 * advice to fold a hand that should plainly be raised.
 */
export function equivalenceBand(pot, bigBlind) {
  return Math.max(pot * 0.06, bigBlind * 0.2);
}

/**
 * Present the mix in the order it should be read, and stop pretending there is one when
 * the choice was a tie-break.
 *
 * A headline that says "开池" above a list reading "弃牌 60% / 开池 31%" contradicts
 * itself. Either the EVs genuinely differ (then the chosen line leads the list and the
 * shares are the model's closeness), or the choice came from the range plan (then it is
 * one plan, not a mix).
 * @param mixed - the output of {@link mixFrom}.
 * @param chosen - the entry {@link pickLine} returned.
 * @param tieBreak - true when the range plan overrode the EV order.
 * @returns the reordered entries.
 */
export function presentMix(mixed, chosen, tieBreak) {
  if (!chosen) return mixed;
  const ordered = [chosen, ...mixed.filter((entry) => entry !== chosen)];
  if (!tieBreak) return ordered;
  return ordered.map((entry, index) => ({ ...entry, share: index === 0 ? 1 : 0 }));
}

/**
 * Pick the line to recommend from the EV table.
 *
 * Three rules, in order:
 * 1. **Among EV-equivalent lines, prefer the one the range plan wants.** A one-street EV
 *    cannot see the postflop value of position, so on its own it folds hands that the
 *    positional range opens - exactly the "the strategy has big problems" report. The
 *    policy's action is the tie-break; the EV table stays as the reason.
 * 2. **Never recommend a line that clearly loses when folding is free.** "Clearly" is the
 *    same equivalence band: a line 40 chips behind a free fold is not a mix, it is a bug.
 * 3. Otherwise the best EV wins.
 * @param mixed - the output of {@link mixFrom}.
 * @param context - `{ pot, bigBlind, preferred }` where `preferred` is a LINE name.
 * @returns the chosen entry, or null.
 */
export function pickLine(mixed, context) {
  const best = mixed[0] ?? null;
  if (!best) return null;
  const band = equivalenceBand(context.pot, context.bigBlind);
  const equivalents = mixed.filter((entry) => best.ev - entry.ev <= band);
  if (context.preferred) {
    const match = equivalents.find((entry) => entry.line === context.preferred);
    if (match) return match;
  }
  if (best.ev <= 0) {
    const fold = mixed.find((entry) => entry.line === 'fold');
    if (fold) return fold;
  }
  return best;
}

/**
 * The preflop half of the GTO layer.
 *
 * Preflop has no board, so there are no made hands, no draws and no MDF - but it has
 * everything else this layer is about: a range (the hero's hand sits in the top X% of
 * starting hands), a price (the blinds against the raise), and an EV for every line.
 * Leaving it out was a mistake worth naming: most decisions ARE preflop, so a player who
 * switched the style saw the analysis not change at all.
 * @param context - the coach context.
 * @returns `{ plan, sections, brief, numbers }`.
 */
function gtoPreflop(context) {
  const { math, board, bigBlind, legal, facingBet, behind, position, street } = context;
  const equity = context.vsReads ? context.vsReads.equity / 100 : null;
  const pot = math.pot;
  const toCall = legal ? legal.toCall : math.toCall;
  const committed = context.committed ?? 0;
  const stack = context.stack ?? math.effective;
  const topShare = Number(context.topShare) || 100;
  const sizes = legal ? context.sizes || [] : [];
  // Preflop fold equity is "everyone folds to the raise", and the tally can tell us how
  // often that happens: the all-streets counters minus the postflop ones. Zero is a real
  // value here (everybody who could call is already all-in).
  const foldEquity = clamp(Number(context.foldEquity ?? 0.45), 0, 0.95);
  const evs = equity === null ? [] : actionEvs({
    pot, toCall, committed, stack, equity, foldEquity, raiseFoldEquity: context.raiseFoldEquity, sizes,
  });
  const mixed = mixFrom(bestPerLine(evs), equivalenceBand(pot, bigBlind));
  // Preflop is where the one-street model is weakest (it cannot see the postflop value of
  // position), so there the range plan breaks ties between equivalent lines.
  const best = pickLine(mixed, { pot, bigBlind, preferred: context.preferredLine });
  const tieBreak = best !== null && mixed[0] !== best;
  const shown = presentMix(mixed, best, tieBreak);
  const indiff = toCall > 0 ? indifference(pot, toCall) : null;
  const role = topShare <= 3
    ? { id: 'value', label: '\u9876\u7ea7\u8303\u56f4\uff08\u524d 3%\uff09', note: '\u8fd9\u91cc\u7684\u76ee\u6807\u662f\u628a\u94b1\u653e\u8fdb\u53bb\uff1a\u52a0\u6ce8\u3001\u751a\u81f3\u6b22\u8fce\u5168\u4e0b\u3002' }
    : topShare <= 10
      ? { id: 'strong', label: '\u5f3a\u724c\uff08\u524d 10%\uff09', note: '\u4e3b\u52a8\u5f00\u6c60\u6216 3-bet\uff0c\u4f46\u9762\u5bf9\u66f4\u5f3a\u7684\u52a8\u4f5c\u8981\u80fd\u653e\u5f97\u4e0b\u3002' }
      : topShare <= 25
        ? { id: 'playable', label: '\u53ef\u73a9\u724c\uff08\u524d 25%\uff09', note: '\u4f4d\u7f6e\u597d\u5c31\u8fdb\uff0c\u4f4d\u7f6e\u5dee\u5c31\u5f03\uff1a\u5b83\u7684\u4ef7\u503c\u6765\u81ea\u4f4d\u7f6e\u548c\u8fde\u63a5\u6027\uff0c\u4e0d\u662f\u672c\u8eab\u7684\u724c\u529b\u3002' }
        : topShare <= 45
          ? { id: 'speculative', label: '\u8fb9\u7f18\u724c\uff08\u524d 45%\uff09', note: '\u53ea\u5728\u4fbf\u5b9c\u3001\u4f4d\u7f6e\u597d\u3001\u80fd\u770b\u7ffb\u724c\u65f6\u624d\u503c\u5f97\u3002' }
          : { id: 'trash', label: '\u5783\u573e\u724c', note: '\u9664\u975e\u514d\u8d39\u770b\u724c\uff0c\u5426\u5219\u76f4\u63a5\u5f03\u6389\u3002' };
  const sections = [];

  const lines = [
    `\u8fd9\u624b\u724c\u5728\u8d77\u624b\u724c\u91cc\u6392\u5728\u524d ${topShare}%\uff08\u8f6e\u5230\u4f60\u65f6\u8eab\u540e\u8fd8\u6709 ${behind} \u4eba\uff09\u3002`,
  ];
  if (indiff) {
    lines.push(`\u8ddf\u6ce8 ${money(toCall, bigBlind)} \u9700\u8981 ${pct(indiff.required * 100)} \u80dc\u7387\uff08\u5bf9\u6297\u4ed6\u4eec\u7684\u8303\u56f4\u4f60\u6709 ${equity === null ? '\u2014' : pct(equity * 100)}\uff09\u3002`);
    lines.push('\u7ffb\u524d\u6ca1\u6709 MDF \u53ef\u8a00\uff1a\u90a3\u662f\u7ffb\u540e\u9632\u5fa1\u4e0b\u6ce8\u7684\u6982\u5ff5\uff0c\u7ffb\u524d\u53ea\u6709\u201c\u8fd9\u624b\u724c\u5728\u8303\u56f4\u91cc\u6392\u591a\u9ad8\u201d\u4e0e\u201c\u4ef7\u683c\u503c\u4e0d\u503c\u201d\u3002');
  } else {
    lines.push(`\u65e0\u4eba\u52a0\u6ce8\uff1a\u4f60\u53ef\u4ee5\u514d\u8d39\u770b\u724c\uff0c\u4e5f\u53ef\u4ee5\u4e3b\u52a8\u5f00\u6c60\u53bb\u62a2\u76f2\u6ce8\uff08\u5f03\u724c\u7387 ${pct(foldEquity * 100)}\uff09\u3002`);
  }
  lines.push(`\u5e95\u6c60 ${money(pot, bigBlind)}\uff0c\u6709\u6548\u7b79\u7801 ${money(math.effective, bigBlind)}\uff0cSPR ${Math.round(math.spr * 10) / 10}\u3002`);
  sections.push({
    id: 'gto',
    icon: '\u265f',
    title: 'GTO \u6570\u5b66\uff1a\u8303\u56f4\u4e0e EV',
    lines,
    items: shown.slice(0, 4).map((entry) => ({
      label: `${lineLabel(entry.line)} ${entry.amount > 0 ? money(entry.amount, bigBlind) : ''}`.trim(),
      text: `EV ${entry.ev >= 0 ? '+' : ''}${Math.round(entry.ev)}\uff08\u5360\u6bd4 ${pct(entry.share * 100)}\uff09\uff1a${entry.note}`,
    })),
  });

  const rangeLines = [
    `\u8fd9\u624b\u724c\u5728\u8ba1\u5212\u91cc\u5c5e\u4e8e\uff1a**${role.label}**\u3002${role.note}`,
    equity === null
      ? '\u6ca1\u6709\u53ef\u8bfb\u7684\u5bf9\u624b\uff0c\u8303\u56f4\u65e0\u6cd5\u6536\u7a84\u3002'
      : `\u628a\u4ed6\u4eec\u7684\u52a8\u4f5c\u6536\u7a84\u6210\u8303\u56f4\u540e\uff0c\u4f60\u7ea6 ${pct(equity * 100)} \u80dc\u7387\uff08\u6a21\u62df\u8bef\u5dee \u00b1${context.vsReads.margin}%\uff09\u3002`,
  ];
  if (shown.length > 1) {
    const gap = mixed[0].ev - mixed[1].ev;
    const band = equivalenceBand(pot, bigBlind);
    rangeLines.push(tieBreak
      ? `两条线的 EV 只差 ${Math.round(gap)} 筹码（在噪声范围内），所以按**范围**选：${lineLabel(best.line)}（翻前的单街 EV 看不到翻后位置的价值，这一步交给范围）。`
      : gap <= band
        ? `理论上接近混合：**${shown.map((entry) => `${lineLabel(entry.line)} ${pct(entry.share * 100)}`).join(' / ')}**（EV 差距 ${Math.round(gap)} 筹码）。`
        : `最优线比第二条线多 ${Math.round(gap)} 筹码，所以这里不需要混合。`);
  }
  sections.push({ id: 'range', icon: '\u{1F9E9}', title: '\u8303\u56f4\u4e0e\u89d2\u8272', lines: rangeLines });

  const headline = best
    ? `${planVerb(best)}${best.amount > 0 ? ` ${money(best.amount, bigBlind)}` : ''}\uff08EV ${best.ev >= 0 ? '+' : ''}${Math.round(best.ev)}\uff09`
    : '\u6682\u65f6\u6ca1\u6709\u53ef\u7528\u7684\u6a21\u62df\u6570\u636e';
  const reasons = [
    `\u8fd9\u624b\u724c\u5728\u8d77\u624b\u724c\u91cc\u6392\u524d ${topShare}%\uff08${role.label}\uff09\uff0c\u8eab\u540e ${behind} \u4eba\u3002`,
  ];
  if (indiff && equity !== null) {
    reasons.push(`\u8ddf\u6ce8\u9700 ${pct(indiff.required * 100)}\uff0c\u4f60\u6709 ${pct(equity * 100)}\uff1a${equity >= indiff.required ? '\u4ef7\u683c\u5408\u9002' : '\u4ef7\u683c\u4e0d\u5408\u9002\u3002'}`);
  } else if (equity !== null) {
    reasons.push(`\u62a2\u76f2\u6ce8\u9700\u8981\u4ed6\u4eec\u90fd\u5f03\u724c\uff08\u4f30\u8ba1 ${pct(foldEquity * 100)}\uff09\uff0c\u88ab\u8ddf\u4e0a\u540e\u4f60\u6709 ${pct(equity * 100)} \u80dc\u7387\u3002`);
  }
  const risks = [];
  if (math.commitShare > 0.25) risks.push(`\u4f60\u5df2\u6295\u5165 ${pct(math.commitShare * 100)} \u7b79\u7801\uff1a\u6c89\u6ca1\u6210\u672c\u4e0d\u7b97\u8fdb EV\u3002`);
  if (behind >= 4) risks.push('\u8eab\u540e\u8fd8\u6709 4 \u4eba\u4ee5\u4e0a\uff1a\u5f00\u6c60\u88ab 3-bet \u7684\u6982\u7387\u4e0d\u4f4e\u3002');

  return {
    plan: {
      headline,
      action: best ? best.action : null,
      tone: equity === null ? 'info' : best && best.ev > 0 ? 'good' : best && best.action === 'fold' ? 'bad' : 'warn',
      reasons,
      risks,
      tags: [role.label, 'GTO', position],
      role: role.id,
    },
    sections,
    brief: [
      `GTO 教练：${position}｜${madeLabelOf(context)}｜${role.label}`,
      equity === null ? '' : `对抗范围 ${pct(equity * 100)} 胜率（±${context.vsReads.margin}%）${indiff ? `，跟注需 ${pct(indiff.required * 100)}` : ''}。`,
      best ? `最佳 EV：${planVerb(best)}${best.amount > 0 ? ` ${money(best.amount, bigBlind)}` : ''}（EV ${best.ev >= 0 ? '+' : ''}${Math.round(best.ev)}）。` : '',
    ].filter(Boolean).join('\n'),
    numbers: {
      mode: 'gto',
      street,
      role: role.id,
      topShare,
      mdf: null,
      alpha: indiff ? indiff.alpha : null,
      required: indiff ? indiff.required : null,
      equity: equity === null ? null : equity,
      foldEquity,
      ev: shown.map((entry) => ({ action: entry.action, amount: entry.amount, ev: Math.round(entry.ev), share: Math.round(entry.share * 1000) / 1000 })),
    },
  };
}

/** The made-hand label, which preflop is just the hand class. */
function madeLabelOf(context) {
  return (context.made && context.made.label) || '\u8d77\u624b\u724c';
}

/** Does this spot have a board to price? */
const hasBoard = (context) => Array.isArray(context.board) && context.board.length >= 3;

/**
 * Build the GTO-flavoured plan and the two sections that carry the numbers.
 *
 * @param context - the same context `planFor` receives in `coach.js`, plus
 *   `{ foldEquity, sizes }`.
 * @returns `{ plan, sections, brief, numbers }`.
 */
export function gtoCoaching(context) {
  if (!hasBoard(context)) return gtoPreflop(context);
  const { math, made, draw, board, street, bigBlind, legal, facingBet, behind, position } = context;
  const equity = context.vsReads ? context.vsReads.equity / 100 : null;
  const pot = math.pot;
  const toCall = legal ? legal.toCall : math.toCall;
  const committed = context.committed ?? 0;
  const stack = context.stack ?? math.effective;
  const role = handRole({ equity, outs: draw.outs, made, facingBet });
  // Zero is a legitimate value (everybody who could call is already all-in), so the floor
  // has to allow it.
  const foldEquity = clamp(Number(context.foldEquity ?? 0.45), 0, 0.95);
  const sizes = legal ? context.sizes || [] : [];
  const evs = equity === null ? [] : actionEvs({
    pot, toCall, committed, stack, equity, foldEquity, raiseFoldEquity: context.raiseFoldEquity, sizes,
  });
  const mixed = mixFrom(bestPerLine(evs), equivalenceBand(pot, bigBlind));
  // Postflop the EV table is the layer's strength, so it picks; the guard inside `pickLine`
  // still refuses to recommend a losing line while folding is free.
  const best = pickLine(mixed, { pot, bigBlind, preferred: null });
  const tieBreak = best !== null && mixed[0] !== best;
  const shown = presentMix(mixed, best, tieBreak);
  const indiff = toCall > 0 ? indifference(pot, toCall) : null;
  const sections = [];

  // 1. the indifference arithmetic of THIS spot
  const lines = [];
  if (indiff) {
    lines.push(`面对 ${money(toCall, bigBlind)} 的下注，你需要 ${pct(indiff.required * 100)} 胜率才不亏（${money(toCall, bigBlind)} ÷ 最终底池）；你对抗他们的范围有 ${equity === null ? '—' : pct(equity * 100)}。`);
    lines.push(`MDF ${pct(indiff.mdf * 100)}：你至少要继续这么多，否则对手用任意两张诈唬就能白赚；换句话说，你最多只能弃掉范围的 ${pct(indiff.alpha * 100)}。`);
    lines.push(`对手用这个尺度下注时，理论上每 ${Math.round((1 - indiff.bluffShare) * 100 / Math.max(1, Math.round(indiff.bluffShare * 100)) * 10) / 10} 手价值牌配 1 手诈唬（诈唬占下注范围 ${pct(indiff.bluffShare * 100)}）——这就是"平衡"的量化含义。`);
  } else if (sizes.length > 0) {
    const sample = sizes[Math.min(sizes.length - 1, 1)] ?? sizes[0];
    const size = Math.max(0, sample.amount - committed);
    const table = indifference(pot, size);
    lines.push(`你要下注 ${money(sample.amount, bigBlind)}（${pct((size / Math.max(1, pot)) * 100)} 池）：对手需要 ${pct(table.required * 100)} 胜率才能跟，防线是 ${pct(table.mdf * 100)}，所以你的下注范围里大约 ${pct(table.bluffShare * 100)} 可以是诈唬。`);
    lines.push(`底池是 ${money(pot, bigBlind)}，SPR ${Math.round(math.spr * 10) / 10}：${math.spr <= 3 ? '很小，强牌直接做到底池全下' : math.spr >= 8 ? '很大，别用一对打光筹码' : '中等，两条街的价值可以打完'}。`);
  }
  if (context.callersAllIn) {
    // The raise lines are gone from the table, so say why: otherwise the reader wonders
    // where the option went, and the "为什么不能加注" question is the whole spot.
    lines.push('对手已经全下：**只有跟或弃两条线**。没有人能再弃牌（所以没有弃牌率），也没有人能再跟你的加注 —— 加注只是把筹码退回来。');
  }
  sections.push({
    id: 'gto',
    icon: '\u265f',
    title: 'GTO \u6570\u5b66\uff1a\u65e0\u5dee\u70b9\u4e0e EV',
    lines,
    items: shown.slice(0, 4).map((entry) => ({
      label: `${lineLabel(entry.line)} ${entry.amount > 0 ? money(entry.amount, bigBlind) : ''}`.trim(),
      text: `EV ${entry.ev >= 0 ? '+' : ''}${Math.round(entry.ev)}\uff08\u5360\u6bd4 ${pct(entry.share * 100)}\uff09\uff1a${entry.note}`,
    })),
  });

  // 2. what this hand is FOR, and how the plan treats it
  const rangeLines = [
    `这手牌在范围里扮演：**${role.label}**。${role.note}`,
    equity === null
      ? '\u6ca1\u6709\u53ef\u8bfb\u7684\u5bf9\u624b\uff0c\u8303\u56f4\u65e0\u6cd5\u6536\u7a84\uff0c\u4e0b\u9762\u7684\u6df7\u5408\u9891\u7387\u53ea\u80fd\u7b97\u7c97\u7565\u3002'
      : `\u5bf9\u6297\u4ed6\u4eec\u52a8\u4f5c\u6536\u7a84\u540e\u7684\u8303\u56f4\uff0c\u8fd9\u624b\u724c\u7ea6 ${pct(equity * 100)} \u80dc\u7387\uff08\u6a21\u62df\u8bef\u5dee \u00b1${context.vsReads.margin}%\uff09\u3002`,
  ];
  if (shown.length > 1) {
    const gap = mixed[0].ev - mixed[1].ev;
    rangeLines.push(tieBreak
      ? `两条线的 EV 只差 ${Math.round(gap)} 筹码（在噪声范围内），所以按**范围**选：${lineLabel(best.line)}。`
      : gap <= equivalenceBand(pot, bigBlind)
        ? `理论上接近混合：**${shown.map((entry) => `${lineLabel(entry.line)} ${pct(entry.share * 100)}`).join(' / ')}**（EV 差距 ${Math.round(gap)} 筹码）。混合不是"随便选"，而是让对手无论怎么应对都拿不到便宜。`
        : `最优线比第二条线多 ${Math.round(gap)} 筹码，所以这里不需要混合。`);
  }
  if (behind > 0 && board.length >= 3) {
    rangeLines.push(`你身后还有 ${behind} 人：他们的范围也要算进来，所以这里的下注门槛比单挑时高。`);
  }
  sections.push({
    id: 'range',
    icon: '\u{1F9E9}',
    title: '\u8303\u56f4\u4e0e\u89d2\u8272',
    lines: rangeLines,
  });

  // 3. the recommendation itself, stated as the max-EV line
  const headline = best
    ? `${planVerb(best)}${best.amount > 0 ? ` ${money(best.amount, bigBlind)}` : ''}\uff08EV ${best.ev >= 0 ? '+' : ''}${Math.round(best.ev)}\uff09`
    : '\u6682\u65f6\u6ca1\u6709\u53ef\u7528\u7684\u6a21\u62df\u6570\u636e';
  const reasons = [];
  if (equity !== null && indiff) {
    reasons.push(`跟注需要 ${pct(indiff.required * 100)}，你有 ${pct(equity * 100)}：${equity >= indiff.required ? '价格合适' : '价格不合适'}。`);
  }
  if (equity !== null && !indiff) {
    reasons.push(`你对抗他们的范围有 ${pct(equity * 100)} 胜率，${equity >= 0.55 ? '够主动做价值' : equity >= 0.4 ? '适合控制底池' : '不适合做大底池'}。`);
  }
  reasons.push(`这手牌属于${role.label}：${role.note}`);
  // Only claim the EVs are close when they are: a 375-chip gap is not a mixed spot.
  if (mixed.length > 1) {
    const gap = mixed[0].ev - mixed[1].ev;
    const band = equivalenceBand(pot, bigBlind);
    if (gap <= band) reasons.push(`EV 差距很小（${Math.round(gap)} 筹码），所以理论上两种打法都对，不要纠结。`);
    else reasons.push(`第二条线（${lineLabel(mixed[1].line)}）的 EV 差 ${Math.round(gap)} 筹码，所以这里不需要混合。`);
  }
  const risks = [];
  if (equity !== null && indiff && equity < indiff.required && best && best.action !== 'fold') {
    risks.push(`按纯赔率这手牌是亏的（${pct(equity * 100)} < ${pct(indiff.required * 100)}），主动下注的价值来自弃牌率：对手不弃，这条线就亏。`);
  }
  if (math.commitShare > 0.3) risks.push(`你已经投入 ${pct(math.commitShare * 100)} 的筹码，沉没成本不算进 EV —— 只按当前的赔率决定。`);

  return {
    plan: {
      headline,
      action: best ? best.action : null,
      tone: equity === null ? 'info' : best && best.ev > 0 ? 'good' : best && best.action === 'fold' ? 'bad' : 'warn',
      reasons,
      risks,
      tags: [role.label, `GTO`, `${position}`],
      role: role.id,
    },
    sections,
    brief: [
      `GTO 教练：${position}｜${made.label}｜${role.label}`,
      equity === null ? '' : `对抗范围 ${pct(equity * 100)} 胜率（±${context.vsReads.margin}%）${indiff ? `，跟注需 ${pct(indiff.required * 100)}，MDF ${pct(indiff.mdf * 100)}` : ''}。`,
      best ? `最佳 EV：${planVerb(best)}${best.amount > 0 ? ` ${money(best.amount, bigBlind)}` : ''}（EV ${best.ev >= 0 ? '+' : ''}${Math.round(best.ev)}）。` : '',
      shown.length > 1 ? `混合：${shown.map((entry) => `${lineLabel(entry.line)} ${pct(entry.share * 100)}`).join(' / ')}。` : '',
    ].filter(Boolean).join('\n'),
    numbers: {
      mode: 'gto',
      role: role.id,
      mdf: indiff ? indiff.mdf : null,
      alpha: indiff ? indiff.alpha : null,
      required: indiff ? indiff.required : null,
      equity: equity === null ? null : equity,
      foldEquity,
      ev: shown.map((entry) => ({ action: entry.action, amount: entry.amount, ev: Math.round(entry.ev), share: Math.round(entry.share * 1000) / 1000 })),
    },
  };
}

/** The Chinese verb for an action, used in headlines. */
function planVerb(entry) {
  if (entry.action === 'fold') return '\u5f03\u724c';
  if (entry.action === 'check') return '\u8fc7\u724c';
  if (entry.action === 'call') return '\u8ddf\u6ce8';
  if (entry.action === 'allin') return '\u5168\u4e0b';
  return '\u4e0b\u6ce8\u5230';
}

/** The Chinese name of a LINE (the family an action belongs to), for frequency lists. */
export function lineLabel(line) {
  if (line === 'bet') return '\u4e0b\u6ce8/\u52a0\u6ce8';
  if (line === 'check') return '\u8fc7\u724c';
  if (line === 'call') return '\u8ddf\u6ce8';
  if (line === 'fold') return '\u5f03\u724c';
  return String(line);
}

/**
 * The bet sizes worth pricing for this seat.
 *
 * Postflop that is the standard pot fractions (a third, half, three quarters, full pot);
 * preflop it is big-blind multiples, because that is how the street is spoken about -
 * "open to 3BB", "3-bet to 9BB" - and a pot fraction there is a number nobody quotes.
 * @param legal - the seat's legal menu.
 * @param pot - the current pot.
 * @param bigBlind - the big blind, for rounding.
 * @param street - the current street.
 * @returns `[{ action, amount }]`.
 */
export function priceSizes(legal, pot, bigBlind, street) {
  if (!legal || !legal.canRaise) return [];
  const out = [];
  const round = (value) => Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(value / (bigBlind / 2)) * (bigBlind / 2)));
  if (street === 'preflop') {
    // An open is a small multiple of the big blind; a 3-bet is a multiple of the raise.
    // "Facing a raise" is `toCall > bigBlind`, NOT `toCall > 0`: a seat facing only the
    // blind still has a blind to call, and pricing that as a 3-bet quoted 3.5BB opens.
    const facingRaise = legal.toCall > bigBlind;
    const sizes = facingRaise
      ? [round(legal.toCall + 2.5 * bigBlind), round(legal.toCall + 4 * bigBlind), round((legal.toCall + bigBlind) * 3)]
      : [round(2.5 * bigBlind), round(3 * bigBlind), round(4 * bigBlind)];
    for (const amount of sizes) {
      if (!out.some((entry) => Math.abs(entry.amount - amount) < bigBlind / 2)) out.push({ action: 'raise', amount });
    }
  } else {
    for (const fraction of [0.33, 0.5, 0.75, 1]) {
      const target = legal.toCall > 0
        ? round(legal.toCall + fraction * (pot + legal.toCall))
        : round(pot * fraction);
      if (!out.some((entry) => Math.abs(entry.amount - target) < bigBlind / 2)) out.push({ action: 'raise', amount: target });
    }
  }
  if (legal.canAllIn) out.push({ action: 'allin', amount: legal.maxRaiseTo });
  return out;
}
