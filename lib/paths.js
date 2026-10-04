// Locates the data root and keeps every file access inside it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Relative paths (including MC_ROOT) resolve against the site folder, not the shell's working directory.
export const DATA_ROOT = path.resolve(SITE_DIR, process.env.MC_ROOT || '../mission-control-demo');

export class PathError extends Error {}

// Resolve a path relative to the data root. Throws PathError for anything outside it,
// including symlinks that point outside.
export function resolveInRoot(rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new PathError('Invalid path');
  const abs = path.resolve(DATA_ROOT, rel);
  if (!isInside(DATA_ROOT, abs)) throw new PathError(`Refused: ${rel} is outside the data root`);
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!isInside(fs.realpathSync(DATA_ROOT), real)) throw new PathError(`Refused: ${rel} is outside the data root`);
  }
  return abs;
}

function isInside(root, abs) {
  const r = path.relative(root, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

export function readText(rel) {
  return fs.readFileSync(resolveInRoot(rel), 'utf8');
}

export function listDir(rel, ext) {
  const abs = resolveInRoot(rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readdirSync(abs).filter((f) => !ext || f.endsWith(ext)).sort();
}
