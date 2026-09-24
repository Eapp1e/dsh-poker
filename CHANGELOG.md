# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The coach style applies on change, and says so when it cannot.** The `coachMode` select no longer
  waits for 保存 (a style is nothing to review), and both it and the coach window's switcher now
  VERIFY the change: the settings route reports the style the host is actually running, so a click
  either takes effect or the window prints "已保存；当前宿主还不认得教练风格，重启一次 dsh web 后生效"
  instead of appearing to do nothing. The payload also carries `coach.settingsMode` - distinct from
  the mode that produced the payload, because GTO is a postflop layer - which is what the switcher
  highlights and what tells a restarted host from an older one.
- **The coach style is switchable from the coach window** (`简洁 | GTO` in its title bar), not only
  from the settings: whether to look at EV is a judgement about the current spot, not a one-time
  configuration. The click writes the setting (so it sticks) and the host re-saves the open table -
  a setting reaches a table through `saveTable`, so a write with no re-save would only have changed
  the NEXT table, and the revision bump is what tells every open panel to re-read it.
- **检查更新** (`lib/update.js`, `设置 → 德州扑克 → 关于与更新`). The settings page shows the installed
  version (read from the package's own manifest, never typed in) and a button that asks GitHub for
  the repository's newest release - falling back to the newest tag, because plenty of repositories
  only tag - then compares it with the installed version and answers with plain lines: up to date, a
  newer version plus the upgrade command, or one sentence explaining offline / rate limiting / a
  repository that does not exist. The repository is a setting, so a fork can check itself; answers are
  cached for ten minutes and the button forces a refresh. Every failure is a sentence, never a throw.
- **A GTO-style coach** (`lib/gto.js`, `设置 → 德州扑克 → 教练风格`). The same spot, reasoned in ranges,
  indifference points and EV instead of rules of thumb: required equity, minimum defence frequency,
  the value:bluff ratio each sizing implies, the EV of every legal action (arithmetic included), an
  approximate mixed frequency over LINES rather than over four sizes of one line, and the hand's role
  in the plan (value / semi-bluff / bluff-catcher / marginal / air). The fold-equity input is the
  table's measured **postflop** fold-to-bet rate raised to the number of live opponents: two players
  folding 60% each takes the pot down 36% of the time, not 60%, and using the per-player number made
  every bluff look free. It is one spot's arithmetic, not a solver - no game tree, no per-street range
  iteration - and preflop stays with the positional range plan.

- **A real settings page** (`settings.section`, `id: poker`) with four groups: general on/off
  switches (plugin, coach layer, advice badge, hand log), the default table (seats, styles, stacks,
  blinds - an explicit argument still wins), panel behaviour (replay speed, open on load), and the AI
  opponents. The host route returns the field DESCRIPTORS along with the values, so the page draws
  whatever `lib/settings.js` declares: adding a setting is one edit there and nothing in the client.
- **测试连通**: a connection test that probes the configured endpoint with the values on screen -
  including an unsaved key - and reports the round-trip time plus what the model answered, or the
  real error (status and body, or a timeout). It never writes anything.
- **AI opponents over any OpenAI-compatible endpoint.** The engine already knew how to pause for an
  external decision (the model-brain path), so an AI turn is: pause, ask, `submitBotDecision`,
  advance - with the page polling while the seat thinks. Every failure (timeout, offline, a non-200,
  an illegal action) falls back to the heuristic policy for that seat, so a bad endpoint costs
  latency and nothing else. The key lives in the host user-settings document and is never returned.
- **The opponents' rates now move with the table.** Each seat keeps a per-table tally of what the
  others actually do (hands, voluntary entries, raises, bets faced, bets folded to), and nudges its
  own tightness/aggression/bluff within a bounded range: a loose table gets tightened against, a
  table that folds to pressure gets bluffed more, an aggressive table gets respected. The player's
  own tendencies are part of that read.
- CI (`.github/workflows/test.yml`) runs the whole suite on every push.
- A **packaging contract suite** (`test/pack.mjs`, `npm test`): it asserts against this repository
  what a plugin registry checks before listing a package - the `dsh.bundle` patch installs, both
  halves are exported, the client half only requires the platform baseline, the one-line description
  is one line and every claim in it appears in the README, the license/changelog/CI are present, and
  no machine paths or scratch files ship.
- **Cross-session sync**: the table belongs to the host, not to a conversation, and a session with no
  poker history adopts it (`.github`-independent, works on an older host too).
- A **rebuy card** when the hero is out of chips, and an **end-of-game card** with a same-config
  rematch instead of a dead end.
- The panel lives in the **sidebar footer**, so switching conversations no longer remounts it.

### Changed

- **Bot preflop ranges, retuned against measurement.** Playtesting showed two problems - bots folded
  too much preflop and still called off all-ins - and the old numbers caused both: the continuing range was 1.5x the *opening*
  range (so 76% of bots continued against a big raise and 62% against a stack-committing one), while
  the opening table was tight enough that 23% of hands were walked to the big blind. Now the width
  comes from the **price and position**: the big blind, closing the action, defends wide; middle
  positions do not; a stack-committing raise is continued only with the top 10% (median top 4%).
  Measured over 3000 six-handed hands: walks 23% → **10%**, flops 59% → **57%**, and the hands that
  continue against a shove are a genuine premium range instead of "anything whose price was right".
- A **shove or a large bet needs real equity**: a made-hand score compared to pot odds was calling off
  with ace-high, and a `commit` carve-out (strength ≥ 0.5 at a small SPR) was bypassing that rule for
  every top pair once the pot had grown.
- The seat tile no longer covers the centre column: the middle reserves room for the tallest tile,
  and 需跟 shows what the **hero** owes (and disappears when nothing is owed).
- Sizing helper: preflop sizes are quoted in **big blinds** (2.5/3/4/6BB) instead of four identical
  pot fractions.

### Fixed

- **The GTO coach recommended raises that could not happen.** Reported from a real hand: two pair
  facing a 206BB shove, where it advised re-raising all-in for "EV +22187". Three separate modelling
  errors: it used the table's fold-to-a-bet rate for a RAISE over a shove (a player who is all-in
  cannot fold, so that fold equity is exactly zero); it valued the "called" branch at the same equity
  as the current range, when a caller's range is stronger and the tighter the more of the stack the
  bet commits; and it built the pot as `pot + 2 x risk`, inventing 100 chips on every raise where the
  opponent only owed 150 of a 250 raise. Against an all-in opponent the EV table now holds only call
  and fold, and says why. Fold equity for a raise is also halved - but only over a real raise, since
  a big blind's 1BB is a blind, not a bet.
