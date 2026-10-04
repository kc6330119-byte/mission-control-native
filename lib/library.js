// The Library: books.json plus Kevin's own notes files. Only his notes are ever displayed;
// the site has no field for, and never stores, text from the books themselves.
import fs from 'node:fs';
import { listDir, readText, resolveInRoot } from './paths.js';
import { writeJsonAtomic } from './store.js';
import { COULD_NOT_READ, todayIso } from './meetings.js';
import { agentSummaries } from './agents.js';
import { renderMarkdown } from './markdown.js';

const FILE = 'library/books.json';
const NOTES_FILE = /^library\/([\w.-]+\.md)$/;

export class LibraryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readBooks() {
  let books;
  try {
    books = JSON.parse(readText(FILE));
  } catch (err) {
    if (err.code === 'ENOENT') throw new LibraryError(`${FILE} not found`, 404);
    throw new LibraryError(`${FILE} ${COULD_NOT_READ}: ${err.message}. Nothing will be saved until it is fixed.`, 409);
  }
  if (!Array.isArray(books) || !books.every((b) => b && typeof b === 'object' && !Array.isArray(b))) {
    throw new LibraryError(`${FILE} ${COULD_NOT_READ}: expected a list of books. Nothing will be saved until it is fixed.`, 409);
  }
  return books;
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);

// Each field is either a clean value or { cnr: true } ("could not read"), never a guess.
function viewBook(b, index, notesFiles) {
  const warnings = [];
  const field = (name, ok, value) => {
    if (ok) return value;
    warnings.push({ file: FILE, message: `book ${index + 1}, "${name}" ${COULD_NOT_READ}: ${JSON.stringify(b[name])}` });
    return { cnr: true };
  };
  const notesMatch = typeof b.notes === 'string' && b.notes.match(NOTES_FILE);
  const view = {
    index,
    title: field('title', typeof b.title === 'string' && b.title.trim(), b.title),
    author: field('author', typeof b.author === 'string' && b.author.trim(), b.author),
    rating: field('rating', b.rating === null || b.rating === undefined || (Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5), b.rating ?? null),
    read: field('read', b.read === 'Yes' || b.read === 'No' || typeof b.read === 'boolean', b.read === true ? 'Yes' : b.read === false ? 'No' : b.read),
    dateRead: field('date_read', b.date_read === null || b.date_read === undefined || isIsoDate(b.date_read), b.date_read ?? null),
    usedBy: field('used_by', b.used_by === undefined || (Array.isArray(b.used_by) && b.used_by.every((u) => typeof u === 'string')), b.used_by ?? []),
    notes: null,
  };
  if (b.notes === null || b.notes === undefined) view.notes = null;
  else if (!notesMatch) view.notes = field('notes', false);
  else if (!notesFiles.includes(notesMatch[1])) {
    warnings.push({ file: FILE, message: `book ${index + 1}, notes file not found: ${b.notes}` });
    view.notes = { missing: b.notes };
  } else view.notes = { file: notesMatch[1], path: b.notes };
  return { view, warnings };
}

function notesFileList() {
  return (listDir('library', '.md') || []).filter((f) => /^[\w.-]+\.md$/.test(f));
}

// Cross-check books.json against the agents' Sources lines. Shown only; neither file is changed.
function crossCheck(views, agents) {
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const unlisted = [];
  for (const b of views) {
    b.checks = [];
    const usedBy = Array.isArray(b.usedBy) ? b.usedBy : [];
    const path = b.notes && b.notes.path;
    for (const u of usedBy) {
      const agent = byName.get(u.toLowerCase());
      if (!agent || !agent.sourcesRead) continue;
      if (!path) b.checks.push(`Used by ${agent.name}, but this book has no notes file for ${agent.name} to read.`);
      else if (!agent.notesFiles.includes(path)) b.checks.push(`Used by ${agent.name}, but ${agent.name}'s Sources line doesn't mention ${path}.`);
    }
  }
  for (const a of agents) {
    for (const f of a.notesFiles) {
      const books = views.filter((b) => b.notes && b.notes.path === f);
      if (!books.length) unlisted.push(`${a.name}'s Sources line mentions ${f}, but no book lists it as its notes.`);
      for (const b of books) {
        const usedBy = Array.isArray(b.usedBy) ? b.usedBy : [];
        if (!usedBy.some((u) => u.toLowerCase() === a.name.toLowerCase())) {
          b.checks.push(`${a.name}'s Sources line mentions ${f}, but this book's Used by doesn't list ${a.name}.`);
        }
      }
    }
  }
  return unlisted;
}

