/**
 * Client-half harness: load lib/client.js the way the browser module loader
 * does - as a classic script under a fake `window.__ModuleLoader__` - with a
 * small hook-aware React so real components run their state and effects.
 *
 * This is the closest thing to a browser test that runs without a browser: it
 * proves the bundle registers under the right module id, exports an activatable
 * plugin, claims all six tool keys plus the session-header surface, reads the
 * newest table out of a session event window, renders a real table, and turns a
 * button click into one ordinary prompt.
 *
 *   node test/client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

/** Resolve a path next to this test file (Windows-safe). */
function local(relative) {
  const base = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.join(base, relative);
}

// ---- a fake browser: module loader, hook-aware React, and a little DOM ----

const loaded = [];
const styleTags = [];

/** Per-component hook state, so repeated renders behave like real re-renders. */
const hookStore = new WeakMap();
let slots = [];
let cursor = 0;
let pendingEffects = [];
let dirty = false;

const fakeReact = {
  Fragment: Symbol('dsh-fragment'),
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
    };
  },
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      dirty = true;
    };
    return [slots[index], set];
  },
  useCallback(fn) {
    return fn;
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect(effect) {
    pendingEffects.push(effect);
  },
};

/**
 * Render one component the way React would: hooks in order, effects after the
 * pass, and another pass when an effect changed state.
 */
function render(component, props) {
  let store = hookStore.get(component);
  if (store === undefined) {
    store = { slots: [], cleanups: [] };
    hookStore.set(component, store);
  }
  let element = null;
  for (let pass = 0; pass < 5; pass += 1) {
    // Effects clean up before the next pass, exactly like React.
    for (const cleanup of store.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        failures.push(`effect cleanup threw :: ${error && error.message}`);
      }
    }
    slots = store.slots;
    cursor = 0;
    pendingEffects = [];
    dirty = false;
    element = component(props);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') store.cleanups.push(cleanup);
    }
    if (!dirty) break;
  }
  return element;
}

globalThis.window = {
  __ModuleLoader__: { load: (item) => loaded.push(item) },
  innerWidth: 1280,
  innerHeight: 900,
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
  },
};

// A controllable clock: the replay's beats are queued here instead of running,
// so the harness can step the animation and assert what is on screen mid-play.
const pendingTimers = [];
globalThis.setTimeout = (fn, delay) => {
  pendingTimers.push({ fn, delay: delay ?? 0 });
  return pendingTimers.length;
};

/** Run every queued timer, including the ones they queue in turn. */
function runTimers(limit = 60) {
  let guard = 0;
  while (pendingTimers.length > 0 && guard < limit) {
    guard += 1;
    const timer = pendingTimers.shift();
    timer.fn();
  }
  return guard;
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  listeners: [],
  addEventListener(type, handler) {
    this.listeners.push({ type, handler });
  },
  removeEventListener(type, handler) {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) this.listeners.splice(index, 1);
  },
};

const requireShim = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`client bundle requested an unexpected module: ${name}`);
};

// The browser loads a client bundle as a CLASSIC SCRIPT, not an ES module, so
// the harness evaluates the same bytes the same way instead of importing them.
const bundleSource = fs.readFileSync(local('../lib/client.js'), 'utf8');
vm.runInThisContext(bundleSource, { filename: 'dsh-plugin-poker/lib/client.js' });

// ---- the bundle contract ----

