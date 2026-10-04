// Board: import without duplicates, deleted-card memory, own cards, and board/board.json.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startSite } from './helpers/site.js';

let site;
before(async () => { site = await startSite(); });
after(async () => { await site?.stop(); });

test('board/board.json is created when missing', async () => {
  assert.equal(site.exists('board/board.json'), false);
  const board = await site.api.board();
  assert.equal(board.cards.length, 0);
  assert.equal(site.exists('board/board.json'), true);
});

test('import adds action items once, keyed by meeting file + item number, suggested left out', async () => {
  const first = await site.api.importItems();
  assert.ok(first.counts.added > 0);
  const saved = site.json('board/board.json');
  assert.equal(saved.cards.length, first.counts.added);
  for (const c of saved.cards) {
    assert.equal(c.column, 'todo');
    assert.equal(c.suggested, false);
    assert.match(c.key, /^[\w.-]+\.md#\d+$/);
    assert.ok(c.meeting && c.meetingDate, 'each card links to its meeting');
  }
  assert.equal(new Set(saved.cards.map((c) => c.key)).size, saved.cards.length, 'no duplicate keys');

  const again = await site.api.importItems();
  assert.equal(again.counts.added, 0, 're-import adds nothing');
  assert.equal(site.json('board/board.json').cards.length, saved.cards.length);
});

test('"Include suggested items" adds them, tagged', async () => {
  const before = site.json('board/board.json').cards.length;
  const res = await site.api.importItems(true);
  assert.ok(res.counts.added > 0);
  const cards = site.json('board/board.json').cards;
  assert.equal(cards.length, before + res.counts.added);
  assert.equal(cards.filter((c) => c.suggested).length, res.counts.added);
});

test('imported cards can move but not be edited; a deleted one stays deleted', async () => {
  const card = site.json('board/board.json').cards.find((c) => c.source === 'import');
  assert.equal((await site.api.editCard(card.id, { title: 'changed' })).status, 403);

  assert.equal((await site.api.moveCard(card.id, 'doing')).status, 200);
  assert.equal(site.json('board/board.json').cards.find((c) => c.id === card.id).column, 'doing');

  assert.equal((await site.api.deleteCard(card.id)).status, 200);
  const res = await site.api.importItems(true);
  assert.equal(res.counts.added, 0);
  assert.ok(!site.json('board/board.json').cards.some((c) => c.key === card.key), 'not re-imported');
});

test('my own cards: added at the top of the column, editable, deletable', async () => {
  const add = await site.api.addCard({ title: 'Book Q4 skip-levels', owner: 'Kevin Collins', column: 'todo' });
  assert.equal(add.status, 200);
  const id = add.json.card.id;
  const todo = site.json('board/board.json').cards.filter((c) => c.column === 'todo');
  assert.equal(todo[0].id, id, 'new card is first in its column');

  assert.equal((await site.api.editCard(id, { title: 'Book Q4 skip-levels (all three)', owner: 'Kevin Collins' })).status, 200);
  assert.equal(site.json('board/board.json').cards.find((c) => c.id === id).title, 'Book Q4 skip-levels (all three)');

  assert.equal((await site.api.deleteCard(id)).status, 200);
  assert.ok(!site.json('board/board.json').cards.some((c) => c.id === id));
});

test('a drop lands before the chosen card', async () => {
  const cards = site.json('board/board.json').cards.filter((c) => c.column === 'todo');
  const [a, , c] = cards;
  assert.equal((await site.api.moveCard(c.id, 'todo', a.id)).status, 200);
  const todo = site.json('board/board.json').cards.filter((x) => x.column === 'todo').map((x) => x.id);
  assert.equal(todo.indexOf(c.id), todo.indexOf(a.id) - 1);
});

test('bad input is refused and the file is left alone', async () => {
  const before = site.file('board/board.json');
  const id = site.json('board/board.json').cards[0].id;
  assert.equal((await site.api.addCard({ title: '   ' })).status, 400);
  assert.equal((await site.api.moveCard(id, 'someday')).status, 400);
  assert.equal((await site.api.addCard({ title: 'x', meeting: '../CLAUDE.md' })).status, 400);
  assert.equal(site.file('board/board.json'), before);
});
