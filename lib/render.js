/**
 * Text rendering for the poker table: the model-facing transcript and the
 * short summaries used in tool results.
 *
 * Everything here is pure string building over a {@link viewFor} snapshot. The
 * model reads these strings, so they carry the FULL situation it needs to
 * narrate the game and to answer "what are my options"; the browser card is a
 * separate rendering from the same structured view.
 * @module dsh-plugin-poker/render
 */
import { cardLabel, cardsLabel } from './cards.js';
import { evaluate7, handName } from './evaluator.js';
import { legalActions, potTotal, viewFor, STREET_ZH } from './engine.js';

/** Thousands-separated chip count. */
export function chips(amount) {
  return Number(amount ?? 0).toLocaleString('en-US');
}

/** Cards shown face down. */
export const HIDDEN = '\u25a0\u25a0';

/** The two face-down glyphs other players show. */
export function hiddenCards(count = 2) {
  return Array.from({ length: count }, () => HIDDEN).join(' ');
}

/**
 * One player's line in the table rendering.
 * @param player - a seat from {@link viewFor}.
 * @param view - the whole table view (for blinds, button, and actor flags).
 */
function playerLine(player, view) {
  const marks = [];
  if (player.isButton) marks.push('\u6309\u94ae');
  if (player.seat === view.smallBlindSeat) marks.push('\u5c0f\u76f2');
  if (player.seat === view.bigBlindSeat) marks.push('\u5927\u76f2');
  if (player.isActor) marks.push('\u884c\u52a8\u4e2d');
  if (player.isHuman) marks.push('\u4f60');
  const status = [];
  if (player.out) status.push('\u5df2\u51fa\u5c40');
  else if (player.folded) status.push('\u5df2\u5f03\u724c');
  else if (player.allIn) status.push('\u5168\u4e0b');
  const cards = player.cards ? cardsLabel(player.cards) : hiddenCards();
  const hand = player.cards && player.cards.length === 2 && view.board.length >= 3
    ? ` (${handName(evaluate7([...player.cards, ...view.board]))})`
    : '';
  const talk = player.talk ? ` \u201c${player.talk}\u201d` : '';
  const action = player.lastAction ? `\u00b7 ${player.lastAction}` : '';
  return `- [${marks.join('/') || `\u5750\u4f4d${player.seat}`}] **${player.name}** ${status.join(' ') || ''}`
    + ` \u7b79\u7801 ${chips(player.stack)} \u00b7 \u672c\u8f6e\u5df2\u6295 ${chips(player.streetCommitted)}`
    + ` \u00b7 \u5e95\u724c ${cards}${hand} ${action}${talk}`;
}

/**
 * The full table as markdown: heading, board, every seat, the action menu.
 * @param state - game state.
 * @param viewerSeat - whose eyes to render from (cards of others stay hidden).
 * @param options - `revealAll` to show every hole card (model-brain view).
 * @returns a markdown string.
 */
export function renderTable(state, viewerSeat, options = {}) {
  const view = viewFor(state, viewerSeat, options);
  const head = view.street === 'idle'
    ? `**\u724c\u684c\u5c31\u7eea** \u00b7 \u5c0f\u76f2 ${chips(view.smallBlind)} / \u5927\u76f2 ${chips(view.bigBlind)}`
    : `**\u7b2c ${view.handNumber} \u624b\u724c \u00b7 ${view.streetLabel}**`;
  const lines = [];
  lines.push(head);
  lines.push('');
  if (view.board.length > 0) lines.push(`\u516c\u5171\u724c\uff1a${cardsLabel(view.board)}`);
  else lines.push('\u516c\u5171\u724c\uff1a\u5c1a\u672a\u53d1\u724c');
  lines.push(`\u5e95\u6c60\uff1a**${chips(view.pot)}**${view.currentBet > 0 ? ` \u00b7 \u5f53\u524d\u4e0b\u6ce8 ${chips(view.currentBet)}` : ''}`);
  lines.push('');
  for (const player of view.players) lines.push(playerLine(player, view));

  // Side pots only mean something once the board is out: pre-flop the big
  // blind overlay always splits the pot, so showing 边池 there is noise.
  const realSidePots = view.pots.length > 1 && (view.board.length >= 3 || (view.showdown && view.showdown.kind === 'showdown'));
  if (realSidePots) {
    lines.push('');
    lines.push(`\u8fb9\u6c60\uff1a${view.pots.map((pot, index) => `${index === 0 ? '\u4e3b\u6c60' : `\u8fb9\u6c60${index}`} ${chips(pot.amount)}`).join(' \u00b7 ')}`);
  }

  if (view.phase === 'betting' && view.actorSeat !== null) {
    const actor = view.players.find((player) => player.seat === view.actorSeat);
    lines.push('');
    if (actor && actor.isHuman) {
      const legal = legalActions(state);
      const options_ = [];
      if (legal.canCheck) options_.push('\u8fc7\u724c check');
      if (legal.canCall) options_.push(`\u8ddf\u6ce8 ${chips(legal.callAmount)} call`);
      if (legal.canRaise) options_.push(`\u52a0\u6ce8\u5230 ${chips(legal.minRaiseTo)}~${chips(legal.maxRaiseTo)} raise(\u603b\u989d)`);
      options_.push('\u5f03\u724c fold');
      lines.push(`\u25b6 **\u8be5\u4f60\u884c\u52a8**\uff1a${options_.join(' / ')}`);
    } else if (actor) {
      lines.push(`\u25b6 \u7b49\u5f85 ${actor.name} \u884c\u52a8`);
    }
  }

  if (view.showdown) {
    lines.push('');
    lines.push(renderShowdownBody(view));
  }
  return lines.join('\n');
}

