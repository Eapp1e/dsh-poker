/**
 * Hot-reload harness: prove that editing the implementation is picked up by a
 * RUNNING plugin instance - no restart, no re-import of the entry file, and no
 * loss of the tables already open.
 *
 * It runs against a throwaway copy of the entry shim plus six stub
 * implementation files, so the test never touches the real poker logic and
 * never depends on its behaviour: the stub reports which revision it is, which
 * is exactly what the harness needs to observe.
 *
 *   node test/hot.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const entrySource = path.join(here, '..', 'lib', 'index.js');

// A scratch plugin package: the real entry file, stub logic beside it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-hot-harness-'));
fs.copyFileSync(entrySource, path.join(root, 'index.js'));
// A scratch PACKAGE needs its own manifest: module type is resolved from the file's
// directory upwards, and a bare temp dir gives `.js` files CommonJS - so every
// `import` in the entry would be a syntax error, under one runner and not another.
fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
for (const file of ['engine.js', 'bots.js', 'cards.js', 'evaluator.js', 'render.js']) {
  fs.writeFileSync(path.join(root, file), 'export const stub = true;\n', 'utf8');
}

/** A stub implementation that only reports its own revision. */
function stub(marker) {
  return `const VERSION = '${marker}';
export const HERO_SEAT = 0;
export const POKER_OPS = {};
export const roster = () => 'stub-opponent';
export const buildView = (state) => ({ tableId: state.tableId, revision: state.revision });
export const renderTable = () => 'stub-table';
export const opNew = (args) => ({ tableId: 'stub-table', revision: 0, actionSeq: 0, actionLog: [], asked: args.marker ?? null });
export const opAction = (table) => ({ ...table, acted: (table.acted ?? 0) + 1 });
export const opNextHand = (table) => ({ ...table, dealt: true });
export const opOpponent = (table) => ({ state: table, note: 'stub' });
export const payload = (state) => ({ text: 'impl ' + VERSION, view: { marker: VERSION, tableId: state.tableId, acted: state.acted ?? 0 }, meta: null });
export const tablePayload = () => ({ text: 'impl ' + VERSION, view: { marker: VERSION }, meta: null });
export const equityPayload = () => ({ text: 'impl ' + VERSION, view: { marker: VERSION }, meta: null });
`;
}

// A unique marker per run keeps this test's stage directory identifiable.
const run = `${Date.now().toString(36)}`;
const markerA = `A${run}`;
const markerB = `B${run}-second`;
const markerC = `C${run}-third-longer`;

fs.writeFileSync(path.join(root, 'impl.js'), stub(markerA), 'utf8');

const registrations = new Map();
const ctx = {
  tools: {
    register(definition) {
      registrations.set(definition.name, definition);
      return () => registrations.delete(definition.name);
    },
  },
  effect: (callback) => callback(),
  get: () => undefined,
};

const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href);
plugin.apply(ctx);

const session = { id: 'hot-session' };
const exec = { agent: { session } };
const newTable = registrations.get('poker_new_table');
const act = registrations.get('poker_action');
const toolExec = newTable.execute;

check('the scratch entry registered its tools', registrations.size === 6, [...registrations.keys()].join(','));

const opened = await newTable.execute({ marker: 'first' }, exec);
check('the first call uses the code on disk', opened.text === `impl ${markerA}`, opened.text);
check('the payload carries the view', opened.view && opened.view.marker === markerA, JSON.stringify(opened.view));

// ── the edit that used to need a host restart ───────────────────────────────

fs.writeFileSync(path.join(root, 'impl.js'), stub(markerB), 'utf8');
const reloaded = await act.execute({ action: 'call' }, exec);
check('an edit is picked up without a restart', reloaded.text === `impl ${markerB}`, reloaded.text);
check('the table registry survived the reload', reloaded.view.tableId === 'stub-table', JSON.stringify(reloaded.view));
check('the edited logic ran against the live table', reloaded.view.acted === 1, String(reloaded.view.acted));
check('the reload is announced to the player once', reloaded.view.reload && typeof reloaded.view.reload.clock === 'string', JSON.stringify(reloaded.view.reload));
check('the reload notice names the changed file', reloaded.view.reload.files.includes('impl.js'), JSON.stringify(reloaded.view.reload.files));

const second = await act.execute({ action: 'call' }, exec);
check('the notice is not repeated on every call', second.view.reload === undefined, JSON.stringify(second.view.reload));
check('the second call keeps the reloaded code', second.text === `impl ${markerB}`, second.text);
check('the reloaded code kept counting on the same table', second.view.acted === 2, String(second.view.acted));
check('the tool registration itself was never redone', registrations.get('poker_new_table').execute === toolExec);