export function libraryView() {
  const books = readBooks();
  const notesFiles = notesFileList();
  const agents = agentSummaries();
  const rows = books.map((b, i) => viewBook(b, i, notesFiles));
  const views = rows.map((r) => r.view);
  const otherChecks = crossCheck(views, agents);
  return {
    books: views,
    notesFiles,
    agents: agents.map((a) => a.name),
    otherChecks,
    warnings: rows.flatMap((r) => r.warnings),
  };
}

// ---------- add / edit ----------

function clean(input, notesFiles) {
  const str = (v, name, max) => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!s) throw new LibraryError(`${name} is required`);
    if (s.length > max) throw new LibraryError(`${name} is longer than ${max} characters`);
    return s;
  };
  const title = str(input.title, 'Title', 300);
  const author = str(input.author, 'Author', 200);

  let rating = input.rating === '' || input.rating === null || input.rating === undefined ? null : Number(input.rating);
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new LibraryError('Rating must be 1 to 5, or empty');

  if (input.read !== 'Yes' && input.read !== 'No') throw new LibraryError('Read must be Yes or No');
  const read = input.read;

  let dateRead = input.date_read || null;
  if (dateRead !== null && !isIsoDate(dateRead)) throw new LibraryError('Date read must be a date (YYYY-MM-DD)');
  if (dateRead && dateRead > todayIso()) throw new LibraryError('Date read can’t be in the future');
  if (read === 'No') {
    if (dateRead) throw new LibraryError('A book you haven’t read can’t have a date read');
    if (rating !== null) throw new LibraryError('A book you haven’t read can’t have a rating');
  }

  if (!Array.isArray(input.used_by) || !input.used_by.every((u) => typeof u === 'string' && u.trim() && u.length <= 80)) {
    throw new LibraryError('Used by must be a list of names');
  }
  const usedBy = [...new Set(input.used_by.map((u) => u.trim()))];

  let notes = input.notes || null;
  if (notes !== null) {
    const m = typeof notes === 'string' && notes.match(NOTES_FILE);
    if (!m || !notesFiles.includes(m[1])) throw new LibraryError('Notes must be one of your notes files in library/');
    resolveInRoot(notes);
  }
  return { title, author, rating, read, date_read: dateRead, used_by: usedBy, notes };
}

const sameBook = (a, b) =>
  String(a.title).trim().toLowerCase() === String(b.title).trim().toLowerCase() &&
  String(a.author).trim().toLowerCase() === String(b.author).trim().toLowerCase();

export function addBook(input) {
  const books = readBooks();
  const book = clean(input, notesFileList());
  if (books.some((b) => sameBook(b, book))) throw new LibraryError('That book is already in the library');
  books.push(book);
  writeJsonAtomic(FILE, books);
  return { ...libraryView(), saved: books.length - 1 };
}

// `original` is the title and author the form was opened with, so an edit never lands on a
// different book if books.json changed in the meantime.
export function editBook(index, input) {
  const books = readBooks();
  const existing = books[index];
  if (!existing || !input.original || !sameBook(existing, input.original)) {
    throw new LibraryError('books.json has changed since this page loaded. Reload and try again.', 409);
  }
  const book = clean(input, notesFileList());
  if (books.some((b, i) => i !== index && sameBook(b, book))) throw new LibraryError('Another entry already has that title and author');
  // Fields the form doesn't show (such as "year") are kept as they are.
  Object.assign(existing, book);
  writeJsonAtomic(FILE, books);
  return { ...libraryView(), saved: index };
}

// Only files that books.json lists as notes are shown, so nothing else in library/ is ever displayed.
export function notesPage(file) {
  if (!/^[\w.-]+\.md$/.test(file)) throw new LibraryError('Invalid notes file name');
  const path = `library/${file}`;
  const books = readBooks();
  const owners = books.filter((b) => b.notes === path);
  if (!owners.length) throw new LibraryError('That file isn’t listed as notes for any book', 404);
  if (!fs.existsSync(resolveInRoot(path))) throw new LibraryError(`${path} not found`, 404);
  const { html } = renderMarkdown(readText(path));
  return { file, path, books: owners.map((b) => ({ title: b.title, author: b.author })), html };
}
