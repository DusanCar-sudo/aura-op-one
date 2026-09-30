import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeBaseUrl,
  deriveProfileName,
  parseModelIds,
  buildModelsRequest,
  fetchModels,
  discoverModels,
} from '../src/providers.js';
import { startMockProvider, MOCK_KEY, type MockProvider } from './mock-provider.js';

describe('normalizeBaseUrl', () => {
  it('leaves a clean base URL alone and drops trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });
    expect(normalizeBaseUrl('https://api.openai.com/v1///')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });
  });

  it('adds a scheme: http for this machine, https for everything else', () => {
    expect(normalizeBaseUrl('localhost:11434/v1')).toEqual({ ok: true, url: 'http://localhost:11434/v1' });
    expect(normalizeBaseUrl('127.0.0.1:1234')).toEqual({ ok: true, url: 'http://127.0.0.1:1234' });
    expect(normalizeBaseUrl('openrouter.ai/api/v1')).toEqual({ ok: true, url: 'https://openrouter.ai/api/v1' });
  });

  it('cuts a pasted full endpoint back to the base', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/chat/completions')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });
    expect(normalizeBaseUrl('https://api.openai.com/v1/models')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });
  });

  it('refuses a key smuggled into the URL rather than storing it as a plain address', () => {
    for (const bad of ['https://user:secret@api.example.com/v1', 'https://api.example.com/v1?api_key=sk-abc', 'https://api.example.com/v1#frag']) {
      const r = normalizeBaseUrl(bad);
      expect(r.ok, bad).toBe(false);
    }
  });

  it('rejects empty input and non-http schemes', () => {
    expect(normalizeBaseUrl('   ').ok).toBe(false);
    expect(normalizeBaseUrl('ftp://example.com').ok).toBe(false);
  });

  it('never echoes a key-shaped string back in an error', () => {
    const r = normalizeBaseUrl('https://exa mple.com/?key=sk-abcdefghijklmnop1234');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('sk-abcdefghijklmnop1234');
  });
});

describe('deriveProfileName', () => {
  it('names well-known endpoints by what people call them', () => {
    expect(deriveProfileName('https://api.openai.com/v1', [])).toBe('openai');
    expect(deriveProfileName('https://openrouter.ai/api/v1', [])).toBe('openrouter');
    expect(deriveProfileName('http://localhost:11434/v1', [])).toBe('ollama');
    expect(deriveProfileName('http://localhost:1234/v1', [])).toBe('lm-studio');
    expect(deriveProfileName('http://127.0.0.1:8000/v1', [])).toBe('local');
    expect(deriveProfileName('http://10.0.0.5:8000/v1', [])).toBe('10-0-0-5');
  });

  it('keeps names unique', () => {
    expect(deriveProfileName('https://api.openai.com/v1', ['openai'])).toBe('openai-2');
    expect(deriveProfileName('https://api.openai.com/v1', ['openai', 'openai-2'])).toBe('openai-3');
  });
});

