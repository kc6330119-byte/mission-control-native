// npm run measure: one table comparing the Node version (server.js) and the native app (the release bundle)
// on this Mac. Every number is measured when the script runs; nothing is typed in. Where a fair comparison
// isn't possible, the table says so instead of printing a number.
//
// It uses no network: the Node version is reached on 127.0.0.1 only, and the app opens no port. It works on
// scratch copies of the data in target/measure/ and, for the app, its own settings folder, which it puts
// back as it found it. Build the app first with `npm run build:app`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBundle } from './build-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'tauri.conf.json'), 'utf8'));
const APP = appBundle('release');
const APP_EXE = path.join(APP, 'Contents', 'MacOS', 'mission-control');
const DATA = path.resolve(REPO, process.env.MC_TEST_DATA || 'sample-workspace');
const OUT = path.join(REPO, 'target', 'measure');
const SETTINGS_DIR = path.join(os.homedir(), 'Library', 'Application Support', CONF.identifier);
const RUNS = 5;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Nothing this script prints may hold a home-folder path ("/Users" and a slash on a Mac, worked out here so
// this file doesn't spell it out): a line that would is not printed, and the script stops.
const HOMES = `${path.dirname(os.homedir())}/`;
const safe = (text) => {
  if (String(text).includes(HOMES)) {
    process.stderr.write('measure: stopped. A line it was about to print contains a home-folder path, so nothing more is printed.\n');
    process.exit(1);
  }
  return text;
};
const say = (line) => process.stderr.write(`${safe(line)}\n`);
const fail = (line) => { console.error(safe(line)); process.exit(1); };
// An unexpected error prints its message only (a stack trace would show file paths), and goes through the guard too.
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, (err) => fail(`measure: failed: ${err?.message ?? err}`));

// ---------- before anything: the release bundle is there, and it is the normal build ----------
if (!fs.existsSync(APP_EXE)) fail(`No release bundle at ${path.relative(REPO, APP)}. Run: npm run build:app`);
const appBinary = fs.readFileSync(APP_EXE).toString('latin1');
if (appBinary.includes('MC_PROBE')) fail('The release bundle contains the probe. Rebuild it with: npm run build:app');
if (sh('pgrep', ['-f', APP_EXE]).stdout.trim()) fail(`${CONF.productName} is already running. Quit it first, so every run starts the same way.`);
if (!fs.existsSync(path.join(REPO, 'server.js'))) fail('server.js is missing; the Node version is needed for the comparison.');

// ---------- helpers ----------
const kb = (p) => Number(sh('du', ['-sk', p]).stdout.split('\t')[0]) || 0; // allocated on disk, in KB
const mb = (k) => `${(k / 1024).toFixed(1)} MB`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const range = (xs) => `${Math.min(...xs)}–${Math.max(...xs)}`;
const isMacOSPart = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// The memory macOS charges to a process (its footprint, Activity Monitor's "Memory" column), from top.
function footprints(pids) {
  if (!pids.length) return {};
  const out = sh('top', ['-l', '1', '-stats', 'pid,mem,command', ...pids.flatMap((p) => ['-pid', String(p)])]).stdout;
  const units = { B: 1 / 1024, K: 1, M: 1024, G: 1024 * 1024 };
  const res = {};
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMG])\+?-?\s+(.+)$/);
    if (m && pids.includes(Number(m[1]))) res[m[1]] = { kb: Number(m[2]) * units[m[3]], name: m[4].trim() };
  }
  return res;
}
const webkitPids = () => sh('pgrep', ['-f', 'com.apple.WebKit']).stdout.split('\n').filter(Boolean).map(Number);
const processName = (pid) => path.basename(sh('ps', ['-o', 'comm=', '-p', String(pid)]).stdout.trim());

