// Node vs Rust: starts the Node "before" (server.js, lib/) and the Rust core (test-server/) on identical
// scratch copies of the data folder, sends both the same requests, and compares the responses, the
// rendered HTML, the private notes each one removes, and the files each one writes.
//
//   node tools/compare.mjs                         the sample workspace (or MC_TEST_DATA)
//   node tools/compare.mjs tools/compare-stress    the same, with the stress cases copied on top
//
// Prints a summary; the full detail goes to target/compare/<name>.json. Differences that SPEC.md
// records as deliberate fixes after the "parity" tag are expected.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(REPO, process.env.MC_TEST_DATA || 'sample-workspace');
const EXTRA = process.argv[2] ? path.resolve(process.argv[2]) : null;
const RUST_BIN = path.join(process.env.CARGO_TARGET_DIR || path.join(REPO, 'target'), 'debug', 'mc-test-server');

const build = spawnSync('cargo', ['build', '--quiet', '-p', 'mc-test-server'], { cwd: REPO, encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stderr); process.exit(1); }

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

function copy(marker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-compare-'));
  fs.cpSync(DATA, root, { recursive: true });
  fs.rmSync(path.join(root, 'board', 'board.json'), { force: true });
  if (EXTRA) fs.cpSync(EXTRA, root, { recursive: true });
  // Demo mode: Node reads MC_DEMO=1, the Rust core reads the sample marker.
  if (marker) fs.writeFileSync(path.join(root, '.sample-workspace'), 'sample\n');
  return root;
}

async function start(kind) {
  const root = copy(kind === 'rust');
  const port = await freePort();
  const [cmd, args, env] = kind === 'node' ? ['node', ['server.js'], { MC_DEMO: '1' }] : [RUST_BIN, [], {}];
  const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, MC_ROOT: root, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/')).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 50)); }
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  };
  return { root, req, log: () => log, stop: () => child.kill() };
}

const report = { same: 0, differ: [] };
const HTML_KEYS = new Set(['html', 'textHtml', 'latestStatusHtml', 'purposeHtml', 'sourcesHtml', 'rulesHtml']);
const htmlDiffs = [];

// Replace ids and timestamps that differ by design; pull HTML out to compare separately.
function normalize(v, where, htmlOut) {
  if (Array.isArray(v)) return v.map((x, i) => normalize(x, `${where}[${i}]`, htmlOut));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (HTML_KEYS.has(k)) { htmlOut.push([`${where}.${k}`, x]); out[k] = '<html>'; continue; }
      if (['id', 'created', 'updated'].includes(k) && typeof x === 'string') { out[k] = `<${k}>`; continue; }
      if (k === 'ownersById') { out[k] = Object.values(x); continue; }
      if (k === 'dataRoot') { out[k] = '<scratch folder>'; continue; }
      out[k] = normalize(x, `${where}.${k}`, htmlOut);
    }
    return out;
  }
  return v;
}

// Same markup apart from how text is escaped and where whitespace falls between tags.
const canonHtml = (h) => String(h).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const summarize = (x) => (typeof x === 'string' ? x.slice(0, 300) : JSON.stringify(x).slice(0, 600));

function compare(label, a, b) {
  const ha = [], hb = [];
  const na = a.json !== null ? normalize(a.json, '', ha) : a.text;
  const nb = b.json !== null ? normalize(b.json, '', hb) : b.text;
  if (a.status === b.status && isDeepStrictEqual(na, nb)) report.same++;
  else report.differ.push({ label, node: { status: a.status, body: summarize(na) }, rust: { status: b.status, body: summarize(nb) } });
  for (let i = 0; i < Math.max(ha.length, hb.length); i++) {
    const [w, x] = ha[i] || ['?', null];
    const [, y] = hb[i] || ['?', null];
    const xs = Array.isArray(x) ? x : [x], ys = Array.isArray(y) ? y : [y];
    xs.forEach((xx, j) => htmlDiffs.push({ label: `${label} ${w}${xs.length > 1 ? `[${j}]` : ''}`, exact: xx === ys[j], canon: canonHtml(xx) === canonHtml(ys[j]), node: xx, rust: ys[j] }));
  }
}

// ---------- private notes: the text each side removes ----------
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const blocks = (html) => decode(html.replace(/<\/(p|li|h\d|td|th|dd|dt|pre|blockquote|tr)>/g, '\n').replace(/<[^>]+>/g, ''))
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
function removed(onHtml, offHtml) {
  const off = blocks(offHtml);
  const out = [];
  for (const l of blocks(onHtml)) { const i = off.indexOf(l); if (i === -1) out.push(l); else off.splice(i, 1); }
  return out;
}

const node = await start('node');
const rust = await start('rust');
const both = async (label, method, p, body, headers) => {
  const a = await node.req(method, p, body, headers);
  const b = await rust.req(method, p, body, headers);
  compare(label, a, b);
  return [a, b];
};

