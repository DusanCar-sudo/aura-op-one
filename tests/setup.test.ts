import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSetup, pickModel, matchModelChoice, renderModelList } from '../src/setup.js';
import { providerStore } from '../src/stores.js';
import { clearRegisteredSecrets } from '../src/redact.js';
import { startMockProvider, scriptedIO, MOCK_KEY, type MockProvider } from './mock-provider.js';

let tmp: string;
let prevDir: string | undefined;
let mock: MockProvider | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-setup-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  clearRegisteredSecrets();
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LIST = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'llama3'];

describe('matchModelChoice', () => {
  it('takes a number from the list on screen', () => {
    expect(matchModelChoice(LIST, LIST, '3')).toEqual({ kind: 'one', model: 'claude-sonnet-4-5' });
  });

  it('numbers refer to the filtered list currently shown', () => {
    const shown = ['gpt-4o', 'gpt-4o-mini'];
    expect(matchModelChoice(shown, LIST, '2')).toEqual({ kind: 'one', model: 'gpt-4o-mini' });
  });

  it('rejects a number outside the list', () => {
    expect(matchModelChoice(LIST, LIST, '9')).toMatchObject({ kind: 'none' });
    expect(matchModelChoice(LIST, LIST, '0')).toMatchObject({ kind: 'none' });
  });

  it('prefers an exact id over a substring that also matches others', () => {
    expect(matchModelChoice(LIST, LIST, 'gpt-4o')).toEqual({ kind: 'one', model: 'gpt-4o' });
    expect(matchModelChoice(LIST, LIST, 'GPT-4O-MINI')).toEqual({ kind: 'one', model: 'gpt-4o-mini' });
  });

  it('narrows on a unique fragment and reports an ambiguous one', () => {
    expect(matchModelChoice(LIST, LIST, 'llama')).toEqual({ kind: 'one', model: 'llama3' });
    expect(matchModelChoice(LIST, LIST, 'gpt')).toEqual({ kind: 'many', matches: ['gpt-4o', 'gpt-4o-mini'] });
    expect(matchModelChoice(LIST, LIST, 'nothing-like-it')).toMatchObject({ kind: 'none' });
  });

  it('takes "=name" literally, for a model the endpoint does not list', () => {
    expect(matchModelChoice(LIST, LIST, '=my-finetune')).toEqual({ kind: 'one', model: 'my-finetune' });
    expect(matchModelChoice(LIST, LIST, '=')).toMatchObject({ kind: 'none' });
  });
});

describe('renderModelList', () => {
  it('numbers the models and marks the current one', () => {
    const text = renderModelList(['a', 'b'], 'b');
    expect(text).toContain('1  a');
    expect(text).toMatch(/\* 2 {2}b/);
  });

  it('caps a very long list and says how to narrow it', () => {
    const many = Array.from({ length: 120 }, (_, i) => `m${i}`);
    const text = renderModelList(many);
    expect(text).toContain('and 80 more');
    expect(text).not.toContain('m119');
  });
});

describe('pickModel', () => {
  it('returns the model picked by number', async () => {
    const s = scriptedIO(['2']);
    expect(await pickModel(s.io, LIST)).toBe('gpt-4o-mini');
  });

  it('keeps the current model on Enter', async () => {
    const s = scriptedIO(['']);
    expect(await pickModel(s.io, LIST, 'llama3')).toBe('llama3');
  });

  it('narrows an ambiguous fragment, then accepts a number from the narrowed list', async () => {
    const s = scriptedIO(['gpt', '2']);
    expect(await pickModel(s.io, LIST)).toBe('gpt-4o-mini');
    expect(s.text()).toContain('2 models match');
  });

  it('explains a bad answer and lets the person try again', async () => {
    const s = scriptedIO(['99', '1']);
    expect(await pickModel(s.io, LIST)).toBe('gpt-4o');
    expect(s.text()).toMatch(/no entry 99/);
  });

  it('uses the only model offered without asking', async () => {
    const s = scriptedIO([]);
    expect(await pickModel(s.io, ['solo'])).toBe('solo');
    expect(s.asked).toHaveLength(0);
  });

  it('gives up when input has ended instead of spinning', async () => {
    const s = scriptedIO([]);
    expect(await pickModel(s.io, LIST)).toBeUndefined();
  });
});

