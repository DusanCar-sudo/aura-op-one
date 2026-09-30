import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  agentStore,
  conversationStore,
  preferencesStore,
  knowledgeStore,
  opOneEpisodeStore,
  providerStore,
  opOneRoot,
} from '../src/stores.js';
import { defaultAgent } from '../src/agent-schema.js';
import { redactSecrets, clearRegisteredSecrets } from '../src/redact.js';
import type { OpOneEpisode, Provenance } from '../src/types.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-stores-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    source: 'test',
    createdAt: new Date().toISOString(),
    confidence: 0.9,
    verification: 'verified',
    ...over,
  };
}

describe('storage root', () => {
  it('is overridable so nothing in tests touches the real ~/.aura', () => {
    expect(opOneRoot()).toBe(tmp);
  });
});

describe('conversation persistence', () => {
  it('persists turns across separate reads', () => {
    const conv = conversationStore.create();
    conversationStore.append(conv.id, { role: 'user', content: 'hello', at: new Date().toISOString() });
    conversationStore.append(conv.id, {
      role: 'assistant',
      content: 'hi',
      at: new Date().toISOString(),
      agentId: 'default',
      model: 'local-model',
      verification: 'verified',
    });

    const reloaded = conversationStore.get(conv.id);
    expect(reloaded?.turns).toHaveLength(2);
    expect(reloaded?.turns[1].verification).toBe('verified');
    expect(reloaded?.turns[1].model).toBe('local-model');
  });

  it('titles a conversation from its first user message', () => {
    const conv = conversationStore.create();
    conversationStore.append(conv.id, {
      role: 'user',
      content: 'improve the pagination helper',
      at: new Date().toISOString(),
    });
    expect(conversationStore.get(conv.id)?.title).toBe('improve the pagination helper');
  });

  it('lists conversations most-recently-updated first', () => {
    const a = conversationStore.create('a');
    const b = conversationStore.create('b');
    // Written explicitly: `create` twice in the same millisecond would leave the
    // ordering genuinely tied, which would test the clock rather than the sort.
    // (`save` stamps updatedAt itself, so the fixture is written directly.)
    for (const [id, at] of [[a.id, '2026-01-02T00:00:00.000Z'], [b.id, '2026-01-01T00:00:00.000Z']]) {
      fs.writeFileSync(
        conversationStore.filePath(id),
        JSON.stringify({ ...conversationStore.get(id)!, updatedAt: at }),
      );
    }

    expect(conversationStore.list().map(c => c.id)).toEqual([a.id, b.id]);
  });

  it('survives a corrupt file rather than failing the whole list', () => {
    conversationStore.create('good');
    fs.writeFileSync(path.join(conversationStore.dir(), 'broken.json'), '{ not json');
    expect(conversationStore.list()).toHaveLength(1);
  });
});

describe('agent store', () => {
  it('round-trips a schema-valid agent', () => {
    const agent = agentStore.create({ ...defaultAgent(), id: 'writer' });
    expect(agentStore.get('writer')?.name).toBe(agent.name);
    expect(agentStore.list().map(a => a.id)).toEqual(['writer']);
  });

  it('refuses to persist an invalid definition', () => {
    expect(() => agentStore.save({ ...defaultAgent(), permittedTools: ['nope'] } as never))
      .toThrow(/unknown tool/);
  });

  it('skips a hand-corrupted definition instead of failing the list', () => {
    agentStore.create({ ...defaultAgent(), id: 'good' });
    fs.writeFileSync(path.join(agentStore.dir(), 'bad.json'), JSON.stringify({ id: 'bad' }));
    expect(agentStore.list().map(a => a.id)).toEqual(['good']);
    expect(agentStore.get('bad')).toBeUndefined();
  });
});

describe('preferences', () => {
  it('defaults the mesh to disabled', () => {
    expect(preferencesStore.load().mesh.enabled).toBe(false);
  });

  it('merges an older file that predates the mesh field, keeping mesh off', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(preferencesStore.filePath(), JSON.stringify({ notes: ['n'] }));
    const prefs = preferencesStore.load();
    expect(prefs.mesh.enabled).toBe(false);
    expect(prefs.notes).toEqual(['n']);
  });

  it('persists updates', () => {
    preferencesStore.update({ defaultAgentId: 'writer' });
    expect(preferencesStore.load().defaultAgentId).toBe('writer');
  });
});

describe('knowledge store', () => {
  it('accepts verified items', () => {
    const item = knowledgeStore.save({ text: 'cache the token endpoint', provenance: provenance() });
    expect(knowledgeStore.list().map(k => k.id)).toEqual([item.id]);
  });

  it('refuses unverified items — the knowledge tier stays the trustworthy one', () => {
    for (const state of ['unverified', 'rejected', 'escalated', 'verification_pending'] as const) {
      expect(() =>
        knowledgeStore.save({ text: 'x', provenance: provenance({ verification: state }) }),
      ).toThrow(/verified items only/);
    }
    expect(knowledgeStore.list()).toHaveLength(0);
  });
});

