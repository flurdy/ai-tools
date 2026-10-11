import path from 'node:path';
import type { ExtensionAPI, ExtensionContext, BashOperations } from '@earendil-works/pi-coding-agent';
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { PilotRuntime } from './runtime.ts';
import { guestPath, guestEnvironment, GUEST_ROOT } from './policy.ts';

export default function (pi: ExtensionAPI) {
  const runtime = new PilotRuntime();
  const cwd = process.cwd();
  const definitions = [createReadToolDefinition(cwd), createWriteToolDefinition(cwd), createEditToolDefinition(cwd),
    createBashToolDefinition(cwd), createLsToolDefinition(cwd), createFindToolDefinition(cwd), createGrepToolDefinition(cwd)];

  async function execution(ctx: ExtensionContext, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Operation aborted');
    const vm = await runtime.get(ctx.cwd);
    const root = runtime.root!;
    const map = (value: string) => guestPath(root, value);
    const readOps = {
      readFile: async (value: string) => vm.fs.readFile(await map(value), { signal }),
      access: async (value: string) => { await vm.fs.access(await map(value), { signal }); },
      detectImageMimeType: async (value: string) => {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(value)) throw new Error('Image reads unsupported in bounded pilot');
        return null;
      },
    };
    const writeOps = {
      writeFile: async (value: string, content: string) => { await vm.fs.writeFile(await map(value), content, { encoding: 'utf8', signal }); },
      mkdir: async (value: string) => { await vm.fs.mkdir(await map(value), { recursive: true, signal }); },
    };
    const bashOps: BashOperations = {
      exec: async (command, directory, options) => {
        const guestCwd = await map(directory);
        if (options.signal?.aborted) throw new Error('aborted');
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const seconds = Math.min(options.timeout ?? 30, 120);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, seconds * 1000);
        try {
          // Never forward Pi's supplied host environment to the guest.
          const proc = vm.exec(['/bin/bash', '-lc', command], { cwd: guestCwd, env: guestEnvironment(), signal: controller.signal, stdout: 'pipe', stderr: 'pipe' });
          for await (const chunk of proc.output()) options.onData(chunk.data);
          const result = await proc;
          return { exitCode: result.exitCode };
        } catch (error) {
          if (options.signal?.aborted) throw new Error('aborted');
          if (timedOut) throw new Error(`timeout:${seconds}`);
          throw error;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        }
      },
    };
    const files: string[] = [];
    let visited = 0;
    async function walk(directory: string, limit: number, depth = 0) {
      if (signal?.aborted) throw new Error('Operation aborted');
      if (++visited > 2000 || depth > 64) throw new Error('Pilot search traversal budget exceeded');
      if (files.length >= limit) return;
      const stat = await vm.fs.stat(directory, { signal });
      if (!stat.isDirectory()) { files.push(directory); return; }
      for (const name of await vm.fs.listDir(directory, { signal })) {
        if (files.length >= limit) break;
        await walk(path.posix.join(directory, name), limit, depth + 1);
      }
    }
    return { vm, root, map, readOps, writeOps, bashOps, files, walk };
  }

  for (const definition of definitions) {
    pi.registerTool({
      ...definition,
      description: `${definition.description} [Gondolin pilot: one vetted workspace; no outside-root paths; host custom tools are not sandboxed. find/grep use bounded sampling, not native ignore/ripgrep semantics; image reads are unsupported.]`,
      async execute(id, params, signal, onUpdate, ctx) {
        const { vm, root, map, readOps, writeOps, bashOps, files, walk } = await execution(ctx, signal);
        // Built-in factories see host paths, exactly as session-mode does. Only I/O maps to guest.
        switch (definition.name) {
          case 'read': return createReadToolDefinition(root, { operations: readOps }).execute(id, params, signal, onUpdate, ctx);
          case 'write': return createWriteToolDefinition(root, { operations: writeOps }).execute(id, params, signal, onUpdate, ctx);
          case 'edit': return createEditToolDefinition(root, { operations: { ...readOps, ...writeOps } }).execute(id, params, signal, onUpdate, ctx);
          case 'bash': return createBashToolDefinition(root, { operations: bashOps, exposeSessionEnvironment: false }).execute(id, params, signal, onUpdate, ctx);
          case 'ls': return createLsToolDefinition(root, { operations: {
            exists: async value => { try { await vm.fs.access(await map(value), { signal }); return true; } catch { return false; } },
            stat: async value => vm.fs.stat(await map(value), { signal }),
            readdir: async value => vm.fs.listDir(await map(value), { signal }),
          }}).execute(id, params, signal, onUpdate, ctx);
          case 'find': return createFindToolDefinition(root, { operations: {
            exists: async value => { await map(value); try { await vm.fs.access(await map(value), { signal }); return true; } catch { return false; } },
            glob: async (pattern, directory, options) => {
              const search = await map(directory);
              await walk(search, Math.min(1000, options.limit));
              return files.map(file => path.posix.relative(search, file)).filter(file =>
                path.posix.matchesGlob(file, pattern) || path.posix.matchesGlob(path.posix.basename(file), pattern));
            },
          }}).execute(id, params, signal, onUpdate, ctx);
          case 'grep': {
            const input = params as { path?: string; pattern: string; ignoreCase?: boolean; literal?: boolean; glob?: string; limit?: number; context?: number };
            if (input.context) throw new Error('Context lines unsupported in bounded pilot grep');
            const search = await map(input.path ?? root);
            await walk(search, 1000);
            const regex = input.literal ? null : new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
            const needle = input.ignoreCase ? input.pattern.toLowerCase() : input.pattern;
            const lines: string[] = [];
            for (const file of files) {
              const relative = path.posix.relative(GUEST_ROOT, file);
              if (input.glob && !path.posix.matchesGlob(relative, input.glob)) continue;
              // Pilot bounds: skip large files; do not claim native ripgrep parity.
              if ((await vm.fs.stat(file, { signal })).size > 65536) continue;
              const content = await vm.fs.readFile(file, { encoding: 'utf8', signal });
              for (const [index, line] of content.split('\n').entries()) {
                if (regex ? regex.test(line) : (input.ignoreCase ? line.toLowerCase() : line).includes(needle)) lines.push(`${relative}:${index + 1}:${line.slice(0, 1000)}`);
                if (lines.length >= Math.min(input.limit ?? 100, 1000)) break;
              }
              if (lines.length >= Math.min(input.limit ?? 100, 1000)) break;
            }
            return { content: [{ type: 'text', text: `[Pilot search: max 1000 files, <=64KiB/file; not ripgrep parity]\n${lines.join('\n').slice(0, 50000) || 'No matches in bounded sample.'}` }], details: undefined };
          }
          default: throw new Error('Unsupported pilot tool');
        }
      },
    });
  }
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'multi_tool_use.parallel') return { block: true, reason: 'Custom parallel wrappers are host-side and unsupported in Gondolin pilot' };
    if (!['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(event.toolName)) return;
    try {
      const { map } = await execution(ctx);
      await map(typeof event.input.path === 'string' ? event.input.path : ctx.cwd);
    } catch (error) { return { block: true, reason: String(error) }; }
  });
  pi.on('user_bash', async (_event, ctx) => ({ operations: (await execution(ctx)).bashOps }));
  pi.on('session_start', async (_event, ctx) => {
    await runtime.get(ctx.cwd);
    ctx.ui.setStatus('gondolin', 'Gondolin pilot: native tools+! guest; custom/MCP/children HOST');
  });
  pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\nGondolin bounded pilot: keep tool paths host-relative. Shell runs at /workspace in a guest with write-through to the vetted root. No network. Global skill files, Git administration, other roots and custom parallel wrappers are unsupported. Custom tools/MCP/children remain host-side; this is not a full-agent sandbox or read-only plan-mode filesystem.` }));
  pi.on('session_shutdown', async (_event, ctx) => { await runtime.close(); ctx.ui.setStatus('gondolin', undefined); });
}
