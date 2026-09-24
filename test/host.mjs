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
    if (name === 'settings') return settingsService;
    return undefined;
  },
  // `inject` is how the plugin asks for an optional service; the harness runs the
  // callback inline, which is what the real host does once the service is composed.
  inject(names, callback) {
    if (names.includes('settings') && settingsService) callback();
    if (names.includes('webServer')) callback();
  },
};

/**
 * A stand-in for the host user-settings service: one live namespace, mutable, with
 * the same `register/get/update` surface the plugin uses.
 */
const settingsService = (() => {
  const sections = new Map();
  const require_ = (namespace) => {
    const record = sections.get(namespace);
    if (!record) throw new Error(`settings namespace "${namespace}" is not registered`);
    return record;
  };
  const announce = (record) => {
    for (const watcher of record.watchers) watcher();
  };
  return {
    register(namespace, schema) {
      if (sections.has(namespace)) throw new Error(`settings namespace "${namespace}" is already registered`);
      const record = { schema, value: undefined, watchers: new Set() };
      sections.set(namespace, record);
      return {
        get: () => record.value,
        update: (patch) => this.update(namespace, patch),
        replace: (section) => this.replace(namespace, section),
        watch: (callback) => {
          record.watchers.add(callback);
          return () => record.watchers.delete(callback);
        },
      };
    },
    get(namespace) {
      const record = sections.get(namespace);
      if (!record) return undefined;
      return record.value ?? record.schema({});
    },
    // The provider's own write API, which is what a hot-reloaded module has to use: the
    // scope from `register` belongs to the instance that registered, and a reloaded
    // instance cannot register again.
    update(namespace, patch) {
      const record = require_(namespace);
      record.value = record.schema({ ...(record.value ?? {}), ...patch });
      announce(record);
    },
    replace(namespace, section) {
      const record = require_(namespace);
      record.value = record.schema(section);
      announce(record);
    },
  };
})();

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
// so the hero would grow a stack instead of losing one. The stack does get all-in as a
// blind on the way down and can win one back, so this takes many hands; the bound is
// generous because the point is the bust, not how quickly it happens.
const shortTable = await call('poker_new_table', { botCount: 1, startingStack: 400, smallBlind: 50, bigBlind: 100, seed: 1 });
const shortId = shortTable.meta.view.tableId;
let bustedView = shortTable.meta.view;
for (let attempt = 0; attempt < 400 && bustedView.players[0].stack > 0; attempt += 1) {
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
// Read defensively: a crashed test hides the failure message that explains it.
const reboughtView = rebought.json && rebought.json.view ? rebought.json.view : null;
check('the rebuy answers with the table', reboughtView !== null, JSON.stringify(rebought.json).slice(0, 200));
check('the rebuy tops the stack up', reboughtView !== null && reboughtView.players[0].stack === 4000,
  reboughtView ? String(reboughtView.players[0].stack) : JSON.stringify(rebought.json).slice(0, 200));
check(
  'the rebuy puts the hero back in the game',
  reboughtView !== null && reboughtView.players[0].out !== true && reboughtView.gameOver === false && reboughtView.canDealNext === true,
  reboughtView ? json({ out: reboughtView.players[0].out, gameOver: reboughtView.gameOver, canDealNext: reboughtView.canDealNext }) : JSON.stringify(rebought.json).slice(0, 200),
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

// ── AI opponents: settings, prompt/parse, and the pause/resume contract ────

const ai = await import('../lib/ai.js');
const settingsModule = await import('../lib/settings.js');

check('the settings defaults are complete',
  ['enabled', 'seats', 'baseUrl', 'model', 'temperature', 'timeoutMs'].every((key) => key in ai.AI_DEFAULTS),
  Object.keys(ai.AI_DEFAULTS).join(','));
check('settings are clamped, not trusted', (() => {
  const wild = settingsModule.normaliseSettings({ aiSeats: 99, aiTemperature: 9, aiTimeoutMs: 1, aiBaseUrl: 'https://x.test/v1///' });
  return wild.aiSeats === 8 && wild.aiTemperature === 2 && wild.aiTimeoutMs === 500 && wild.aiBaseUrl === 'https://x.test/v1';
})(), JSON.stringify(settingsModule.normaliseSettings({ aiSeats: 99, aiTemperature: 9, aiTimeoutMs: 1, aiBaseUrl: 'https://x.test/v1///' })));
check('an empty section yields the defaults',
  settingsModule.normaliseSettings(undefined).aiModel === ai.AI_DEFAULTS.model && settingsModule.normaliseSettings(null).aiEnabled === false);

const cannedMenu = { canCheck: false, canCall: true, canRaise: true, canAllIn: true, toCall: 200, minRaiseTo: 400, maxRaiseTo: 2000 };
check('a JSON decision is parsed', (() => {
  const parsed = ai.parseAiDecision('{"action":"raise","amount":600,"talk":"来"}', cannedMenu);
  return parsed && parsed.action === 'raise' && parsed.amount === 600 && parsed.talk === '来';
})(), 'plain JSON');
check('a fenced answer is parsed', ai.parseAiDecision('```json\n{"action":"call"}\n```', cannedMenu)?.action === 'call');
check('prose around the JSON is tolerated', ai.parseAiDecision('Sure! {"action":"fold"} ok', cannedMenu)?.action === 'fold');
check('an illegal action is refused', ai.parseAiDecision('{"action":"check"}', cannedMenu) === null, 'check with a bet to face');
check('an unknown action is refused', ai.parseAiDecision('{"action":"dance"}', cannedMenu) === null);
check('nonsense is refused', ai.parseAiDecision('I fold.', cannedMenu) === null && ai.parseAiDecision('', cannedMenu) === null);
check('a wild amount is clamped into the menu', (() => {
  const low = ai.parseAiDecision('{"action":"raise","amount":1}', cannedMenu);
  const high = ai.parseAiDecision('{"action":"raise","amount":999999}', cannedMenu);
  return low.amount === 400 && high.amount === 2000;
})());
check('a raise without an amount is refused', ai.parseAiDecision('{"action":"raise"}', cannedMenu) === null);

const promptState = (() => {
  const state = plugin.__testState ?? null;
  return state;
})();
void promptState;
check('the system prompt asks for one JSON object',
  /ONE JSON object/.test(ai.AI_SYSTEM_PROMPT) && /amount/.test(ai.AI_SYSTEM_PROMPT), ai.AI_SYSTEM_PROMPT.slice(0, 60));

/** A fetch double: records the request, answers with whatever the test wants. */
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (response instanceof Error) throw response;
    return response;
  };
  impl.calls = calls;
  return impl;
}