/** The showdown block: every revealed hand, then the payouts. */
function renderShowdownBody(view) {
  const lines = ['**\u644a\u724c**'];
  for (const entry of view.showdown.revealed ?? []) {
    lines.push(`- ${entry.name}\uff1a${cardsLabel(entry.cards)} \u2014 ${entry.hand}`);
  }
  for (const pot of view.showdown.payouts ?? []) {
    const awards = pot.awards.map((award) => `${award.name} +${chips(award.amount)}`).join('\u3001');
    lines.push(`- \u5e95\u6c60 ${chips(pot.amount)} \u2192 ${awards}`);
  }
  return lines.join('\n');
}

/**
 * A one-paragraph situation summary: what just happened, what is expected next.
 * @param state - game state.
 * @param viewerSeat - the human seat.
 */
export function renderSituation(state, viewerSeat) {
  const view = viewFor(state, viewerSeat);
  const parts = [];
  parts.push(`\u7b2c ${view.handNumber} \u624b \u00b7 ${view.streetLabel} \u00b7 \u5e95\u6c60 ${chips(view.pot)}`);
  if (view.phase === 'betting' && view.actorSeat !== null) {
    const actor = view.players.find((player) => player.seat === view.actorSeat);
    parts.push(actor && actor.isHuman ? '\u8be5\u4f60\u884c\u52a8' : `\u7b49\u5f85 ${actor ? actor.name : '?'} \u884c\u52a8`);
  } else if (view.phase === 'handover') {
    const winners = (view.showdown?.payouts ?? []).flatMap((pot) => pot.awards.map((award) => `${award.name} +${chips(award.amount)}`));
    parts.push(`\u672c\u624b\u7ed3\u675f \u00b7 ${winners.join('\u3001')}`);
  } else if (view.gameOver) {
    parts.push('\u724c\u5c40\u7ed3\u675f');
  }
  return parts.join(' \u00b7 ');
}

/**
 * The player's own situation as a compact digest: hole cards, made hand, the
 * price to continue. Used by the equity and hint tools.
 * @param state - game state.
 * @param viewerSeat - the human seat.
 */
export function renderSelf(state, viewerSeat) {
  const player = state.players[viewerSeat];
  const lines = [];
  if (player.cards.length === 2) {
    lines.push(`\u4f60\u7684\u5e95\u724c\uff1a${cardsLabel(player.cards)}`);
    if (state.board.length >= 3) lines.push(`\u5f53\u524d\u724c\u578b\uff1a${handName(evaluate7([...player.cards, ...state.board]))}`);
    else lines.push('\u5f53\u524d\u724c\u578b\uff1a\u7ffb\u724c\u524d\u5e95\u724c');
  }
  const legal = legalActions(state);
  if (legal && legal.seat === viewerSeat) {
    lines.push(`\u9762\u4e34\u4e0b\u6ce8\uff1a${chips(legal.toCall)}\uff08\u5e95\u6c60 ${chips(potTotal(state))}\uff0c\u8ddf\u6ce8\u9700\u8981\u80dc\u7387 ${legal.toCall > 0 ? `${Math.round((legal.callAmount / (potTotal(state) + legal.callAmount)) * 1000) / 10}%` : '0%'}\uff09`);
  }
  lines.push(`\u4f60\u7684\u7b79\u7801\uff1a${chips(player.stack)}\uff08\u672c\u624b\u5df2\u6295 ${chips(player.handCommitted)}\uff09`);
  return lines.join('\n');
}

/** Street label lookup re-exported for tools. */
export { STREET_ZH };

/** Card label re-exported for tools. */
export { cardLabel };
