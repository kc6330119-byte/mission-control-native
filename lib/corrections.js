// The corrections log: corrections/corrections.json. New entries are appended; nothing else in the
// file (such as its top-level "note") is changed.
import { readText } from './paths.js';
import { writeJsonAtomic } from './store.js';
import { COULD_NOT_READ, todayIso } from './meetings.js';

const FILE = 'corrections/corrections.json';
export const FIELDS = ['date', 'where', 'what', 'caught_by', 'decision', 'rule'];
const MAX = { date: 10, where: 200, what: 1500, caught_by: 200, decision: 1500, rule: 500 };

export class CorrectionsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The file is either { ..., "entries": [...] } or a bare list. Either shape is written back as found.
function readLog() {
  let data;
  try {
    data = JSON.parse(readText(FILE));
  } catch (err) {
    if (err.code === 'ENOENT') throw new CorrectionsError(`${FILE} not found`, 404);
    throw new CorrectionsError(`${FILE} ${COULD_NOT_READ}: ${err.message}. Nothing will be saved until it is fixed.`, 409);
  }
  const entries = Array.isArray(data) ? data : data && Array.isArray(data.entries) ? data.entries : null;
  if (!entries) throw new CorrectionsError(`${FILE} ${COULD_NOT_READ}: no list of entries. Nothing will be saved until it is fixed.`, 409);
  return { data, entries };
}

// A date as written: YYYY, YYYY-MM or YYYY-MM-DD, and a real date.
export function parsePartialDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo && (mo < '01' || mo > '12')) return null;
  if (d) {
    const iso = `${y}-${mo}-${d}`;
    if (Number.isNaN(Date.parse(iso + 'T00:00:00Z')) || !new Date(iso + 'T00:00:00Z').toISOString().startsWith(iso)) return null;
  }
  return { text: s, precision: d ? 'day' : mo ? 'month' : 'year' };
}

export function correctionsView() {
  const { data, entries } = readLog();
  const warnings = [];
  const rows = entries.map((e, index) => {
    const row = { index };
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      warnings.push({ file: FILE, message: `entry ${index + 1} ${COULD_NOT_READ}` });
      for (const f of FIELDS) row[f] = { cnr: true };
      return row;
    }
    for (const f of FIELDS) {
      const ok = f === 'date' ? parsePartialDate(e[f]) : typeof e[f] === 'string' && e[f].trim();
      if (ok) row[f] = e[f];
      else {
        row[f] = { cnr: true };
        warnings.push({ file: FILE, message: `entry ${index + 1}, "${f}" ${COULD_NOT_READ}: ${JSON.stringify(e[f])}` });
      }
    }
    return row;
  });
  return {
    total: entries.length,
    note: !Array.isArray(data) && typeof data.note === 'string' ? data.note : null,
    entries: rows,
    warnings,
  };
}

export function addCorrection(input) {
  const { data, entries } = readLog();
  const entry = {};
  for (const f of FIELDS) {
    const s = typeof input[f] === 'string' ? input[f].replace(/[ \t]+/g, ' ').trim() : '';
    if (!s) throw new CorrectionsError(`${label(f)} is required`);
    if (s.length > MAX[f]) throw new CorrectionsError(`${label(f)} is longer than ${MAX[f]} characters`);
    entry[f] = s;
  }
  const date = parsePartialDate(entry.date);
  if (!date) throw new CorrectionsError('Date must be YYYY-MM-DD or YYYY-MM');
  if (entry.date > todayIso()) throw new CorrectionsError('Date can’t be in the future');
  const dup = entries.some((e) => e && e.date === entry.date && e.where === entry.where && e.what === entry.what);
  if (dup) throw new CorrectionsError('That entry is already in the log');
  entries.push(entry);
  writeJsonAtomic(FILE, data);
  return { ...correctionsView(), saved: entries.length - 1 };
}

function label(f) {
  return { date: 'Date', where: 'Where', what: 'What happened', caught_by: 'Who caught it', decision: 'My decision', rule: 'The rule it became' }[f];
}