describe('parseModelIds', () => {
  it('reads the OpenAI shape', () => {
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b']);
  });

  it('reads the { models } shape (Ollama, Google) and bare arrays', () => {
    expect(parseModelIds({ models: [{ name: 'llama3' }, { model: 'qwen' }] })).toEqual(['llama3', 'qwen']);
    expect(parseModelIds(['x', 'y'])).toEqual(['x', 'y']);
  });

  it('sorts and de-duplicates so numbering is stable between calls', () => {
    expect(parseModelIds({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm2' }] })).toEqual(['m1', 'm2']);
  });

  it('returns undefined for something that is not a model list', () => {
    expect(parseModelIds({ error: 'nope' })).toBeUndefined();
    expect(parseModelIds('hello')).toBeUndefined();
    expect(parseModelIds(null)).toBeUndefined();
  });

  it('distinguishes "not a list" from "an empty list"', () => {
    expect(parseModelIds({ data: [] })).toEqual([]);
  });
});

describe('buildModelsRequest', () => {
  it('sends a Bearer key to OpenAI-style endpoints', () => {
    const r = buildModelsRequest('https://api.openai.com/v1', 'sk-x');
    expect(r.url).toBe('https://api.openai.com/v1/models');
    expect(r.headers.Authorization).toBe('Bearer sk-x');
    expect(r.headers['x-api-key']).toBeUndefined();
  });

  it('sends no Authorization header for a keyless endpoint', () => {
    expect(buildModelsRequest('http://localhost:11434/v1', '').headers.Authorization).toBeUndefined();
  });

  it('adds Anthropic\'s own headers and asks for the full page', () => {
    const r = buildModelsRequest('https://api.anthropic.com/v1', 'sk-ant-x');
    expect(r.headers['x-api-key']).toBe('sk-ant-x');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
  });
});

describe('fetchModels / discoverModels against a live endpoint', () => {
  let mock: MockProvider | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });

  it('lists the models the endpoint reports, sending the key', async () => {
    mock = await startMockProvider();
    const r = await fetchModels(`${mock.origin}/v1`, MOCK_KEY);
    expect(r).toEqual({ ok: true, models: ['mock-large', 'mock-mini', 'mock-small'], baseUrl: `${mock.origin}/v1` });
    expect(mock.requests[0].authorization).toBe(`Bearer ${MOCK_KEY}`);
  });

  it('reports a rejected key as an auth failure that never contains the key', async () => {
    mock = await startMockProvider();
    const r = await fetchModels(`${mock.origin}/v1`, 'sk-wrong-key-987654321');
    expect(r).toMatchObject({ ok: false, kind: 'auth', status: 401 });
    expect(JSON.stringify(r)).not.toContain('sk-wrong-key-987654321');
  });

  it('reports a missing model list as not-found', async () => {
    mock = await startMockProvider({ modelsAt: '/elsewhere' });
    const r = await fetchModels(`${mock.origin}/v1`, MOCK_KEY);
    expect(r).toMatchObject({ ok: false, kind: 'not-found' });
  });

  it('reports a web page (or any non-JSON body) as a bad response', async () => {
    mock = await startMockProvider({ modelsBody: () => ({ status: 200, body: '<html>hi</html>', type: 'text/html' }) });
    const r = await fetchModels(`${mock.origin}/v1`, MOCK_KEY);
    expect(r).toMatchObject({ ok: false, kind: 'bad-response' });
  });

  it('reports a server error with a redacted snippet', async () => {
    mock = await startMockProvider({ modelsBody: () => ({ status: 500, body: 'boom key=sk-leakedleakedleaked123' }) });
    const r = await fetchModels(`${mock.origin}/v1`, MOCK_KEY);
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 500 });
    expect(JSON.stringify(r)).not.toContain('sk-leakedleakedleaked123');
  });

  it('reports a dead address as unreachable, in words', async () => {
    mock = await startMockProvider();
    const dead = mock.origin;
    await mock.close();
    mock = undefined;
    const r = await fetchModels(`${dead}/v1`, MOCK_KEY, { timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, kind: 'unreachable' });
    if (!r.ok) expect(r.message).toMatch(/could not reach/);
  });

  it('retries a bare host with /v1 and returns the URL that worked', async () => {
    mock = await startMockProvider();
    const r = await discoverModels(mock.origin, MOCK_KEY);
    expect(r).toMatchObject({ ok: true, baseUrl: `${mock.origin}/v1` });
  });

  it('does not invent a /v1 for an address that already has a path', async () => {
    mock = await startMockProvider({ modelsAt: '/nowhere' });
    const r = await discoverModels(`${mock.origin}/api`, MOCK_KEY);
    expect(r.ok).toBe(false);
    expect(mock.requests.filter(q => q.url.startsWith('/api/v1'))).toHaveLength(0);
  });
});
