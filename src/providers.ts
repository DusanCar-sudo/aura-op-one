// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — provider endpoints
// ─────────────────────────────────────────────────────────────────────────────
//
// The client-side half of "give it a base URL and a key, then pick a model from
// what the provider offers": normalising the URL, asking the endpoint for its
// model list, and naming the saved profile.
//
// This is plain HTTP against the OpenAI-compatible `GET {baseUrl}/models`
// convention, so it needs nothing from aura-code and lives outside the engine
// boundary. aura-code's own live-model lookup only knows a fixed set of vendors;
// this works for any endpoint that follows the convention, which is the point.

import { redactSecrets } from './redact.js';

// ─────────────────────────────────────────────────────────────────────────────
// Base URL
// ─────────────────────────────────────────────────────────────────────────────

export type UrlResult = { ok: true; url: string } | { ok: false; reason: string };

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

/**
 * Turns whatever was typed or pasted into a clean base URL.
 *
 *  - a bare host gets a scheme (http for this machine, https for anything else)
 *  - a pasted full endpoint (`…/chat/completions`, `…/models`) is cut back to the base
 *  - trailing slashes go
 *  - credentials, query strings and fragments are refused, not silently dropped:
 *    a key in the URL would be stored and shown as if it were not a secret
 */
export function normalizeBaseUrl(input: string): UrlResult {
  let s = input.trim();
  if (!s) return { ok: false, reason: 'the URL is empty' };

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:]/)[0];
    s = `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${s}`;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: `"${redactSecrets(input.trim())}" is not a valid URL` };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'the URL must start with http:// or https://' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'put the key in the API key field, not inside the URL' };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: 'the base URL should not contain ? or # — give just the address, e.g. https://api.example.com/v1' };
  }

  const path = u.pathname
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|models|embeddings|responses)$/i, '');
  return { ok: true, url: `${u.origin}${path}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile naming
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_LOCAL_PORTS: Record<string, string> = { '11434': 'ollama', '1234': 'lm-studio' };

/**
 * A short readable handle from the endpoint's address — `api.openai.com/v1`
 * becomes `openai`, `localhost:11434` becomes `ollama` — made unique against
 * `taken`. The person is never asked to name something they just described by URL.
 */
export function deriveProfileName(baseUrl: string, taken: string[]): string {
  let base = 'provider';
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (LOCAL_HOST.test(u.hostname)) {
      base = KNOWN_LOCAL_PORTS[u.port] ?? 'local';
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      base = host.replace(/\./g, '-');
    } else {
      const parts = host.replace(/^(api|www)\./, '').split('.');
      const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      base = label.length >= 3 ? label : parts.join('.');
    }
  } catch {
    // keep the generic name
  }
  base = base.replace(/[^a-z0-9._-]/g, '') || 'provider';

  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model list
// ─────────────────────────────────────────────────────────────────────────────

export type ModelsFailure = 'unreachable' | 'auth' | 'not-found' | 'bad-response' | 'http';

export type ModelsResult =
  | { ok: true; models: string[]; baseUrl: string }
  | { ok: false; kind: ModelsFailure; message: string; status?: number };

export interface FetchModelsOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The URL and headers for the model-list call. Exported so the shape is testable. */
export function buildModelsRequest(
  baseUrl: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let url = `${baseUrl}/models`;

  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Anthropic's own key header and version are required on its model list, and
  // it pages at 20 unless asked for more.
  if (safeHost(baseUrl) === 'api.anthropic.com') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    url += '?limit=1000';
  }
  return { url, headers };
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Pulls model ids out of whatever list shape the endpoint returned: the OpenAI
 * `{ data: [{ id }] }`, `{ models: [{ name | id | model }] }` as Ollama and
 * Google report it, or a bare array. Sorted and de-duplicated so the numbered
 * list is stable between calls — `:model 3` must mean the same thing twice.
 */
export function parseModelIds(body: unknown): string[] | undefined {
  const obj = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
  const list = Array.isArray(body) ? body : obj ? (obj.data ?? obj.models) : undefined;
  if (!Array.isArray(list)) return undefined;

  const ids = new Set<string>();
  for (const item of list) {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? ((item as Record<string, unknown>).id ??
           (item as Record<string, unknown>).name ??
           (item as Record<string, unknown>).model)
        : undefined;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Asks one endpoint which models it offers.
 *
 * Failure is a value, not an exception, and every failure says what to do next —
 * this runs in the middle of a setup dialogue where "fetch failed" helps nobody.
 * Nothing in a failure message can carry the key: the response snippet goes
 * through `redactSecrets`, and the key is never part of the URL.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<ModelsResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { url, headers } = buildModelsRequest(baseUrl, apiKey);

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? `no answer within ${Math.round(timeoutMs / 1000)}s`
      : (err.cause?.code ?? err.cause?.message ?? err.message ?? 'connection failed');
    return {
      ok: false,
      kind: 'unreachable',
      message: `could not reach ${baseUrl} (${redactSecrets(String(why))}) — check the address and that the server is running`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      kind: 'auth',
      status: res.status,
      message: `${baseUrl} rejected the API key (HTTP ${res.status})`,
    };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return {
      ok: false,
      kind: 'not-found',
      status: res.status,
      message: `${baseUrl} has no model list at /models (HTTP ${res.status})`,
    };
  }
  if (!res.ok) {
    const snippet = redactSecrets((await safeText(res)).replace(/\s+/g, ' ').slice(0, 160));
    return {
      ok: false,
      kind: 'http',
      status: res.status,
      message: `${baseUrl} answered HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return {
      ok: false,
      kind: 'bad-response',
      message: `${baseUrl}/models did not return JSON — is this the API address rather than a web page?`,
    };
  }

  const models = parseModelIds(body);
  if (!models) {
    return {
      ok: false,
      kind: 'bad-response',
      message: `${baseUrl}/models returned something that is not a model list`,
    };
  }
  return { ok: true, models, baseUrl };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * `fetchModels`, plus the one correction people need constantly: an address with
 * no path (`http://localhost:11434`) almost always means the `/v1` root. If the
 * bare address has no model list, `/v1` is tried before giving up, and the
 * result carries whichever base URL actually worked.
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<ModelsResult> {
  const first = await fetchModels(baseUrl, apiKey, opts);
  if (first.ok) return first;

  const bare = (() => {
    try {
      return new URL(baseUrl).pathname.replace(/\/+$/, '') === '';
    } catch {
      return false;
    }
  })();
  if (bare && (first.kind === 'not-found' || first.kind === 'bad-response')) {
    const second = await fetchModels(`${baseUrl}/v1`, apiKey, opts);
    if (second.ok) return second;
  }
  return first;
}
