import { lstatSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { VM, RealFSProvider, ShadowProvider, createHttpHooks } from '@earendil-works/gondolin';
import { GUEST_ROOT, guestEnvironment, hiddenPath, workspaceRoot } from './policy.ts';

// Deliberately restrictive pilot: no guest-created link aliases, no existing link traversal.
class PilotWorkspace extends ShadowProvider {
  async symlink() { throw new Error('Guest symlinks disabled in pilot'); }
  symlinkSync() { throw new Error('Guest symlinks disabled in pilot'); }
  async link() { throw new Error('Guest hard links disabled in pilot'); }
  linkSync() { throw new Error('Guest hard links disabled in pilot'); }
}

function shadowed(root: string, value: string): boolean {
  if (hiddenPath(value)) return true;
  const host = path.resolve(root, `.${value}`);
  const rel = path.relative(root, host);
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return true;
  let cursor = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return true;
      if (stat.isDirectory()) {
        try { lstatSync(path.join(cursor, '.git')); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  }
  return false;
}

export class PilotRuntime {
  root?: string;
  private pending?: Promise<VM>;
  private stopped = false;

  async get(cwd: string): Promise<VM> {
    if (this.stopped) throw new Error('Gondolin pilot stopped; reload before reuse');
    const root = await workspaceRoot(cwd);
    if (this.root && root !== this.root) throw new Error('Workspace changed; no implicit remount');
    this.root = root;
    // One attempt per runtime: rejected startup is cached, never falls back to host tools.
    this.pending ??= this.start(root);
    return this.pending;
  }

  private async start(root: string): Promise<VM> {
    if (process.env.GONDOLIN_PILOT !== '1') throw new Error('Set GONDOLIN_PILOT=1 only for an explicitly approved disposable pilot');
    const assetsInput = process.env.GONDOLIN_PILOT_ASSETS;
    const stateInput = process.env.GONDOLIN_PILOT_STATE;
    if (!assetsInput || !stateInput || !path.isAbsolute(assetsInput) || !path.isAbsolute(stateInput)) throw new Error('Explicit absolute pilot assets/state paths required');
    const assets = await realpath(assetsInput);
    await mkdir(stateInput, { recursive: true, mode: 0o700 });
    const state = await realpath(stateInput);
    for (const location of [assets, state]) {
      const rel = path.relative(root, location);
      if (rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel))) throw new Error('Assets and state must not be exposed inside the guest workspace');
    }
    const manifest = JSON.parse(await readFile(path.join(assets, 'manifest.json'), 'utf8'));
    if (manifest.buildId !== '3cd7a864-f023-5a35-9db1-39a1be5bdcca') throw new Error('Only the reviewed Alpine 0.2.0 x86_64 image is supported');
    const { httpHooks } = createHttpHooks({ allowedHosts: [], blockInternalRanges: true });
    return VM.create({
      sandbox: { vmm: 'qemu', accel: 'kvm', qemuPath: '/usr/bin/qemu-system-x86_64', imagePath: assets, mitmCertDir: path.join(state, 'ssl') },
      httpHooks, dns: { mode: 'synthetic' }, allowWebSockets: false,
      vfs: { mounts: { [GUEST_ROOT]: new PilotWorkspace(new RealFSProvider(root), { shouldShadow: ({ path: p }) => shadowed(root, p), writeMode: 'deny' }) } },
      env: guestEnvironment(), memory: '512M', cpus: 1, startTimeoutMs: 30000,
      sessionLabel: 'bounded-pilot: host custom tools are NOT VM-confined',
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pending) {
      let vm: VM;
      try { vm = await this.pending; } catch { return; }
      await vm.close();
    }
  }
}