// A staged copy must be importable ON ITS OWN TERMS: module type is resolved from
// the file's directory upwards, and the stage sits in the OS temp dir where nothing
// of ours is in scope. Without a manifest beside the copies they load as CommonJS
// and every `import` line is a syntax error - which is how a reload could fail on
// one runner and quietly fall back to the previous implementation.
const stageRoot = fs.readdirSync(os.tmpdir())
  .filter((name) => name.startsWith('dsh-plugin-poker-hot-'))
  .map((name) => path.join(os.tmpdir(), name))
  .filter((dir) => fs.statSync(dir).isDirectory())
  .flatMap((dir) => fs.readdirSync(dir).map((rev) => path.join(dir, rev)))
  .filter((dir) => fs.existsSync(path.join(dir, 'impl.js')));
const newestStage = stageRoot
  .map((dir) => ({ dir, at: fs.statSync(path.join(dir, 'impl.js')).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0];
const stageManifest = newestStage ? path.join(newestStage.dir, 'package.json') : '';
check('a staged revision ships its own module manifest',
  stageManifest !== '' && fs.existsSync(stageManifest), newestStage ? newestStage.dir : 'no staged revision found');
if (stageManifest && fs.existsSync(stageManifest)) {
  const parsed = JSON.parse(fs.readFileSync(stageManifest, 'utf8'));
  check('the staged manifest marks the copies as ESM', parsed.type === 'module', JSON.stringify(parsed));
  check('the staged copies still sit next to the manifest',
    fs.existsSync(path.join(path.dirname(stageManifest), 'impl.js')), path.dirname(stageManifest));
}

// The loader reports what it is running, which is also how a stuck reload is
// diagnosed in a live host.
const state = plugin.hotState();
check('the loader state names the loaded revision', state.loaded === state.revision, JSON.stringify(state));
check('the loaded revision is staged, not imported in place', state.staged === true, JSON.stringify(state));
check('a clean reload leaves no error behind', state.lastError === '', JSON.stringify(state));

// The snapshot is what makes the reload consistent: the code is imported from a
// staged copy of every implementation file, not from the edited originals.
const stageRoots = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-plugin-poker-hot-'));
const stages = [];
for (const stageRoot of stageRoots) {
  const dir = path.join(os.tmpdir(), stageRoot);
  for (const name of fs.readdirSync(dir)) {
    const candidate = path.join(dir, name, 'impl.js');
    if (fs.existsSync(candidate) && fs.readFileSync(candidate, 'utf8').includes(markerB)) stages.push(path.join(dir, name));
  }
}
check('the reload was served from a staged snapshot', stages.length === 1, `${stages.length} snapshots carried the edit`);
check(
  'the snapshot holds every implementation file',
  stages.length === 1 && ['impl.js', 'engine.js', 'bots.js', 'cards.js', 'evaluator.js', 'render.js'].every((file) => fs.existsSync(path.join(stages[0], file))),
  stages[0] ?? 'no snapshot',
);

// ── a half-saved file must not take the table down ──────────────────────────

fs.writeFileSync(path.join(root, 'impl.js'), 'export const opNew = ( {\n', 'utf8');
let survived = null;
try {
  survived = await act.execute({ action: 'call' }, exec);
} catch (error) {
  survived = { text: `threw :: ${error && error.message}` };
}
check('a syntax error keeps the last working code serving', survived.text === `impl ${markerB}`, survived.text);
check('the loader reports the failure it survived', plugin.hotState().lastError !== '', JSON.stringify(plugin.hotState()));

fs.writeFileSync(path.join(root, 'impl.js'), stub(markerC), 'utf8');
const fixed = await act.execute({ action: 'call' }, exec);
check('fixing the file reloads again', fixed.text === `impl ${markerC}`, fixed.text);
// Three actions have now been applied to the one live table: the reload, the
// call served by the last good code while the file was broken, and this one.
check('the table is still the same one', fixed.view.tableId === 'stub-table' && fixed.view.acted === 4, JSON.stringify(fixed.view));

// ── cleanup ─────────────────────────────────────────────────────────────────

for (const stageRoot of stageRoots) {
  const dir = path.join(os.tmpdir(), stageRoot);
  for (const name of fs.readdirSync(dir)) {
    try {
      const candidate = path.join(dir, name, 'impl.js');
      if (fs.existsSync(candidate) && fs.readFileSync(candidate, 'utf8').includes(run)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    } catch {
      // A snapshot this test cannot remove is not a failure.
    }
  }
}
fs.rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} hot-reload checks passed`);
}
