// The only place the site writes files. Anything not on the allowlist is refused.
import fs from 'node:fs';
import path from 'node:path';
import { PathError, resolveInRoot } from './paths.js';

export const WRITABLE = new Set(['board/board.json', 'library/books.json', 'corrections/corrections.json']);

// Write to a temporary file next to the target, then rename it over the target, so a crash
// mid-write never leaves a half-written file.
export function writeJsonAtomic(rel, data) {
  if (!WRITABLE.has(rel)) throw new PathError(`Refused: the site never writes ${rel}`);
  const abs = resolveInRoot(rel);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
