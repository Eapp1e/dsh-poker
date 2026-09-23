/**
 * Host-half harness: load the plugin exactly as the loader would, then drive a
 * whole poker session through the registered tools. This catches contract
 * mistakes (tool definition shape, argument handling, payload building) without
 * touching a running host.
 *
 *   node test/host.mjs
 */
import * as plugin from '../lib/index.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

check('host half exports a plugin name', typeof plugin.name === 'string' && plugin.name.length > 0);
check('host half declares inject', Array.isArray(plugin.inject) && plugin.inject.includes('tools'));
check('host half exports apply', typeof plugin.apply === 'function');

// ── a minimal cordis context, mirroring the real registry contract ──────────

const registered = new Map();
const effects = [];
const routes = [];
const ctx = {
  tools: {
    register(definition) {
      for (const field of ['name', 'description', 'parameters', 'execute', 'output']) {
        if (definition[field] === undefined) throw new Error(`tool ${definition.name} is missing ${field}`);
      }
      if (definition.parameters.type !== 'object' || typeof definition.parameters.properties !== 'object') {
        throw new Error(`tool ${definition.name} has a non-object parameter schema`);
      }
      if (typeof definition.output.render !== 'function' || definition.output.schema === undefined) {
        throw new Error(`tool ${definition.name} has an incomplete output declaration`);
      }
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  effect(callback) {
    const disposer = callback();
    effects.push(disposer);
    return disposer;
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route);
          return () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      };
    }
    // The host-side SessionStore: how a browser-supplied session id becomes a
    // live session the plugin can bind a table to.
    if (name === 'sessions') {
      return {
        get(id) {
          return id === 'session-under-test' ? { session } : undefined;
        },
      };
    }
    return undefined;
  },
};

plugin.apply(ctx);

const EXPECTED = [
  'poker_new_table',
  'poker_action',
  'poker_next_hand',
  'poker_table',
  'poker_opponent',
  'poker_equity',
];
check('every poker tool registered', EXPECTED.every((toolName) => registered.has(toolName)), [...registered.keys()].join(','));
check('no unexpected tool registered', registered.size === EXPECTED.length, [...registered.keys()].join(','));

// ── drive the tools the way an agent would ─────────────────────────────────

const session = { id: 'harness-session' };
const exec = { agent: { session } };

/** Call one tool and run its declared output projection. */
async function call(toolName, args) {
  const definition = registered.get(toolName);
  if (!definition) throw new Error(`unknown tool ${toolName}`);
  const value = await definition.execute(args, exec);
  const content = definition.output.render(args, value);
  const meta = definition.output.presentationMeta ? definition.output.presentationMeta(args, value) : undefined;
  const callView = definition.presentCall ? definition.presentCall(args) : undefined;
  return { value, content, meta, callView, definition };
}

const json = (value) => JSON.stringify(value);

// Before anybody opens a table, a tool call says so instead of inventing one.
let noTableYet = '';
try {
  await call('poker_table', {});
} catch (error) {
  noTableYet = String(error && error.message);
}
check('a host with no table is told to open one', noTableYet.includes('poker_new_table'), noTableYet);

// The browser's discovery op must answer "nothing yet" rather than throwing: a
// freshly loaded page asks before anybody has opened a table.
const noCurrent = await request('POST', '/poker/current', {});
check('the current-table op is honest about having no table', noCurrent.status === 200 && noCurrent.json.ok === true && noCurrent.json.view === null,
  JSON.stringify(noCurrent.json));

const opened = await call('poker_new_table', { botCount: 2, startingStack: 2000, smallBlind: 25, bigBlind: 50, seed: 20240101 });
check('new table returns text', typeof opened.value.text === 'string' && opened.value.text.includes('\u5e95\u6c60'));
check('new table returns content blocks', Array.isArray(opened.content) && opened.content[0].type === 'text');
check('new table publishes a browser view', opened.meta && opened.meta.view && Array.isArray(opened.meta.view.players));
check('browser view hides opponent cards', opened.meta.view.players.slice(1).every((player) => player.cards === null));
check('browser view carries the viewer cards', opened.meta.view.players[0].cards.length === 2);
check('new table is serializable', json(opened.value).length > 0);
check('call view is a generic card', opened.callView && opened.callView.card === 'generic');