// A scratch copy of the data with one deliberately unreadable table row. Both versions print a
// "could not read" line for it at the moment they answer the Meetings page's request (/api/meetings),
// which lets the first page be timed from outside, with nothing added to the app.
const MARKER = '2026-10-04_measure-marker_1on1.md';
function scratch(name) {
  const root = path.join(OUT, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(DATA, root, { recursive: true });
  fs.rmSync(path.join(root, 'board', 'board.json'), { force: true });
  // Marked as the sample, so any window that opens during a run shows the "Recreated demo data" badge.
  fs.writeFileSync(path.join(root, '.sample-workspace'), 'Recreated demo data, copied for npm run measure.\n');
  fs.writeFileSync(path.join(root, 'meeting-notes', MARKER), '# Measure | October 4, 2026\n\n**Date:** October 4, 2026 | **Duration:** 1m\n**Attendees:** Kevin Collins\n**Company:** Harborline Cloud | **Type:** 1:1\n\n## Action Items\n\n| # | Action Item | Owner | Status |\n|---|---|---|---|\n| 1 | A row with a cell missing |\n');
  return root;
}
const markerSeen = (text) => text.split('\n').some((l) => l.startsWith('[could not read]') && l.includes(MARKER));

// ---------- 1. on disk ----------
say('Measuring what each needs on disk…');
// Node: the files the dynamic loader actually loads for `node`, other than the ones that are part of macOS.
const nodeExe = fs.realpathSync(process.execPath);
const loaded = sh(process.execPath, ['-e', '0'], { env: { ...process.env, DYLD_PRINT_LIBRARIES: '1' } }).stderr
  .split('\n').map((l) => l.replace(/^dyld\[\d+\]: <[^>]*> /, '').trim()).filter((l) => l.startsWith('/'));
const runtimeFiles = [...new Set([nodeExe, ...loaded.filter((p) => !isMacOSPart(p)).map((p) => fs.realpathSync(p))])];
const runtimeKb = runtimeFiles.reduce((s, f) => s + kb(f), 0);
const prodModules = sh('npm', ['ls', '--omit=dev', '--parseable', '--all', '--offline'], { cwd: REPO }).stdout.split('\n').filter((p) => p && p !== REPO);
const modulesKb = prodModules.reduce((s, p) => s + kb(p), 0);
const siteFiles = ['server.js', 'lib', 'package.json', 'public/index.html', 'public/app.js', 'public/styles.css'];
const siteKb = siteFiles.reduce((s, f) => s + kb(path.join(REPO, f)), 0);
const nodeDiskKb = runtimeKb + modulesKb + siteKb;
const appKb = kb(APP);
const sampleKb = kb(path.join(APP, 'Contents', 'Resources', 'sample-workspace'));
const archs = sh('lipo', ['-archs', APP_EXE]).stdout.trim();
// otool -L prints a header line per chip type ("<binary> (architecture arm64):"), then one indented line per
// library. Only the indented lines are libraries; a universal binary lists each library once per chip type.
const appLibs = [...new Set(sh('otool', ['-L', APP_EXE]).stdout.split('\n')
  .filter((l) => /^\s+\S/.test(l))
  .map((l) => l.trim().replace(/ \(compatibility version [^)]*\)$/, '')))];
const appOutsideMacOS = appLibs.filter((p) => !isMacOSPart(p));

// ---------- 2 and 3. first page, and memory with it showing ----------
const settingsBackup = fs.existsSync(SETTINGS_DIR) ? Object.fromEntries(fs.readdirSync(SETTINGS_DIR).map((f) => [f, fs.readFileSync(path.join(SETTINGS_DIR, f))])) : null;
const restoreSettings = () => {
  fs.rmSync(SETTINGS_DIR, { recursive: true, force: true });
  if (settingsBackup) { fs.mkdirSync(SETTINGS_DIR, { recursive: true }); for (const [f, b] of Object.entries(settingsBackup)) fs.writeFileSync(path.join(SETTINGS_DIR, f), b); }
};

async function nodeRun() {
  const root = scratch('node');
  const port = await freePort();
  const t0 = performance.now();
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, MC_ROOT: root, PORT: String(port), MC_DEMO: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let ready = null;
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; if (ready === null && markerSeen(log)) ready = performance.now() - t0; });
  // The requests the Meetings page makes, in its order, as soon as the server answers.
  const base = `http://localhost:${port}`;
  const get = (p) => fetch(base + p).then((r) => r.text());
  let page;
  for (;;) { try { page = await get('/'); break; } catch { await sleep(5); } }
  const files = await Promise.all([get('/styles.css'), get('/app.js')]);
  if ([page, ...files].some((t) => t.includes('__'))) throw new Error('The Node version\'s page shows a "__" placeholder.');
  await get('/api/config');
  await get('/api/meetings');
  while (ready === null) await sleep(2);
  await sleep(2000);
  const mem = footprints([child.pid]);
  child.kill();
  await new Promise((r) => child.once('exit', r));
  return { ms: Math.round(ready), memKb: mem[child.pid]?.kb ?? null, counted: [`node (${mb(mem[child.pid]?.kb ?? 0)})`] };
}