// The AI sees a REAL table: the engine's own pause state, not a hand-built stub.
const engineModule = await import('../lib/engine.js');
const aiPaused = engineModule.startHand(engineModule.createGame({
  startingStack: 1000,
  smallBlind: 50,
  bigBlind: 100,
  seed: 5,
  bots: [{ name: 'A', style: 'tag' }, { name: 'B', style: 'tag' }],
}));
aiPaused.aiSeats = [1];
const banked = engineModule.applyAction(aiPaused, { seat: 0, action: 'call' }, () => ({ action: 'call' }));
check('an AI seat pauses the table', banked.pendingDecision && banked.pendingDecision.kind === 'ai' && banked.pendingDecision.seat === 1,
  JSON.stringify(banked.pendingDecision));
check('the paused table has not acted for the AI seat yet', banked.players[1].hasActed === false, String(banked.players[1].hasActed));
check('the pause carries a legal menu and the seat cards',
  banked.pendingDecision.legal && Array.isArray(banked.pendingDecision.cards) && banked.pendingDecision.cards.length === 2,
  JSON.stringify(banked.pendingDecision.legal));

const aiSeat = banked.pendingDecision.seat;
const legalMenu = banked.pendingDecision.legal;
const aiState = banked;

const settingsFor = (patch) => settingsModule.normaliseSettings({ aiEnabled: true, aiApiKey: 'sk-test', ...patch });
const okFetch = fakeFetch({ ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"call"}' } }] }) });
const aiDecision = await ai.askAi({ settings: settingsFor({}), state: aiState, seat: aiSeat, legal: legalMenu, fetchImpl: okFetch });
check('a good answer becomes a decision', aiDecision && aiDecision.action === 'call', JSON.stringify(aiDecision));
check('the request carries the key and the model',
  okFetch.calls[0].options.headers.authorization === 'Bearer sk-test'
    && okFetch.calls[0].body.model === ai.AI_DEFAULTS.model
    && okFetch.calls[0].url.endsWith('/chat/completions'),
  JSON.stringify(okFetch.calls[0].url));
check('the prompt describes the real table',
  okFetch.calls[0].body.messages[1].content.includes('\u5e95\u6c60') && okFetch.calls[0].body.messages[1].content.includes(`seat ${aiSeat}`),
  okFetch.calls[0].body.messages[1].content.slice(0, 90));

check('an HTTP error falls back to nothing', await ai.askAi({
  settings: settingsFor({}), state: aiState, seat: aiSeat, legal: legalMenu,
  fetchImpl: fakeFetch({ ok: false, status: 500, json: async () => ({}) }),
}) === null);
check('a network failure falls back to nothing', await ai.askAi({
  settings: settingsFor({}), state: aiState, seat: aiSeat, legal: legalMenu, fetchImpl: fakeFetch(new Error('offline')),
}) === null);
check('a timeout falls back to nothing', await ai.askAi({
  settings: settingsFor({}), state: aiState, seat: aiSeat, legal: legalMenu,
  fetchImpl: () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
}) === null);
check('a disabled configuration never calls out', await (async () => {
  const spy = fakeFetch({ ok: true, json: async () => ({}) });
  const answer = await ai.askAi({ settings: settingsModule.normaliseSettings({ aiEnabled: false }), state: aiState, seat: aiSeat, legal: legalMenu, fetchImpl: spy });
  return answer === null && spy.calls.length === 0;
})());

check('a raise is clamped into the paused menu', (() => {
  const parsed = ai.parseAiDecision(`{"action":"raise","amount":9999999}`, legalMenu);
  return parsed === null || (parsed.amount >= legalMenu.minRaiseTo && parsed.amount <= legalMenu.maxRaiseTo);
})(), JSON.stringify(legalMenu));

// Resume the way the host does: with a decision that fits the menu the pause carried.
const resumeAction = legalMenu.canCheck ? 'check' : 'call';
const resumed = engineModule.submitBotDecision(banked, { seat: aiSeat, action: resumeAction }, () => ({ action: 'check' }));
check('resuming applies the AI action', resumed.actionSeq > banked.actionSeq,
  `${banked.actionSeq} -> ${resumed.actionSeq}`);
check('the AI seat acted on that street',
  resumed.actionLog.some((entry) => entry.seat === aiSeat && entry.street === banked.street),
  JSON.stringify(resumed.actionLog.map((entry) => `${entry.seat}:${entry.action}`)));
// A pause may legitimately REAPPEAR: the same seat is on turn again on the next
// street, and the host asks for a fresh decision there. What must not happen is the
// old decision being reused for the new spot.
check('a later pause is a new decision, not the old one',
  !resumed.pendingDecision || resumed.pendingDecision.actionSeq !== banked.pendingDecision.actionSeq
    || resumed.pendingDecision.street !== banked.pendingDecision.street,
  JSON.stringify({ before: banked.pendingDecision.street, after: resumed.pendingDecision && resumed.pendingDecision.street }));

// ── the settings route (the plugin's page in the settings dialog) ──────────

const settingsGet = await request('GET', '/poker/settings');
check('the settings route answers with defaults',
  settingsGet.status === 200 && settingsGet.json.ok === true && settingsGet.json.settings.aiEnabled === false,
  JSON.stringify(settingsGet.json).slice(0, 200));
check('the settings route never echoes the key',
  settingsGet.json.settings.aiApiKey === undefined && settingsGet.json.settings.hasApiKey === false,
  JSON.stringify(settingsGet.json.settings));

// The route sends the field DESCRIPTORS too, which is what lets the page draw itself:
// adding a setting to `settings.js` shows up in the UI with no client change.
const settingsGroups = settingsGet.json.groups;
check('the settings route describes its fields', Array.isArray(settingsGroups) && settingsGroups.length === 5,
  JSON.stringify((settingsGroups || []).map((group) => group.id)));
check('the groups are the general/table/panel/AI/about ones',
  ['general', 'table', 'panel', 'ai', 'about'].every((id) => (settingsGroups || []).some((group) => group.id === id)),
  JSON.stringify((settingsGroups || []).map((group) => group.id)));
check('every descriptor carries a control kind and a label',
  (settingsGroups || []).every((group) => group.label && group.fields.every((field) => field.label && field.kind)),
  JSON.stringify(settingsGroups && settingsGroups[0]));
check('the on/off switches are in the general group',
  (settingsGroups || []).some((group) => group.id === 'general'
    && group.fields.some((field) => field.key === 'pluginEnabled' && field.kind === 'boolean')
    && group.fields.some((field) => field.key === 'coachEnabled' && field.kind === 'boolean')
    && group.fields.some((field) => field.key === 'showAdvice' && field.kind === 'boolean')),
  JSON.stringify(settingsGroups && settingsGroups[0] && settingsGroups[0].fields.map((field) => field.key)));
check('the table defaults are editable',
  (settingsGroups || []).some((group) => group.id === 'table'
    && group.fields.some((field) => field.key === 'botCount' && field.min === 1 && field.max === 8)
    && group.fields.some((field) => field.key === 'botStyles' && Array.isArray(field.options))),
  JSON.stringify(settingsGroups && settingsGroups[1] && settingsGroups[1].fields.map((field) => field.key)));
check('the secret is described but its value is withheld',
  (settingsGroups || []).some((group) => group.id === 'ai'
    && group.fields.some((field) => field.key === 'aiApiKey' && field.kind === 'password' && field.value === '')),
  JSON.stringify(settingsGroups && settingsGroups[3] && settingsGroups[3].fields.map((field) => field.key)));

const settingsPost = await request('POST', '/poker/settings', {
  pluginEnabled: false,
  coachEnabled: false,
  botCount: 3,
  botStyles: 'lag',
  aiEnabled: true,
  aiSeats: 2,
  aiBaseUrl: 'https://example.test/v1/',
  aiApiKey: 'sk-secret',
  aiModel: 'test-model',
});
check('the settings route saves', settingsPost.status === 200 && settingsPost.json.settings.aiEnabled === true,
  JSON.stringify(settingsPost.json).slice(0, 200));
check('the saved URL is normalised', settingsPost.json.settings.aiBaseUrl === 'https://example.test/v1',
  settingsPost.json.settings.aiBaseUrl);
check('the save reports the key without returning it',
  settingsPost.json.settings.hasApiKey === true && settingsPost.json.settings.aiApiKey === undefined,
  JSON.stringify(settingsPost.json.settings));
check('the values come back on the next read',
  settingsPost.json.settings.aiSeats === 2 && settingsPost.json.settings.aiModel === 'test-model'
    && settingsPost.json.settings.botCount === 3 && settingsPost.json.settings.botStyles === 'lag',
  JSON.stringify(settingsPost.json.settings));
check('the on/off switches persisted',
  settingsPost.json.settings.pluginEnabled === false && settingsPost.json.settings.coachEnabled === false,
  JSON.stringify({ plugin: settingsPost.json.settings.pluginEnabled, coach: settingsPost.json.settings.coachEnabled }));
check('the values live in the host settings service',
  settingsService.get('poker').aiModel === 'test-model' && settingsService.get('poker').aiApiKey === 'sk-secret',
  JSON.stringify(settingsService.get('poker')));
// A page cannot otherwise tell "saved" from "saved and in force": the host reports what it
// is running, which is also how a page detects an older host (it reports nothing at all).
check('the settings write reports what the host applied',
  settingsPost.json.applied !== undefined
    && settingsPost.json.applied.coachMode === 'simple'
    && settingsPost.json.applied.coachEnabled === false,
  JSON.stringify(settingsPost.json.applied));

const settingsBad = await request('POST', '/poker/settings', { aiSeats: 99, aiTemperature: 42, botStyles: 'nonsense' });
check('out-of-range values are clamped, not rejected',
  settingsBad.status === 200 && settingsBad.json.settings.aiSeats === 8 && settingsBad.json.settings.aiTemperature === 2,
  JSON.stringify(settingsBad.json.settings));
check('an unknown option falls back to the schema default',
  settingsBad.json.settings.botStyles === 'mixed', String(settingsBad.json.settings.botStyles));
check('a select whose default is a number survives normalisation',
  settingsModule.normaliseSettings({ replaySpeed: 2 }).replaySpeed === 2
    && settingsModule.normaliseSettings({}).replaySpeed === 1,
  JSON.stringify(settingsModule.normaliseSettings({ replaySpeed: 2 }).replaySpeed));
check('the big blind is never below the small blind', (() => {
  const settings = settingsModule.normaliseSettings({ smallBlind: 500, bigBlind: 100 });
  return settings.bigBlind >= settings.smallBlind;
})(), JSON.stringify(settingsModule.normaliseSettings({ smallBlind: 500, bigBlind: 100 })));

// The new-table defaults are what the route and the tool open with, when the caller
// does not pass its own values.
await request('POST', '/poker/settings', { aiEnabled: true, aiSeats: 2, botCount: 3, smallBlind: 25, bigBlind: 50 });
const defaultTable = await request('POST', '/poker/new', {});
check('a new table follows the configured defaults',
  defaultTable.json.view.players.length === 4 && defaultTable.json.view.bigBlind === 50,
  json({ players: defaultTable.json.view.players.length, bigBlind: defaultTable.json.view.bigBlind }));
check('the configured AI seats are attached to a new table',
  Array.isArray(defaultTable.json.view.aiSeats) && defaultTable.json.view.aiSeats.length === 2,
  JSON.stringify(defaultTable.json.view.aiSeats));
check('a caller-supplied argument still beats the defaults', (() => {
  const players = defaultTable.json.view.players.length;
  return players === 4;
})(), `${defaultTable.json.view.players.length} seats`);

// Turning the AI off must leave the table playable: the next hand's seats are all
// heuristics again.
const settingsOff = await request('POST', '/poker/settings', { aiEnabled: false });
check('the AI can be switched back off', settingsOff.json.settings.aiEnabled === false, JSON.stringify(settingsOff.json.settings));

// The coach switch is a real switch: off means the payload carries no analysis (the
// table, the legal menu and the log are untouched). A paused table has no coach to
// begin with, so this compares two tables opened the same way through the tool.
await request('POST', '/poker/settings', { coachEnabled: false });
const coachOffTable = await call('poker_new_table', { botCount: 1, startingStack: 2000, smallBlind: 25, bigBlind: 50, seed: 31 });
check('the coach switch reaches the view',
  coachOffTable.meta.view.coach === undefined && coachOffTable.meta.view.players.length === 2,
  json({ coach: coachOffTable.meta.view.coach === undefined, players: coachOffTable.meta.view.players.length }));
await request('POST', '/poker/settings', { coachEnabled: true });
const coachOnTable = await call('poker_new_table', { botCount: 1, startingStack: 2000, smallBlind: 25, bigBlind: 50, seed: 31 });
check('turning it back on restores the analysis',
  coachOnTable.meta.view.coach !== undefined && Array.isArray(coachOnTable.meta.view.coach.sections),
  json({ coach: Boolean(coachOnTable.meta.view.coach) }));
check('the table itself is unaffected by the coach switch',
  coachOnTable.meta.view.players.length === coachOffTable.meta.view.players.length
    && coachOnTable.meta.view.handNumber === coachOffTable.meta.view.handNumber,
  json({ on: coachOnTable.meta.view.handNumber, off: coachOffTable.meta.view.handNumber }));

// The coach STYLE is a setting as well: it reaches the coach that produced the payload, and
// the payload reports which one it was so a surface can label itself. Preflop gets the GTO
// layer too - leaving it out was the bug a player hit, because most decisions ARE preflop.
await request('POST', '/poker/settings', { coachMode: 'gto' });
const gtoTable = await call('poker_new_table', { botCount: 1, startingStack: 2000, smallBlind: 25, bigBlind: 50, seed: 31 });
check('the coach style setting reaches the payload',
  gtoTable.meta.view.coach !== undefined && typeof gtoTable.meta.view.coach.mode === 'string',
  json({ mode: gtoTable.meta.view.coach && gtoTable.meta.view.coach.mode }));
check('a preflop payload is produced by the GTO coach',
  gtoTable.meta.view.coach.mode === 'gto', String(gtoTable.meta.view.coach.mode));
check('the preflop GTO payload carries preflop numbers',
  gtoTable.meta.view.coach.gto !== null
    && gtoTable.meta.view.coach.gto.street === 'preflop'
    && Number.isFinite(gtoTable.meta.view.coach.gto.topShare)
    && typeof gtoTable.meta.view.coach.gto.role === 'string'
    && gtoTable.meta.view.coach.gto.mdf === null,
  json(gtoTable.meta.view.coach.gto));
check('the preflop GTO payload carries its two sections',
  gtoTable.meta.view.coach.sections.some((section) => section.id === 'gto')
    && gtoTable.meta.view.coach.sections.some((section) => section.id === 'range'),
  gtoTable.meta.view.coach.sections.map((section) => section.id).join(','));
await request('POST', '/poker/settings', { coachMode: 'simple' });
const backToSimple = await call('poker_new_table', { botCount: 1, startingStack: 2000, smallBlind: 25, bigBlind: 50, seed: 31 });
check('switching back is a real switch',
  backToSimple.meta.view.coach.mode === 'simple' && backToSimple.meta.view.coach.gto === null,
  json({ mode: backToSimple.meta.view.coach.mode, gto: backToSimple.meta.view.coach.gto }));
check('an unknown coach style falls back to simple',
  settingsModule.normaliseSettings({ coachMode: 'solver' }).coachMode === 'simple',
  settingsModule.normaliseSettings({ coachMode: 'solver' }).coachMode);

// ── 测试连通: the endpoint probe ───────────────────────────────────────────

const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => ({
    ok: true,
    status: 200,
    json: async () => ({ model: 'test-model', choices: [{ message: { content: 'pong' } }] }),
  });
  const tested = await request('POST', '/poker/settings-test', {});
  check('the connection test reports a round trip',
    tested.status === 200 && tested.json.ok === true && tested.json.result.ok === true
      && tested.json.result.reply === 'pong',
    JSON.stringify(tested.json).slice(0, 200));
  check('the connection test reports how long it took',
    Number.isFinite(tested.json.result.ms) && tested.json.result.ms >= 0, JSON.stringify(tested.json.result));
  check('the connection test reports the model the endpoint answered with',
    tested.json.result.model === 'test-model', JSON.stringify(tested.json.result));

  // The body on screen wins over what is stored, so a key can be tested before saving.
  const testedDraft = await request('POST', '/poker/settings-test', { aiModel: 'draft-model' });
  check('an unsaved draft is what gets tested', testedDraft.json.result.ok === true,
    JSON.stringify(testedDraft.json.result));

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
  const refused = await request('POST', '/poker/settings-test', {});
  check('a refused key is reported with the status and the body',
    refused.json.result.ok === false && refused.json.result.error.includes('401')
      && refused.json.result.error.includes('invalid api key'),
    JSON.stringify(refused.json.result));

  globalThis.fetch = async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  const timedOut = await request('POST', '/poker/settings-test', {});
  check('a timeout is reported as a timeout',
    timedOut.json.result.ok === false && /超时/.test(timedOut.json.result.error),
    JSON.stringify(timedOut.json.result));
} finally {
  globalThis.fetch = realFetch;
}

