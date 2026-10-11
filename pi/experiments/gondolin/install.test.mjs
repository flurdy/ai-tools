import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, symlink, readlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('managed pilot install is explicit, contained, idempotent and refuses conflicts', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'gondolin-install-'));
  try {
    const source = path.join(base, 'repo/pi/experiments/gondolin');
    await mkdir(path.join(source, 'node_modules/@earendil-works/gondolin'), { recursive: true });
    await writeFile(path.join(source, 'node_modules/@earendil-works/gondolin/package.json'), '{}');
    const script = path.join(source, 'install.mjs');
    await copyFile(new URL('./install.mjs', import.meta.url), script);
    const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(invoke().status, 0);
    assert.notEqual(invoke(path.join(base, 'normal-agent')).status, 0);
    const agent = path.join(base, 'repo/.artifacts/pilot/agent');
    assert.notEqual(invoke(agent, '--check').status, 0);
    assert.equal(invoke(agent).status, 0);
    assert.equal(invoke(agent).status, 0);
    assert.equal(invoke(agent, '--check').status, 0);
    assert.equal(await readlink(path.join(agent, 'extensions/gondolin-pilot')), source);
    const conflict = path.join(base, 'repo/.artifacts/conflict/extensions');
    await mkdir(conflict, { recursive: true });
    await writeFile(path.join(conflict, 'gondolin-pilot'), 'do not replace');
    assert.notEqual(invoke(path.dirname(conflict)).status, 0);
    await mkdir(path.join(base, 'outside'));
    await symlink(path.join(base, 'outside'), path.join(base, 'repo/.artifacts/escape'));
    assert.notEqual(invoke(path.join(base, 'repo/.artifacts/escape/agent')).status, 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});
