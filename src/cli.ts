#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — terminal client
// ─────────────────────────────────────────────────────────────────────────────
//
// The default screen shows only: conversation, active agent, active model,
// verification state, and how to reach help. Everything else is behind a `:`
// command. This is a read-eval-print shell over ./commands.ts and ./session.ts —
// it holds no logic of its own beyond wiring and prompting.

import * as readline from 'readline';
import { createSpinner } from './spinner.js';
import { createLineReader } from './line-reader.js';
import { OpOneSession } from './session.js';
import { createAuraCodeEngine, installConfirmHandler } from './engine.js';
import { runCommand, isCommand, formatTurn } from './commands.js';
import type { CommandIO } from './commands.js';
import { renderStatusLine, renderAssistant, HELP_TEXT } from './display.js';
import { PRODUCT_NAME } from './types.js';
import { conversationStore, providerStore } from './stores.js';
import { runSetup } from './setup.js';

export interface CliOptions {
  projectRoot?: string;
  /** Resume an existing conversation. */
  conversationId?: string;
  testCommand?: string;
  permissionLevel?: 'read-only' | 'normal' | 'auto';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(`${PRODUCT_NAME}\n\n${HELP_TEXT}\n\n${OPTIONS_TEXT}\n`);
    return 0;
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const engine = createAuraCodeEngine({
    permissionLevel: opts.permissionLevel ?? 'auto',
    testCommand: opts.testCommand,
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = createLineReader(rl);
  const spinner = createSpinner();
  installConfirmHandler(message => spinner.paused(async () => {
    const answer = await input.ask(`\n⚠️  ${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  }));

  const session = new OpOneSession({
    engine,
    projectRoot,
    conversationId: opts.conversationId,
    testCommand: opts.testCommand,
    // Consequential actions ask. A non-"y" answer is a no.
    confirm: (message: string) => spinner.paused(async () => {
      const answer = await input.ask(`\n${message}\n  [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    }),
  });

  process.stdout.write(`${PRODUCT_NAME} — :help for commands\n`);
  process.stdout.write(`ready in ${Date.now() - startedAt}ms\n\n`);

  // What the dialogue commands (:setup, :model, :agent new) need beyond a prompt.
  const io: CommandIO = {
    askSecret: q => input.askSecret(q),
    write: text => { process.stdout.write(text); },
  };

  try {
    // No provider yet: lead the person through connecting one. Only on a real
    // terminal — a piped session must not have its script eaten by a dialogue —
    // and only until they decline once. `--setup` runs it regardless.
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (opts.setup || (!providerStore.active() && !providerStore.welcomeSkipped())) {
      if (opts.setup || interactive) {
        const outcome = await runSetup(
          { ask: q => input.ask(q), askSecret: io.askSecret, write: io.write },
          { welcome: !opts.setup },
        );
        if (outcome.status === 'saved' && session.activeModelOverride()) {
          session.setModelOverride(undefined);
        }
        if (outcome.status === 'cancelled') {
          process.stdout.write(`setup cancelled: ${outcome.reason} — type :setup to try again\n`);
        }
        process.stdout.write('\n');
      } else {
        process.stdout.write('no provider set up yet — type :setup to connect one\n\n');
      }
    }

    for (;;) {
      const last = session.lastResult();
      const ranLocal = Boolean(last?.usedLocalModel) && !session.activeModelOverride();
      const status = renderStatusLine({
        agentName: session.activeAgent().name,
        provider: session.activeProvider()?.name,
        model: ranLocal
          ? last!.model
          : session.effectiveModel() ?? session.activeAgent().modelPolicy.kind,
        isLocal: ranLocal,
        verification: session.lastResult()?.verification.state ?? 'unverified',
        meshEnabled: session.meshEnabled(),
      });
      process.stdout.write(`${status}\n`);

      const line = (await input.ask('› ')).trim();
      if (input.ended && !line) return 0;
      if (!line) continue;

      if (isCommand(line)) {
        const result = await runCommand(session, line, q => input.ask(q), io);
        if (result.output) process.stdout.write(`${result.output}\n\n`);
        if (result.quit) return 0;
        continue;
      }

      const t0 = Date.now();
      spinner.start('thinking');
      let turn;
      try { turn = await session.handle(line); } finally { spinner.stop(); }
      const firstResponseMs = Date.now() - t0;

      process.stdout.write(`\n${renderAssistant(formatTurn(turn))}\n`);
      process.stdout.write(`  ${firstResponseMs}ms\n\n`);
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    input.close();
  }
}

interface ParsedArgs extends CliOptions {
  help?: boolean;
  /** Run the provider dialogue at startup, even when one is already set up. */
  setup?: boolean;
}

const OPTIONS_TEXT = `Options

  --setup           connect a provider (or another one) before starting
  --root <dir>      project root (default: the current directory)
  --resume <id>     continue an earlier conversation
  --test-command    command the verification gate runs
  --readonly        the agent may read but not change anything
  --auto            no confirmations except dangerous commands, which stay blocked (default)
  --ask             confirm risky actions (normal mode)`;

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--setup') out.setup = true;
    else if (a === '--root') out.projectRoot = argv[++i];
    else if (a === '--resume') out.conversationId = argv[++i];
    else if (a === '--test-command') out.testCommand = argv[++i];
    else if (a === '--readonly') out.permissionLevel = 'read-only';
    else if (a === '--auto') out.permissionLevel = 'auto';
    else if (a === '--ask') out.permissionLevel = 'normal';
  }
  return out;
}

/** Most recent conversation id, for `--resume` with no argument. */
export function latestConversationId(): string | undefined {
  return conversationStore.list()[0]?.id;
}

if (require.main === module) {
  main().then(code => process.exit(code));
}