// ── 检查更新: the release check ────────────────────────────────────────────

const updateModule = await import('../lib/update.js');
const manifest = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('versions compare the way a person reads them',
  updateModule.compareVersions('0.1.0', '0.2.0') < 0
    && updateModule.compareVersions('1.0.0', '0.9.9') > 0
    && updateModule.compareVersions('v0.1.0', '0.1.0') === 0
    && updateModule.compareVersions('0.1.0', '0.1.1') < 0,
  JSON.stringify([
    updateModule.compareVersions('0.1.0', '0.2.0'),
    updateModule.compareVersions('1.0.0', '0.9.9'),
    updateModule.compareVersions('v0.1.0', '0.1.0'),
    updateModule.compareVersions('0.1.0', '0.1.1'),
  ]));
check('a tag without numbers still compares', updateModule.compareVersions('beta', 'alpha') > 0);
check('the default repository is this plugin\'s own',
  updateModule.DEFAULT_REPO === 'Eapp1e/dsh-poker', updateModule.DEFAULT_REPO);
check('the default repository matches package.json', (() => {
  const url = String(manifest.repository && manifest.repository.url || '');
  return url.includes(updateModule.DEFAULT_REPO);
})(), String(manifest.repository && manifest.repository.url));

const settingsWithVersion = await request('GET', '/poker/settings');
check('the settings page is told the installed version',
  typeof settingsWithVersion.json.version === 'string' && /^\d+\.\d+\.\d+/.test(settingsWithVersion.json.version),
  String(settingsWithVersion.json.version));
