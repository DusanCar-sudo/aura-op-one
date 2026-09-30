// A tiny OpenAI-compatible server for tests: GET /v1/models and
// POST /v1/chat/completions, gated on one API key. Runs on 127.0.0.1 with an
// OS-assigned port, so the suite stays offline and needs no real key.

import * as http from 'http';
import type { AddressInfo } from 'net';

export const MOCK_KEY = 'sk-mock-test-key-0123456789';

export interface MockProvider {
  /** e.g. http://127.0.0.1:41234 — no path; tests add /v1 as a user would. */
  origin: string;
  /** Every request received, in order. */
  requests: Array<{ method: string; url: string; authorization?: string; body?: unknown; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export interface MockOptions {
  models?: string[];
  /** Serve the list only at /models (no /v1 prefix) — for the bare-host retry test. */
  modelsAt?: string;
  /** The key the server demands; `null` accepts any request, like a local Ollama. */
  key?: string | null;
  /** Replaces the /models handler's body. */
  modelsBody?: (url: string) => { status: number; body: string; type?: string };
}

export async function startMockProvider(opts: MockOptions = {}): Promise<MockProvider> {
  const key = opts.key === undefined ? MOCK_KEY : opts.key;
  const models = opts.models ?? ['mock-large', 'mock-small', 'mock-mini'];
  const modelsAt = opts.modelsAt ?? '/v1/models';
  const requests: MockProvider['requests'] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, authorization: req.headers.authorization, body, headers: req.headers });

      const send = (status: number, payload: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(payload);
      };

      if (key !== null && req.headers.authorization !== `Bearer ${key}`) return send(401, '{"error":{"message":"bad key"}}');

      if (req.method === 'GET' && url.split('?')[0] === modelsAt) {
        if (opts.modelsBody) {
          const custom = opts.modelsBody(url);
          return send(custom.status, custom.body, custom.type);
        }
        return send(200, JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }));
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const model = (body as { model?: string } | undefined)?.model ?? '?';
        const text = `mock reply from ${model}`;
        if ((body as { stream?: boolean } | undefined)?.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        return send(200, JSON.stringify({
          id: '1', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }));
      }

      send(404, 'not found', 'text/plain');
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/** A SetupIO that answers from a script and records everything written. */
export function scriptedIO(answers: string[]) {
  const out: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    out,
    asked,
    text: () => out.join(''),
    remaining: () => queue.length,
    io: {
      ask: async (q: string) => { asked.push(q); out.push(q); return queue.shift() ?? ''; },
      askSecret: async (q: string) => { asked.push(q); out.push(`${q}********\n`); return queue.shift() ?? ''; },
      write: (t: string) => { out.push(t); },
    },
  };
}