check('the bundle registered exactly one module', loaded.length === 1, `got ${loaded.length}`);
const entry = loaded[0];
// The loader materializes a bundle lazily: running the factory IS the import.
const exportsObject = entry && entry.factory(requireShim);
check('the module id is the package name', entry && entry.id === 'dsh-plugin-poker', entry && entry.id);
check('the bundle declares the slots injection', exportsObject && JSON.stringify(exportsObject.inject) === '["slots"]', JSON.stringify(exportsObject && exportsObject.inject));
check('the bundle exports apply', exportsObject && typeof exportsObject.apply === 'function');
check('the bundle declares its own module record', bundleSource.includes('const module = { exports: {} }'));
const requests = [...bundleSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2]);
check('the bundle only requires the platform table', requests.every((name) => name === 'react'), requests.join(','));
check('one CSS tag was injected', styleTags.length === 1, `got ${styleTags.length}`);
check('the CSS tag is owned by the plugin', styleTags[0] && styleTags[0].dataset.plugin === 'dsh-plugin-poker');
check('the stylesheet dresses the felt', typeof styleTags[0].textContent === 'string' && styleTags[0].textContent.includes('dshp-felt'));
// The bet chip used to hang off the tile's top-right corner and cover the name.
check('the bet chip is centred above the seat', /\.dshp-betChip\{[^}]*left:50%[^}]*transform:translateX\(-50%\)/.test(styleTags[0].textContent), 'bet chip is not centred');
check('the bet chip sits clear of the seat text', /\.dshp-betChip\{[^}]*top:-1[5-9]px/.test(styleTags[0].textContent), 'bet chip overlaps the tile');
check('the pot BB pill uses the light palette', /\.dshp-bbBig\{[^}]*color:#a9d6ff/.test(styleTags[0].textContent), 'the pot BB pill would be unreadable');
check('the stylesheet has a hot-reload pill', /\.dshp-reload\{/.test(styleTags[0].textContent), 'no dshp-reload rule');
// Every action button keeps its own colour and brightens it on hover, so the
// four options read as one family - the fold button used to fall through to the
// generic white hover and wash its red out.
const sheet = styleTags[0].textContent;
check('every action button has a hover of its own', ['\\.dshp-btn:hover', '\\.dshp-btnPrimary:hover', '\\.dshp-btnDanger:hover', '\\.dshp-btnAllIn:hover', '\\.dshp-btnCommit:hover'].every((rule) => new RegExp(rule + '\\{').test(sheet)), 'a family lost its hover');
check('the all-in button is not the sizing grey', /\.dshp-btnAllIn\{[^}]*background:#6d4aff/.test(sheet), 'all-in still shares the preset grey');
// A LIGHT theme is what broke these two: a translucent wash with near-white text
// is invisible on a white panel, so the two themed accents are solid fills.
check('the themed action buttons are solid, not translucent', /\.dshp-btnAllIn\{[^}]*background:#6d4aff[^}]*color:#fff/.test(sheet)
  && /\.dshp-btnCommit\{[^}]*background:#2f7fd8[^}]*color:#fff/.test(sheet), 'a themed button is still a wash');
// The DARK theme is what broke the call button: it took the app's primary-button
// token, which in dark mode is nearly white, so white-on-white made the most-used
// button invisible. Call and fold are poker colours now, in every theme.
check('the call button is poker green, not a theme token', /\.dshp-btnPrimary\{[^}]*background:#2f9e44[^}]*color:#fff/.test(sheet)
  && !/\.dshp-btnPrimary\{[^}]*dsw-alias-button-primary/.test(sheet), 'the call button follows the theme again');
// Fold keeps its red through the app's error tokens, so the fill and the text
// come from the same theme; only the call button had to stop following a token
// that turns white in the dark theme.
check('the fold button stays red with white text', /\.dshp-btnDanger\{[^}]*color:#fff/.test(sheet)
  && /\.dshp-btnDanger\{[^}]*background:(var\(--dsw-alias-state-error-primary|#c0392b)/.test(sheet), 'the fold button lost its red');
check('the advice ring is yellow, not the raise blue', /\.dshp-btnAdvice\{[^}]*#ffd166/.test(sheet) && !/\.dshp-btnAdvice\{[^}]*4d9ef7/.test(sheet), 'the ring copies the commit colour');
// The hand log is reference material: names stay quiet.
check('the log names are quiet', /\.dshp-logWho\{[^}]*font-weight:600/.test(sheet) && !/\.dshp-logWho\{[^}]*ffe9a8/.test(sheet), 'log names are still the loud gold');
// The table dressing: felt with depth, a rail, round chips, and a seat hover
// that reveals the read.
check('the felt and rail have depth', /\.dshp-felt\{[^}]*radial-gradient/.test(sheet) && /\.dshp-table\{[^}]*linear-gradient/.test(sheet), 'the felt or rail went flat');
check('the chips are round', /\.dshp-chip\{[^}]*border-radius:50%/.test(sheet), 'no chip discs');
check('a hovered seat reveals its read', /\.dshp-seat:hover \.dshp-seatRead\{display:block\}/.test(sheet), 'the read can never appear');
check('the dealer button is a chip', /\.dshp-dealer\{[^}]*border-radius:50%/.test(sheet), 'no dealer chip');
// One fixed spot per seat: the chip is pinned over the tile's top-left corner and
// hangs outside the box, so it never covers the avatar, the stack or the cards.
check('the dealer chip is pinned to one corner', /\.dshp-dealer\{[^}]*top:-\d+px[^}]*left:-\d+px/.test(sheet)
  && !/\.dshp-dealer(Above|Below|Left|Right)\{/.test(sheet), 'the dealer chip moved around');
// A real dealer's board is one evenly spaced row: unequal gaps between the flop,
// the turn and the river read as a layout bug (which is how the player read
// them). The cards themselves say which street is new - they arrive one at a
// time - so there is nothing left for a gap to say.
check('the five board cards are spaced evenly', /\.dshp-boardRow\{[^}]*gap:\d+px/.test(sheet)
  && !/\.dshp-boardGap\{/.test(sheet) && !/dshp-boardGap/.test(sheet.replace(/dshp-board[A-Za-z]*Row/g, '')),
  'the board still has a special street gap');
// The dealing area must survive a squeezed card: the centre paints ABOVE the
// seats (so the street text is never hidden behind a tile) and a narrow table
// shrinks the board through a container query instead of letting it run over the
// rail. Both were reported from a narrow transcript column.
check('the street text paints above the seats', /\.dshp-center\{[^}]*z-index:3/.test(sheet) && /\.dshp-seat\{[^}]*z-index:1/.test(sheet),
  'the centre can still be covered by a seat');
check('a narrow table shrinks its board instead of overflowing it', /\.dshp-table\{[^}]*container-type:inline-size/.test(sheet)
  && /@container \(max-width:520px\)\{[^}]*\.dshp-card\{width:\d+px/.test(sheet.replace(/\n/g, '')), 'no container query for the board');
// The deal animation must not lift a card over the line above it while it fades in.
const dealTravel = Number((/@keyframes dshpDealIn\{from\{opacity:0;transform:translateY\(-(\d+)px\)/.exec(sheet) || [])[1]);
check('a dealt card does not jump over the text above it', dealTravel > 0 && dealTravel <= 8, `travel ${dealTravel}px`);
// The page's table cache hangs off `window` so a rebuilt bundle swapped in by
// the host's client HMR keeps the table (and its replay) instead of resetting.
check('the table cache survives a client reload', globalThis.window.__dshPokerTables instanceof Map, String(globalThis.window.__dshPokerTables));

// ---- real host payloads feed the views ----

const host = await import('../lib/index.js');
const registered = new Map();
host.apply({
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } },
  effect: (callback) => callback(),
});

const session = { id: 'client-harness' };
const exec = { agent: { session } };
const opened = await registered.get('poker_new_table').execute({ botCount: 2, startingStack: 5000, smallBlind: 25, bigBlind: 50, seed: 4242 }, exec);
const openedMeta = registered.get('poker_new_table').output.presentationMeta({}, opened);
check('the tool payload carries a browser view', openedMeta && openedMeta.view && Array.isArray(openedMeta.view.players));

const checked = await registered.get('poker_action').execute({ action: 'call' }, exec);
const checkedMeta = registered.get('poker_action').output.presentationMeta({}, checked);

/** A session event window holding the two real poker calls, newest last. */
function eventWindow() {
  return {
    entries: [
      { type: 'event', event: { type: 'user/message', seq: 1, data: {} } },
      { type: 'event', event: { type: 'tool/call', seq: 2, data: { callId: 'call_a', name: 'poker_new_table', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'call_a' }, content: [] }, meta: openedMeta } } },
      { type: 'event', event: { type: 'tool/call', seq: 4, data: { callId: 'call_b', name: 'poker_action', arguments: '{"action":"call"}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 5, data: { message: { source: { kind: 'tool', callId: 'call_b' }, content: [] }, meta: checkedMeta } } },
    ],
    hasMore: false,
    revision: 1,
  };
}

let submitted = null;
let subscribed = 0;
// The fold-replay session below gets its own event window, filled in once the
// table it plays has been opened, so this binding reads it lazily.
let foldWindow = null;
// The teaching-window sessions: the analysis is rendered by the header surface
// from whatever view that session last logged. One fixture per scenario, keyed
// by session id, because the page caches the newest table per session.
const coachFixtures = new Map();
const sessionsService = {
  binding: (sessionId) => (sessionId === session.id
    ? {
        session: { prompt: (parts, mode) => { submitted = { sessionId, parts, mode }; } },
        eventSource: {
          getSnapshot: eventWindow,
          subscribe: () => { subscribed += 1; return () => {}; },
        },
      }
    : sessionId === 'fold-harness' && foldWindow
      ? {
          session: { prompt: (parts, mode) => { submitted = { sessionId, parts, mode }; } },
          eventSource: {
            getSnapshot: () => foldWindow,
            subscribe: () => { subscribed += 1; return () => {}; },
          },
        }
      : coachFixtures.has(sessionId)
        ? {
            session: { prompt: (parts, mode) => { submitted = { sessionId, parts, mode }; } },
            eventSource: {
              getSnapshot: () => coachFixtures.get(sessionId),
              subscribe: () => { subscribed += 1; return () => {}; },
            },
          }
        : undefined),
};

// ---- the browser's fetch is wired to the plugin's REAL route handler -------

const hostPlugin = await import('../lib/index.js');
const fetchRequests = [];
let failFetch = false;
let lastRouteAnswer = null;
// One-shot override: a stand-in answer for the NEXT matching route call, used to
// play the part of a host that predates a feature (see the stale-host test).
let fetchOverride = null;

/** A request stand-in matching what the webserver hands a route handler. */
function fakeHttpRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A response stand-in that records status and body. */
function fakeHttpResponse() {
  const state = { status: 0, body: '' };
  return {
    writeHead(status) {
      state.status = status;
    },
    end(body) {
      state.body = body ?? '';
    },
    settle() {
      return { status: state.status, json: state.body ? JSON.parse(state.body) : null };
    },
  };
}

globalThis.fetch = async (url, options) => {
  const body = options && options.body ? JSON.parse(options.body) : undefined;
  fetchRequests.push({ url, method: (options && options.method) || 'GET', body });
  if (failFetch) throw new Error('route unavailable');
  if (fetchOverride !== null) {
    const answer = fetchOverride(url, body);
    if (answer !== undefined && answer !== null) {
      lastRouteAnswer = answer;
      return { status: 200, ok: true, json: async () => answer };
    }
  }
  const response = fakeHttpResponse();
  await hostPlugin.handlePokerRequest(fakeHttpRequest((options && options.method) || 'GET', url, body), response);
  const settled = response.settle();
  lastRouteAnswer = settled.json;
  return { status: settled.status, ok: settled.status === 200, json: async () => settled.json };
};

// ---- activate against a fake slot registry ----

const registrations = [];
const fakeCtx = {
  services: {
    slots: { inject: (_key, callback) => callback(), register: (options, component) => registrations.push({ options, component }) },
    sessions: sessionsService,
  },
  get(name) {
    return this.services[name];
  },
};

exportsObject.apply(fakeCtx);

const EXPECTED_KEYS = ['poker_new_table', 'poker_action', 'poker_next_hand', 'poker_table', 'poker_opponent', 'poker_equity'];
const toolCards = registrations.filter((registration) => registration.options.name === 'tool.call.toolview');
// The panel lives in the SIDEBAR FOOTER: one surface for the whole app, so moving
// between conversations neither remounts it nor replays the hand again.
const headerActions = registrations.filter((registration) => registration.options.name === 'sidebar.footer.action');
check('every poker tool key is claimed', toolCards.length === EXPECTED_KEYS.length, `got ${toolCards.length}`);
check(
  'the claimed keys are the poker tools',
  EXPECTED_KEYS.every((key) => toolCards.some((registration) => registration.options.key === key)),
  toolCards.map((registration) => registration.options.key).join(','),
);
check('the sidebar gains one poker surface', headerActions.length === 1, `got ${headerActions.length}`);
check('the panel surface uses the list-slot id option', headerActions.length === 1 && headerActions[0].options.id === 'poker', JSON.stringify(headerActions[0] && headerActions[0].options));
check('nothing claims the per-session header any more', registrations.every((registration) => registration.options.name !== 'conversation.session.header.actions'),
  registrations.map((registration) => registration.options.name).join(','));
check('every registration passes a plain component', registrations.every((registration) => typeof registration.component === 'function'));

/** The sidebar panel surface, exercised further below. */
const headerComponent = headerActions[0].component;

/**
 * Put the panel into a known state by clicking its toggle only while it is not
 * already there. Sections used to depend on whatever state the previous section
 * left behind, which made a reordering silently break unrelated checks.
 * @param open - the state wanted.
 * @param sessionId - which session to render.
 * @returns the rendered tree in that state.
 */
function setPanel(open, sessionId = session.id) {
  let tree = walkAll(render(headerComponent, { sessionId }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (classes(tree).includes('dshp-panel') === open) return tree;
    const toggle = tree.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-headerBtn'));
    if (toggle === undefined) return tree;
    toggle.props.onClick();
    tree = walkAll(render(headerComponent, { sessionId }));
  }
  return tree;
}

// ---- tree helpers ----

/** Document-level listeners the plugin registered, newest last. */
function documentListeners(type) {
  const all = globalThis.document.listeners;
  return type ? all.filter((entry) => entry.type === type).map((entry) => entry.handler) : all;
}

/** Flatten a fake React tree into visible text. */
function flatten(node) {  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join(' ');
  if (typeof node.type === 'function') return flatten(node.type(node.props));
  return flatten(node.children);
}

/** Collect elements of one tag from the tree. */
function collect(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, tag, out);
    return out;
  }
  if (node.type === tag) out.push(node);
  if (typeof node.type === 'function') collect(node.type(node.props), tag, out);
  collect(node.children, tag, out);
  return out;
}

/** Every class name present in the tree. */
function classes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) classes(child, out);
    return out;
  }
  if (node.props && typeof node.props.className === 'string') out.push(...node.props.className.split(' '));
  if (typeof node.type === 'function') classes(node.type(node.props), out);
  classes(node.children, out);
  return out;
}

/**
 * Flatten a tree ONCE, invoking every function component exactly once.
 *
 * Separate `collect` calls re-invoke components, so elements gathered by two
 * different walks close over different render state. Anything that has to agree
 * - an uncontrolled input and the button that fills it - must come from ONE walk.
 */
function walkAll(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walkAll(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    walkAll(node.type(node.props), out);
    return out;
  }
  out.push(node);
  walkAll(node.children, out);
  return out;
}

// ---- the inline card that replaces a poker tool call's row ----

const cardComponent = toolCards.find((registration) => registration.options.key === 'poker_action').component;
const settledBlock = {
  kind: 'tool-result',
  meta: checkedMeta,
  content: [{ type: 'text', text: checked.text }],
  call: { name: 'poker_action', argsRaw: '{"action":"call"}' },
};

let card;
try {
  card = render(cardComponent, { block: settledBlock, sessionId: session.id, toolName: 'poker_action' });
} catch (error) {
  failures.push(`rendering a settled table threw :: ${error && error.message}`);
}

const cardText = flatten(card);
const cardClasses = classes(card);
check('the card draws the felt', cardClasses.includes('dshp-felt'), cardClasses.join(','));
check('the card shows the pot', cardClasses.includes('dshp-pot'), cardText.slice(0, 120));
check('the card renders every seat', ['\u73a9\u5bb6', '\u8001\u738b', '\u963f\u73cd'].every((name) => cardText.includes(name)), cardText.slice(0, 200));
check('the card renders five board slots', cardClasses.filter((name) => name === 'dshp-card').length >= 5, String(cardClasses.filter((name) => name === 'dshp-card').length));
check('face-down opponents keep a card back', cardClasses.includes('dshp-cardBack'));

// ---- the standard oval layout: seats on the rail, pot in the middle --------

const seatNodes = collect(card, 'div').filter((node) => String(node.props.className || '').split(' ').includes('dshp-seat'));
check('every player gets a seat on the rail', seatNodes.length === checkedMeta.view.players.length, `${seatNodes.length} seats for ${checkedMeta.view.players.length} players`);
check(
  'seats are positioned around the oval',
  seatNodes.length > 0 && seatNodes.every((node) => /%$/.test(String(node.props.style && node.props.style.left)) && /%$/.test(String(node.props.style && node.props.style.top))),
  JSON.stringify(seatNodes.map((node) => node.props.style)),
);
const heroSeat = seatNodes.find((node) => String(node.props.className).includes('dshp-seatHero'));
check('the hero sits at the bottom of the table', heroSeat !== undefined && parseFloat(heroSeat.props.style.top) > 70, heroSeat && JSON.stringify(heroSeat.props.style));
const opponentTops = seatNodes.filter((node) => node !== heroSeat).map((node) => parseFloat(node.props.style.top));
check('opponents sit above the hero', heroSeat !== undefined && opponentTops.every((top) => top < parseFloat(heroSeat.props.style.top)), JSON.stringify(opponentTops));
check('the pot and board live in the middle of the felt', collect(card, 'div').some((node) => String(node.props.className).includes('dshp-center')));
check('the table is an oval, not a list', cardClasses.includes('dshp-table') && !cardClasses.includes('dshp-seats'), cardClasses.join(','));

// ---- a full ring must not stack its side seats on top of each other --------

const nineMeta = registered.get('poker_new_table').output.presentationMeta({}, await registered.get('poker_new_table').execute({ botCount: 8 }, exec));
const nineCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: nineMeta, content: [], call: { name: 'poker_new_table', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_new_table',
});
const nineFlat = walkAll(nineCard);
const nineSeats = nineFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat'));
check('a nine-handed table renders nine seats', nineSeats.length === 9, String(nineSeats.length));
const nineTable = nineFlat.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-table'));
// The oval is on the table, the felt fills it; what keeps a seat tile off the
// action buttons is the table's VERTICAL margin, the room the tiles hang into.
check('a big table is drawn taller than a small one', nineTable !== undefined && Number(nineTable.props.style && nineTable.props.style.aspectRatio) < 1.45, nineTable && JSON.stringify(nineTable.props.style));
const tableMargin = /\.dshp-table\{[^}]*margin:(\d+)px 0 (\d+)px/.exec(sheet);
check('the table reserves vertical room for the seat tiles', nineTable.props.style.aspectRatio !== undefined
  && tableMargin !== null && Number(tableMargin[1]) >= 40 && Number(tableMargin[2]) >= 50
  && /\.dshp-felt\{[^}]*width:100%;height:100%/.test(sheet),
  JSON.stringify({ style: nineTable.props.style, margin: tableMargin && tableMargin.slice(1) }));
check('a big table keeps full-size cards', !nineSeats.some((node) => String(node.props.className).includes('dshp-seatDense')), nineSeats.map((node) => node.props.className).join(' | '));

// Geometry check: with the felt width fixed at 640px, no two seats down the
// same side may sit closer than one tile's height (~87px) — that is the overlap
// a player actually sees.
const feltWidth = 640;
const feltHeight = feltWidth / Number(nineTable.props.style.aspectRatio);
const positions = nineSeats.map((node) => ({ x: parseFloat(node.props.style.left), y: parseFloat(node.props.style.top) }));
for (const [side, low, high] of [['left', -1, 30], ['right', 70, 101]]) {
  const column = positions.filter((point) => point.x >= low && point.x <= high).sort((a, b) => a.y - b.y);
  const gaps = [];
  for (let index = 1; index < column.length; index += 1) gaps.push(Math.round(((column[index].y - column[index - 1].y) / 100) * feltHeight));
  check(`${side}-side seats clear each other`, column.length >= 2 && gaps.every((gap) => gap >= 90), `gaps ${JSON.stringify(gaps)} on a ${Math.round(feltHeight)}px felt`);
}

// The hovered read used to run off the panel and get clipped. Every seat now
// says where its read hangs (`data-read`), and that choice is checked against the
// felt: the 214px card must land entirely inside it, on any seat of a full ring.
const READ_W = 214;
const READ_H = 96;
const TILE_W = 92;
const TILE_H = 100;
check('the read tooltip has the width this check assumes', /\.dshp-seatRead\{[^}]*width:214px/.test(sheet), 'the tooltip width changed');
check('every seat decides where its read hangs', nineSeats.every((node) => /^(above|below)-(left|center|right)$/.test(String(node.props['data-read']))), nineSeats.map((node) => node.props['data-read']).join(' | '));
for (const seat of nineSeats) {
  const anchor = String(seat.props['data-read']);
  const x = (parseFloat(seat.props.style.left) / 100) * feltWidth;
  const y = (parseFloat(seat.props.style.top) / 100) * feltHeight;
  const box = anchor.endsWith('left')
    ? { left: x - TILE_W / 2, right: x - TILE_W / 2 + READ_W }
    : anchor.endsWith('right')
      ? { left: x + TILE_W / 2 - READ_W, right: x + TILE_W / 2 }
      : { left: x - READ_W / 2, right: x + READ_W / 2 };
  if (anchor.startsWith('below')) {
    box.top = y + TILE_H / 2 + 9;
    box.bottom = box.top + READ_H;
  } else {
    box.bottom = y - TILE_H / 2 - 9;
    box.top = box.bottom - READ_H;
  }
  check(`seat ${seat.props['data-seat']} hangs its read inside the felt`,
    box.left >= 0 && box.right <= feltWidth && box.top >= 0 && box.bottom <= feltHeight,
    `${anchor} ${JSON.stringify(box)} on a ${Math.round(feltWidth)}x${Math.round(feltHeight)} felt`);
}

// ---- the hot-reload pill ---------------------------------------------------

// The host re-imports the plugin's own code when its files change, and stamps
// the next payload so the player can see the edit is already live.
const reloadCard = render(cardComponent, {
  block: {
    kind: 'tool-result',
    meta: { ...checkedMeta, view: { ...checkedMeta.view, reload: { at: 1, clock: '18:52:03', files: ['engine.js'] } } },
    content: [],
    call: { name: 'poker_action', argsRaw: '{}' },
  },
  sessionId: session.id,
  toolName: 'poker_action',
});
check('a reloaded plugin says so on the felt', flatten(reloadCard).includes('\u4ee3\u7801\u5df2\u70ed\u91cd\u8f7d 18:52:03'), flatten(reloadCard).slice(-200));
check('the pill names the file that changed', walkAll(reloadCard).some((node) => String(node.props && node.props.title || '').includes('engine.js')), 'no title naming the changed file');
check('no pill without a reload', !cardText.includes('\u4ee3\u7801\u5df2\u70ed\u91cd\u8f7d'), cardText.slice(-200));

// ---- the optional teaching layer ------------------------------------------

// A coach payload as the host sends it: sections are data, not markup, so the
// window renders whatever analysis the host provides. `plan` is the same advice
// as data, which is what the action row turns into a badge and a ring.
const coachMeta = {
  ...checkedMeta,
  view: {
    ...checkedMeta.view,
    coach: {
      version: 1,
      brief: 'coach brief',
      equity: { equity: 58.3, margin: 2.6 },
      plan: { headline: '\u5f03\u724c', action: 'fold', tone: 'bad' },
      sections: [
        { id: 'spot', icon: '\u{1F9ED}', title: '\u5c40\u9762', lines: ['\u4f60\u5728\u6309\u94ae\u4f4d BTN\uff0c\u7ffb\u724c\u5708', '\u5e95\u6c60 600\uff0cSPR 8'] },
        {
          id: 'plan',
          icon: '\u{1F3AF}',
          title: '\u4e0b\u6ce8\u903b\u8f91\u4e0e\u5efa\u8bae',
          tone: 'good',
          lines: ['\u4e0b\u6ce8 400\uff08\u7ea6 2/3 \u6c60\uff09', '\u9876\u5bf9\u503c\u5f97\u6536\u4ef7\u503c'],
          items: [{ label: '\u98ce\u9669 / \u53cd\u9762', text: '\u591a\u4eba\u5e95\u6c60\u91cc\u8bc8\u552c\u5931\u8d25\u7387\u66f4\u9ad8' }],
          tags: [{ term: 'c-bet', zh: '\u6301\u7eed\u4e0b\u6ce8', why: '\u7ffb\u524d\u52a0\u6ce8\u8005\u5728\u7ffb\u724c\u5708\u7ee7\u7eed\u4e0b\u6ce8' }],
        },
      ],
    },
  },
};
const coachBlock = { kind: 'tool-result', meta: coachMeta, content: [], call: { name: 'poker_action', argsRaw: '{}' } };

// The analysis lives in its own window on the persistent header surface, so the
// session it reads from is what the test has to seed.
coachFixtures.set('coach-session', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'coach_a', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'coach_a' }, content: [] }, meta: coachMeta } } },
  ],
  hasMore: false,
  revision: 1,
});
const coachTree = render(headerComponent, { sessionId: 'coach-session' });
const coachFlat = walkAll(coachTree);
const coachTextOut = flatten(coachTree);
check('the teaching window renders the host sections', coachTextOut.includes('\u4f60\u5728\u6309\u94ae\u4f4d BTN') && coachTextOut.includes('\u4e0b\u6ce8 400'), coachTextOut.slice(-200));
check('the teaching window shows the win rate with its error bar', /\u80dc\u7387\u7ea6 58% \u00b12\.6%/.test(coachTextOut), coachTextOut.slice(-200));
check('a section carries its tone', classes(coachTree).includes('dshp-teachGood'), classes(coachTree).filter((name) => name.startsWith('dshp-teach')).join(','));
check('items are rendered with their label', coachTextOut.includes('\u98ce\u9669 / \u53cd\u9762\uff1a'), coachTextOut.slice(-200));
check('terms arrive as pills with their explanation', coachFlat.some((node) => node.props && node.props.title === '\u7ffb\u524d\u52a0\u6ce8\u8005\u5728\u7ffb\u724c\u5708\u7ee7\u7eed\u4e0b\u6ce8'), 'no vocabulary pill');
const coachWinNode = coachFlat.find((node) => String(node.props && node.props.className || '').includes('dshp-coachWin'));
check('the analysis is its own window, not part of the table panel', coachWinNode !== undefined && !classes(coachTree).includes('dshp-panel'), classes(coachTree).filter((name) => name.startsWith('dshp-coach')).join(','));
check('it opens on the left by default', coachWinNode !== undefined && coachWinNode.props.style.left === '20px', JSON.stringify(coachWinNode && coachWinNode.props.style));
check('it has its own pin and close', coachFlat.filter((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-iconBtn')).length >= 1
  && coachFlat.some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-close')), 'window controls missing');

// The one-line recommendation is data, so the action row can point at the button
// that would follow it - this is what stops a prefilled raise box from reading
// like advice.
const adviceCard = render(cardComponent, { block: coachBlock, sessionId: session.id, toolName: 'poker_action' });
const adviceFlat = walkAll(adviceCard);
const adviceText = flatten(adviceCard);
check('the action row repeats the recommendation', adviceText.includes('\u6559\u7ec3\u5efa\u8bae') && adviceText.includes('\u5f03\u724c'), adviceText.slice(-200));
check('the recommended action is ringed', adviceFlat.some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnAdvice') && String(node.props.className || '').includes('dshp-btnDanger')), adviceFlat.filter((node) => node.type === 'button').map((node) => String(node.props.className || '')).join(' | '));
check('no other action is ringed', adviceFlat.filter((node) => String(node.props.className || '').includes('dshp-btnAdvice')).length === 1, String(adviceFlat.filter((node) => String(node.props.className || '').includes('dshp-btnAdvice')).length));

// One switch hides the whole layer: the window, the badge, the board read and
// the terms - while the action controls stay exactly where they were. The switch
// lives on the card and in the table panel's title bar; both drive one preference.
const toggleButton = adviceFlat.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-teachToggle'));
check('the teaching layer can be switched off', toggleButton !== undefined, 'no toggle button');
check('the switch is an icon, not a sentence', flatten(toggleButton) === '\u{1F4A1}', JSON.stringify(flatten(toggleButton)));
// It is the SAME kind of button as the pin beside it - same class, same hover,
// same amber "on" state - so the title bar reads as one toolbar. A styling rule
// of its own is what the player asked us to remove.
check('the teaching switch is built like the pin', String(toggleButton.props.className).includes('dshp-iconBtn')
  && String(toggleButton.props.className).includes('dshp-iconBtnOn')
  && toggleButton.props['data-teach'] === 'on'
  && !/\.dshp-teachToggle/.test(sheet), String(toggleButton.props.className));
if (toggleButton) toggleButton.props.onClick();
const offTree = render(headerComponent, { sessionId: 'coach-session' });
check('switching off closes the window', !classes(offTree).includes('dshp-coachWin'), classes(offTree).filter((name) => name.startsWith('dshp-coach')).join(','));
const offCard = render(cardComponent, { block: coachBlock, sessionId: session.id, toolName: 'poker_action' });
const offText = flatten(offCard);
check('switching off drops the recommendation badge', !offText.includes('\u6559\u7ec3\u5efa\u8bae'), offText.slice(-160));
check('switching off keeps the action buttons', walkAll(offCard).some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btn')), 'action buttons disappeared');
check('switching off keeps the size presets', walkAll(offCard).some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-size')), 'size presets disappeared');
check('switching off leaves no coaching prose in the table', !offText.includes('\u724c\u9762\uff1a'), offText.slice(-160));
check('the choice is remembered', (() => {
  try {
    return globalThis.window.localStorage.getItem('dsh-plugin-poker/coach') === 'off';
  } catch (error) {
    return false;
  }
})(), 'preference was not stored');
check('the switch is still there when the layer is off', walkAll(offCard).some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-teachToggle')), offText.slice(0, 160));
const offToggle = walkAll(offCard).find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-teachToggle'));
check('the switch loses its amber, keeps its size, when off', offToggle !== undefined
  && !String(offToggle.props.className).includes('dshp-iconBtnOn')
  && offToggle.props['data-teach'] === 'off'
  && String(offToggle.props.className).includes('dshp-iconBtn'), offToggle && String(offToggle.props.className));
if (offToggle) offToggle.props.onClick();
const restoredTree = render(headerComponent, { sessionId: 'coach-session' });
check('switching back on restores the window', flatten(restoredTree).includes('\u4f60\u5728\u6309\u94ae\u4f4d BTN'), flatten(restoredTree).slice(-160));

// A view the host sent without an analysis (an older payload, or a table with no
// cards yet) must not grow an empty window.
const noCoachView = { ...checkedMeta.view };
delete noCoachView.coach;
coachFixtures.set('coach-empty-session', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'coach_b', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'coach_b' }, content: [] }, meta: { ...checkedMeta, view: noCoachView } } } },
  ],
  hasMore: false,
  revision: 1,
});
const noCoachTree = render(headerComponent, { sessionId: 'coach-empty-session' });
check('a view without a coach shows no window', !classes(noCoachTree).includes('dshp-coachWin'), classes(noCoachTree).filter((name) => name.startsWith('dshp-coach')).join(','));

// ---- the teaching window: folding, pinning, dragging ----------------------

/** Locate the coach window's title bar in a rendered header tree. */
function coachHead(tree) {
  return walkAll(tree).find((node) => String(node.props && node.props.className || '').includes('dshp-coachWinHead'));
}

const foldTree = render(headerComponent, { sessionId: 'coach-session' });
const sectionTitles = walkAll(foldTree).filter((node) => String(node.props && node.props.className || '').includes('dshp-teachSecTitle'));
check('every analysis section is foldable', sectionTitles.length === 2, `got ${sectionTitles.length}`);
check('a section opens expanded', flatten(foldTree).includes('\u4f60\u5728\u6309\u94ae\u4f4d BTN'), flatten(foldTree).slice(-160));
if (sectionTitles[0]) sectionTitles[0].props.onClick();
const foldedTree = render(headerComponent, { sessionId: 'coach-session' });
check('clicking a title folds that section only', !flatten(foldedTree).includes('\u4f60\u5728\u6309\u94ae\u4f4d BTN') && flatten(foldedTree).includes('\u4e0b\u6ce8 400'), flatten(foldedTree).slice(-200));
const foldAll = walkAll(foldedTree).find((node) => node.type === 'button' && flatten(node) === '\u6536\u8d77\u5168\u90e8');
check('the window offers a fold-all control', foldAll !== undefined, flatten(foldedTree).slice(-200));
check('the window footer carries no position hint', !flatten(foldedTree).includes('\u5df2\u56fa\u5b9a\u4f4d\u7f6e') && !flatten(foldedTree).includes('\u4f4d\u7f6e\u81ea\u52a8\u8bb0\u4f4f'), flatten(foldedTree).slice(-200));
if (foldAll) foldAll.props.onClick();
const allFoldedTree = render(headerComponent, { sessionId: 'coach-session' });
check('folding all leaves only the titles', !flatten(allFoldedTree).includes('\u4e0b\u6ce8 400') && flatten(allFoldedTree).includes('\u5c55\u5f00\u5168\u90e8'), flatten(allFoldedTree).slice(-200));
const unfold = walkAll(allFoldedTree).find((node) => node.type === 'button' && flatten(node) === '\u5c55\u5f00\u5168\u90e8');
if (unfold) unfold.props.onClick();
check('unfolding brings the analysis back', flatten(render(headerComponent, { sessionId: 'coach-session' })).includes('\u4f60\u5728\u6309\u94ae\u4f4d BTN'), 'still folded');

