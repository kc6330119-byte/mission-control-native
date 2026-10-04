// Mission Control site: a local server that reads the workspace files and serves the pages.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DATA_ROOT, PathError, SITE_DIR, readText } from './lib/paths.js';
import { COULD_NOT_READ, FIELDS_PLACEHOLDER, extractHeaderFields, meetingsOverview, parseMeeting } from './lib/meetings.js';
import { renderInline, renderMarkdown } from './lib/markdown.js';
import { BoardError, addCard, boardView, deleteCard, editCard, importActionItems, moveCard } from './lib/board.js';
import { LibraryError, addBook, editBook, libraryView, notesPage } from './lib/library.js';
import { loadAgents } from './lib/agents.js';
import { CorrectionsError, addCorrection, correctionsView } from './lib/corrections.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.env.MC_DEMO === '1';
const PUBLIC_DIR = path.join(SITE_DIR, 'public');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MEETING_FILE = /^[\w.-]+\.md$/;
const MAX_BODY = 64 * 1024;

const seenWarnings = new Set();
function logWarnings(warnings) {
  for (const w of warnings) {
    const line = `${w.file}: ${w.message}`;
    if (!seenWarnings.has(line)) { seenWarnings.add(line); console.warn(`[could not read] ${line}`); }
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// [method, path or pattern, handler(url, body, params)]
const routes = [
  ['GET', '/api/config', () => ({ demo: DEMO, dataRoot: path.basename(DATA_ROOT) })],

  ['GET', '/api/meetings', () => {
    const overview = meetingsOverview({ demo: DEMO });
    logWarnings(overview.warnings);
    return overview;
  }],

  ['GET', '/api/meeting', (url) => {
    const file = url.searchParams.get('file') || '';
    if (!MEETING_FILE.test(file)) throw new PathError('Invalid meeting file name');
    const meta = parseMeeting(file);
    const header = extractHeaderFields(readText(`meeting-notes/${file}`));
    if (header.missing.length) logWarnings(header.missing.map((n) => ({ file, message: `header field "${n}" ${COULD_NOT_READ}` })));
    const { html, privateNotes } = renderMarkdown(header.body, {
      showPrivate: url.searchParams.get('private') === '1',
    });
    // Header fields one per line, placed where they were in the file.
    const fieldsHtml = `<dl class="meeting-fields">${header.fields
      .map((f) => `<dt>${renderInline(f.name)}</dt><dd>${f.value === null ? `<span class="cnr">${COULD_NOT_READ}</span>` : renderInline(f.value)}</dd>`)
      .join('')}</dl>`;
    const slot = `<p>${FIELDS_PLACEHOLDER}</p>`;
    const body = html.includes(slot) ? html.replace(slot, fieldsHtml) : fieldsHtml + html.replaceAll(FIELDS_PLACEHOLDER, '');
    return { file, date: meta.date, title: meta.title, people: meta.people, type: meta.type, html: body, privateNotes };
  }],

  // ---------- board (writes only board/board.json) ----------
  ['GET', '/api/board', () => boardView()],
  ['POST', '/api/board/import', (url, body) => {
    const result = importActionItems({ includeSuggested: body.includeSuggested === true });
    logWarnings(result.warnings);
    return result;
  }],
  ['POST', '/api/board/cards', (url, body) => addCard(body)],
  ['PUT', /^\/api\/board\/cards\/([\w-]+)$/, (url, body, [id]) => editCard(id, body)],
  ['POST', /^\/api\/board\/cards\/([\w-]+)\/move$/, (url, body, [id]) => moveCard(id, body)],
  ['DELETE', /^\/api\/board\/cards\/([\w-]+)$/, (url, body, [id]) => deleteCard(id)],

  // ---------- library (writes only library/books.json) ----------
  ['GET', '/api/library', () => {
    const view = libraryView();
    logWarnings(view.warnings);
    return view;
  }],
  ['GET', '/api/library/notes', (url) => notesPage(url.searchParams.get('file') || '')],
  ['POST', '/api/library/books', (url, body) => addBook(body)],
  ['PUT', /^\/api\/library\/books\/(\d+)$/, (url, body, [index]) => editBook(Number(index), body)],

  // ---------- corrections (writes only corrections/corrections.json) ----------
  ['GET', '/api/corrections', () => {
    const view = correctionsView();
    logWarnings(view.warnings);
    return view;
  }],
  ['POST', '/api/corrections', (url, body) => addCorrection(body)],

  // ---------- agents (read-only) ----------
  ['GET', '/api/agents', () => {
    const view = loadAgents();
    logWarnings(view.warnings);
    return view;
  }],
];

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const [m, p, handler] of routes) {
    const params = typeof p === 'string' ? (p === pathname ? [] : null) : p.exec(pathname)?.slice(1);
    if (!params) continue;
    pathMatched = true;
    if (m === method) return { handler, params };
  }
  return pathMatched ? { notAllowed: true } : null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Only pages served by this site may call it: the Host must be this server (blocks DNS
// rebinding), and writes must come from this origin as JSON (blocks cross-site form posts).
function checkRequest(req) {
  const port = req.socket.localPort;
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!allowed.includes(req.headers.host)) throw new HttpError(403, 'Unexpected Host header');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && !allowed.map((h) => `http://${h}`).includes(origin)) throw new HttpError(403, 'Writes are only accepted from this site');
  if (req.method !== 'DELETE' && !/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Send JSON');
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  send(res, 200, fs.readFileSync(abs), TYPES[path.extname(abs)] || 'application/octet-stream');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      checkRequest(req);
      const url = new URL(req.url, `http://${HOST}`);
      const route = matchRoute(req.method, url.pathname);
      if (route?.notAllowed) return send(res, 405, { error: 'Method not allowed' });
      if (route) return send(res, 200, await route.handler(url, await readBody(req), route.params));
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError || err instanceof BoardError || err instanceof LibraryError || err instanceof CorrectionsError) return send(res, err.status, { error: err.message });
      if (err instanceof URIError) return send(res, 400, { error: 'Bad URL encoding' });
      if (err instanceof PathError) return send(res, 400, { error: err.message });
      if (err.code === 'ENOENT') return send(res, 404, { error: 'File not found' });
      console.error(err);
      return send(res, 500, { error: 'Server error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(SITE_DIR, 'server.js')) {
  if (!fs.existsSync(DATA_ROOT)) console.warn(`Data root not found: ${DATA_ROOT}`);
  createServer().listen(PORT, HOST, () => {
    console.log(`Mission Control: http://localhost:${PORT}  (data: ${DATA_ROOT}${DEMO ? ', demo mode' : ''})`);
  });
}