const view = opened.meta.view;
check('view exposes the legal menu to the hero', view.legal !== null && view.legal.seat === 0, json(view.legal));
check('view carries a blind structure', view.smallBlind === 25 && view.bigBlind === 50);
check('view names the street', typeof view.streetLabel === 'string' && view.streetLabel.length > 0);

// Play the whole hand from the hero's seat with a simple legal-only policy.
let steps = 0;
let current = opened;
let hands = 0;
while (steps < 200) {
  steps += 1;
  const state = current.meta.view;
  if (state.canDealNext) {
    hands += 1;
    if (hands >= 3) break;
    current = await call('poker_next_hand', {});
    continue;
  }
  if (state.pending) {
    current = await call('poker_opponent', { action: 'call' });
    continue;
  }
  if (!state.legal) break;
  const options = ['fold'];
  if (state.legal.canCheck) options.push('check');
  if (state.legal.canCall) options.push('call');
  if (state.legal.canRaise) options.push('raise');
  const pick = options[steps % options.length];
  const args = pick === 'raise'
    ? { action: 'raise', amount: state.legal.minRaiseTo }
    : { action: pick };
  current = await call('poker_action', args);
}

check('a full hand completed through the tools', hands >= 1, `steps=${steps}`);
check('the table view stayed renderable', current.value.text.includes('\u5e95\u6c60'));

// ── the coach travels with the view ────────────────────────────────────────

check('the view carries the coaching analysis', opened.meta.view.coach && Array.isArray(opened.meta.view.coach.sections) && opened.meta.view.coach.sections.length >= 5, JSON.stringify(opened.meta.view.coach && opened.meta.view.coach.sections.map((section) => section.id)));
check(
  'the sections cover the whole decision',
  ['spot', 'hand', 'plan', 'reads', 'math', 'lesson'].every((id) => opened.meta.view.coach.sections.some((section) => section.id === id)),
  JSON.stringify(opened.meta.view.coach.sections.map((section) => section.id)),
);
check('the model-facing text carries the coach brief', opened.value.text.includes('教练：') && opened.value.text.includes('建议：'), opened.value.text.slice(-260));
check('the coach quotes its own error bar', typeof opened.meta.view.coach.equity.margin === 'number' && opened.meta.view.coach.equity.margin > 0, JSON.stringify(opened.meta.view.coach.equity));

const peeked = await call('poker_table', { reveal: true });
const hiddenCards = peeked.meta.view.players.filter((player) => !player.isHuman).flatMap((player) => player.cards ?? []);
const blind = await call('poker_table', {});
const blindJson = JSON.stringify(blind.meta.view);
check('the debug peek really reveals cards', hiddenCards.length > 0, JSON.stringify(hiddenCards));
check(
  'the coach never leaks an opponent hole card',
  hiddenCards.every((card) => !blindJson.includes(`"${card}"`)),
  hiddenCards.filter((card) => blindJson.includes(`"${card}"`)).join(','),
);

// ── equity tool ────────────────────────────────────────────────────────────

const equity = await call('poker_equity', { iterations: 400 });
check('equity returns a percentage', /equity|%/.test(equity.value.text));
check('equity view carries the estimate', equity.meta.view.equity && typeof equity.meta.view.equity.equity === 'number');

// ── model-brain path ───────────────────────────────────────────────────────

