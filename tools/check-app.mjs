// The app check (SPEC.md, decision 53). Builds the app twice (a probe build that a script can drive, and the
// normal release build), runs a session of reads and saves in the real window, restarts it, and checks:
//   - what changed outside the workspace: only the settings file, holding the folder path and nothing else
//   - what changed inside the workspace: only board.json, books.json and corrections.json
//   - no listening port or socket for the app's process, every page loads, moves and saves land in the
//     files, the private-notes switch is off after a reload and a restart, web links leave the window, the
//     content security policy blocks anything from elsewhere, and no page shows "Invalid Date"
//
//   node tools/check-app.mjs            build both, then check
//   node tools/check-app.mjs --no-build check the bundles already built
//
// It touches only this folder and the app's own settings folder, which it puts back as it found it.
// Screenshots and the report go to target/app-check/.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBundle, buildApp } from './build-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'tauri.conf.json'), 'utf8'));
const NAME = CONF.productName;
const ID = CONF.identifier;
const EXE = 'mission-control';
const DATA = path.resolve(REPO, process.env.MC_TEST_DATA || 'sample-workspace');
const OUT = path.join(REPO, 'target', 'app-check');
const WS = path.join(OUT, 'workspace');
const SHOTS = path.join(OUT, 'shots');
const HOME = os.homedir();
const SETTINGS_DIR = path.join(HOME, 'Library', 'Application Support', ID);
const SETTINGS = path.join(SETTINGS_DIR, 'settings.json');
const WRITABLE = ['board/board.json', 'library/books.json', 'corrections/corrections.json'];
const appPath = (profile) => appBundle(profile);
const exePath = (profile) => path.join(appPath(profile), 'Contents', 'MacOS', EXE);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- build ----------
const timings = {};
function build(label, args) {
  const t = Date.now();
  const res = buildApp(args, { stdio: ['ignore', 'pipe', 'pipe'], identity: null });
  timings[label] = `${((Date.now() - t) / 1000).toFixed(1)} s`;
  if (res.status !== 0) { console.error(res.stdout, res.stderr); process.exit(1); }
}
if (!process.argv.includes('--no-build')) {
  build('probe build (debug)', ['--debug', '--features', 'probe']);
  build('release build', []);
}
const windowId = path.join(REPO, 'target', 'probe', 'window-id');
fs.mkdirSync(path.dirname(windowId), { recursive: true });
if (sh('swiftc', ['-O', '-o', windowId, path.join(REPO, 'tools', 'window-id.swift')]).status !== 0) throw new Error('could not build window-id');

// ---------- the workspace: demo data, the stress cases, and dates that don't exist ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.cpSync(DATA, WS, { recursive: true });
fs.rmSync(path.join(WS, 'board', 'board.json'), { force: true });
fs.cpSync(path.join(REPO, 'tools', 'compare-stress'), WS, { recursive: true });
fs.writeFileSync(path.join(WS, '.sample-workspace'), 'Marks this copy as the sample, so the demo badge shows.\n');
const header = (title, date) => `# ${title} | ${date}\n\n**Date:** ${date} | **Duration:** 1m\n**Attendees:** Kevin Collins, Sam Ortiz\n**Company:** Harborline Cloud | **Type:** 1:1\n\n---\n\n`;
fs.writeFileSync(path.join(WS, 'meeting-notes', '2026-10-12_check_1on1.md'), header('Check', 'October 12, 2026')
  + '## Action Items\n\n| # | Action Item | Owner | Status |\n|---|---|---|---|\n\n## Open Items from Earlier Meetings\n\n| From | Item | Owner | Status now |\n|---|---|---|---|\n| Feb 30 | First seen on a date that does not exist | Sam Ortiz | Open |\n');
fs.writeFileSync(path.join(WS, 'meeting-notes', '2026-02-30_check_1on1.md'), header('Check C', 'February 30, 2026') + '## Action Items\n');
const claude = path.join(WS, 'CLAUDE.md');
fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace(/^Last reviewed:.*$/m, 'Last reviewed: 2026-02-30'));

