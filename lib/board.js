// The Board: cards in three columns, saved to board/board.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveInRoot } from './paths.js';
import { writeJsonAtomic } from './store.js';
import { COULD_NOT_READ, isSuggested, loadMeetings, ownerNames } from './meetings.js';
import { plainText } from './markdown.js';

const FILE = 'board/board.json';
export const COLUMNS = [
  { id: 'todo', name: 'To do' },
  { id: 'doing', name: 'Doing' },
  { id: 'done', name: 'Done' },
];
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id));
const MAX_TITLE = 500;
const MAX_OWNER = 120;

export class BoardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const emptyBoard = () => ({ version: 1, cards: [], deletedImports: [] });

// Checks the whole file. If any part is off, the board is shown as unreadable and nothing is
// written, so a hand-edited file is never overwritten with a guess.
function validate(board) {
  const problems = [];
  if (!board || typeof board !== 'object' || Array.isArray(board)) return ['the file is not a JSON object'];
  if (!Array.isArray(board.cards)) problems.push('"cards" is not a list');
  if (board.deletedImports !== undefined && !(Array.isArray(board.deletedImports) && board.deletedImports.every((k) => typeof k === 'string'))) {
    problems.push('"deletedImports" is not a list of keys');
  }
  const ids = new Set();
  (Array.isArray(board.cards) ? board.cards : []).forEach((c, i) => {
    const where = `card ${i + 1}`;
    if (!c || typeof c !== 'object') return problems.push(`${where} is not an object`);
    if (typeof c.id !== 'string' || !c.id) problems.push(`${where} has no id`);
    else if (ids.has(c.id)) problems.push(`${where} repeats id ${c.id}`);
    ids.add(c.id);
    if (!COLUMN_IDS.has(c.column)) problems.push(`${where} has an unknown column "${c.column}"`);
    if (typeof c.title !== 'string' || !c.title.trim()) problems.push(`${where} has no title`);
    if (c.source !== 'import' && c.source !== 'manual') problems.push(`${where} has an unknown source "${c.source}"`);
    if (c.source === 'import' && typeof c.key !== 'string') problems.push(`${where} is imported but has no key`);
  });
  return problems;
}

export function readBoard() {
  const abs = resolveInRoot(FILE);
  if (!fs.existsSync(abs)) {
    const board = emptyBoard();
    writeJsonAtomic(FILE, board);
    return board;
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new BoardError(`board/board.json ${COULD_NOT_READ}: ${err.message}. Nothing will be saved until it is fixed.`, 409);
  }
  const problems = validate(board);
  if (problems.length) {
    throw new BoardError(`board/board.json ${COULD_NOT_READ}: ${problems.slice(0, 3).join('; ')}. Nothing will be saved until it is fixed.`, 409);
  }
  board.deletedImports ??= [];
  return board;
}

// Owners per card, by the same rule as the Meetings page. Computed for display; never saved.
function owners(board) {
  const ownersById = Object.fromEntries(board.cards.map((c) => [c.id, c.owner ? ownerNames(c.owner) : []]));
  return { ownersById, owners: [...new Set(Object.values(ownersById).flat())].sort() };
}

function update(fn) {
  const board = readBoard();
  const result = fn(board);
  writeJsonAtomic(FILE, board);
  return { board, ...owners(board), ...result };
}

// Puts `card` into `column` just before the card `beforeId`, at the top when `atTop`, else at the end.
function place(board, card, column, { beforeId = null, atTop = false } = {}) {
  card.column = column;
  const inColumn = board.cards.filter((c) => c.column === column && c !== card);
  let at;
  if (beforeId) {
    const before = inColumn.find((c) => c.id === beforeId);
    if (!before) throw new BoardError('The drop position is no longer on the board. Reload to see the current board.', 409);
    at = board.cards.indexOf(before);
  } else if (atTop && inColumn.length) {
    at = board.cards.indexOf(inColumn[0]);
  } else {
    at = inColumn.length ? board.cards.indexOf(inColumn[inColumn.length - 1]) + 1 : board.cards.length;
  }
  board.cards.splice(at, 0, card);
}

function findCard(board, id) {
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new BoardError('That card is no longer on the board. Reload to see the current board.', 404);
  return card;
}

