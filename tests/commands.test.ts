import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, isCommand, formatTurn } from '../src/commands.js';
import { OpOneSession } from '../src/session.js';
import { agentStore, knowledgeStore, preferencesStore, providerStore } from '../src/stores.js';
import { defaultAgent } from '../src/agent-schema.js';
import { renderStatusLine } from '../src/display.js';
import { createFakeEngine } from './fake-engine.js';
import { startMockProvider, scriptedIO, MOCK_KEY, type MockProvider } from './mock-provider.js';
import { clearRegisteredSecrets } from '../src/redact.js';

let tmp: string;
let prevDir: string | undefined;
let session: OpOneSession;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-cmd-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
  session = new OpOneSession({ engine: createFakeEngine(), projectRoot: '/proj' });
});

afterEach(() => {
  clearRegisteredSecrets();
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('command dispatch', () => {
  it('recognises commands and passes everything else through to the agent', async () => {
    expect(isCommand(':status')).toBe(true);
    expect(isCommand('  :help')).toBe(true);
    expect(isCommand('hello there')).toBe(false);

    expect((await runCommand(session, 'hello there')).passthrough).toBe(true);
  });

  it('implements every command the brief lists', async () => {
    for (const cmd of [':agent', ':model', ':mesh', ':verify', ':memory', ':status', ':help']) {
      const result = await runCommand(session, cmd);
      expect(result.output, cmd).toBeTruthy();
      expect(result.output, cmd).not.toMatch(/^unknown command/);
    }
    // :council needs arguments, and says so rather than failing.
    expect((await runCommand(session, ':council')).output).toContain('usage');
  });

  it('reports an unknown command instead of guessing', async () => {
    expect((await runCommand(session, ':wat')).output).toMatch(/unknown command ":wat"/);
  });

  it('quits on :quit', async () => {
    expect((await runCommand(session, ':quit')).quit).toBe(true);
  });
});

describe(':agent', () => {
  it('lists agents and marks the active one', async () => {
    agentStore.create({ ...defaultAgent(), id: 'reviewer', name: 'Reviewer' });
    agentStore.create({ ...defaultAgent(), id: 'writer', name: 'Writer' });
    session.setAgent(agentStore.get('writer')!);

    const out = (await runCommand(session, ':agent')).output;
    expect(out).toContain('reviewer');
    expect(out).toMatch(/\*\s+writer/);
  });

  it('switches the active agent and persists the choice', async () => {
    agentStore.create({ ...defaultAgent(), id: 'reviewer', name: 'Reviewer' });
    await runCommand(session, ':agent reviewer');

    expect(session.activeAgent().id).toBe('reviewer');
    expect(preferencesStore.load().defaultAgentId).toBe('reviewer');
  });

  it('reports an unknown agent', async () => {
    expect((await runCommand(session, ':agent ghost')).output).toContain('no agent "ghost"');
  });

  it('creates an agent from interactive answers', async () => {
    const answers = [
      'linter', 'Linter', 'Runs lint.', 'Run the linter and report.',
      'read_file,run_shell', 'cloud-only', 'manual', 'engineering',
    ];
    let i = 0;
    const out = (await runCommand(session, ':agent new', async () => answers[i++])).output;

    expect(out).toContain('created agent "linter"');
    const created = agentStore.get('linter')!;
    expect(created.permittedTools).toEqual(['read_file', 'run_shell']);
    expect(created.modelPolicy).toEqual({ kind: 'cloud-only' });
    expect(created.memoryScope).toBe('engineering');
  });

  it('reports schema problems instead of storing a broken agent', async () => {
    const answers = ['bad id', 'N', 'p', 'i', 'not_a_tool', 'cloud-only', 'never', 'everything'];
    let i = 0;
    const out = (await runCommand(session, ':agent new', async () => answers[i++])).output;

    expect(out).toContain('invalid agent definition');
    expect(agentStore.list()).toHaveLength(0);
  });
});

describe(':model', () => {
  it('shows the policy and the override', async () => {
    const out = (await runCommand(session, ':model')).output;
    expect(out).toContain('model override: (none)');
    expect(out).toContain('agent policy:   local-first');
  });

  it('sets and clears the override', async () => {
    await runCommand(session, ':model gpt-4o');
    expect(session.activeModelOverride()).toBe('gpt-4o');

    await runCommand(session, ':model auto');
    expect(session.activeModelOverride()).toBeUndefined();
  });

  it('reports the model that actually ran, not the one requested', async () => {
    const engine = createFakeEngine({ localAvailable: false });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('do a thing');

    expect((await runCommand(s, ':model')).output).toContain('last run used: cloud-model');
  });
});

describe(':mesh', () => {
  it('shows mesh off by default, with its rules', async () => {
    const out = (await runCommand(session, ':mesh')).output;
    expect(out).toContain('Agent Mesh: off (default)');
    expect(out).toContain('routing rules:');
    expect(out).toContain('(none)');
  });

  it('toggles the mesh', async () => {
    await runCommand(session, ':mesh on');
    expect(session.meshEnabled()).toBe(true);
    await runCommand(session, ':mesh off');
    expect(session.meshEnabled()).toBe(false);
  });

  it('runs a delegated task, falling back locally while no transport exists', async () => {
    await runCommand(session, ':mesh on');
    const out = (await runCommand(session, ':mesh run tidy the imports')).output;
    expect(out).toBeTruthy();
  });

  it('rejects malformed usage', async () => {
    expect((await runCommand(session, ':mesh sideways')).output).toContain('usage:');
    expect((await runCommand(session, ':mesh run ')).output).toContain('usage:');
  });
});

describe(':council', () => {
  it('requires roles and a question separated by "?"', async () => {
    expect((await runCommand(session, ':council security,perf')).output)
      .toMatch(/roles and one question/);
  });

  it('reports seats, agreements, synthesis and verification state', async () => {
    const engine = createFakeEngine({
      verifyPasses: true,
      councilAnswers: {
        security: 'We should rate limit the token endpoint before caching it.',
        performance: 'We should rate limit the token endpoint before caching it.',
      },
      run: req => (req.task.startsWith('Synthesise') ? { summary: 'Rate limit first.' } : {}),
    });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });

    const out = (await runCommand(s, ':council security,performance ? should we cache tokens')).output;
    expect(out).toContain('2/2 seats answered');
    expect(out).toContain('agreements:');
    expect(out).toContain('Rate limit first.');
    expect(out).toContain('verification: verified');
  });

  it('surfaces a council error rather than throwing', async () => {
    const engine = createFakeEngine({ councilFailures: ['a'] });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    expect((await runCommand(s, ':council a ? q')).output).toContain('council:');
  });
});

