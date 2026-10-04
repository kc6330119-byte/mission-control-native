// Fixes made in the Rust core after the "parity" tag (SPEC.md, decisions 37-43). The Node version
// (server.js, lib/) fails these on purpose: it is the "before".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startSite } from './helpers/site.js';

const meeting = (title, date, sections) => `# ${title} | ${date}

**Date:** ${date} | **Duration:** 1m
**Attendees:** Kevin Collins (SRE Manager), Sam Ortiz (SRE)
**Company:** Harborline Cloud | **Type:** 1:1

---

${sections}
`;

let site;
before(async () => {
  site = await startSite({
    prepare(root) {
      const notes = path.join(root, 'meeting-notes');
      // "constructor" is an ordinary word in an item that is followed up a week later.
      fs.writeFileSync(path.join(notes, '2026-10-05_native-a_1on1.md'), meeting('Native A', 'October 5, 2026', `## Action Items

| # | Action Item | Owner | Status |
|---|---|---|---|
| 1 | Constructor refactor scheduler | Sam Ortiz | Open |
`));
      fs.writeFileSync(path.join(notes, '2026-10-12_native-b_1on1.md'), meeting('Native B', 'October 12, 2026', `## Action Items

| # | Action Item | Owner | Status |
|---|---|---|---|

## Open Items from Earlier Meetings

| From | Item | Owner | Status now |
|---|---|---|---|
| Oct 5 | Constructor refactor scheduler still open | Sam Ortiz | In progress |
| Feb 30 | Item first seen on a date that doesn't exist | Sam Ortiz | Open |
`));
      // A file name that starts with a date that doesn't exist.
      fs.writeFileSync(path.join(notes, '2026-02-30_native-c_1on1.md'), meeting('Native C', 'February 30, 2026', '## Action Items\n'));
      // A "Last reviewed" date that doesn't exist.
      const claude = path.join(root, 'CLAUDE.md');
      fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace(/^Last reviewed:.*$/m, 'Last reviewed: 2026-02-30'));
      // "$" patterns in a header field.
      const dana = path.join(notes, '2026-09-22_dana-kevin_1on1.md');
      // (A function, because a replacement string would itself treat "$" patterns specially.)
      fs.writeFileSync(dana, fs.readFileSync(dana, 'utf8').replace('**Company:** Harborline Cloud', () => '**Company:** Harborline Cloud $$ $& $\' $`'));
      // A book whose title can't be read.
      const booksFile = path.join(root, 'library', 'books.json');
      const books = JSON.parse(fs.readFileSync(booksFile, 'utf8'));
      books.push({ title: 123, author: 'Nobody', read: 'No', used_by: [] });
      fs.writeFileSync(booksFile, JSON.stringify(books, null, 2));
    },
  });
});
after(async () => { await site?.stop(); });

const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('"constructor" is not a month: the follow-up matches its action item', async () => {
  const tracked = await site.api.tracked();
  const item = tracked.find((r) => r.key === '2026-10-05_native-a_1on1.md#1');
  assert.deepEqual(item.sources.map((s) => s.file), ['2026-10-05_native-a_1on1.md', '2026-10-12_native-b_1on1.md']);
  assert.equal(tracked.filter((r) => r.unmatched && /^Constructor refactor/.test(r.text)).length, 0);
});

test('a new correction needs a full date, YYYY-MM-DD', async () => {
  const before = site.file('corrections/corrections.json');
  const entry = { where: 'w', what: 'x', caught_by: 'Me', decision: 'd', rule: 'r' };
  for (const date of ['2026-09', '2026']) {
    const res = await site.api.addCorrection({ ...entry, date });
    assert.equal(res.status, 400, date);
    assert.match(res.json.error, /YYYY-MM-DD/);
  }
  assert.equal(site.file('corrections/corrections.json'), before);
});

test('a date that doesn\'t exist is refused everywhere, never rolled over', async () => {
  const tracked = await site.api.tracked();
  const feb30 = tracked.find((r) => /^Item first seen on a date that doesn't exist/.test(r.text));
  assert.equal(feb30.firstSeen, null);
  assert.equal(feb30.firstSeenText, 'Feb 30');
  assert.equal(feb30.ageDays, null);

  const meetings = await site.api.meetings();
  assert.equal(meetings.find((m) => m.file === '2026-02-30_native-c_1on1.md').date, null);

  const coach = (await site.api.agents()).cards.find((c) => c.name === 'Coach');
  assert.equal(coach.lastReviewed, null);

  const books = site.file('library/books.json');
  assert.equal((await site.api.addBook({ title: 'X', author: 'Y', read: 'Yes', date_read: '2026-02-30', used_by: [] })).status, 400);
  assert.equal(site.file('library/books.json'), books);
  const log = site.file('corrections/corrections.json');
  assert.equal((await site.api.addCorrection({ date: '2026-02-30', where: 'w', what: 'x', caught_by: 'Me', decision: 'd', rule: 'r' })).status, 400);
  assert.equal(site.file('corrections/corrections.json'), log);
});

test('editing a book whose title can\'t be read says so', async () => {
  const lib = await site.api.library();
  const book = lib.books.find((b) => b.title && b.title.cnr);
  const before = site.file('library/books.json');
  // What the Library form sends for this book: the unreadable title as it received it.
  const res = await site.api.editBook(book.index, {
    original: { title: book.title, author: book.author }, title: 'Fixed', author: 'Nobody', read: 'No', used_by: [], notes: null,
  });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /title could not be read/);
  assert.equal(site.file('library/books.json'), before);
});

test('"$$", "$&", "$\'" and "$`" in a meeting header come through unchanged', async () => {
  const res = await site.api.meetingRaw('2026-09-22_dana-kevin_1on1.md');
  assert.equal(res.status, 200);
  assert.ok(decode(res.json.html).includes('Harborline Cloud $$ $& $\' $`'), 'the header text is as written');
});

test('a board card stored as a list gets an error that says what is wrong', async () => {
  const file = path.join(site.root, 'board', 'board.json');
  fs.writeFileSync(file, '{"cards": [["not", "a", "card"]]}');
  const res = await site.api.boardRaw();
  assert.equal(res.status, 409);
  assert.match(res.json.error, /card 1 is a list/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"cards": [["not", "a", "card"]]}');
  fs.rmSync(file);
});

test('error messages say "app", not "site"', async () => {
  const res = await site.post('/api/board/import', {}, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'Writes are only accepted from this app');
  // "Refused: the app never writes …" can't be reached over HTTP; core/src/store.rs tests it.
});

test('the page title and brand are the app name, written once in app/tauri.conf.json', async () => {
  const name = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'app', 'tauri.conf.json'), 'utf8')).productName;
  const [page] = await site.api.pageShell();
  assert.ok(page.text.includes(`<title>${name}</title>`), 'title');
  assert.ok(page.text.includes(`<span class="brand-name">${name}</span>`), 'brand');
  assert.ok(!page.text.includes('__'), 'no placeholder left');
});
