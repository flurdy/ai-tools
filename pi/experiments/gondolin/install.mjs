#!/usr/bin/env node
// This pilot installer intentionally cannot activate the user's normal agent directory.
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.resolve(source, '../../../.artifacts');
const [agent, check, ...extra] = process.argv.slice(2);
if (!agent || !path.isAbsolute(agent) || (check && check !== '--check') || extra.length) {
  throw new Error('Usage: node install.mjs /absolute/ai-tools/.artifacts/isolated-agent [--check]');
}
function canonicalMissing(value) {
  let cursor = value;
  const suffix = [];
  while (!existsSync(cursor)) {
    // A dangling link is not a missing directory to create through.
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Dangling path link refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    suffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Unresolvable destination');
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...suffix);
}
const parent = canonicalMissing(path.join(agent, 'extensions'));
const boundary = canonicalMissing(artifacts);
const relative = path.relative(boundary, parent);
if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
  throw new Error('Only isolated agent directories under this repository .artifacts are permitted');
}
const destination = path.join(parent, 'gondolin-pilot');
let existing;
try { existing = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing && (!existing.isSymbolicLink() || readlinkSync(destination) !== source)) throw new Error('Conflicting resource; nothing overwritten');
if (!existsSync(path.join(source, 'node_modules/@earendil-works/gondolin/package.json'))) throw new Error('Install the reviewed lockfile dependencies separately first');
if (check) {
  if (!existing) throw new Error('Pilot link not installed');
} else if (!existing) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  symlinkSync(source, destination);
}
console.log(`Verified isolated pilot link: ${destination}`);
