// Builds sample-workspace/ from mission-control-demo (SPEC.md, decision 30): everything except .DS_Store,
// board/board.json, transcripts/, agendas/, reruns/ and agent-drafts.md, plus the .sample-workspace marker.
// The book-notes files that books.json lists are placeholders unless --real-notes is given.
//
//   node tools/make-sample.mjs               placeholders for the book notes
//   node tools/make-sample.mjs --real-notes  the notes as they are in mission-control-demo
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.resolve(REPO, process.env.MC_TEST_DATA || '../mission-control-demo');
const TARGET = path.join(REPO, 'sample-workspace');
const REAL_NOTES = process.argv.includes('--real-notes');

if (!fs.existsSync(path.join(SOURCE, 'meeting-notes'))) {
  console.error(`make-sample builds sample-workspace/ from the full demo workspace, which isn't here:
  ${path.relative(REPO, SOURCE) || SOURCE}
It is the author's working folder and is not published. sample-workspace/ is already in the repository;
to rebuild it from another copy of the demo data, set MC_TEST_DATA to that folder.`);
  process.exit(1);
}

// No board.json: the app creates an empty board on first visit, and the empty board points to "Import action items".
const LEAVE_OUT = new Set(['.DS_Store', 'transcripts', 'agendas', 'reruns', 'agent-drafts.md', 'board/board.json']);

fs.rmSync(TARGET, { recursive: true, force: true });
fs.cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(SOURCE, src).split(path.sep).join('/');
    return !LEAVE_OUT.has(rel) && path.basename(src) !== '.DS_Store';
  },
});
// git keeps no empty folders, so neither does the sample: the app makes board/ when the Board first opens.
for (const dir of ['board']) { try { fs.rmdirSync(path.join(TARGET, dir)); } catch { /* not empty or not there */ } }
fs.writeFileSync(path.join(TARGET, '.sample-workspace'), 'This folder is the Mission Control sample workspace. The "Recreated demo data" badge shows while it is open.\n');

if (!REAL_NOTES) {
  const books = JSON.parse(fs.readFileSync(path.join(TARGET, 'library', 'books.json'), 'utf8'));
  for (const b of books) {
    if (typeof b.notes !== 'string' || !fs.existsSync(path.join(TARGET, b.notes))) continue;
    fs.writeFileSync(path.join(TARGET, b.notes), `# My notes on ${b.title}\n\nPlaceholder. My own notes on this book go here, in my words. No text from the book itself.\n`);
  }
}

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(TARGET, p)); } };
walk(TARGET);
console.log(`sample-workspace/: ${files.length} files, book notes ${REAL_NOTES ? 'as written' : 'as placeholders'}`);
console.log(files.sort().map((f) => `  ${f}`).join('\n'));
