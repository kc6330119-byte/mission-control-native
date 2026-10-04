// Reads CLAUDE.md (the coach) and .claude/agents/*.md for the read-only Agents page.
import fs from 'node:fs';
import { listDir, readText, resolveInRoot } from './paths.js';
import { COULD_NOT_READ, daysBetween, parseDates, todayIso } from './meetings.js';
import { renderInline } from './markdown.js';

const AGENTS_DIR = '.claude/agents';
export const REVIEW_AFTER_DAYS = 30;

// "negotiation-prep" -> "Negotiation prep", the form books.json uses in "used_by".
export const displayName = (name) => {
  const s = name.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function splitFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src, hasFrontmatter: false };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: src.slice(m[0].length), hasFrontmatter: true };
}

function labelledLine(body, label) {
  const m = body.match(new RegExp(`^\\**${label}:\\**\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

function parseReviewed(value) {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso && !Number.isNaN(Date.parse(value + 'T00:00:00Z'))) return value;
  const written = parseDates(value, '9999-12-31');
  return /\b\d{4}\b/.test(value) && written.length === 1 ? written[0] : null;
}

// The numbered rules: top-level "1." items, with wrapped lines joined. The line or heading just
// before the first item is kept as a caption ("When I give you a plan or a draft:").
function parseRules(body) {
  const lines = body.split(/\r?\n/);
  const rules = [];
  let caption = null;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = line.match(/^(\d+)\.\s+(.*)$/);
    if (item) {
      if (!rules.length) {
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].trim()) { caption = lines[j].replace(/^#+\s*/, '').trim(); break; }
        }
      }
      current = { text: item[2] };
      rules.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.text += ' ' + line.trim();
    } else if (current && line.trim()) {
      current = null;
      // A second, separate numbered list is not part of the same rule set.
      if (rules.length) break;
    }
  }
  return { caption, rules: rules.map((r) => r.text) };
}

function parseInstructionFile(rel, { fallbackName }) {
  const warnings = [];
  const warn = (message) => warnings.push({ file: rel, message });
  const src = readText(rel);
  const { meta, body } = splitFrontmatter(src);

  const name = meta.name || fallbackName;
  if (!name) warn(`name ${COULD_NOT_READ}`);
  const purpose = labelledLine(body, 'Purpose');
  const sources = labelledLine(body, 'Sources');
  const reviewedRaw = labelledLine(body, 'Last reviewed');
  const lastReviewed = parseReviewed(reviewedRaw);
  if (!purpose) warn(`"Purpose:" line ${COULD_NOT_READ}`);
  if (!sources) warn(`"Sources:" line ${COULD_NOT_READ}`);
  if (!lastReviewed) warn(`"Last reviewed:" date ${COULD_NOT_READ}${reviewedRaw ? ` ("${reviewedRaw}")` : ''}`);
  const { caption, rules } = parseRules(body);
  if (!rules.length) warn(`rules ${COULD_NOT_READ}: no numbered list found`);

  const today = todayIso();
  const daysSince = lastReviewed ? daysBetween(lastReviewed, today) : null;
  return {
    file: rel,
    name: name ? displayName(name) : null,
    id: name || null,
    tools: meta.tools || null,
    sources,
    purposeHtml: purpose ? renderInline(purpose) : null,
    sourcesHtml: sources ? renderInline(sources) : null,
    lastReviewed,
    lastReviewedText: reviewedRaw,
    daysSince,
    reviewDue: daysSince !== null && daysSince > REVIEW_AFTER_DAYS,
    rulesCaption: caption,
    rulesHtml: rules.map((r) => renderInline(r)),
    warnings,
  };
}

export function loadAgents() {
  const warnings = [];
  const cards = [];

  if (fs.existsSync(resolveInRoot('CLAUDE.md'))) {
    cards.push({ ...parseInstructionFile('CLAUDE.md', { fallbackName: 'Coach' }), name: 'Coach', role: 'coach' });
  } else {
    warnings.push({ file: 'CLAUDE.md', message: 'not found' });
  }

  const files = listDir(AGENTS_DIR, '.md');
  for (const f of files || []) {
    cards.push({ ...parseInstructionFile(`${AGENTS_DIR}/${f}`, { fallbackName: f.replace(/\.md$/, '') }), role: 'agent' });
  }

  for (const c of cards) warnings.push(...c.warnings);
  return {
    cards,
    agentsFolderFound: files !== null,
    agentsFolder: AGENTS_DIR,
    today: todayIso(),
    reviewAfterDays: REVIEW_AFTER_DAYS,
    warnings,
  };
}

// What a book's "used_by" can point at: the coach plus each agent, with the notes files each
// one's Sources line names explicitly (a folder such as "library/" doesn't count as naming a file).
export function agentSummaries() {
  const { cards } = loadAgents();
  return cards.filter((c) => c.name).map((c) => ({
    name: c.name,
    sourcesRead: c.sources !== null,
    notesFiles: [...new Set((c.sources || '').match(/\blibrary\/[\w.-]+\.md\b/g) || [])],
  }));
}
