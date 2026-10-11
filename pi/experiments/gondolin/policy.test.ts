import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guestPath, workspaceRoot, hiddenPath, guestEnvironment } from './policy.ts';

test('ordinary checkout only; canonical paths and new files remain confined', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'gondolin-policy-'));
  try {
    const root = path.join(base, 'repo');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'file'), 'fixture');
    assert.equal(await workspaceRoot(root), root);
    assert.equal(await guestPath(root, 'file'), '/workspace/file');
    assert.equal(await guestPath(root, path.join(root, 'new/leaf')), '/workspace/new/leaf');
    for (const input of ['../outside', '/tmp/outside', '/workspace/file', '~/.ssh/id_rsa', '.git/config', '.env', '.beads/issues.jsonl', 'node_modules/a']) {
      await assert.rejects(guestPath(root, input));
    }
    await symlink(path.join(root, 'file'), path.join(root, 'alias'));
    await assert.rejects(guestPath(root, 'alias'));
    await symlink(path.join(base, 'absent'), path.join(root, 'dangling'));
    await assert.rejects(guestPath(root, 'dangling/leaf'));
    await link(path.join(root, 'file'), path.join(root, 'hardlink'));
    await assert.rejects(guestPath(root, 'hardlink'));
    await mkdir(path.join(root, 'nested/.git'), { recursive: true });
    await assert.rejects(guestPath(root, 'nested/file'));
    await writeFile(path.join(root, '.gitmodules'), 'fixture');
    await assert.rejects(workspaceRoot(root));
    const linked = path.join(base, 'linked');
    await mkdir(linked);
    await writeFile(path.join(linked, '.git'), 'gitdir: ../repo/.git/worktrees/linked');
    await assert.rejects(workspaceRoot(linked));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('hidden paths and environment are a fixed conservative pilot policy', () => {
  for (const p of ['/.env', '/sub/.env.production', '/.git/config', '/.pi/settings.json', '/node_modules/pkg', '/id_rsa', '/key.pem', '/.npmrc']) {
    assert.equal(hiddenPath(p), true, p);
  }
  assert.equal(hiddenPath('/src/main.ts'), false);
  assert.deepEqual(guestEnvironment(), { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.equal('PI_MODEL' in guestEnvironment(), false);
});
