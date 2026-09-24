/**
 * Packaging contract suite: the things a plugin REGISTRY checks before listing this
 * package, asserted against the repository itself.
 *
 *   node test/pack.mjs
 *
 * The community list's inclusion rule is, verbatim: "An entry is added when the
 * plugin installs with `dsh plugin add`, does what its one-line description says,
 * sits in the right category, and is maintained. Every submission is checked
 * against its own source before merging." The first and second of those are things
 * this file can enforce: the manifest must be installable, and the one-line
 * description must match what the README says the plugin does.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const local = (...parts) => path.join(here, ...parts);
const read = (...parts) => fs.readFileSync(local(...parts), 'utf8');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

const manifest = JSON.parse(read('..', 'package.json'));
const readme = read('..', 'README.md');
const changelog = read('..', 'CHANGELOG.md');

// ── it installs with `dsh plugin add` ──────────────────────────────────────

check('the package declares a name', manifest.name === 'dsh-plugin-poker', String(manifest.name));
check('the package is not private', manifest.private !== true, String(manifest.private));
check('the package publishes publicly', manifest.publishConfig && manifest.publishConfig.access === 'public',
  JSON.stringify(manifest.publishConfig));
// The whole installer path hangs off this one declaration: `dsh plugin add` reads
// `dsh.bundle.patch`, and without it the package is just an ordinary dependency.
check('the manifest declares a bundle patch',
  manifest.dsh && manifest.dsh.bundle && typeof manifest.dsh.bundle.patch === 'string',
  JSON.stringify(manifest.dsh));
check('the declared patch file exists', fs.existsSync(local('..', 'cordis.patch.yml')), 'missing cordis.patch.yml');
check('the patch ships in the tarball', Array.isArray(manifest.files) && manifest.files.includes('cordis.patch.yml'),
  JSON.stringify(manifest.files));
const patch = read('..', 'cordis.patch.yml');
// One insert, and it names this package exactly once: a bundle that loads itself
// twice collides on tool names, which is the failure the README warns about.
check('the patch inserts exactly one row', (patch.match(/- insert:/g) || []).length === 1, patch);
check('the patch names this package', patch.includes(`name: '${manifest.name}'`), patch);
check('the patch carries an id', /^\s*-?\s*id:\s*\S+/m.test(patch), patch);

// ── it is a two-faced plugin, and both faces are exported ──────────────────

check('the host half is the main entry', manifest.main === 'lib/index.js', String(manifest.main));
check('the host half is exported', manifest.exports && manifest.exports['.'] === './lib/index.js',
  JSON.stringify(manifest.exports));
check('the client half is exported', manifest.exports && manifest.exports['./client'] === './lib/client.js',
  JSON.stringify(manifest.exports));
check('the client half declares the web platform',
  manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web',
  JSON.stringify(manifest.dsh && manifest.dsh.client));
check('the client bundle exists', fs.existsSync(local('..', 'lib', 'client.js')), 'missing lib/client.js');

// The client half may only require platform-baseline modules. React is baseline, so
// no `dsh.client.external` is needed - anything else would need one, and a reviewer
// would have to verify it resolves.
const clientSource = read('..', 'lib', 'client.js');
const requires = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2]);
check('the client half only requires the platform baseline', requires.every((name) => name === 'react'),
  requires.join(', ') || 'no requires');
check('no non-baseline externals are declared',
  !manifest.dsh.client.external || manifest.dsh.client.external.length === 0,
  JSON.stringify(manifest.dsh.client.external));

// ── the one-line description matches what the package does ─────────────────

const description = String(manifest.description || '');
check('there is a description', description.length > 20, description);
check('the description is ONE line', !description.includes('\n'), description);
check('the description is one sentence-ish, not a paragraph', description.length <= 180, `${description.length} chars`);
// The reviewer's phrase is "does what its one-line description says": every noun it
// claims has to be findable in the README the reviewer reads.
for (const claim of ['DeepSeek Harness', "Hold'em", 'tools', 'opponents', 'coach', 'table']) {
  check(`the README backs the claim "${claim}"`, readme.toLowerCase().includes(claim.toLowerCase()),
    description);
}
check('the README repeats the same one-liner', readme.includes(description), description);

// ── maintained: license, changelog, CI, and a suite that needs no install ──

check('the license is declared', typeof manifest.license === 'string' && manifest.license.length > 0, String(manifest.license));
check('a LICENSE file exists', fs.existsSync(local('..', 'LICENSE')), 'missing LICENSE');
const license = read('..', 'LICENSE');
check('the LICENSE matches the declared license', license.includes(manifest.license), license.split('\n')[0]);
check('the LICENSE is dated, not placeholder text', /Copyright \(c\) 20\d\d/.test(license), license.split('\n')[2]);
check('a CHANGELOG exists', fs.existsSync(local('..', 'CHANGELOG.md')), 'missing CHANGELOG.md');
check('the changelog has this release', /## \[0\.1\.0\]/.test(changelog), changelog.slice(0, 120));
check('a CI workflow exists', fs.existsSync(local('..', '.github', 'workflows', 'test.yml')), 'missing CI');
const ci = read('..', '.github', 'workflows', 'test.yml');
check('CI runs the suite', ci.includes('npm test'), ci);
check('the test script runs every suite',
  ['run.mjs', 'host.mjs', 'client.mjs', 'coach.mjs', 'hot.mjs', 'pack.mjs']
    .every((suite) => String(manifest.scripts.test).includes(suite)),
  String(manifest.scripts.test));
check('there are no runtime dependencies',
  !manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
  JSON.stringify(manifest.dependencies));

// ── the repository is publishable: no machine paths, no scratch files ──────

const shipped = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];
for (const file of shipped) {
  const text = read('..', file);
  check(`${file} has no absolute machine path`, !/[A-Za-z]:\\\\|[A-Za-z]:\/(Users|DeepSeekHarness)/.test(text), file);
}
// Scratch markers are checked in the CODE and CONFIG only: the docs legitimately
// name the patterns they forbid ("no tmp- files left"), which would trip a check
// that scanned them too.
for (const file of ['package.json', 'cordis.patch.yml']) {
  check(`${file} has no scratch marker left`, !/tmp-|TODO:|FIXME/.test(read('..', file)), file);
}
for (const dir of ['lib', 'test']) {
  // This file is skipped: it is the one that DEFINES the markers, so it necessarily
  // contains them - the same self-reference the docs hit above.
  const files = fs.readdirSync(local('..', dir)).filter((name) => /\.(js|mjs)$/.test(name) && name !== 'pack.mjs');
  for (const file of files) {
    const text = read('..', dir, file);
    check(`${dir}/${file} has no scratch marker left`, !/\bTODO:|FIXME/.test(text), file);
  }
}
const stray = fs.readdirSync(local('..')).filter((name) => name.startsWith('tmp-') || name.endsWith('.tgz'));
check('no scratch files in the repository root', stray.length === 0, stray.join(', '));

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} packaging checks passed`);
}