describe('episode store', () => {
  function episode(over: Partial<OpOneEpisode> = {}): OpOneEpisode {
    return {
      id: 'ep_1',
      at: new Date().toISOString(),
      projectRoot: '/proj',
      request: 'fix the bug',
      agentId: 'default',
      model: 'local-model',
      usedLocalModel: true,
      mode: 'local-agent',
      retrievedMemoryIds: [],
      summary: 'fixed',
      verification: {
        state: 'verified',
        decision: 'ok',
        checks: [],
        evidence: { toolCalls: [], filesChanged: ['a.ts'], testsExecuted: ['npm test'] },
        at: new Date().toISOString(),
      },
      durationMs: 10,
      tokens: { input: 1, output: 2 },
      ...over,
    };
  }

  it('round-trips an episode with its evidence', () => {
    opOneEpisodeStore.save(episode());
    const got = opOneEpisodeStore.get('ep_1');
    expect(got?.verification.evidence.filesChanged).toEqual(['a.ts']);
    expect(got?.verification.evidence.testsExecuted).toEqual(['npm test']);
  });

  it('lists newest first', () => {
    opOneEpisodeStore.save(episode({ id: 'old', at: '2026-01-01T00:00:00.000Z' }));
    opOneEpisodeStore.save(episode({ id: 'new', at: '2026-06-01T00:00:00.000Z' }));
    expect(opOneEpisodeStore.list().map(e => e.id)).toEqual(['new', 'old']);
  });
});

describe('provider store', () => {
  const profile = (over: Partial<import('../src/types.js').ProviderProfile> = {}) => ({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key-abcdef123456',
    model: 'gpt-4o',
    createdAt: '2026-09-30T00:00:00.000Z',
    ...over,
  });

  it('starts empty: no active provider and the welcome not skipped', () => {
    expect(providerStore.list()).toEqual([]);
    expect(providerStore.active()).toBeUndefined();
    expect(providerStore.welcomeSkipped()).toBe(false);
  });

  it('saves a profile, activates it, and reads it back from disk', () => {
    providerStore.upsert(profile());
    expect(providerStore.active()).toMatchObject({ name: 'openai', model: 'gpt-4o' });
    expect(fs.existsSync(path.join(tmp, 'providers.json'))).toBe(true);
  });

  it('keeps the key file readable by its owner only', () => {
    providerStore.upsert(profile());
    const mode = fs.statSync(providerStore.filePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp file behind after a write', () => {
    providerStore.upsert(profile());
    expect(fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a profile of the same name instead of duplicating it', () => {
    providerStore.upsert(profile());
    providerStore.upsert(profile({ model: 'gpt-4o-mini' }));
    expect(providerStore.list()).toHaveLength(1);
    expect(providerStore.get('openai')?.model).toBe('gpt-4o-mini');
  });

  it('switches the active provider and changes a profile\'s model', () => {
    providerStore.upsert(profile());
    providerStore.upsert(profile({ name: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3' }));
    expect(providerStore.active()?.name).toBe('local');

    expect(providerStore.setActive('openai')?.name).toBe('openai');
    expect(providerStore.active()?.name).toBe('openai');
    expect(providerStore.setActive('nope')).toBeUndefined();

    expect(providerStore.setModel('openai', ' gpt-4.1 ')?.model).toBe('gpt-4.1');
    expect(providerStore.setModel('openai', '   ')).toBeUndefined();
  });

  it('finds the profile for an endpoint so setup can update rather than add', () => {
    providerStore.upsert(profile());
    expect(providerStore.findByUrl('https://api.openai.com/v1')?.name).toBe('openai');
    expect(providerStore.findByUrl('https://elsewhere.example/v1')).toBeUndefined();
  });

  it('removing the active profile hands over to the next one, and removing the last leaves none', () => {
    providerStore.upsert(profile());
    providerStore.upsert(profile({ name: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3' }));
    expect(providerStore.remove('local')).toBe(true);
    expect(providerStore.active()?.name).toBe('openai');
    expect(providerStore.remove('openai')).toBe(true);
    expect(providerStore.active()).toBeUndefined();
    expect(providerStore.remove('openai')).toBe(false);
  });

  it('refuses a profile with no model', () => {
    expect(() => providerStore.upsert(profile({ model: '' }))).toThrow(/needs a name, a base URL and a model/);
  });

  it('drops malformed entries from a hand-edited file instead of crashing', () => {
    fs.writeFileSync(
      providerStore.filePath(),
      JSON.stringify({ active: 'ok', profiles: [{ name: 'ok', baseUrl: 'http://x/v1', model: 'm', apiKey: '' }, { name: 5 }, 'junk', null] }),
    );
    expect(providerStore.list().map(p => p.name)).toEqual(['ok']);
    expect(providerStore.active()?.name).toBe('ok');
  });

  it('survives a corrupt file', () => {
    fs.writeFileSync(providerStore.filePath(), '{not json');
    expect(providerStore.list()).toEqual([]);
  });

  it('remembers a skipped welcome across a later save', () => {
    providerStore.skipWelcome();
    providerStore.upsert(profile());
    expect(providerStore.welcomeSkipped()).toBe(true);
  });

  it('registers stored keys so they are redacted everywhere afterwards', () => {
    providerStore.upsert(profile({ apiKey: 'plain-not-pattern-shaped-key-77' }));
    clearRegisteredSecrets();
    providerStore.load();
    expect(redactSecrets('the key is plain-not-pattern-shaped-key-77 ok')).not.toContain('plain-not-pattern-shaped-key-77');
  });
});