// ---------- reads ----------
for (const p of ['/', '/app.js', '/styles.css', '/api/config', '/api/meetings', '/api/board', '/api/library', '/api/agents', '/api/corrections']) await both(`GET ${p}`, 'GET', p);
const meetings = (await node.req('GET', '/api/meetings')).json.meetings;
const privateReport = [];
for (const m of meetings) {
  const [offN, offR] = await both(`meeting ${m.file}`, 'GET', `/api/meeting?file=${encodeURIComponent(m.file)}`);
  const [onN, onR] = await both(`meeting ${m.file} private`, 'GET', `/api/meeting?file=${encodeURIComponent(m.file)}&private=1`);
  const rn = removed(onN.json.html, offN.json.html), rr = removed(onR.json.html, offR.json.html);
  privateReport.push({ file: m.file, countNode: offN.json.privateNotes, countRust: offR.json.privateNotes, sameText: isDeepStrictEqual(rn, rr), removedNode: rn, removedRust: rr });
}
const lib = (await node.req('GET', '/api/library')).json;
for (const f of lib.notesFiles) await both(`notes ${f}`, 'GET', `/api/library/notes?file=${encodeURIComponent(f)}`);

// ---------- refusals and odd requests ----------
const odd = [
  ['GET', '/api/meeting?file=../CLAUDE.md'], ['GET', '/api/meeting?file=..%2F..%2Fetc%2Fpasswd'], ['GET', '/api/meeting?file=%2Fetc%2Fpasswd'],
  ['GET', '/api/meeting?file=nope.md'], ['GET', '/api/meeting'], ['GET', '/api/library/notes?file=../../etc/passwd'],
  ['GET', '/api/library/notes?file=unlisted.md'], ['GET', '/..%2Fpackage.json'], ['GET', '/%2e%2e/%2e%2e/etc/passwd'], ['GET', '/nope'],
  ['GET', '/%E0%A4%A'], ['GET', '/api/nope'], ['POST', '/api/meetings', {}], ['DELETE', '/'], ['PUT', '/api/board/cards/x', {}],
  ['POST', '/api/board/import', '{bad json'], ['POST', '/api/board/import', '[1]'], ['POST', '/api/corrections', 'x'.repeat(70000)],
  ['POST', '/api/board/import', {}, { Origin: 'https://evil.example' }], ['POST', '/api/corrections', '{}', { 'Content-Type': 'text/plain' }],
  ['POST', '/api/board/cards/x/move', { column: 'someday' }], ['POST', '/api/board/cards/x/move', { column: 'todo', beforeId: 5 }],
  ['POST', '/api/board/cards/x/move', { column: 'todo' }], ['DELETE', '/api/board/cards/x'],
  ['POST', '/api/board/cards', { title: '   ' }], ['POST', '/api/board/cards', { title: 'x', meeting: '../CLAUDE.md' }],
  ['POST', '/api/board/cards', { title: 'x', meeting: 5 }], ['POST', '/api/board/cards', { title: 'y'.repeat(501) }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'Yes', rating: 7, used_by: [] }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'No', date_read: '2024-01-01', used_by: [] }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'Yes', date_read: '2999-01-01', used_by: [] }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'Yes', date_read: '2026-02-30', used_by: [] }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'Yes', used_by: [], notes: 'goals/harborline-sre-goals-2026.md' }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'maybe', used_by: [] }],
  ['POST', '/api/library/books', { title: 'X', author: 'Y', read: 'Yes', used_by: 'Coach' }],
  ['POST', '/api/library/books', { title: '', author: 'Y', read: 'Yes', used_by: [] }],
  ['PUT', '/api/library/books/0', { title: 'X', author: 'Y', read: 'Yes', used_by: [] }],
  ['PUT', '/api/library/books/999', { original: { title: 'a', author: 'b' }, title: 'X', author: 'Y', read: 'Yes', used_by: [] }],
  ['POST', '/api/corrections', { date: '2026-13-01', where: 'w', what: 'x', caught_by: 'c', decision: 'd', rule: 'r' }],
  ['POST', '/api/corrections', { date: '2999-01-01', where: 'w', what: 'x', caught_by: 'c', decision: 'd', rule: 'r' }],
  ['POST', '/api/corrections', { date: '2026-10-01', where: 'w', what: 'x', caught_by: 'c', decision: 'd', rule: '' }],
  ['POST', '/api/corrections', { date: '2026/10/01', where: 'w', what: 'x', caught_by: 'c', decision: 'd', rule: 'r' }],
];
for (const [method, p, body, headers] of odd) {
  const shown = typeof body === 'string' ? body.slice(0, 20) : JSON.stringify(body ?? '').slice(0, 80);
  await both(`${method} ${p.slice(0, 60)} ${shown} ${JSON.stringify(headers ?? '')}`, method, p, body, headers);
}

