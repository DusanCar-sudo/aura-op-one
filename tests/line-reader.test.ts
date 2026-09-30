import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createLineReader } from '../src/line-reader.js';

/** Minimal stand-in for the readline interface the reader consumes. */
function fakeRl() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    close() { emitter.emit('close'); },
    setPrompt() {},
    prompt() {},
  }) as unknown as Parameters<typeof createLineReader>[0] & EventEmitter;
}

function sink() {
  const written: string[] = [];
  return {
    written,
    stream: { write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WritableStream,
  };
}

describe('line reader', () => {
  it('resolves a pending ask when the line arrives', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    const pending = reader.ask('› ');
    rl.emit('line', 'hello');
    expect(await pending).toBe('hello');
    expect(out.written).toContain('› ');
  });

  it('buffers lines that arrive before they are asked for — the piped-stdin case', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    // All lines arrive at once, as they do from a pipe.
    rl.emit('line', ':status');
    rl.emit('line', ':mesh');
    rl.emit('line', ':quit');

    expect(await reader.ask('› ')).toBe(':status');
    expect(await reader.ask('› ')).toBe(':mesh');
    expect(await reader.ask('› ')).toBe(':quit');
  });

  it('preserves order when buffered and pending reads interleave', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    rl.emit('line', 'first');
    const a = await reader.ask('› ');
    const pending = reader.ask('› ');
    rl.emit('line', 'second');

    expect(a).toBe('first');
    expect(await pending).toBe('second');
  });

  it('releases a waiting caller on close instead of hanging', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    const pending = reader.ask('› ');
    rl.emit('close');
    expect(await pending).toBe('');
    expect(reader.ended).toBe(true);
  });

  it('drains buffered lines before reporting ended', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    rl.emit('line', 'leftover');
    rl.emit('close');

    expect(reader.ended).toBe(false);
    expect(await reader.ask('› ')).toBe('leftover');
    expect(reader.ended).toBe(true);
    expect(await reader.ask('› ')).toBe('');
  });

  it('echoes buffered lines so a piped transcript reads like a session', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    rl.emit('line', ':status');
    await reader.ask('› ');

    expect(out.written.join('')).toBe('› :status\n');
  });
});

describe('line reader — secret input', () => {
  it('does not echo a buffered (piped) secret into the transcript', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    rl.emit('line', 'sk-super-secret-value');
    expect(await reader.askSecret('API key: ')).toBe('sk-super-secret-value');

    const transcript = out.written.join('');
    expect(transcript).toContain('API key: ********');
    expect(transcript).not.toContain('sk-super-secret-value');
  });

  it('resolves a pending secret prompt when the line arrives', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    const pending = reader.askSecret('API key: ');
    rl.emit('line', 'typed-secret-123');
    expect(await pending).toBe('typed-secret-123');
    expect(out.written.join('')).not.toContain('typed-secret-123');
  });

  it('returns empty once input has ended', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);
    rl.emit('close');
    expect(await reader.askSecret('API key: ')).toBe('');
  });

  it('mutes readline\'s echo while a secret is typed on a terminal, and restores it after', async () => {
    const rl = fakeRl() as unknown as EventEmitter & { _writeToOutput?: (s: string) => void };
    const echoed: string[] = [];
    const original = (s: string) => { echoed.push(s); };
    rl._writeToOutput = original;
    const out = sink();
    (out.stream as unknown as { isTTY: boolean }).isTTY = true;
    const reader = createLineReader(rl as unknown as Parameters<typeof createLineReader>[0], out.stream);

    const pending = reader.askSecret('API key: ');
    expect(rl._writeToOutput).not.toBe(original);
    rl._writeToOutput!('s'); // a keystroke being echoed — must go nowhere
    expect(echoed).toEqual([]);

    rl.emit('line', 'typed');
    expect(await pending).toBe('typed');
    expect(rl._writeToOutput).toBe(original); // echo is back for the next prompt
    expect(out.written.join('')).toContain('\n');
  });
});
