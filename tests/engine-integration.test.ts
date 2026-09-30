// Tests against the REAL engine, not the fake.
//
// Everything else in tests/op-one/ substitutes a fake engine, which proves the
// boundary is clean but says nothing about whether it is wired to aura-code
// correctly. These tests exercise the parts of `createAuraCodeEngine` that need
// no provider, no network and no API key — permission enforcement, the file
// snapshot, and evidence extraction — so a break in the actual wiring is caught.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { createAuraCodeEngine, extractEvidence } from '../src/engine.js';
import { providerStore } from '../src/stores.js';
import type { ProviderProfile } from '../src/types.js';
import { startMockProvider, MOCK_KEY, type MockProvider } from './mock-provider.js';

// The default engine reads the active provider from the store, so nothing here
// may see the real ~/.aura/op-one.
let stateDir: string;
let prevDir: string | undefined;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-engine-state-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = stateDir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('real engine — permission enforcement', () => {
  it('enforces read-only through aura-code\'s permission system', () => {
    const engine = createAuraCodeEngine({ permissionLevel: 'read-only' });

    expect(engine.checkPermission('read_file', { path: 'a.ts' }).allowed).toBe(true);
    expect(engine.checkPermission('list_dir', { path: '.' }).allowed).toBe(true);

    const write = engine.checkPermission('write_file', { path: 'a.ts' });
    expect(write.allowed).toBe(false);
    expect(write.reason).toMatch(/read-only/i);
  });

  it('blocks dangerous shell commands even at the most permissive level', () => {
    const engine = createAuraCodeEngine({ permissionLevel: 'auto' });

    const danger = engine.checkPermission('run_shell', { command: 'rm -rf /' });
    expect(danger.allowed).toBe(false);
    expect(danger.reason).toMatch(/dangerous/i);
  });

  it('translates aura-code\'s needsConfirm into the client\'s needsConfirmation', () => {
    // aura-code returns `{ allowed: true, needsConfirm: true }` for a shell
    // command that is neither on the safe list nor dangerous. Reading the wrong
    // field name here silently drops every confirmation prompt, so the mapping
    // is asserted against the real permission system rather than assumed.
    const engine = createAuraCodeEngine({ permissionLevel: 'normal' });
    const outcome = engine.checkPermission('run_shell', { command: 'curl https://example.com' });

    expect(outcome.allowed).toBe(true);
    expect(outcome.needsConfirmation).toBe(true);
  });

  it('is available immediately — no window where an early check fails closed', () => {
    // Constructed and checked in the same tick: the permission system is loaded
    // synchronously precisely so this cannot return a spurious denial.
    const engine = createAuraCodeEngine({ permissionLevel: 'read-only' });
    expect(engine.checkPermission('read_file', { path: 'a.ts' })).toEqual({
      allowed: true,
      needsConfirmation: undefined,
      reason: undefined,
    });
  });
});