describe('runSetup — the first-run dialogue', () => {
  it('walks URL → key → model list → pick, and saves the profile as active', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, MOCK_KEY, '2']);

    const outcome = await runSetup(s.io, { welcome: true });

    expect(outcome.status).toBe('saved');
    const saved = providerStore.active();
    expect(saved).toMatchObject({ baseUrl: `${mock.origin}/v1`, apiKey: MOCK_KEY, model: 'mock-mini' });
    expect(saved?.name).toBe('local');
    expect(s.text()).toContain('Welcome to Aura OP One');
    expect(s.text()).toContain('3 models available');
    expect(s.text()).toContain('✓ local is ready');
  });

  it('asks only for a base URL and a key — the model comes from the list', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, MOCK_KEY, '1']);
    await runSetup(s.io);
    expect(s.asked.map(q => q.split(/[\s(:]/)[0]).slice(0, 2)).toEqual(['Base', 'API']);
    expect(s.asked.some(q => /model name/i.test(q))).toBe(false);
  });

  it('never prints the key', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, MOCK_KEY, '1']);
    await runSetup(s.io, { welcome: true });
    expect(s.text()).not.toContain(MOCK_KEY);
  });

  it('cleans a pasted key: quotes, whitespace and a "Bearer " prefix', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, `  "Bearer ${MOCK_KEY}"  `, '1']);
    expect((await runSetup(s.io)).status).toBe('saved');
    expect(providerStore.active()?.apiKey).toBe(MOCK_KEY);
  });

  it('accepts a bare host and reports the /v1 it settled on', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([mock.origin, MOCK_KEY, '1']);
    const outcome = await runSetup(s.io);
    expect(outcome.status).toBe('saved');
    expect(providerStore.active()?.baseUrl).toBe(`${mock.origin}/v1`);
    expect(s.text()).toContain(`Using ${mock.origin}/v1`);
  });

  it('skipping at the URL prompt saves nothing and is remembered, so it does not nag', async () => {
    const s = scriptedIO(['']);
    expect(await runSetup(s.io, { welcome: true })).toEqual({ status: 'skipped' });
    expect(providerStore.list()).toEqual([]);
    expect(providerStore.welcomeSkipped()).toBe(true);
  });

  it('a skip from :setup (not the welcome) is not remembered', async () => {
    const s = scriptedIO(['']);
    await runSetup(s.io);
    expect(providerStore.welcomeSkipped()).toBe(false);
  });

  it('a wrong key is explained, and a retry with the right one succeeds', async () => {
    mock = await startMockProvider();
    const url = `${mock.origin}/v1`;
    const s = scriptedIO([url, 'sk-wrong-000000000', 'r', url, MOCK_KEY, '1']);

    const outcome = await runSetup(s.io);

    expect(outcome.status).toBe('saved');
    expect(s.text()).toMatch(/rejected the API key/);
    expect(providerStore.active()?.apiKey).toBe(MOCK_KEY);
    expect(s.text()).not.toContain('sk-wrong-000000000');
  });

  it('lets the person type a model name when the endpoint has no list', async () => {
    mock = await startMockProvider({ modelsAt: '/nowhere' });
    const s = scriptedIO([`${mock.origin}/v1`, MOCK_KEY, 't', 'my-model']);
    const outcome = await runSetup(s.io);
    expect(outcome.status).toBe('saved');
    expect(providerStore.active()?.model).toBe('my-model');
  });

  it('cancels with a reason — and changes nothing — when the person gives up', async () => {
    mock = await startMockProvider();
    const s = scriptedIO([`${mock.origin}/v1`, 'sk-wrong-000000000', '']);
    const outcome = await runSetup(s.io);
    expect(outcome).toMatchObject({ status: 'cancelled' });
    expect(providerStore.list()).toEqual([]);
  });

  it('a keyless endpoint (Ollama) works with an empty key', async () => {
    mock = await startMockProvider({ key: null, models: ['llama3', 'qwen'] });
    const s = scriptedIO([`${mock.origin}/v1`, '', '1']);

    const outcome = await runSetup(s.io);

    expect(outcome.status).toBe('saved');
    expect(mock.requests[0].authorization).toBeUndefined();
    expect(providerStore.active()).toMatchObject({ apiKey: '', model: 'llama3' });
    expect(s.text()).toMatch(/Enter for none/);
  });

  it('re-running setup for the same endpoint updates the profile instead of duplicating it', async () => {
    mock = await startMockProvider();
    const url = `${mock.origin}/v1`;
    await runSetup(scriptedIO([url, MOCK_KEY, '1']).io);
    await runSetup(scriptedIO([url, '', '3']).io); // Enter keeps the saved key
    const all = providerStore.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ apiKey: MOCK_KEY, model: 'mock-small' });
  });

  it('two different endpoints become two profiles with distinct names', async () => {
    mock = await startMockProvider();
    const other = await startMockProvider({ key: 'sk-second-endpoint-key-1' });
    try {
      await runSetup(scriptedIO([`${mock.origin}/v1`, MOCK_KEY, '1']).io);
      await runSetup(scriptedIO([`${other.origin}/v1`, 'sk-second-endpoint-key-1', '1']).io);
      const names = providerStore.list().map(p => p.name);
      expect(new Set(names).size).toBe(2);
      expect(providerStore.active()?.baseUrl).toBe(`${other.origin}/v1`);
    } finally {
      await other.close();
    }
  });

  it('closed input ends the dialogue rather than looping', async () => {
    const s = scriptedIO([]);
    const outcome = await runSetup(s.io, { welcome: true });
    expect(outcome.status).toBe('skipped');
  });
});