describe(':memory', () => {
  it('summarises the separate stores', async () => {
    const out = (await runCommand(session, ':memory')).output;
    expect(out).toContain('conversations');
    expect(out).toContain('episodes');
    expect(out).toContain('agents');
    expect(out).toContain('preferences');
  });

  it('shows retrieved records with their verification state and ranking reason', async () => {
    knowledgeStore.save({
      text: 'the retry budget is four attempts',
      provenance: {
        source: 'test', createdAt: new Date().toISOString(),
        confidence: 0.9, verification: 'verified', projectRoot: '/proj',
      },
    });

    const out = (await runCommand(session, ':memory retry budget')).output;
    expect(out).toContain('[verified]');
    expect(out).toContain('verified engineering experience');
  });

  it('says so when nothing matches', async () => {
    expect((await runCommand(session, ':memory zzzz')).output).toContain('nothing retrieved');
  });
});

describe(':verify and :status', () => {
  it('says there is nothing to verify before a turn', async () => {
    expect((await runCommand(session, ':verify')).output).toBe('nothing to verify yet');
  });

  it('reports the gate decision, checks and evidence', async () => {
    const engine = createFakeEngine({
      verifyPasses: true,
      run: { toolCalls: [
        { name: 'edit_file', input: { path: 'a.ts' } },
        { name: 'run_shell', input: { command: 'npm test' } },
      ] },
    });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('change a file');

    const out = (await runCommand(s, ':verify')).output;
    expect(out).toContain('verification: verified');
    expect(out).toContain('1 file(s) changed');
    expect(out).toContain('1 test command(s) run');
  });

  it(':status shows only agent, model, verification, mesh and the last turn', async () => {
    const engine = createFakeEngine({ localAvailable: false, run: { toolCalls: [] } });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('a task');

    const out = (await runCommand(s, ':status')).output;
    expect(out).toContain('agent        :');
    expect(out).toContain('verification :');
    expect(out).toContain('mesh         : off');
    expect(out).toContain('fallback: local-model → cloud-model');
    // No dashboards, graphs or telemetry on the default surface.
    expect(out).not.toMatch(/graph|dashboard|telemetry/i);
  });
});