describe('real engine — file snapshot', () => {
  it('captures the project file set the verification gate needs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-snap-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export const b = 2;');

      const engine = createAuraCodeEngine();
      const files = engine.snapshotFiles(tmp);

      expect(files.size).toBeGreaterThanOrEqual(2);
      expect([...files].some(f => f.endsWith('a.ts'))).toBe(true);
      expect([...files].some(f => f.endsWith('b.ts'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a missing root rather than throwing', () => {
    const engine = createAuraCodeEngine();
    expect(engine.snapshotFiles('/definitely/not/a/real/path').size).toBe(0);
  });
});

describe('real engine — evidence extraction', () => {
  it('derives files changed and tests executed from the tool-call log', () => {
    const evidence = extractEvidence([
      { name: 'read_file', input: { path: 'src/a.ts' } },
      { name: 'edit_file', input: { path: 'src/a.ts' } },
      { name: 'write_file', input: { path: 'src/b.ts' } },
      { name: 'run_shell', input: { command: 'npm test' } },
      { name: 'run_shell', input: { command: 'ls -la' } },
    ]);

    // Reads are not changes; the edited file appears once despite two mentions.
    expect(evidence.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(evidence.testsExecuted).toEqual(['npm test']);
    expect(evidence.toolCalls).toHaveLength(5);
  });

  it('recognises the common test runners', () => {
    for (const cmd of ['vitest run', 'npx jest', 'pytest -q', 'go test ./...', 'cargo test', 'node --test']) {
      const evidence = extractEvidence([{ name: 'run_shell', input: { command: cmd } }]);
      expect(evidence.testsExecuted, cmd).toEqual([cmd]);
    }
  });

  it('recognises a project-specific test command it would not otherwise match', () => {
    const evidence = extractEvidence(
      [{ name: 'run_shell', input: { command: 'make check-everything' } }],
      'make check-everything',
    );
    expect(evidence.testsExecuted).toEqual(['make check-everything']);
  });

  it('counts run_tests as a test execution', () => {
    const evidence = extractEvidence([{ name: 'run_tests', input: {} }]);
    expect(evidence.testsExecuted).toEqual(['run_tests']);
  });
});

describe('real engine — model resolution without a provider', () => {
  it('honours a pinned policy without touching the network', async () => {
    const engine = createAuraCodeEngine();
    const resolved = await engine.resolveModel({
      policy: { kind: 'pinned', model: 'gpt-4o' },
      task: 'anything',
      projectRoot: '/proj',
    });
    expect(resolved).toMatchObject({ model: 'gpt-4o', isLocal: false });
  });

  it('lets a session override win over the agent policy', async () => {
    const engine = createAuraCodeEngine();
    const resolved = await engine.resolveModel({
      policy: { kind: 'local-first' },
      task: 'anything',
      projectRoot: '/proj',
      override: 'claude-sonnet-4-5',
    });
    expect(resolved.model).toBe('claude-sonnet-4-5');
    expect(resolved.reason).toMatch(/override/);
  });

  it('resolves cloud-only to the configured cloud model', async () => {
    const engine = createAuraCodeEngine({ cloudModel: 'my-cloud-model' });
    const resolved = await engine.resolveModel({
      policy: { kind: 'cloud-only' },
      task: 'anything',
      projectRoot: '/proj',
    });
    expect(resolved).toMatchObject({ model: 'my-cloud-model', isLocal: false });
  });
});

describe('real engine — talks to the configured provider', () => {
  let mock: MockProvider | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });

  // A real repo, so aura-code's git calls stay quiet instead of printing "fatal: not a git repository".
  const project = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-engine-proj-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
    return dir;
  };

  function profileFor(m: MockProvider, over: Partial<ProviderProfile> = {}): ProviderProfile {
    return { name: 'local', baseUrl: `${m.origin}/v1`, apiKey: MOCK_KEY, model: 'mock-mini', createdAt: new Date().toISOString(), ...over };
  }

  const chatCalls = (m: MockProvider) => m.requests.filter(r => r.method === 'POST' && r.url === '/v1/chat/completions');

  it('sends the turn to the profile\'s base URL with its key and the chosen model', async () => {
    mock = await startMockProvider();
    const engine = createAuraCodeEngine({ activeProvider: () => profileFor(mock!) });
    const root = project();

    const result = await engine.run({ projectRoot: root, task: 'say hello', model: 'mock-large' });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.summary).toContain('mock reply from mock-large');
    const calls = chatCalls(mock);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].authorization).toBe(`Bearer ${MOCK_KEY}`);
    expect((calls[0].body as { model: string }).model).toBe('mock-large');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the active profile from the store on every run, so :provider and :model apply at once', async () => {
    mock = await startMockProvider();
    providerStore.upsert(profileFor(mock));
    const engine = createAuraCodeEngine(); // default: providerStore.active()
    const root = project();

    await engine.run({ projectRoot: root, task: 'one', model: 'mock-mini' });
    providerStore.setModel('local', 'mock-small');
    const second = await engine.run({ projectRoot: root, task: 'two', model: 'default' });

    const models = chatCalls(mock).map(c => (c.body as { model: string }).model);
    expect(models[0]).toBe('mock-mini');
    expect(models[models.length - 1]).toBe('mock-small'); // the 'default' placeholder became the profile's model
    expect(second.summary).toContain('mock-small');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('maps the mesh fallback placeholder to the profile\'s model, not a literal "fallback"', async () => {
    mock = await startMockProvider();
    const engine = createAuraCodeEngine({ activeProvider: () => profileFor(mock!, { model: 'mock-large' }) });
    const root = project();

    await engine.run({ projectRoot: root, task: 'x', model: 'fallback' });

    expect((chatCalls(mock)[0].body as { model: string }).model).toBe('mock-large');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a local run bypasses the remote profile entirely', async () => {
    mock = await startMockProvider();
    const engine = createAuraCodeEngine({ activeProvider: () => profileFor(mock!) });
    const root = project();

    // Goes to the local model server (or fails to reach it) — either way the remote
    // profile must not receive it, or a "local" turn would leak to the cloud.
    await engine.run({ projectRoot: root, task: 'private task', model: 'qwen2.5-coder:1.5b', local: true });

    expect(chatCalls(mock)).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a keyless profile still works (the SDK gets a placeholder, the server sees none it needs)', async () => {
    mock = await startMockProvider({ key: null });
    const engine = createAuraCodeEngine({ activeProvider: () => profileFor(mock!, { apiKey: '' }) });
    const root = project();

    const result = await engine.run({ projectRoot: root, task: 'hi', model: 'mock-mini' });

    expect(result.success).toBe(true);
    expect(result.summary).toContain('mock reply from mock-mini');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a rejected key is an error result that does not contain the key', async () => {
    mock = await startMockProvider();
    const engine = createAuraCodeEngine({ activeProvider: () => profileFor(mock!, { apiKey: 'sk-wrong-key-abcdef123456' }) });
    const root = project();

    const result = await engine.run({ projectRoot: root, task: 'hi', model: 'mock-mini' });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sk-wrong-key-abcdef123456');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves cloud-only to the profile\'s model when no cloud model is configured', async () => {
    const engine = createAuraCodeEngine({
      activeProvider: () => ({ name: 'p', baseUrl: 'http://x/v1', apiKey: '', model: 'profile-model', createdAt: '' }),
    });
    const resolved = await engine.resolveModel({ policy: { kind: 'cloud-only' }, task: 't', projectRoot: '/proj' });
    expect(resolved).toMatchObject({ model: 'profile-model', isLocal: false });
  });

  it('an explicit cloudModel option still outranks the profile', async () => {
    const engine = createAuraCodeEngine({
      cloudModel: 'explicit',
      activeProvider: () => ({ name: 'p', baseUrl: 'http://x/v1', apiKey: '', model: 'profile-model', createdAt: '' }),
    });
    const resolved = await engine.resolveModel({ policy: { kind: 'cloud-only' }, task: 't', projectRoot: '/proj' });
    expect(resolved.model).toBe('explicit');
  });
});