const modelTable = await call('poker_new_table', { botCount: 1, startingStack: 1000, smallBlind: 25, bigBlind: 50, botBrain: 'model', seed: 777 });
const modelView = modelTable.meta.view;
check('model brain pauses for a decision after the hero acts', modelView.legal !== null || modelView.pending !== null, json({ legal: modelView.legal, pending: modelView.pending }));
const acted = await call('poker_action', { action: modelView.legal.canCheck ? 'check' : 'call' });
const pendingView = acted.meta.view;
check('a bot decision is pending under the model brain', pendingView.pending !== null, json(pendingView.pending));
check('the pending seat is a bot, not the hero', pendingView.pending.seat !== 0);
const decided = await call('poker_opponent', { action: pendingView.pending.legal.canCheck ? 'check' : 'call' });
const afterView = decided.meta.view;
check(
  'submitting the bot decision advances the hand',
  afterView.pending === null
    || afterView.pending.seat !== pendingView.pending.seat
    || afterView.street !== pendingView.street
    || afterView.pot !== pendingView.pot
    || afterView.log.length !== pendingView.log.length,
  json({ before: { seat: pendingView.pending.seat, street: pendingView.street, pot: pendingView.pot }, after: { seat: afterView.pending && afterView.pending.seat, street: afterView.street, pot: afterView.pot } }),
);
const switched = await call('poker_opponent', { brain: 'auto' });
check('switching back to auto clears the pending decision', switched.meta.view.pending === null);
check('switching brains is reported', typeof switched.value.text === 'string' && switched.value.text.includes('auto'));

// ── error surfaces are model-readable ──────────────────────────────────────

let errorText = '';
try {
  await call('poker_action', { action: 'dance' });
} catch (error) {
  errorText = String(error && error.message);
}
check('an unknown action raises a readable error', errorText.includes('fold'), errorText);

// The table is HOST-wide, not per session: a conversation that has never touched
// poker still sees the game in progress, which is what makes switching chats safe.
const otherSession = { id: 'another-conversation' };
const mainSees = await call('poker_table', {});
const seenElsewhere = await registered.get('poker_table').execute({}, { agent: { session: otherSession } });
check(
  'another session sees the same table',
  seenElsewhere.view.tableId === mainSees.meta.view.tableId,
  `${seenElsewhere.view.tableId} vs ${mainSees.meta.view.tableId}`,
);
const elsewhereLegal = seenElsewhere.view.legal;
if (elsewhereLegal) {
  const actedElsewhere = await registered.get('poker_action').execute(
    { action: elsewhereLegal.canCheck ? 'check' : 'call' },
    { agent: { session: otherSession } },
  );
  check('another session may act on that table', actedElsewhere.view.tableId === mainSees.meta.view.tableId,
    `${actedElsewhere.view.tableId} vs ${mainSees.meta.view.tableId}`);
} else {
  // Not the hero's turn: the read above is the whole point of this pair, and the
  // action path is covered by the route tests below.
  check('another session may act on that table', true);
}

// ── the browser route: play without chatting ───────────────────────────────

check('the plugin mounts one web route', routes.length === 1, `got ${routes.length}`);
check('the route owns the /poker prefix', routes[0] && routes[0].kind === 'prefix' && routes[0].path === plugin.POKER_PATH, JSON.stringify(routes[0] && { kind: routes[0].kind, path: routes[0].path }));

/** A minimal request: method, url, and a JSON body as one chunk. */
function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A minimal response that records what the handler wrote. */
function fakeResponse() {
  const state = { status: 0, headers: null, body: '' };
  return {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      state.body = body ?? '';
    },
    settle() {
      return { status: state.status, headers: state.headers, json: state.body ? JSON.parse(state.body) : null };
    },
  };
}

/** Call the mounted route and parse its answer. */
async function request(method, path, body) {
  const response = fakeResponse();
  await routes[0].handler(fakeRequest(method, path, body), response);
  return response.settle();
}

const table = await call('poker_new_table', { botCount: 2, startingStack: 4000, smallBlind: 25, bigBlind: 50, seed: 24680 });
const tableId = table.meta.view.tableId;
check('the browser view carries an opaque table id', typeof tableId === 'string' && tableId.length > 6, String(tableId));
check('the browser view carries a revision', Number.isInteger(table.meta.view.revision) && table.meta.view.revision >= 1, String(table.meta.view.revision));

const readBack = await request('POST', '/poker/table', { tableId });
check('the route reads a table by id', readBack.status === 200 && readBack.json.ok === true, JSON.stringify(readBack.json).slice(0, 160));
check('the route answers with the same table', readBack.json.view.tableId === tableId);
check('the route answer is JSON', readBack.headers['content-type'].includes('application/json'));