// ---------- writes, in the same order on both ----------
await both('import', 'POST', '/api/board/import', { includeSuggested: false });
await both('re-import', 'POST', '/api/board/import', { includeSuggested: false });
await both('import suggested', 'POST', '/api/board/import', { includeSuggested: true });
const idsOf = async (s) => (await s.req('GET', '/api/board')).json.board.cards.map((c) => c.id);
const [nIds, rIds] = [await idsOf(node), await idsOf(rust)];
const pair = async (label, method, f, body) => compare(label, await node.req(method, f(nIds), body?.(nIds)), await rust.req(method, f(rIds), body?.(rIds)));
await pair('move 0 to doing', 'POST', (ids) => `/api/board/cards/${ids[0]}/move`, () => ({ column: 'doing' }));
await pair('move 5 before 2', 'POST', (ids) => `/api/board/cards/${ids[5]}/move`, (ids) => ({ column: 'todo', beforeId: ids[2] }));
await pair('move 3 before itself', 'POST', (ids) => `/api/board/cards/${ids[3]}/move`, (ids) => ({ column: 'todo', beforeId: ids[3] }));
await pair('move 4 before missing', 'POST', (ids) => `/api/board/cards/${ids[4]}/move`, () => ({ column: 'done', beforeId: 'nope' }));
await pair('edit imported', 'PUT', (ids) => `/api/board/cards/${ids[1]}`, () => ({ title: 'changed' }));
await pair('delete 1', 'DELETE', (ids) => `/api/board/cards/${ids[1]}`);
await both('re-import after delete', 'POST', '/api/board/import', { includeSuggested: true });
const [an, ar] = await both('add card', 'POST', '/api/board/cards', { title: '  Book  Q4\nskip-levels ', owner: 'Kevin Collins and Dana', column: 'doing', meeting: meetings[0].file });
compare('edit own', await node.req('PUT', `/api/board/cards/${an.json.card.id}`, { title: 'Edited', owner: '' }), await rust.req('PUT', `/api/board/cards/${ar.json.card.id}`, { title: 'Edited', owner: '' }));
await both('add book', 'POST', '/api/library/books', { title: 'Radical Candor', author: 'Kim Scott', read: 'Yes', date_read: '2024-03-01', rating: '4', used_by: ['Coach', ' Coach ', 'Nobody'], notes: null });
await both('dup book', 'POST', '/api/library/books', { title: 'radical candor ', author: 'KIM SCOTT', read: 'No', used_by: [] });
const books = JSON.parse(fs.readFileSync(path.join(node.root, 'library/books.json'), 'utf8'));
const i = books.findIndex((b) => /7 Habits/.test(b.title));
await both('edit book', 'PUT', `/api/library/books/${i}`, { original: { title: books[i].title, author: books[i].author }, title: books[i].title, author: books[i].author, read: 'Yes', date_read: books[i].date_read, rating: 5, used_by: ['Coach'], notes: books[i].notes });
await both('add correction', 'POST', '/api/corrections', { date: '2026-10-01', where: 'w', what: 'x\n  y', caught_by: 'Me', decision: 'd', rule: 'r' });
await both('dup correction', 'POST', '/api/corrections', { date: '2026-10-01', where: 'w', what: 'x\n y', caught_by: 'Me', decision: 'd', rule: 'r' });
await both('partial-date correction', 'POST', '/api/corrections', { date: '2026-09', where: 'w2', what: 'x2', caught_by: 'Me', decision: 'd', rule: 'r' });
for (const p of ['/api/board', '/api/library', '/api/corrections']) await both(`GET ${p} after writes`, 'GET', p);

// ---------- files ----------
const files = {};
for (const f of ['board/board.json', 'library/books.json', 'corrections/corrections.json']) {
  const a = fs.readFileSync(path.join(node.root, f), 'utf8'), b = fs.readFileSync(path.join(rust.root, f), 'utf8');
  const strip = (t) => t.replace(/"(id|created|updated)": "[^"]+"/g, '"$1": "*"');
  files[f] = a === b ? 'byte-identical' : strip(a) === strip(b) ? 'identical apart from ids and times' : 'DIFFERENT';
}

node.stop(); rust.stop();
const summary = {
  responses: { compared: report.same + report.differ.length, same: report.same, differ: report.differ.map((d) => `${d.label} | node ${d.node.status} | rust ${d.rust.status}`) },
  html: {
    fragments: htmlDiffs.length,
    byteIdentical: htmlDiffs.filter((h) => h.exact).length,
    whitespaceOrEscapingOnly: htmlDiffs.filter((h) => !h.exact && h.canon).length,
    different: htmlDiffs.filter((h) => !h.canon).map((h) => h.label),
  },
  privateNotes: privateReport.map((p) => `${p.file}: ${p.countNode}/${p.countRust} ${p.sameText ? 'same text removed' : 'DIFFERENT TEXT REMOVED'}`),
  files,
  warningsPrinted: node.log().split('\n').filter((l) => l.startsWith('[could not read]')).join('\n') === rust.log().split('\n').filter((l) => l.startsWith('[could not read]')).join('\n') ? 'same' : 'different',
};
const outDir = path.join(REPO, 'target', 'compare');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${EXTRA ? path.basename(EXTRA) : 'demo'}.json`);
fs.writeFileSync(outFile, JSON.stringify({ summary, responses: report.differ, html: htmlDiffs.filter((h) => !h.exact), privateNotes: privateReport, logs: { node: node.log(), rust: rust.log() } }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Detail: ${path.relative(REPO, outFile)}`);
fs.rmSync(node.root, { recursive: true, force: true });
fs.rmSync(rust.root, { recursive: true, force: true });