// ---------- snapshots ----------
function hashTree(root, { skip = [] } = {}) {
  const out = {};
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    const rel = path.relative(root, p) || '.';
    if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) return;
    if (st.isDirectory()) { out[`${rel}/`] = 'dir'; for (const e of fs.readdirSync(p)) walk(path.join(p, e)); }
    else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  };
  walk(root);
  return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

// Everywhere an app, WebKit or macOS keeps per-app files, under the bundle id, the program name and the app name.
const getconf = (k) => sh('getconf', [k]).stdout.trim();
const L = path.join(HOME, 'Library');
const outsidePlaces = [ID, EXE, NAME].flatMap((n) => [
  `${L}/Application Support/${n}`, `${L}/Caches/${n}`, `${L}/WebKit/${n}`, `${L}/HTTPStorages/${n}`,
  `${L}/HTTPStorages/${n}.binarycookies`, `${L}/Cookies/${n}.binarycookies`, `${L}/Preferences/${n}.plist`,
  `${L}/Saved Application State/${n}.savedState`, `${L}/Logs/${n}`, `${L}/Application Scripts/${n}`, `${L}/Containers/${n}`,
  path.join(getconf('DARWIN_USER_CACHE_DIR'), n), path.join(getconf('DARWIN_USER_TEMP_DIR'), n),
]);
const snapOutside = () => Object.assign({}, ...outsidePlaces.map((p) => Object.fromEntries(Object.entries(hashTree(p)).map(([k, v]) => [path.join(p, k), v]))));
const snapRepo = () => ({ ...hashTree(REPO, { skip: ['target', 'node_modules', '.git'] }), ...Object.fromEntries(Object.entries(hashTree(DATA)).map(([k, v]) => [`demo:${k}`, v])) });

// The settings folder is put back as it was found.
const savedSettings = fs.existsSync(SETTINGS_DIR) ? hashTreeContents(SETTINGS_DIR) : null;
function hashTreeContents(dir) {
  return Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
}
fs.rmSync(SETTINGS_DIR, { recursive: true, force: true });