describe('default screen rendering', () => {
  it('shows agent, model and verification state, and hides mesh while it is off', () => {
    const line = renderStatusLine({
      agentName: 'Fixer', model: 'local-model', isLocal: true,
      verification: 'verified', meshEnabled: false,
    }, false);

    expect(line).toContain('Fixer');
    expect(line).toContain('local-model (local)');
    expect(line).toContain('verified');
    expect(line).not.toContain('mesh');
  });

  it('shows mesh once it is on', () => {
    const line = renderStatusLine({
      agentName: 'Fixer', model: 'm', isLocal: false,
      verification: 'unverified', meshEnabled: true,
    }, false);
    expect(line).toContain('mesh:on');
  });

  it('renders a turn as reply plus verification state, and names fallbacks and denials', () => {
    const out = formatTurn({
      reply: 'done',
      verification: { state: 'rejected', decision: 'no' },
      fallback: { from: 'mesh:x', to: 'local-agent', reason: 'unavailable' },
      deniedActions: [{ tool: 'run_shell', reason: 'not granted' }],
    });

    expect(out).toContain('done');
    expect(out).toContain('— rejected');
    expect(out).toContain('mesh:x → local-agent');
    expect(out).toContain('denied: run_shell');
  });
});

describe('provider commands', () => {
  let mock: MockProvider | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });

  /** Connects the session's store to the mock endpoint, as :setup would have. */
  async function connect(model = 'mock-mini', name = 'local'): Promise<MockProvider> {
    mock = await startMockProvider();
    providerStore.upsert({ name, baseUrl: `${mock.origin}/v1`, apiKey: MOCK_KEY, model, createdAt: new Date().toISOString() });
    return mock;
  }

  it(':provider says how to get started when nothing is set up', async () => {
    const out = (await runCommand(session, ':provider')).output;
    expect(out).toMatch(/no provider is set up/);
    expect(out).toContain(':setup');
  });

  it(':setup outside a terminal explains itself instead of hanging', async () => {
    expect((await runCommand(session, ':setup')).output).toMatch(/interactive terminal/);
  });

  it(':setup runs the dialogue, saves the provider, and drops a stale :model override', async () => {
    mock = await startMockProvider();
    session.setModelOverride('stale-model-from-before');
    const s = scriptedIO([`${mock.origin}/v1`, MOCK_KEY, '3']);

    const out = (await runCommand(session, ':setup', q => s.io.ask(q), { askSecret: q => s.io.askSecret(q), write: t => s.io.write(t) })).output;

    expect(out).toMatch(/now using local/);
    expect(providerStore.active()).toMatchObject({ model: 'mock-small' });
    expect(session.activeModelOverride()).toBeUndefined();
    expect(session.effectiveModel()).toBe('mock-small');
  });

  it(':setup that is abandoned changes nothing and says so', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, 'sk-not-the-key-000000', '']);
    const out = (await runCommand(session, ':setup', q => s.io.ask(q), { askSecret: q => s.io.askSecret(q), write: t => s.io.write(t) })).output;
    expect(out).toMatch(/setup cancelled/);
    expect(providerStore.list()).toEqual([]);
  });

  it(':provider lists profiles, marks the active one, and never shows a key', async () => {
    await connect();
    providerStore.upsert({ name: 'other', baseUrl: 'https://api.other.example/v1', apiKey: 'sk-other-key-abcdef123456', model: 'o-1', createdAt: '2026-01-01T00:00:00Z' }, { activate: false });

    const out = (await runCommand(session, ':provider')).output;

    expect(out).toMatch(/\* local/);
    expect(out).toMatch(/ {3}other/);
    expect(out).not.toContain(MOCK_KEY);
    expect(out).not.toContain('sk-other-key-abcdef123456');
  });

  it(':provider <name> switches, by exact name or unique prefix, and drops a stale override', async () => {
    await connect();
    providerStore.upsert({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-key-abcdef1234567', model: 'x/y', createdAt: '2026-01-01T00:00:00Z' }, { activate: false });
    session.setModelOverride('old');

    const out = (await runCommand(session, ':provider open')).output;

    expect(out).toMatch(/now using openrouter — x\/y/);
    expect(providerStore.active()?.name).toBe('openrouter');
    expect(session.activeModelOverride()).toBeUndefined();
    expect((await runCommand(session, ':provider use local')).output).toMatch(/now using local/);
  });

  it(':provider <unknown> says so and points at the list', async () => {
    await connect();
    expect((await runCommand(session, ':provider nope')).output).toMatch(/no provider "nope"/);
    expect(providerStore.active()?.name).toBe('local');
  });

  it(':provider remove forgets the profile and its key and reports what is in use now', async () => {
    await connect();
    providerStore.upsert({ name: 'second', baseUrl: 'https://api.second.example/v1', apiKey: 'sk-second-key-abcdef1234', model: 's-1', createdAt: '2026-01-01T00:00:00Z' }, { activate: false });

    const out = (await runCommand(session, ':provider remove local')).output;

    expect(out).toMatch(/removed local and its saved key/);
    expect(out).toMatch(/now using second/);
    expect(fs.readFileSync(providerStore.filePath(), 'utf8')).not.toContain(MOCK_KEY);
  });

  it(':provider remove of the last one says none is set up', async () => {
    await connect();
    expect((await runCommand(session, ':provider remove local')).output).toMatch(/no provider is set up/);
  });

  it(':status shows the provider, and the model comes from it', async () => {
    await connect('mock-large');
    const out = (await runCommand(session, ':status')).output;
    expect(out).toMatch(/provider\s+: local \(http:\/\/127\.0\.0\.1:\d+\/v1\)/);
    expect(out).toMatch(/model\s+: mock-large/);
    expect(out).not.toContain(MOCK_KEY);
  });

  it(':status before setup points at :setup', async () => {
    expect((await runCommand(session, ':status')).output).toMatch(/provider\s+: \(none — :setup connects one\)/);
  });
});

