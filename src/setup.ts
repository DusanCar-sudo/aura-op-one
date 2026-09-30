// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — first-run welcome and provider setup
// ─────────────────────────────────────────────────────────────────────────────
//
// Connecting a model takes three things: a base URL, an API key, and a model
// name. The model name is the one people get wrong from memory, so it is never
// typed blind — once the URL and key are in, the endpoint is asked which models
// it offers and the person picks from that list.
//
// The same dialogue serves the first-run welcome and `:setup` / `:provider add`;
// `pickModel` is also what `:model` uses to switch models later.

import type { ProviderProfile } from './types.js';
import { providerStore } from './stores.js';
import { registerSecret } from './redact.js';
import { discoverModels, deriveProfileName, normalizeBaseUrl } from './providers.js';

/** The terminal, as the wizard needs it. Tests supply scripted answers. */
export interface SetupIO {
  ask(question: string): Promise<string>;
  /** Like `ask`, for the API key: not echoed. */
  askSecret(question: string): Promise<string>;
  write(text: string): void;
}

export interface SetupOptions {
  /** First run: shows the welcome text and remembers a skip so it does not nag. */
  welcome?: boolean;
  /** Replaces the network call. For tests. */
  discover?: typeof discoverModels;
}

export type SetupOutcome =
  | { status: 'saved'; profile: ProviderProfile }
  | { status: 'skipped' }
  | { status: 'cancelled'; reason: string };

/** Bounds every loop, so a closed stdin (which answers '') can never spin. */
const MAX_ATTEMPTS = 4;
/** Longest model list printed in full; beyond it the person filters by typing. */
const MAX_SHOWN = 40;

const EXAMPLE_URLS = [
  'https://api.openai.com/v1',
  'https://api.anthropic.com/v1',
  'https://generativelanguage.googleapis.com/v1beta/openai',
  'https://openrouter.ai/api/v1',
  'http://localhost:11434/v1        (Ollama — no key needed)',
];

function welcomeText(): string {
  return [
    'Welcome to Aura OP One.',
    '',
    'Connecting a model takes three things:',
    '  1. the provider\'s base URL',
    '  2. your API key',
    '  3. the model — which you pick from the list the provider reports',
    '',
    ...urlExamples(),
    '',
    `Your key is kept on this machine only, in ${providerStore.filePath()}`,
    '(readable by you alone) and is never shown or logged.',
    'Keys already in your environment (ANTHROPIC_API_KEY and the like) keep working:',
    'press Enter at the URL prompt to skip, and :setup brings this back any time.',
    '',
  ].join('\n');
}

function addText(): string {
  return ['Add a provider — base URL, API key, then pick a model.', '', ...urlExamples(), ''].join('\n');
}

