// Aura OP One — busy indicator
//
// Shows the person the bot is alive while a turn runs. Only animates on a real
// terminal; piped sessions get nothing, so transcripts stay clean.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  start(label?: string): void;
  stop(): void;
  /** Runs `fn` with the spinner cleared, e.g. around a y/N prompt. */
  paused<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSpinner(out: NodeJS.WriteStream = process.stdout): Spinner {
  const enabled = Boolean(out.isTTY);
  let timer: NodeJS.Timeout | undefined;
  let label = 'working';
  let t0 = 0;
  let i = 0;

  const clear = () => out.write('\r\x1b[2K');
  const draw = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    out.write(`\r\x1b[2K\x1b[2m${FRAMES[i++ % FRAMES.length]} ${label}… ${s}s\x1b[0m`);
  };

  const spinner: Spinner = {
    start(l = 'working') {
      if (!enabled || timer) return;
      label = l;
      t0 = Date.now();
      i = 0;
      draw();
      timer = setInterval(draw, 100);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      clear();
    },
    async paused<T>(fn: () => Promise<T>): Promise<T> {
      const was = Boolean(timer);
      const resumeLabel = label;
      const started = t0;
      spinner.stop();
      try {
        return await fn();
      } finally {
        if (was) {
          spinner.start(resumeLabel);
          t0 = started;
        }
      }
    },
  };
  return spinner;
}