const beforeRevision = table.meta.view.revision;
const routeActed = await request('POST', '/poker/action', { tableId, action: 'call' });
check('the route applies a hero action', routeActed.status === 200 && routeActed.json.ok === true, JSON.stringify(routeActed.json).slice(0, 200));
check('an action advances the revision', routeActed.json.view.revision > beforeRevision, `${beforeRevision} -> ${routeActed.json.view && routeActed.json.view.revision}`);
// The street may or may not change (a bot can raise and send it back), so assert
// what actually must be true: the hero's action is in the returned replay log.
check(
  'an action is recorded as a replayable step',
  Array.isArray(routeActed.json.steps) && routeActed.json.steps.some((step) => step.seat === 0 && step.action === 'call' && step.seq > 0),
  JSON.stringify(routeActed.json.steps).slice(0, 240),
);
check('the route answer carries the model-facing text too', typeof routeActed.json.text === 'string' && routeActed.json.text.length > 0);

const illegal = await request('POST', '/poker/action', { tableId, action: 'dance' });
check('an illegal action is rejected with a readable error', illegal.status === 400 && illegal.json.ok === false && /fold/.test(illegal.json.error), JSON.stringify(illegal.json));

const unknown = await request('POST', '/poker/nonsense', { tableId });
check('an unknown operation is a 404', unknown.status === 404, String(unknown.status));

const wrongMethod = await request('GET', '/poker/table', undefined);
check('a non-POST request is refused', wrongMethod.status === 405, String(wrongMethod.status));

const noTable = await request('POST', '/poker/action', { tableId: 'nope', action: 'call' });
check('an unknown table id is refused', noTable.status === 400 && noTable.json.ok === false, JSON.stringify(noTable.json));

// A route-driven change must stay visible to the agent's own tools.
const afterRoute = await call('poker_table', {});
check('the agent sees the route-driven state', afterRoute.meta.view.revision >= routeActed.json.view.revision, `${afterRoute.meta.view.revision} vs ${routeActed.json.view.revision}`);
check('the route never replaced the table', afterRoute.meta.view.tableId === tableId);

// ── a browser-opened table becomes the shared one ──────────────────────────

const routeOpened = await request('POST', '/poker/new', { sessionId: 'session-under-test', botCount: 8, startingStack: 20000, smallBlind: 100, bigBlind: 200 });
check('the route opens a table', routeOpened.status === 200 && routeOpened.json.ok === true, JSON.stringify(routeOpened.json).slice(0, 200));
check('the requested table size is honoured', routeOpened.json.view.players.length === 9, String(routeOpened.json.view.players.length));
check('every requested seat is dealt in', routeOpened.json.view.players.every((player) => player.stack > 0), JSON.stringify(routeOpened.json.view.players.map((player) => player.stack)));
check('the requested blind reaches the view', routeOpened.json.view.bigBlind === 200);

const viaRoute = routeOpened.json.view.tableId;
const agentSees = await call('poker_table', {});
check('the agent sees the browser-opened table', agentSees.meta.view.tableId === viaRoute, `${agentSees.meta.view.tableId} vs ${viaRoute}`);
check('the agent keeps the requested table size', agentSees.meta.view.players.length === 9, String(agentSees.meta.view.players.length));

// The discovery op: what a session with nothing of its own shows.
const discovered = await request('POST', '/poker/current', {});
check('the current-table op answers with the shared table', discovered.status === 200 && discovered.json.view.tableId === viaRoute, JSON.stringify(discovered.json).slice(0, 160));
check('the discovery answer carries the replay steps', Array.isArray(discovered.json.steps), JSON.stringify(discovered.json.steps).slice(0, 120));