// ---------- run the app ----------
const events = [];
const lsofs = {};
async function run(profile, label, env, { timeout = 180000, untilWindow = false } = {}) {
  const child = spawn(exePath(profile), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const lsof = (when) => {
    const all = sh('lsof', ['-nP', '-a', '-p', String(child.pid), '-i']).stdout.trim();
    const listen = sh('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN']).stdout.trim();
    lsofs[`${label} (${when})`] = { sockets: all || 'none', listening: listen || 'none' };
  };
  const screenshot = (name) => {
    const id = sh(windowId, [String(child.pid)]).stdout.trim();
    if (id) sh('screencapture', ['-x', '-o', '-l', id, path.join(SHOTS, `${label}-${name}.png`)]);
  };
  const onLine = (line) => {
    const m = line.match(/^\[probe\] GET \/__probe\/([\w-]+)\?(\S*) -> /);
    if (!m) return;
    const data = JSON.parse(decodeURIComponent(m[2]) || 'null');
    events.push({ run: label, what: m[1], data });
    if (m[1] === 'shot') screenshot(data);
    if (m[1] === 'ready') lsof('pages loaded');
  };
  let buf = '';
  const feed = (d) => { log += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const exited = new Promise((r) => child.once('exit', r));
  if (untilWindow) {
    for (let i = 0; i < 100 && !sh(windowId, [String(child.pid)]).stdout.trim(); i++) await sleep(150);
    await sleep(2500);
    lsof('window open');
    screenshot('window');
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  await exited;
  clearTimeout(timer);
  fs.writeFileSync(path.join(OUT, `${label}.log`), log);
  return log;
}

const probeScript = (mode) => {
  const p = path.join(OUT, `probe-${mode}.js`);
  fs.writeFileSync(p, fs.readFileSync(path.join(REPO, 'tools', 'check-app-probe.js'), 'utf8').replace('__MODE__', mode));
  return p;
};

const repoBefore = snapRepo();
const wsBefore = hashTree(WS);
const outsideBefore = snapOutside();
// First launch: no settings file, so the welcome window; Choose Folder… "picks" the workspace.
await run('debug', 'welcome', { MC_PROBE: probeScript('welcome'), MC_PROBE_PICK: WS }, { timeout: 60000 });
// The session opens the workspace through the same code as the folder picker, which writes the settings file.
await run('debug', 'session', { MC_PROBE_WORKSPACE: WS, MC_PROBE: probeScript('session') });
// The restart opens the remembered folder from the settings file.
await run('debug', 'restart', { MC_PROBE: probeScript('restart') });
const outsideAfter = snapOutside();
const wsAfter = hashTree(WS);
const settingsText = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;

// A remembered folder that is gone: the welcome window names it, and Quit ends the app.
const gone = `${WS}-moved-away`;
// The welcome window shows a folder as the window title does: the home folder as "~".
const shownPath = (p) => (p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p);
const goneSettings = `${JSON.stringify({ workspace: gone }, null, 2)}\n`;
fs.writeFileSync(SETTINGS, goneSettings);
const missingStart = Date.now();
await run('debug', 'missing', { MC_PROBE: probeScript('missing') }, { timeout: 60000 });
const missingResult = { exitedWithin: `${((Date.now() - missingStart) / 1000).toFixed(1)} s`, folderCreated: fs.existsSync(gone), settingsUnchanged: fs.readFileSync(SETTINGS, 'utf8') === goneSettings };
fs.writeFileSync(SETTINGS, settingsText);

// A workspace without books.json and corrections.json, and one where both can't be read.
const wsMissing = `${WS}-without-files`;
const wsUnreadable = `${WS}-unreadable-files`;
for (const [dir, write] of [[wsMissing, null], [wsUnreadable, '{ this is not JSON']]) {
  fs.cpSync(WS, dir, { recursive: true });
  for (const f of ['library/books.json', 'corrections/corrections.json']) {
    fs.rmSync(path.join(dir, f), { force: true });
    if (write) fs.writeFileSync(path.join(dir, f), write);
  }
}
await run('debug', 'missing-files', { MC_PROBE_WORKSPACE: wsMissing, MC_PROBE: probeScript('missing-files') }, { timeout: 60000 });
await run('debug', 'unreadable-files', { MC_PROBE_WORKSPACE: wsUnreadable, MC_PROBE: probeScript('unreadable-files') }, { timeout: 60000 });
const filesCreated = ['library/books.json', 'corrections/corrections.json'].filter((f) => fs.existsSync(path.join(wsMissing, f)));
const unreadableKept = ['library/books.json', 'corrections/corrections.json'].every((f) => fs.readFileSync(path.join(wsUnreadable, f), 'utf8') === '{ this is not JSON');

// The normal build's welcome window, for the screenshot.
fs.rmSync(SETTINGS);
await run('release', 'release-welcome', {}, { untilWindow: true });
fs.writeFileSync(SETTINGS, settingsText);

// The normal build: no probe, opened from the settings file as a person would see it.
await run('release', 'release', {}, { untilWindow: true });
const outsideAfterRelease = snapOutside();
const repoAfter = snapRepo();

// Put the settings folder back.
fs.rmSync(SETTINGS_DIR, { recursive: true, force: true });
if (savedSettings) { fs.mkdirSync(SETTINGS_DIR, { recursive: true }); for (const [f, b] of Object.entries(savedSettings)) fs.writeFileSync(path.join(SETTINGS_DIR, f), b); }

// ---------- results ----------
const ev = (what, run = 'session') => events.filter((e) => e.what === what && e.run === run).map((e) => e.data);
const one = (what, run) => ev(what, run)[0];
const pages = ev('page');
const outsideChanged = changed(outsideBefore, outsideAfter).filter((k) => !k.endsWith('/'));
const outsideDirsCreated = changed(outsideBefore, outsideAfter).filter((k) => k.endsWith('/'));
let settingsValue = null;
try { settingsValue = JSON.parse(settingsText); } catch { /* reported below */ }
const wsChanged = changed(wsBefore, wsAfter).filter((k) => !k.endsWith('/'));
const csp = one('csp');
const verdict = (ok) => (ok ? 'pass' : 'FAIL');
// The folder that holds home folders ("/Users" on a Mac), worked out here so this file doesn't spell it out.
const HOMES = `${path.dirname(os.homedir())}/`;
const homePaths = fs.readFileSync(exePath('release')).toString('latin1').split(HOMES).length - 1;
const lsofClean = Object.values(lsofs).every((l) => l.sockets === 'none' && l.listening === 'none');

const checklist = {
  'no listening port for the app\'s process (lsof)': verdict(lsofClean && Object.keys(lsofs).length >= 3),
  'works with Wi-Fi off': 'needs Kevin (the app opened no socket at all; see lsof)',
  'welcome window: the app name, the two sentences and the three buttons': verdict(
    one('welcome', 'welcome')?.name === NAME && one('welcome', 'welcome')?.text.length === 2
    && one('welcome', 'welcome')?.buttons.join('|') === 'Choose Folder…|Open Sample…|Quit'),
  'welcome window: the main button is "Open Sample…" on first launch and "Choose Folder…" when the folder is missing': verdict(
    one('welcome', 'welcome')?.primary.join() === 'Open Sample…' && one('welcome', 'welcome')?.focused === 'Open Sample…'
    && one('welcome', 'missing')?.primary.join() === 'Choose Folder…' && one('welcome', 'missing')?.focused === 'Choose Folder…'),
  'welcome window: Choose Folder… opens the workspace and remembers it': verdict(
    !!one('main-after-welcome', 'welcome') && events.some((e) => e.run === 'restart' && e.what === 'ready')),
  'missing folder: the welcome window names it, Quit ends the app, nothing is created': verdict(
    one('welcome', 'missing')?.text.some((t) => t === shownPath(gone)) && one('welcome-click', 'missing') === 'Quit'
    && !missingResult.folderCreated && missingResult.settingsUnchanged),
  'the pages can\'t call the app (no Tauri permissions)': verdict([one('welcome', 'welcome'), one('main-after-welcome', 'welcome'), one('welcome', 'missing')]
    .every((x) => x && (x.appCalls.bridge === false || ['dialog', 'opener', 'fs'].every((k) => x.appCalls[k].startsWith('refused'))))),
  'a workspace without books.json or corrections.json shows a plain notice naming the file, not an error': verdict(
    ['library', 'corrections'].every((p) => {
      const r = one('missing-files', 'missing-files')?.[p];
      return r && !r.error && r.tableShown === false && r.notice?.includes(p === 'library' ? 'library/books.json' : 'corrections/corrections.json');
    })),
  'a books.json or corrections.json that can\'t be read is still an error, and is not overwritten': verdict(
    ['library', 'corrections'].every((p) => /could not read/.test(one('unreadable-files', 'unreadable-files')?.[p]?.error || '')) && unreadableKept),
  'every page loads': verdict(pages.length > 0 && pages.every((p) => !p.error)),
  'a card moves and the move is saved': verdict(one('card-moved')?.column === 'doing' && one('card-dragged')?.column === 'done'),
  'a book and a correction save': verdict(one('book-saved')?.status === 'Book added.' && one('correction-saved')?.status === 'Entry added.'),
  'the private-notes switch is off after a reload and after a restart': verdict(
    one('switch-on-load')?.on === false && one('switch-turned-on')?.on === true && one('switch-turned-on')?.privateNotesShown > 0
    && one('switch-after-reload')?.on === false && one('switch-after-reload')?.privateNotesShown === 0
    && one('switch-after-restart', 'restart')?.on === false && one('switch-after-restart', 'restart')?.privateNotesShown === 0),
  'external links open in the browser and not in the app window': verdict(one('external-link')?.stayed === true && one('external-window-open')?.stayed === true),
  'an impossible date never shows "Invalid Date"': verdict(pages.length > 0 && pages.every((p) => !p.invalidDate)),
  'an empty board points to "Import action items"': verdict(one('board-empty')?.cards === 0 && /“Import action items”/.test(one('board-empty')?.todo || '')),
  'the sample workspace ships without board.json': verdict(
    !fs.existsSync(path.join(REPO, 'sample-workspace', 'board', 'board.json'))
    && !fs.existsSync(path.join(appPath('release'), 'Contents', 'Resources', 'sample-workspace', 'board', 'board.json'))),
  'only the settings file changed outside the workspace, holding the folder path and nothing else': verdict(
    outsideChanged.length === 1 && outsideChanged[0] === SETTINGS
    && settingsValue && Object.keys(settingsValue).join() === 'workspace' && settingsValue.workspace === WS),
  'no screenshot shows a private note': verdict(ev('shot-refused').length === 0 && !fs.readdirSync(SHOTS).some((f) => /private/i.test(f))),
  'only the three allowed files changed in the workspace': verdict(wsChanged.every((f) => WRITABLE.includes(f))),
  'the content security policy blocks other origins and inline scripts': verdict(csp && !csp.inlineScriptRan && csp.violations.length >= 3),
  [`the release binary contains no "${HOMES}"`]: verdict(homePaths === 0),
  'the repository and mission-control-demo are unchanged': verdict(changed(repoBefore, repoAfter).length === 0),
};

const report = {
  app: NAME, bundleId: ID, timings,
  homePathsInReleaseBinary: homePaths,
  binaryBytes: fs.statSync(exePath('release')).size,
  bundleSize: Object.fromEntries(['debug', 'release'].map((p) => [p, sh('du', ['-sh', appPath(p)]).stdout.split('\t')[0]])),
  checklist,
  details: {
    errors: events.filter((e) => e.what === 'error'),
    pages: pages.map((p) => `${p.name}: ${p.error ? `ERROR ${p.error}` : 'ok'}${p.invalidDate ? ' INVALID DATE' : ''} (could not read ×${p.couldNotRead}, demo badge ${p.demoBadge ? 'on' : 'off'}, title "${p.title}")`),
    welcome: { firstLaunch: one('welcome', 'welcome'), afterChoose: one('main-after-welcome', 'welcome'), missing: one('welcome', 'missing'), missingResult },
    emptyBoard: one('board-empty'),
    missingFiles: { ...one('missing-files', 'missing-files'), filesCreatedByAdding: filesCreated },
    unreadableFiles: one('unreadable-files', 'unreadable-files'),
    moves: { button: one('card-moved'), drag: one('card-dragged') },
    saves: { book: one('book-saved'), correction: one('correction-saved') },
    privateSwitch: { onLoad: one('switch-on-load'), turnedOn: one('switch-turned-on'), afterReload: one('switch-after-reload'), afterRestart: one('switch-after-restart', 'restart') },
    links: { click: one('external-link'), windowOpen: one('external-window-open') },
    csp,
    lsof: lsofs,
    outsideChangedDuringSession: outsideChanged,
    outsideFoldersCreatedDuringSession: outsideDirsCreated,
    outsideChangedByReleaseRun: changed(outsideAfter, outsideAfterRelease),
    settingsFile: settingsText,
    workspaceChanged: wsChanged,
    screenshots: fs.readdirSync(SHOTS).sort(),
  },
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(checklist).some((v) => v === 'FAIL') ? 1 : 0);