- **The engine no longer offers a raise nobody can call.** With every live opponent all-in, the extra
  chips come straight back, so `canRaise` / `canBet` / `canAllIn` are off and the panel stops showing
  a "全下 20,850" that differs from the 18,200 call by 250 chips that return anyway.
- **The GTO coach's advice was bad, not just its wording.** An audit of 60 preflop spots found it
  recommending three-way "mixes" that gave 30% of the range to lines losing 40+ chips, and folding
  hands the positional range opens. Three rules now hold the recommendation together: a line clearly
  behind a free fold is never recommended; among EV-equivalent lines the range plan picks (a
  one-street EV cannot see the postflop value of position, so it must not overrule the range); and a
  tie-break is reported as one plan rather than as a mix that contradicts its own headline. The
  equivalence band also shrank from half a big blind to a fifth, because at the wider setting a hand
  27 chips better than folding still carried a 17% folding share.
- **The GTO coach said nothing new preflop.** It was built as a postflop layer ("a one-street EV model
  has nothing to say with no board yet"), which is wrong exactly where it matters most: most decisions
  ARE preflop, so switching the style looked like it did nothing at all. Preflop now has its own half
  of the layer - the hand's position in the starting range, the equity a call needs, and the EV of
  folding / calling / opening 2.5-4BB / 3-betting / shoving, sized in big blinds because that is how
  the street is spoken about - and it says plainly that MDF is not a preflop concept instead of
  borrowing one. Fold equity preflop comes from the preflop slice of the tally (all streets minus
  postflop), not from the whole number.
- **A toggle could make the sidebar entry vanish.** Two components returned early ABOVE their
  remaining hooks (the sidebar entry when `pluginEnabled` is off, the coach window while the teaching
  layer is off). React counts hooks per render, so flipping such a switch throws - and the symptom is
  not an error message but a surface that disappears, which is exactly what "侧栏入口怎么没了" turned
  out to be. Every hook now runs unconditionally, and the client harness enforces the rule: a
  component that changes its hook count fails the suite by name instead of quietly taking a surface
  down with it.
- **The settings dropdown was unreadable in dark mode.** A native `<select>` paints its popup from
  the element's own colours, and every settings control shared one translucent fill - so the option
  list came out a washed-out panel with low-contrast text. The select and its options now carry an
  opaque layer background (`bg-layer-2`, the same token the settings dialog uses) with the primary
  label colour: measured against the real dark tokens that is 13.34:1 (#f9fafb on #2c2c2e).
- **The coach's advice badge wrapped.** A long recommendation ("弃牌：QTo（不同花）在关池位 CO 太弱…")
  wrapped the "教练建议" label itself onto a second line and pushed the action buttons down. The badge
  is one line now: the label never shrinks, the sentence takes the ellipsis, and the full text is the
  tooltip.
- **`playersBehind` did not measure position.** It walks the seat ring, and a full lap visits every
  other seat, so every player counted every live opponent as "behind" them - the big blind, which
  closes the action, was treated as having five players still to act and defended as tightly as under
  the gun. It now counts only players who have **not acted yet**, which is what "behind" means.
- **A hot reload could silently not happen.** The reloader stages a copy of `lib/*.js` under the OS
  temp directory, but the copies did not carry a module manifest - and module type is resolved from
  the file's own directory upwards, so in a temp tree with no `"type": "module"` above it Node read
  the copies as CommonJS, the `import` lines were a syntax error, and the loader kept the previous
  implementation. Each staged revision now writes its own `package.json`, and `test/hot.mjs` asserts
  it. **This one needs a host restart** (it lives in the entry file).

## [0.1.0]

The first release: a complete Texas Hold'em table inside DeepSeek Harness.

### Added

- **Engine** (`lib/engine.js`): deterministic no-limit hold'em — blinds, position
  order, min-raise rules, short all-in raises that do not reopen the betting,
  uncalled-bet refunds, side pots, showdowns, split pots, and chip-conservation
  invariants over thousands of simulated hands.
- **Opponents** (`lib/bots.js`): six personalities (rock / tag / lag / station /
  maniac / pro) whose bets come from board texture, position, pot odds and reads.
- **Tools** for the model: `poker_new_table`, `poker_action`, `poker_next_hand`,
  `poker_table`, `poker_opponent`, `poker_equity` — with a coach brief attached to
  every payload so the model explains a decision with the same numbers the player
  can see.
- **Coach** (`lib/coach.js`, optional and remembered): range estimation, Monte
  Carlo equity with an error bar, pot odds / MDF / SPR, a "why" for the suggested
  action, a hand review, and a concept card per spot.
- **Browser table** (`lib/client.js`): the felt with seats on the rail, chip
  stacks, bet chips, dealer button, position and action tags, a replay that plays
  the opponents' moves one beat at a time, a hand log, the sizing helper, the
  coach window, and a draggable/pinnable panel.
- **No-chat actions**: every button (`/poker/action`, `/next`, `/start`, `/rebuy`)
  plays straight against the host, so clicking never posts a message and never
  spends a model turn. Only an unreachable route falls back to the chat.
- **One shared table**: the table belongs to the host, not to a conversation, so
  switching sessions — or reloading the page — shows the same game.
- **Rebuy**: when the hero's stack hits zero, the action row becomes a rebuy card
  with whole-big-blind top-ups and a custom amount.
- **Hot reload** (`lib/index.js`): editing `impl.js` and its imports takes effect
  on the next tool call or click, without a restart and without folding the hand.
- **Tests** (`npm test`, no dependencies): 838 assertions across the engine, the
  host contract, the client bundle, the coach and the hot-reload loader.