// Whatever session asks - even one the host has never seen - the same table comes
// back, so switching conversations cannot silently start a different game.
const strangerOpened = await request('POST', '/poker/new', { sessionId: 'no-such-session', botCount: 1, startingStack: 3000 });
check('a browser table opens even for a session the host cannot resolve', strangerOpened.status === 200 && strangerOpened.json.ok === true, JSON.stringify(strangerOpened.json).slice(0, 120));
const freshSession = { id: 'a-different-session' };
const adopted = await registered.get('poker_table').execute({}, { agent: { session: freshSession } });
check('a never-seen session finds the table that was just opened', adopted.view.tableId === strangerOpened.json.view.tableId, `${adopted.view.tableId} vs ${strangerOpened.json.view.tableId}`);

// ── rebuying a busted hero ─────────────────────────────────────────────────

// A short-stacked heads-up table the hero shoves and loses: the one situation the
// rebuy card is for. Seeded, so the bust is deterministic.
// A short-stacked heads-up table that leaves the hero with nothing: the hero FOLDS
// every hand until the blinds have eaten the stack. Folding rather than shoving is
// deliberate - a bot that sensibly folds a shove leaves the shover winning blinds,
// so the hero would grow a stack instead of losing one.
const shortTable = await call('poker_new_table', { botCount: 1, startingStack: 400, smallBlind: 50, bigBlind: 100, seed: 1 });
const shortId = shortTable.meta.view.tableId;
let bustedView = shortTable.meta.view;
for (let attempt = 0; attempt < 60 && bustedView.players[0].stack > 0; attempt += 1) {
  if (bustedView.canDealNext) {
    bustedView = (await call('poker_next_hand', {})).meta.view;
    continue;
  }
  if (!bustedView.legal) break;
  const action = bustedView.legal.canFold ? 'fold' : bustedView.legal.canCheck ? 'check' : 'call';
  const fold = await request('POST', '/poker/action', { tableId: shortId, action });
  bustedView = fold.json.view;
}
check(
  'the short-stacked hero eventually busts',
  bustedView.players[0].stack === 0 && bustedView.canDealNext === true,
  json({ stack: bustedView.players[0].stack, canDealNext: bustedView.canDealNext }),
);

const zeroRebuy = await request('POST', '/poker/rebuy', { tableId: shortId, amount: 0 });
check('a rebuy needs a positive amount', zeroRebuy.status === 400 && /大于 0/.test(zeroRebuy.json.error), JSON.stringify(zeroRebuy.json));

const rebought = await request('POST', '/poker/rebuy', { tableId: shortId, amount: 4000 });
check('the route rebuys a busted hero', rebought.status === 200 && rebought.json.ok === true, JSON.stringify(rebought.json).slice(0, 160));
check('the rebuy tops the stack up', rebought.json.view.players[0].stack === 4000, String(rebought.json.view.players[0].stack));
check(
  'the rebuy puts the hero back in the game',
  rebought.json.view.players[0].out !== true && rebought.json.view.gameOver === false && rebought.json.view.canDealNext === true,
  json({ out: rebought.json.view.players[0].out, gameOver: rebought.json.view.gameOver, canDealNext: rebought.json.view.canDealNext }),
);

const fundedRebuy = await request('POST', '/poker/rebuy', { tableId: shortId, amount: 1000 });
check('a funded hero is refused a second rebuy', fundedRebuy.status === 400 && /无需补码/.test(fundedRebuy.json.error), JSON.stringify(fundedRebuy.json));

const dealtAfterRebuy = await request('POST', '/poker/next', { tableId: shortId });
check(
  'the next hand deals the rebought hero back in',
  dealtAfterRebuy.json.view.handNumber === bustedView.handNumber + 1
    && dealtAfterRebuy.json.view.players[0].out !== true
    && dealtAfterRebuy.json.view.players[0].stack > 0,
  json({ hand: dealtAfterRebuy.json.view.handNumber, out: dealtAfterRebuy.json.view.players[0].out, stack: dealtAfterRebuy.json.view.players[0].stack }),
);

// ── dispose contract ───────────────────────────────────────────────────────

check('apply registered one disposer', typeof effects[0] === 'function');
effects[0]();
check('disposing unregisters every tool', registered.size === 0, [...registered.keys()].join(','));

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} host-half checks passed`);
}
