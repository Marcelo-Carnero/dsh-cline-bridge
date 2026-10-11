/**
 * Release gate: build, pack, then install the REAL tarball into a clean
 * directory and assert the published surface.
 *
 * Why this exists: `dsh plugin add <repo>` installs git source, and pnpm >=10
 * refuses to run a git dependency's `prepare` script until the user allows it.
 * Shipping prebuilt `lib/` in the tarball removes that permission entirely, and
 * this script is the proof that what we publish is what we tested: the tarball
 * is unpacked into a temp directory, never symlinked from this working tree.
 *
 * Steps:
 *   1. npm run build   (must be clean)
 *   2. npm run test    (unit + HTTP/MCP security suite)
 *   3. npm pack        -> .tgz
 *   4. unpack and assert the published surface:
 *      - lib/ + lib/types present (prebuilt, no build needed at install time)
 *      - cordis.patch.yml present (the bundle patch DSH applies)
 *      - README.md / SECURITY.md / CHANGELOG.md / LICENSE present
 *      - no src/, no test/, no ref-*, no .token, no logs leaked
 *      - package.json still declares the dsh bundle patch
 *   5. load the unpacked build as a real ES module and assert the config and
 *      auth guards still hold on the published code.
 *
 * No DSH binary is required: step 5 exercises the published `lib/` build, which
 * is exactly the code DSH's loader will import.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Package root = the directory that contains this script's parent (scripts/).
// `new URL('..')` resolves to a trailing-slash URL, so normalize before dirname.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const require = createRequire(import.meta.url);

/**
 * Run a step of the gate.
 *
 * Node scripts are invoked with this same `node` binary — no shell, no `.cmd`
 * shim indirection — so a child failure is always visible as a real status code.
 * `npm pack` likewise runs npm's own JS CLI, because a `.cmd` shim under a
 * shell on Windows can hang when the parent redirects the child's stdio.
 */
function run(label, args, { cwd = root } = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd, stdio: 'inherit' });
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    console.error(
      `\nx release test failed at: ${label} (status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'})`,
    );
    process.exit(result.status ?? 1);
  }
}

const NODE = process.execPath;

function fail(message) {
  console.error(`\nx ${message}`);
  process.exit(1);
}

/**
 * Locate npm's own JS CLI (`npm-cli.js`), so the pack step can run it with this
 * same node binary. A `.cmd` shim under a shell on Windows can hang when the
 * parent redirects the child's stdio, so the shim is never used here.
 *
 * The bundled npm sits next to the node binary, but the layout differs per OS:
 *   Windows : <dir(node)>/node_modules/npm/bin/npm-cli.js
 *   Linux   : <dir(node)>/../lib/node_modules/npm/bin/npm-cli.js   (apt/node tarball)
 *   nvm/mac : <dir(node)>/../lib/node_modules/npm/bin/npm-cli.js
 * A locally installed npm under the project always wins when present, so the
 * gate behaves identically on a dev box and on a CI runner.
 */
function findNpmCli() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail('npm CLI not found; install dev dependencies (npm) or run this gate with npm available');
}
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(join(dir, entry)).isDirectory()) out.push(...walk(join(dir, entry), rel));
    else out.push(rel);
  }
  return out;
}