async function appRun() {
  const root = scratch('app');
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SETTINGS_DIR, 'settings.json'), `${JSON.stringify({ workspace: root }, null, 2)}\n`);
  const errFile = path.join(OUT, 'app-stderr.log');
  fs.writeFileSync(errFile, '');
  const webkitBefore = new Set(webkitPids());
  // Launched the way Finder launches it (Launch Services), with its error output kept so the line can be seen.
  const t0 = performance.now();
  sh('open', ['-n', '--stderr', errFile, APP]);
  let ready = null;
  while (ready === null) {
    if (markerSeen(fs.readFileSync(errFile, 'utf8'))) ready = performance.now() - t0;
    else if (performance.now() - t0 > 60000) throw new Error('the app did not show the Meetings page within 60 s');
    else await sleep(2);
  }
  await sleep(2000);
  const appPid = Number(sh('pgrep', ['-n', '-f', APP_EXE]).stdout.trim());
  const helpers = webkitPids().filter((p) => !webkitBefore.has(p));
  const mem = footprints([appPid, ...helpers]);
  const counted = [appPid, ...helpers].map((p) => `${p === appPid ? CONF.productName : processName(p)} (${mb(mem[p]?.kb ?? 0)})`);
  const total = [appPid, ...helpers].reduce((s, p) => s + (mem[p]?.kb ?? 0), 0);
  process.kill(appPid, 'SIGTERM');
  for (let i = 0; i < 100 && sh('kill', ['-0', String(appPid)]).status === 0; i++) await sleep(50);
  await sleep(500);
  return { ms: Math.round(ready), memKb: total, counted };
}

fs.mkdirSync(OUT, { recursive: true });
const nodeRuns = [];
const appRuns = [];
try {
  for (let i = 1; i <= RUNS; i++) { say(`Node version, run ${i} of ${RUNS}…`); nodeRuns.push(await nodeRun()); }
  for (let i = 1; i <= RUNS; i++) { say(`Native app, run ${i} of ${RUNS}…`); appRuns.push(await appRun()); }
} finally {
  restoreSettings();
}

// ---------- 4. lines of code ----------
// Lines that hold code: not blank, not only a comment. Rust unit tests (#[cfg(test)] modules) are left out.
function codeLines(file) {
  const ext = path.extname(file);
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  if (ext === '.rs') { const t = lines.findIndex((l) => l.trim() === '#[cfg(test)]'); if (t >= 0) lines = lines.slice(0, t); }
  let inBlock = false;
  return lines.filter((raw) => {
    const l = raw.trim();
    if (inBlock) { if (l.includes('*/') || l.includes('-->')) inBlock = false; return false; }
    if (!l || l.startsWith('//')) return false;
    if (l.startsWith('/*') || l.startsWith('<!--')) { if (!l.includes('*/') && !l.includes('-->')) inBlock = true; return false; }
    return true;
  }).length;
}
const files = (dir, ext) => fs.readdirSync(path.join(REPO, dir)).filter((f) => f.endsWith(ext)).map((f) => path.join(REPO, dir, f));
const sum = (list) => list.reduce((s, f) => s + codeLines(f), 0);
const loc = {
  node: sum([path.join(REPO, 'server.js'), ...files('lib', '.js')]),
  core: sum(files('core/src', '.rs')),
  app: sum(files('app/src', '.rs').filter((f) => !f.endsWith('probe.rs'))),
  probe: codeLines(path.join(REPO, 'app', 'src', 'probe.rs')),
  pages: sum(['index.html', 'app.js', 'styles.css'].map((f) => path.join(REPO, 'public', f))),
  welcome: sum(['welcome.html', 'welcome.js'].map((f) => path.join(REPO, 'public', f))),
};