function urlExamples(): string[] {
  return ['Base URL examples:', ...EXAMPLE_URLS.map(u => `  ${u}`)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Choosing from a list
// ─────────────────────────────────────────────────────────────────────────────

export type ModelChoice =
  | { kind: 'one'; model: string }
  | { kind: 'many'; matches: string[] }
  | { kind: 'none'; reason: string };

/**
 * Resolves what the person typed against a model list: a number from the list
 * on screen, an exact id, or a fragment that narrows to one. A leading `=` takes
 * the rest literally, for a model the endpoint does not list.
 *
 * `shown` is what is currently numbered on screen (it shrinks as the person
 * filters); `all` is everything the endpoint offers.
 */
export function matchModelChoice(shown: string[], all: string[], input: string): ModelChoice {
  const text = input.trim();
  if (!text) return { kind: 'none', reason: 'nothing typed' };

  if (text.startsWith('=')) {
    const literal = text.slice(1).trim();
    return literal ? { kind: 'one', model: literal } : { kind: 'none', reason: 'nothing after "="' };
  }

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= shown.length
      ? { kind: 'one', model: shown[n - 1] }
      : { kind: 'none', reason: `no entry ${n} — the list has ${shown.length}` };
  }

  const exact = all.find(m => m === text) ?? all.find(m => m.toLowerCase() === text.toLowerCase());
  if (exact) return { kind: 'one', model: exact };

  const needle = text.toLowerCase();
  const matches = all.filter(m => m.toLowerCase().includes(needle));
  if (matches.length === 1) return { kind: 'one', model: matches[0] };
  if (matches.length > 1) return { kind: 'many', matches };
  return { kind: 'none', reason: `no model matches "${text}"` };
}

/** Prints a numbered model list, marking the current one. */
export function renderModelList(models: string[], current?: string): string {
  const width = String(Math.min(models.length, MAX_SHOWN)).length;
  const lines = models.slice(0, MAX_SHOWN).map(
    (m, i) => `  ${current === m ? '*' : ' '} ${String(i + 1).padStart(width)}  ${m}`,
  );
  if (models.length > MAX_SHOWN) {
    lines.push(`    … and ${models.length - MAX_SHOWN} more — type part of a name to narrow the list`);
  }
  return lines.join('\n');
}

/**
 * Lets the person pick a model from the endpoint's own list. Resolves to the
 * chosen id, or undefined when they give up (or input ends).
 */
export async function pickModel(
  io: Pick<SetupIO, 'ask' | 'write'>,
  models: string[],
  current?: string,
): Promise<string | undefined> {
  if (models.length === 0) return undefined;
  if (models.length === 1) {
    io.write(`Only one model is offered: ${models[0]} — using it.\n`);
    return models[0];
  }

  let shown = models;
  let reprint = true;
  let empties = 0;

  for (let round = 0; round < MAX_ATTEMPTS * 3; round++) {
    if (reprint) {
      io.write(`${renderModelList(shown, current)}\n`);
      reprint = false;
    }
    const answer = (await io.ask(
      `Model — number or name${current ? ` (Enter keeps ${current})` : ''}: `,
    )).trim();

    if (!answer) {
      if (current && models.includes(current)) return current;
      if (++empties >= 2) return undefined;
      io.write('Pick one by number, or type part of its name.\n');
      continue;
    }

    const choice = matchModelChoice(shown, models, answer);
    if (choice.kind === 'one') return choice.model;
    if (choice.kind === 'many') {
      shown = choice.matches;
      reprint = true;
      io.write(`${choice.matches.length} models match — pick one:\n`);
    } else {
      io.write(`${choice.reason}. (Prefix with = to use a name that is not listed.)\n`);
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The dialogue
// ─────────────────────────────────────────────────────────────────────────────

/** Cleans a pasted key: whitespace, wrapping quotes, a leading "Bearer ". */
function cleanKey(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * Runs the whole dialogue: base URL → API key → the endpoint's model list → pick
 * → save and activate.
 *
 * Every failure is reported in words and offers a way forward (retry, or type a
 * model name for an endpoint with no list) instead of ending the dialogue.
 */
export async function runSetup(io: SetupIO, opts: SetupOptions = {}): Promise<SetupOutcome> {
  const discover = opts.discover ?? discoverModels;
  io.write(`${opts.welcome ? welcomeText() : addText()}\n`);

  let baseUrl: string | undefined;
  let apiKey: string | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 1. Base URL
    const url = await askBaseUrl(io, baseUrl);
    if (url.kind === 'skip') {
      if (opts.welcome) providerStore.skipWelcome();
      io.write('Skipped — type :setup whenever you are ready.\n');
      return { status: 'skipped' };
    }
    if (url.kind === 'invalid') return { status: 'cancelled', reason: url.reason };
    baseUrl = url.url;

    // 2. API key. A key already saved for this endpoint can be kept with Enter.
    const saved = providerStore.findByUrl(baseUrl);
    const fallbackKey = apiKey ?? saved?.apiKey ?? '';
    const hint = !fallbackKey
      ? 'Enter for none — e.g. a local Ollama'
      : apiKey ? 'Enter keeps the last one entered' : 'Enter keeps the saved one';
    const typed = cleanKey(await io.askSecret(`API key (${hint}): `));
    apiKey = typed || fallbackKey;
    registerSecret(apiKey);

    // 3. Ask the endpoint which models it has.
    io.write(`Asking ${baseUrl} which models it offers…\n`);
    const found = await discover(baseUrl, apiKey);

    let model: string | undefined;
    if (found.ok) {
      if (found.baseUrl !== baseUrl) {
        io.write(`Using ${found.baseUrl}\n`);
        baseUrl = found.baseUrl;
      }
      if (found.models.length === 0) {
        io.write('The provider reports no models.\n');
      } else {
        io.write(`${found.models.length} model${found.models.length === 1 ? '' : 's'} available.\n\n`);
        model = await pickModel(io, found.models, providerStore.findByUrl(baseUrl)?.model);
        if (!model) return { status: 'cancelled', reason: 'no model chosen' };
      }
    } else {
      io.write(`✗ ${found.message}\n`);
    }

    // 4. No list to choose from (or the call failed): retry, type a name, or stop.
    if (!model) {
      const next = (await io.ask(
        'Retry with different details (r), type a model name yourself (t), or cancel (Enter)? ',
      )).trim().toLowerCase();
      if (next.startsWith('t')) {
        const typedModel = (await io.ask('Model name: ')).trim();
        if (!typedModel) return { status: 'cancelled', reason: 'no model chosen' };
        model = typedModel;
      } else if (next.startsWith('r')) {
        continue;
      } else {
        return { status: 'cancelled', reason: found.ok ? 'no models to choose from' : found.message };
      }
    }

    // 5. Save it and make it the one in use.
    const existing = providerStore.findByUrl(baseUrl);
    const name = existing?.name ?? deriveProfileName(baseUrl, providerStore.list().map(p => p.name));
    const profile = providerStore.upsert(
      {
        name,
        baseUrl,
        apiKey,
        model,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      },
      { activate: true },
    );
    io.write(`\n✓ ${profile.name} is ready — ${profile.model} at ${profile.baseUrl}\n`);
    return { status: 'saved', profile };
  }

  return { status: 'cancelled', reason: 'too many attempts' };
}

type UrlAnswer =
  | { kind: 'url'; url: string }
  | { kind: 'skip' }
  | { kind: 'invalid'; reason: string };

async function askBaseUrl(io: SetupIO, current?: string): Promise<UrlAnswer> {
  let lastReason = 'no valid URL given';
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const answer = (await io.ask(current ? `Base URL [${current}]: ` : 'Base URL: ')).trim();
    if (!answer) return current ? { kind: 'url', url: current } : { kind: 'skip' };

    const result = normalizeBaseUrl(answer);
    if (result.ok) return { kind: 'url', url: result.url };
    lastReason = result.reason;
    io.write(`✗ ${result.reason}\n`);
  }
  return { kind: 'invalid', reason: lastReason };
}