console.log('-> build');
run('build', [NODE, join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')]);
console.log('-> unit + security tests');
run('test', [NODE, join(root, 'scripts', 'test.mjs')]);

console.log('-> npm pack');
rmSync(join(root, 'release-test.tmp'), { recursive: true, force: true });
mkdirSync(join(root, 'release-test.tmp'), { recursive: true });
// Run npm's JS CLI with this same node binary: a `.cmd` shim under a shell on
// Windows can hang when the parent redirects the child's stdio.
run('pack', [NODE, findNpmCli(), 'pack', '--pack-destination', 'release-test.tmp', '--ignore-scripts', '--no-audit', '--no-fund']);
const packedDir = join(root, 'release-test.tmp');
const tarball = readdirSync(packedDir).find((name) => name.endsWith('.tgz'));
if (tarball === undefined) fail('npm pack produced no tarball');

// Unpack inside the project tree, not in the OS temp dir: the published build
// imports its runtime deps, and resolving them from here mirrors a DSH profile
// that provides the peer packages. release-test.tmp/ is gitignored.
const pkgRoot = join(packedDir, 'package');
mkdirSync(pkgRoot, { recursive: true });
// Unpack with the system tar: `node:tar` is not a stable builtin on Node 24, and
// adding a tar dependency to a security-sensitive package is a bad trade. npm
// pack output is a standard gzipped tarball with a `package/` prefix.
const extract = spawnSync('tar', ['-xzf', join(packedDir, tarball), '-C', pkgRoot, '--strip-components=1'], { stdio: 'inherit' });
if (extract.status !== 0) fail('failed to unpack the npm pack tarball');
const files = walk(pkgRoot);

console.log(`-> inspecting tarball (${files.length} files)`);
for (const required of [
  'lib/index.js', 'lib/mcp.js', 'lib/bridge.js', 'lib/config.js', 'lib/types/index.d.ts',
  'cordis.patch.yml', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'package.json',
]) {
  if (!files.includes(required)) fail(`published tarball is missing ${required}`);
}

// Nothing that must never ship may ship: sources, tests, local notes, tokens,
// logs, env files and build info.
for (const forbidden of ['src', 'test', 'node_modules']) {
  if (files.some((f) => f === forbidden || f.startsWith(`${forbidden}/`))) fail(`published tarball leaks ${forbidden}/`);
}
for (const pattern of [/^ref-/, /\.token$/, /\.log$/, /(^|\/)\.env/, /\.tsbuildinfo$/]) {
  const leaked = files.find((f) => pattern.test(f));
  if (leaked !== undefined) fail(`published tarball leaks ${leaked}`);
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-cline-bridge');
// Authorship must survive into the published artifact, so the npm registry page
// and every `npm ls` point at the real maintainer — not at a copied template.
assert.ok(pkg.author, 'package.json must declare an author');
assert.match(pkg.author, /Marcelo F\. Carnero/, 'package.json author must be the real maintainer');
assert.match(pkg.author, /mcarnero1968@gmail\.com/, 'package.json author must carry the maintainer contact');
assert.ok(pkg.dsh?.bundle?.patch, 'package.json must declare dsh.bundle.patch');
assert.ok(pkg.files.includes('lib'), 'package.json must publish lib/');
assert.ok(pkg.files.includes('cordis.patch.yml'), 'package.json must publish cordis.patch.yml');

const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /cline-bridge/, 'cordis.patch.yml must insert the cline-bridge row');
assert.match(patch, /127\.0\.0\.1/, 'cordis.patch.yml must keep the loopback default');

console.log('-> loading the published build');
const config = await import(pathToFileURL(join(pkgRoot, 'lib', 'config.js')).href);
assert.equal(config.isLoopbackHost('127.0.0.1'), true);
assert.equal(config.isLoopbackHost('localhost'), true);
assert.equal(config.isLoopbackHost('::1'), true);
assert.equal(config.isLoopbackHost('0.0.0.0'), false);
assert.equal(config.bridgeHttpUrl('127.0.0.1', 3457), 'http://127.0.0.1:3457/mcp');
assert.throws(
  () => config.resolveConfig({ authMode: 'none', host: '0.0.0.0' }, {}),
  /loopback/,
  'published build must refuse authMode none on a non-loopback host',
);
const resolved = config.resolveConfig(
  { authMode: 'token', authToken: 'release-gate-token-value-0123456789' },
  { DSH_HOME: join(pkgRoot, '.dsh-home') },
);
assert.equal(resolved.authMode, 'token');
assert.equal(resolved.port, 3457);
assert.equal(resolved.host, '127.0.0.1');

// The published build must expose exactly the documented tool surface.
const mcp = await import(pathToFileURL(join(pkgRoot, 'lib', 'mcp.js')).href);
const logMod = await import(pathToFileURL(join(pkgRoot, 'lib', 'log.js')).href);
const logger = logMod.createBridgeLogger({ level: 'error', dshHome: resolved.dshHome, stdioSafe: false });
const server = mcp.createMcpServer(
  {
    async health() { return { status: 'ok' }; },
    async listWorkspaces() { return []; },
    async createSession() { return {}; },
    async listSessions() { return []; },
    async getSession() { return {}; },
    async sendMessage() { return {}; },
    async getTaskStatus() { return {}; },
    async getResult() { return {}; },
    async cancelTask() { return {}; },
    async answerQuestion() { return {}; },
    async approve() { return {}; },
  },
  resolved,
  logger,
);
const internal = server.server;
const registered = Object.keys(internal?._registeredTools ?? {});
if (registered.length === 0) {
  console.log('  (tool registry is not introspectable on this SDK build; the unit suite covers the tool list)');
} else {
  assert.deepEqual(
    registered.slice().sort(),
    [...mcp.BRIDGE_TOOL_NAMES].slice().sort(),
    'published build must expose exactly the documented bridge tools',
  );
}
await server.close();

// The runtime deps the tarball relies on must resolve the way DSH will resolve
// them; peer deps are supplied by the DSH profile, not by this package.
// Resolve every external specifier the PUBLISHED build imports, not just the
// bare dependency names: a dependency can be installed while the subpath this
// package actually imports is not.
// The clause between `import`/`export` and `from` is matched without quotes or
// semicolons so the scan can never jump across statements.
const FROM_RE = /(?:^|\n)[ \t]*(?:import|export)\b[^'";\n]*?\bfrom[ \t]*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g;
const external = new Set();
for (const rel of files.filter((f) => f.startsWith('lib/') && f.endsWith('.js'))) {
  const source = readFileSync(join(pkgRoot, rel), 'utf8');
  for (const re of [FROM_RE, BARE_RE]) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (!spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('/')) external.add(spec);
    }
  }
}
if (external.size === 0) fail('no external imports found in the published build; the scan itself is broken');
for (const spec of external) {
  try {
    require.resolve(spec, { paths: [root] });
  } catch {
    fail(`published build imports "${spec}", which is not resolvable; the tarball would not load in a DSH profile`);
  }
}
console.log(`  resolved ${external.size} external import specifier(s) from the published build`);

rmSync(packedDir, { recursive: true, force: true });
console.log('\nOK release package test passed: the published tarball is prebuilt, loadable, loopback-only and leak-free');