# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **AI opponents over any OpenAI-compatible endpoint.** The plugin's own page in the
  settings dialog (`settings.section`, `id: poker`) configures how many seats the AI plays plus
  base URL, key, model, temperature, timeout and JSON mode; the values live in the host
  user-settings document (`GET/POST /poker/settings`, and the key is never returned to the page).
  The engine already knew how to pause for an external decision (the model-brain path), so an AI
  turn is: pause, ask, `submitBotDecision`, advance - with the page polling while the seat thinks.
  Every failure (timeout, offline, a non-200, an illegal action) falls back to the heuristic policy
  for that seat, so a bad endpoint costs latency and nothing else.
- **The opponents' rates now move with the table.** Each seat keeps a per-table tally of what the
  others actually do (hands, voluntary entries, raises, bets faced, bets folded to), and nudges its
  own tightness/aggression/bluff within a bounded range: a loose table gets tightened against, a
  table that folds to pressure gets bluffed more, an aggressive table gets respected. The player's
  own tendencies are part of that read.
- A **submission guide** (`SUBMISSION.md`) plus CI (`.github/workflows/test.yml`) for listing the
  plugin in the community registry: what the entry looks like, what a reviewer checks, and the
  pre-flight commands.
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

- **Bot preflop ranges, retuned against measurement.** The complaint was two-sided - "翻前弃牌率也太高"
  and "allin 还喜欢跟" - and the old numbers caused both: the continuing range was 1.5x the *opening*
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