// ---------- the table ----------
const nMs = nodeRuns.map((r) => r.ms), aMs = appRuns.map((r) => r.ms);
const aMem = appRuns.map((r) => Math.round(r.memKb / 1024));
const nMem = nodeRuns.map((r) => Math.round(r.memKb / 1024));
const rows = [
  ['1. On disk to run it',
    `${mb(nodeDiskKb)}: Node ${process.version} runtime ${mb(runtimeKb)} + node_modules ${mb(modulesKb)} + site files ${mb(siteKb)}; with Node already installed: ${mb(modulesKb + siteKb)}`,
    `${mb(appKb)}: the .app bundle (${archs === 'arm64' ? 'Apple silicon only' : archs.split(' ').sort().join() === 'arm64,x86_64' ? 'universal: Apple silicon and Intel' : archs}); includes the ${mb(sampleKb)} sample workspace`],
  ['2. Launch to first page',
    `${median(nMs)} ms (range ${range(nMs)}), server only: no browser counted`,
    `${median(aMs)} ms (range ${range(aMs)}), window and web view included`],
  ['3. Memory, Meetings showing',
    `${median(nMem)} MB (range ${range(nMem)}) for node alone; the browser tab it needs: not measured, no fair figure`,
    `${median(aMem)} MB (range ${range(aMem)}), every process it needs`],
  ['4. Lines of code',
    `server and logic ${loc.node}`,
    `Rust core ${loc.core} + Rust app ${loc.app}`],
  ['   Page files (both)', `${loc.pages} shared`, `${loc.pages} shared + ${loc.welcome} welcome window`],
];
const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length), ['', 'Node version (server.js)', `Native app (${CONF.productName}.app)`][i].length));
const line = (cells) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(' | ')} |`;
const out = [];
out.push(`Mission Control: Node version vs native app, measured ${new Date().toISOString().slice(0, 16).replace('T', ' ')} on ${sh('sw_vers', ['-productName']).stdout.trim()} ${sh('sw_vers', ['-productVersion']).stdout.trim()}, ${sh('sysctl', ['-n', 'machdep.cpu.brand_string']).stdout.trim()}`);
out.push('');
out.push(line(['', 'Node version (server.js)', `Native app (${CONF.productName}.app)`]));
out.push(`|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`);
for (const r of rows) out.push(line(r));
out.push('');
out.push('How each row was measured:');
out.push(`1. du (space allocated on disk). Node: the node binary plus the ${runtimeFiles.length - 1} non-macOS libraries the loader actually loads for it (DYLD_PRINT_LIBRARIES), the production packages from \`npm ls --omit=dev\` (${prodModules.map((p) => path.basename(p)).join(', ')}), and server.js, lib/, package.json and the three page files; npm is not counted, since \`node server.js\` runs it. "With Node already installed" is node_modules plus the site files. App: the bundle; its binary links ${appOutsideMacOS.length ? `also ${appOutsideMacOS.join(', ')}` : 'only libraries that are part of macOS'}. Both use the WebKit or browser that comes with macOS, not counted for either.`);
out.push(`2. ${RUNS} runs each, on a fresh scratch copy of the data marked as the sample (both in demo mode: the badge shows), with one unreadable row added; both versions print a "could not read" line for it while answering the Meetings page's data request, and the clock stops when that line appears. Node: from starting \`node server.js\` to that line, with this script making the page's requests (/, styles.css, app.js, /api/config, /api/meetings) as soon as the server answers; a browser's start and drawing are not included, which favours Node. App: from \`open\` (as Finder launches it) to that line, so its window, web view and page scripts are included; the final drawing of the page is not, for either.`);
out.push(`3. Two seconds after the first page was ready in each run of row 2: the footprint macOS charges to each process (top's MEM, Activity Monitor's "Memory"). Node: the node process only. The browser tab can't be counted fairly: a browser's main, network and graphics processes are shared with every other tab and extension, so no number is printed. App: the app process plus the WebKit processes that started with it (${[...new Set(appRuns.flatMap((r) => r.counted.map((c) => c.replace(/ \(.*\)$/, ''))))].join(', ')}); one run: ${appRuns[0].counted.join(', ')}.`);
out.push(`4. Lines that hold code: not blank and not only a comment. Node: server.js and lib/*.js. Rust core: core/src. Rust app: app/src without probe.rs (${loc.probe} lines, built only for the app check) and without Rust unit tests. Page files: public/index.html, app.js and styles.css, served by both (the app's core writes the app's name over the page title and the brand; the Node version shows them as written); welcome.html and welcome.js are the app's alone. Libraries (marked; comrak, Tauri) and the test server are not counted.`);
out.push('');
out.push(`Release bundle checked: no probe code. Node version's page checked: no "__" in index.html, app.js or styles.css. No network used: the Node version listens on 127.0.0.1 only; the app opens no port.`);
console.log(safe(out.join('\n')));
fs.rmSync(path.join(OUT, 'node'), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'app'), { recursive: true, force: true });