function cleanText(value, name, max, { required }) {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (required && !s) throw new BoardError(`${name} is required`);
  if (s.length > max) throw new BoardError(`${name} is longer than ${max} characters`);
  return s;
}

function meetingRef(file, meetings) {
  if (!file) return { meeting: null, meetingDate: null };
  const m = meetings.find((x) => x.file === file);
  if (!m) throw new BoardError(`Unknown meeting: ${file}`);
  return { meeting: m.file, meetingDate: m.date };
}

const now = () => new Date().toISOString();

// ---------- operations ----------

export function importActionItems({ includeSuggested = false } = {}) {
  const meetings = loadMeetings();
  return update((board) => {
    const onBoard = new Set(board.cards.filter((c) => c.source === 'import').map((c) => c.key));
    const deleted = new Set(board.deletedImports);
    const counts = { added: 0, alreadyOnBoard: 0, previouslyDeleted: 0, suggestedLeftOut: 0 };
    // Oldest meeting first, in item order, so the To do column reads chronologically.
    for (const m of [...meetings].reverse()) {
      for (const a of m.actionItems) {
        const key = `${m.file}#${a.num}`;
        const suggested = isSuggested(a.text, a.status);
        if (onBoard.has(key)) { counts.alreadyOnBoard++; continue; }
        if (deleted.has(key)) { counts.previouslyDeleted++; continue; }
        if (suggested && !includeSuggested) { counts.suggestedLeftOut++; continue; }
        board.cards.push({
          id: crypto.randomUUID(),
          column: 'todo',
          source: 'import',
          key,
          title: plainText(a.text),
          owner: plainText(a.owner) || null,
          meeting: m.file,
          meetingDate: m.date,
          suggested,
          created: now(),
        });
        onBoard.add(key);
        counts.added++;
      }
    }
    return { counts, warnings: meetings.flatMap((m) => m.warnings) };
  });
}

export function addCard(input) {
  const meetings = loadMeetings();
  return update((board) => {
    const card = {
      id: crypto.randomUUID(),
      source: 'manual',
      title: cleanText(input.title, 'Title', MAX_TITLE, { required: true }),
      owner: cleanText(input.owner, 'Owner', MAX_OWNER, { required: false }) || null,
      ...meetingRef(input.meeting, meetings),
      created: now(),
    };
    // Cards added by hand go to the top of their column.
    place(board, card, COLUMN_IDS.has(input.column) ? input.column : 'todo', { atTop: true });
    return { card };
  });
}

export function editCard(id, input) {
  const meetings = loadMeetings();
  return update((board) => {
    const card = findCard(board, id);
    if (card.source !== 'manual') throw new BoardError('Imported cards come from the meeting notes and can’t be edited. Move or delete them instead.', 403);
    card.title = cleanText(input.title, 'Title', MAX_TITLE, { required: true });
    card.owner = cleanText(input.owner, 'Owner', MAX_OWNER, { required: false }) || null;
    Object.assign(card, meetingRef(input.meeting, meetings));
    card.updated = now();
    return { card };
  });
}

// Moves a card to `column`, before the card `beforeId` (end of the column if none). Using a card
// id rather than a position keeps drops right when the page is only showing some of the cards.
export function moveCard(id, { column, beforeId = null }) {
  if (!COLUMN_IDS.has(column)) throw new BoardError(`Unknown column "${column}"`);
  if (beforeId !== null && typeof beforeId !== 'string') throw new BoardError('Invalid drop position');
  return update((board) => {
    const card = findCard(board, id);
    if (beforeId === id) return { card };
    board.cards.splice(board.cards.indexOf(card), 1);
    if (card.column !== column) card.updated = now();
    place(board, card, column, { beforeId });
    return { card };
  });
}

export function deleteCard(id) {
  return update((board) => {
    const card = findCard(board, id);
    board.cards.splice(board.cards.indexOf(card), 1);
    // A deleted imported card stays deleted: the next import skips its key.
    if (card.source === 'import' && !board.deletedImports.includes(card.key)) board.deletedImports.push(card.key);
    return { card };
  });
}

export function boardView() {
  const meetings = loadMeetings();
  const board = readBoard();
  return {
    board,
    ...owners(board),
    columns: COLUMNS,
    meetings: meetings.map(({ file, date, people }) => ({ file, date, people })),
  };
}