// Pinning locks the window and is remembered separately from the table panel.
const pinTree = render(headerComponent, { sessionId: 'coach-session' });
const winPin = walkAll(coachHead(pinTree)).find((node) => node.type === 'button' && flatten(node) === '\u{1F4CC}');
check('the window has its own pin', winPin !== undefined, 'no pin in the window header');
if (winPin) winPin.props.onClick();
const pinnedTree = render(headerComponent, { sessionId: 'coach-session' });
check('pinning marks the window as fixed', classes(pinnedTree).includes('dshp-coachWinPinned'), classes(pinnedTree).filter((name) => name.startsWith('dshp-coach')).join(','));
check('the window keeps its own remembered layout', (() => {
  try {
    return JSON.parse(globalThis.window.localStorage.getItem('dsh-plugin-poker/coach-window')).pinned === true;
  } catch (error) {
    return false;
  }
})(), 'window layout was not stored');
// Unpin from the freshly rendered tree, then check the window can move again.
const unpinWindow = walkAll(pinnedTree).find((node) => node.type === 'button' && flatten(node) === '\u{1F4CC}');
if (unpinWindow) unpinWindow.props.onClick();
check('unpinning releases the window', !classes(render(headerComponent, { sessionId: 'coach-session' })).includes('dshp-coachWinPinned'), 'still pinned');

// Dragging: press the title bar, move, release - the window follows and the new
// position is remembered. A pinned window refuses to move at all.
const dragTree = render(headerComponent, { sessionId: 'coach-session' });
const head = coachHead(dragTree);
const fakeWindowNode = {
  offsetWidth: 452,
  getBoundingClientRect: () => ({ left: 20, top: 68 }),
};
if (head) {
  head.props.onPointerDown({ currentTarget: { parentElement: fakeWindowNode }, clientX: 40, clientY: 80, button: 0, target: {} });
}
const moveListener = documentListeners('pointermove').pop();
check('pressing the title bar starts a drag', moveListener !== undefined, `${documentListeners('pointermove').length} move listeners`);
if (moveListener) moveListener({ clientX: 300, clientY: 220 });
const draggedTree = render(headerComponent, { sessionId: 'coach-session' });
const draggedWin = walkAll(draggedTree).find((node) => String(node.props && node.props.className || '').includes('dshp-coachWin'));
check('the window follows the pointer', draggedWin !== undefined && draggedWin.props.style.left === '280px' && draggedWin.props.style.top === '208px', JSON.stringify(draggedWin && draggedWin.props.style));
const upListener = documentListeners('pointerup').pop();
if (upListener) upListener({});
check('the new position is remembered', (() => {
  try {
    const stored = JSON.parse(globalThis.window.localStorage.getItem('dsh-plugin-poker/coach-window'));
    return stored.x === 280 && stored.y === 208;
  } catch (error) {
    return false;
  }
})(), 'position was not stored');
check('the two windows keep separate layouts', (() => {
  try {
    const stored = JSON.parse(globalThis.window.localStorage.getItem('dshp-plugin-poker/panel'));
    return stored === null || stored.x !== 280;
  } catch (error) {
    return true;
  }
})(), 'both windows share one layout');
// Pressing a title-bar button must not start a drag either: the buttons live in
// the same bar, so the press has to be told apart from a drag.
const moveCount = documentListeners('pointermove').length;
if (head) {
  head.props.onPointerDown({
    currentTarget: { parentElement: fakeWindowNode },
    clientX: 40,
    clientY: 80,
    button: 0,
    target: { closest: (selector) => (selector === 'button' ? {} : null) },
  });
}
check('a press on a title-bar button is not a drag', documentListeners('pointermove').length === moveCount, 'the button started a drag');

// A stored position from a bigger screen is pulled back into view.
globalThis.window.localStorage.setItem('dsh-plugin-poker/coach-window', JSON.stringify({ x: 99999, y: 99999, pinned: false }));
const clampedTree = render(headerComponent, { sessionId: 'coach-session' });
const clampedWin = walkAll(clampedTree).find((node) => String(node.props && node.props.className || '').includes('dshp-coachWin'));
check('an off-screen saved position is clamped back into view', clampedWin !== undefined
  && parseFloat(clampedWin.props.style.left) <= 1280 - 452 - 8
  && parseFloat(clampedWin.props.style.top) <= 800 - 80, JSON.stringify(clampedWin && clampedWin.props.style));
globalThis.window.localStorage.setItem('dsh-plugin-poker/coach-window', JSON.stringify({ x: null, y: null, pinned: false }));

// ---- opponents' moves are named on their own cards ------------------------

// The tile used to say "加注到 300" - the number, not the move. A seat that opens
// or 3-bets now wears the same word the raise button carries, so a learner can
// see who opened and who 3-bet without reading the log.
const termNames = checkedMeta.view.players.map((player) => player.name);
/** The poker term a seat wears, or null. */
function seatTermOf(tree, name) {
  const seats = walkAll(tree).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat'));
  const seat = seats.find((node) => flatten(walkAll(node).find((child) => String(child.props && child.props.className || '').includes('dshp-seatName'))) === name);
  if (!seat) return null;
  const pill = walkAll(seat).find((child) => String(child.props && child.props.className || '').split(' ').includes('dshp-seatTerm'));
  return pill ? flatten(pill) : null;
}
const openMeta = {
  ...checkedMeta,
  view: {
    ...checkedMeta.view,
    street: 'preflop',
    board: [],
    log: [
      '\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014',
      `${termNames[1]} \u52a0\u6ce8\u5230 300`,
      `${termNames[2]} \u52a0\u6ce8\u5230 900`,
    ],
  },
};
const openCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: openMeta, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
check('the first preflop raise is named open on its seat', seatTermOf(openCard, termNames[1]) === 'open', JSON.stringify(termNames.map((name) => `${name}:${seatTermOf(openCard, name)}`)));
check('the next preflop raise is named 3-bet on its seat', seatTermOf(openCard, termNames[2]) === '3-bet', JSON.stringify(termNames.map((name) => `${name}:${seatTermOf(openCard, name)}`)));
const raiseTerms = {
  ...checkedMeta,
  view: {
    ...checkedMeta.view,
    street: 'flop',
    board: ['5d', '2c', 'Kh'],
    log: [
      '\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014',
      '\u53d1\u724c\uff1a\u7ffb\u724c 5\u26662\u2663K\u2665',
      `${termNames[1]} \u8fc7\u724c`,
      `${termNames[2]} \u4e0b\u6ce8\u5230 600`,
      `${termNames[1]} \u52a0\u6ce8\u5230 1800`,
    ],
  },
};
const raiseCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: raiseTerms, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
check('a postflop bet is named on its seat', seatTermOf(raiseCard, termNames[2]) === 'bet', JSON.stringify(termNames.map((name) => `${name}:${seatTermOf(raiseCard, name)}`)));
check('a check-then-raise is named check-raise', seatTermOf(raiseCard, termNames[1]) === 'check-raise', JSON.stringify(termNames.map((name) => `${name}:${seatTermOf(raiseCard, name)}`)));
check('last street\u2019s raise is not left on the tile', seatTermOf(raiseCard, termNames[2]) !== 'open', String(seatTermOf(raiseCard, termNames[2])));

// ---- the centre column keeps its original order ---------------------------

// pot -> 需跟 -> board -> caption ("第 N 手 · 河牌"). The caption stays UNDER the
// board where it belongs; what keeps it off the hero's tile is the table's own
// padding (the room the seat tiles hang into), not a reordering.
const centreColumn = walkAll(card).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-center'));
const centreClasses = centreColumn ? centreColumn.children.map((child) => String(child.props && child.props.className || '')) : [];
const boardIndex = centreClasses.findIndex((name) => name.includes('dshp-boardRow'));
const captionIndex = centreClasses.map((name, index) => ({ name, index })).filter((entry) => entry.name.includes('dshp-street')).pop();
check('the caption sits under the board, as it always did', centreClasses.length >= 3
  && centreClasses[0].includes('dshp-pot') && boardIndex > 0 && captionIndex !== undefined && captionIndex.index === centreClasses.length - 1,
  centreClasses.join(' | '));

// ---- the hand log reads as a story ---------------------------------------

const logMeta = {
  ...checkedMeta,
  view: {
    ...checkedMeta.view,
    log: [
      '\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014',
      '\u5c0f\u7f8e \u4e0b\u5c0f\u76f2 50',
      '\u73a9\u5bb6 \u4e0b\u5927\u76f2 100',
      '\u77f3\u5934 \u52a0\u6ce8\u5230 350',
      '\u53d1\u724c\uff1a\u7ffb\u724c 5\u26662\u2663K\u2665',
      '\u5c0f\u7f8e \u4e0b\u6ce8\u5230 1800',
      '\u77f3\u5934 \u8ddf\u6ce8 1800\uff1a\u201c\u770b\u4e00\u773c\u4e0d\u4e8f\u201d',
      '\u53d1\u724c\uff1a\u8f6c\u724c 5\u26662\u2663K\u26659\u2660',
      '\u5c0f\u7f8e \u5168\u4e0b\u5230 791',
      '\u644a\u724c \u77f3\u5934\uff1a\u4e00\u5bf9 9 (One Pair)',
      '\u5c0f\u7f8e \u4ee5\u4e00\u5bf9 9 (One Pair) \u8d62\u4e0b 16582',
    ],
  },
};
const logCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: logMeta, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
const logFlat = walkAll(logCard);
const logBlocks = logFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-logBlock'));
check('the log splits into street blocks', logBlocks.length === 4, `got ${logBlocks.length}`);
check('each block is titled', logFlat.some((node) => String(node.props && node.props.className || '').includes('dshp-logHead') && flatten(node).includes('\u53d1\u724c \u00b7 \u7ffb\u724c')), logFlat.filter((node) => String(node.props.className || '').includes('dshp-logHead')).map((node) => flatten(node)).join(' | '));
check('the dealt board travels with the block', flatten(logCard).includes('5\u26662\u2663K\u2665'), flatten(logCard).slice(-160));
const logRows = logFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-logRow'));
check('every action is one row', logRows.length === 8, `got ${logRows.length}`);
check('the actor is split from the action', logRows.some((node) => flatten(node).includes('\u77f3\u5934') && flatten(node).includes('\u52a0\u6ce8\u5230 350')), logRows.map((node) => flatten(node)).join(' | '));
const talkRows = logFlat.filter((node) => String(node.props && node.props.className || '').includes('dshp-logTalk'));
check('table talk is set apart', talkRows.length === 1 && flatten(talkRows[0]).includes('\u770b\u4e00\u773c\u4e0d\u4e8f'), logRows.map((node) => flatten(node)).join(' | '));
const showdownRows = logFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-logShow'));
check('showdown rows are marked', showdownRows.length === 1 && flatten(showdownRows[0]).includes('\u4e00\u5bf9 9'), logRows.map((node) => flatten(node)).join(' | '));
const plainLogView = { ...checkedMeta.view, log: [] };
const plainLogCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: { ...checkedMeta, view: plainLogView }, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
check('a view without a log shows no log column', !classes(plainLogCard).includes('dshp-log'), classes(plainLogCard).filter((name) => name.startsWith('dshp-log')).join(','));

// ---- the table itself: players, positions, dealer, pot --------------------

// Every seat is a player card: a face for the personality, a name, and the
// position it is sitting in.
const flatSeats = walkAll(card).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat'));
const avatars = flatSeats.map((node) => walkAll(node).find((child) => String(child.props && child.props.className || '').includes('dshp-avatar')));
check('every seat has an avatar', avatars.length === checkedMeta.view.players.length && avatars.every((node) => node !== undefined), String(avatars.filter(Boolean).length));
const heroAvatar = walkAll(heroSeat).find((node) => String(node.props && node.props.className || '').includes('dshp-avatar'));
check('the hero avatar is the person, not a personality', heroAvatar !== undefined && flatten(heroAvatar) === '\u{1F9D1}', JSON.stringify(flatten(heroAvatar)));
const botAvatars = flatSeats
  .filter((node) => node.props['data-human'] !== 'true')
  .map((node) => ({ style: node.props['data-style'], face: flatten(walkAll(node).find((child) => String(child.props && child.props.className || '').includes('dshp-avatar'))) }));
check('opponents wear their personality', botAvatars.length > 0 && botAvatars.every((entry) => entry.face.length > 0 && entry.face !== '\u{1F9D1}'), JSON.stringify(botAvatars));

const positionPills = walkAll(card).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-pos'));
check('every seat names its position', positionPills.length === checkedMeta.view.players.length, `${positionPills.length} pills for ${checkedMeta.view.players.length} seats`);
const pillTexts = positionPills.map((node) => flatten(node)).sort();
check('the positions are the real ones for this table', JSON.stringify(pillTexts) === JSON.stringify(['BB', 'BTN', 'SB']), JSON.stringify(pillTexts));
const buttonSeatNode = flatSeats.find((node) => Number(node.props['data-seat']) === checkedMeta.view.buttonSeat);
check('the button seat is the one wearing BTN', buttonSeatNode !== undefined && String(buttonSeatNode.props['data-position']).startsWith('BTN'), JSON.stringify(flatSeats.map((node) => node.props['data-seat'] + ':' + node.props['data-position'])));

const dealerChip = walkAll(card).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-dealer'));
// The button is drawn on its OWNER's card, always in the same corner, so the eye
// finds it without hunting and nothing floats in the middle of the felt.
check('the dealer button belongs to one seat', dealerChip.length === 1, `${dealerChip.length} chips`);
const dealerSeat = flatSeats.find((node) => walkAll(node).some((child) => String(child.props && child.props.className || '').includes('dshp-dealer')));
check('the dealer button is on the button seat', dealerSeat !== undefined && Number(dealerSeat.props['data-seat']) === checkedMeta.view.buttonSeat,
  JSON.stringify(flatSeats.map((node) => `${node.props['data-seat']}:${node.props['data-dealer'] || '-'}`)));
check('the dealer button is pinned to the tile corner', dealerSeat !== undefined && dealerSeat.props['data-dealer'] === 'yes'
  && dealerChip[0].props.className === 'dshp-dealer'
  && /\.dshp-dealer\{[^}]*top:-\d+px[^}]*left:-\d+px/.test(sheet),
  `${dealerSeat && dealerSeat.props['data-dealer']} / ${dealerChip[0].props.className}`);
check('no seat without the button wears a chip', flatSeats.every((node) => (Number(node.props['data-seat']) === checkedMeta.view.buttonSeat) === (String(node.props['data-dealer']).length > 0)),
  flatSeats.map((node) => node.props['data-dealer']).join('|'));
check('the felt is dressed', walkAll(card).some((node) => String(node.props && node.props.className || '').includes('dshp-feltMark')) && walkAll(card).some((node) => String(node.props && node.props.className || '').includes('dshp-feltLine')), 'no felt dressing');
const potStack = walkAll(card).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-chip'));
check('the pot is drawn as chips', potStack.length === 4, `${potStack.length} discs`);
// A STACK, read the way a stack looks from the table: one face on top, the rims
// of the chips under it showing a few pixels each. Two earlier attempts scattered
// discs flat on top of each other and both read as a single blob.
const chipStack = potStack.map((node) => ({
  cls: String(node.props.className),
  x: parseFloat(node.props.style.left),
  y: parseFloat(node.props.style.top),
}));
const face = chipStack.filter((entry) => entry.cls.includes('dshp-chipTop'));
const rims = chipStack.filter((entry) => !entry.cls.includes('dshp-chipTop'));
const rimH = Number((/\.dshp-chip\{[^}]*height:(\d+)px/.exec(sheet) || [])[1]);
const faceH = Number((/\.dshp-chipTop\{[^}]*height:(\d+)px/.exec(sheet) || [])[1]);
const boxH = Number((/\.dshp-potStack\{[^}]*height:(\d+)px/.exec(sheet) || [])[1]);
const steps = rims.slice(1).map((entry, index) => Math.abs(entry.y - rims[index].y));
// Rims are listed bottom-first: the top one is the last, and the chip above it is
// the face. Its visible band is what is left below the face's bottom edge.
const topRim = rims[rims.length - 1];
const bottomRim = rims[0];
const band = Math.min(...steps, topRim.y + rimH - faceH);
check('the pot chips are a stack, not a scatter', face.length === 1 && rims.length === 3
  && rims.every((entry) => Math.abs(entry.x - face[0].x) <= 1)
  && steps.every((step) => step === steps[0])
  // Every rim shows the same band, and that band is a real slice of a chip: not
  // so small the chip vanishes, not so large the stack comes apart.
  && band === steps[0] && band >= 3 && band <= rimH
  && face[0].y < topRim.y
  // The whole stack has to fit the box it is drawn in.
  && bottomRim.y + rimH <= boxH,
  JSON.stringify({ chipStack, steps, band, rimH, faceH, boxH }));
// The face is a full circle, the rims are the flat ellipses of a stack seen from
// the side; the CSS says so, and the test reads the CSS rather than trusting it.
check('the top chip shows its face and the rest show rims', /\.dshp-chipTop\{[^}]*width:18px;height:18px/.test(sheet)
  && /\.dshp-chip\{[^}]*height:6px;border-radius:50%/.test(sheet)
  && /\.dshp-chipTop\{[^}]*repeating-conic-gradient/.test(sheet), 'the stack lost its shape');
check('the pile uses more than one denomination', new Set(chipStack.map((entry) => entry.cls.replace('dshp-chip ', '').split(' ')[0])).size >= 3,
  chipStack.map((entry) => entry.cls).join(' | '));

