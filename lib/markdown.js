// Markdown rendering on the server. Raw HTML in the source is escaped, unsafe links are dropped,
// and "Manager-only note" items are removed unless the caller asks for private notes.
import { Marked } from 'marked';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SAFE_HREF = /^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+(\/|$|#|\.))/i;

const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link(token) {
      if (!SAFE_HREF.test(token.href || '')) return this.parser.parseInline(token.tokens);
      return false;
    },
    image: ({ text }) => escapeHtml(text),
    listitem(item) {
      if (!item.privateNote) return false;
      return `<li class="private-note">${this.parser.parse(item.tokens)}</li>\n`;
    },
    paragraph(token) {
      if (!token.privateNote) return false;
      return `<p class="private-note">${this.parser.parseInline(token.tokens)}</p>\n`;
    },
  },
});

const PRIVATE_MARK = /^[\s*_]*manager-only note/i;

// Walk block tokens. Private items are either removed (counted) or flagged for styling.
function handlePrivate(tokens, keep, counter) {
  const out = [];
  let skipDepth = 0;
  for (const t of tokens) {
    if (skipDepth) {
      if (t.type === 'heading' && t.depth <= skipDepth) skipDepth = 0;
      else continue;
    }
    if (t.type === 'heading' && PRIVATE_MARK.test(t.text)) {
      counter.n++;
      if (!keep) { skipDepth = t.depth; continue; }
    }
    if ((t.type === 'paragraph' || t.type === 'text') && PRIVATE_MARK.test(t.text)) {
      counter.n++;
      if (!keep) continue;
      t.privateNote = true;
    }
    if (t.type === 'list') {
      t.items = t.items.filter((item) => {
        if (PRIVATE_MARK.test(item.text)) {
          counter.n++;
          item.privateNote = true;
          return keep;
        }
        item.tokens = handlePrivate(item.tokens, keep, counter);
        return true;
      });
      if (!t.items.length) continue;
    }
    if (t.type === 'blockquote') t.tokens = handlePrivate(t.tokens, keep, counter);
    out.push(t);
  }
  return out;
}

export function renderMarkdown(src, { showPrivate = false } = {}) {
  const counter = { n: 0 };
  const tokens = handlePrivate(marked.lexer(src), showPrivate, counter);
  return { html: marked.parser(tokens), privateNotes: counter.n };
}

export function renderInline(src) {
  return marked.parseInline(src || '');
}

// Plain text from inline Markdown: drop emphasis, code ticks and link targets.
export function plainText(src) {
  return String(src || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/(^|\s)_(\S[^_]*\S|\S)_(?=\s|$|[.,;:])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the lines of a "## Heading" section, up to the next level-2 (or higher) heading.
export function sectionLines(src, heading) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s+/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Parses the first pipe table in a section. Rows whose cell count doesn't match the header
// are reported in `bad` rather than guessed at.
export function parseTable(lines) {
  const tableLines = [];
  let started = false;
  for (const l of lines) {
    if (l.trim().startsWith('|')) { tableLines.push(l); started = true; }
    else if (started) break;
  }
  if (tableLines.length < 2 || !/^\|?\s*:?-{2,}/.test(tableLines[1].trim())) return null;
  const header = splitRow(tableLines[0]);
  const rows = [];
  const bad = [];
  for (const l of tableLines.slice(2)) {
    const cells = splitRow(l);
    if (cells.length !== header.length) { bad.push(l); continue; }
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return { header, rows, bad };
}
