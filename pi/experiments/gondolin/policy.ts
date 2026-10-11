import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const GUEST_ROOT = '/workspace';

export function hiddenPath(value: string): boolean {
  return value.split('/').some(part =>
    ['.git', '.beads', '.pi', '.agents', '.claude', '.ssh', '.aws', '.config', '.npmrc', '.pypirc', '.netrc', 'node_modules', 'id_rsa', 'id_ed25519'].includes(part)
    || part.startsWith('.env') || /\.(?:pem|key|p12|pfx)$/i.test(part));
}

async function exists(value: string): Promise<boolean> {
  try { await lstat(value); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function workspaceRoot(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  const marker = await lstat(path.join(root, '.git'));
  if (!marker.isDirectory() || marker.isSymbolicLink()) throw new Error('Pilot requires an ordinary checkout, not a linked worktree/submodule');
  if (await exists(path.join(root, '.gitmodules'))) throw new Error('Submodule checkouts are unsupported by this pilot');
  return root;
}

export async function guestPath(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.startsWith('~')) throw new Error('Use an in-root host path');
  const host = path.resolve(root, input);
  const relative = path.relative(root, host);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Outside-workspace path refused');
  if (hiddenPath(relative)) throw new Error('Hidden pilot path refused');
  let cursor = root;
  for (const part of relative.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Symlinks and hard-linked files are unsupported');
      if (stat.isDirectory() && await exists(path.join(cursor, '.git'))) throw new Error('Nested repository path refused');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return relative ? `${GUEST_ROOT}/${relative}` : GUEST_ROOT;
}

export function guestEnvironment(): Record<string, string> {
  return { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}
