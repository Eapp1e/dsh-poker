/**
 * dsh-plugin-poker - the browser half.
 *
 * This file is a hand-written client bundle in the exact shape the DSH client
 * module loader expects: register a factory under the package name, receive the
 * frozen platform module table through `require`, and export `apply`. It
 * requires only `react`, which is part of the seeded platform table, so no
 * bundler is involved.
 *
 * Two surfaces share one table renderer:
 *
 * 1. `tool.call.toolview` (keyed by tool name) replaces each poker tool call's
 *    row with the table as it stood at that call.
 * 2. `conversation.session.header.actions` adds a persistent "poker table"
 *    button. It reads the NEWEST poker table out of the session's own event
 *    window - a tool result carries the table through its persisted
 *    `meta.view` - and expands a panel that always shows the live table, so the
 *    game is visible without scrolling to a tool row.
 *
 * Both are pure views over data the session already has; neither needs a
 * projection, an RPC, or extra host surface. Action buttons compose one
 * plain-language sentence and submit it as an ordinary prompt, keeping every
 * game action inside the normal conversation path.
 * @module dsh-plugin-poker/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-poker',
  factory: (require) => {
    // The loader's factory form is CommonJS-shaped: the bundle owns its own
    // module record and returns its exports. Both must be declared here — the
    // page provides no ambient `module`/`exports`.
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');

    /** The wire tool names this card family owns. */
    const TOOL_NAMES = [
      'poker_new_table',
      'poker_action',
      'poker_next_hand',
      'poker_table',
      'poker_opponent',
      'poker_equity',
    ];

    /** One CSS tag for the whole family; the loader claims it by plugin id. */
    const css = [
      '.dshp-root{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5}',
      '.dshp-compact{font-size:12px}',
      '.dshp-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dshp-title{font-weight:600;color:var(--dsw-alias-label-primary,inherit);display:inline-flex;align-items:center;gap:5px}',
      '.dshp-muted{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px}',
      // The table itself: a wooden rail around an oval felt, seats on the rail.
      // The felt keeps the oval (aspect-ratio lives HERE, not on the table), and
      // the table is a padded frame around it: the padding is what the seat tiles
      // hang into, so a seat at 93% of the felt can never reach the buttons below.
      // The felt is also a container, so a squeezed table grows the board's room
      // instead of spilling into the rail (see the @container rule at the end).
      '.dshp-table{container-type:inline-size;position:relative;flex:none;width:100%;aspect-ratio:1.78/1;min-height:230px;max-height:560px;margin:62px 0 66px;padding:11px;box-sizing:border-box;border-radius:50%;background:linear-gradient(160deg,#8a5527 0%,#5a3417 42%,#301b0b 100%);box-shadow:inset 0 0 26px rgba(0,0,0,.6),0 10px 26px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.07)}',
      // A full ring stacks three tiles down each side, so the felt is taller and
      // the tiles hang out of it far less: the margins shrink with the crowd, and
      // the extra height goes to the seats instead of to empty rail.
      '.dshp-table[data-seats="7"],.dshp-table[data-seats="8"]{margin:52px 0 56px}',
      '.dshp-table[data-seats="9"]{margin:48px 0 52px}',
      '.dshp-felt{position:relative;width:100%;height:100%;box-sizing:border-box;border-radius:50%;background:radial-gradient(72% 82% at 50% 34%,#37996a 0%,#1f6743 50%,#0f3823 100%);box-shadow:inset 0 0 60px rgba(0,0,0,.55),inset 0 0 0 3px rgba(255,255,255,.05),inset 0 0 0 13px rgba(0,0,0,.15)}',
      // Felt dressing: a faint suit watermark and the betting line, so the oval
      // reads as a table rather than a green blob.
      '.dshp-feltMark{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:76px;font-weight:800;letter-spacing:8px;color:rgba(255,255,255,.05);pointer-events:none;user-select:none;white-space:nowrap}',
      '.dshp-feltLine{position:absolute;left:7%;top:11%;width:86%;height:78%;border:1px dashed rgba(255,255,255,.09);border-radius:50%;pointer-events:none}',
      // The dealer button is a real chip pinned to the top-left corner of the tile
      // of the player who holds it - one fixed spot on every seat, so the eye
      // finds it without hunting, and the chip never covers the avatar, the stack
      // or the hole cards.
      '.dshp-dealer{position:absolute;top:-11px;left:-10px;width:21px;height:21px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#2a2a2a;background:radial-gradient(circle at 34% 30%,#ffffff,#dcdcdc 68%,#b0b0b0 100%);border:1px solid rgba(0,0,0,.28);box-shadow:0 2px 6px rgba(0,0,0,.55),inset 0 0 0 2px rgba(0,0,0,.06);z-index:5;pointer-events:none;line-height:1}',
      '.dshp-center{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);z-index:3;display:flex;flex-direction:column;align-items:center;gap:4px;width:60%}',
      '.dshp-pot{display:inline-flex;align-items:center;gap:7px;background:rgba(0,0,0,.46);border:1px solid rgba(255,255,255,.24);color:#ffe9a8;border-radius:999px;padding:3px 15px 3px 6px;font-weight:700;font-size:15px;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,.45)}',
      // A small stack of chips in front of the amount.
      //
      // Drawn the way a stack looks from the table's viewpoint: the top chip shows
      // its FACE, the ones under it show their rims a few pixels each, so the pile
      // reads as chips and can be counted. Scattering discs flat on top of each
      // other was tried twice and both times read as one blob.
      '.dshp-potStack{position:relative;width:20px;height:30px;flex:none}',
      '.dshp-chip{position:absolute;left:1px;width:18px;height:6px;border-radius:50%;background:var(--chipBody);box-shadow:0 1px 2px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.55),inset 0 -2px 0 rgba(0,0,0,.3)}',
      '.dshp-chipW{--chipBody:#eef0f3;--chipSpot:#c0392b;--chipRim:#b6bdc6}',
      '.dshp-chipR{--chipBody:#c0392b;--chipSpot:#f6f7f9;--chipRim:#8d271d}',
      '.dshp-chipG{--chipBody:#1f7a4d;--chipSpot:#f6f7f9;--chipRim:#12502e}',
      '.dshp-chipK{--chipBody:#2a3038;--chipSpot:#ffd166;--chipRim:#12161b}',
      // The top chip: a coloured body with a ring of edge spots at the rim, a white
      // ring and a centre dot - a casino chip, legible even at 18px.
      '.dshp-chipTop{z-index:2;width:18px;height:18px;background-image:repeating-conic-gradient(from 0deg,var(--chipSpot) 0deg 12deg,transparent 12deg 45deg);box-shadow:0 2px 5px rgba(0,0,0,.65),inset 0 0 0 1px rgba(0,0,0,.35)}',
      '.dshp-chipTop::after{content:"";position:absolute;inset:3px;border-radius:50%;border:2px solid rgba(255,255,255,.92);box-shadow:inset 0 1px 2px rgba(0,0,0,.22)}',
      '.dshp-chipTop::before{content:"";position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:rgba(255,255,255,.92)}',
      '.dshp-street{color:rgba(255,255,255,.72);font-size:11px;letter-spacing:.4px;text-align:center;white-space:nowrap}',
      // Shown for one answer after the host hot-reloaded the plugin's own code.
      '.dshp-reload{display:inline-flex;align-items:center;gap:4px;background:rgba(142,199,255,.16);border:1px solid rgba(142,199,255,.5);color:#a9d6ff;border-radius:999px;padding:1px 8px;font-size:10px;font-weight:600;white-space:nowrap}',
      // The coach lives in its own window, so the table panel never grows into a
      // wall of text and the analysis can be dragged wherever it is out of the way.
      '.dshp-coachWin{position:fixed;z-index:101;width:452px;max-width:min(94vw,540px);max-height:calc(100vh - 96px);display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-specific-menu,#1f1f22);border:1px solid rgba(142,199,255,.4);border-radius:14px;padding:10px 10px 0;box-shadow:var(--dsw-elevation-prominent,0 14px 36px rgba(0,0,0,.55))}',
      '.dshp-coachWinPinned{border-color:rgba(142,199,255,.8)}',
      '.dshp-coachWinHead{display:flex;align-items:center;gap:6px;padding:0 0 7px;margin-bottom:7px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));cursor:grab;touch-action:none;user-select:none;flex:none}',
      '.dshp-coachWinHeadPinned{cursor:default}',
      '.dshp-coachWinTitle{font-size:12.5px;font-weight:700;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}',
      // The style switcher in the coach window head: two states, no room for more.
      '.dshp-modeSwitch{display:inline-flex;flex:none;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:7px;overflow:hidden}',
      '.dshp-modeBtn{cursor:pointer;border:0;background:0 0;color:var(--dsw-alias-label-tertiary,#8a8a8a);font:inherit;font-size:10.5px;line-height:16px;padding:0 6px}',
      '.dshp-modeBtn:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dshp-modeBtnOn{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
      '.dshp-modeNotice{font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-warn-primary,#ffd166);flex:1 1 100%;min-width:0}',
      '.dshp-coachWinBody{display:flex;flex-direction:column;gap:9px;overflow-y:auto;overflow-x:hidden;padding:0 2px 8px 0;min-height:0}',
      // The recommendation, repeated in the window's own title bar. The tone is
      // carried by the border, the text stays a theme label colour so it is
      // readable on a light theme too.
      '.dshp-coachPlan{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));border:1px solid var(--dsw-alias-state-warn-primary,rgba(255,209,102,.5));color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}',
      '.dshp-coachPlanGood{border-color:var(--dsw-alias-state-success-primary,rgba(142,242,164,.55))}',
      '.dshp-coachPlanWarn{border-color:var(--dsw-alias-state-warn-primary,rgba(255,209,102,.55))}',
      '.dshp-coachPlanBad{border-color:var(--dsw-alias-state-error-primary,rgba(255,143,143,.6))}',
      '.dshp-coachWinFoot{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));padding:5px 0 6px}',
      // The recommendation, shown right above the buttons it refers to.
      '.dshp-notice{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:1.4;padding:4px 8px;border-radius:8px;background:rgba(192,57,43,.14);border:1px solid var(--dsw-alias-state-error-primary,rgba(226,74,78,.6));color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-noticeMark{flex:none;font-weight:700;color:var(--dsw-alias-state-error-primary,#e24a4e)}',
      // The rebuy card: only drawn once the hero's stack is empty, offering whole
      // big-blind top-ups plus a custom amount.
      '.dshp-rebuy{display:flex;flex-direction:column;gap:8px;padding:9px 10px;border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-state-warn-primary,rgba(255,209,102,.5))}',
      '.dshp-rebuyHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dshp-rebuyRow{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshp-rebuyOpt{flex:1 1 0;min-width:96px}',
      '.dshp-rebuyCustom{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dshp-rebuyInput{flex:0 1 104px;min-width:76px}',
      // The end-of-game card: the result, and the way forward.
      '.dshp-over{display:flex;flex-direction:column;gap:8px;padding:9px 10px;border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-state-success-primary,rgba(142,242,164,.5))}',
      '.dshp-overHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dshp-overTitle{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-overRow{display:flex;gap:6px;flex-wrap:wrap}',
      // The plugin's page in the settings dialog.
      '.dshp-set{display:flex;flex-direction:column;gap:10px;max-width:620px}',
      '.dshp-setHead{display:flex;align-items:center;gap:8px}',
      '.dshp-setTitle{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-setGroup{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:var(--dsw-alias-fill-l1,rgba(127,127,127,.05))}',
      '.dshp-setGroupTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-setRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}',
      '.dshp-setLabel{flex:0 0 116px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dshp-setInput{box-sizing:border-box;flex:0 1 260px;min-width:120px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px}',
      '.dshp-setInput:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,rgba(142,242,164,.6))}',
      // A native select paints its popup from the ELEMENT's colours, not from the page:
      // with the shared translucent fill the option list came out washed out in dark
      // mode (light panel, low-contrast text). An opaque layer background - the same
      // token the settings dialog itself uses - plus explicit option colours fixes both
      // themes, and the fallbacks keep it readable if the token is ever missing.
      '.dshp-setSelect{flex:0 1 260px;background:var(--dsw-alias-bg-layer-2,#26272b);color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-setSelect option{background:var(--dsw-alias-bg-layer-2,#26272b);color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshp-setCheck{width:16px;height:16px;accent-color:#2f7fd8}',
      '.dshp-setValue{font-size:13px;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}',
      '.dshp-setActionCell{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.dshp-setLink{color:var(--dsw-alias-state-success-primary,#8ef2a4);text-decoration:underline}',
      '.dshp-setHint{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;flex:1 1 auto;min-width:0}',
      '.dshp-setSave{flex:0 0 auto;min-width:96px}',
      '.dshp-setTestBtn{flex:0 0 auto;min-width:110px}',
      '.dshp-setTest{font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35))}',
      '.dshp-setTestOk{border-color:var(--dsw-alias-state-success-primary,rgba(142,242,164,.55));color:var(--dsw-alias-state-success-primary,#8ef2a4)}',
      '.dshp-setTestBad{border-color:var(--dsw-alias-state-error-primary,rgba(255,143,143,.6));color:var(--dsw-alias-state-error-primary,#ff8f8f)}',
      '.dshp-advice{display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 8px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));border:1px solid var(--dsw-alias-state-warn-primary,rgba(255,209,102,.5));color:var(--dsw-alias-label-primary,inherit);overflow:hidden;flex-wrap:nowrap;min-width:0}',
      // The label never wraps or shrinks; the sentence next to it takes the ellipsis.
      '.dshp-adviceLabel{flex:none;white-space:nowrap}',
      '.dshp-adviceText{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dshp-adviceGood{border-color:var(--dsw-alias-state-success-primary,rgba(142,242,164,.55))}',
      '.dshp-adviceWarn{border-color:var(--dsw-alias-state-warn-primary,rgba(255,209,102,.55))}',
      '.dshp-adviceBad{border-color:var(--dsw-alias-state-error-primary,rgba(255,143,143,.6))}',
      // The advice ring is YELLOW on purpose: the raise commit is already blue,
      // so a blue ring on it read as "this is the raise button" instead of "this
      // is what the coach wants".
      '.dshp-btnAdvice{box-shadow:0 0 0 2px #ffd166,0 0 10px rgba(255,209,102,.35)}',
      '.dshp-teachSec{display:flex;flex-direction:column;gap:4px;border-left:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));padding-left:8px}',
      '.dshp-teachGood{border-left-color:var(--dsw-alias-state-success-primary,#8ef2a4)}',
      '.dshp-teachWarn{border-left-color:var(--dsw-alias-state-warn-primary,#ffd166)}',
      '.dshp-teachBad{border-left-color:var(--dsw-alias-state-error-primary,#ff8f8f)}',
      '.dshp-teachSecTitle{cursor:pointer;font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:center;gap:5px;user-select:none}',
      '.dshp-teachSecTitle:hover{color:var(--dsw-alias-brand-primary,inherit)}',
      '.dshp-teachCaret{font-size:9px;color:var(--dsw-alias-label-tertiary,#8a8a8a);flex:none;width:8px}',
      '.dshp-teachLine{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#c9c9c9)}',
      '.dshp-teachItem{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#c9c9c9)}',
      // The label used to be gold on dark; on a light theme that vanished. Bold
      // primary text carries the emphasis in either theme.
      '.dshp-teachItemLabel{font-weight:700;color:var(--dsw-alias-label-primary,inherit);margin-right:4px}',
      '.dshp-teachTags{display:flex;flex-wrap:wrap;gap:4px;margin-top:1px}',
      // The five community cards are spaced EVENLY: one board, one rhythm. Street
      // grouping is carried by the cards themselves (they arrive one at a time),
      // not by unequal gaps, which read as a layout bug.
      '.dshp-boardRow{display:flex;align-items:center;justify-content:center;gap:6px}',
      '.dshp-card{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:38px;height:52px;border-radius:6px;background:linear-gradient(180deg,#fff 0%,#eef0f2 100%);border:1px solid rgba(0,0,0,.3);box-shadow:0 2px 4px rgba(0,0,0,.4);font-weight:700;line-height:1;user-select:none;flex:none}',
      '.dshp-cardRank{font-size:16px}',
      '.dshp-cardSuit{font-size:13px;margin-top:1px}',
      '.dshp-red{color:#d13438}',
      '.dshp-black{color:#1b1b1b}',
      '.dshp-cardBack{background:repeating-linear-gradient(45deg,#2b4f8a 0 4px,#20396a 4px 8px);border-color:rgba(255,255,255,.3)}',
      '.dshp-cardEmpty{background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.16);box-shadow:none}',
      '.dshp-mini{width:22px;height:30px;border-radius:4px}',
      '.dshp-mini .dshp-cardRank{font-size:11px}',
      '.dshp-mini .dshp-cardSuit{font-size:9px;margin-top:0}',
      '.dshp-heroCard{width:32px;height:44px;border-radius:6px;box-shadow:0 3px 7px rgba(0,0,0,.5)}',
      '.dshp-heroCard .dshp-cardRank{font-size:15px}',
      '.dshp-heroCard .dshp-cardSuit{font-size:12px}',
      // Seats sit ON the rail, placed by percentage around the oval.
      '.dshp-seat{position:absolute;transform:translate(-50%,-50%);box-sizing:border-box;display:flex;flex-direction:column;gap:3px;align-items:center;padding:6px 7px;border-radius:11px;background:linear-gradient(180deg,rgba(20,28,24,.95),rgba(9,15,12,.95));border:1px solid rgba(255,255,255,.18);box-shadow:0 3px 10px rgba(0,0,0,.5);color:#f3f3f3;text-align:center}',
      '.dshp-seatActor{border-color:#ffd166;box-shadow:0 0 0 1px #ffd166,0 0 16px rgba(255,209,102,.5);animation:dshpSeatPulse .42s ease-out}',
      '@keyframes dshpSeatPulse{0%{transform:translate(-50%,-50%) scale(.94)}55%{transform:translate(-50%,-50%) scale(1.06)}100%{transform:translate(-50%,-50%) scale(1)}}',
      '.dshp-resolving{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.dshp-spinner{width:11px;height:11px;border-radius:50%;border:2px solid rgba(127,127,127,.35);border-top-color:var(--dsw-static-blue-600,#2563eb);animation:dshpSpin .7s linear infinite;flex:none}',
      '@keyframes dshpSpin{to{transform:rotate(360deg)}}',
      // A dealt card drops onto the felt instead of blinking into place, so a
      // replayed flop/turn/river reads as a deal and not as a repaint. The travel
      // is short (-6px) on purpose: a bigger lift covered the "需跟" line above
      // the board while the card was fading in.
      '.dshp-dealIn{animation:dshpDealIn .26s cubic-bezier(.2,.9,.3,1.3)}',
      '@keyframes dshpDealIn{from{opacity:0;transform:translateY(-6px) rotate(-6deg) scale(.86)}to{opacity:1;transform:none}}',
      '.dshp-seatWinner{border-color:#8ef2a4;box-shadow:0 0 0 1px #8ef2a4,0 0 18px rgba(142,242,164,.45)}',
      '.dshp-seatOut{opacity:.42;z-index:0}',
      '.dshp-seatHero{background:linear-gradient(180deg,rgba(26,54,36,.97),rgba(13,30,20,.97));border-color:rgba(142,242,164,.45)}',
      '.dshp-seatTop{display:flex;align-items:center;justify-content:center;gap:4px;max-width:100%;min-width:0}',
      // An avatar and a position pill turn the tile into a player card: who is
      // sitting there, in what seat, with what personality.
      '.dshp-avatar{width:23px;height:23px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12.5px;line-height:1;flex:none;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);box-shadow:inset 0 1px 2px rgba(0,0,0,.35)}',
      '.dshp-seatHero .dshp-avatar{background:rgba(142,242,164,.16);border-color:rgba(142,242,164,.5)}',
      '.dshp-pos{font-size:9px;font-weight:700;letter-spacing:.3px;padding:0 5px;border-radius:5px;background:rgba(255,255,255,.16);color:rgba(255,255,255,.88);white-space:nowrap;flex:none}',
      '.dshp-posLate{background:rgba(255,209,102,.24);color:#ffe9a8}',
      '.dshp-posBlind{background:rgba(142,199,255,.22);color:#cfe4ff}',
      // What this player did on THIS street, in poker terms (open / 3-bet /
      // c-bet...): the same word the raise button carries, on their own card.
      '.dshp-seatTerm{font-size:9px;font-weight:700;letter-spacing:.2px;padding:0 5px;border-radius:5px;background:rgba(142,199,255,.28);color:#e8f3ff;white-space:nowrap;flex:none}',
      '.dshp-seatTermPost{background:rgba(255,209,102,.3);color:#3a2a00}',
      // Hover lifts the tile and reveals the coach's read for that player - the
      // same numbers the analysis window quotes, per seat.
      '.dshp-seat{z-index:1;transition:box-shadow .15s ease,border-color .15s ease}',
      '.dshp-seat:hover{z-index:6;border-color:rgba(255,255,255,.5);outline:2px solid rgba(142,199,255,.35);outline-offset:1px}',
      // A player still in the hand is drawn above one who folded: the tiles on a
      // full ring sit close, and a greyed-out fold must never cover a live seat.
      '.dshp-seatActor{z-index:5}',
      // The read is placed INSIDE the felt: above the tile normally, below it for
      // the seats along the top, and nudged left/right at the ends of the rail, so
      // it never runs off the panel and gets clipped.
      '.dshp-seatRead{position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);display:none;box-sizing:border-box;width:214px;padding:6px 8px;border-radius:9px;background:rgba(11,17,21,.97);border:1px solid rgba(142,199,255,.45);box-shadow:0 10px 24px rgba(0,0,0,.6);color:#dbeaff;font-size:10.5px;line-height:1.5;text-align:left;z-index:20;pointer-events:none;white-space:normal}',
      '.dshp-seat:hover .dshp-seatRead{display:block}',
      '.dshp-seatReadBelow{bottom:auto;top:calc(100% + 9px)}',
      '.dshp-seatReadLeft{left:0;transform:none}',
      '.dshp-seatReadRight{left:auto;right:0;transform:none}',
      '.dshp-seatReadTitle{display:block;font-weight:700;color:#fff;margin-bottom:2px}',
      '.dshp-seatName{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '.dshp-seatChips{font-size:12px;color:#ffe9a8;font-variant-numeric:tabular-nums;line-height:1.15}',
      // BB is the unit players reason in, so it has to be READABLE, not a faint
      // whisper: a light blue chip pill next to the gold chip count.
      '.dshp-bb{font-size:10px;font-weight:600;color:#8ec7ff;background:rgba(142,199,255,.14);border-radius:999px;padding:0 5px;letter-spacing:.2px;white-space:nowrap}',
      '.dshp-bbOnGold{color:#4a3200;background:rgba(0,0,0,.16)}',
      '.dshp-bbBig{font-size:11px;color:#a9d6ff;background:rgba(142,199,255,.18)}',
      // The same pill on a THEME surface (the coach window, the sizing helper):
      // the blue-on-dark variant is invisible on a light theme.
      '.dshp-bbPane{color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14))}',
      '.dshp-seatCards{display:flex;gap:3px;justify-content:center}',
      '.dshp-seatMade{font-size:10px;font-weight:600;color:#ffd166;line-height:1.2}',
      '.dshp-seatHand{font-size:10px;color:rgba(255,255,255,.6);line-height:1.2}',
      '.dshp-badges{display:flex;gap:3px;justify-content:center;flex-wrap:wrap}',
      '.dshp-badge{font-size:9px;line-height:14px;padding:0 4px;border-radius:4px;background:rgba(255,255,255,.2);color:#fff}',
      // The same badge on a THEME surface (the card head): white-on-white is
      // invisible on a light theme, so it takes the pane's own tokens.
      '.dshp-badgePane{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.2));color:var(--dsw-alias-label-secondary,inherit);line-height:15px;padding:0 6px;border-radius:6px}',
      '.dshp-badgeTurn{background:#ffd166;color:#3a2a00}',
      '.dshp-badgeYou{background:#2f9e44;color:#fff}',
      // The settled amount: a light green pill with a dark number, and the sign
      // centred as its own piece so "+450" does not read as "450 with a speck".
      '.dshp-badgeWin{background:#8ef2a4;color:#0b2a13;display:inline-flex;align-items:center;gap:1px;padding:0 6px;font-size:10px;font-weight:700;line-height:16px;font-variant-numeric:tabular-nums}',
      '.dshp-badgeSign{font-size:12px;font-weight:800;line-height:1;transform:translateY(.5px)}',
      // The bet chip rides fully ABOVE the tile and centred on it: anchored to a
      // corner it overlapped the seat's own name row.
      '.dshp-betChip{position:absolute;top:-18px;left:50%;transform:translateX(-50%);z-index:2;background:linear-gradient(180deg,#ffe9a8,#e0b64a);color:#3a2a00;border-radius:999px;font-size:10px;font-weight:700;padding:1px 7px;box-shadow:0 1px 4px rgba(0,0,0,.55);white-space:nowrap}',
      '.dshp-talk{font-size:10px;color:rgba(255,255,255,.62);font-style:italic;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // The control bar is deliberately a separate surface from the felt.
      '.dshp-controls{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.1))}',
      '.dshp-bottom{display:flex;gap:10px;align-items:stretch}',
      '.dshp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}',
      '.dshp-side{width:214px;flex:none;display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.dshp-sideTitle{font-size:11px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-secondary,inherit);display:flex;align-items:center;gap:6px}',
      // Table-size picker.
      '.dshp-picker{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.dshp-pickGrid{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshp-pick{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-fill-l2,rgba(127,127,127,.1));color:inherit;border-radius:10px;padding:8px 6px;min-width:70px;display:flex;flex-direction:column;align-items:center;gap:2px}',
      '.dshp-pick:hover{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.22));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.6))}',
      '.dshp-pick strong{font-size:15px;font-weight:700}',
      '.dshp-pick span{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      // The swap strip: one row of size chips under the table, with the size being
      // played marked, so choosing another table never hides the current one.
      '.dshp-pickStrip{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.45));border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06))}',
      '.dshp-pickStripTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;flex:none}',
      '.dshp-pickChip{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;line-height:1.2;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
      '.dshp-pickChip:hover{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.26));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.6))}',
      '.dshp-pickChipNow{border-color:#4d9ef7;background:rgba(77,158,247,.2)}',
      '.dshp-pickChip small{font-size:9px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.dshp-pickChipNow small{color:var(--dsw-alias-label-secondary,inherit)}',
      '.dshp-pickCancel{flex:none;min-width:0;padding:4px 12px;font-size:12px}',
      '.dshp-unit{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;flex:none}',
      '.dshp-eq{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);flex:none}',
      // Compact, but the native steppers STAY: the arrows walk in big blinds, which
      // is the unit the rest of the panel speaks, and a number field keeps ~84px of
      // intrinsic width for them anyway.
      '.dshp-input{box-sizing:border-box;flex:0 1 84px;min-width:64px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:var(--dsw-alias-fill-l1,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:6px 8px;font-size:12px}',
      '.dshp-inputBB{flex:0 1 66px;min-width:58px}',
      '.dshp-actionsCol{display:flex;flex-direction:column;gap:8px}',
      // Poker vocabulary tag (open / 3-bet / call ...) so the buttons teach terms.
      '.dshp-tag{font-size:9px;line-height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit);font-weight:500;letter-spacing:.2px;white-space:nowrap;flex:none}',
      '.dshp-btnRow{display:flex;gap:6px;width:100%;flex-wrap:wrap}',
      // nowrap everywhere a squeezed flex row would otherwise stack characters
      // one per line, which is what made this panel look broken when narrow.
      // Every action button shares the row evenly, so the row always fills.
      //
      // Neutral surfaces and text come from the theme's alias tokens: a
      // translucent white fill with near-white text is invisible on a LIGHT
      // theme, which is exactly what a player reported.
      '.dshp-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:9px;padding:6px 8px;font-size:12px;font-weight:600;line-height:1.15;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;white-space:nowrap;flex:1 1 0;min-width:64px;overflow:hidden;transition:background .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dshp-btnMain{font-size:12px;font-weight:600;display:flex;flex-wrap:wrap;justify-content:center;gap:0 4px;max-width:100%}',
      // The labels are lists of pieces, and they WRAP instead of being cut off:
      // a piece is a whole word ("跟注", "8,025", "all-in"), never a character, so
      // a narrow button gets a second line rather than "全下 8,0...".
      '.dshp-commitAmount{white-space:nowrap}',
      '.dshp-btnSub{font-size:9px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a8a8a);display:flex;flex-wrap:wrap;justify-content:center;gap:0 4px;max-width:100%}',
      '.dshp-btnPrimary .dshp-btnSub{color:rgba(255,255,255,.85)}',
      '.dshp-btnDanger .dshp-btnSub{color:rgba(255,255,255,.85)}',
      '.dshp-btn:hover{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.26));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55))}',
      '.dshp-btn:active{background:var(--dsw-alias-fill-l4,rgba(127,127,127,.34))}',
      // Every action button keeps its OWN colour and brightens it on hover, so
      // the four options stay one family with one interaction language.
      //
      // The call button is POKER GREEN, hardcoded on purpose: it used to take the
      // app's primary-button token, and in the dark theme that token is nearly
      // WHITE - so "跟注 300" rendered as white text on a white button and the one
      // button you press most often became invisible. Call is green at every
      // table; the theme gets to style the panel, not the chips.
      '.dshp-btnPrimary{background:#2f9e44;border-color:#3fbf58;color:#fff}',
      '.dshp-btnPrimary:hover{background:#37b34f;border-color:#8ef2a4}',
      '.dshp-btnPrimary:active{background:#2b8f3d}',
      // Check is its own colour (teal): grey made it look like one of the sizing
      // presets right below it, which are the only grey things in this area.
      '.dshp-btnCheck{background:#0f8f86;border-color:#17a79c;color:#fff}',
      '.dshp-btnCheck:hover{background:#13a196;border-color:#5fd8cd}',
      '.dshp-btnCheck:active{background:#0c7a72}',
      // Fold keeps its red on BOTH themes through the app's error tokens - those
      // resolve to red-600 in the light theme and #ec1313 in the dark one, so the
      // pair of foreground/background always matches.
      '.dshp-btnDanger{background:var(--dsw-alias-state-error-primary,#c0392b);border-color:var(--dsw-alias-state-error-primary,#e24a4e);color:#fff}',
      '.dshp-btnDanger:hover{background:var(--dsw-alias-state-error-secondary,#d64535);border-color:#ff9a9d}',
      '.dshp-btnDanger:active{background:#a5301f}',
      // All-in gets its own colour: it used to be the same grey as the sizing
      // presets, which made the most aggressive option look like a utility chip.
      // The fills are SOLID: a translucent wash with near-white text - which is
      // what these two buttons used to be - vanishes on a light theme.
      '.dshp-btnAllIn{background:#6d4aff;border-color:#7c5cff;color:#fff}',
      '.dshp-btnAllIn:hover{background:#8064ff;border-color:#b9a6ff}',
      '.dshp-btnAllIn:active{background:#5b3ae0}',
      '.dshp-btnAllIn .dshp-btnSub{color:rgba(255,255,255,.85)}',
      '.dshp-btnGhost{background:transparent;font-weight:500}',
      // The raise commit lives in the action row but BELONGS to the sizing row
      // below: one accent colour plus a pointer triangle ties the two together.
      '.dshp-btnCommit{position:relative;border-color:#4d9ef7;background:#2f7fd8;color:#fff}',
      '.dshp-btnCommit:hover{background:#3d8ff0;border-color:#8ec7ff}',
      '.dshp-btnCommit:active{background:#2a6fc0}',
      '.dshp-btnCommit .dshp-btnSub{color:rgba(255,255,255,.85)}',
      '.dshp-btnCommit::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#4d9ef7;pointer-events:none}',
      '.dshp-raise{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:10px;border:1px solid #4d9ef7;background:rgba(77,158,247,.07)}',
      '.dshp-reset{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-fill-l2,rgba(127,127,127,.12));color:inherit;border-radius:7px;width:26px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;flex:none}',
      '.dshp-reset:hover{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.24))}',
      // How big the typed amount is, in pots - the number players compare across
      // streets. Fixed width and tabular digits so the readout changes on every
      // keystroke ("0.4 池" → "1.33 池") without moving anything else, and packed
      // right after the BB box: a gap that grows with the row just to park a
      // two-word label at the far edge reads as a mistake.
      '.dshp-potShare{width:74px;flex:none;text-align:left;font-size:11px;font-weight:600;color:var(--dsw-static-blue-600,#1c7ed6);white-space:nowrap;font-variant-numeric:tabular-nums}',
      // The bet-sizing coach.
      '.dshp-coach{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.dshp-coachHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dshp-coachTitle{font-size:12px;font-weight:600}',
      '.dshp-sizes{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:6px}',
      // The four size presets use the SAME palette and hover as the action
      // buttons above them: one row of controls, one visual language.
      '.dshp-size{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:9px;padding:6px 9px;font-size:11px;line-height:1.25;text-align:left;display:flex;flex-direction:column;gap:1px;white-space:nowrap;overflow:hidden;transition:background .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dshp-size:hover{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.26));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55))}',
      '.dshp-size:active{background:var(--dsw-alias-fill-l4,rgba(127,127,127,.34))}',
      '.dshp-size strong{font-size:12px}',
      '.dshp-sizeUses{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshp-tip{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.45}',
      // The hand log reads as a story: one block per street, one row per action.
      // It does NOT scroll on its own: the column around it is the one scroller,
      // so there is a single place where a long log starts moving.
      '.dshp-log{display:flex;flex-direction:column;gap:9px;padding-right:2px}',
      '.dshp-logBlock{display:flex;flex-direction:column;gap:3px}',
      '.dshp-logHead{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-secondary,#c9c9c9)}',
      '.dshp-logHead::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.28))}',
      '.dshp-logBoard{font-size:10px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap}',
      '.dshp-logRow{display:flex;gap:5px;align-items:baseline;font-size:11.5px;line-height:1.45}',
      // The log is reference material, not the headline: names stay quiet and the
      // action carries the reading weight. Everything here sits on a theme
      // surface, so it reads from the theme's label tokens.
      '.dshp-logWho{font-weight:600;color:var(--dsw-alias-label-primary,inherit);flex:none;max-width:68px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-logAct{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#c9c9c9)}',
      '.dshp-logTalk{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-logShow .dshp-logWho{color:var(--dsw-static-blue-600,#1c7ed6)}',
      '.dshp-equity{display:flex;gap:10px;font-size:12px;align-items:center}',
      '.dshp-bar{height:6px;border-radius:999px;background:rgba(0,0,0,.35);overflow:hidden}',
      '.dshp-barFill{height:100%;background:linear-gradient(90deg,#2f9e44,#8ef2a4)}',
      '.dshp-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      // Header action + its floating panel.
      // The footer rows' own wrapper is 4px wider with -2px side margins (that is
      // how `sidebar.settings` is laid out), so matching it is what lines the two
      // marks up on the same x.
      '.dshp-headerRoot{position:relative;display:inline-flex;width:calc(100% + 4px);margin:4px -2px;min-width:0}',
      // The sidebar footer row, matched to the shell's own rows (`sidebar.settings`
      // is 42px tall, 12px radius, 14px/22px type, 8px gap): an entry that does not
      // share those numbers reads as stray text next to the real modules.
      '.dshp-headerBtn{cursor:pointer;box-sizing:border-box;width:100%;min-width:0;height:42px;border:0;background:0 0;color:var(--dsw-alias-label-primary,inherit);border-radius:12px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;font-weight:500;line-height:22px;display:flex;align-items:center;gap:8px;overflow:hidden}',
      '.dshp-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dshp-headerBtnOn{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.18))}',
      // The mark wears its own framed tile. The tile is a DARK wash with a light
      // glyph in dark mode (and the reverse in light): a bright chip with a pale
      // spade on it was the one thing in the rail that shouted, and the glyph still
      // read as washed out.
      '.dshp-iconTile{flex:none;width:24px;height:24px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16));border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.45))}',
      // A collapsed rail keeps the round 36px target the other rows use.
      '.dshp-headerBtnRail{width:36px;height:36px;justify-content:center;gap:0;padding:0;border-radius:50%}',
      // The smaller tile for a card head, where the row is compact.
      '.dshp-iconTileSm{width:18px;height:18px;border-radius:5px}',
      // The glyph is DRAWN, not typed: an emoji in the sidebar rail renders as a
      // small washed-out mono shape that varies per font, which read as "看不清".
      '.dshp-icon{display:block;flex:none;opacity:.95}',
      '.dshp-headerState{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;white-space:nowrap}',
      '.dshp-headerLabel{color:var(--dsw-alias-label-primary,inherit)}',
      // The panel floats ABOVE the page without covering it: no backdrop, fixed
      // position, and draggable by its header so the reader can scroll the
      // conversation underneath while the table stays in view.
      '.dshp-panel{position:fixed;z-index:100;width:660px;max-width:min(95vw,740px);max-height:calc(100vh - 110px);display:flex;flex-direction:column;overflow:auto;box-sizing:border-box;background:var(--dsw-specific-menu,#1f1f22);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:16px;padding:10px;box-shadow:var(--dsw-elevation-prominent,0 14px 36px rgba(0,0,0,.5))}',
      // The panel is a column: the table keeps its size (`flex:none`) and the
      // BOTTOM is capped, so its two columns scroll inside themselves while the
      // felt stays put. Only a really short window scrolls the panel.
      '.dshp-root{display:flex;flex-direction:column;min-height:0}',
      '.dshp-bottom{display:flex;align-items:stretch;gap:10px;flex:0 1 auto;min-height:150px;max-height:236px;overflow:hidden}',
      '.dshp-main,.dshp-side{min-height:0;max-height:100%;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:transparent transparent}',
      '.dshp-panel{scrollbar-width:thin;scrollbar-color:transparent transparent}',
      // A SLIM scrollbar that is invisible until the pointer is ON THE BAR ITSELF
      // (or dragging it): pointing at the column's content leaves the module
      // looking like a panel of content instead of a box with a track down its
      // side. The default Windows bar is 17px of permanent furniture.
      '.dshp-main::-webkit-scrollbar,.dshp-side::-webkit-scrollbar,.dshp-log::-webkit-scrollbar,.dshp-panel::-webkit-scrollbar,.dshp-coachWinBody::-webkit-scrollbar{width:6px;height:6px}',
      '.dshp-main::-webkit-scrollbar-track,.dshp-side::-webkit-scrollbar-track,.dshp-log::-webkit-scrollbar-track,.dshp-panel::-webkit-scrollbar-track,.dshp-coachWinBody::-webkit-scrollbar-track{background:transparent}',
      '.dshp-main::-webkit-scrollbar-thumb,.dshp-side::-webkit-scrollbar-thumb,.dshp-log::-webkit-scrollbar-thumb,.dshp-panel::-webkit-scrollbar-thumb,.dshp-coachWinBody::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}',
      '.dshp-main::-webkit-scrollbar-thumb:hover,.dshp-side::-webkit-scrollbar-thumb:hover,.dshp-log::-webkit-scrollbar-thumb:hover,.dshp-panel::-webkit-scrollbar-thumb:hover,.dshp-coachWinBody::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.6)}',
      '.dshp-main::-webkit-scrollbar-thumb:active,.dshp-side::-webkit-scrollbar-thumb:active,.dshp-log::-webkit-scrollbar-thumb:active,.dshp-panel::-webkit-scrollbar-thumb:active,.dshp-coachWinBody::-webkit-scrollbar-thumb:active{background:rgba(127,127,127,.85)}',
      // Firefox has no per-part styling and cannot reveal a bar on hover, so it gets
      // a dim but always-visible thumb instead of an invisible one.
      '@supports not selector(::-webkit-scrollbar){.dshp-main,.dshp-side,.dshp-panel,.dshp-coachWinBody{scrollbar-color:rgba(127,127,127,.4) transparent}}',
      '.dshp-panelHead{display:flex;align-items:center;gap:8px;padding:0 2px 6px;cursor:move;user-select:none}',
      '.dshp-panelHeadPinned{cursor:default}',
      '.dshp-headGrow{flex:1;min-width:0}',
      '.dshp-iconBtn{cursor:pointer;border:1px solid transparent;background:0 0;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:13px;line-height:1;padding:2px 6px;border-radius:6px}',
      // The teaching switch is an ordinary toolbar icon: it uses the SAME button
      // rules as the pin (same size, same hover, same "on" amber) instead of a
      // chip of its own, so the title bar reads as one toolbar.
      '.dshp-iconBtn:hover{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit)}',
      '.dshp-iconBtnOn{background:rgba(255,209,102,.2);border-color:rgba(255,209,102,.65);color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      // A squeezed table shrinks the board a little rather than spilling it over
      // the rail. The felt is a container, so this reacts to the TABLE's width,
      // not the window's - the same card is 640px in the panel and ~380px in a
      // narrow transcript column.
      '@container (max-width:520px){',
      '.dshp-card{width:31px;height:43px}',
      '.dshp-cardRank{font-size:13px}',
      '.dshp-cardSuit{font-size:10px}',
      '.dshp-mini{width:19px;height:26px}',
      '.dshp-heroCard{width:27px;height:37px}',
      // A short felt has to fit a column in the middle AND a seat tile at the
      // bottom, so the tiles get a little tighter too - otherwise the caption
      // lands on the hero's card in a narrow transcript column.
      '.dshp-seat{padding:3px 4px;gap:1px}',
      '.dshp-avatar{width:19px;height:19px;font-size:11px}',
      '.dshp-seatName,.dshp-seatChips{font-size:11px}',
      '.dshp-center{width:80%;gap:6px;top:40%}',
      '.dshp-pot{padding:2px 11px 2px 5px;font-size:13px}',
      '.dshp-bb{font-size:9px}',
      '}',
      '.dshp-close{cursor:pointer;border:0;background:0 0;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:16px;line-height:1;padding:2px 6px;border-radius:6px}',
      '.dshp-close:hover{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16))}',
    ].join('');
    const tagId = 'dsh-plugin-poker/client.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-poker';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** Thousands-separated chips. */
    const chips = (value) => Number(value || 0).toLocaleString('en-US');

    /** The table's big blind, used for every BB conversion. */
    const blindOf = (view) => (view && Number(view.bigBlind) > 0 ? Number(view.bigBlind) : 0);

    /**
     * A stack or bet expressed in big blinds, the unit serious players actually
     * think in: "3.5BB" says more about a bet than "350" does.
     * @param amount - chips.
     * @param view - the table view carrying the blind.
     * @returns the label, or null when the blind is unknown.
     */
    function bbLabel(amount, view) {
      const blind = blindOf(view);
      if (blind <= 0) return null;
      const value = Number(amount || 0) / blind;
      const rounded = Math.round(value * 10) / 10;
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + 'BB';
    }

    /** `1,250 (12.5BB)` — chips with the BB equivalent in a readable pill. */
    function chipsWithBB(amount, view, variant) {
      const label = bbLabel(amount, view);
      if (!label) return chips(amount);
      return [chips(amount), React.createElement('span', { className: 'dshp-bb' + (variant ? ' ' + variant : ''), key: 'bb' }, label)];
    }

    /**
     * The hand log's lines for the street being played: everything after the last
     * `发牌：` line (or after the hand's opening line when there is no board yet).
     * @param view - the table view.
     * @returns the log lines of the current street.
     */
    function streetLines(view) {
      const lines = Array.isArray(view.log) ? view.log : [];
      let start = 0;
      for (let index = 0; index < lines.length; index += 1) {
        if (/^\u2014\u2014 \u7b2c \d+ \u624b\u724c\u5f00\u59cb/.test(lines[index])) start = index;
      }
      for (let index = start; index < lines.length; index += 1) {
        if (/^\u53d1\u724c\uff1a/.test(lines[index])) start = index;
      }
      return lines.slice(start);
    }

    /**
     * How many raises the current street has already seen, read from the hand log
     * this plugin itself writes. Used to name the hero's raise correctly: an
     * opening raise is an `open`, the next one is a `3-bet`, and so on.
     * @param view - the table view.
     * @returns `{ raises, heroChecked }` for the current street.
     */
    function streetHistory(view) {
      const heroName = view.players && view.players[0] ? view.players[0].name : null;
      let raises = 0;
      let heroChecked = false;
      for (const line of streetLines(view)) {
        if (/(\u52a0\u6ce8|\u4e0b\u6ce8|\u5168\u4e0b)\u5230 /.test(line)) raises += 1;
        if (heroName && line.indexOf(heroName) !== -1 && /\u8fc7\u724c/.test(line)) heroChecked = true;
      }
      return { raises, heroChecked };
    }

    /** A raise's poker name for a given raise count on a given street. */
    function raiseTerm(street, raises) {
      if (street === 'preflop') return raises === 1 ? 'open' : (raises + 1) + '-bet';
      if (raises === 1) return 'bet';
      if (raises === 2) return 'raise';
      return raises + '-bet';
    }

    /** The short name of a coach action, for a badge that must stay one line. */
    const ADVICE_SHORT = {
      fold: '\u5f03\u724c',
      check: '\u8fc7\u724c',
      call: '\u8ddf\u6ce8',
      bet: '\u4e0b\u6ce8',
      raise: '\u52a0\u6ce8',
      allin: '\u5168\u4e0b',
    };

    /**
     * The coach's verdict as a badge label: the move, not the argument.
     *
     * The window head has room for two characters and a colour, so the headline
     * ("弃牌：K9s（同花）在关池位 CO 太弱…") is carried as the tooltip and spelled
     * out in the plan section underneath instead of being truncated here.
     * @param plan - `{ action, headline }` from the coach payload.
     * @returns a short label like `弃牌`.
     */
    function shortAdvice(plan) {
      if (!plan) return '';
      if (plan.action && ADVICE_SHORT[plan.action]) return ADVICE_SHORT[plan.action];
      // No action key (an older payload): take the words before any explanation.
      return String(plan.headline || '').split(/[\uff1a\uff0c,\uff08(]/)[0].trim().slice(0, 6);
    }

    /**
     * What every seat has done on THIS street, in poker terms.
     *
     * The tile used to say "加注到 300", which is the number and not the move: a
     * player learning the game wants to see that seat OPENED or 3-BET, the same
     * word the raise button carries. Read from the same log lines the hero's own
     * button uses, so the two can never disagree.
     * @param view - the table view.
     * @returns a Map of seat number to term.
     */
    function streetTerms(view) {
      const terms = new Map();
      const players = Array.isArray(view.players) ? view.players : [];
      let raises = 0;
      const checked = new Set();
      for (const line of streetLines(view)) {
        const text = String(line);
        const actor = players.find((player) => player.name && text.startsWith(player.name));
        if (!actor) continue;
        if (/\u8fc7\u724c/.test(text)) {
          checked.add(actor.seat);
          continue;
        }
        if (!/(\u52a0\u6ce8|\u4e0b\u6ce8|\u5168\u4e0b)\u5230 /.test(text)) continue;
        raises += 1;
        const term = raiseTerm(view.street, raises);
        terms.set(actor.seat, view.street === 'preflop' || term === 'bet' ? term : (checked.has(actor.seat) ? 'check-raise' : term));
      }
      return terms;
    }

    /**
     * The poker name of the raise the hero is about to make: preflop that is
     * open / 3-bet / 4-bet; postflop a bet, a raise, a check-raise, or a re-raise.
     * @param view - the table view.
     * @returns `{ tag, en, why }` - a short label, its English term, and one line
     *   of explanation for the button's tooltip.
     */
    function raiseVocabulary(view) {
      const { raises, heroChecked } = streetHistory(view);
      if (view.street === 'preflop') {
        if (raises === 0) return { tag: '\u5f00\u6c60', en: 'open', why: '\u7ffb\u724c\u524d\u65e0\u4eba\u5165\u6c60\uff0c\u7b2c\u4e00\u4e2a\u52a0\u6ce8\u53eb\u5f00\u6c60 open' };
        if (raises === 1) return { tag: '3-bet', en: '3-bet', why: '\u6709\u4eba\u5f00\u6c60\u540e\u4f60\u518d\u52a0\u6ce8\uff0c\u53eb 3-bet' };
        if (raises === 2) return { tag: '4-bet', en: '4-bet', why: '\u5bf9 3-bet \u7684\u518d\u52a0\u6ce8\uff0c\u53eb 4-bet' };
        return { tag: (raises + 1) + '-bet', en: (raises + 1) + '-bet', why: '\u8fde\u7eed\u52a0\u6ce8\u7684\u7b2c ' + (raises + 1) + ' \u7ea7' };
      }
      if (Number(view.currentBet || 0) === 0) {
        return { tag: '\u4e0b\u6ce8', en: 'bet', why: '\u672c\u8857\u65e0\u4eba\u4e0b\u6ce8\uff0c\u4f60\u4e3b\u52a8\u6295\u6ce8\u53eb\u4e0b\u6ce8 bet' };
      }
      if (heroChecked) {
        return { tag: '\u8fc7\u724c-\u52a0\u6ce8', en: 'check-raise', why: '\u4f60\u5148\u8fc7\u724c\u3001\u5bf9\u624b\u4e0b\u6ce8\u540e\u4f60\u518d\u52a0\u6ce8\uff0c\u53eb\u8fc7\u724c-\u52a0\u6ce8 check-raise' };
      }
      if (raises === 0) return { tag: '\u52a0\u6ce8', en: 'raise', why: '\u9762\u5bf9\u4e0b\u6ce8\u63d0\u9ad8\u4ef7\u683c\uff0c\u53eb\u52a0\u6ce8 raise' };
      return { tag: '\u518d\u52a0\u6ce8', en: 're-raise', why: '\u5bf9\u52a0\u6ce8\u7684\u518d\u52a0\u6ce8\uff0c\u53eb\u518d\u52a0\u6ce8 re-raise' };
    }

    /**
     * Is the hero's raise the FIRST voluntary bet of this street?
     *
     * Preflop the big blind is a forced bet, not something to raise, so "nobody
     * has raised yet" means this is an OPEN. That is the same test the button's
     * own vocabulary uses, which is what keeps the two from disagreeing - and it
     * is what decides whether a size is measured against the pot on the table or
     * against the pot after a call.
     * @param view - the table view.
     * @returns true for an open bet, false for a raise over a real bet.
     */
    function openingBet(view) {
      return streetHistory(view).raises === 0;
    }

    /**
     * How big one bet is relative to the pot, the size players actually compare
     * across streets: `1/2` is a half-pot bet, `1` is a pot-sized raise.
     *
     * An OPEN is measured against the pot before the action - the number on the
     * table. A RAISE is measured against the pot AFTER the call (`pot + toCall`),
     * because "a pot-sized raise" means raising by what the pot will hold once you
     * have called. The sizing helper prints which one it used, so the reader can
     * check the arithmetic by eye.
     * @param view - the table view.
     * @param toCall - chips owed before raising.
     * @param amount - the raise's total this street.
     * @returns a short label like `≈ 0.5 池`, or a dash when it cannot be told.
     */
    function potShareLabel(view, toCall, amount) {
      const pot = Number(view.pot || 0);
      const current = Number(view.currentBet || 0);
      const open = openingBet(view);
      const base = open ? pot : pot + Number(toCall || 0);
      const value = Number(amount);
      if (!Number.isFinite(value) || value <= 0 || base <= 0) return '\u2248 \u2014';
      const fraction = open ? value / base : (value - current) / base;
      const rounded = Math.round(fraction * 100) / 100;
      return '\u2248 ' + String(rounded) + ' \u6c60';
    }

    /** Suit glyphs by suit char. */
    const SUITS = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };

    /** A card code's rank, with T displayed as 10. */
    const rankLabel = (code) => (String(code)[0] || '').toUpperCase().replace('T', '10');

    /** A card code's suit char. */
    const suitOf = (code) => String(code || '')[1] ? String(code)[1].toLowerCase() : '';

    // ---- reading the live table out of the session's own event window -------

    /**
     * The plugin's client context, captured at activation. Registered components
     * are plain functions handed straight to the slot registry, so they resolve
     * services through this rather than through an extra wrapper (and the
     * per-click lookup means a service that appears later is still found).
     */
    let pluginCtx = null;

    /** The sessions service, resolved lazily on every use. */
    function getSessions() {
      return pluginCtx ? pluginCtx.get('sessions') : undefined;
    }

    /**
     * The newest table this page has seen per session, as
     * `sessionId -> { view, revision, stepSeq, queue, timer }`.
     *
     * A click answers with a fresh view that no session event carries yet, so
     * the page keeps it here and the panel merges it against the log by
     * revision. The same record drives the replay: the answer also carries the
     * hand's action log, and the unseen entries are applied one at a time so the
     * opponents' moves are visible as a process instead of resolving instantly.
     *
     * It hangs off `window` rather than living in this closure because the host
     * swaps a rebuilt client bundle in place: a reload must not throw away the
     * table the player is looking at and snap back to whatever the session log
     * last recorded.
     */
    const TABLE_CACHE = (() => {
      if (typeof window === 'undefined') return new Map();
      if (!(window.__dshPokerTables instanceof Map)) window.__dshPokerTables = new Map();
      return window.__dshPokerTables;
    })();

    /** Surfaces subscribed to local cache updates. */
    const CACHE_LISTENERS = new Set();

    /**
     * The table this page last saw, remembered across sessions and reloads.
     *
     * The host keeps ONE table for everybody, but a browser session that has
     * never touched poker has nothing in its own event log to show. This key is
     * how such a session finds the game: it is written whenever a view arrives
     * and used to ask the host which table it is playing (`/poker/current`).
     */
    const SHARED_TABLE_KEY = 'dsh-poker-current-table';
    let SHARED_TABLE_ID = null;
    /**
     * The cache key the app-wide surface uses.
     *
     * The sidebar panel is mounted ONCE, outside any conversation, so its replay
     * state needs one fixed key rather than a session id: switching conversations
     * must not look like a fresh table that has to be replayed from the start.
     */
    const SHARED_CACHE_KEY = '__dsh-poker-shared__';
    /** Sessions that have already asked the host for the shared table. */
    const TABLE_DISCOVERED = new Set();

    /** Note which table this page is looking at, for later sessions and reloads. */
    function rememberTable(tableId) {
      if (typeof tableId !== 'string' || tableId === '') return;
      SHARED_TABLE_ID = tableId;
      try {
        if (globalThis.localStorage) globalThis.localStorage.setItem(SHARED_TABLE_KEY, tableId);
      } catch (error) {
        // Private mode, a full quota: the in-memory id still covers this page.
      }
    }

    /** The remembered table id, from this page or from the last one. */
    function rememberedTable() {
      if (SHARED_TABLE_ID !== null) return SHARED_TABLE_ID;
      try {
        SHARED_TABLE_ID = globalThis.localStorage ? globalThis.localStorage.getItem(SHARED_TABLE_KEY) : null;
      } catch (error) {
        SHARED_TABLE_ID = null;
      }
      return SHARED_TABLE_ID;
    }

    /**
     * Ask the host for the table everybody shares and adopt it into this session.
     *
     * Without this, moving from one conversation to another looked like the game
     * had vanished: the second session's log holds no poker call, so its panel
     * offered to open a table while the first one was mid-hand.
     *
     * Two request shapes, on purpose. When this page remembers a table id it asks
     * for THAT table (`/poker/table`, an op every version of the host has) - one
     * request, and it works against a host that predates the shared-table change.
     * If that id is dead (the host restarted, or the table was replaced) it asks
     * the discovery op instead, so a stale memory can never wedge the panel.
     * @param sessionId - the session to seed.
     * @param options.force - ask again even if this session already asked once.
     */
    function discoverSharedTable(sessionId, options = {}) {
      if (!sessionId) return;
      if (!options.force && TABLE_DISCOVERED.has(sessionId)) return;
      TABLE_DISCOVERED.add(sessionId);
      if (typeof fetch !== 'function') return;
      // What this session is showing right now. When the answer lands it is only
      // applied if that is STILL the case: a click that opened or advanced a table
      // in the meantime is fresher than a discovery that set off before it.
      const before = TABLE_CACHE.get(sessionId);
      const beforeTable = before && before.view ? before.view.tableId : null;
      const post = (path, body) => fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then((response) => response.json());
      const adopt = (answer) => {
        if (!answer || answer.ok !== true || !answer.view) return false;
        const now = TABLE_CACHE.get(sessionId);
        const nowTable = now && now.view ? now.view.tableId : null;
        if (nowTable !== beforeTable) return false;
        // A refused click is showing a message the player is reading: a
        // background sync must not wipe it.
        if (now && now.view && now.view.notice) return false;
        // Never overwrite a hand this page is in the middle of replaying, and never
        // overwrite a newer local answer: the sync is a catch-up, so anything the
        // player just did outranks it.
        if (now && now.view && now.view.resolving) return false;
        if (now && now.view && now.view.tableId === answer.view.tableId && (now.revision ?? 0) > (answer.view.revision ?? 0)) return false;
        // A SYNC, not a hand being played: land the snapshot itself. Replaying the
        // unseen moves here is what made a conversation switch feel like watching
        // the same hand all over again.
        TABLE_CACHE.set(sessionId, {
          view: answer.view,
          revision: answer.view.revision ?? 0,
          stepSeq: answer.view.actionSeq ?? 0,
          queue: [],
          timer: null,
          final: null,
          chain: [],
        });
        rememberTable(answer.view.tableId);
        notifyCache();
        return true;
      };
      const remembered = rememberedTable();
      return post(remembered ? '/poker/table' : '/poker/current', remembered ? { tableId: remembered } : {})
        .then((answer) => {
          if (adopt(answer)) return undefined;
          // A remembered table that no longer exists is the stale case that used
          // to wedge this: the host has moved on, so ask it what it is playing.
          if (!remembered) {
            if (typeof console !== 'undefined') {
              console.warn('poker: this host does not answer /poker/current yet, and this page has no table id to ask about');
            }
            return undefined;
          }
          return post('/poker/current', {}).then((second) => {
            if (!adopt(second) && typeof console !== 'undefined') {
              console.warn('poker: the remembered table is gone and the host reports no current table');
            }
            return undefined;
          });
        })
        .catch((error) => {
          if (typeof console !== 'undefined') console.warn('poker: cannot read the shared table', error);
        });
    }

    // ---- the optional teaching layer ---------------------------------------

    /** Where the coach on/off choice is remembered. */
    const COACH_KEY = 'dsh-plugin-poker/coach';

    /** Surfaces subscribed to the coach toggle. */
    const COACH_LISTENERS = new Set();

    /**
     * Whether the coaching layer is shown. Optional on purpose: a player who
     * wants to read the table alone can switch the whole layer off, and the
     * choice is remembered for the next visit.
     */
    let coachOn = (() => {
      try {
        const raw = window.localStorage ? window.localStorage.getItem(COACH_KEY) : null;
        return raw === null ? true : raw === 'on';
      } catch (error) {
        return true;
      }
    })();

    /** Turn the teaching layer on or off, everywhere, and remember it. */
    function setCoachOn(next) {
      coachOn = next === true;
      try {
        if (window.localStorage) window.localStorage.setItem(COACH_KEY, coachOn ? 'on' : 'off');
      } catch (error) {
        // A preference that cannot be stored still applies to this page.
      }
      for (const listener of COACH_LISTENERS) {
        try {
          listener();
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: coach listener failed', error);
        }
      }
    }

    /** Subscribe one surface to the coach toggle. */
    function useCoachOn() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        COACH_LISTENERS.add(bump);
        return () => COACH_LISTENERS.delete(bump);
      }, []);
      return coachOn;
    }

    /**
     * Which analysis sections the reader folded away, as `{ sectionId: true }`.
     *
     * Kept beside the coach switch rather than in component state so the fold
     * survives a re-render of any surface, and so the window can offer "fold all"
     * without owning a second copy of the truth.
     */
    let foldedSections = {};

    /** Surfaces subscribed to the fold state. */
    const FOLD_LISTENERS = new Set();

    /** Fold or unfold one section. */
    function setSectionFolded(id, next) {
      foldedSections = { ...foldedSections, [id]: next === true };
      for (const listener of FOLD_LISTENERS) {
        try {
          listener();
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: fold listener failed', error);
        }
      }
    }

    /** Fold or unfold every section at once. */
    function setAllSectionsFolded(ids, next) {
      const updated = { ...foldedSections };
      for (const id of ids) updated[id] = next === true;
      foldedSections = updated;
      for (const listener of FOLD_LISTENERS) {
        try {
          listener();
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: fold listener failed', error);
        }
      }
    }

    /** Subscribe one surface to the fold state. */
    function useFoldedSections() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        FOLD_LISTENERS.add(bump);
        return () => FOLD_LISTENERS.delete(bump);
      }, []);
      return foldedSections;
    }

    /**
     * Where each floating window sits, and whether it is pinned.
     *
     * Kept here rather than in component state for two reasons: a drag must
     * survive any re-render (the table re-renders on every replay beat), and the
     * two windows must never share a slot - a drag of one must not move the other.
     */
    const WINDOW_STATE = new Map();

    /** Surfaces subscribed to a window move. */
    const WINDOW_LISTENERS = new Set();

    /** Tell every window surface that a position or pin changed. */
    function notifyWindows() {
      for (const listener of WINDOW_LISTENERS) {
        try {
          listener();
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: window listener failed', error);
        }
      }
    }

    /** One window's `{ position, pinned }`, read from storage on first use. */
    function windowState(key, width) {
      if (!WINDOW_STATE.has(key)) {
        const stored = readWindowLayout(key);
        WINDOW_STATE.set(key, { position: clampWindowPosition(stored.position, width), pinned: stored.pinned === true });
      }
      return WINDOW_STATE.get(key);
    }

    /** Move a window (memory only; {@link persistWindowState} writes it down). */
    function setWindowPosition(key, position, width) {
      const current = windowState(key, width);
      WINDOW_STATE.set(key, { ...current, position: clampWindowPosition(position, width) });
      notifyWindows();
    }

    /** Pin or unpin a window, remembering the choice immediately. */
    function setWindowPinned(key, pinned, width) {
      const current = windowState(key, width);
      WINDOW_STATE.set(key, { ...current, pinned: pinned === true });
      writeWindowLayout(key, current.position, pinned === true);
      notifyWindows();
    }

    /** Write a window's layout down, at the end of a drag. */
    function persistWindowState(key) {
      const current = WINDOW_STATE.get(key);
      if (current) writeWindowLayout(key, current.position, current.pinned);
    }

    /** Subscribe one surface to a window's position and pin. */
    function useWindowState(key, width) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        WINDOW_LISTENERS.add(bump);
        return () => WINDOW_LISTENERS.delete(bump);
      }, []);
      return windowState(key, width);
    }

    /**
     * The teaching switch: one icon, no label.
     *
     * It appears in the poker panel's title bar and in every inline card's title
     * row, and it drives one shared preference, so the analysis window opens
     * wherever the player is looking from.
     */
    function CoachToggle() {
      const on = useCoachOn();
      return React.createElement(
        'button',
        {
          // `dshp-teachToggle` is only a hook for tests and for the store; the look
          // comes from `dshp-iconBtn`, exactly like the pin beside it.
          className: 'dshp-iconBtn dshp-teachToggle' + (on ? ' dshp-iconBtnOn' : ''),
          type: 'button',
          'data-teach': on ? 'on' : 'off',
          title: on
            ? '\u6559\u7ec3\u5df2\u5f00\uff1a\u70b9\u4e00\u4e0b\u5173\u6389\u6559\u5b66\u7a97\u53e3\uff08\u5168\u51ed\u81ea\u5df1\u5206\u6790\uff09'
            : '\u6559\u7ec3\u5df2\u5173\uff1a\u70b9\u4e00\u4e0b\u6253\u5f00\u6559\u5b66\u7a97\u53e3\uff08\u8bfb\u724c\u3001\u4e0b\u6ce8\u903b\u8f91\u3001\u6570\u5b66\uff09',
          onClick: (event) => {
            // The title bars are draggable, so a click here must not start a drag.
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            setCoachOn(!on);
          },
          onPointerDown: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          },
        },
        '\u{1F4A1}',
      );
    }

    /**
     * The analysis sections, rendered straight from the host's payload.
     *
     * Clicking a section title folds it away, which is what keeps a seven-section
     * analysis readable in one window.
     * @param coach - the host's coach payload.
     * @param folded - `{ sectionId: true }` for the sections the reader collapsed.
     * @param onToggle - called with a section id to fold or unfold it.
     */
    function coachSections(coach, folded, onToggle) {
      return coach.sections.map((section) => {
        const tone = section.tone === 'good' ? ' dshp-teachGood' : section.tone === 'warn' ? ' dshp-teachWarn' : section.tone === 'bad' ? ' dshp-teachBad' : '';
        const collapsed = folded[section.id] === true;
        const body = collapsed ? [] : [
          ...(section.lines || []).map((line, index) => React.createElement('div', { className: 'dshp-teachLine', key: 'l' + index }, line)),
          ...(section.items || []).map((item, index) => React.createElement(
            'div',
            { className: 'dshp-teachItem', key: 'i' + index },
            React.createElement('span', { className: 'dshp-teachItemLabel' }, item.label + '\uff1a'),
            item.text,
          )),
          ...((section.tags || []).length > 0
            ? [React.createElement('div', { className: 'dshp-teachTags', key: 'tags' },
                section.tags.map((tag) => React.createElement('span', { className: 'dshp-tag', key: tag.term, title: tag.why }, tag.term + ' ' + tag.zh)))]
            : []),
        ];
        return React.createElement(
          'div',
          { className: 'dshp-teachSec' + tone, key: section.id },
          React.createElement(
            'div',
            {
              className: 'dshp-teachSecTitle',
              title: collapsed ? '\u70b9\u5f00\u8fd9\u4e00\u8282' : '\u6536\u8d77\u8fd9\u4e00\u8282',
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                if (typeof onToggle === 'function') onToggle(section.id);
              },
            },
            React.createElement('span', { className: 'dshp-teachCaret' }, collapsed ? '\u25b8' : '\u25be'),
            (section.icon ? section.icon + ' ' : '') + section.title,
          ),
          body,
        );
      });
    }

    /** Where the teaching window sits, remembered apart from the table panel. */
    const COACH_LAYOUT_KEY = 'dsh-plugin-poker/coach-window';

    /** The style the host reports running, or null for a host that predates the field. */
    function hostModeOf(coach) {
      const value = coach && coach.settingsMode;
      return value === 'gto' || value === 'simple' ? value : null;
    }

    /**
     * The teaching window: its own floating panel, so the analysis never grows
     * the table panel into a wall of text. It opens on the LEFT by default (the
     * table panel defaults to the right), drags by its title bar and pins like
     * every other window here.
     */
    function CoachWindow(props) {
      const on = useCoachOn();
      const [dragging, setDragging] = React.useState(false);
      const [switching, setSwitching] = React.useState(false);
      const [pendingMode, setPendingMode] = React.useState(null);
      const [switchNotice, setSwitchNotice] = React.useState('');
      const folded = useFoldedSections();
      const layout = useWindowState(COACH_LAYOUT_KEY, 452);
      const settings = usePluginSettings();
      const pinned = layout.pinned === true;
      const position = layout.position;
      const view = props.view;
      const coach = view && view.coach;
      // Hooks first, unconditionally: this window renders nothing whenever the teaching
      // layer is off or the payload has no analysis, and a hook below that early return
      // would change the hook count the moment the layer came back on.
      React.useEffect(() => {
        if (!pendingMode) return undefined;
        if (hostModeOf(coach) === null) {
          setSwitchNotice('\u5df2\u4fdd\u5b58\u5230\u8bbe\u7f6e\uff1b\u5f53\u524d\u5bbf\u4e3b\u8fd8\u4e0d\u8ba4\u5f97\u6559\u7ec3\u98ce\u683c\uff0c\u91cd\u542f\u4e00\u6b21 dsh web \u540e\u751f\u6548');
          setPendingMode(null);
          return undefined;
        }
        if (hostModeOf(coach) === pendingMode) {
          setSwitchNotice('');
          setPendingMode(null);
          return undefined;
        }
        const timer = setTimeout(() => {
          setSwitchNotice('\u5df2\u4fdd\u5b58\uff0c\u4f46\u5f53\u524d\u724c\u684c\u8fd8\u6ca1\u6362\u8fc7\u6765\uff1a\u91cd\u542f\u4e00\u6b21 dsh web \u540e\u751f\u6548');
          setPendingMode(null);
        }, 2500);
        return () => clearTimeout(timer);
      }, [pendingMode, coach && coach.settingsMode]);
      if (!on || !coach || !Array.isArray(coach.sections) || coach.sections.length === 0) return null;
      const plan = coach.plan || null;
      // The switcher shows the SETTING the host is running, not the mode of this payload:
      // GTO is a postflop layer, so a preflop payload comes from the simple plan even in
      // GTO mode, and highlighting the payload made the button jump back every preflop.
      // `settingsMode` comes from the host; the local setting is the fallback for a host
      // that predates it.
      const hostMode = hostModeOf(coach);
      const coachMode = hostMode !== null ? hostMode : (settings.coachMode === 'gto' ? 'gto' : 'simple');
      /**
       * Persist the style, then make the table re-read it - and VERIFY it took.
       *
       * A style change cannot take effect in this page: only the host computes the coach.
       * So the click writes the setting, pulls the fresh table, and then watches for the
       * host to report the new style. A host that has not been restarted since the style
       * became switchable simply never reports it, which is worth saying out loud
       * instead of leaving a button that appears to do nothing.
       */
      const chooseCoachMode = async (mode) => {
        if (mode === coachMode || switching) return;
        setSwitching(true);
        setSwitchNotice('');
        try {
          await fetch('/poker/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ coachMode: mode }),
          });
          await loadPluginSettings(true);
          setPendingMode(mode);
          refreshTables();
        } catch (error) {
          setSwitchNotice('\u4fdd\u5b58\u5931\u8d25\uff1a\u5bbf\u4e3b\u9762\u677f\u8fd8\u6ca1\u8fde\u4e0a');
        } finally {
          setSwitching(false);
        }
      };
      const switchLine = switchNotice
        ? React.createElement('div', { className: 'dshp-modeNotice' }, switchNotice)
        : null;
      const planTone = plan && plan.tone === 'good' ? ' dshp-coachPlanGood' : plan && plan.tone === 'warn' ? ' dshp-coachPlanWarn' : plan && plan.tone === 'bad' ? ' dshp-coachPlanBad' : '';
      const sectionIds = coach.sections.map((section) => section.id);
      const allFolded = sectionIds.every((id) => folded[id] === true);
      const style = position && typeof position.x === 'number' && typeof position.y === 'number'
        ? { left: position.x + 'px', top: position.y + 'px' }
        : { left: '20px', top: '68px' };
      const stopPress = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      };
      return React.createElement(
        'div',
        { className: 'dshp-coachWin' + (pinned ? ' dshp-coachWinPinned' : ''), style },
        React.createElement(
          'div',
          {
            className: 'dshp-coachWinHead' + (pinned ? ' dshp-coachWinHeadPinned' : '') + (dragging ? ' dshp-dragging' : ''),
            onPointerDown: startWindowDrag({
              pinned,
              moveTo: (next) => setWindowPosition(COACH_LAYOUT_KEY, next, 452),
              drop: () => persistWindowState(COACH_LAYOUT_KEY),
              onDragChange: setDragging,
            }),
            title: pinned ? '\u5df2\u56fa\u5b9a\uff1a\u70b9 \u{1F4CC} \u89e3\u9664\u540e\u624d\u80fd\u62d6\u52a8' : '\u62d6\u52a8\u6807\u9898\u680f\u53ef\u79fb\u52a8\u6559\u7ec3\u7a97\u53e3',
          },
          React.createElement('span', { className: 'dshp-coachWinTitle' }, coach.mode === 'gto' ? '\u265f GTO \u6559\u7ec3' : '\u{1F393} \u6559\u7ec3'),
          // The style is switchable right here, not only in the settings: it is a way of
          // LOOKING at the same spot, so the reading decides when to change it. The write
          // goes to the settings route (so it sticks), and the host re-saves the table so
          // the analysis on screen changes immediately.
          React.createElement(
            'span',
            { className: 'dshp-modeSwitch', title: '\u5207\u6362\u6559\u7ec3\u98ce\u683c\uff08\u4f1a\u8bb0\u4f4f\uff09' },
            React.createElement('button', {
              className: 'dshp-modeBtn' + (coachMode === 'simple' ? ' dshp-modeBtnOn' : ''),
              type: 'button',
              onPointerDown: stopPress,
              onClick: (event) => { stopPress(event); chooseCoachMode('simple'); },
            }, '\u7b80\u6d01'),
            React.createElement('button', {
              className: 'dshp-modeBtn' + (coachMode === 'gto' ? ' dshp-modeBtnOn' : ''),
              type: 'button',
              onPointerDown: stopPress,
              onClick: (event) => { stopPress(event); chooseCoachMode('gto'); },
              title: 'GTO\uff1a\u8303\u56f4\u3001\u65e0\u5dee\u70b9\u4e0e\u5404\u52a8\u4f5c EV',
            }, 'GTO'),
          ),
          coach.equity
            ? React.createElement('span', { className: 'dshp-bb dshp-bbPane' }, `\u80dc\u7387\u7ea6 ${Math.round(coach.equity.equity)}% \u00b1${coach.equity.margin}%`)
            : null,
          switchLine,
          plan && plan.headline
            ? React.createElement(
                'span',
                { className: 'dshp-coachPlan' + planTone, title: plan.headline },
                // The pill names the RESULT only: a full sentence ("弃牌：K9s（同花）
                // 在关池位 CO 太弱…") never fits the window head, so it used to be
                // cut off mid-word. The reason is one section below, in full.
                shortAdvice(plan),
              )
            : null,
          React.createElement('span', { className: 'dshp-headGrow' }),
          React.createElement('button', {
            className: 'dshp-iconBtn' + (pinned ? ' dshp-iconBtnOn' : ''),
            type: 'button',
            title: pinned ? '\u5df2\u56fa\u5b9a\uff08\u70b9\u51fb\u89e3\u9664\uff09\uff1a\u4e0d\u53ef\u62d6\u52a8' : '\u56fa\u5b9a\u6559\u7ec3\u7a97\u53e3\uff1a\u4e0d\u53ef\u62d6\u52a8\u3001\u8bb0\u4f4f\u4f4d\u7f6e',
            onPointerDown: stopPress,
            onClick: () => setWindowPinned(COACH_LAYOUT_KEY, !pinned, 452),
          }, '\u{1F4CC}'),
          React.createElement('button', {
            className: 'dshp-close',
            type: 'button',
            title: '\u5173\u6389\u6559\u7ec3\u7a97\u53e3\uff08\u4e0b\u6b21\u53ef\u4ee5\u7528 \u{1F393} \u91cd\u65b0\u6253\u5f00\uff09',
            onPointerDown: stopPress,
            onClick: () => setCoachOn(false),
          }, '\u00d7'),
        ),
        React.createElement('div', { className: 'dshp-coachWinBody' }, coachSections(coach, folded, (id) => setSectionFolded(id, folded[id] !== true))),
        React.createElement(
          'div',
          { className: 'dshp-coachWinFoot' },
          React.createElement('button', {
            className: 'dshp-iconBtn',
            type: 'button',
            title: allFolded ? '\u5c55\u5f00\u5168\u90e8\u5206\u6790' : '\u6536\u8d77\u5168\u90e8\u5206\u6790\uff0c\u53ea\u770b\u6807\u9898',
            onPointerDown: stopPress,
            onClick: () => setAllSectionsFolded(sectionIds, !allFolded),
          }, allFolded ? '\u5c55\u5f00\u5168\u90e8' : '\u6536\u8d77\u5168\u90e8'),
        ),
      );
    }

    /** One "thinking" beat between replayed actions, in milliseconds. */
    const STEP_MS = 820;
    /**
     * Beat before the first card of a new street. The board is laid out one card
     * at a time (see {@link DEAL_CARD_MS}), so this is the pause that lets the
     * player register that the street changed before the cards start moving.
     */
    const DEAL_MS = 1500;

    /**
     * How often to ask the host for the table while an AI seat is thinking. The
     * answer is produced by a background HTTP call, so the page has nothing to
     * listen to - it polls, at a rate that is slow enough to be invisible and fast
     * enough that a reply feels immediate.
     */
    const AI_POLL_MS = 1200;

    /**
     * The plugin's settings, as this page last saw them.
     *
     * Fetched once per page load from the plugin's own route and shared through a
     * listener set, so the panel, the coach window and the table all read the same
     * values. The defaults apply until the first answer lands (and forever if the
     * route is not there, e.g. a headless profile).
     */
    const SETTINGS_DEFAULTS = {
      pluginEnabled: true,
      coachEnabled: true,
      showAdvice: true,
      showLog: true,
      replaySpeed: 1,
      autoOpen: false,
    };
    let PLUGIN_SETTINGS = null;
    const SETTINGS_LISTENERS = new Set();
    /** The pacing multiplier the replay reads, kept in one mutable place. */
    const PACING = { speed: 1 };

    /** Fetch the settings once; `force` re-reads them (after a save). */
    async function loadPluginSettings(force) {
      if (PLUGIN_SETTINGS !== null && force !== true) return PLUGIN_SETTINGS;
      try {
        const response = await fetch('/poker/settings');
        const answer = await response.json();
        if (answer && answer.ok && answer.settings) {
          PLUGIN_SETTINGS = Object.assign({}, SETTINGS_DEFAULTS, answer.settings);
          PACING.speed = Number(PLUGIN_SETTINGS.replaySpeed) > 0 ? Number(PLUGIN_SETTINGS.replaySpeed) : 1;
          for (const listener of SETTINGS_LISTENERS) listener();
        }
      } catch (error) {
        // No route (or a dead one): the defaults stand.
      }
      return PLUGIN_SETTINGS;
    }

    /** The settings for this render, re-rendering when they arrive or change. */
    function usePluginSettings() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        SETTINGS_LISTENERS.add(bump);
        void loadPluginSettings(false);
        return () => SETTINGS_LISTENERS.delete(bump);
      }, []);
      return PLUGIN_SETTINGS === null ? SETTINGS_DEFAULTS : PLUGIN_SETTINGS;
    }

    /**
     * Ask every mounted table surface to re-read the host's table.
     *
     * A setting can change what the HOST computes (the coach style, the AI seats), and
     * only the host knows that: the page has to pull the new view instead of waiting for
     * the next click. Mounted panels register here.
     */
    const TABLE_REFRESHERS = new Set();
    function refreshTables() {
      for (const refresher of TABLE_REFRESHERS) {
        try {
          refresher();
        } catch (error) {
          // A surface that has gone away must not stop the others from refreshing.
        }
      }
    }

    /**
     * Beat between two community cards. Dealing is the slowest thing at a real
     * table, and rushing it is what made the replay feel like a slideshow: the
     * flop lands as three separate cards, the turn and river as single ones.
     */
    const DEAL_CARD_MS = 620;

    /**
     * Longest a whole replay may take. A hand that ran to showdown has dozens of
     * actions; past this the remaining beats compress instead of the player
     * waiting half a minute for the table to catch up.
     */
    const REPLAY_BUDGET_MS = 26000;

    /**
     * Hardest cap on how many unseen actions are replayed one by one. Only a
     * cache that fell far behind (a hidden tab, a long disconnect) can hit this.
     */
    const MAX_REPLAY_STEPS = 120;

    /** Street codes to their Chinese labels, for a replay that crosses streets. */
    const STREET_LABELS = {
      preflop: '\u7ffb\u724c\u524d',
      flop: '\u7ffb\u724c',
      turn: '\u8f6c\u724c',
      river: '\u6cb3\u724c',
      showdown: '\u644a\u724c',
    };

    /**
     * How long to hold one replayed action. Deals and big bets get a longer beat,
     * and the beat drifts a little with the action number so a row of calls does
     * not tick like a metronome - the table should read as people playing.
     * @param step - the action about to be shown.
     * @param previousStreet - the street currently on screen.
     * @param cap - longest beat this replay can afford, from its total budget.
     */
    function stepDelay(step, previousStreet, cap) {
      // One multiplier over every beat, from the plugin's `replaySpeed` setting:
      // the pacing is a taste, and 0.5x / 1x / 2x is all the knob needs to be.
      const speed = PACING.speed;
      let base;
      if (step.deal) {
        // Cards get their own slow, even beat: a deal is not an action, and
        // drifting it would make the flop look like it stuttered. The first card
        // of a street also holds the pause that lets the street land.
        return Math.max(200, Math.min((step.dealFirst ? DEAL_MS : DEAL_CARD_MS) * speed, cap));
      }
      if (step.street && step.street !== previousStreet) base = DEAL_MS;
      else base = STEP_MS + ((step.seq % 3) * 110);
      if (step.action === 'raise' || step.action === 'allin' || step.allIn) base += 200;
      return Math.max(240, Math.min(base * speed, cap));
    }

    /** Apply one replayed action to a view, with no engine involved. */
    function applyStep(view, step, progress) {
      const players = (Array.isArray(view.players) ? view.players : []).map((player) => {
        if (player.seat !== step.seat) return player;
        return Object.assign({}, player, {
          stack: typeof step.stack === 'number' ? step.stack : player.stack,
          streetCommitted: typeof step.streetCommitted === 'number' ? step.streetCommitted : player.streetCommitted,
          lastAction: step.label || player.lastAction,
          folded: step.folded === true,
          allIn: step.allIn === true,
          talk: step.talk || player.talk,
        });
      });
      // The board travels with the step, so a replay that crosses streets lays
      // the flop, turn and river out one at a time rather than all at once.
      const board = Array.isArray(step.board) ? step.board.slice() : view.board;
      const before = Array.isArray(view.board) ? view.board.length : 0;
      const dealt = Array.isArray(step.board) && board.length > before;
      return Object.assign({}, view, {
        players,
        board,
        street: step.street || view.street,
        streetLabel: STREET_LABELS[step.street] || view.streetLabel,
        // `justDealt` is the board size the deal animation runs at, `dealtFrom`
        // the first index that is genuinely new - reveal one card at a time and
        // only that one card animates.
        justDealt: dealt ? board.length : 0,
        dealtFrom: dealt ? before : 0,
        pot: typeof step.pot === 'number' ? step.pot : view.pot,
        currentBet: typeof step.currentBet === 'number' ? step.currentBet : view.currentBet,
        // Spotlight the actor of THIS step, and take the action menu away while
        // the table is still settling so a stale click cannot be dispatched.
        // A deal beat has no actor, so it leaves the spotlight where it was.
        actorSeat: typeof step.seat === 'number' && step.seat >= 0 ? step.seat : view.actorSeat,
        legal: null,
        resolving: true,
        replay: progress && progress.total > 0
          ? { done: progress.done, total: progress.total, seat: step.seat, label: step.deal ? '\u53d1\u724c' : (step.label || '') }
          : view.replay || null,
      });
    }

    /** Tell every surface that the cached table changed. */
    function notifyCache() {
      for (const listener of CACHE_LISTENERS) {
        try {
          listener();
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: cache listener failed', error);
        }
      }
    }

    /**
     * The street a board of `size` cards belongs to, for the deal beats that are
     * synthesised when the last cards arrive with the settle (an all-in run-out
     * deals the turn and river with no action in between).
     * @param size - community cards already out.
     */
    function streetForBoard(size) {
      if (size <= 3) return 'flop';
      return size === 4 ? 'turn' : 'river';
    }

    /**
     * One card of a street, as a replay beat: no actor, no chips, just the board
     * growing by one. `dealFirst` marks the card that opens the street.
     *
     * A deal carries the seq of the LAST ACTION already shown, not the one it is
     * dealing for: if a fresh snapshot lands mid-deal, the action that follows is
     * still "unseen" and gets replayed instead of being skipped.
     * @param step - the host step the cards arrived with.
     * @param board - that step's board.
     * @param size - how many cards are out once this card lands.
     * @param dealFirst - is this the street's first card?
     * @param seq - the seq of the action already on screen.
     */
    function dealBeat(step, board, size, dealFirst, seq) {
      return {
        seq,
        deal: true,
        dealFirst: dealFirst === true,
        seat: -1,
        street: streetForBoard(size),
        board: board.slice(0, size),
        // A dealt card moves no chips: the pot and the bet stand until the action
        // that follows the deal lands on its own beat.
      };
    }

    /**
     * Drive one replay step, rescheduling itself until the queue drains and the
     * authoritative view lands. A test (or a page without timers) gets the same
     * sequence synchronously.
     */
    function scheduleStep(sessionId) {
      const entry = TABLE_CACHE.get(sessionId);
      if (!entry || entry.timer) return;
      if (entry.queue.length === 0) {
        if (entry.final) {
          const onScreen = Array.isArray(entry.view.board) ? entry.view.board.length : 0;
          const target = Array.isArray(entry.final.board) ? entry.final.board.length : 0;
          // Cards that arrived with the settle itself - an all-in run-out deals
          // the rest of the board with no action to hang it on - still come out
          // one at a time instead of appearing all at once at the end.
          if (target > onScreen) {
            const board = entry.final.board;
            for (let size = onScreen + 1; size <= target; size += 1) {
              entry.queue.push(dealBeat(entry.final, board, size, size === onScreen + 1, entry.stepSeq));
            }
            entry.beats = (entry.beats || 0) + (target - onScreen);
            scheduleStep(sessionId);
            return;
          }
          // The authoritative view lands last, so the table ends on the exact
          // state the host holds (stacks, winners, whose turn it is).
          entry.view = entry.final;
          entry.final = null;
          notifyCache();
        }
        return;
      }
      const step = entry.queue[0];
      const total = entry.total || entry.queue.length;
      const cap = Math.max(240, Math.floor(REPLAY_BUDGET_MS / Math.max(1, entry.beats || total)));
      // The hero's own action gets the SAME beat as everyone else's. It used to be
      // applied instantly, which is fine mid-hand but lands right on the opening
      // move of a new hand (the hero is often first to act): your chips would jump
      // while every opponent then took a beat, and the table read as broken.
      const delay = stepDelay(step, entry.view && entry.view.street, cap);
      const run = () => {
        const current = TABLE_CACHE.get(sessionId);
        if (!current || current.queue !== entry.queue) return;
        current.timer = null;
        const taken = current.queue.shift();
        // A beat whose queue was replaced can fire against a drained entry.
        if (!taken) {
          scheduleStep(sessionId);
          return;
        }
        // Dealt cards are not actions: they must not advance the "对手行动中 3/9"
        // counter, which the player reads as how much of the hand is left.
        if (!taken.deal) current.done = (current.done || 0) + 1;
        current.view = applyStep(current.view, taken, { done: current.done, total });
        current.stepSeq = taken.seq;
        notifyCache();
        scheduleStep(sessionId);
      };
      if (typeof setTimeout !== 'function') {
        run();
        return;
      }
      entry.timer = setTimeout(run, delay);
    }

    /**
     * Publish one fresh view, replaying whatever happened in between.
     * @param sessionId - the session being played.
     * @param view - the authoritative view from the host.
     * @param steps - the hand's action log, as the host stamped it.
     * @param options.hold - show the table at the START of the hand and keep the
     *   opponents' moves queued until the player presses 开始 (a table this page
     *   just opened or swapped to).
     */
    function cacheView(sessionId, view, steps, options = {}) {
      if (!sessionId || !view) return;
      // Every view the page sees names the shared table, so another session (or a
      // reload) can find it even though it has no poker call of its own.
      rememberTable(view.tableId);
      const previous = TABLE_CACHE.get(sessionId);
      const revision = view.revision ?? 0;
      // A NEW table starts its own revision counter at 0, so "the old table has a
      // higher revision" is not a reason to ignore it: compare the table id first.
      // Without this, switching tables silently did nothing.
      const switched = Boolean(previous && previous.view && view.tableId && previous.view.tableId
        && previous.view.tableId !== view.tableId);
      if (previous && !switched && previous.revision > revision) return;
      const log = Array.isArray(steps) ? steps : [];

      if (!previous || switched) {
        // First sight of this table (or a different table entirely): nothing to
        // animate from. A GUI-opened table is also HELD here: the reader sees the
        // blinds posted and their own cards, presses 开始, and only then do the
        // opponents move - one beat at a time. Nothing is lost by waiting, and it
        // works whether or not the host paused the table itself.
        const held = options.hold === true && log.length > 0;
        TABLE_CACHE.set(sessionId, {
          view: held ? Object.assign({}, handStartView(view), { awaitingStart: true }) : view,
          revision,
          stepSeq: held ? 0 : view.actionSeq ?? 0,
          queue: [],
          timer: null,
          final: null,
          chain: [],
          held: held ? { view, steps: log } : null,
        });
        notifyCache();
        return;
      }

      const unseen = log.filter((step) => typeof step.seq === 'number' && step.seq > (previous.stepSeq ?? 0));
      // A NEW HAND resets the whole table: folded flags, revealed cards, stacks,
      // the board and the log all start over. The replay must therefore start from
      // the fresh hand's blinds-posted snapshot, not from the showdown it is about
      // to leave behind - otherwise the seats keep the PREVIOUS hand's state until
      // each of the new hand's moves is replayed over them.
      const handChanged = Boolean(previous.view && view.handNumber !== previous.view.handNumber);
      const fromView = handChanged ? handStartView(view) : previous.view;
      // Which snapshots feed the live table: a card showing one of these is the
      // card the player is playing from, so it may follow the replay instead of
      // freezing. Older cards are not in the chain and stay historical.
      const chain = [previous.revision, ...(previous.chain ?? [])].slice(0, 16);
      if (unseen.length === 0) {
        TABLE_CACHE.set(sessionId, { view, revision, stepSeq: previous.stepSeq ?? 0, queue: [], timer: null, final: null, chain });
        notifyCache();
        return;
      }

      // Replay the WHOLE stretch that happened between the snapshot on screen
      // and this answer - after a fold the player still wants to watch the hand
      // play out. Only a cache that fell absurdly far behind (a hidden tab, a
      // long disconnect) drops its oldest beats, and those are folded into the
      // first replayed step's numbers.
      const skipped = unseen.slice(0, Math.max(0, unseen.length - MAX_REPLAY_STEPS));
      const kept = unseen.slice(skipped.length);
      // Lay the board out one card at a time. The host stamps each action with
      // the board as it stood, so a step whose board is longer than the board on
      // screen means cards were dealt in between: those become their own beats
      // (see `dealBeat`) shown BEFORE the action that follows them.
      const queue = [];
      let shown = Array.isArray(fromView.board) ? fromView.board.length : 0;
      // The seq of the action last shown - what a deal beat carries, so an
      // interruption mid-deal cannot make the next action look "already seen".
      const shownSeq = skipped.length > 0 ? skipped[skipped.length - 1].seq : previous.stepSeq;
      let lastSeq = shownSeq;
      for (const step of kept) {
        const board = Array.isArray(step.board) ? step.board : null;
        if (board && board.length > shown) {
          // Every card of the new street gets its own beat, INCLUDING the last
          // one: the action that follows the deal then re-applies the same board
          // (no growth, no second animation) and reads as a pure action.
          for (let size = shown + 1; size <= board.length; size += 1) {
            queue.push(dealBeat(step, board, size, size === shown + 1, lastSeq));
          }
          shown = board.length;
        }
        lastSeq = step.seq;
        queue.push(step);
      }
      const entry = {
        // The table is locked while the replay runs: `legal` is dropped on the
        // view shown from the FIRST beat on, so a click that lands while the
        // queue is still draining cannot dispatch a second, stale action. Any
        // notice from a refused click goes with it - the run has moved on. A new
        // hand starts from its fresh snapshot (`fromView`), not the old one.
        view: Object.assign({}, fromView, { resolving: true, legal: null, notice: null }),
        revision,
        stepSeq: shownSeq,
        queue,
        timer: null,
        final: view,
        chain,
        done: 0,
        // Progress counts ACTIONS, not the cards laid out between them, while the
        // replay budget is spent over every beat including the deals.
        total: queue.filter((beat) => !beat.deal).length,
        beats: queue.length,
      };
      TABLE_CACHE.set(sessionId, entry);
      scheduleStep(sessionId);
    }

    /**
     * The table as it stood right after the blinds were posted.
     *
     * A GUI-opened table arrives with the opponents' preflop moves already played.
     * To let the player start the hand themselves the display is rewound: every
     * player gets back what they put in and keeps only their blind, the pot is the
     * two blinds, the board is empty, and the log keeps just the opening line and
     * the blinds - so the story still starts where it should.
     * @param view - the authoritative view (preflop, first hand).
     * @returns a view of the same table at the start of the hand.
     */
    function handStartView(view) {
      const players = Array.isArray(view.players) ? view.players : [];
      if (players.length === 0) return view;
      const smallBlind = Number(view.smallBlind || 0);
      const bigBlind = Number(view.bigBlind || 0);
      const blinds = new Map();
      if (Number.isInteger(view.smallBlindSeat)) blinds.set(view.smallBlindSeat, smallBlind);
      if (Number.isInteger(view.bigBlindSeat)) blinds.set(view.bigBlindSeat, bigBlind);
      const log = (Array.isArray(view.log) ? view.log : [])
        .filter((line) => /\u2014\u2014|[\u4e0b]\u5c0f\u76f2|[\u4e0b]\u5927\u76f2/.test(String(line)));
      // Preflop the seat after the big blind acts first.
      const afterBig = Number.isInteger(view.bigBlindSeat) ? (view.bigBlindSeat + 1) % players.length : view.actorSeat;
      return Object.assign({}, view, {
        board: [],
        pot: smallBlind + bigBlind,
        currentBet: bigBlind,
        actorSeat: typeof afterBig === 'number' ? afterBig : view.actorSeat,
        legal: null,
        resolving: true,
        equity: null,
        replay: null,
        log,
        players: players.map((player) => {
          const committed = Number(player.streetCommitted || 0);
          const blind = blinds.get(player.seat) ?? 0;
          return Object.assign({}, player, {
            // Everything they put in comes back, then their blind goes out again.
            stack: Number(player.stack || 0) + committed - blind,
            streetCommitted: blind,
            handCommitted: Math.max(0, Number(player.handCommitted || 0) - committed + blind),
            folded: false,
            allIn: false,
            lastAction: blind > 0 ? (blind === bigBlind ? '\u5927\u76f2 ' + blind : '\u5c0f\u76f2 ' + blind) : null,
            talk: null,
            hand: null,
          });
        }),
      });
    }

    /**
     * Let a held hand play: queue the opponents' moves the table arrived with and
     * start the beats. Returns false when nothing was held, which means the host
     * paused the table itself and it has to be released over the route.
     * @param sessionId - the session whose table is waiting.
     * @returns whether a local hold was released.
     */
    function releaseHeld(sessionId) {
      const entry = TABLE_CACHE.get(sessionId);
      if (!entry || !entry.held) return false;
      const held = entry.held;
      // Put the START view back in place with its own step counter, then feed the
      // held answer through the normal replay path: same beats, same pacing.
      TABLE_CACHE.set(sessionId, Object.assign({}, entry, { held: null, stepSeq: 0 }));
      cacheView(sessionId, held.view, held.steps);
      notifyCache();
      return true;
    }

    /**
     * Whichever of two table snapshots is newer.
     *
     * A click never writes to the session log, so a table this page opened itself
     * is only in the cache - and its revision restarts at 0, so revisions alone
     * cannot say which is current. Two rules, in order:
     *   1. if the log carries content this page has not seen yet (a higher event
     *      seq), the log wins - that is a table opened from the chat;
     *   2. otherwise the cache wins when it holds a different table (this page
     *      switched), and revisions decide when both hold the same table.
     */
    function newestTable(fromLog, cached) {
      if (!fromLog) return cached ?? null;
      if (!cached) return fromLog;
      const logSeq = typeof fromLog.seq === 'number' ? fromLog.seq : null;
      if (logSeq !== null && cached.logSeq !== undefined && logSeq > cached.logSeq) return fromLog;
      const logId = fromLog.view ? fromLog.view.tableId : null;
      const cacheId = cached.view ? cached.view.tableId : null;
      if (logId && cacheId && logId !== cacheId) return cached;
      const logRevision = (fromLog.view && fromLog.view.revision) ?? 0;
      const cacheRevision = (cached.view && cached.view.revision) ?? 0;
      return cacheRevision >= logRevision ? cached : fromLog;
    }

    /**
     * Does this payload look like a poker table view? Used when the matching
     * `tool/call` fell outside the loaded event window, so the tool's own name
     * is unavailable and the shape has to speak for itself.
     */
    function looksLikeTableView(view) {
      return Boolean(view) && Array.isArray(view.players) && typeof view.streetLabel === 'string';
    }

    /**
     * The newest poker table in one session's event window.
     *
     * Scans backwards and stops at the first hit, so cost is independent of how
     * much history the window holds. Returns null when no poker call is loaded.
     * @param sessions - the client sessions service.
     * @param sessionId - the session to read.
     * @returns `{ view, callId, toolName }` or null.
     */
    function latestTableView(sessions, sessionId) {
      try {
        const binding = sessions && sessionId ? sessions.binding(sessionId) : undefined;
        const source = binding && binding.eventSource;
        if (!source || typeof source.getSnapshot !== 'function') return null;
        const entries = source.getSnapshot().entries || [];
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          const event = entry && entry.type === 'event' ? entry.event : null;
          if (!event || event.type !== 'tool/result' || !event.data) continue;
          const view = event.data.meta && event.data.meta.view;
          if (!looksLikeTableView(view)) continue;
          const callId = event.data.message && event.data.message.source ? event.data.message.source.callId : null;
          let toolName = null;
          if (callId) {
            for (let back = index - 1; back >= 0 && toolName === null; back -= 1) {
              const candidate = entries[back];
              const call = candidate && candidate.type === 'event' ? candidate.event : null;
              if (call && call.type === 'tool/call' && call.data && call.data.callId === callId) toolName = call.data.name;
            }
          }
          if (toolName !== null && String(toolName).indexOf('poker') !== 0) continue;
          return { view, callId, toolName: toolName || 'poker_table', seq: typeof event.seq === 'number' ? event.seq : null };
        }
        return null;
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('poker: cannot read the session event window', error);
        return null;
      }
    }

    /**
     * The newest table in one session: the freshest of what the session log
     * carries and what this page learned from its own direct actions.
     * @param sessionId - the session to follow.
     * @returns `{ view }` or null, refreshed on every session change.
     */
    function useLatestTable(sessionId) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        CACHE_LISTENERS.add(bump);
        let subscription = null;
        try {
          const sessions = getSessions();
          const binding = sessions && sessionId ? sessions.binding(sessionId) : undefined;
          if (binding && binding.eventSource && typeof binding.eventSource.subscribe === 'function') {
            subscription = binding.eventSource.subscribe(bump);
          }
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: cannot subscribe to the session', error);
        }
        bump();
        return () => {
          CACHE_LISTENERS.delete(bump);
          if (typeof subscription === 'function') subscription();
        };
      }, [sessionId]);
      const fromLog = latestTableView(getSessions(), sessionId);
      // Seed the page's cache from the log on first paint, so the very first
      // click still has a "state on screen" to replay forward from.
      if (fromLog && fromLog.view && !TABLE_CACHE.has(sessionId)) {
        TABLE_CACHE.set(sessionId, {
          view: fromLog.view,
          revision: fromLog.view.revision ?? 0,
          stepSeq: fromLog.view.actionSeq ?? 0,
          queue: [],
          timer: null,
          final: null,
          // Which log event this snapshot came from, so `newestTable` can tell
          // "the log has something newer" from "the log is simply older".
          logSeq: fromLog.seq ?? null,
        });
        rememberTable(fromLog.view.tableId);
      }
      // A session with no poker history of its own still belongs to the one table
      // the host is playing, so ask for it rather than showing an empty panel. A
      // session stuck on an older table catches up the same way: anything whose
      // table is not the one this page last saw is out of date.
      const cachedNow = TABLE_CACHE.get(sessionId);
      const shared = rememberedTable();
      if (!cachedNow) {
        if (!fromLog) discoverSharedTable(sessionId);
      } else if (cachedNow.view && shared && cachedNow.view.tableId !== shared) {
        discoverSharedTable(sessionId, { force: true });
      }
      return newestTable(fromLog, TABLE_CACHE.get(sessionId));
    }

    /**
     * The live table record for one session, refreshed on every replay beat.
     *
     * Used by the tool card to decide whether it is the card being played from:
     * a card whose own snapshot sits in the live chain follows the replay, while
     * older cards keep showing the moment they captured.
     * @param sessionId - the session to follow.
     * @returns the cache entry, or null.
     */
    function useLiveTable(sessionId) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTick((value) => value + 1);
        CACHE_LISTENERS.add(bump);
        return () => CACHE_LISTENERS.delete(bump);
      }, [sessionId]);
      return sessionId ? TABLE_CACHE.get(sessionId) ?? null : null;
    }

    /** Submit one plain-language sentence as an ordinary user prompt. */
    function useSubmit(sessionId) {
      return React.useCallback((text) => {
        try {
          // Resolved per click: the sessions service may not exist yet when the
          // surface is registered, and a stale undefined would kill every button.
          const sessions = getSessions();
          const binding = sessions && sessionId ? sessions.binding(sessionId) : undefined;
          if (binding && binding.session && typeof binding.session.prompt === 'function') {
            binding.session.prompt([{ type: 'text', text }], 'queue');
          }
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('poker: cannot submit the action', error);
        }
      }, [sessionId]);
    }

    /**
     * Play one action straight at the host plugin, so a click changes the table
     * without a chat message and without a model turn.
     *
     * The answer's view is cached locally and the panel re-renders from it. Only a
     * genuinely unreachable route falls back to the plain-language prompt: a RULES
     * rejection (an illegal action) is reported on the panel, because a click must
     * never write to the conversation - that is the whole point of this route.
     * @param sessionId - the session whose table is being played.
     * @returns `(view, op, payload, fallbackText) => Promise<void>`.
     */
    function useAct(sessionId) {
      const submit = useSubmit(sessionId);
      return React.useCallback(async (view, op, payload, fallbackText) => {
        const tableId = view && view.tableId;
        // Opening a table is the one operation that has no table yet.
        if (op !== 'new' && !tableId) {
          if (fallbackText) submit(fallbackText);
          return;
        }
        let answer = null;
        let status = 0;
        // Say "sent" at once: a route call plus the opponents' replay can take a
        // moment, and a button that looks inert invites a second click.
        setSending(sessionId, op);
        try {
          const response = await fetch('/poker/' + op, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign(tableId ? { tableId } : {}, payload)),
          });
          status = response.status;
          answer = await response.json();
        } catch (error) {
          // No route at all (a profile without a web server, a network failure):
          // the chat is then the only way left to touch the table.
          setSending(sessionId, null);
          if (typeof console !== 'undefined') console.warn('poker: the action route is unreachable, using the chat instead', error);
          if (fallbackText) submit(fallbackText);
          return;
        }
        if (!answer || answer.ok !== true) {
          if (typeof console !== 'undefined') console.warn('poker: action refused', answer && answer.error);
          setNotice(sessionId, (answer && answer.error) || `HTTP ${status}`);
          setSending(sessionId, null);
          return;
        }
        // A new table is HELD at the start of its hand: the opponents only move
        // once the player presses 开始 (see `handStartView`).
        cacheView(sessionId, answer.view, answer.steps, op === 'new' ? { hold: true } : {});      }, [sessionId, submit]);
    }

    /**
     * Remember that a click is in flight, so the panel can say so immediately.
     *
     * A route call plus the opponents' replay can take a beat or two; without this
     * the button looked like it had done nothing at all.
     * @param sessionId - the session whose table is waiting.
     * @param op - the operation being sent, or null to clear.
     */
    function setSending(sessionId, op) {
      const entry = TABLE_CACHE.get(sessionId);
      if (!entry || !entry.view) return;
      if (op === null) {
        if (entry.sending === undefined) return;
        TABLE_CACHE.set(sessionId, Object.assign({}, entry, { sending: null }));
      } else {
        TABLE_CACHE.set(sessionId, Object.assign({}, entry, { sending: op }));
      }
      notifyCache();
    }

    /**
     * The `poker_new_table` arguments that rebuild the table on screen.
     *
     * A rematch should be the same game, not a default one: the seat count, the
     * blinds and the original starting stack are all read back off the view (the
     * starting stack is recorded while the table is on its first hand, where every
     * stack still is one).
     * @param view - the table view.
     * @returns arguments for the `new` operation.
     */
    function lastTableConfig(view) {
      const players = Array.isArray(view.players) ? view.players : [];
      return {
        botCount: Math.max(1, players.length - 1),
        smallBlind: Number(view.smallBlind) || undefined,
        bigBlind: Number(view.bigBlind) || undefined,
        startingStack: Number(view.startingStack) || undefined,
      };
    }

    /**
     * Report a refused action ON the panel.
     *
     * The table itself is fine - this one action was not - so the message belongs
     * next to the buttons the player just pressed, not in the conversation. It
     * clears itself as soon as the next answer arrives.
     * @param sessionId - the session whose table refused the action.
     * @param text - the host's message.
     */
    function setNotice(sessionId, text) {
      const entry = TABLE_CACHE.get(sessionId);
      if (!entry || !entry.view || !text) return;
      TABLE_CACHE.set(sessionId, Object.assign({}, entry, {
        view: Object.assign({}, entry.view, { notice: String(text) }),
      }));
      notifyCache();
    }

    // ---- presentational pieces ---------------------------------------------

    /** One face-up card, or a face-down placeholder. */
    function Card(props) {
      const code = props.code;
      const className = 'dshp-card' + (props.variant ? ' ' + props.variant : '') + (props.gap === true ? ' dshp-boardGap' : '');
      if (!code) return React.createElement('span', { className: className + ' dshp-cardEmpty' }, '\u00a0');
      const red = suitOf(code) === 'h' || suitOf(code) === 'd';
      return React.createElement(
        'span',
        { className: className + (red ? ' dshp-red' : ' dshp-black') },
        React.createElement('span', { className: 'dshp-cardRank' }, rankLabel(code)),
        React.createElement('span', { className: 'dshp-cardSuit' }, SUITS[suitOf(code)] || ''),
      );
    }

    /**
     * The plugin's mark in its framed tile, for a title row.
     *
     * The sidebar entry, the panel title and every card head wear the same mark in
     * the same frame - a framed icon in one place and a bare glyph in another is
     * what "the icon has no border" was about.
     * @param props.size - the tile's edge in pixels (the glyph follows it).
     */
    function TitleMark(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 24;
      const small = size < 22;
      return React.createElement(
        'span',
        { className: 'dshp-iconTile' + (small ? ' dshp-iconTileSm' : '') },
        React.createElement(SpadeMark, { size: Math.round(size * 0.58) }),
      );
    }

    /** A face-down card. */
    function CardBack(props) {
      return React.createElement('span', { className: 'dshp-card dshp-cardBack' + (props.variant ? ' ' + props.variant : '') }, '\u00a0');
    }

    /**
     * The plugin's own mark: a spade, drawn as a path.
     *
     * Drawn rather than typed on purpose - the emoji fell back to a small, faint
     * monochrome glyph in the sidebar rail and was hard to make out. `currentColor`
     * means it inherits the button's own colour in either theme.
     * @param props.size - pixel size, default 14.
     */
    function SpadeMark(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 14;
      return React.createElement(
        'svg',
        {
          className: 'dshp-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', {
          d: 'M8 1.1 11.4 5.2c1.2 1.4.8 3.4-.8 4.1-.9.4-1.9.2-2.5-.5l1.2 4.6H6.7l1.2-4.6c-.6.7-1.6.9-2.5.5-1.6-.7-2-2.7-.8-4.1L8 1.1Z',
        }),
      );
    }

    /** A face per personality, so a seat is recognisable at a glance. */
    const STYLE_FACE = { rock: '\u{1FAA8}', tag: '\u{1F42F}', lag: '\u{1F98A}', station: '\u{1F422}', maniac: '\u{1F92A}', pro: '\u{1F3A9}' };

    /** Short position label and its accent class, from the seat's distance to the blinds. */
    function positionLabel(relative, count) {
      if (count === 2) return relative === 0 ? { short: 'BB', tone: 'dshp-posBlind' } : { short: 'BTN/SB', tone: 'dshp-posLate' };
      if (relative === 0) return { short: 'BB', tone: 'dshp-posBlind' };
      if (relative === count - 1) return { short: 'SB', tone: 'dshp-posBlind' };
      if (relative === count - 2) return { short: 'BTN', tone: 'dshp-posLate' };
      if (relative === count - 3) return { short: 'CO', tone: 'dshp-posLate' };
      if (relative === count - 4) return { short: 'HJ', tone: '' };
      if (relative === 1) return { short: 'UTG', tone: '' };
      return { short: 'MP', tone: '' };
    }

    /**
     * Every dealt seat's position, worked out from the blinds the view carries.
     *
     * The coach names positions host-side for the hero; the table needs them for
     * every tile, and the arithmetic is the same one-liner.
     * @param view - the table view.
     * @returns a `Map` of seat index to `{ short, tone }`.
     */
    function seatPositions(view) {
      const positions = new Map();
      const dealt = (Array.isArray(view.players) ? view.players : []).filter((player) => !player.out).map((player) => player.seat);
      const count = dealt.length;
      const from = dealt.indexOf(view.bigBlindSeat);
      if (count < 2 || from < 0) return positions;
      dealt.forEach((seat, index) => positions.set(seat, positionLabel((index - from + count) % count, count)));
      return positions;
    }

    /** The coach's read for one seat, matched by seat id or by name. */
    function seatRead(view, seat) {
      const coach = view && view.coach;
      const sections = coach && Array.isArray(coach.sections) ? coach.sections : [];
      const reads = sections.find((section) => section.id === 'reads');
      const items = reads && Array.isArray(reads.items) ? reads.items : [];
      const found = items.find((item) => item.seat === seat.seat
        || (seat.name && String(item.label || '').startsWith(seat.name)));
      return found ? { label: found.label, text: found.text } : null;
    }

    /**
     * Where to hang a seat's read tooltip so it stays on the table.
     *
     * Seats on the top half of the oval open their tooltip DOWNWARD, because
     * upward would leave the felt and get clipped by the panel; seats at the ends
     * hug the near edge instead of centring, so the 214px card never runs past
     * the rail. The choice is exposed as `data-read` on the tile so it can be
     * checked against the geometry instead of trusted.
     * @param top - the seat's vertical position, in percent.
     * @param left - the seat's horizontal position, in percent.
     * @returns `above|below` + `-left|-center|-right`.
     */
    function readAnchor(top, left) {
      const vertical = top < 46 ? 'below' : 'above';
      const horizontal = left < 26 ? 'left' : left > 74 ? 'right' : 'center';
      return vertical + '-' + horizontal;
    }

    /** The read tooltip's placement classes for one {@link readAnchor}. */
    function readPlacement(anchor) {
      return (anchor.startsWith('below') ? ' dshp-seatReadBelow' : '')
        + (anchor.endsWith('left') ? ' dshp-seatReadLeft' : anchor.endsWith('right') ? ' dshp-seatReadRight' : '');
    }

    /**
     * One seat on the rail: a face, a name, its position, the stack, this
     * street's commitment, and the hole cards (face up for the hero, backs for
     * others). Hovering it reveals the coach's read of that player.
     * @param props.seat - the seat snapshot.
     * @param props.view - the whole table view.
     * @param props.style - absolute position on the oval.
     * @param props.position - `{ short, tone }` for this seat.
     * @param props.placement - extra classes for the read tooltip's placement.
     * @param props.anchor - which corner the read hangs from, for testing.
     * @param props.dealer - `above|below|left|right` when this seat holds the button.
     */
    function Seat(props) {
      const seat = props.seat;
      const view = props.view;
      const badges = [];
      if (seat.isHuman) badges.push(React.createElement('span', { className: 'dshp-badge dshp-badgeYou', key: 'you' }, '\u4f60'));
      if (seat.allIn) badges.push(React.createElement('span', { className: 'dshp-badge', key: 'ai' }, '\u5168\u4e0b'));
      if (seat.seat === view.actorSeat) badges.push(React.createElement('span', { className: 'dshp-badge dshp-badgeTurn', key: 'turn' }, '\u884c\u52a8'));
      if (seat.wonLastHand > 0) {
        // The sign is its own piece, slightly larger and bolder than the number:
        // a small "+" glued to the amount sat high and read as part of the digits.
        badges.push(React.createElement('span', { className: 'dshp-badge dshp-badgeWin', key: 'win' },
          React.createElement('span', { className: 'dshp-badgeSign' }, '+'),
          chips(seat.wonLastHand)));
      }

      const cardSize = seat.isHuman ? 'dshp-heroCard' : 'dshp-mini';
      const cards = [];
      if (seat.cards) {
        for (let index = 0; index < seat.cards.length; index += 1) {
          cards.push(React.createElement(Card, { key: 'c' + index, code: seat.cards[index], variant: cardSize }));
        }
      } else {
        for (let index = 0; index < (seat.cardCount || 0); index += 1) {
          cards.push(React.createElement(CardBack, { key: 'b' + index, variant: cardSize }));
        }
      }

      const status = seat.out ? '\u5df2\u51fa\u5c40' : seat.folded ? '\u5df2\u5f03\u724c' : seat.lastAction || '';
      const position = props.position;
      const read = seat.isHuman ? null : seatRead(view, seat);
      const face = seat.isHuman ? '\u{1F9D1}' : (STYLE_FACE[seat.style] || '\u{1F464}');

      return React.createElement(
        'div',
        {
          className: 'dshp-seat'
            + (seat.isHuman ? ' dshp-seatHero' : '')
            + (seat.seat === view.actorSeat ? ' dshp-seatActor' : '')
            + (seat.wonLastHand > 0 ? ' dshp-seatWinner' : '')
            + (seat.folded || seat.out ? ' dshp-seatOut' : ''),
          style: props.style,
          // Data attributes keep the DOM readable: which seat this is, who is
          // sitting in it, and where it is sitting.
          'data-seat': String(seat.seat),
          'data-style': seat.style || '',
          'data-position': position ? position.short : '',
          'data-human': seat.isHuman ? 'true' : 'false',
          'data-read': props.anchor || '',
          'data-dealer': props.dealer ? 'yes' : '',
          'data-term': props.term || '',
        },
        // The button belongs to a player, so it is drawn on that player's card,
        // always in the same corner.
        props.dealer
          ? React.createElement('span', {
              className: 'dshp-dealer',
              title: 'D = dealer button（\u5e84\u5bb6\u6309\u94ae\uff0c\u4e5f\u5c31\u662f\u8fd9\u4e2a\u5e2d\u4f4d\u7684 BTN \u4f4d\u7f6e\uff09\uff1a\u6bcf\u624b\u724c\u5411\u5de6\u79fb\u4e00\u4e2a\u5e2d\u4f4d\uff0c\u5b83\u5de6\u8fb9\u7684\u4eba\u5148\u884c\u52a8',
            }, 'D')
          : null,
        // The coach's read, revealed on hover: the same numbers the analysis
        // window quotes, attached to the player they are about.
        read
          ? React.createElement(
              'div',
              { className: 'dshp-seatRead' + (props.placement || '') },
              React.createElement('span', { className: 'dshp-seatReadTitle' }, read.label),
              read.text,
            )
          : null,
        seat.streetCommitted > 0 ? React.createElement('span', { className: 'dshp-betChip' }, chipsWithBB(seat.streetCommitted, view, 'dshp-bbOnGold')) : null,
        React.createElement(
          'div',
          { className: 'dshp-seatTop' },
          React.createElement('span', { className: 'dshp-avatar', title: seat.style ? '\u98ce\u683c\uff1a' + seat.style : '' }, face),
          React.createElement('span', { className: 'dshp-seatName' }, seat.name),
        ),
        React.createElement(
          'div',
          { className: 'dshp-badges' },
          position ? React.createElement('span', { className: 'dshp-pos ' + position.tone, title: position.short === 'BTN' ? '\u4f4d\u7f6e BTN = \u5e84\u5bb6\u4f4d\uff1a\u6bdb\u6be1\u4e0a\u90a3\u679a D \u7b79\u7801\u5c31\u662f\u5b83\uff0c\u6bcf\u624b\u724c\u5411\u5de6\u79fb\u4e00\u4f4d' : '\u4f4d\u7f6e ' + position.short }, position.short) : null,
          // What this seat did on this street, in poker terms - the same word the
          // raise button carries, so an open or a 3-bet is visible on the player.
          props.term
            ? React.createElement('span', {
                className: 'dshp-seatTerm' + (view.street === 'preflop' ? '' : ' dshp-seatTermPost'),
                title: '\u8fd9\u4e00\u8857 ' + seat.name + ' \u7684\u52a8\u4f5c\uff1a' + props.term,
              }, props.term)
            : null,
          badges,
        ),
        React.createElement('span', { className: 'dshp-seatChips' }, chipsWithBB(seat.stack, view)),
        cards.length > 0 ? React.createElement('div', { className: 'dshp-seatCards' }, cards) : null,
        seat.hand ? React.createElement('span', { className: 'dshp-seatMade' }, seat.hand) : null,
        status ? React.createElement('span', { className: 'dshp-seatHand' }, status) : null,
        seat.talk ? React.createElement('span', { className: 'dshp-talk' }, '\u201c' + seat.talk + '\u201d') : null,
      );
    }

    /**
     * The action bar plus the bet-sizing coach.
     *
     * Every button plays directly against the host plugin (`act`), so a click
     * changes the table without posting a message; `act` falls back to the
     * chat path only when the direct route is unavailable.
     *
     * The size presets do NOT act: they fill the amount box so the reader can
     * see the number, its BB equivalent, and what that size is for before
     * committing. That two-step is the point - this row doubles as the lesson.
     *
     * Deliberately hook-free so this row can be exercised (and reasoned about)
     * without a React hook runtime: the custom amount lives in the DOM input,
     * reached through a callback ref.
     */
    function Actions(props) {
      const view = props.view;
      const act = props.act;
      /** Let a locally held table start; false when the host holds it instead. */
      const onStart = props.onStart;
      // Hooks first, unconditionally: the teaching switch decides how much of
      // the sizing helper explains itself, and the plugin settings decide which
      // optional pieces of the action area are on screen.
      const teaching = useCoachOn();
      const settings = usePluginSettings();
      const box = { value: '' };
      const chipsBox = { node: null };
      const bbBox = { node: null };
      const legal = view.legal;
      const buttons = [];
      let foldButton = null;
      // The hero's seat, and whether it has been emptied: the only time the rebuy
      // card is offered. `resolving` guards against a stale stack mid-replay.
      const hero = (Array.isArray(view.players) ? view.players : []).find((player) => player.isHuman);
      const heroBusted = Boolean(hero && Number(hero.stack) === 0 && !view.resolving);

      /**
       * What the coach wants, as data: the badge above the buttons says it, and
       * the matching button gets a ring. A prefilled raise box is a control, not
       * a recommendation - this is what stops the two from being confused.
       */
      const advice = teaching && view.coach && view.coach.plan ? view.coach.plan : null;
      const advised = advice ? advice.action : null;
      const isAdvised = (key) => {
        if (advised === null) return false;
        // The commit button is whatever raise the reader sized, so it answers to
        // both raise family actions.
        if (key === 'commit') return advised === 'raise' || advised === 'bet' || advised === 'allin';
        return advised === key;
      };

      /**
       * One stacked action button: the move and its amount on the first line, the
       * BB equivalent and poker term underneath.
       *
       * Both lines are lists of WHOLE pieces ("跟注" / "8,025"), laid out with
       * flex-wrap: a narrow button puts a piece on the next line instead of
       * cutting it off ("全下 8,0..."), and no piece is ever split by character.
       */
      const actionButton = (options) => {
        const line = (pieces, className, refs) => React.createElement(
          'span',
          { className },
          pieces.filter((piece) => piece !== null && piece !== undefined && piece !== '').map((piece, index) => React.createElement(
            'span',
            { key: 'p' + index, className: piece.className, ref: piece.ref },
            piece.text ?? piece,
          )),
        );
        return React.createElement(
          'button',
          {
            key: options.key,
            type: 'button',
            className: options.className + (isAdvised(options.key) ? ' dshp-btnAdvice' : ''),
            title: options.title,
            onClick: options.onClick,
          },
          options.mainNode ?? line([options.verb, options.amount].filter(Boolean), 'dshp-btnMain'),
          options.sub ? line([options.sub, options.sub2].filter(Boolean), 'dshp-btnSub') : null,
        );
      };
      // The commit button's amount text is updated straight in the DOM as the
      // reader types: the row has no hook state to re-render from. The pot-share
      // readout rides the same update.
      const commitVerbNode = { node: null };
      const commitAmountNode = { node: null };
      const shareNode = { node: null };
      let commitVerb = '\u4e0b\u6ce8\u5230';
      const syncCommit = (amount) => {
        if (commitVerbNode.node) commitVerbNode.node.textContent = commitVerb;
        if (commitAmountNode.node) commitAmountNode.node.textContent = chips(amount || (legal ? legal.minRaiseTo : 0));
      };
      const syncShare = (amount) => {
        if (!shareNode.node) return;
        shareNode.node.textContent = potShareLabel(view, legal ? legal.toCall : 0, amount);
      };
      const syncAmounts = (amount) => {
        syncCommit(amount);
        syncShare(amount);
      };

      /** Fill the amount box from a preset, showing the size before it is played. */
      const fill = (amount) => {
        const rounded = Math.max(legal ? legal.minRaiseTo : 0, Math.round(amount));
        box.value = String(rounded);
        if (chipsBox.node) chipsBox.node.value = String(rounded);
        const blind = blindOf(view);
        if (bbBox.node && blind > 0) bbBox.node.value = String(Math.round((rounded / blind) * 10) / 10);
        syncAmounts(rounded);
      };

      // A table the browser just opened waits for the player: showing the action
      // row first would invite a click into a street nobody has played. The start
      // button stands OUTSIDE the `legal` branch, because a waiting table has no
      // legal actions for the hero yet. A busted hero takes the rebuy card instead.
      if (heroBusted) {
        // No action buttons: the game is waiting on "buy back in or start over",
        // not on a bet. The rebuy card is built further down.
      } else if (view.awaitingStart) {
        buttons.push(actionButton({
          key: 'start',
          className: 'dshp-btn dshp-btnPrimary',
          title: '\u5f00\u59cb\u8fd9\u4e00\u624b\uff1a\u5bf9\u624b\u4f1a\u4e00\u6b65\u4e00\u6b65\u884c\u52a8\uff0c\u4f60\u518d\u51b3\u5b9a',
          verb: '\u5f00\u59cb',
          sub: '\u53d1\u724c\u5e76\u884c\u52a8',
          onClick: () => {
            // The moves this page already holds are replayed locally; only a table
            // the HOST paused needs the route to let the opponents go.
            if (onStart && onStart()) return;
            act(view, 'start', {}, '\u5f00\u59cb\u8fd9\u4e00\u624b');
          },
        }));
      } else if (legal) {
        if (legal.canCheck) {
          buttons.push(actionButton({
            key: 'check',
            className: 'dshp-btn dshp-btnCheck',
            title: '\u8fc7\u724c check\uff1a\u65e0\u4eba\u4e0b\u6ce8\u65f6\u628a\u884c\u52a8\u8ba9\u7ed9\u4e0b\u4e00\u5bb6',
            verb: '\u8fc7\u724c',
            sub: 'check',
            onClick: () => act(view, 'action', { action: 'check' }, '\u8fc7\u724c'),
          }));
        }
        if (legal.canCall) {
          const callBB = bbLabel(legal.callAmount, view);
          const potOdds = legal.callAmount > 0 ? Math.round((legal.callAmount / (view.pot + legal.callAmount)) * 1000) / 10 : 0;
          buttons.push(actionButton({
            key: 'call',
            className: 'dshp-btn dshp-btnPrimary',
            title: `\u8ddf\u6ce8 ${chips(legal.callAmount)}${callBB ? ' (' + callBB + ')' : ''}\uff1a\u9700\u8981 ${potOdds}% \u80dc\u7387\u624d\u5212\u7b97`,
            verb: '\u8ddf\u6ce8',
            amount: chips(legal.callAmount),
            sub: callBB,
            sub2: 'call',
            onClick: () => act(view, 'action', { action: 'call' }, '\u8ddf\u6ce8' + (legal.callAmount ? ' ' + legal.callAmount : '')),
          }));
        }
        if (legal.canAllIn) {
          const allInBB = bbLabel(legal.maxRaiseTo, view);
          buttons.push(actionButton({
            key: 'allin',
            className: 'dshp-btn dshp-btnAllIn',
            title: '\u5168\u4e0b all-in\uff1a\u77ed\u7801\uff08\u7b79\u7801\u4e0d\u5230 20BB\uff09\u6216\u62ff\u5230\u6781\u5f3a\u724c\u65f6\u4f7f\u7528',
            verb: '\u5168\u4e0b',
            amount: chips(legal.maxRaiseTo),
            sub: allInBB,
            sub2: 'all-in',
            onClick: () => act(view, 'action', { action: 'allin' }, '\u5168\u4e0b'),
          }));
        }
        if (legal.canFold) {
          // Held back one step: the raise commit joins this row just before it.
          foldButton = actionButton({
            key: 'fold',
            className: 'dshp-btn dshp-btnDanger',
            title: '\u5f03\u724c fold\uff1a\u653e\u5f03\u8fd9\u624b\u724c',
            verb: '\u5f03\u724c',
            sub: 'fold',
            onClick: () => act(view, 'action', { action: 'fold' }, '\u5f03\u724c'),
          });
        }
      } else if (view.canDealNext && !view.gameOver) {
        buttons.push(actionButton({
          key: 'next',
          className: 'dshp-btn dshp-btnPrimary',
          title: '\u53d1\u4e0b\u4e00\u624b\u724c',
          verb: '\u53d1\u4e0b\u4e00\u624b',
          sub: 'deal',
          onClick: () => act(view, 'next', {}, '\u53d1\u4e0b\u4e00\u624b\u724c'),
        }));
      } else if (view.pending) {
        buttons.push(React.createElement('span', { key: 'pending', className: 'dshp-hint' }, '\u7b49\u5f85\u6a21\u578b\u4e3a ' + view.pending.name + ' \u51b3\u7b56'));
      }

      // The sizing group and the lesson, both only while a size is being chosen.
      let sizingRow = null;
      let coach = null;
      if (legal && legal.canRaise && !view.awaitingStart) {
        const blind = blindOf(view) || 1;
        // The pot the sizes are measured against, worked out once: an open bet is
        // a fraction of the pot on the table, a raise of the pot after the call.
        const pot = Number(view.pot || 0);
        const toCall = Number(legal.toCall || 0);
        const openBet = openingBet(view);
        const vocabulary = raiseVocabulary(view);
        const openVerb = Number(view.currentBet || 0) > 0 ? '\u52a0\u6ce8\u5230' : '\u4e0b\u6ce8\u5230';
        commitVerb = openVerb;
        /**
         * How much the commit button should raise TO.
         *
         * The box shows the minimum raise as its PLACEHOLDER, so a player who just
         * presses the button without typing is asking for that amount - and the old
         * code read `box.value`, found `''`, and silently did nothing. That is the
         * "点击加注没反应" case.
         */
        const commitAmount = () => {
          const typed = Number(box.value !== '' ? box.value : (chipsBox.node ? chipsBox.node.value : ''));
          if (Number.isFinite(typed) && typed > 0) return Math.round(typed);
          return Math.round(legal.minRaiseTo);
        };
        const commit = () => {
          const amount = commitAmount();
          act(view, 'action', { action: 'raise', amount }, '\u52a0\u6ce8\u5230 ' + amount);
        };
        /** Mirror a chip amount into the BB box. */
        const fromChips = () => {
          const value = Number(chipsBox.node ? chipsBox.node.value : box.value);
          if (!Number.isFinite(value)) return;
          box.value = String(value);
          if (bbBox.node) bbBox.node.value = String(Math.round((value / blind) * 10) / 10);
          syncAmounts(value);
        };
        /** Mirror a BB amount into the chip box - the way players actually think. */
        const fromBB = () => {
          const value = Number(bbBox.node ? bbBox.node.value : '');
          if (!Number.isFinite(value) || value <= 0) return;
          const amount = Math.round(value * blind);
          box.value = String(amount);
          if (chipsBox.node) chipsBox.node.value = String(amount);
          syncAmounts(amount);
        };
        /** Reset both boxes so a new size can be typed from scratch. */
        const clear = () => {
          box.value = '';
          if (chipsBox.node) chipsBox.node.value = '';
          if (bbBox.node) bbBox.node.value = '';
          syncAmounts(0);
          if (chipsBox.node && typeof chipsBox.node.focus === 'function') chipsBox.node.focus();
        };
        // The commit button stands in the action row, immediately left of fold,
        // and is visually tied to the sizing row underneath it.
        buttons.push(actionButton({
          key: 'commit',
          className: 'dshp-btn dshp-btnCommit',
          title: vocabulary.why,
          // The verb and the amount are separate pieces of the same line, so a long
          // amount wraps onto its own line instead of being cut off ("加注到 1,...").
          mainNode: React.createElement(
            'span',
            { className: 'dshp-btnMain' },
            React.createElement('span', { className: 'dshp-commitVerb', ref: (node) => { commitVerbNode.node = node; } }, openVerb),
            React.createElement('span', { className: 'dshp-commitAmount', ref: (node) => { commitAmountNode.node = node; } }, chips(legal.minRaiseTo)),
          ),
          sub: vocabulary.en,
          onClick: commit,
        }));
        sizingRow = React.createElement(
          'div',
          { className: 'dshp-raise' },
          React.createElement('button', {
            className: 'dshp-reset',
            type: 'button',
            title: '\u91cd\u7f6e\u91d1\u989d',
            onClick: clear,
          }, '\u21ba'),
          // The chip box steps by one big blind, so the arrows walk in the unit
          // the rest of the panel speaks.
          React.createElement('input', {
            className: 'dshp-input',
            type: 'number',
            step: blind,
            min: legal.minRaiseTo,
            max: legal.maxRaiseTo,
            placeholder: String(legal.minRaiseTo),
            ref: (node) => { chipsBox.node = node; },
            onChange: (event) => { box.value = event.target.value; fromChips(); },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              // Same rule as the commit button: an empty box means the minimum.
              act(view, 'action', { action: 'raise', amount: commitAmount() }, '\u52a0\u6ce8\u5230 ' + commitAmount());
            },
          }),
          React.createElement('span', { className: 'dshp-unit' }, '\u7b79\u7801'),
          React.createElement('span', { className: 'dshp-eq' }, '='),
          React.createElement('input', {
            className: 'dshp-input dshp-inputBB',
            type: 'number',
            step: 1,
            min: Math.round((legal.minRaiseTo / blind) * 10) / 10,
            placeholder: String(Math.round((legal.minRaiseTo / blind) * 10) / 10),
            ref: (node) => { bbBox.node = node; },
            onChange: fromBB,
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              const value = Number(event.target.value);
              // An empty BB box means the minimum raise too, not "do nothing".
              const amount = Number.isFinite(value) && value > 0 ? Math.round(value * blind) : commitAmount();
              act(view, 'action', { action: 'raise', amount }, '\u52a0\u6ce8\u5230 ' + amount);
            },
          }),
          React.createElement('span', { className: 'dshp-unit' }, 'BB'),
          React.createElement('span', {
            className: 'dshp-potShare',
            title: openingBet(view)
              ? `\u8fd9\u4e2a\u91d1\u989d\u76f8\u5f53\u4e8e\u4e0b\u6ce8\u524d\u5e95\u6c60\uff08${chips(pot)}\uff09\u7684\u591a\u5c11\uff1a0.5 \u6c60 = \u534a\u6c60\u4e0b\u6ce8\uff0c1 \u6c60 = \u6ee1\u6c60\u4e0b\u6ce8`
              : `\u8fd9\u4e2a\u91d1\u989d\u76f8\u5f53\u4e8e\u201c\u8ddf\u6ce8\u540e\u5e95\u6c60\u201d\uff08\u5e95\u6c60 ${chips(pot)} + \u9700\u8ddf ${chips(toCall)} = ${chips(pot + toCall)}\uff09\u7684\u591a\u5c11\uff1a0.5 \u6c60 = \u534a\u6c60\u52a0\u6ce8\uff0c1 \u6c60 = \u6807\u51c6\u7684 pot-sized raise`,
            ref: (node) => { shareNode.node = node; },
          }, potShareLabel(view, legal.toCall, legal.minRaiseTo)),
        );

        // A size is a fraction of what is already out there: an opening bet is
        // `fraction × pot`, and a raise is `current bet + fraction × (pot + call)`
        // - which makes "1 pot" the classic pot-sized raise.
        const target1 = (fraction) => {
          const raw = openBet ? fraction * pot : Number(view.currentBet) + fraction * (pot + toCall);
          return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(raw)));
        };
        const potPresets = [
          { name: '1/3 \u6c60', fraction: 1 / 3, uses: '\u5e72\u71e5\u9762\u4ef7\u503c' },
          { name: '1/2 \u6c60', fraction: 1 / 2, uses: '\u901a\u7528\u4ef7\u503c' },
          { name: '2/3 \u6c60', fraction: 2 / 3, uses: '\u6e7f\u9762\u4fdd\u62a4' },
          { name: '1 \u6c60', fraction: 1, uses: '\u6781\u5316\u00b7\u8bc8\u552c' },
        ];
        // Preflop the pot IS the two blinds, so every pot fraction falls under the
        // minimum raise and all four presets collapse onto one identical number -
        // which reads as broken (and was the first thing a new hand showed). Preflop,
        // and any spot where the fractions collapse, sizes in BLINDS instead: that is
        // how an open is actually chosen, and "3-bet to 9BB" how a raise is.
        const collapsed = new Set(potPresets.map((preset) => target1(preset.fraction))).size < 2;
        const current = Number(view.currentBet || 0);
        const byBlind = view.street === 'preflop' || collapsed;
        const blindSteps = openBet
          ? [
              { name: '2.5BB', multiple: 2.5, uses: '\u5c0f\u5f00\u6c60\u00b7\u62a2\u76f2' },
              { name: '3BB', multiple: 3, uses: '\u6807\u51c6\u5f00\u6c60' },
              { name: '4BB', multiple: 4, uses: '\u9694\u79bb\u00b7\u6709\u8ddf\u6ce8\u8005' },
              { name: '6BB', multiple: 6, uses: '\u5927\u5c3a\u5ea6\u00b7\u4fdd\u62a4' },
            ]
          : [
              { name: '2.5\u00d7', multiple: 2.5, uses: '\u5c0f\u53cd\u51fb\u00b7\u7d27\u8ddf' },
              { name: '3\u00d7', multiple: 3, uses: '\u6807\u51c6 3-bet' },
              { name: '4\u00d7', multiple: 4, uses: '\u9694\u79bb\u00b7\u6709\u8ddf\u6ce8\u8005' },
              { name: '5\u00d7', multiple: 5, uses: '\u6781\u5316\u00b7\u903c\u5f03' },
            ];
        const presets = byBlind
          ? blindSteps.map((step) => ({
              name: step.name,
              uses: step.uses,
              unit: openBet ? 'BB' : '\u500d',
              // The blind (or the bet being raised) is the unit here, not the pot.
              raw: openBet ? step.multiple * blind : current * step.multiple,
            }))
          : potPresets.map((preset) => ({
              name: preset.name,
              uses: preset.uses,
              unit: '\u6c60',
              raw: openBet ? preset.fraction * pot : current + preset.fraction * (pot + toCall),
            }));
        const sizeButtons = presets.map((preset) => {
          const target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(preset.raw)));
          const sizeBB = bbLabel(target, view);
          // Which pot the fraction is measured against, spelled out: a bet is a
          // fraction of the pot on the table, a raise is a fraction of the pot
          // AFTER the call (that is what "pot-sized raise" means) - and the reader
          // can only check that if the number is written down.
          const current2 = current;
          const nominal = preset.raw;
          const raised = target - current2;
          const share = openBet ? target / pot : raised / (pot + toCall);
          const shareText = '\u7ea6 ' + (Math.round(share * 100) / 100) + ' \u6c60';
          const cappedHigh = nominal > legal.maxRaiseTo + 0.5;
          // A preset below the minimum raise lands on the minimum instead, and the
          // tooltip says so - otherwise "1/3 池" would quietly mean something else.
          const raisedToMin = !cappedHigh && target > nominal + 0.5;
          const unit = preset.unit;
          const why = unit === '\u6c60'
            ? (openBet
              ? `${preset.name}\uff1a\u4e0b\u6ce8\u524d\u5e95\u6c60 ${chips(pot)} \u7684 ${preset.name.replace(' \u6c60', '')} = ${chips(target)}${sizeBB ? ' (' + sizeBB + ')' : ''}${cappedHigh ? `\uff08\u53d7\u5168\u4e0b\u4e0a\u9650\u9650\u5236\uff0c\u5b9e\u9645 ${shareText}\uff09` : raisedToMin ? `\uff08\u4e0d\u8db3\u6700\u5c0f\u52a0\u6ce8 ${chips(legal.minRaiseTo)}\uff0c\u5b9e\u9645\u662f ${shareText}\uff09` : ''} \u2014 ${preset.uses}`
              : `${preset.name}\uff1a\u8ddf\u6ce8\u540e\u5e95\u6c60 ${chips(pot + toCall)}\uff08\u5e95\u6c60 ${chips(pot)} + \u9700\u8ddf ${chips(toCall)}\uff09\u7684 ${preset.name.replace(' \u6c60', '')} = \u52a0\u6ce8 ${chips(Math.round(nominal - current2))}\uff0c\u672c\u8f6e\u603b\u989d ${chips(target)}${sizeBB ? ' (' + sizeBB + ')' : ''}`
                + (cappedHigh ? '\uff08\u53d7\u5168\u4e0b\u4e0a\u9650\u9650\u5236\uff09' : raisedToMin ? `\uff08\u4e0d\u8db3\u6700\u5c0f\u52a0\u6ce8 ${chips(legal.minRaiseTo)}\uff0c\u5b9e\u9645\u662f ${shareText}\uff09` : '')
                + ` \u2014 ${preset.uses}`)
            : (openBet
              ? `${preset.name}\uff1a\u4e00\u4e2a\u5927\u76f2 ${chips(blind)}\uff0c${preset.name} = ${chips(target)}\uff08${shareText}\uff09${cappedHigh ? '\uff08\u53d7\u5168\u4e0b\u4e0a\u9650\u9650\u5236\uff09' : raisedToMin ? `\uff08\u4e0d\u8db3\u6700\u5c0f\u52a0\u6ce8 ${chips(legal.minRaiseTo)}\uff0c\u5b9e\u9645\u662f ${shareText}\uff09` : ''} \u2014 ${preset.uses}`
              : `${preset.name}\uff1a\u5f53\u524d\u4e0b\u6ce8 ${chips(current2)} \u7684 ${preset.name.replace('\u00d7', '')} \u500d = ${chips(target)}\uff08${shareText}\uff09${cappedHigh ? '\uff08\u53d7\u5168\u4e0b\u4e0a\u9650\u9650\u5236\uff09' : raisedToMin ? `\uff08\u4e0d\u8db3\u6700\u5c0f\u52a0\u6ce8 ${chips(legal.minRaiseTo)}\uff0c\u5b9e\u9645\u662f ${shareText}\uff09` : ''} \u2014 ${preset.uses}`);
          return React.createElement(
            'button',
            {
              key: preset.name,
              className: 'dshp-size',
              type: 'button',
              title: why,
              onClick: () => fill(target),
            },
            React.createElement('strong', null, chips(target) + (sizeBB ? ' \u00b7 ' + sizeBB : '')),
            // A blind-sized preset would just repeat its own name here, so the sub
            // line carries what the reader cannot see yet: the pot share.
            React.createElement(
              'span',
              { className: 'dshp-sizeUses' },
              (cappedHigh ? '\u5168\u4e0b \u00b7 ' : raisedToMin ? '\u6700\u5c0f \u00b7 ' : '')
                + (unit === '\u6c60' ? preset.name : shareText.replace('\u7ea6 ', '\u2248 '))
                + ' \u00b7 ' + preset.uses,
            ),
          );
        });
        coach = React.createElement(
          'div',
          { className: 'dshp-coach' },
          React.createElement(
            'div',
            { className: 'dshp-coachHead' },
            // This row only SIZES a bet: the term label (open / 3-bet) rides on
            // the commit button, and the reading lives in the teaching window.
            React.createElement('span', { className: 'dshp-coachTitle' }, '\u{1F4D0} \u4e0b\u6ce8\u5c3a\u5ea6\u52a9\u624b'),
            React.createElement('span', { className: 'dshp-bb dshp-bbPane', title: '\u4e0b\u6ce8\uff08\u65e0\u4eba\u4e0b\u6ce8\u65f6\u7684\u7b2c\u4e00\u4e2a\u6ce8\uff09\u6309\u201c\u5f53\u524d\u5e95\u6c60\u201d\u7b97\uff1b\u52a0\u6ce8\u6309\u201c\u8ddf\u6ce8\u540e\u5e95\u6c60\u201d\u7b97\uff08\u6807\u51c6 pot-sized raise\uff09' },
              `\u5e95\u6c60 ${chips(pot)}${bbLabel(pot, view) ? ' (' + bbLabel(pot, view) + ')' : ''}`
              + (toCall > 0 ? ` \u00b7 \u9700\u8ddf ${chips(toCall)}${bbLabel(toCall, view) ? ' (' + bbLabel(toCall, view) + ')' : ''}` : '')
              + (openBet
                ? ` \u00b7 \u4e0b\u6ce8\u6309\u6b64\u7b97`
                : ` \u00b7 \u52a0\u6ce8\u6309\u8ddf\u6ce8\u540e ${chips(pot + toCall)} \u7b97`)
              + ` \u00b7 1BB = ${chips(blindOf(view))}`,
            ),
          ),
          React.createElement('div', { className: 'dshp-sizes' }, sizeButtons),
        );
      }

      // A finished game needs a way forward. `canDealNext` is false once fewer
      // than two players have chips, so the row used to render nothing at all and
      // the player was simply stuck looking at an empty table.
      let overPanel = null;
      if (view.gameOver && !view.awaitingStart) {
        const hero = (Array.isArray(view.players) ? view.players : []).find((player) => player.isHuman);
        const othersAlive = (Array.isArray(view.players) ? view.players : [])
          .filter((player) => !player.isHuman && Number(player.stack) > 0).length;
        const wonItAll = othersAlive === 0;
        overPanel = React.createElement(
          'div',
          { className: 'dshp-over' },
          React.createElement(
            'div',
            { className: 'dshp-overHead' },
            React.createElement('span', { className: 'dshp-overTitle' }, wonItAll ? '\u{1F3C6} \u4f60\u628a\u5168\u573a\u6253\u5149\u4e86' : '\u724c\u5c40\u7ed3\u675f'),
            React.createElement('span', { className: 'dshp-bb dshp-bbPane' },
              view.handNumber ? '\u7b2c ' + view.handNumber + ' \u624b' : ''),
          ),
          React.createElement('span', { className: 'dshp-tip' }, wonItAll
            ? `\u4f60\u7684\u7b79\u7801 ${chips(hero ? hero.stack : 0)}\uff0c\u5176\u4f59 ${view.players.length - 1} \u5bb6\u5168\u90e8\u51fa\u5c40\u3002\u518d\u6765\u4e00\u5c40\u4f1a\u6309\u540c\u6837\u7684\u4eba\u6570\u3001\u76f2\u6ce8\u4e0e\u8d77\u59cb\u7b79\u7801\u91cd\u5f00\u3002`
            : '\u8fd9\u5c40\u5230\u6b64\u4e3a\u6b62\u3002\u4f60\u53ef\u4ee5\u6309\u540c\u6837\u7684\u914d\u7f6e\u91cd\u5f00\u4e00\u5c40\uff0c\u6216\u7528\u6807\u9898\u680f\u7684 \u{1F504} \u6362\u4e00\u5f20\u724c\u684c\u3002'),
          React.createElement('div', { className: 'dshp-overRow' },
            React.createElement('button', {
              className: 'dshp-btn dshp-btnPrimary',
              type: 'button',
              title: '\u6309\u540c\u6837\u7684\u4eba\u6570\u3001\u76f2\u6ce8\u4e0e\u8d77\u59cb\u7b79\u7801\u91cd\u65b0\u5f00\u5c40',
              onClick: () => act(null, 'new', lastTableConfig(view), '\u518d\u6765\u4e00\u5c40\u5fb7\u5dde\u6251\u514b'),
            },
            React.createElement('span', { className: 'dshp-btnMain' }, '\u518d\u6765\u4e00\u5c40'),
            React.createElement('span', { className: 'dshp-btnSub' }, 'rematch')),
          ),
        );
      }

      // Fold closes the action row, immediately right of the raise commit.
      if (foldButton) buttons.push(foldButton);

      // A busted hero replaces the whole action row with the rebuy card: whole-BB
      // top-ups plus a custom amount. The title-bar 🔄 still offers a new table.
      let rebuyPanel = null;
      if (heroBusted) {
        const blind = blindOf(view) || 100;
        const options = [50, 100, 200].map((bb) => ({ bb, amount: bb * blind }));
        const rebuyBox = { node: null };
        const rebuy = (amount) => act(view, 'rebuy', { amount: Math.round(amount) }, '\u8865\u7801 ' + Math.round(amount));
        rebuyPanel = React.createElement(
          'div',
          { className: 'dshp-rebuy' },
          React.createElement(
            'div',
            { className: 'dshp-rebuyHead' },
            React.createElement('span', { className: 'dshp-coachTitle' }, '\u4f60\u5df2\u8f93\u5149\u7b79\u7801'),
            React.createElement('span', { className: 'dshp-bb dshp-bbPane' }, '\u8865\u7801\u540e\u53ef\u53d1\u4e0b\u4e00\u624b\u7ee7\u7eed'),
          ),
          React.createElement(
            'div',
            { className: 'dshp-rebuyRow' },
            options.map((option) => React.createElement(
              'button',
              {
                key: 'rebuy' + option.bb,
                className: 'dshp-btn dshp-btnPrimary dshp-rebuyOpt',
                type: 'button',
                title: `\u8865\u7801 ${chips(option.amount)} (${option.bb}BB)`,
                onClick: () => rebuy(option.amount),
              },
              React.createElement('span', { className: 'dshp-btnMain' }, '\u8865\u7801 ' + chips(option.amount)),
              React.createElement('span', { className: 'dshp-btnSub' }, option.bb + 'BB'),
            )),
          ),
          React.createElement(
            'div',
            { className: 'dshp-rebuyCustom' },
            React.createElement('input', {
              className: 'dshp-input dshp-rebuyInput',
              type: 'number',
              step: blind,
              min: blind,
              placeholder: '\u81ea\u5b9a\u4e49\u989d\u5ea6',
              ref: (node) => { rebuyBox.node = node; },
            }),
            React.createElement('span', { className: 'dshp-unit' }, '\u7b79\u7801'),
            React.createElement('button', {
              className: 'dshp-btn dshp-btnCommit dshp-rebuyGo',
              type: 'button',
              title: '\u6309\u8f93\u5165\u7684\u7b79\u7801\u8865\u7801',
              onClick: () => {
                const amount = Math.round(Number(rebuyBox.node ? rebuyBox.node.value : ''));
                if (Number.isFinite(amount) && amount > 0) rebuy(amount);
              },
            }, React.createElement('span', { className: 'dshp-btnMain' }, '\u8865\u7801')),
          ),
        );
      }

      if (buttons.length === 0 && coach === null && !rebuyPanel && !overPanel && !view.resolving && !view.sending) return null;
      /** The coach's one-line recommendation, sitting right above the buttons. */
      // The badge shows the headline; its tooltip carries the WHY, so the player
      // can see the reasoning without opening the teaching window ("why does it
      // want me to fold?" is the question this answers).
      const why = view.coach && Array.isArray(view.coach.sections)
        ? (view.coach.sections.find((section) => section.id === 'plan') || {}).lines || []
        : [];
      // One line, always: the advice is a badge above the buttons, and a long
      // sentence used to wrap the label itself onto a second row ("教练建/议") and
      // push the buttons down. The full sentence lives in the tooltip.
      const adviceLine = advice && advised !== null && settings.showAdvice !== false
        ? React.createElement(
            'div',
            {
              className: 'dshp-advice'
                + (advice.tone === 'good' ? ' dshp-adviceGood' : advice.tone === 'warn' ? ' dshp-adviceWarn' : advice.tone === 'bad' ? ' dshp-adviceBad' : ''),
              title: why.length > 0 ? why.join('\n') : advice.headline,
            },
            React.createElement('span', { className: 'dshp-adviceLabel' },
              view.coach && view.coach.mode === 'gto' ? '\u265f GTO \u5efa\u8bae' : '\u{1F393} \u6559\u7ec3\u5efa\u8bae'),
            React.createElement('span', { className: 'dshp-adviceText' }, advice.headline),
          )
        : null;
      // The click's own acknowledgement, shown from the instant it is sent until
      // the answer lands: the menu is withdrawn so a second click cannot double up.
      const sendingRow = view.sending
        ? React.createElement('div', { className: 'dshp-resolving' },
            React.createElement('span', { className: 'dshp-spinner' }),
            '\u5df2\u53d1\u51fa\uff0c\u7b49\u724c\u684c\u56de\u5e94\u2026',
          )
        : null;
      return React.createElement(
        'div',
        { className: 'dshp-actionsCol' },
        // While the opponents' replay is running there is deliberately no action
        // menu: the table is still settling and a stale click would not match.
        view.resolving
          ? React.createElement('div', { className: 'dshp-resolving' },
              React.createElement('span', { className: 'dshp-spinner' }),
              view.replay && view.replay.total > 0
                ? `\u5bf9\u624b\u884c\u52a8\u4e2d\u2026 ${view.replay.done}/${view.replay.total}`
                  + (view.replay.label ? ` \u00b7 ${view.replay.label}` : '')
                : '\u5bf9\u624b\u884c\u52a8\u4e2d\u2026',
            )
          : sendingRow,
        // A refused click is answered HERE, next to the button that caused it - never
        // in the conversation.
        view.notice
          ? React.createElement('div', { className: 'dshp-notice' },
              React.createElement('span', { className: 'dshp-noticeMark' }, '\u26a0'),
              React.createElement('span', null, view.notice),
            )
          : null,
        adviceLine,
        overPanel,
        rebuyPanel,
        buttons.length > 0 && !view.sending ? React.createElement('div', { className: 'dshp-btnRow' }, buttons) : null,
        sizingRow,
        coach,
      );
    }

    /**
     * The pot, drawn as a stack of chips.
     *
     * Three rims and one face. Each rim is offset by less than its own height, so
     * a few pixels of every chip show below the one above it - that banding is
     * what makes a stack read as a stack. The face is last so it paints on top,
     * with a pixel of jitter so the pile looks pushed together by hand.
     * @returns an array of chip elements.
     */
    function potChips() {
      const pile = [
        { cls: 'dshp-chipW', x: 0, y: 24, r: -3 },
        { cls: 'dshp-chipG', x: 1, y: 20, r: 2 },
        { cls: 'dshp-chipW', x: 0, y: 16, r: -2 },
        { cls: 'dshp-chipR dshp-chipTop', x: 0, y: 0, r: 10 },
      ];
      return pile.map((chip, index) => React.createElement('span', {
        key: 'chip' + index,
        className: 'dshp-chip ' + chip.cls,
        style: { left: chip.x + 'px', top: chip.y + 'px', transform: 'rotate(' + chip.r + 'deg)' },
      }));
    }

    /** The table itself: an oval felt with seats on the rail and the pot in the middle. */
    function TableView(props) {
      const view = props.view;
      const act = props.act;
      const compact = props.compact === true;
      // Hooks first, unconditionally.
      const settings = usePluginSettings();
      /** Optional element rendered between the felt and the bottom modules. */
      const slot = props.slot ?? null;
      // Normalise at the boundary: a view that lost a field must degrade to an
      // emptier table, never to a thrown child render the fence cannot catch.
      const boardCards = Array.isArray(view.board) ? view.board : [];
      const players = Array.isArray(view.players) ? view.players : [];
      // What the HERO still owes this street. Read from their own commitment, not
      // from `currentBet`: after the hero bets, the price on the table is their own
      // bet, and showing it back to them as "需跟" was both wrong and confusing.
      const heroSeat = players.find((player) => player.isHuman) || players[0];
      const heroToCall = heroSeat
        ? Math.max(0, Number(view.currentBet || 0) - Number(heroSeat.streetCommitted || 0))
        : 0;

      // Seat geometry: the hero sits at the bottom centre, and increasing seat
      // index - the engine's own action order - walks counter-clockwise around
      // the rail, so the next player to act is always on the hero's left.
      //
      // A bigger table needs a TALLER oval: with three seats stacked down each
      // side, a flat 1.78:1 felt leaves ~60px between neighbours while a seat
      // tile is ~87px, so the tiles overlap. The table grows instead of the
      // tiles shrinking - readable cards matter more than a compact panel.
      const count = Math.max(1, players.length);
      const dense = count >= 7;
      const aspectRatio = count >= 9 ? 1.32 : dense ? 1.45 : 1.78;
      const radiusX = count >= 9 ? 39.5 : dense ? 41.5 : 45;
      // The vertical radius is what keeps a tall seat tile off the pot in the
      // middle: seats sit nearer the rail, so the top tile ends above the pot and
      // the hero's tile (which grows rows as the hand goes on) starts below the
      // board. 49% for a normal ring, and the same treatment for a full one - the
      // tile can carry a status row, a made hand and a win badge at once.
      const radiusY = dense ? 48 : 49;
      const seatWidth = count >= 8 ? 92 : dense ? 96 : 106;
      const positions = seatPositions(view);
      const terms = streetTerms(view);
      const seats = players.map((seat, index) => {
        const angle = Math.PI / 2 + (index * 2 * Math.PI) / count;
        const left = 50 + radiusX * Math.cos(angle);
        const top = 50 + radiusY * Math.sin(angle);
        const anchor = readAnchor(top, left);
        return React.createElement(Seat, {
          key: seat.seat,
          seat,
          view,
          position: positions.get(seat.seat) ?? null,
          anchor,
          placement: readPlacement(anchor),
          dealer: seat.seat === view.buttonSeat ? true : null,
          term: terms.get(seat.seat) || null,
          style: {
            left: left.toFixed(2) + '%',
            top: top.toFixed(2) + '%',
            width: seatWidth + 'px',
          },
        });
      });

      // The board: only the cards that are actually out, all five evenly spaced -
      // one board, one rhythm. Dashed placeholders for the cards still to come
      // used to sit on the felt and were the loudest thing on it while saying
      // nothing; unequal street gaps were tried and read as a layout bug.
      const board = [];
      if (boardCards.length > 0) {
        const slots = boardCards.length;
        // The cards of the street that was just dealt animate in; earlier streets
        // are already on the felt and must stay still.
        const dealt = typeof view.justDealt === 'number' && view.justDealt > 0 ? view.justDealt : 0;
        // Cards come out one at a time, so "which cards are new" is the board as
        // it stood before this beat - not a guess from the board size.
        const freshFrom = dealt === 0
          ? slots
          : (typeof view.dealtFrom === 'number' && view.dealtFrom >= 0 ? view.dealtFrom : dealt);
        for (let index = 0; index < slots; index += 1) {
          board.push(React.createElement(Card, {
            key: 'board' + index,
            code: boardCards[index],
            variant: index >= freshFrom ? 'dshp-dealIn' : undefined,
          }));
        }
      }

      const equity = view.equity
        ? React.createElement(
            'div',
            { className: 'dshp-equity' },
            React.createElement('span', { className: 'dshp-muted' }, '\u80dc ' + view.equity.win + '% \u00b7 \u5e73 ' + view.equity.tie + '% \u00b7 \u8d1f ' + view.equity.lose + '%'),
            React.createElement('div', { className: 'dshp-bar', style: { flex: '1' } },
              React.createElement('div', { className: 'dshp-barFill', style: { width: Math.max(0, Math.min(100, view.equity.equity)) + '%' } }),
            ),
            React.createElement('strong', null, view.equity.equity + '%'),
          )
        : null;

      // The showdown is already a block inside the hand log, so it is not
      // repeated here: one column, one story.
      const logLines = !compact && Array.isArray(view.log) ? view.log.slice(-16) : [];
      const log = logLines.length > 0
        ? React.createElement('div', { className: 'dshp-log' }, handLogBlocks(logLines).map((block, blockIndex) => React.createElement(
            'div',
            { className: 'dshp-logBlock', key: 'b' + blockIndex },
            React.createElement(
              'div',
              { className: 'dshp-logHead' },
              block.title,
              block.board ? React.createElement('span', { className: 'dshp-logBoard' }, block.board) : null,
            ),
            block.entries.map((entry, index) => React.createElement(
              'div',
              { className: 'dshp-logRow' + (entry.showdown ? ' dshp-logShow' : ''), key: 'e' + index },
              React.createElement('span', { className: 'dshp-logWho' }, entry.who),
              entry.action ? React.createElement('span', { className: 'dshp-logAct' }, entry.action) : null,
              entry.talk ? React.createElement('span', { className: 'dshp-logTalk' }, '\u201c' + entry.talk + '\u201d') : null,
            )),
          )))
        : null;

      return React.createElement(
        'div',
        { className: 'dshp-root' },
        React.createElement(
          'div',
          { className: 'dshp-table', 'data-seats': String(count), style: { aspectRatio: String(aspectRatio) } },
          React.createElement(
            'div',
            { className: 'dshp-felt' },
            // Felt dressing first, so the seats and the pot sit on top of it.
            React.createElement('span', { className: 'dshp-feltMark' }, '\u2660 \u2665 \u2666 \u2663'),
            React.createElement('span', { className: 'dshp-feltLine' }),
            React.createElement(
              'div',
              { className: 'dshp-center' },
              React.createElement('span', { className: 'dshp-pot' },
                React.createElement('span', { className: 'dshp-potStack' }, potChips()),
                chips(view.pot),
                React.createElement('span', { className: 'dshp-bb dshp-bbBig' }, bbLabel(view.pot, view) || ''),
              ),
              board.length > 0 ? React.createElement('div', { className: 'dshp-boardRow' }, board) : null,
              // The caption, then how much is owed: the reader asked for the
              // "需跟" amount directly under the hand/street line. It is the HERO's
              // own call - `currentBet` is the table's price, which after the hero
              // bets is their own bet, so "需跟 200" appeared right after betting
              // 200. Nothing owed means no line.
              React.createElement('span', { className: 'dshp-street' },
                (view.handNumber ? '\u7b2c ' + view.handNumber + ' \u624b \u00b7 ' + view.streetLabel : '\u724c\u684c\u5c31\u7eea')
                + (view.pots && view.pots.length > 1 && boardCards.length >= 3 ? ' \u00b7 \u8fb9\u6c60 ' + view.pots.length + ' \u5c42' : ''),
              ),
              heroToCall > 0 ? React.createElement('span', { className: 'dshp-street' },
                '\u9700\u8ddf ' + chips(heroToCall) + ' ',
                bbLabel(heroToCall, view) ? React.createElement('span', { className: 'dshp-bb' }, bbLabel(heroToCall, view)) : null,
              ) : null,
              // The host reloads the plugin's own code when its files change, so
              // one pill tells the player their edit is already live in this hand.
              view.reload
                ? React.createElement('span', {
                    className: 'dshp-reload',
                    title: '\u5df2\u91cd\u65b0\u52a0\u8f7d\uff1a' + (Array.isArray(view.reload.files) && view.reload.files.length > 0 ? view.reload.files.join(', ') : 'lib/*.js'),
                  }, '\u{1F501} \u4ee3\u7801\u5df2\u70ed\u91cd\u8f7d ' + (view.reload.clock || ''))
                : null,
            ),
            seats,
          ),
        ),
        // The host panel can drop its own strip in here (the table-swap chooser):
        // inside the card, directly under the felt, instead of floating anywhere.
        slot,
        // Bottom area: strategy on the left, history on the right, so the log
        // reads as a side column instead of one more stacked row.
        React.createElement(
          'div',
          { className: 'dshp-bottom' },
          React.createElement(
            'div',
            { className: 'dshp-main' },
            equity,
            React.createElement('div', { className: 'dshp-controls' }, React.createElement(Actions, { view, act, onStart: props.onStart })),
          ),
          // `showLog` off drops the whole column, so the strategy area gets the
          // width instead of sitting next to an empty panel.
          settings.showLog === false
            ? null
            : React.createElement(
                'div',
                { className: 'dshp-side' },
                React.createElement('span', { className: 'dshp-sideTitle' }, '\u724c\u5c40\u8bb0\u5f55'),
                log,
              ),
        ),
      );
    }

    /**
     * Group the hand log into street blocks, so the side column reads as a story
     * instead of one grey paragraph.
     *
     * The engine writes the log as plain sentences (`小美 下注 1800：“看一眼不亏”`,
     * `发牌：翻牌 5♦2♣K♥`) because the model reads them too. This only regroups
     * those strings - the panel and the model still see exactly the same facts.
     * @param lines - `view.log`, oldest first.
     * @returns `[{ title, board, entries: [{ who, action, talk, showdown }] }]`.
     */
    function handLogBlocks(lines) {
      const blocks = [];
      let block = { title: '\u672c\u624b\u5f00\u59cb', board: '', entries: [] };
      blocks.push(block);
      for (const raw of lines) {
        const line = typeof raw === 'string' ? raw.trim() : '';
        if (line === '') continue;
        const deal = /^\u53d1\u724c\uff1a(\S+)\s*(.*)$/.exec(line);
        if (deal) {
          block = { title: '\u53d1\u724c \u00b7 ' + deal[1], board: deal[2] || '', entries: [] };
          blocks.push(block);
          continue;
        }
        if (/^\u644a\u724c/.test(line)) {
          if (block.title !== '\u644a\u724c') {
            block = { title: '\u644a\u724c', board: '', entries: [] };
            blocks.push(block);
          }
          const rest = line.replace(/^\u644a\u724c\s*/, '');
          const split = rest.indexOf('\uff1a');
          block.entries.push({
            who: split > 0 ? rest.slice(0, split) : '\u644a\u724c',
            action: split > 0 ? rest.slice(split + 1) : rest,
            talk: '',
            showdown: true,
          });
          continue;
        }
        const marker = /^\u2014{2}\s*(.+?)\s*\u2014*$/.exec(line);
        if (marker) {
          block = { title: marker[1], board: '', entries: [] };
          blocks.push(block);
          continue;
        }
        const space = line.indexOf(' ');
        const who = space > 0 ? line.slice(0, space) : line;
        let rest = space > 0 ? line.slice(space + 1) : '';
        const talk = /\u201c([^\u201d]*)\u201d/.exec(rest);
        if (talk) rest = rest.replace(/\s*\uff1a?\u201c[^\u201d]*\u201d\s*$/, '');
        block.entries.push({
          who: who.replace(/\uff1a$/, ''),
          action: rest.trim(),
          talk: talk ? talk[1] : '',
          showdown: false,
        });
      }
      return blocks.filter((item) => item.entries.length > 0 || item.board !== '');
    }

    /** A one-line summary for the header button. */
    function summarise(view) {
      if (!view) return '\u672a\u5f00\u684c';
      if (view.gameOver) return '\u724c\u5c40\u7ed3\u675f';
      const actor = view.players.find((seat) => seat.seat === view.actorSeat);
      const who = actor ? (actor.isHuman ? '\u8be5\u4f60' : actor.name) : view.phase === 'handover' ? '\u672c\u624b\u7ed3\u675f' : '';
      return ('\u7b2c ' + view.handNumber + ' \u624b\u00b7' + view.streetLabel + ' \u00b7 ' + chips(view.pot)) + (who ? ' \u00b7 ' + who : '');
    }

    /**
     * The session-header button plus its floating panel. This is the persistent
     * surface: it always shows the newest table in the session, whichever tool
     * call produced it, and it doubles as the plugin's own load indicator.
     */
    /** Where the panel sits, and whether it is pinned, remembered across visits. */
    const LAYOUT_KEY = 'dsh-plugin-poker/panel';

    /** Read the remembered layout of one floating window, tolerating no storage. */
    function readWindowLayout(key) {
      try {
        const raw = window.localStorage ? window.localStorage.getItem(key) : null;
        if (!raw) return { position: null, pinned: false };
        const parsed = JSON.parse(raw);
        const position = parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number' ? { x: parsed.x, y: parsed.y } : null;
        return { position, pinned: parsed && parsed.pinned === true };
      } catch (error) {
        return { position: null, pinned: false };
      }
    }

    /** Remember one window's layout for the next visit; failure is never fatal. */
    function writeWindowLayout(key, position, pinned) {
      try {
        if (!window.localStorage) return;
        window.localStorage.setItem(key, JSON.stringify({
          x: position ? position.x : null,
          y: position ? position.y : null,
          pinned: pinned === true,
        }));
      } catch (error) {
        // A layout that cannot be stored is not worth breaking the table over.
      }
    }

    /**
     * Keep a remembered window position usable: a window saved on a bigger
     * screen (or dragged off the edge) is pulled back into view instead of
     * reappearing where nobody can reach it.
     * @param position - `{ x, y }` or null.
     * @param width - the window's own width in pixels.
     */
    function clampWindowPosition(position, width) {
      if (!position) return null;
      const maxX = Math.max(8, (window.innerWidth || 1200) - (width || 460) - 8);
      const maxY = Math.max(8, (window.innerHeight || 800) - 80);
      return {
        x: Math.max(8, Math.min(maxX, Math.round(position.x))),
        y: Math.max(8, Math.min(maxY, Math.round(position.y))),
      };
    }

    /**
     * Drag one floating window by its title bar, clamped to the viewport.
     *
     * Shared by the table panel and the teaching window so both behave the same
     * way: a pinned window refuses to move, a press on a title-bar button is a
     * click rather than a drag, and the position is written down on release.
     * @param options.pinned - whether the window refuses to move.
     * @param options.moveTo - called with `{ x, y }` while dragging.
     * @param options.drop - called once on release.
     * @param options.onDragChange - optional `(dragging) => void` for the cursor.
     */
    function startWindowDrag(options) {
      return (event) => {
        if (options.pinned) return;
        // The title bar holds buttons: a press on one of them is a click, not a drag.
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('button')) return;
        if (event.button !== undefined && event.button !== 0) return;
        const header = event.currentTarget;
        const window_ = header && header.parentElement;
        if (!window_ || typeof window_.getBoundingClientRect !== 'function') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        const rect = window_.getBoundingClientRect();
        const dx = event.clientX - rect.left;
        const dy = event.clientY - rect.top;
        if (typeof options.onDragChange === 'function') options.onDragChange(true);
        const onMove = (moveEvent) => {
          const width = window_.offsetWidth || 460;
          options.moveTo({
            x: Math.max(8, Math.min((window.innerWidth || 1200) - width - 8, moveEvent.clientX - dx)),
            y: Math.max(8, Math.min((window.innerHeight || 800) - 60, moveEvent.clientY - dy)),
          });
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          if (typeof options.onDragChange === 'function') options.onDragChange(false);
          options.drop();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      };
    }

    /**
     * The table-size picker: one click opens that table straight through the
     * plugin route, with the chat prompt kept only as a fallback.
     * @param props.onPick - called with the player count.
     * @param props.onCancel - present when a table already exists (a re-open).
     */
    function TablePicker(props) {
      const open = props.onPick;
      const choices = [
        { players: 2, caption: '\u5355\u6311' },
        { players: 3, caption: '\u4e09\u4eba' },
        { players: 4, caption: '\u56db\u4eba' },
        { players: 5, caption: '\u4e94\u4eba' },
        { players: 6, caption: '\u516d\u4eba\u00b7\u6807\u51c6' },
        { players: 7, caption: '\u4e03\u4eba' },
        { players: 8, caption: '\u516b\u4eba' },
        { players: 9, caption: '\u4e5d\u4eba\u00b7\u5168\u73af' },
      ];
      const now = Number(props.current || 0);
      // Swapping a table keeps the table on screen: the picker is a slim strip
      // under it, sized as chips, with the size you are playing marked. The big
      // card grid is only for the empty state, where there is nothing to keep.
      if (props.existing) {
        // Just the number: "3 人 三人" said the same thing twice. The caption is
        // still there, in the tooltip, for the sizes that need explaining.
        const chips = choices.map((choice) => React.createElement(
          'button',
          {
            key: choice.players,
            className: 'dshp-pickChip' + (choice.players === now ? ' dshp-pickChipNow' : ''),
            type: 'button',
            title: choice.players + ' \u4eba\u684c\uff1a' + choice.caption + '\uff08\u5176\u4f59\u5e2d\u4f4d\u7531\u673a\u5668\u4eba\u5360\u636e\uff09',
            onClick: () => open(choice.players),
          },
          choice.players + ' \u4eba',
        ));
        return React.createElement(
          'div',
          { className: 'dshp-pickStrip' },
          React.createElement('span', { className: 'dshp-pickStripTitle' }, '\u{1F504} \u6362\u4e00\u5f20\u724c\u684c'),
          chips,
          React.createElement('span', { className: 'dshp-headGrow' }),
          React.createElement('button', { className: 'dshp-btn dshp-btnGhost dshp-pickCancel', type: 'button', onClick: props.onCancel }, '\u53d6\u6d88'),
        );
      }
      const buttons = choices.map((choice) => React.createElement(
        'button',
        {
          key: choice.players,
          className: 'dshp-pick',
          type: 'button',
          onClick: () => open(choice.players),
        },
        React.createElement('strong', null, choice.players + ' \u4eba'),
        React.createElement('span', null, choice.caption),
      ));
      return React.createElement(
        'div',
        { className: 'dshp-picker' },
        React.createElement(
          'div',
          { className: 'dshp-coachHead' },
          React.createElement('span', { className: 'dshp-coachTitle' }, '\u9009\u62e9\u51e0\u4eba\u684c'),
          React.createElement('span', { className: 'dshp-bb dshp-bbPane' }, '\u5176\u4f59\u5e2d\u4f4d\u7531\u673a\u5668\u4eba\u5360\u636e\uff0c\u4f60\u5750 0 \u53f7\u5e2d'),
        ),
        React.createElement('div', { className: 'dshp-pickGrid' }, buttons),
        React.createElement('div', { className: 'dshp-tip' }, '\u9ed8\u8ba4\u914d\u7f6e\uff1a\u8d77\u59cb 10,000 \u7b79\u7801\uff08100BB\uff09\u3001\u76f2\u6ce8 50/100\u3001\u673a\u5668\u4eba\u6027\u683c\u6df7\u5408\u3002\u5f00\u684c\u4e0d\u4f1a\u5f80\u5bf9\u8bdd\u91cc\u53d1\u6d88\u606f\u3002'),
      );
    }

    function HeaderAction(props) {
      // The sidebar mounts this WITHOUT a session (one surface for the whole app,
      // which is what stops a conversation switch from replaying the hand). A
      // session-scoped mount still passes one, and then the panel can also read
      // that session's own log - which is how an embedded surface stays useful.
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : SHARED_CACHE_KEY;
      const [open, setOpen] = React.useState(false);
      const [choosing, setChoosing] = React.useState(false);
      const rootRef = React.useRef(null);
      const settings = usePluginSettings();
      // Every hook runs before this component is allowed to render nothing: a switch that
      // is read from settings cannot sit above the hooks, because React counts hooks per
      // render and a changing count throws the whole entry off the sidebar.
      const hidden = settings.pluginEnabled === false;
      // Position and pin live in the shared window store, so a drag survives the
      // replay re-renders and the teaching window never inherits this one's spot.
      const layout = useWindowState(LAYOUT_KEY, 660);
      const pinned = layout.pinned === true;
      const position = layout.position;
      const latest = useLatestTable(sessionId);
      const act = useAct(sessionId);
      const view = latest && latest.view ? latest.view : null;

      // Opening the panel re-reads the shared table: after the player has been
      // playing in another conversation, THIS session should catch up the moment
      // it is looked at, not stay on whatever it last saw.
      React.useEffect(() => {
        if (open) discoverSharedTable(sessionId, { force: true });
      }, [open, sessionId]);

      // `autoOpen`: pop the panel as soon as the page loads.
      React.useEffect(() => {
        if (settings.autoOpen === true) setOpen(true);
      }, [settings.autoOpen]);

      // Register this panel as a table reader, so a settings change (the coach style, the
      // AI seats) can pull the host's new view without waiting for the next click.
      React.useEffect(() => {
        const refresher = () => discoverSharedTable(sessionId, { force: true });
        TABLE_REFRESHERS.add(refresher);
        return () => TABLE_REFRESHERS.delete(refresher);
      }, [sessionId]);

      // An AI seat is answered in the HOST, after this page's click has already
      // returned - so while one is thinking, poll for the table's next revision.
      // Bounded: a dead endpoint must not leave a timer running forever, and the
      // host falls back to the heuristic policy on its own regardless.
      const aiThinking = view && view.pendingDecision && view.pendingDecision.kind === 'ai';
      React.useEffect(() => {
        if (!aiThinking) return undefined;
        let polls = 0;
        const timer = setInterval(() => {
          polls += 1;
          if (polls > 30) {
            clearInterval(timer);
            return;
          }
          discoverSharedTable(sessionId, { force: true });
        }, AI_POLL_MS);
        return () => clearInterval(timer);
      }, [aiThinking, sessionId]);

      /**
       * Open a table of `players` seats: one route call, no chat message. If the
       * route is unavailable the action falls back to a prompt, so the table
       * still gets opened by the model.
       */
      const openTable = async (players) => {
        await act(null, 'new', { botCount: players - 1, sessionId }, `\u5f00\u4e00\u684c${players}\u4eba\u684c\u5fb7\u5dde\u6251\u514b`);
        setChoosing(false);
      };

      // Close on a click outside the panel - unless it is pinned, which is the
      // whole point of pinning. There is deliberately NO full-screen backdrop:
      // the table must never stop the reader from scrolling the conversation.
      React.useEffect(() => {
        if (!open || pinned) return undefined;
        const onPointerDown = (event) => {
          const node = rootRef.current;
          if (node && event.target && !node.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open, pinned]);

      /** Drag the panel by its header, clamped to the viewport. */
      const startDrag = startWindowDrag({
        pinned,
        moveTo: (next) => setWindowPosition(LAYOUT_KEY, next, 660),
        drop: () => persistWindowState(LAYOUT_KEY),
      });

      const panelStyle = position
        ? { left: position.x + 'px', top: position.y + 'px' }
        : { right: '20px', top: '68px' };

      // The plugin switch, applied HERE and nowhere earlier: off hides the entry (the
      // tools keep working, so a conversation that is mid-hand is never broken by a
      // settings change). It has to be the last thing before the render, because every
      // hook above it runs on every render either way.
      if (hidden) return null;

      const panel = open
        ? React.createElement(
            'div',
            { className: 'dshp-panel', style: panelStyle },
            React.createElement(
              'div',
              { className: 'dshp-panelHead' + (pinned ? ' dshp-panelHeadPinned' : ''), onPointerDown: startDrag, title: pinned ? '\u5df2\u56fa\u5b9a\uff1a\u4e0d\u53ef\u62d6\u52a8\uff0c\u70b9\u5916\u90e8\u4e5f\u4e0d\u4f1a\u5173\u95ed' : '\u62d6\u52a8\u53ef\u79fb\u52a8\u9762\u677f' },
              React.createElement('span', { className: 'dshp-title' }, React.createElement(TitleMark, { size: 24 }), '\u5fb7\u5dde\u6251\u514b'),
              React.createElement('span', { className: 'dshp-muted dshp-headGrow' }, view ? summarise(view) : '\u672c\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u724c\u684c'),
              // Icons only: the title bar is a toolbar. The teaching switch is the
              // one control that changes what you SEE, so it leads the cluster
              // (amber chip) and the pin trails it on the right.
              React.createElement(CoachToggle, {}),
              view ? React.createElement('button', {
                // The swap strip is open right now: the icon says so, the same way
                // the pin lights up while the panel is pinned.
                className: 'dshp-iconBtn' + (choosing ? ' dshp-iconBtnOn' : ''),
                type: 'button',
                title: choosing ? '\u6536\u8d77\u6362\u684c\u9009\u9879' : '\u6362\u4e00\u5f20\u724c\u684c\uff08\u53ef\u9009\u4eba\u6570\uff09',
                onClick: () => setChoosing(!choosing),
              }, '\u{1F504}') : null,
              React.createElement('button', {
                className: 'dshp-iconBtn' + (pinned ? ' dshp-iconBtnOn' : ''),
                type: 'button',
                title: pinned ? '\u5df2\u56fa\u5b9a\uff08\u70b9\u51fb\u89e3\u9664\uff09\uff1a\u4e0d\u53ef\u62d6\u52a8\u3001\u70b9\u5916\u90e8\u4e0d\u5173\u95ed\uff0c\u5e76\u8bb0\u4f4f\u4f4d\u7f6e' : '\u56fa\u5b9a\u9762\u677f\uff1a\u4e0d\u53ef\u62d6\u52a8\u3001\u4e0d\u4f1a\u88ab\u70b9\u5916\u90e8\u5173\u95ed\uff0c\u5e76\u8bb0\u4f4f\u4f4d\u7f6e',
                onClick: () => setWindowPinned(LAYOUT_KEY, !pinned, 660),
              }, '\u{1F4CC}'),
              React.createElement('button', { className: 'dshp-close', type: 'button', onClick: () => setOpen(false) }, '\u00d7'),
            ),
            // With a table on screen the picker is a STRIP inside the card, right
            // under the felt, so the player can see the table they are about to
            // leave; with no table it IS the content, in its full card-grid form.
            view
              ? React.createElement(TableView, {
                  view,
                  act,
                  onStart: () => releaseHeld(sessionId),
                  slot: choosing
                    ? React.createElement(TablePicker, {
                        existing: true,
                        current: view.players ? view.players.length : 0,
                        onPick: openTable,
                        onCancel: () => setChoosing(false),
                      })
                    : null,
                })
              : React.createElement(TablePicker, {
                  existing: false,
                  onPick: openTable,
                  onCancel: () => setChoosing(false),
                }),
          )
        : null;
      return React.createElement(
        'span',
        { className: 'dshp-headerRoot', ref: rootRef },
        React.createElement(
          'button',
          {
            className: 'dshp-headerBtn' + (open ? ' dshp-headerBtnOn' : '') + (props.wide === false ? ' dshp-headerBtnRail' : ''),
            type: 'button',
            title: view ? '\u5fb7\u5dde\u6251\u514b\u724c\u684c\uff1a' + summarise(view) : '\u5fb7\u5dde\u6251\u514b\u724c\u684c',
            onClick: () => setOpen(!open),
          },
          // The mark carries its own frame, so the row reads as a sidebar module.
          React.createElement(
            'span',
            { className: 'dshp-iconTile' },
            React.createElement(SpadeMark, { size: props.wide === false ? 15 : 14 }),
          ),
          // The sidebar reports whether it is wide enough for a label; a collapsed
          // rail gets the glyph alone rather than a truncated sentence.
          props.wide === false
            ? null
            : React.createElement(
                'span',
                { className: 'dshp-headerState' },
                [
                  React.createElement('span', { className: 'dshp-headerLabel', key: 'label' }, '\u724c\u684c'),
                  React.createElement('span', { key: 'state' }, summarise(view)),
                ],
              ),
        ),
        panel,
        // The teaching window is a sibling of the table panel: it opens on the
        // left, keeps its own position, and stays put when the table panel closes.
        React.createElement(CoachWindow, { view }),
      );
    }

    /** The inline table card that replaces one poker tool call's row. */
    function PokerCard(props) {
      try {
        return renderCard(props);
      } catch (error) {
        // A card that cannot render must degrade to a one-line row: the
        // transcript is the user's only view of the game.
        if (typeof console !== 'undefined') console.warn('poker: card render failed', error);
        return React.createElement('div', { className: 'dshp-root' },
          React.createElement('span', { className: 'dshp-title' }, React.createElement(TitleMark, { size: 18 }), '\u5fb7\u5dde\u6251\u514b'),
          '\uff08\u724c\u684c\u6e32\u67d3\u5931\u8d25\uff0c\u8be6\u60c5\u89c1\u63a7\u5236\u53f0\uff09');
      }
    }

    /** The card body, wrapped by {@link PokerCard}'s failure fence. */
    function renderCard(props) {
      const block = props.block;
      const settled = block && block.kind === 'tool-result';
      const candidate = settled && block.meta ? block.meta.view : null;
      const captured = looksLikeTableView(candidate) ? candidate : null;
      // Follow the live table only when THIS card is the one it grew out of.
      const live = useLiveTable(props.sessionId);
      const liveView = live && live.view ? live.view : null;
      const follows = captured !== null && live !== null && Array.isArray(live.chain) && live.chain.includes(captured.revision ?? 0);
      const view = follows && liveView ? liveView : captured;
      const act = useAct(props.sessionId);
      if (!view) {
        return React.createElement(
          'div',
          { className: 'dshp-root dshp-compact' },
          React.createElement('div', { className: 'dshp-head' },
            React.createElement('span', { className: 'dshp-title' }, React.createElement(TitleMark, { size: 18 }), '\u5fb7\u5dde\u6251\u514b'),
            React.createElement('span', { className: 'dshp-muted' }, settled ? '\u8be5\u8c03\u7528\u6ca1\u6709\u724c\u684c\u5feb\u7167' : '\u6b63\u5728\u5904\u7406\u724c\u5c40\u2026'),
          ),
        );
      }
      const pending = view.pending && view.pending.name
        ? React.createElement('div', { className: 'dshp-head' },
            React.createElement('span', { className: 'dshp-badge dshp-badgePane' }, '\u6a21\u578b\u4ee3\u6253'),
            React.createElement('span', { className: 'dshp-muted' }, '\u7b49\u5f85 ' + view.pending.name + ' \u51b3\u7b56'),
          )
        : null;
      return React.createElement(
        'div',
        { className: 'dshp-root' },
        React.createElement('div', { className: 'dshp-head' },
          React.createElement('span', { className: 'dshp-title' }, React.createElement(TitleMark, { size: 18 }), '\u5fb7\u5dde\u6251\u514b'),
          React.createElement('span', { className: 'dshp-muted' }, view.botBrain === 'model' ? '\u6a21\u578b\u4ee3\u6253\u6a21\u5f0f' : '\u5185\u7f6e\u7b56\u7565\u5bf9\u624b'),
          view.gameOver ? React.createElement('span', { className: 'dshp-badge dshp-badgePane' }, '\u724c\u5c40\u7ed3\u675f') : null,
          React.createElement(CoachToggle, {}),
        ),
        pending,
        React.createElement(TableView, { view, act, compact: false, onStart: () => releaseHeld(props.sessionId) }),
      );
    }

    /**
     * Client plugin body: own every poker tool's card, and add the persistent
     * session-header surface.
     *
     * Deliberately total: the shell asserts that every boot-graph entry reaches
     * `active` and shows a failure page otherwise, so a surface that cannot
     * register must degrade to no surface rather than break the whole GUI.
     */
    function apply(ctx) {
      try {
        const slots = ctx.get('slots');
        if (slots === undefined) {
          if (typeof console !== 'undefined') console.warn('poker: the slots service is unavailable, table surfaces not registered');
          return;
        }
        pluginCtx = ctx;
        for (const toolName of TOOL_NAMES) {
          slots.inject('tool.call.toolview', () => slots.register({ name: 'tool.call.toolview', key: toolName }, PokerCard));
        }
        // The panel hangs off the SIDEBAR FOOTER, not the session header. The
        // sidebar is one surface for the whole application, so switching
        // conversations no longer remounts the panel - and no longer replays the
        // hand the other conversation already showed.
        slots.inject('sidebar.footer.action', () => slots.register(
          { name: 'sidebar.footer.action', id: 'poker', order: 30 },
          HeaderAction,
        ));
        // The plugin's own page in the settings dialog: the AI opponents and the
        // endpoint they use.
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'poker', order: 60, label: '\u5fb7\u5dde\u6251\u514b' },
          PokerSettings,
        ));
        if (typeof console !== 'undefined') {
          console.info(`[poker] client half active: ${TOOL_NAMES.length} table cards + sidebar panel`);
        }
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('poker: failed to register table surfaces', error);
      }
    }

    /**
     * The plugin's page in the settings dialog.
     *
     * The host sends the values AND the field descriptors (group, control kind,
     * bounds, help, options), so this component draws whatever the schema declares:
     * adding a setting means adding it to `lib/settings.js`, never to this file. A
     * stored secret is reported as "set" and never travels back - the key field is
     * write-only.
     */
    function PokerSettings() {
      const [form, setForm] = React.useState(null);
      const [groups, setGroups] = React.useState([]);
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [keyDraft, setKeyDraft] = React.useState('');
      const [testing, setTesting] = React.useState(false);
      const [testResult, setTestResult] = React.useState(null);
      // Results of the `action` fields (check-for-update), keyed by field.
      const [actionResults, setActionResults] = React.useState({});
      React.useEffect(() => {
        let live = true;
        fetch('/poker/settings')
          .then((response) => response.json())
          .then((answer) => {
            if (!live || !answer || !answer.ok) return;
            setForm(answer.settings);
            setGroups(Array.isArray(answer.groups) ? answer.groups : []);
          })
          .catch(() => { if (live) setStatus('\u8bfb\u53d6\u8bbe\u7f6e\u5931\u8d25'); });
        return () => { live = false; };
      }, []);
      const patch = (key, value) => setForm((current) => Object.assign({}, current, { [key]: value }));
      /** The body every write sends: the form, plus a key only if one was typed. */
      const writeBody = () => {
        const payload = Object.assign({}, form);
        delete payload.hasApiKey;
        if (keyDraft !== '') payload.aiApiKey = keyDraft;
        return payload;
      };
      const post = async (path, payload) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return response.json();
      };
      /**
       * Write a settings patch and take the answer.
       *
       * Shared by the save button and by fields that apply on change (`apply: 'change'`),
       * so both paths refresh the panel: the host re-saves the open table on a settings
       * write, and this page has to pull that new view to see it.
       */
      const savePatch = async (patch) => {
        setBusy(true);
        setStatus('');
        try {
          const answer = await post('/poker/settings', Object.assign(writeBody(), patch || {}));
          if (answer && answer.ok) {
            setForm(answer.settings);
            if (Array.isArray(answer.groups)) setGroups(answer.groups);
            setKeyDraft('');
            // The host reports what it is actually running. A host that predates the
            // setting sends nothing, and saying "已保存" then would be a lie the player
            // discovers by watching the panel not change.
            setStatus(answer.applied === undefined
              ? '\u5df2\u4fdd\u5b58\uff08\u5f53\u524d\u5bbf\u4e3b\u8fd8\u6ca1\u91cd\u542f\uff0c\u91cd\u542f\u4e00\u6b21 dsh web \u540e\u751f\u6548\uff09'
              : '\u5df2\u4fdd\u5b58');
            refreshTables();
          } else {
            setStatus((answer && answer.error) || '\u4fdd\u5b58\u5931\u8d25');
          }
        } catch (error) {
          setStatus('\u4fdd\u5b58\u5931\u8d25');
        } finally {
          setBusy(false);
        }
      };
      const save = () => savePatch({});
      /**
       * Probe the endpoint with what is on screen - including a key that has not been
       * saved yet, so the player can test before committing to it.
       */
      const test = async () => {
        if (!form) return;
        setTesting(true);
        setTestResult(null);
        try {
          const answer = await post('/poker/settings-test', writeBody());
          setTestResult(answer && answer.ok ? answer.result : { ok: false, error: (answer && answer.error) || '\u6d4b\u8bd5\u5931\u8d25' });
        } catch (error) {
          setTestResult({ ok: false, error: '\u6d4b\u8bd5\u5931\u8d25' });
        } finally {
          setTesting(false);
        }
      };
      /**
       * Run a descriptor's action (the release check) and keep its lines.
       *
       * The host answers with lines to print, so this stays generic: any future
       * `kind: 'action'` field works without a line of client code.
       */
      const runAction = async (field) => {
        setActionResults((current) => Object.assign({}, current, { [field.key]: { running: true } }));
        try {
          const answer = await post(`/poker/${field.action}`, writeBody());
          setActionResults((current) => Object.assign({}, current, {
            [field.key]: answer && answer.ok ? answer.result : { ok: false, lines: [(answer && answer.error) || '\u64cd\u4f5c\u5931\u8d25'] },
          }));
        } catch (error) {
          setActionResults((current) => Object.assign({}, current, {
            [field.key]: { ok: false, lines: ['\u64cd\u4f5c\u5931\u8d25'] },
          }));
        }
      };
      if (!form) {
        return React.createElement('div', { className: 'dshp-set' },
          React.createElement('p', { className: 'dshp-setHint' }, status || '\u6b63\u5728\u8bfb\u53d6\u8bbe\u7f6e\u2026'));
      }
      const control = (field) => {
        const value = form[field.key];
        if (field.kind === 'info') {
          // A fact the host knows (the installed version) arrives in the DESCRIPTOR,
          // not in the form: reading it from `form` rendered an empty row.
          return React.createElement('span', { className: 'dshp-setValue' }, String(field.value ?? ''));
        }
        if (field.kind === 'action') {
          const result = actionResults[field.key];
          return React.createElement('span', { className: 'dshp-setActionCell' },
            React.createElement('button', {
              className: 'dshp-btn dshp-setTestBtn',
              type: 'button',
              disabled: result && result.running === true,
              onClick: () => runAction(field),
            }, result && result.running === true ? '\u67e5\u8be2\u4e2d\u2026' : '\u7acb\u5373\u68c0\u67e5'),
            result && Array.isArray(result.lines)
              ? React.createElement('span', { className: 'dshp-setTest' + (result.ok ? ' dshp-setTestOk' : ' dshp-setTestBad') },
                  result.lines.join(' '),
                  result.url ? ' ' : '',
                  result.url
                    ? React.createElement('a', { className: 'dshp-setLink', href: result.url, target: '_blank', rel: 'noreferrer' }, '\u6253\u5f00\u53d1\u5e03\u9875')
                    : null)
              : null,
          );
        }
        if (field.kind === 'boolean') {
          return React.createElement('input', {
            className: 'dshp-setCheck',
            type: 'checkbox',
            checked: value === true,
            onChange: (event) => patch(field.key, event.target.checked),
          });
        }
        if (field.kind === 'select') {
          return React.createElement('select', {
            className: 'dshp-setInput dshp-setSelect',
            value: String(value),
            onChange: (event) => {
              const raw = event.target.value;
              const match = (field.options || []).find((option) => String(option.value) === raw);
              const next = match ? match.value : raw;
              patch(field.key, next);
              // A field can ask to be applied the moment it changes (`apply: 'change'`):
              // a style switch has nothing to review, and making the player find the save
              // button for it is the difference between a switch and a form.
              if (field.apply === 'change') void savePatch({ [field.key]: next });
            },
          }, (field.options || []).map((option) => React.createElement('option', {
            key: String(option.value),
            value: String(option.value),
          }, option.label)));
        }
        if (field.kind === 'password') {
          return React.createElement('input', {
            className: 'dshp-setInput',
            type: 'password',
            value: keyDraft,
            placeholder: field.hasValue || form.hasApiKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : 'sk-\u2026',
            onChange: (event) => setKeyDraft(event.target.value),
          });
        }
        const numeric = field.kind === 'number';
        return React.createElement('input', {
          className: 'dshp-setInput',
          type: numeric ? 'number' : 'text',
          value: value === undefined || value === null ? '' : value,
          ...(field.min === undefined ? {} : { min: field.min }),
          ...(field.max === undefined ? {} : { max: field.max }),
          ...(field.step === undefined ? {} : { step: field.step }),
          onChange: (event) => patch(field.key, numeric ? Number(event.target.value) : event.target.value),
        });
      };
      const row = (field) => React.createElement('label', { className: 'dshp-setRow', key: field.key },
        React.createElement('span', { className: 'dshp-setLabel' }, field.label),
        control(field),
        field.hint ? React.createElement('span', { className: 'dshp-setHint' }, field.hint) : null,
      );
      const rendered = groups.map((group) => React.createElement('div', { className: 'dshp-setGroup', key: group.id },
        React.createElement('h4', { className: 'dshp-setGroupTitle' }, group.label),
        group.hint ? React.createElement('p', { className: 'dshp-setHint' }, group.hint) : null,
        group.fields.map(row),
      ));
      const testLine = testResult
        ? React.createElement('div', { className: 'dshp-setTest' + (testResult.ok ? ' dshp-setTestOk' : ' dshp-setTestBad') },
            testResult.ok
              ? `\u2705 \u8fde\u901a\uff1a${testResult.ms}ms \u00b7 ${testResult.model || ''}${testResult.reply ? ` \u00b7 \u56de\u590d\u201c${testResult.reply}\u201d` : ''}`
              : `\u274c \u5931\u8d25\uff1a${testResult.error || '\u672a\u77e5\u539f\u56e0'}`)
        : null;
      return React.createElement('div', { className: 'dshp-set' },
        // The same framed mark the sidebar entry wears, so the module is recognisable
        // in both places instead of being a bare heading here.
        React.createElement('div', { className: 'dshp-setHead' },
          React.createElement(TitleMark, { size: 24 }),
          React.createElement('h3', { className: 'dshp-setTitle' }, '\u5fb7\u5dde\u6251\u514b'),
        ),
        React.createElement('p', { className: 'dshp-setHint' },
          '\u8fd9\u91cc\u662f\u63d2\u4ef6\u81ea\u5df1\u7684\u8bbe\u7f6e\uff1b\u4fdd\u5b58\u540e\u7acb\u5373\u751f\u6548\uff08\u9762\u677f\u9700\u8981\u5237\u65b0\u4e00\u6b21\u624d\u4f1a\u91cd\u8bfb\u56de\u653e\u8282\u594f\u7b49\u9875\u9762\u7ea7\u8bbe\u7f6e\uff09\u3002'),
        rendered,
        React.createElement('div', { className: 'dshp-setRow' },
          React.createElement('button', {
            className: 'dshp-btn dshp-btnPrimary dshp-setSave',
            type: 'button',
            disabled: busy,
            onClick: save,
          }, busy ? '\u4fdd\u5b58\u4e2d\u2026' : '\u4fdd\u5b58'),
          React.createElement('button', {
            className: 'dshp-btn dshp-setTestBtn',
            type: 'button',
            disabled: testing,
            title: '\u7528\u5f53\u524d\uff08\u542b\u672a\u4fdd\u5b58\u7684\uff09\u914d\u7f6e\u53d1\u4e00\u6b21\u6700\u5c0f\u8bf7\u6c42',
            onClick: test,
          }, testing ? '\u6d4b\u8bd5\u4e2d\u2026' : '\u6d4b\u8bd5\u8fde\u901a'),
          status ? React.createElement('span', { className: 'dshp-setHint' }, status) : null,
        ),
        testLine,
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    // A test seam: the settings cache is module-level on purpose (a page fetches them
    // once), so the harness needs a way to force a re-read mid-test.
    exports.__testing = { loadPluginSettings, usePluginSettings };
    return module.exports;
  },
});