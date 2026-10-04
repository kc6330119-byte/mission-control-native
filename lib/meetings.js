// Reads meeting summaries and builds the "Tracked items across all meetings" roll-up.
import { listDir, readText } from './paths.js';
import { parseTable, plainText, renderInline, sectionLines } from './markdown.js';

export const COULD_NOT_READ = 'could not read';
const MEETINGS_DIR = 'meeting-notes';

// ---------- dates (kept as YYYY-MM-DD strings so time zones never shift them) ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/g;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function todayIso() {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// All month-day dates in a cell. A date without a year takes the year written elsewhere in the
// cell, or else the meeting's year (stepping back a year if that would put it after the meeting).
export function parseDates(text, meetingDate) {
  const cellYear = (text.match(/\b(20\d\d)\b/) || [])[1];
  const out = [];
  for (const m of text.matchAll(MONTH_RE)) {
    const month = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day = Number(m[2]);
    if (!month || day < 1 || day > 31) continue;
    let year = Number(m[3] || cellYear || meetingDate.slice(0, 4));
    let d = iso(year, month, day);
    if (!m[3] && !cellYear && d > meetingDate) d = iso(year - 1, month, day);
    out.push(d);
  }
  return out.sort();
}

// ---------- one meeting ----------

function headerField(src, name) {
  const m = src.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([^\\n|]+)`));
  return m ? m[1].trim() : null;
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
}

// Owners are the names outside parentheses: "Riley Brooks (Praveen Iyer secondary)" is owned by Riley.
export function ownerNames(owner) {
  return splitTopLevel(plainText(owner)).flatMap((n) => n.split(/\s+(?:and|&)\s+/)).map((n) => n.trim()).filter(Boolean);
}

// Header lines such as "**Date:** May 5, 2026 | **Duration:** 4m 12s", before the first section.
const HEADER_FIELDS = ['Date', 'Duration', 'Attendees', 'Company', 'Type', 'Prior context'];
export const FIELDS_PLACEHOLDER = 'MCHEADERFIELDS';

export function extractHeaderFields(src) {
  const lines = src.split(/\r?\n/);
  const end = lines.findIndex((l) => /^(##\s|---\s*$)/.test(l));
  const fields = [];
  let placed = false;
  const body = [];
  lines.forEach((line, i) => {
    if ((end === -1 || i < end) && /^\*\*[^*]+:\*\*/.test(line)) {
      for (const seg of line.split(/\s+\|\s+(?=\*\*[^*]+:\*\*)/)) {
        const m = seg.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
        if (m) fields.push({ name: m[1].trim(), value: m[2].trim() });
      }
      if (!placed) { body.push(FIELDS_PLACEHOLDER); placed = true; }
      return;
    }
    body.push(line);
  });
  const named = new Set(fields.map((f) => f.name));
  const missing = HEADER_FIELDS.filter((n) => !named.has(n));
  const ordered = [
    ...HEADER_FIELDS.map((n) => fields.find((f) => f.name === n) || { name: n, value: null }),
    ...fields.filter((f) => !HEADER_FIELDS.includes(f.name)),
  ];
  return { fields: ordered, missing, body: body.join('\n'), placed };
}

function readTable(src, heading, required, warn) {
  const lines = sectionLines(src, heading);
  if (!lines) return null;
  const table = parseTable(lines);
  if (!table) { warn(`"${heading}" table ${COULD_NOT_READ}`); return []; }
  const missing = required.filter((h) => !table.header.includes(h));
  if (missing.length) { warn(`"${heading}" table ${COULD_NOT_READ}: missing column ${missing.join(', ')}`); return []; }
  for (const l of table.bad) warn(`"${heading}" row ${COULD_NOT_READ}: ${l.slice(0, 80)}…`);
  return table.rows;
}

export function parseMeeting(file) {
  const src = readText(`${MEETINGS_DIR}/${file}`);
  const warnings = [];
  const warn = (message) => warnings.push({ file, message });

  let date = (file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  if (!date) {
    const d = headerField(src, 'Date');
    const parsed = d && /\d{4}/.test(d) ? parseDates(d, '9999-12-31')[0] : null;
    date = parsed || null;
    if (!date) warn(`date ${COULD_NOT_READ}`);
  }
  const title = (src.match(/^#\s+(.+)$/m) || [])[1]?.trim() || null;
  const attendees = headerField(src, 'Attendees');
  const type = headerField(src, 'Type');
  if (!attendees) warn(`attendees ${COULD_NOT_READ}`);
  if (!type) warn(`meeting type ${COULD_NOT_READ}`);

  const actionRows = readTable(src, 'Action Items', ['#', 'Action Item', 'Owner', 'Status'], warn);
  if (actionRows === null) warn(`no "Action Items" section`);
  const openRows = readTable(src, 'Open Items from Earlier Meetings', ['From', 'Item', 'Owner', 'Status now'], warn) || [];

  const actionItems = [];
  for (const r of actionRows || []) {
    const num = Number(plainText(r['#']));
    if (!Number.isInteger(num) || num < 1) { warn(`action item number ${COULD_NOT_READ}: "${r['#']}"`); continue; }
    actionItems.push({ num, text: r['Action Item'], owner: r.Owner, due: r.Due ?? null, status: r.Status });
  }
  const openItems = openRows.map((r) => ({ from: r.From, text: r.Item, owner: r.Owner, age: r.Age ?? null, status: r['Status now'] }));

  return {
    file,
    date,
    title: title || COULD_NOT_READ,
    people: attendees ? splitTopLevel(attendees) : null,
    type: type || null,
    actionItems,
    openItems,
    warnings,
  };
}

export function loadMeetings() {
  const files = listDir(MEETINGS_DIR, '.md') || [];
  const meetings = files.map(parseMeeting);
  // Newest first; undated meetings go last.
  meetings.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file));
  return meetings;
}

// ---------- text matching ----------

const STOP = new Set(('a an and are as at be but by e.g eg for from if in into is it its not of off on or per so than that the then ' +
  'their them they this to up vs with he she him his her suggested said meeting').split(' '));

function tokens(text) {
  return new Set(
    plainText(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/'s\b/g, '')
      .split(/[^a-z0-9']+/)
      .map((t) => t.replace(/^'+|'+$/g, ''))
      // Dates differ between mentions of the same item, so month names and day numbers don't count.
      .filter((t) => t.length > 1 && !STOP.has(t) && !(t in MONTHS) && !/^\d{1,2}$/.test(t))
      .map(stem),
  );
}

function stem(t) {
  if (t.length <= 4) return t;
  return t.replace(/(ing|ed|es|s)$/, '');
}

// Share of the shorter text's words that also appear in the longer one.
function similarity(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return { score: shared / Math.max(1, Math.min(a.size, b.size)), shared };
}

const MATCH_SCORE = 0.75;
const MIN_SHARED = 3;
const MIN_MARGIN = 0.15;

export const isSuggested = (text, status = '') => /\(suggested/i.test(text) || /^suggested\b/i.test(plainText(status));

// ---------- roll-up ----------

// Every action item starts a tracked item (key: meeting file + item number). Each later
// "Open Items from Earlier Meetings" row is attached to an item from the meeting it came from
// only when the text matches closely and no other candidate comes near. Anything else becomes
// its own row, tagged "unmatched".
export function buildTracked(meetings, asOf) {
  const chrono = [...meetings].filter((m) => m.date).sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
  const items = [];
  const warnings = [];

  const mention = (m, owner, status, kind) => ({ file: m.file, date: m.date, owner, status, kind });

  for (const m of chrono) {
    for (const a of m.actionItems) {
      items.push({
        key: `${m.file}#${a.num}`,
        text: a.text,
        firstSeen: m.date,
        firstSeenText: null,
        suggested: isSuggested(a.text, a.status),
        unmatched: false,
        tokens: tokens(a.text),
        mentions: [mention(m, a.owner, a.status, 'action item')],
      });
    }

    for (const o of m.openItems) {
      const dates = parseDates(plainText(o.from), m.date);
      const origin = dates[0] || null;
      const t = tokens(o.text);
      let target = null;

      if (origin) {
        const candidates = items
          .filter((it) => it.firstSeen === origin && !it.mentions.some((x) => x.file === m.file && x.kind === 'earlier item'))
          .map((it) => ({ it, ...similarity(t, it.tokens) }))
          .sort((x, y) => y.score - x.score);
        const [best, second] = candidates;
        if (best && best.score >= MATCH_SCORE && best.shared >= MIN_SHARED && (!second || best.score - second.score >= MIN_MARGIN)) {
          target = best.it;
        }
      }

      if (target) {
        target.mentions.push(mention(m, o.owner, o.status, 'earlier item'));
      } else {
        if (!origin) warnings.push({ file: m.file, message: `first-seen date ${COULD_NOT_READ}: "${plainText(o.from)}"` });
        items.push({
          key: `${m.file}#open-${m.openItems.indexOf(o) + 1}`,
          text: o.text,
          firstSeen: origin,
          firstSeenText: origin ? null : plainText(o.from),
          suggested: isSuggested(o.text),
          unmatched: true,
          tokens: t,
          mentions: [mention(m, o.owner, o.status, 'earlier item')],
        });
      }
    }
  }

  const rows = items.map((it) => {
    const latest = it.mentions[it.mentions.length - 1];
    const latestStatus = plainText(latest.status);
    return {
      key: it.key,
      text: plainText(it.text),
      textHtml: renderInline(it.text),
      owner: plainText(latest.owner),
      firstSeen: it.firstSeen,
      firstSeenText: it.firstSeenText,
      ageDays: it.firstSeen ? daysBetween(it.firstSeen, asOf) : null,
      latestStatus,
      latestStatusHtml: renderInline(latest.status),
      closed: /^(closed|done)\b/i.test(latestStatus),
      suggested: it.suggested,
      unmatched: it.unmatched,
      owners: ownerNames(latest.owner),
      sources: it.mentions.map(({ file, date, kind }) => ({ file, date, kind })),
    };
  });
  // Oldest first; rows whose first-seen date could not be read go last.
  rows.sort((a, b) => (a.firstSeen || '9999').localeCompare(b.firstSeen || '9999') || a.key.localeCompare(b.key, 'en', { numeric: true }));
  return { rows, warnings };
}

export function meetingsOverview({ demo }) {
  const meetings = loadMeetings();
  const newest = meetings.find((m) => m.date)?.date || null;
  const asOf = demo && newest ? newest : todayIso();
  const tracked = buildTracked(meetings, asOf);
  return {
    asOf,
    asOfIsNewestMeeting: Boolean(demo && newest),
    meetings: meetings.map(({ file, date, title, people, type }) => ({ file, date, title, people, type })),
    tracked: tracked.rows,
    owners: [...new Set(tracked.rows.flatMap((r) => r.owners))].sort(),
    warnings: [...meetings.flatMap((m) => m.warnings), ...tracked.warnings],
  };
}