// The board is grouped by street: a gap before the turn and before the river.
const boardRowNode = walkAll(card).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-boardRow'));
const boardCardsOut = boardRowNode ? walkAll(boardRowNode).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-card')) : [];
const gapped = boardCardsOut.map((node, index) => ({ index, gap: String(node.props.className).includes('dshp-boardGap') })).filter((entry) => entry.gap);
check(
  'the turn and river are set apart from the flop',
  boardCardsOut.length >= 3 && gapped.length === Math.max(0, Number(checkedMeta.view.board.length) - 3) && gapped.every((entry) => entry.index >= 3),
  JSON.stringify({ cards: boardCardsOut.length, board: checkedMeta.view.board.length, gapped }),
);
// A real table shows empty felt until the cards land: the board is the cards that
// are OUT, never a row of dashed slots waiting for the turn and the river.
const flopOnly = render(cardComponent, {
  block: { kind: 'tool-result', meta: { ...checkedMeta, view: { ...checkedMeta.view, board: checkedMeta.view.board.slice(0, 3) } }, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
const flopRow = walkAll(flopOnly).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-boardRow'));
const flopCards = flopRow ? walkAll(flopRow).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-card')) : [];
check('the flop is three cards and nothing else', flopCards.length === 3
  && flopCards.every((node) => !String(node.props.className).includes('dshp-cardEmpty'))
  && !classes(flopOnly).includes('dshp-cardEmpty'), `${flopCards.length} cards, ${classes(flopOnly).filter((name) => name === 'dshp-cardEmpty').length} empty slots`);

// Hovering a seat reveals the coach's read of that player.
const realReads = (checkedMeta.view.coach.sections.find((section) => section.id === 'reads') || {}).items || [];
const readTooltips = flatSeats.map((node) => ({ node, tip: walkAll(node).find((child) => String(child.props && child.props.className || '').includes('dshp-seatRead')) }));
check('the coach read is attached to the player it is about', readTooltips.filter((entry) => entry.tip !== undefined).length === realReads.length, `${readTooltips.filter((entry) => entry.tip).length} tooltips for ${realReads.length} reads`);
check('the read tooltip carries the reading', readTooltips.some((entry) => entry.tip !== undefined && flatten(entry.tip).includes('\u8303\u56f4\u5bbd\u5ea6')), JSON.stringify(readTooltips.map((entry) => entry.tip && flatten(entry.tip).slice(0, 40))));
check('the hero has no read tooltip', (readTooltips.find((entry) => entry.node.props['data-human'] === 'true') || {}).tip === undefined, 'the hero got a read');

// ---- BB is shown next to the chips everywhere it matters ------------------

check('stacks carry a BB equivalent', (cardText.match(/BB/g) || []).length >= checkedMeta.view.players.length, cardText.slice(0, 200));
check('the pot carries a BB equivalent', new RegExp(bbOf(checkedMeta.view.pot)).test(cardText), `pot ${checkedMeta.view.pot} -> ${bbOf(checkedMeta.view.pot)}BB missing`);

/** The BB label the card should print for one chip amount. */
function bbOf(amount) {
  const value = Math.round((Number(amount) / Number(checkedMeta.view.bigBlind)) * 10) / 10;
  return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + 'BB';
}

// ---- the bet-sizing coach ------------------------------------------------

// One walk: the size presets and the amount box they fill must come from the
// same render, or the closures would not agree.
const flatCard = walkAll(card);
const coach = flatCard.find((node) => String(node.props && node.props.className || '').includes('dshp-coach'));
check('the sizing coach appears when a size must be chosen', coach !== undefined, cardText.slice(0, 200));
const sizeButtons = flatCard.filter((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-size'));
check('the coach offers the standard sizes', sizeButtons.length === 4, `got ${sizeButtons.length}`);
check('every size shows its chips and BB', sizeButtons.length === 4 && sizeButtons.every((button) => /BB/.test(flatten(button))), sizeButtons.map((button) => flatten(button)).join(' | '));
check('every size explains what it is for', sizeButtons.length === 4 && sizeButtons.every((button) => /\u6c60/.test(flatten(button))) && sizeButtons.every((button) => typeof button.props.title === 'string' && button.props.title.length > 8), sizeButtons.map((button) => flatten(button)).join(' | '));
check('the coach reads the board texture', /\u5e72\u71e5\u9762|\u6e7f\u9762|\u540c\u82b1\u9762|\u8fde\u63a5\u9762|\u516c\u5bf9\u9762|\u724c\u684c/.test(flatten(coach)), flatten(coach).slice(0, 220));
// The board read and its advice moved into the teaching window: this row only
// sizes a bet, so it must not carry coaching prose any more.
check('the sizing helper leaves the coaching to the coach window', !flatten(coach).includes('\u724c\u9762\uff1a') && !walkAll(coach).some((node) => String(node.props.className || '').includes('dshp-tip')), flatten(coach).slice(0, 220));
// No "开池 style label in the sizing helper either: the term rides on the
// commit button and the analysis lives in the teaching window.
check('the sizing helper carries no term label', !walkAll(coach).some((node) => String(node.props.className || '').includes('dshp-tag')), walkAll(coach).map((node) => String(node.props.className || '')).join(' | '));
const allInButton = flatCard.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnAllIn'));
check('the all-in button wears its own colour', allInButton !== undefined, flatCard.filter((node) => node.type === 'button').map((node) => String(node.props.className || '')).join(' | '));
check('the coach states the blind so BB is learnable', /1BB = /.test(flatten(coach)), flatten(coach).slice(0, 220));

submitted = null;
fetchRequests.length = 0;
const amountBox = flatCard.find((node) => node.type === 'input');
const boxNode = { value: '' };
// React attaches refs at mount; the harness does it by hand.
if (amountBox && typeof amountBox.props.ref === 'function') amountBox.props.ref(boxNode);
if (sizeButtons.length > 0) sizeButtons[0].props.onClick();
check('a size preset only fills the box', fetchRequests.length === 0 && submitted === null, `requests=${fetchRequests.length} prompt=${JSON.stringify(submitted)}`);
check('a size preset writes the amount into the box', Number(boxNode.value) > 0, boxNode.value);
const legalNow = checkedMeta.view.legal;
const expectedThirdPot = Math.min(legalNow.maxRaiseTo, Math.max(legalNow.minRaiseTo, Math.round(Number(checkedMeta.view.pot) / 3)));
check('the 1/3-pot preset is a third of the pot', Number(boxNode.value) === expectedThirdPot, `${boxNode.value} vs ${expectedThirdPot}`);
check('sizes are pot-relative, not stacked on the minimum raise', expectedThirdPot < legalNow.minRaiseTo + Number(checkedMeta.view.pot) / 3, String(expectedThirdPot));

// ---- the amount box speaks both chips and BB ------------------------------

const bbBoxNode = { value: '' };
const bbInput = flatCard.find((node) => node.type === 'input' && String(node.props.className || '').includes('dshp-inputBB'));
check('the raise box steps by one big blind', amountBox !== undefined && Number(amountBox.props.step) === Number(checkedMeta.view.bigBlind), `${amountBox && amountBox.props.step} vs ${checkedMeta.view.bigBlind}`);
check('there is a second box for BB', bbInput !== undefined && typeof bbInput.props.ref === 'function', 'the BB box is missing');
if (bbInput && typeof bbInput.props.ref === 'function') bbInput.props.ref(bbBoxNode);
if (sizeButtons.length > 1) sizeButtons[1].props.onClick();
// The chips box is authoritative; the BB box shows the same size to one decimal,
// so half of an odd pot (63 chips = 1.26BB) legitimately displays as 1.3.
check(
  'picking a size keeps both boxes in step',
  Number(bbBoxNode.value) > 0 && Math.abs(Number(bbBoxNode.value) * Number(checkedMeta.view.bigBlind) - Number(boxNode.value)) <= 0.05 * Number(checkedMeta.view.bigBlind) + 0.5,
  `bb=${bbBoxNode.value} chips=${boxNode.value}`,
);
// Typing BB must drive the chips box - the unit players actually think in.
bbBoxNode.value = '3';
if (bbInput) bbInput.props.onChange();
check('typing a BB amount writes the chip amount', Number(boxNode.value) === 3 * Number(checkedMeta.view.bigBlind), `${boxNode.value} vs ${3 * checkedMeta.view.bigBlind}`);

// ---- the amount is also shown as a share of the pot ------------------------

const shareText = { textContent: '' };
const shareSpan = flatCard.find((node) => node.type === 'span' && String(node.props && node.props.className || '').includes('dshp-potShare'));
check('the sizing row reports the pot share', shareSpan !== undefined, 'no pot-share readout');
if (shareSpan) shareSpan.props.ref(shareText);
if (sizeButtons.length > 3) sizeButtons[3].props.onClick();
check('the readout names the unit', /\u6c60/.test(shareText.textContent), shareText.textContent);
const potNow = Number(checkedMeta.view.pot);
const currentNow = Number(checkedMeta.view.currentBet);
const expectedShare = currentNow === 0 ? boxNode.value / potNow : (boxNode.value - currentNow) / (potNow + Number(checkedMeta.view.legal.toCall));
check(
  'a preset updates the pot share',
  Math.abs(Number((shareText.textContent.match(/([\d.]+)\s*\u6c60/) || [])[1]) - expectedShare) < 0.02,
  `${shareText.textContent} vs expected ${Math.round(expectedShare * 100) / 100}`,
);
bbBoxNode.value = '3';
if (bbInput) bbInput.props.onChange();
check(
  'typing BB updates the pot share too',
  /\u6c60/.test(shareText.textContent) && !/\u2014/.test(shareText.textContent),
  shareText.textContent,
);

// ---- the action area names each move in poker terms ------------------------

check('the hand-holding hint is gone', !/\u70b9\u5c3a\u5bf8\u53ea\u4f1a\u586b\u5165\u91d1\u989d\u6846/.test(flatten(coach)), flatten(coach).slice(0, 240));
// Action buttons stack their term (and BB) on a second, dimmer line, which is
// what keeps them narrow enough to sit side by side in a squeezed panel.
const subText = flatCard
  .filter((node) => String(node.props && node.props.className || '').includes('dshp-btnSub'))
  .map((node) => flatten(node));
check('every action button carries its term', ['check', 'all-in', 'fold'].every((term) => subText.some((line) => line.includes(term))), subText.join(' | '));
check('the BB rides along on the buttons', subText.some((line) => /BB/.test(line)), subText.join(' | '));
check('the raise is named for the spot', subText.includes('bet'), subText.join(' | '));
check('the coach repeats the raise name', /\u4e0b\u6ce8|\u52a0\u6ce8|open|3-bet|check-raise/.test(flatten(coach)), flatten(coach).slice(0, 200));

// Preflop, facing the blinds: the buttons must read call, and the raise is an
// `open` - the exact vocabulary a learner needs to see.
const preflopBlock = { kind: 'tool-result', meta: openedMeta, content: [{ type: 'text', text: opened.text }], call: { name: 'poker_new_table', argsRaw: '{}' } };
const preflopCard = render(cardComponent, { block: preflopBlock, sessionId: session.id, toolName: 'poker_action' });
const preflopFlat = walkAll(preflopCard);
const preflopSubs = preflopFlat
  .filter((node) => String(node.props && node.props.className || '').includes('dshp-btnSub'))
  .map((node) => flatten(node));
check('a call button carries its term', preflopSubs.some((line) => line.includes('call')), preflopSubs.join(' | '));
check('an opening raise is labelled open', preflopSubs.includes('open'), preflopSubs.join(' | '));
// The card no longer carries the analysis (that is its own window now), but it
// does repeat the host's one-line recommendation above the buttons.
const preflopAdvice = openedMeta.view.coach && openedMeta.view.coach.plan ? openedMeta.view.coach.plan.headline : null;
check('the preflop card repeats the host recommendation', preflopAdvice !== null && flatten(preflopCard).includes('\u6559\u7ec3\u5efa\u8bae') && flatten(preflopCard).includes(preflopAdvice), `${preflopAdvice} :: ${flatten(preflopCard).slice(-200)}`);
check('the opening raise explains itself', preflopFlat.some((node) => typeof node.props.title === 'string' && /\u5f00\u6c60 open/.test(node.props.title)), 'no open explanation');

// The commit button follows whatever the boxes hold, updated straight in the DOM.
// The verb and the amount are separate nodes so a long amount can wrap onto its
// own line instead of being cut off ("加注到 1,..."), and the AMOUNT is the one
// the sizing controls drive.
const commitText = { textContent: '' };
const commitSpan = flatCard.find((node) => typeof node.props.ref === 'function' && String(node.props.className || '').includes('dshp-commitAmount'));
check('the commit button exposes its amount', commitSpan !== undefined, 'no ref-carrying amount span');
if (commitSpan) commitSpan.props.ref(commitText);
if (sizeButtons.length > 2) sizeButtons[2].props.onClick();
check('the commit label follows the chosen size', commitText.textContent.includes(boxNode.value), `${commitText.textContent} vs ${boxNode.value}`);

const clearButton = flatCard.find((node) => node.type === 'button' && flatten(node) === '\u21ba');
check('the amount box has a reset key', clearButton !== undefined, 'no reset key');
const sizingRow = flatCard.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-raise'));
check('the reset key sits on the left of the sizing row', sizingRow !== undefined && sizingRow.children[0] === clearButton, sizingRow ? flatten(sizingRow.children[0]) : 'no sizing row');
if (clearButton) clearButton.props.onClick();
check('the reset key empties the chip box', boxNode.value === '', JSON.stringify(boxNode.value));
check('the reset key empties the BB box', bbBoxNode.value === '', JSON.stringify(bbBoxNode.value));
check('resetting leaves the commit button usable', /\d/.test(commitText.textContent), commitText.textContent);

// The commit button belongs to the action row (left of fold) and points down at
// the sizing row it drives.
const commitButtonNode = flatCard.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnCommit'));
check('the raise commit sits in the action row', commitButtonNode !== undefined, 'no commit button in the row');
const buttonRow = flatCard.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-btnRow'));
if (buttonRow) {
  const classesInRow = buttonRow.children.map((child) => String(child.props && child.props.className || ''));
  const commitIndex = classesInRow.findIndex((name) => name.includes('dshp-btnCommit'));
  const foldIndex = classesInRow.findIndex((name) => name.includes('dshp-btnDanger'));
  check('the commit stands immediately left of fold', commitIndex >= 0 && foldIndex === commitIndex + 1, classesInRow.join(' | '));
}

// The check button used to be the same grey as the sizing presets right below
// it, so the two rows looked like one control group.
check('the check button has a colour of its own', /\.dshp-btnCheck\{[^}]*background:#0f8f86[^}]*color:#fff/.test(sheet)
  && /\.dshp-btnCheck:hover\{/.test(sheet), 'check is still the preset grey');
check('checking is not styled like a sizing preset', /className: 'dshp-btn dshp-btnCheck'/.test(fs.readFileSync(local('../lib/client.js'), 'utf8')),
  'the check button lost its class');

// ---- the sizing maths, spelled out -----------------------------------------

// This fixture is an OPENING spot preflop, where the pot IS the two blinds (75) and
// the minimum raise (100 = 2BB) is already 1.33 pots. Pot fractions therefore all
// collapse onto the minimum - four identical buttons, which is what made the first
// bet of every hand look broken - so preflop and any collapsed spot size in BLINDS
// instead, the way an open is actually chosen.
const preflopSizes = preflopFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-size'));
const sizeTexts = preflopSizes.map((node) => flatten(node));
const sizeTitles = preflopSizes.map((node) => String(node.props.title || ''));
check('a preflop open is sized in big blinds',
  preflopSizes.length === 4
    && ['2.5BB', '3BB', '4BB', '6BB'].every((name, index) => sizeTitles[index].startsWith(name))
    && sizeTitles.every((title) => title.includes('\u4e00\u4e2a\u5927\u76f2 50')),
  sizeTitles.join(' || '));
check('the blind-sized presets are four different numbers',
  new Set(sizeTexts.map((text) => (text.match(/^[\d,]+/) || [])[0])).size === 4,
  sizeTexts.join(' | '));
check('a blind-sized preset still says how many pots it is',
  sizeTitles.every((title) => /\u6c60/.test(title)),
  sizeTitles[0]);
const shareLabel = preflopFlat.find((node) => String(node.props && node.props.className || '').includes('dshp-potShare'));
// The READOUT stays pot-relative (that is the number players compare across
// streets): the minimum raise is 100 against a pot of 75, so 100 / 75 = 1.33 pots.
check('the pot-share readout measures an open against the pot before it',
  shareLabel !== undefined && flatten(shareLabel) === '\u2248 1.33 \u6c60'
  && String(shareLabel.props.title).includes('\u4e0b\u6ce8\u524d\u5e95\u6c60'),
  shareLabel ? `${flatten(shareLabel)} :: ${shareLabel.props.title}` : 'no readout');

// The reader's own example: a 1.5BB pot (150) and a 2BB open (200) is 1.33 pots,
// NOT 0.4 - the old code measured it against the pot after a call, which made an
// opening raise look smaller than a third of the pot.
const openSpot = {
  ...checkedMeta,
  view: {
    ...checkedMeta.view,
    street: 'preflop',
    board: [],
    pot: 150,
    currentBet: 100,
    smallBlind: 50,
    bigBlind: 100,
    legal: { ...checkedMeta.view.legal, canCheck: false, canCall: true, canRaise: true, canAllIn: true, toCall: 100, callAmount: 100, currentBet: 100, minRaiseTo: 200, maxRaiseTo: 10000 },
    log: ['\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014', '\u8001\u738b \u4e0b\u5c0f\u76f2 50', '\u73a9\u5bb6 \u4e0b\u5927\u76f2 100'],
  },
};
const openPotCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: openSpot, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
const openFlat = walkAll(openPotCard);
const openShare = openFlat.find((node) => String(node.props && node.props.className || '').includes('dshp-potShare'));
check('the reader\u2019s own example: 2BB into 1.5BB is 1.33 pots',
  openShare !== undefined && flatten(openShare) === '\u2248 1.33 \u6c60', openShare ? flatten(openShare) : 'no readout');
const openPresets = openFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-size'));
// The pot is 150 (1.5BB) and the minimum raise is 200 (2BB): an opening raise here
// is priced in blinds, and each preset is a distinct whole multiple of the blind.
check('the opening presets in a 1.5BB pot are blind multiples', openPresets.length === 4
  && openPresets.every((node) => String(node.props.title).includes('\u4e00\u4e2a\u5927\u76f2 100'))
  && flatten(openPresets[0]).includes('250')
  && flatten(openPresets[1]).includes('300'),
  openPresets.map((node) => flatten(node)).join(' | '));
// A RAISE (someone has bet) is measured against the pot after the call: the classic
// pot-sized raise. The fixture is POSTFLOP, because preflop raises are named in
// multiples of the bet being raised instead.
const raiseSpot = {
  ...openSpot,
  view: {
    ...openSpot.view,
    street: 'flop',
    streetLabel: '\u7ffb\u724c',
    board: ['Ah', 'Kd', '7c'],
    pot: 450,
    currentBet: 300,
    legal: { ...openSpot.view.legal, toCall: 300, callAmount: 300, currentBet: 300, minRaiseTo: 500, maxRaiseTo: 10000 },
    log: ['\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014', '\u53d1\u724c\uff1a\u7ffb\u724c A\u2665 K\u2666 7\u2663', '\u77f3\u5934 \u4e0b\u6ce8\u5230 300'],
  },
};
const raiseSpotCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: raiseSpot, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
const raiseFlat = walkAll(raiseSpotCard);
const raisePresets = raiseFlat.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-size'));
check('a postflop raise is measured against the pot after the call', raisePresets.length === 4
  && flatten(raisePresets[3]).includes('1,050')
  && String(raisePresets[3].props.title).includes('\u8ddf\u6ce8\u540e\u5e95\u6c60 750')
  && String(raisePresets[3].props.title).includes('1 \u6c60'),
  raisePresets.map((node) => flatten(node)).join(' | '));
check('the raise readout uses the same base', (() => {
  const node = raiseFlat.find((child) => String(child.props && child.props.className || '').includes('dshp-potShare'));
  return node !== undefined && flatten(node) === '\u2248 0.27 \u6c60' && String(node.props.title).includes('\u8ddf\u6ce8\u540e\u5e95\u6c60');
})(), 'the raise readout disagrees with the presets');

// A PREFLOP raise is the other vocabulary: three times the bet you are raising.
const preflopRaise = {
  ...openSpot,
  view: {
    ...openSpot.view,
    street: 'preflop',
    pot: 450,
    currentBet: 300,
    legal: { ...openSpot.view.legal, toCall: 200, callAmount: 200, currentBet: 300, minRaiseTo: 500, maxRaiseTo: 10000 },
    log: ['\u2014\u2014 \u7b2c 1 \u624b\u724c\u5f00\u59cb\u2014\u2014', '\u8001\u738b \u4e0b\u5c0f\u76f2 50', '\u73a9\u5bb6 \u4e0b\u5927\u76f2 100', '\u77f3\u5934 \u52a0\u6ce8\u5230 300'],
  },
};
const preflopRaiseCard = render(cardComponent, {
  block: { kind: 'tool-result', meta: preflopRaise, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
const preflopRaisePresets = walkAll(preflopRaiseCard).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-size'));
check('a preflop raise is priced in multiples of the bet being raised',
  preflopRaisePresets.length === 4
    && flatten(preflopRaisePresets[1]).includes('900')
    && String(preflopRaisePresets[1].props.title).includes('3 \u500d')
    && String(preflopRaisePresets[1].props.title).includes('\u5f53\u524d\u4e0b\u6ce8 300'),
  preflopRaisePresets.map((node) => flatten(node)).join(' | '));

// 需跟 belongs directly under the hand caption.
const preflopCentre = walkAll(preflopCard).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-center'));
const preflopCentreChildren = preflopCentre ? preflopCentre.children.map((child) => flatten(child)) : [];
check('需跟 sits under the hand caption', preflopCentreChildren.length >= 3
  && /^\u7b2c \d+ \u624b/.test(preflopCentreChildren[preflopCentreChildren.length - 2])
  && preflopCentreChildren[preflopCentreChildren.length - 1].startsWith('\u9700\u8ddf'),
  preflopCentreChildren.join(' | '));

// ...and it is the HERO's own call, so it goes away once they have matched the
// price. Reading `currentBet` showed the hero their own bet back as "需跟 200".
const owedView = {
  ...checkedMeta.view,
  board: ['9h', 'Kd', '2c'],
  street: 'flop',
  streetLabel: '\u7ffb\u724c',
  pot: 900,
  currentBet: 200,
  players: checkedMeta.view.players.map((player) => (player.isHuman
    ? { ...player, streetCommitted: 200, lastAction: '\u4e0b\u6ce8\u5230 200', hand: '\u4e00\u5bf9 9 (One Pair)' }
    : { ...player, streetCommitted: 300 })),
};
const settledCentre = walkAll(render(cardComponent, {
  block: { kind: 'tool-result', meta: { ...checkedMeta, view: owedView }, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
})).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-center'));
const settledLines = settledCentre ? settledCentre.children.map((child) => flatten(child)) : [];
check('a hero who has matched the bet is not told to call it again',
  !settledLines.some((line) => line.startsWith('\u9700\u8ddf')),
  settledLines.join(' | '));
const raisedView = { ...owedView, currentBet: 400 };
const raisedCentre = walkAll(render(cardComponent, {
  block: { kind: 'tool-result', meta: { ...checkedMeta, view: raisedView }, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
})).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-center'));
const raisedLines = raisedCentre ? raisedCentre.children.map((child) => flatten(child)) : [];
check('a re-raise shows only what the hero actually owes',
  raisedLines.some((line) => line.startsWith('\u9700\u8ddf 200')),
  raisedLines.join(' | '));

// The centre column has to fit BETWEEN the top tile and the hero's, which grows
// rows as the hand goes on: a tall hero tile (status + made hand + win badge) must
// still clear it, or the caption is painted over - which is what happened.
check('the centre column reserves room for a tall hero tile',
  /\.dshp-center\{[^}]*top:47%/.test(sheet) && /\.dshp-center\{[^}]*gap:4px/.test(sheet),
  'the centre column still sits low enough to collide');
check('the seats ride near the rail so the middle stays clear',
  /const radiusY = dense \? 48 : 49;/.test(fs.readFileSync(local('../lib/client.js'), 'utf8')),
  'the vertical seat radius was reduced again');

// ---- every action button is the same size, and labels wrap -----------------

// The commit button used to be 1.5x wide, which made the row look ragged; all
// four share the row evenly now.
check('every action button is the same width', /\.dshp-btn\{[^}]*flex:1 1 0/.test(sheet)
  && !/\.dshp-btnCommit\{[^}]*flex:/.test(sheet) && !/\.dshp-btn\w*\{[^}]*flex:(?!1 1 0)[\d.]/.test(sheet.replace(/\.dshp-btnSub[^}]*\}/g, '')),
  'a button still has its own width');
// A label that does not fit WRAPS: both lines are lists of whole pieces, so
// "全下 8,0..." becomes "全下" / "8,025" on two lines instead of an ellipsis.
check('button labels wrap instead of being cut off', /\.dshp-btnMain\{[^}]*flex-wrap:wrap/.test(sheet)
  && /\.dshp-btnSub\{[^}]*flex-wrap:wrap/.test(sheet)
  && !/\.dshp-btnMain\{[^}]*text-overflow:ellipsis/.test(sheet)
  && !/\.dshp-btnSub\{[^}]*text-overflow:ellipsis/.test(sheet), 'a label is still truncated');
// The pieces really are separate elements: the call button's line is 跟注 + amount.
const callButton = [card, preflopCard].map((tree) => walkAll(tree).find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnPrimary'))).find(Boolean);
const callMain = callButton ? callButton.children.find((child) => String(child.props && child.props.className || '').includes('dshp-btnMain')) : null;
check('a button label is a list of whole pieces', Boolean(callMain) && Array.isArray(callMain.children)
  && callMain.children.length >= 2 && flatten(callMain).includes('\u8ddf\u6ce8'), callMain ? flatten(callMain) : 'no call button');

// ---- the panel keeps its original width -----------------------------------

// The player asked for VERTICAL room, not a wider page: the panel stays 660px
// and the table keeps its thin rail; the room comes from the table's margin.
check('the panel keeps its 660px width', /\.dshp-panel\{[^}]*width:660px/.test(sheet), 'the panel got wider again');
// The panel is a column: the table keeps its size and the BOTTOM gives way, so
// the felt stays put while the reader scrolls inside the two bottom columns.
check('the table holds still while the reader scrolls', /\.dshp-panel\{[^}]*display:flex;flex-direction:column/.test(sheet)
  && /\.dshp-table\{[^}]*flex:none/.test(sheet)
  && /\.dshp-bottom\{[^}]*min-height:150px;max-height:236px/.test(sheet)
  && /\.dshp-main,\.dshp-side\{[^}]*overflow-y:auto/.test(sheet)
  // One scroller per column: the log no longer scrolls inside the log.
  && !/\.dshp-log\{[^}]*overflow-y:auto/.test(sheet), 'the felt can still be squashed or scrolled away');
// A full ring needs a taller felt, so the tiles hang out of it less.
check('a full ring tightens its vertical margins', /\.dshp-table\[data-seats="9"\]\{margin:(\d+)px 0 (\d+)px\}/.test(sheet)
  && /\.dshp-table\[data-seats="7"\],\.dshp-table\[data-seats="8"\]\{margin:/.test(sheet), 'the 9-max table keeps the roomy margins');
// The columns scroll on a SLIM bar that hides until you point at the column: a
// module should read as content, not as a box with a track down its side.
check('the bottom columns scroll on a slim bar', /\.dshp-main,\.dshp-side\{[^}]*scrollbar-width:thin/.test(sheet)
  && /\.dshp-main::-webkit-scrollbar,\.dshp-side::-webkit-scrollbar[^{]*\{width:6px/.test(sheet)
  && !/\.dshp-main\{[^}]*padding:9px/.test(sheet), 'the bottom columns are still cramped or use a fat scrollbar');
// The thumb shows only while the pointer is on the BAR itself: hovering the
// column's content must not draw it.
check('the scrollbar only shows when the bar itself is hovered',
  /\.dshp-main,\.dshp-side\{[^}]*scrollbar-color:transparent transparent/.test(sheet)
  && /\.dshp-main::-webkit-scrollbar-thumb,\.dshp-side::-webkit-scrollbar-thumb[^{]*\{background:transparent/.test(sheet)
  && /scrollbar-thumb:hover[^{]*\{background:rgba\(127,127,127,\.6\)/.test(sheet)
  && /scrollbar-thumb:active[^{]*\{background:rgba\(127,127,127,\.85\)/.test(sheet)
  && !/\.dshp-main:hover::-webkit-scrollbar-thumb/.test(sheet), 'the bar is drawn on column hover or never');
// The amount fields are compact, but the native steppers stay: the arrows walk in
// whole big blinds, so they are a control the player actually uses.
check('the amount fields are compact but keep their steppers',
  /\.dshp-input\{[^}]*box-sizing:border-box;flex:0 1 84px/.test(sheet)
  && /\.dshp-inputBB\{flex:0 1 66px/.test(sheet)
  && !/-webkit-inner-spin-button[^{]*\{-webkit-appearance:none/.test(sheet)
  && !/\.dshp-input\{[^}]*appearance:textfield/.test(sheet), 'the steppers were removed from the amount fields');
check('the pot readout cannot change the row', /\.dshp-potShare\{[^}]*width:74px[^}]*flex:none/.test(sheet)
  && /\.dshp-potShare\{[^}]*tabular-nums/.test(sheet), 'the readout resizes as you type');
// The log column is narrower than the strategy column's needs.
check('the log column leaves room for the action row', /\.dshp-side\{width:214px/.test(sheet), 'the log column is still 252px wide');
// A live seat must never be covered by a folded one, and the actor stays on top.
check('folded seats drop behind live ones', /\.dshp-seatOut\{[^}]*z-index:0/.test(sheet) && /\.dshp-seat\{[^}]*z-index:1/.test(sheet)
  && /\.dshp-seatActor\{z-index:5\}/.test(sheet), 'a folded tile can still cover a live one');
// The raise amount is the same size as every other button's amount.
check('the raise amount is the same size as the others', !/\.dshp-commitAmount\{[^}]*font-size/.test(sheet)
  && /\.dshp-btnMain\{[^}]*font-size:12px/.test(sheet), 'the raise amount has its own size');

// Seed the page's table cache the way the panel does on its first paint, so the
// click below has a state on screen to replay forward from.
render(headerComponent, { sessionId: session.id });

/**
 * Render the settled card, click its first legal action, and report what the
 * click did: a direct route call (no chat message) or the fallback prompt.
 */
submitted = null;
fetchRequests.length = 0;
const cardButtons = collect(card, 'button');
const actionButton = cardButtons.find((button) => /\u8fc7\u724c|\u8ddf\u6ce8|\u4e0b\u6ce8|\u52a0\u6ce8/.test(flatten(button)));
check('the card offers action buttons', cardButtons.length >= 2, `got ${cardButtons.length}`);
check('the card offers a legal action for the hero turn', actionButton !== undefined, cardText.slice(0, 200));
const revisionBefore = checkedMeta.view.revision;
if (actionButton) await actionButton.props.onClick();
check('clicking never posts a chat message', submitted === null, JSON.stringify(submitted));
check('clicking calls the plugin route instead', fetchRequests.length === 1 && fetchRequests[0].url.startsWith('/poker/'), JSON.stringify(fetchRequests.map((entry) => entry.url)));
check('the route call carries the opaque table id', fetchRequests.length === 1 && fetchRequests[0].body.tableId === checkedMeta.view.tableId, JSON.stringify(fetchRequests[0] && fetchRequests[0].body));
check('the route call names one action', fetchRequests.length === 1 && typeof fetchRequests[0].body.action === 'string', JSON.stringify(fetchRequests[0] && fetchRequests[0].body));

// ---- the opponents' moves are REPLAYED, not jumped over --------------------

check('the answer queues replay beats', pendingTimers.length > 0, `queued ${pendingTimers.length}`);
if (lastRouteAnswer && Array.isArray(lastRouteAnswer.steps)) {
  check('the route stamps every action it played', lastRouteAnswer.steps.every((step) => typeof step.seq === 'number' && step.seq > 0), JSON.stringify(lastRouteAnswer.steps).slice(0, 200));
  check('each stamped action carries where it landed', lastRouteAnswer.steps.every((step) => typeof step.stack === 'number' && typeof step.pot === 'number'), JSON.stringify(lastRouteAnswer.steps[0] || null));
}
// The hero's own action waits the SAME beat as an opponent's. It used to land at
// once, which is fine mid-hand but lands on the opening move of a new hand (the
// hero is often first to act) - your chips jumped while every opponent then took
// a beat, and the table read as broken.
const heroBeat = pendingTimers.shift();
check('the hero action waits its beat like everyone else', heroBeat !== undefined && heroBeat.delay >= 240 && heroBeat.delay <= 1040, JSON.stringify(heroBeat && heroBeat.delay));
if (heroBeat) heroBeat.fn();
const midway = render(cardComponent, { block: settledBlock, sessionId: session.id, toolName: 'poker_action' });
const midwayText = flatten(midway);
check('mid-replay the table says it is settling', /\u5bf9\u624b\u884c\u52a8\u4e2d/.test(midwayText), midwayText.slice(-160));
check('mid-replay the count is shown', /\u5bf9\u624b\u884c\u52a8\u4e2d\u2026 1\/\d+/.test(midwayText), midwayText.slice(-160));
check('mid-replay the menu is withdrawn', !collect(midway, 'button').some((button) => String(button.props.className || '').includes('dshp-btnPrimary')), 'action buttons stayed clickable during the replay');
const opponentBeat = pendingTimers.shift();
check('an opponent move waits its turn', opponentBeat !== undefined && opponentBeat.delay > 0, JSON.stringify(opponentBeat && opponentBeat.delay));
if (opponentBeat) opponentBeat.fn();
// Drain the whole replay: the beats are chained, so the page is only settled once
// the queue is empty and the authoritative view has landed.
runTimers(400);
check('the replay queue drains', pendingTimers.length === 0, `still queued ${pendingTimers.length}`);
const settled = render(cardComponent, { block: settledBlock, sessionId: session.id, toolName: 'poker_action' });
const settledText = flatten(settled);
check('the replay ends on the authoritative state', !/\u5bf9\u624b\u884c\u52a8\u4e2d/.test(settledText), settledText.slice(-160));
check('the replay lands the real revision', lastRouteAnswer !== null && lastRouteAnswer.view.revision > revisionBefore, `${revisionBefore} -> ${lastRouteAnswer && lastRouteAnswer.view.revision}`);
check('the settled table shows the pot it ended on', settledText.includes(Number(lastRouteAnswer.view.pot).toLocaleString('en-US')), `expected ${lastRouteAnswer.view.pot}`);

// The click really advanced the engine: re-render and read the newer state.
const afterClick = settled;
const afterText = flatten(afterClick);
check('a direct action advances the game', /\u8be5\u4f60|\u8fc7\u724c|\u8ddf\u6ce8|\u52a0\u6ce8|\u53d1\u4e0b\u4e00\u624b|\u672c\u624b\u7ed3\u675f/.test(afterText), afterText.slice(0, 200));

// ---- the panel prefers the freshest view, cached or logged ----------------

const headerAfterClick = render(headerComponent, { sessionId: session.id });
const headerAfterText = flatten(headerAfterClick);
check('the panel picks up the click-driven table', /\u7b2c 1 \u624b/.test(headerAfterText), headerAfterText.slice(0, 200));
check('the click produced a newer revision than the session log holds', lastRouteAnswer !== null && lastRouteAnswer.view.revision > checkedMeta.view.revision, `${checkedMeta.view.revision} -> ${lastRouteAnswer && lastRouteAnswer.view.revision}`);
check(
  'the panel shows the click-driven view, not the logged one',
  lastRouteAnswer !== null && headerAfterText.includes(lastRouteAnswer.view.streetLabel) && lastRouteAnswer.view.streetLabel !== checkedMeta.view.streetLabel,
  `panel=${headerAfterText.slice(0, 80)} cached=${lastRouteAnswer && lastRouteAnswer.view.streetLabel} logged=${checkedMeta.view.streetLabel}`,
);

// ---- when the route is unavailable the chat path still plays the game -----

failFetch = true;
submitted = null;
const fallbackCard = render(cardComponent, { block: settledBlock, sessionId: session.id, toolName: 'poker_action' });
const fallbackButton = collect(fallbackCard, 'button').find((button) => /\u8fc7\u724c|\u8ddf\u6ce8|\u4e0b\u6ce8|\u52a0\u6ce8/.test(flatten(button)));
if (fallbackButton) await fallbackButton.props.onClick();
check('a failed route call falls back to one chat prompt', submitted !== null && submitted.parts[0].type === 'text', JSON.stringify(submitted));
check('the fallback prompt is queued like any user message', submitted !== null && submitted.mode === 'queue');
failFetch = false;

// ---- the persistent header surface ----

let header;
try {
  header = render(headerComponent, { sessionId: session.id });
} catch (error) {
  failures.push(`rendering the header surface threw :: ${error && error.message}`);
}
check('the header surface subscribes to the session', subscribed >= 1, `subscriptions ${subscribed}`);
const headerText = flatten(header);
check('the header reads the newest table out of the session', /\u7b2c 1 \u624b\u00b7/.test(headerText), headerText.slice(0, 200));
// The pot the header prints is the one the live table holds, not a fixture total.
check(
  'the header summary shows the pot',
  lastRouteAnswer !== null && headerText.includes(Number(lastRouteAnswer.view.pot).toLocaleString('en-US')),
  `expected pot ${lastRouteAnswer && lastRouteAnswer.view.pot} :: ${headerText.slice(0, 200)}`,
);

check('the header renders a toggle button', collect(header, 'button')[0] !== undefined, headerText.slice(0, 120));
const panel = setPanel(true);
const openTree = panel;
const panelClasses = classes(panel);
const panelText = flatten(panel);
check('clicking the header button opens the panel', panelClasses.includes('dshp-panel'), panelClasses.join(','));
check('the panel draws the same felt table', panelClasses.includes('dshp-felt'));
// The page must stay usable behind the table: no full-screen backdrop, and the
// panel is draggable by its header.
check('the panel never covers the page', !panelClasses.includes('dshp-backdrop'), panelClasses.join(','));
const panelNode = walkAll(panel).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-panel'));
check('the panel floats in a fixed position', panelNode !== undefined && panelNode.props.style !== undefined, JSON.stringify(panelNode && panelNode.props.style));
const panelHead = walkAll(panel).find((node) => String(node.props && node.props.className || '').includes('dshp-panelHead'));
check('the panel can be dragged by its header', panelHead !== undefined && typeof panelHead.props.onPointerDown === 'function');
check('an outside click closes the panel', globalThis.document.listeners.some((entry) => entry.type === 'pointerdown'), JSON.stringify(globalThis.document.listeners.map((entry) => entry.type)));

// ---- pinning the panel ----------------------------------------------------

// The title bar is a toolbar of icons now: the pin is the one wearing 📌, and it
// sits at the right end (after the teaching switch and the table swap). Scoped to
// the panel's own title bar, because the coach window has a toolbar of its own.
const tablePanelHead = walkAll(panel).find((node) => String(node.props && node.props.className || '').includes('dshp-panelHead'));
const titleBarButtons = walkAll(tablePanelHead).filter((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-iconBtn'));
const pinButton = titleBarButtons.find((node) => flatten(node) === '\u{1F4CC}');
check('the panel offers a pin', pinButton !== undefined, 'no pin button');
check('the pin is an icon, not a sentence', flatten(pinButton) === '\u{1F4CC}', JSON.stringify(flatten(pinButton)));
check('the teaching switch leads the toolbar and the pin ends it', (() => {
  const glyphs = walkAll(tablePanelHead).filter((node) => node.type === 'button').map((node) => flatten(node));
  const teach = glyphs.indexOf('\u{1F4A1}');
  const pin = glyphs.lastIndexOf('\u{1F4CC}');
  // — the close button is after the pin, so the pin is the last TOOL, not the last
  // button: 💡 | 🔄 | 📌 | ×.
  return teach >= 0 && pin > teach && glyphs.indexOf('\u{1F504}') > teach && glyphs[glyphs.length - 1] === '\u00d7';
})(), walkAll(tablePanelHead).filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));
check('the swap-table control keeps its text off too', titleBarButtons.some((node) => String(node.props.title || '').includes('\u6362\u4e00\u5f20\u724c\u684c')) && !titleBarButtons.some((node) => flatten(node).includes('\u6362\u684c')), titleBarButtons.map((node) => flatten(node)).join(' | '));
if (pinButton) pinButton.props.onClick();
const pinned = render(headerComponent, { sessionId: session.id });
const pinnedHead = walkAll(pinned).find((node) => String(node.props && node.props.className || '').includes('dshp-panelHead'));
check('pinning marks the panel as fixed', pinnedHead !== undefined && String(pinnedHead.props.className).includes('dshp-panelHeadPinned'), pinnedHead && pinnedHead.props.className);
check('a pinned panel ignores outside clicks', !globalThis.document.listeners.some((entry) => entry.type === 'pointerdown'), JSON.stringify(globalThis.document.listeners.map((entry) => entry.type)));
check('pinning is remembered for the next visit', (() => {
  try {
    return JSON.parse(globalThis.window.localStorage.getItem('dsh-plugin-poker/panel')).pinned === true;
  } catch (error) {
    return false;
  }
})(), 'layout was not persisted');
// Unpin again so the remaining checks see the default behaviour.
const unpin = walkAll(pinned).find((node) => node.type === 'button' && flatten(node) === '\u{1F4CC}');
if (unpin) unpin.props.onClick();
render(headerComponent, { sessionId: session.id });

// The table panel drags through the same shared window store, under its own key.
const panelForDrag = render(headerComponent, { sessionId: session.id });
const panelHeadForDrag = walkAll(panelForDrag).find((node) => String(node.props && node.props.className || '').includes('dshp-panelHead'));
const panelWindowNode = { offsetWidth: 660, getBoundingClientRect: () => ({ left: 100, top: 100 }) };
const panelMovesBefore = documentListeners('pointermove').length;
if (panelHeadForDrag) {
  panelHeadForDrag.props.onPointerDown({ currentTarget: { parentElement: panelWindowNode }, clientX: 120, clientY: 120, button: 0, target: {} });
}
const panelMove = documentListeners('pointermove').pop();
check('the table panel also drags by its header', documentListeners('pointermove').length === panelMovesBefore + 1 && panelMove !== undefined, 'no drag started');
if (panelMove) panelMove({ clientX: 400, clientY: 300 });
const panelDrop = documentListeners('pointerup').pop();
if (panelDrop) panelDrop({});
check('the panel position is saved under the panel key', (() => {
  try {
    const stored = JSON.parse(globalThis.window.localStorage.getItem('dsh-plugin-poker/panel'));
    return stored.x === 380 && stored.y === 280;
  } catch (error) {
    return false;
  }
})(), 'panel position was not stored');

// ---- the hand log sits beside the coach -----------------------------------

const bottom = walkAll(pinned).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-bottom'));
const sideColumn = walkAll(pinned).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-side'));
check('the bottom area is split into strategy and history columns', bottom !== undefined && sideColumn !== undefined, 'missing dshp-bottom / dshp-side');
check('the hand log lives in the side column', sideColumn !== undefined && walkAll(sideColumn).some((node) => String(node.props && node.props.className || '').includes('dshp-log')), 'log not in the side column');
check('the side column is labelled as the hand history', sideColumn !== undefined && /\u724c\u5c40\u8bb0\u5f55/.test(flatten(sideColumn)), flatten(sideColumn).slice(0, 80));
check('the panel names the street or the hand', /\u7b2c \d+ \u624b|\u7ffb\u724c\u524d|\u7ffb\u724c|\u8f6c\u724c|\u6cb3\u724c/.test(panelText), panelText.slice(0, 200));
submitted = null;
fetchRequests.length = 0;
const panelButtons = collect(panel, 'button').filter((button) => String(button.props.className || '').includes('dshp-btn'));
check('the panel exposes playable actions', panelButtons.length >= 2, `got ${panelButtons.length}`);
if (panelButtons.length > 0) await panelButtons[0].props.onClick();
check('a panel button plays directly', fetchRequests.length === 1 && fetchRequests[0].url.startsWith('/poker/'), JSON.stringify(fetchRequests.map((entry) => entry.url)));
check('a panel button posts no chat message', submitted === null, JSON.stringify(submitted));
const closed = walkAll(setPanel(false));
check('clicking the header toggle again closes the panel', !classes(closed).includes('dshp-panel'), flatten(closed).slice(0, 120));

// ---- a session with no poker table yet offers every table size ------------

const emptyHeader = render(headerComponent, { sessionId: 'no-table-here' });
check('a session without a table says so', flatten(emptyHeader).includes('\u672a\u5f00\u684c'), flatten(emptyHeader).slice(0, 140));
// Open the panel for this session; the toggle carries the open state.
const emptyTree = setPanel(true, 'no-table-here');
const pickButtons = emptyTree.filter((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-pick'));
check('every table size is offered', pickButtons.length === 8, `got ${pickButtons.length}`);
check(
  'the size buttons name the player count',
  pickButtons.length === 8 && /2 \u4eba/.test(flatten(pickButtons[0])) && /9 \u4eba/.test(flatten(pickButtons[7])),
  pickButtons.map((button) => flatten(button)).join(' | '),
);
check(
  'the sizes explain themselves',
  /\u5355\u6311/.test(flatten(pickButtons[0])) && /\u5168\u73af/.test(flatten(pickButtons[7])) && /\u6807\u51c6/.test(flatten(pickButtons[4])),
  pickButtons.map((button) => flatten(button)).join(' | '),
);

submitted = null;
fetchRequests.length = 0;
if (pickButtons[7]) await pickButtons[7].props.onClick();
// Only the picker's own request: the panel also syncs the shared table in the
// background (a /poker/table or /poker/current call), which is not this click.
const openRequests = fetchRequests.filter((entry) => entry.url === '/poker/new');
check('picking nine players opens the table through the route', openRequests.length === 1, JSON.stringify(fetchRequests.map((entry) => entry.url)));
check('the route call asks for eight opponents', openRequests[0] && openRequests[0].body.botCount === 8, JSON.stringify(openRequests[0] && openRequests[0].body));
check('the route call names the session', openRequests[0] && openRequests[0].body.sessionId === 'no-table-here', JSON.stringify(openRequests[0] && openRequests[0].body));
check('opening a table posts no chat message', submitted === null, JSON.stringify(submitted));

const afterOpen = render(headerComponent, { sessionId: 'no-table-here' });
const openedTree = walkAll(afterOpen);
check('the panel switches to the table it just opened', openedTree.some((node) => String(node.props && node.props.className || '').includes('dshp-table')), flatten(afterOpen).slice(0, 160));
check('the new table has nine seats', openedTree.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat')).length === 9, String(openedTree.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat')).length));
const swapButton = openedTree.find((node) => node.type === 'button' && String(node.props.title || '').includes('\u6362\u4e00\u5f20\u724c\u684c'));
check('an open table can be swapped for another size', swapButton !== undefined, 'no 换桌 button');

// Swapping an EXISTING table: a new table restarts its revision at 0, which used
// to look older than the table already on screen, so the client ignored the
// answer and the swap silently did nothing. The cache compares table ids now.
submitted = null;
fetchRequests.length = 0;
if (swapButton) swapButton.props.onClick();
const pickerTree = walkAll(render(headerComponent, { sessionId: 'no-table-here' }));
const swapChoices = pickerTree.filter((node) => node.type === 'button' && String(node.props.className || '').split(' ').includes('dshp-pickChip'));
check('the swap button opens the size picker', swapChoices.length === 8, `got ${swapChoices.length}`);
// The strip sits UNDER the table (the table stays visible), marks the size being
// played, and offers a way out.
const pickerStrip = pickerTree.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-pickStrip'));
const tableIndex = pickerTree.findIndex((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-table'));
check('the picker is a strip under the table, not instead of it', pickerStrip !== undefined && tableIndex >= 0
  && pickerTree.indexOf(pickerStrip) > tableIndex, `table@${tableIndex}, strip@${pickerTree.indexOf(pickerStrip)}`);
check('the strip marks the table being played', swapChoices.filter((node) => String(node.props.className).includes('dshp-pickChipNow')).length === 1
  && flatten(swapChoices.find((node) => String(node.props.className).includes('dshp-pickChipNow'))).startsWith('9'),
  swapChoices.map((node) => `${flatten(node)}${String(node.props.className).includes('Now') ? '*' : ''}`).join(' | '));
const cancelPick = pickerTree.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-pickCancel'));
check('the strip can be dismissed', cancelPick !== undefined && flatten(cancelPick) === '\u53d6\u6d88', cancelPick && flatten(cancelPick));
if (cancelPick) cancelPick.props.onClick();
const dismissed = walkAll(render(headerComponent, { sessionId: 'no-table-here' }));
check('dismissing keeps the table', dismissed.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-table'))
  && !dismissed.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-pickStrip')), 'the strip stayed open');
// Re-open it for the actual swap.
if (swapButton) swapButton.props.onClick();
const reopened = walkAll(render(headerComponent, { sessionId: 'no-table-here' }));
const reopenChoices = reopened.filter((node) => node.type === 'button' && String(node.props.className || '').split(' ').includes('dshp-pickChip'));
// Only the click's own request counts: the panel also syncs the shared table in
// the background, which is a /poker/current call.
const swapRequests = () => fetchRequests.filter((entry) => entry.url === '/poker/new');
if (reopenChoices[1]) await reopenChoices[1].props.onClick();
check('the swap goes through the route', swapRequests().length === 1 && swapRequests()[0].url === '/poker/new' && swapRequests()[0].body.botCount === 2,
  JSON.stringify(fetchRequests.map((entry) => entry.body)));
const swapped = walkAll(render(headerComponent, { sessionId: 'no-table-here' }));
const swappedSeats = swapped.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat'));
check('swapping really replaces the table on screen', swappedSeats.length === 3, `${swappedSeats.length} seats after the swap`);

// ---- a table the browser opened waits for 开始 -----------------------------

// The current host deals a GUI table paused, so 开始 has to go over the route.
check('a table opened from the GUI arrives paused', lastRouteAnswer !== null && lastRouteAnswer.view.awaitingStart === true
  && Number(lastRouteAnswer.view.actionSeq) === 0, JSON.stringify({ awaiting: lastRouteAnswer && lastRouteAnswer.view.awaitingStart, seq: lastRouteAnswer && lastRouteAnswer.view.actionSeq }));
const startButton = swapped.find((node) => node.type === 'button' && flatten(node).startsWith('\u5f00\u59cb'));
check('the paused table offers 开始', startButton !== undefined, swapped.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));
check('the paused table hides the action buttons', !swapped.some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnCheck'))
  && !swapped.some((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnAllIn')),
  swapped.filter((node) => node.type === 'button').map((node) => String(node.props.className)).join(' | '));
check('the paused table shows no sizing helper', !swapped.some((node) => String(node.props && node.props.className || '').includes('dshp-coachTitle')),
  'the sizing helper appeared before the hand started');

pendingTimers.length = 0;
fetchRequests.length = 0;
submitted = null;
if (startButton) await startButton.props.onClick();
// The click's route call is a promise chain: let it land before reading the cache.
await new Promise((resolve) => process.nextTick(resolve));
check('a host-paused table starts over the route', fetchRequests.filter((entry) => entry.url === '/poker/start').length === 1,
  JSON.stringify(fetchRequests.map((entry) => entry.url)));
check('开始 posts no chat message', submitted === null, JSON.stringify(submitted));
// The hero may BE the first preflop actor, in which case there is nothing to
// replay and the table is simply playable; otherwise the bots get their beats.
const justStarted = walkAll(render(headerComponent, { sessionId: 'no-table-here' }))
  .some((node) => node.type === 'button' && /dshp-btn(Check|AllIn|Danger|Commit)/.test(String(node.props.className || '')));
check('开始 puts the hand under way', pendingTimers.length > 0 || justStarted,
  `${pendingTimers.length} beats queued, playable=${justStarted}`);
const startedSeats = walkAll(render(headerComponent, { sessionId: 'no-table-here' })).filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat'));
check('the started table is still the swapped one', startedSeats.length === 3, `${startedSeats.length} seats`);
pendingTimers.length = 0;
runTimers(40);

// ---- a host that predates the paused deal is held by the BROWSER ------------

// The user's running host may be older than this client (the entry layer only
// changes on a restart), so the same "click 开始  flow must work when the answer
// already carries the opponents' moves: the page rewinds the display to the start
// of the hand and replays those moves itself.
const staleExec = { agent: { session: { id: 'stale-scan' } } };
const staleOpened = await registered.get('poker_new_table').execute({ botCount: 5, startingStack: 10000, smallBlind: 50, bigBlind: 100, seed: 77 }, staleExec);
const staleView = registered.get('poker_new_table').output.presentationMeta({}, staleOpened).view;
const staleState = await (async () => {
  const response = fakeHttpResponse();
  await hostPlugin.handlePokerRequest(fakeHttpRequest('POST', '/poker/table', { tableId: staleView.tableId }), response);
  return response.settle().json;
})();
check('the stale-host stand-in carries the opponents\u2019 moves', staleState.ok === true && Array.isArray(staleState.steps) && staleState.steps.length > 0
  && staleState.view.awaitingStart === false, JSON.stringify({ steps: staleState.steps.length, awaiting: staleState.view.awaitingStart }));

const staleSession = { id: 'stale-host' };
fetchOverride = (url) => (url === '/poker/new' ? { ok: true, view: staleState.view, steps: staleState.steps } : undefined);
// The window carries a DIFFERENT table (the one already on screen), so the answer
// really is a switch - which is the case a stale host produces.
const staleWindow = {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 's1', name: 'poker_new_table', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 's1' }, content: [] }, meta: { view: checkedMeta.view } } } },
  ],
  hasMore: false,
  revision: 1,
};
coachFixtures.set('stale-host', staleWindow);
render(headerComponent, { sessionId: 'stale-host' });
const stalePanel = setPanel(true, 'stale-host');
const staleSwap = stalePanel.find((node) => node.type === 'button' && String(node.props.title || '').includes('\u6362\u4e00\u5f20\u724c\u684c'));
if (staleSwap) staleSwap.props.onClick();
const stalePicker = walkAll(render(headerComponent, { sessionId: 'stale-host' }))
  .filter((node) => node.type === 'button' && String(node.props.className || '').split(' ').includes('dshp-pickChip'));
if (stalePicker[1]) await stalePicker[1].props.onClick();
fetchOverride = null;
await new Promise((resolve) => process.nextTick(resolve));

const heldEntry = globalThis.window.__dshPokerTables.get('stale-host');
const heldView = heldEntry ? heldEntry.view : null;
check('the browser holds a stale host\u2019s answer at the start of the hand', heldEntry !== null && heldEntry !== undefined
  && heldEntry.held !== null && heldView.awaitingStart === true, JSON.stringify({ held: Boolean(heldEntry && heldEntry.held), awaiting: heldView && heldView.awaitingStart }));
check('the held table is rewound', heldView !== null && heldView.pot === heldView.smallBlind + heldView.bigBlind
  && heldView.currentBet === heldView.bigBlind && heldView.board.length === 0 && heldView.legal === null
  && heldView.players.every((player) => player.folded !== true && player.allIn !== true),
  JSON.stringify({ pot: heldView && heldView.pot, legal: heldView && heldView.legal }));
check('the held stacks are whole again', heldView !== null
  && heldView.players.every((player) => player.stack + player.streetCommitted === 10000)
  && heldView.players.filter((player) => player.streetCommitted === heldView.smallBlind).length === 1
  && heldView.players.filter((player) => player.streetCommitted === heldView.bigBlind).length === 1,
  JSON.stringify(heldView && heldView.players.map((player) => player.stack + player.streetCommitted)));
check('the held log keeps only the blinds', heldView !== null
  && heldView.log.every((line) => /^\u2014\u2014|[\u4e0b]\u5c0f\u76f2|[\u4e0b]\u5927\u76f2/.test(String(line))),
  JSON.stringify(heldView && heldView.log));

const heldPanel = walkAll(render(headerComponent, { sessionId: 'stale-host' }));
const heldStart = heldPanel.find((node) => node.type === 'button' && flatten(node).startsWith('\u5f00\u59cb'));
check('the held table offers 开始', heldStart !== undefined, heldPanel.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));
pendingTimers.length = 0;
fetchRequests.length = 0;
submitted = null;
if (heldStart) await heldStart.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
// Only the click's own route call counts: the panel also syncs the shared table in
// the background, and that must NOT become an action.
check('开始 replays what the page holds, with no route call', fetchRequests.filter((entry) => entry.url === '/poker/start').length === 0,
  JSON.stringify(fetchRequests.map((entry) => entry.url)));
check('开始 posts no chat message', submitted === null, JSON.stringify(submitted));
check('gives the held moves their beats', pendingTimers.length > 0, `${pendingTimers.length} beats queued`);
runTimers(60);
const staleSettled = globalThis.window.__dshPokerTables.get('stale-host');
check('after the beats the held table is playable', staleSettled.view.awaitingStart !== true && staleSettled.view.legal !== null
  && staleSettled.view.resolving !== true && !staleSettled.held,
  JSON.stringify({ awaiting: staleSettled.view.awaitingStart, legal: Boolean(staleSettled.view.legal), resolving: staleSettled.view.resolving }));
check('the held table keeps the opponents\u2019 moves', staleSettled.view.pot === staleState.view.pot && staleSettled.view.street === staleState.view.street,
  JSON.stringify({ pot: staleSettled.view.pot, expected: staleState.view.pot }));
pendingTimers.length = 0;

// ---- a refused click is answered on the panel, never in the chat ------------

// This is the bug that put "全下" into the conversation: the route refused the action
// (an all-in that cannot raise), the client treated the refusal like a dead route and
// posted the action as a chat message, which started a model turn.
fetchOverride = (url) => (url === '/poker/action' ? { ok: false, error: '\u52a0\u6ce8\u5fc5\u987b\u9ad8\u4e8e\u5f53\u524d\u4e0b\u6ce8 7400\uff08\u6216\u9009\u62e9\u8ddf\u6ce8\uff09' } : undefined);
submitted = null;
fetchRequests.length = 0;
const refusedPanel = walkAll(render(headerComponent, { sessionId: 'stale-host' }));
const refusedButton = refusedPanel.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btn') && node.props.onClick);
if (refusedButton) await refusedButton.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
check('a refused action does not go to the chat', submitted === null, JSON.stringify(submitted));
check('a refused action still talks to the route', fetchRequests.filter((entry) => entry.url === '/poker/action').length === 1,
  JSON.stringify(fetchRequests.map((entry) => entry.url)));
const refusedView = globalThis.window.__dshPokerTables.get('stale-host').view;
check('a refused action is reported on the panel', typeof refusedView.notice === 'string' && refusedView.notice.includes('7400'),
  JSON.stringify(refusedView.notice));
const noticeNode = walkAll(render(headerComponent, { sessionId: 'stale-host' }))
  .find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-notice'));
check('the panel draws the refusal next to the buttons', noticeNode !== undefined && flatten(noticeNode).includes('7400'),
  noticeNode ? flatten(noticeNode) : 'no notice drawn');
// The next accepted answer clears it: the notice belongs to one refused click.
fetchOverride = null;
if (refusedButton) await refusedButton.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
check('the notice clears with the next answer',
  !globalThis.window.__dshPokerTables.get('stale-host').view.notice,
  JSON.stringify(globalThis.window.__dshPokerTables.get('stale-host').view.notice));
pendingTimers.length = 0;
runTimers(60);

// ---- dealing the next hand refreshes every seat at once --------------------

// The complaint this guards: 发下一手 left the seats (and the board, and the log)
// looking like the hand that had just finished, because the new hand's moves were
// replayed ON TOP of the old showdown instead of from the new hand's own start.
const driveSession = { id: 'drive-harness' };
const driveExec = { agent: { session: driveSession } };
let driveResult = await registered.get('poker_new_table').execute({ botCount: 2, startingStack: 3000, smallBlind: 25, bigBlind: 50, seed: 31 }, driveExec);
let driveView = registered.get('poker_new_table').output.presentationMeta({}, driveResult).view;
let driveGuard = 0;
while (driveView.legal && driveGuard < 80) {
  driveGuard += 1;
  driveResult = await registered.get('poker_action').execute({ action: driveView.legal.canCheck ? 'check' : 'call' }, driveExec);
  driveView = registered.get('poker_action').output.presentationMeta({}, driveResult).view;
}
check('the drive hand played out to a finished hand', driveView.phase === 'handover' && driveView.handNumber === 1,
  `${driveView.phase} hand ${driveView.handNumber}`);
const endedMeta = registered.get('poker_action').output.presentationMeta({}, driveResult);

// Hand 2's real answer, straight from the route: a view plus its replay steps.
const nextResponse = fakeHttpResponse();
await hostPlugin.handlePokerRequest(fakeHttpRequest('POST', '/poker/next', { tableId: driveView.tableId }), nextResponse);
const nextAnswer = nextResponse.settle().json;
check('the next-hand answer carries the new hand and its moves',
  nextAnswer.ok === true && nextAnswer.view.handNumber === 2 && Array.isArray(nextAnswer.steps) && nextAnswer.steps.length > 0,
  JSON.stringify({ hand: nextAnswer.view && nextAnswer.view.handNumber, steps: nextAnswer.steps && nextAnswer.steps.length }));

coachFixtures.set('next-harness', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'next_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'next_call' }, content: [] }, meta: endedMeta } } },
  ],
  hasMore: false,
  revision: 1,
});
render(headerComponent, { sessionId: 'next-harness' });
const nextPanel = setPanel(true, 'next-harness');
const dealButton = nextPanel.find((node) => node.type === 'button' && flatten(node).includes('\u53d1\u4e0b\u4e00\u624b'));
check('a finished hand offers 发下一手', dealButton !== undefined, nextPanel.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));
fetchOverride = (url) => (url === '/poker/next' ? nextAnswer : undefined);
pendingTimers.length = 0;
fetchRequests.length = 0;
submitted = null;
if (dealButton) await dealButton.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
fetchOverride = null;
const dealt = globalThis.window.__dshPokerTables.get('next-harness').view;
check('dealing the next hand refreshes every seat at once',
  dealt.handNumber === 2
    && Array.isArray(dealt.board) && dealt.board.length === 0
    && dealt.pot === dealt.smallBlind + dealt.bigBlind
    && dealt.players.every((player) => player.folded === false && player.allIn === false),
  JSON.stringify({ hand: dealt.handNumber, board: dealt.board, pot: dealt.pot, folded: dealt.players.map((player) => player.folded) }));
check('the new hand keeps only its own opening log',
  Array.isArray(dealt.log) && dealt.log.length > 0 && dealt.log.every((line) => /\u2014\u2014|[\u4e0b]\u5c0f\u76f2|[\u4e0b]\u5927\u76f2/.test(String(line))),
  JSON.stringify(dealt.log));
check('the new hand\u2019s moves are still replayed', pendingTimers.length > 0, `${pendingTimers.length} beats queued`);
check('dealing the next hand posts no chat message', submitted === null, JSON.stringify(submitted));
runTimers(60);
const settledNext = globalThis.window.__dshPokerTables.get('next-harness').view;
check('the replay lands the new hand\u2019s real state',
  settledNext.handNumber === 2 && settledNext.pot === nextAnswer.view.pot && settledNext.players.some((player) => player.folded === true),
  JSON.stringify({ hand: settledNext.handNumber, pot: settledNext.pot, expected: nextAnswer.view.pot }));
pendingTimers.length = 0;

// ---- the rebuy card, only once the hero's stack is empty -------------------

// A real busted table: the hero folds every hand until the blinds have taken the
// short stack. (Shoving instead would not work any more - a bot that sensibly folds
// a shove leaves the shover winning the blinds and growing a stack.)
async function bustedTableView(exec, seed) {
  let view = (await registered.get('poker_new_table').execute({ botCount: 1, startingStack: 400, smallBlind: 50, bigBlind: 100, seed }, exec)).view;
  for (let attempt = 0; attempt < 60 && view.players[0].stack > 0; attempt += 1) {
    if (view.canDealNext) {
      view = (await registered.get('poker_next_hand').execute({}, exec)).view;
      continue;
    }
    if (!view.legal) break;
    const action = view.legal.canFold ? 'fold' : view.legal.canCheck ? 'check' : 'call';
    view = (await registered.get('poker_action').execute({ action }, exec)).view;
  }
  return view;
}

const rebuySession = { id: 'rebuy-harness' };
const rebuyExec = { agent: { session: rebuySession } };
const bustedMeta = registered.get('poker_action').output.presentationMeta({}, { view: await bustedTableView(rebuyExec, 1) });
check('the probe table really busts the hero',
  bustedMeta.view.players[0].stack === 0 && bustedMeta.view.canDealNext === true,
  JSON.stringify({ stack: bustedMeta.view.players[0].stack, canDealNext: bustedMeta.view.canDealNext }));

coachFixtures.set('rebuy-harness', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'rebuy_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'rebuy_call' }, content: [] }, meta: bustedMeta } } },
  ],
  hasMore: false,
  revision: 1,
});
const rebuyTree = setPanel(true, 'rebuy-harness');
const rebuyNode = rebuyTree.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-rebuy'));
check('a busted hero gets the rebuy card', rebuyNode !== undefined,
  rebuyTree.filter((node) => typeof node.props.className === 'string').map((node) => node.props.className).join(' | ').slice(0, 240));
check('the rebuy card names the problem', flatten(rebuyNode).includes('\u4f60\u5df2\u8f93\u5149\u7b79\u7801'), flatten(rebuyNode));
const rebuyOptions = rebuyTree.filter((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-rebuyOpt'));
const rebuyLabels = rebuyOptions.map((node) => flatten(node)).join(' | ');
check('the rebuy card offers whole big-blind top-ups',
  rebuyOptions.length === 3 && ['5,000', '10,000', '20,000'].every((amount) => rebuyLabels.includes(amount)),
  rebuyLabels);
check('a busted hero is not offered 发下一手',
  rebuyTree.every((node) => !(node.type === 'button' && flatten(node).includes('\u53d1\u4e0b\u4e00\u624b'))),
  rebuyTree.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));

// The middle top-up really rebuys: the click goes to the route and the hero comes
// back with chips, so the card goes away and 发下一手 takes its place.
fetchRequests.length = 0;
submitted = null;
if (rebuyOptions[1]) await rebuyOptions[1].props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
check('the rebuy click goes to the route',
  fetchRequests.filter((entry) => entry.url === '/poker/rebuy').length === 1
    && fetchRequests.find((entry) => entry.url === '/poker/rebuy').body.amount === 10000,
  JSON.stringify(fetchRequests.map((entry) => entry.body)));
check('the rebuy click posts no chat message', submitted === null, JSON.stringify(submitted));
check('the rebuy lands on the table',
  lastRouteAnswer !== null && lastRouteAnswer.ok === true && lastRouteAnswer.view.players[0].stack === 10000,
  JSON.stringify(lastRouteAnswer && lastRouteAnswer.view && lastRouteAnswer.view.players[0]));
const fundedTree = setPanel(true, 'rebuy-harness');
check('the rebuy card goes away once the hero is funded',
  fundedTree.every((node) => !String(node.props && node.props.className || '').includes('dshp-rebuy')),
  'the rebuy card stayed after the top-up');
check('a funded hero is offered 发下一手 again',
  fundedTree.some((node) => node.type === 'button' && flatten(node).includes('\u53d1\u4e0b\u4e00\u624b')),
  fundedTree.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | '));

// A CUSTOM amount is typed into the box and confirmed.
const customSession = { id: 'rebuy-custom' };
const customExec = { agent: { session: customSession } };
const customMeta = registered.get('poker_action').output.presentationMeta({}, { view: await bustedTableView(customExec, 7) });
coachFixtures.set('rebuy-custom', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'custom_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'custom_call' }, content: [] }, meta: customMeta } } },
  ],
  hasMore: false,
  revision: 1,
});
const customTree = setPanel(true, 'rebuy-custom');
const customInput = customTree.find((node) => node.type === 'input' && String(node.props.className || '').includes('dshp-rebuyInput'));
const customGo = customTree.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-rebuyGo'));
check('the rebuy card offers a custom amount', customInput !== undefined && customGo !== undefined,
  customTree.filter((node) => node.type === 'input' || node.type === 'button').map((node) => node.props.className).join(' | '));
const typedBox = { value: '7500' };
if (customInput && typeof customInput.props.ref === 'function') customInput.props.ref(typedBox);
fetchRequests.length = 0;
if (customGo) await customGo.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
const customRebuys = fetchRequests.filter((entry) => entry.url === '/poker/rebuy');
check('the custom amount rebuys exactly what was typed',
  customRebuys.length === 1 && customRebuys[0].body.amount === 7500 && lastRouteAnswer.view.players[0].stack === 7500,
  JSON.stringify({ body: customRebuys[0] && customRebuys[0].body, stack: lastRouteAnswer && lastRouteAnswer.view && lastRouteAnswer.view.players[0].stack }));

// ---- a session with no poker history adopts the shared table ----------------

// The complaint this guards: the panel in a second conversation looked empty (or
// offered to open a table) while the first conversation was mid-hand, because the
// table used to belong to whichever session had opened it.
const syncSession = 'sync-harness';
coachFixtures.set(syncSession, {
  entries: [{ type: 'event', event: { type: 'user/message', seq: 1, data: {} } }],
  hasMore: false,
  revision: 1,
});
const tick = async () => {
  for (let step = 0; step < 8; step += 1) await new Promise((resolve) => process.nextTick(resolve));
};
const hostCurrent = fakeHttpResponse();
await hostPlugin.handlePokerRequest(fakeHttpRequest('POST', '/poker/current', {}), hostCurrent);
const hostCurrentTable = hostCurrent.settle().json.view;
check('the host has a current table to sync', hostCurrentTable !== null && typeof hostCurrentTable.tableId === 'string', JSON.stringify(hostCurrent.settle().json).slice(0, 120));

fetchRequests.length = 0;
render(headerComponent, { sessionId: syncSession });
await tick();
const syncedEntry = globalThis.window.__dshPokerTables.get(syncSession);
check('a session with no poker history adopts the shared table',
  syncedEntry !== undefined && syncedEntry.view && syncedEntry.view.tableId === hostCurrentTable.tableId,
  JSON.stringify(syncedEntry && syncedEntry.view && syncedEntry.view.tableId));
// The request shape matters: a page that has seen a table asks for THAT id
// (`/poker/table`), which every host version answers, instead of depending on the
// newer discovery op. That is what makes the sync work WITHOUT a host restart.
const syncRequests = fetchRequests.filter((entry) => entry.url === '/poker/table' || entry.url === '/poker/current');
check('the sync asks by remembered id first, and only falls back to the new op',
  syncRequests.length > 0 && syncRequests[0].url === '/poker/table' && typeof syncRequests[0].body.tableId === 'string',
  JSON.stringify(syncRequests));
// A sync lands the snapshot: it must NOT queue a replay, or switching conversation
// would show the same hand being played out again.
check('the sync lands the snapshot instead of replaying it',
  syncedEntry.queue.length === 0 && !syncedEntry.view.resolving && syncedEntry.stepSeq === syncedEntry.view.actionSeq,
  JSON.stringify({ queue: syncedEntry.queue.length, resolving: syncedEntry.view.resolving, stepSeq: syncedEntry.stepSeq, actionSeq: syncedEntry.view.actionSeq }));
const syncedTree = setPanel(true, syncSession);
check('the synced panel shows the table, not the picker',
  syncedTree.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-table'))
    && !syncedTree.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-picker')),
  flatten(syncedTree).slice(0, 140));
check('the synced panel shows the same seats as the host', syncedTree.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat')).length
  === hostCurrentTable.players.length,
  `${syncedTree.filter((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-seat')).length} vs ${hostCurrentTable.players.length}`);

// The stale case that actually bit in practice: the page remembers a table id
// from before the host restarted, asks for it, and used to give up right there -
// leaving the picker on screen forever. It must ask the host what it is playing.
const deadIdSession = 'stale-id-harness';
coachFixtures.set(deadIdSession, {
  entries: [{ type: 'event', event: { type: 'user/message', seq: 1, data: {} } }],
  hasMore: false,
  revision: 1,
});
fetchOverride = (url) => (url === '/poker/table'
  ? { ok: false, error: '\u724c\u684c\u5df2\u4e0d\u5b58\u5728\uff08\u5bbf\u4e3b\u91cd\u542f\u540e\u724c\u5c40\u4f1a\u6d88\u5931\uff09\uff0c\u8bf7\u91cd\u65b0\u5f00\u684c' }
  : undefined);
fetchRequests.length = 0;
render(headerComponent, { sessionId: deadIdSession });
await tick();
fetchOverride = null;
const staleRequests = fetchRequests.filter((entry) => entry.url === '/poker/table' || entry.url === '/poker/current');
const recoveredEntry = globalThis.window.__dshPokerTables.get(deadIdSession);
check('a dead remembered id falls back to the discovery op',
  staleRequests.length >= 2 && staleRequests[0].url === '/poker/table' && staleRequests[staleRequests.length - 1].url === '/poker/current',
  JSON.stringify(staleRequests.map((entry) => entry.url)));
check('the fallback still lands the shared table',
  recoveredEntry !== undefined && recoveredEntry.view && recoveredEntry.view.tableId === hostCurrentTable.tableId,
  JSON.stringify(recoveredEntry && recoveredEntry.view && recoveredEntry.view.tableId));

// ---- the panel lives in the sidebar, outside any conversation ---------------

// Mounted the way the sidebar mounts it - no session prop at all - the panel still
// renders, still syncs, and keeps ONE cache entry for the whole page. That single
// key is why a conversation switch cannot replay the hand a second time.
const sidebarTree = walkAll(render(headerComponent, {}));
const sidebarToggle = sidebarTree.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-headerBtn'));
check('the panel renders without a session', sidebarToggle !== undefined,
  sidebarTree.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | ').slice(0, 160));
if (sidebarToggle) sidebarToggle.props.onClick();
await tick();
const sidebarOpen = walkAll(render(headerComponent, {}));
check('the sidebar panel opens on the shared key',
  classes(sidebarOpen).includes('dshp-panel') && globalThis.window.__dshPokerTables.has('__dsh-poker-shared__'),
  [...globalThis.window.__dshPokerTables.keys()].join(','));
// Close it again so the rest of the suite sees the default state.
const sidebarClose = sidebarOpen.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-close'));
if (sidebarClose) sidebarClose.props.onClick();
check('the sidebar panel closes again', !classes(walkAll(render(headerComponent, {}))).includes('dshp-panel'));

// ---- the coach badge names the move; the commit button never goes quiet -----

// A dedicated session so a click here cannot disturb the table the other sections
// are reading (the log/cache merge is per session, and a stale card follows it).
const uiSession = 'ui-harness';
coachFixtures.set(uiSession, {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'ui_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'ui_call' }, content: [] }, meta: checkedMeta } } },
  ],
  hasMore: false,
  revision: 1,
});
const longHeadline = '\u5f03\u724c\uff1aK9s\uff08\u540c\u82b1\uff09\u5728\u5173\u6c60\u4f4d CO \u592a\u5f31\uff08\u540e\u9762\u8fd8\u6709 3 \u4eba\uff09';
const planView = {
  ...checkedMeta.view,
  coach: { ...checkedMeta.view.coach, plan: { action: 'fold', tone: 'bad', headline: longHeadline } },
};
coachFixtures.set(uiSession, {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'ui_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'ui_call' }, content: [] }, meta: { ...checkedMeta, view: planView } } } },
  ],
  hasMore: false,
  revision: 1,
});
const uiTree = walkAll(render(headerComponent, { sessionId: uiSession }));
const planPill = uiTree.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-coachPlan'));
check('the coach badge shows the move, not the sentence',
  planPill !== undefined && flatten(planPill) === '\u5f03\u724c' && planPill.props.title === longHeadline,
  planPill ? `${flatten(planPill)} :: ${planPill.props.title}` : 'no badge');
check('the badge cannot be longer than the window head',
  planPill !== undefined && String(planPill.props.className).includes('dshp-coachPlan'),
  planPill && planPill.props.className);

// The empty-box commit: the box shows the minimum as a PLACEHOLDER, so pressing the
// button without typing asks for that amount. It used to read '' and do nothing.
const uiPanel = setPanel(true, uiSession);
const uiInputs = uiPanel.filter((node) => node.type === 'input');
const uiChipBox = { value: '' };
const uiBBBox = { value: '' };
if (uiInputs[0] && typeof uiInputs[0].props.ref === 'function') uiInputs[0].props.ref(uiChipBox);
if (uiInputs[1] && typeof uiInputs[1].props.ref === 'function') uiInputs[1].props.ref(uiBBBox);
const uiCommit = uiPanel.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnCommit'));
check('the commit button is on screen', uiCommit !== undefined, 'no commit button');
fetchRequests.length = 0;
submitted = null;
if (uiCommit) await uiCommit.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
const commitCall = fetchRequests.find((entry) => entry.url === '/poker/action');
check('an empty amount box still commits the minimum raise',
  commitCall !== undefined && commitCall.body.action === 'raise' && commitCall.body.amount === checkedMeta.view.legal.minRaiseTo,
  JSON.stringify({ call: commitCall && commitCall.body, min: checkedMeta.view.legal.minRaiseTo }));
check('committing posts no chat message', submitted === null, JSON.stringify(submitted));

// While a click is in flight the row says so and withdraws the menu, so a second
// click cannot double up on a table that has already moved.
const uiEntry = globalThis.window.__dshPokerTables.get(uiSession);
globalThis.window.__dshPokerTables.set(uiSession, Object.assign({}, uiEntry, {
  // Mid-send: no replay in flight, the click's own acknowledgement on screen.
  queue: [],
  view: Object.assign({}, uiEntry.view, { sending: 'action', legal: null, resolving: false }),
}));
const sendingTree = setPanel(true, uiSession);
check('a click is acknowledged at once', flatten(sendingTree).includes('\u5df2\u53d1\u51fa'), flatten(sendingTree).slice(-120));
check('the menu is withdrawn while the click is in flight',
  !sendingTree.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-btnRow')),
  'the buttons stayed clickable mid-send');

// ---- the sidebar mark is drawn, not typed ------------------------------------

const bareSidebar = walkAll(render(headerComponent, {}));
const sidebarGlyph = bareSidebar.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-icon'));
check('the sidebar entry draws its own mark', sidebarGlyph !== undefined && sidebarGlyph.type === 'svg'
  && String(sidebarGlyph.props.fill) === 'currentColor',
  sidebarGlyph ? `${sidebarGlyph.type} ${JSON.stringify(sidebarGlyph.props.fill)}` : 'no drawn mark');
const sidebarButton = bareSidebar.find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-headerBtn'));
check('no emoji stands in for the mark', sidebarButton !== undefined && !flatten(sidebarButton).includes('\u{1F0CF}'),
  sidebarButton ? flatten(sidebarButton) : 'no sidebar button');
// The card heads carry the same drawn mark: one emoji left in the transcript made
// the panel look half-converted.
const cardHead = walkAll(render(cardComponent, { block: settledBlock, sessionId: session.id, toolName: 'poker_action' }));
check('the card head uses the drawn mark too',
  !flatten(cardHead).includes('\u{1F0CF}') && cardHead.some((node) => node.type === 'svg' && String(node.props && node.props.className || '').includes('dshp-icon')),
  flatten(cardHead).slice(0, 90));
// Lined up with `sidebar.settings`: that row is laid out in a wrapper 4px wider
// with -2px side margins, so copying it is what puts both marks on one x.
check('the footer row lines up with the settings row',
  /\.dshp-headerRoot\{[^}]*width:calc\(100% \+ 4px\)/.test(sheet) && /\.dshp-headerRoot\{[^}]*margin:4px -2px/.test(sheet),
  'the entry is not laid out like the settings row');
// A bright chip with a pale glyph was the loudest thing in the rail; the tile is a
// dark wash in dark mode instead, with the label colour on top.
check('the mark tile is a themed wash, not a bright chip',
  /\.dshp-iconTile\{[^}]*background:var\(--dsw-alias-fill-l2/.test(sheet)
    && /\.dshp-iconTile\{[^}]*color:var\(--dsw-alias-label-primary/.test(sheet)
    && !/\.dshp-iconTile\{[^}]*button-elevated-fill/.test(sheet),
  'the tile still uses the elevated (bright) fill');
// The settled amount's sign is its own piece: slightly larger than the digits, so
// it reads as "+450" and not as "450 with a speck in front".
check('the win badge centres its sign',
  /\.dshp-badgeWin\{[^}]*display:inline-flex/.test(sheet)
    && /\.dshp-badgeWin\{[^}]*align-items:center/.test(sheet)
    && /\.dshp-badgeSign\{[^}]*font-size:12px/.test(sheet),
  'the win sign is still inline text');
const narrowTree = walkAll(render(headerComponent, { wide: false }));
check('a narrow rail drops the label, keeps the mark',
  narrowTree.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-icon'))
    && !narrowTree.some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-headerState')),
  narrowTree.filter((node) => typeof node.props.className === 'string').map((node) => node.props.className).join(' | ').slice(0, 160));
// The entry has to sit in the footer like the shell's own rows: same height, same
// radius, same type - and the mark in a framed tile rather than a loose glyph.
check('the sidebar row matches the shell rows',
  /\.dshp-headerBtn\{[^}]*height:42px/.test(sheet)
    && /\.dshp-headerBtn\{[^}]*border-radius:12px/.test(sheet)
    && /\.dshp-headerBtn\{[^}]*font-size:14px/.test(sheet)
    && /\.dshp-headerBtn\{[^}]*width:100%/.test(sheet),
  'the sidebar entry does not share the footer row geometry');
check('the sidebar mark sits in a framed tile',
  /\.dshp-iconTile\{[^}]*width:24px;height:24px/.test(sheet)
    && /\.dshp-iconTile\{[^}]*border:\.5px solid/.test(sheet)
    && /\.dshp-iconTile\{[^}]*border-radius:7px/.test(sheet),
  'the mark has no frame of its own');
check('the collapsed rail keeps the round target size',
  /\.dshp-headerBtnRail\{[^}]*width:36px;height:36px/.test(sheet)
    && /\.dshp-headerBtnRail\{[^}]*border-radius:50%/.test(sheet),
  'the rail entry does not match the other rail buttons');
check('the row really renders that tile', sidebarButton !== undefined
  && walkAll(sidebarButton).some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-iconTile')),
  sidebarButton ? flatten(sidebarButton) : 'no sidebar button');

// ---- a finished game offers a rematch ---------------------------------------

// When fewer than two players have chips, `canDealNext` is false and there is no
// legal action - so the whole action area used to render nothing and the player was
// left staring at an empty table with no way forward.
const overView = {
  ...checkedMeta.view,
  gameOver: true,
  canDealNext: false,
  legal: null,
  phase: 'gameover',
  street: 'idle',
  pot: 0,
  board: [],
  startingStack: 5000,
  players: checkedMeta.view.players.map((player, index) => (index === 0
    ? { ...player, stack: 15000 }
    : { ...player, stack: 0, out: true, folded: false })),
};
coachFixtures.set('over-harness', {
  entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'over_call', name: 'poker_action', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'over_call' }, content: [] }, meta: { ...checkedMeta, view: overView } } } },
  ],
  hasMore: false,
  revision: 1,
});
const overTree = setPanel(true, 'over-harness');
const overPanel = overTree.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-over'));
check('a finished game says so and offers a rematch', overPanel !== undefined, flatten(overTree).slice(-140));
check('the rematch card names the win', flatten(overPanel).includes('\u6253\u5149'), flatten(overPanel));
const rematch = overTree.find((node) => node.type === 'button' && flatten(node).includes('\u518d\u6765\u4e00\u5c40'));
check('the rematch button is on the card', rematch !== undefined,
  overTree.filter((node) => node.type === 'button').map((node) => flatten(node)).join(' | ').slice(0, 140));
fetchRequests.length = 0;
submitted = null;
if (rematch) await rematch.props.onClick();
await new Promise((resolve) => process.nextTick(resolve));
const rematchCall = fetchRequests.find((entry) => entry.url === '/poker/new');
check('a rematch reopens the same game',
  rematchCall !== undefined && rematchCall.body.botCount === overView.players.length - 1
    && rematchCall.body.smallBlind === overView.smallBlind && rematchCall.body.bigBlind === overView.bigBlind
    && rematchCall.body.startingStack === overView.startingStack,
  JSON.stringify(rematchCall && rematchCall.body));

// The panel's own title wears the framed mark too - a bordered icon in the sidebar
// and a bare glyph in the panel is exactly "the icon has no border".
const titledPanel = walkAll(render(headerComponent, { sessionId: uiSession }));
const panelTitle = titledPanel.find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-title'));
check('the panel title wears the same framed mark',
  panelTitle !== undefined && walkAll(panelTitle).some((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-iconTile'))
    && walkAll(panelTitle).some((node) => node.type === 'svg'),
  panelTitle ? flatten(panelTitle) : 'no panel title');

// ---- an unsettled (running) call must render a placeholder, not throw ----

let running;
try {
  running = render(cardComponent, { block: { kind: 'tool-call', call: { name: 'poker_action', argsRaw: '{}' } }, sessionId: session.id, toolName: 'poker_action' });
} catch (error) {
  failures.push(`rendering a running call threw :: ${error && error.message}`);
}
check('a running call renders a placeholder', flatten(running).includes('\u5fb7\u5dde\u6251\u514b'), flatten(running));

// ---- a card shape the plugin does not own must fall back, not crash -------

const foreign = render(cardComponent, {
  block: { kind: 'tool-result', meta: { view: { something: 'else' } }, content: [], call: { name: 'poker_action', argsRaw: '{}' } },
  sessionId: session.id,
  toolName: 'poker_action',
});
check('a foreign payload falls back to a placeholder row', flatten(foreign).includes('\u5fb7\u5dde\u6251\u514b'), flatten(foreign).slice(0, 120));

// ---- after the hero folds, the WHOLE rest of the hand is still replayed ----

// The complaint this guards: folding used to jump straight to the settled hand,
// so the player who folded never saw the hand play out. A hand where the bots
// fold around immediately would be a weak test, so find a seed whose hand runs
// all the way to the river after the hero folds.
const newTableTool = registered.get('poker_new_table');
const actionTool = registered.get('poker_action');
const foldSession = { id: 'fold-harness' };
const foldExec = { agent: { session: foldSession } };
// The scan plays scratch tables to completion, so it must not touch the table
// the browser is about to play: a separate session owns those.
const scanExec = { agent: { session: { id: 'fold-scan' } } };

let foldSeed = null;
let foldBeats = 0;
for (let seed = 901; seed <= 960 && foldSeed === null; seed += 1) {
  const open = await newTableTool.execute({ botCount: 5, startingStack: 10000, smallBlind: 50, bigBlind: 100, seed }, scanExec);
  const folded = await actionTool.execute({ action: 'fold' }, scanExec);
  const beats = Number(folded.view.actionSeq) - Number(open.view.actionSeq);
  if (beats >= 12 && Array.isArray(folded.view.board) && folded.view.board.length === 5) {
    foldSeed = seed;
    foldBeats = beats;
  }
}
check('a seed was found whose hand plays on after a fold', foldSeed !== null, 'no seed reached the river with 12+ actions');

if (foldSeed !== null) {
  // The real table for the click: freshly dealt from the same seed, still on the
  // hero's preflop turn.
  const foldOpen = await newTableTool.execute({ botCount: 5, startingStack: 10000, smallBlind: 50, bigBlind: 100, seed: foldSeed }, foldExec);
  const foldOpenMeta = newTableTool.output.presentationMeta({}, foldOpen);
  check('the seeded table waits for the hero', foldOpen.view.phase === 'betting' && foldOpen.view.legal && foldOpen.view.legal.canFold === true, JSON.stringify(foldOpen.view.legal));
  foldWindow = {
    entries: [
      { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'fold_a', name: 'poker_new_table', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'fold_a' }, content: [] }, meta: foldOpenMeta } } },
    ],
    hasMore: false,
    revision: 1,
  };
  // The first paint seeds the page's cache from this session's log, so the click
  // has a state on screen to replay forward from.
  render(headerComponent, { sessionId: foldSession.id });

  const foldBlock = {
    kind: 'tool-result',
    meta: foldOpenMeta,
    content: [],
    call: { name: 'poker_action', argsRaw: '{"action":"fold"}' },
  };
  const foldCard = render(cardComponent, { block: foldBlock, sessionId: foldSession.id, toolName: 'poker_action' });
  const foldButton = walkAll(foldCard).find((node) => node.type === 'button' && String(node.props.className || '').includes('dshp-btnDanger'));
  check('the hero can fold from the card', foldButton !== undefined, flatten(foldCard).slice(0, 200));

  pendingTimers.length = 0;
  fetchRequests.length = 0;
  if (foldButton) await foldButton.props.onClick();
  check('folding calls the route', fetchRequests.length === 1 && fetchRequests[0].body.action === 'fold', JSON.stringify(fetchRequests[0] && fetchRequests[0].body));

  // Only one beat is queued at a time - each beat queues the next - so the hand
  // is counted as it plays instead of read off the queue up front.
  /**
   * How many community cards a rendered table shows. The board is only ever the
   * cards that are OUT (no dashed placeholders), so this counts the faces in the
   * board row - the seats' own hole cards are in their own tiles, not here.
   */
  const boardSize = (tree) => {
    const row = walkAll(tree).find((node) => String(node.props && node.props.className || '').split(' ').includes('dshp-boardRow'));
    if (row === undefined) return 0;
    return walkAll(row).filter((node) => {
      const names = String(node.props && node.props.className || '').split(' ');
      return names.includes('dshp-card') && !names.includes('dshp-cardEmpty');
    }).length;
  };
  /** What the replay indicator says on this beat: a deal, or an action. */
  const replayLine = (tree) => {
    const node = walkAll(tree).find((child) => String(child.props && child.props.className || '').includes('dshp-resolving'));
    return node ? flatten(node) : '';
  };
  const foldBeat = pendingTimers.shift();
  check('the hero fold waits its beat too', foldBeat !== undefined && foldBeat.delay >= 240, JSON.stringify(foldBeat && foldBeat.delay));
  const boardSeen = [];
  const opponentDelays = [];
  let dealtAnimation = false;
  let progressText = '';
  let beats = 0;
  let actionBeats = 0;
  let dealBeats = 0;
  let startBoard = null;
  if (foldBeat) {
    foldBeat.fn();
    startBoard = boardSize(render(cardComponent, { block: foldBlock, sessionId: foldSession.id, toolName: 'poker_action' }));
    // Step the rest of the hand one action at a time and watch the felt: the
    // board must fill street by street and the indicator must count the moves off.
    let guard = 0;
    while (pendingTimers.length > 0 && guard < 400) {
      guard += 1;
      const timer = pendingTimers.shift();
      opponentDelays.push(timer.delay);
      timer.fn();
      beats += 1;
      const snapshot = render(cardComponent, { block: foldBlock, sessionId: foldSession.id, toolName: 'poker_action' });
      const names = classes(snapshot);
      const size = boardSize(snapshot);
      const line = replayLine(snapshot);
      // A beat that puts a card on the felt is a DEAL, not an action: the replay
      // deals the flop, turn and river one card at a time.
      if (size > (boardSeen.length > 0 ? boardSeen[boardSeen.length - 1] : 0)) dealBeats += 1;
      else actionBeats += 1;
      boardSeen.push(size);
      if (names.includes('dshp-dealIn')) dealtAnimation = true;
      // The action counter only moves on an action, so read it off the first of
      // those - the first beats are the flop being dealt.
      if (progressText === '' && line.includes('\u5bf9\u624b\u884c\u52a8\u4e2d') && !line.includes('\u53d1\u724c')) progressText = flatten(snapshot);
    }
  }
  check('folding plays out every remaining action', actionBeats === foldBeats - 1, `${actionBeats} action beats for ${foldBeats - 1} remaining actions (${beats} beats, ${dealBeats} deals)`);
  check('more actions are replayed than the old four-beat cap', actionBeats > 4, `${actionBeats} beats`);
  check('every opponent move waits its turn', opponentDelays.every((delay) => delay >= 240), JSON.stringify(opponentDelays));
  check('no beat is rushed through', opponentDelays.every((delay) => delay <= 1500), JSON.stringify(opponentDelays));
  check('a new street is dealt on a longer beat', opponentDelays.some((delay) => delay >= 1000), JSON.stringify(opponentDelays));
  check('the replay counts the actions off', new RegExp(`2/${foldBeats}`).test(progressText), progressText.slice(-220));
  check('the replay names the action it is showing', /\u5bf9\u624b\u884c\u52a8\u4e2d|BB|\u8ddf\u6ce8|\u8fc7\u724c|\u52a0\u6ce8|\u5f03\u724c/.test(progressText), progressText.slice(-220));
  check('the whole board is dealt out after the fold', boardSeen.includes(3) && boardSeen.includes(4) && boardSeen.includes(5), JSON.stringify(boardSeen));
  check('the board only ever grows', boardSeen.every((size, index) => index === 0 || size >= boardSeen[index - 1]), JSON.stringify(boardSeen));
  // Dealing is slow and card by card: never two community cards on one beat, and
  // the flop is three separate beats rather than one jump to three cards.
  check('cards are dealt one at a time', boardSeen.every((size, index) => index === 0 || size - boardSeen[index - 1] <= 1), JSON.stringify(boardSeen));
  check('the flop arrives as three cards, not one jump', boardSeen.includes(1) && boardSeen.includes(2), JSON.stringify(boardSeen));
  check('the replay starts from the preflop felt', startBoard === 0 && boardSeen[0] <= 1, JSON.stringify({ startBoard, first: boardSeen[0] }));
  check('a dealt street animates in', dealtAnimation, 'no deal animation on any replayed street');

  const afterFold = render(cardComponent, { block: foldBlock, sessionId: foldSession.id, toolName: 'poker_action' });
  const afterFoldText = flatten(afterFold);
  check('the replay ends on the settled hand', !/\u5bf9\u624b\u884c\u52a8\u4e2d/.test(afterFoldText), afterFoldText.slice(-200));
  check('the hand really finished after the fold', lastRouteAnswer !== null && lastRouteAnswer.view.phase !== 'betting', lastRouteAnswer && lastRouteAnswer.view.phase);
  check('the settled hand shows all five board cards', lastRouteAnswer !== null && lastRouteAnswer.view.board.length === 5, JSON.stringify(lastRouteAnswer && lastRouteAnswer.view.board));
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} client-half checks passed`);
}