describe(':model with a provider connected', () => {
  let mock: MockProvider | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });

  async function connect(model = 'mock-mini'): Promise<MockProvider> {
    mock = await startMockProvider();
    providerStore.upsert({ name: 'local', baseUrl: `${mock.origin}/v1`, apiKey: MOCK_KEY, model, createdAt: new Date().toISOString() });
    return mock;
  }

  it('lists what the provider offers, marking the current model', async () => {
    await connect('mock-mini');
    const out = (await runCommand(session, ':model')).output;
    expect(out).toMatch(/provider: {5}local/);
    expect(out).toMatch(/model: {8}mock-mini/);
    expect(out).toMatch(/1 {2}mock-large/);
    expect(out).toMatch(/\* 2 {2}mock-mini/);
    expect(out).toMatch(/3 {2}mock-small/);
  });

  it('switches by number against the list the provider reported', async () => {
    await connect('mock-mini');
    const out = (await runCommand(session, ':model 3')).output;
    expect(out).toMatch(/model: mock-small {2}\(local\)/);
    expect(providerStore.active()?.model).toBe('mock-small');
    expect(session.effectiveModel()).toBe('mock-small');
  });

  it('switches by exact name or unique fragment', async () => {
    await connect();
    await runCommand(session, ':model mock-large');
    expect(providerStore.active()?.model).toBe('mock-large');
    await runCommand(session, ':model small');
    expect(providerStore.active()?.model).toBe('mock-small');
  });

  it('reports an ambiguous fragment instead of guessing', async () => {
    await connect();
    const out = (await runCommand(session, ':model mock')).output;
    expect(out).toMatch(/matches 3 models/);
    expect(providerStore.active()?.model).toBe('mock-mini'); // unchanged
  });

  it('refuses a name the provider does not list, and takes it with "="', async () => {
    await connect();
    expect((await runCommand(session, ':model gpt-99')).output).toMatch(/no model matches/);
    expect(providerStore.active()?.model).toBe('mock-mini');

    await runCommand(session, ':model =my-finetune');
    expect(providerStore.active()?.model).toBe('my-finetune');
  });

  it('a number that is out of range is explained', async () => {
    await connect();
    expect((await runCommand(session, ':model 42')).output).toMatch(/no entry 42/);
  });

  it('drops a stale session override so the switch is not silently ignored', async () => {
    await connect();
    session.setModelOverride('stale');
    await runCommand(session, ':model 1');
    expect(session.activeModelOverride()).toBeUndefined();
    expect(session.effectiveModel()).toBe('mock-large');
  });

  it(':model auto clears an override and says which model is in use', async () => {
    await connect('mock-small');
    session.setModelOverride('stale');
    const out = (await runCommand(session, ':model auto')).output;
    expect(out).toMatch(/using mock-small from local/);
    expect(session.activeModelOverride()).toBeUndefined();
  });

  it('with a terminal, lets the person pick from the list', async () => {
    await connect('mock-mini');
    const s = scriptedIO(['1']);
    const out = (await runCommand(session, ':model', q => s.io.ask(q), { askSecret: q => s.io.askSecret(q), write: t => s.io.write(t) })).output;
    expect(out).toMatch(/model: mock-large/);
    expect(providerStore.active()?.model).toBe('mock-large');
    expect(s.text()).toMatch(/Enter keeps mock-mini/);
  });

  it('with a terminal, Enter keeps the current model', async () => {
    await connect('mock-mini');
    const s = scriptedIO(['']);
    const out = (await runCommand(session, ':model', q => s.io.ask(q), { askSecret: q => s.io.askSecret(q), write: t => s.io.write(t) })).output;
    expect(out).toMatch(/model unchanged: mock-mini/);
  });

  it('when the list is unreachable, says why and still lets a typed name through', async () => {
    const m = await connect();
    await m.close();
    mock = undefined;

    const shown = (await runCommand(session, ':model')).output;
    expect(shown).toMatch(/could not reach/);

    expect((await runCommand(session, ':model 2')).output).toMatch(/cannot resolve "2" without the model list/);
    const typed = (await runCommand(session, ':model my-model')).output;
    expect(typed).toMatch(/model: my-model/);
    expect(typed).toMatch(/could not check local's list/);
    expect(providerStore.active()?.model).toBe('my-model');
  });

  it('warns when the agent is pinned to a model, since the pin wins', async () => {
    await connect();
    session.setAgent({ ...defaultAgent(), name: 'Pinned', modelPolicy: { kind: 'pinned', model: 'gpt-4o' } });
    const out = (await runCommand(session, ':model 1')).output;
    expect(out).toMatch(/pinned to gpt-4o, which takes precedence/);
  });

  it('never prints the key', async () => {
    await connect();
    for (const cmd of [':model', ':model 1', ':provider', ':status']) {
      expect((await runCommand(session, cmd)).output, cmd).not.toContain(MOCK_KEY);
    }
  });
});

describe(':model without a provider (unchanged behaviour)', () => {
  it('still sets a free-text override, and points at :setup', async () => {
    const shown = (await runCommand(session, ':model')).output;
    expect(shown).toContain('model override: (none)');
    expect(shown).toContain(':setup');
    await runCommand(session, ':model gpt-4o');
    expect(session.activeModelOverride()).toBe('gpt-4o');
  });
});

describe('help text', () => {
  it('lists the provider commands', async () => {
    const out = (await runCommand(session, ':help')).output;
    expect(out).toContain(':setup');
    expect(out).toContain(':provider');
  });

  it('renders the provider in the status line, except while a local model answers', () => {
    const base = { agentName: 'Default', model: 'gpt-4o', verification: 'unverified' as const, meshEnabled: false };
    expect(renderStatusLine({ ...base, provider: 'openai', isLocal: false })).toContain('[openai] gpt-4o');
    expect(renderStatusLine({ ...base, provider: 'openai', isLocal: true })).not.toContain('[openai]');
    expect(renderStatusLine({ ...base, isLocal: false })).not.toMatch(/\[\w+\] gpt-4o/);
  });
});