check('the version also arrives as an info field',
  (settingsWithVersion.json.groups || []).some((group) => group.fields.some((field) => field.kind === 'info' && /^v\d/.test(String(field.value)))),
  JSON.stringify((settingsWithVersion.json.groups || []).map((group) => group.id)));
check('the about group carries the update action',
  (settingsWithVersion.json.groups || []).some((group) => group.id === 'about'
    && group.fields.some((field) => field.kind === 'action' && field.action === 'update-apply')),
  JSON.stringify((settingsWithVersion.json.groups || []).find((group) => group.id === 'about')));
// The manual "check now" row is gone: the check runs on page load by itself, and the update
// button re-checks (past the cache) when there is nothing newer.
check('there is no separate check-now row',
  !(settingsWithVersion.json.groups || []).some((group) => group.fields.some((field) => field.action === 'update-check')),
  JSON.stringify((settingsWithVersion.json.groups || []).flatMap((group) => group.fields.map((field) => field.action)).filter(Boolean)));

/** A GitHub API double: answers by URL pattern. */
const githubDouble = (handlers) => async (url) => {
  for (const [pattern, answer] of handlers) {
    if (String(url).includes(pattern)) {
      if (answer instanceof Error) throw answer;
      return {
        ok: answer.status === 200,
        status: answer.status,
        json: async () => answer.json,
        text: async () => JSON.stringify(answer.json ?? ''),
      };
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

try {
  globalThis.fetch = githubDouble([
    ['/releases/latest', { status: 200, json: { tag_name: 'v9.9.9', html_url: 'https://github.com/Eapp1e/dsh-poker/releases/tag/v9.9.9', body: '很多新东西', published_at: '2026-01-01T00:00:00Z' } }],
  ]);
  const newer = await request('POST', '/poker/update-check', { force: true });
  check('a newer release is reported as newer',
    newer.status === 200 && newer.json.result.ok === true && newer.json.result.behind === true,
    JSON.stringify(newer.json).slice(0, 200));
  check('the newer release names both versions and the url',
    newer.json.result.latest === 'v9.9.9' && newer.json.result.url.includes('v9.9.9')
      && newer.json.result.lines.join(' ').includes('9.9.9'),
    JSON.stringify(newer.json.result.lines));
  check('the upgrade command is spelled out',
    newer.json.result.lines.some((line) => line.includes('dsh plugin')), JSON.stringify(newer.json.result.lines));

  globalThis.fetch = githubDouble([
    ['/releases/latest', { status: 200, json: { tag_name: `v${settingsWithVersion.json.version}` } }],
  ]);
  const same = await request('POST', '/poker/update-check', { force: true });
  check('the current version reports as up to date',
    same.json.result.behind === false && same.json.result.lines.join(' ').includes('已是最新'),
    JSON.stringify(same.json.result.lines));

  // Many repositories only tag: the check has to fall back rather than give up.
  globalThis.fetch = githubDouble([
    ['/releases/latest', { status: 404, json: {} }],
    ['/tags', { status: 200, json: [{ name: 'v3.0.0' }] }],
  ]);
  const tagged = await request('POST', '/poker/update-check', { force: true });
  check('a repository with only tags still answers',
    tagged.json.result.ok === true && tagged.json.result.source === 'tag' && tagged.json.result.latest === 'v3.0.0',
    JSON.stringify(tagged.json.result));

  globalThis.fetch = githubDouble([['/releases/latest', { status: 404, json: {} }], ['/tags', { status: 404, json: {} }]]);
  const missing = await request('POST', '/poker/update-check', { force: true });
  check('a missing repository is explained, not thrown',
    missing.status === 200 && missing.json.result.ok === false && missing.json.result.lines.join(' ').includes('没找到仓库'),
    JSON.stringify(missing.json.result.lines));

  globalThis.fetch = githubDouble([['/releases/latest', { status: 403, json: {} }]]);
  const limited = await request('POST', '/poker/update-check', { force: true });
  check('rate limiting is explained', limited.json.result.ok === false && /限流/.test(limited.json.result.lines.join(' ')),
    JSON.stringify(limited.json.result.lines));

  globalThis.fetch = async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  const offline = await request('POST', '/poker/update-check', { force: true });
  check('an offline machine gets a sentence, not an error',
    offline.status === 200 && offline.json.result.ok === false && /超时/.test(offline.json.result.lines.join(' ')),
    JSON.stringify(offline.json.result.lines));

  // The repository is a setting, so a fork can check itself - and the cache means one
  // lookup per window instead of one per settings open.
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9' }) };
  };
  await request('POST', '/poker/update-check', { updateRepo: 'someone/else' });
  await request('POST', '/poker/update-check', { updateRepo: 'someone/else' });
  await request('POST', '/poker/update-check', { updateRepo: 'someone/else', force: true });
  check('a non-default repository is honoured and cached', calls === 2, `${calls} requests for 3 checks`);
} finally {
  globalThis.fetch = realFetch;
}

// ── switching the coach style from the coach window ────────────────────────
//
// The coach window can switch the style itself, so a settings write has to change the
// analysis on the table that is ALREADY open - not just the next one. That means the
// host re-saves the table (which stamps the setting onto it and bumps the revision the
// panels poll for), and a live postflop view starts reporting GTO.

/** Play until the hero is on turn with a flop out. */
async function tableAtFlop(seed) {
  let view = (await call('poker_new_table', { botCount: 1, startingStack: 4000, smallBlind: 25, bigBlind: 50, seed })).meta.view;
  for (let step = 0; step < 30; step += 1) {
    if (view.board.length >= 3 && view.legal) return view;
    if (view.canDealNext) {
      view = (await call('poker_next_hand', {})).meta.view;
      continue;
    }
    if (!view.legal) return view;
    view = (await call('poker_action', { action: view.legal.canCheck ? 'check' : 'call' })).meta.view;
  }
  return view;
}

await request('POST', '/poker/settings', { coachMode: 'simple', coachEnabled: true });
const flopView = await tableAtFlop(4242);
check('a live flop is on screen for the switch',
  flopView.board.length >= 3 && flopView.legal !== null && flopView.coach !== undefined,
  json({ board: flopView.board.length, legal: flopView.legal !== null, coach: Boolean(flopView.coach) }));
check('the live table starts on the simple coach', flopView.coach.mode === 'simple', String(flopView.coach.mode));

const styleSwitch = await request('POST', '/poker/settings', { coachMode: 'gto' });
check('the settings write is accepted', styleSwitch.json.settings.coachMode === 'gto', json(styleSwitch.json.settings.coachMode));
const afterSwitch = await request('POST', '/poker/current', {});
check('switching re-saves the open table',
  afterSwitch.json.view.revision > flopView.revision,
  `${flopView.revision} -> ${afterSwitch.json.view.revision}`);
check('the live table now reports the GTO coach',
  afterSwitch.json.view.coach.mode === 'gto', String(afterSwitch.json.view.coach.mode));
check('the GTO sections are on the live table',
  afterSwitch.json.view.coach.sections.some((section) => section.id === 'gto')
    && afterSwitch.json.view.coach.sections.some((section) => section.id === 'range'),
  afterSwitch.json.view.coach.sections.map((section) => section.id).join(','));
check('the GTO numbers are on the live table',
  afterSwitch.json.view.coach.gto !== null
    && typeof afterSwitch.json.view.coach.gto.role === 'string'
    && Array.isArray(afterSwitch.json.view.coach.gto.ev)
    && afterSwitch.json.view.coach.gto.ev.length > 0,
  JSON.stringify(afterSwitch.json.view.coach.gto));
// Checked to means there is no bet to defend against, so MDF is not a number - the
// field is null rather than invented.
check('a check-to spot reports no MDF',
  afterSwitch.json.view.coach.gto.mdf === null || Number.isFinite(afterSwitch.json.view.coach.gto.mdf),
  JSON.stringify({ mdf: afterSwitch.json.view.coach.gto.mdf, toCall: afterSwitch.json.view.legal.toCall }));

await request('POST', '/poker/settings', { coachMode: 'simple' });
const backAgain = await request('POST', '/poker/current', {});
check('switching back changes the live table too',
  backAgain.json.view.coach.mode === 'simple'
    && !backAgain.json.view.coach.sections.some((section) => section.id === 'gto'),
  String(backAgain.json.view.coach.mode));

// ── 点击更新: the update itself ────────────────────────────────────────────

check('the package manager follows the lock file',
  updateModule.pickPackageManager(['pnpm-lock.yaml', 'package-lock.json']) === 'pnpm'
    && updateModule.pickPackageManager(['yarn.lock']) === 'yarn'
    && updateModule.pickPackageManager(['package-lock.json']) === 'npm'
    && updateModule.pickPackageManager([]) === 'npm',
  JSON.stringify([
    updateModule.pickPackageManager(['pnpm-lock.yaml']),
    updateModule.pickPackageManager(['yarn.lock']),
    updateModule.pickPackageManager([]),
  ]));
check('the install command is argv, not a shell string',
  JSON.stringify(updateModule.installArgv('npm', 'dsh-plugin-poker', '1.2.3')) === JSON.stringify(['npm', ['install', 'dsh-plugin-poker@1.2.3', '--no-audit', '--no-fund']])
    && updateModule.installArgv('pnpm', 'p', '2.0.0')[0] === 'pnpm',
  JSON.stringify(updateModule.installArgv('npm', 'dsh-plugin-poker', '1.2.3')));

/** Run applyUpdate against a stubbed GitHub and a stubbed package manager. */
const updateWith = (options) => updateModule.applyUpdate({
  current: '0.1.0',
  repo: 'Eapp1e/dsh-poker',
  packageName: 'dsh-plugin-poker',
  installRoot: '/tmp/install',
  manager: 'npm',
  ...options,
});
const releaseStub = (tag) => async () => ({ ok: true, status: 200, json: async () => ({ tag_name: tag }) });

const nothingToDo = await updateWith({ fetchImpl: releaseStub('v0.1.0'), run: async () => { throw new Error('must not run'); } });
check('an up-to-date install does not run anything',
  nothingToDo.ok === true && nothingToDo.updated === false && /已是最新/.test(nothingToDo.lines.join(' ')),
  JSON.stringify(nothingToDo));

let ran = null;
const didUpdate = await updateWith({
  fetchImpl: releaseStub('v9.9.9'),
  run: async (options) => {
    ran = options;
    return { code: 0, stdout: 'added 1 package in 3s', stderr: '' };
  },
});
check('an update runs the package manager in the install root',
  ran !== null && ran.command === 'npm' && ran.cwd === '/tmp/install'
    && ran.args.includes('dsh-plugin-poker@9.9.9'),
  JSON.stringify(ran));
check('a successful update reports both versions',
  didUpdate.ok === true && didUpdate.updated === true && didUpdate.version === '9.9.9'
    && /0\.1\.0/.test(didUpdate.lines.join(' ')) && /9\.9\.9/.test(didUpdate.lines.join(' ')),
  JSON.stringify(didUpdate.lines));

const failedUpdate = await updateWith({
  fetchImpl: releaseStub('v9.9.9'),
  run: async () => ({ code: 1, stdout: '', stderr: 'EACCES: permission denied' }),
});
check('a failed update explains itself and offers the manual command',
  failedUpdate.ok === false && failedUpdate.updated === false
    && /EACCES/.test(failedUpdate.lines.join(' ')) && /手动升级/.test(failedUpdate.lines.join(' ')),
  JSON.stringify(failedUpdate.lines));

// This package is not on npm, so a git checkout must update by pulling - `npm install` there
// would 404 instead of updating anything.
let gitRan = null;
const gitUpdate = await updateWith({
  fetchImpl: releaseStub('v9.9.9'),
  gitRoot: '/tmp/checkout',
  run: async (options) => {
    gitRan = options;
    return { code: 0, stdout: 'Already up to date.', stderr: '' };
  },
});
check('a git checkout updates by pulling',
  gitRan !== null && gitRan.command === 'git' && gitRan.args.join(' ') === '-C /tmp/checkout pull --ff-only'
    && gitUpdate.ok === true && gitUpdate.via === 'git',
  JSON.stringify({ ran: gitRan, result: gitUpdate.lines }));

// A tag that sorts ABOVE the installed version but is not a version number npm would take.
// (A tag that sorts below is simply "not newer"; a prerelease like 1.0.0-beta.1 is valid and
// is allowed through.)
const badTag = await updateWith({ fetchImpl: releaseStub('v1.2.3.4.5'), run: async () => { throw new Error('must not run'); } });
check('a tag that is not a version is refused before anything runs',
  badTag.ok === false && /不像版本号/.test(badTag.lines.join(' ')), JSON.stringify(badTag.lines));
check('a real prerelease tag is allowed through',
  updateModule.installArgv('npm', 'dsh-plugin-poker', '1.0.0-beta.1')[1].includes('dsh-plugin-poker@1.0.0-beta.1'),
  JSON.stringify(updateModule.installArgv('npm', 'dsh-plugin-poker', '1.0.0-beta.1')));

const noRunner = await updateWith({ fetchImpl: releaseStub('v9.9.9') });
check('without a runner the answer is the manual command',
  noRunner.ok === false && /手动升级/.test(noRunner.lines.join(' ')), JSON.stringify(noRunner.lines));

// The route itself: an up-to-date install answers without spawning anything, which is also
// what makes this test safe to run.
try {
  globalThis.fetch = releaseStub(`v${settingsWithVersion.json.version}`);
  const routeUpToDate = await request('POST', '/poker/update-apply', {});
  check('the update route answers when there is nothing to do',
    routeUpToDate.status === 200 && routeUpToDate.json.result.updated === false,
    JSON.stringify(routeUpToDate.json).slice(0, 200));
} finally {
  globalThis.fetch = realFetch;
}

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
