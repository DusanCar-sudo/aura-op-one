// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — the aura-code boundary
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the ONLY seam between Aura OP One and aura-code. Everything else in
// src/op-one/ depends on the `Engine` interface below, never on aura-code
// internals — that is what keeps the client thin and what makes extraction into
// a standalone `aura-op-one` repository mechanical (architecture §3, §12).
//
// The production implementation (createAuraCodeEngine) is deliberately the only
// place that imports from ../agent/, ../verify/, ../archimedes/, ../safety/ and
// ../providers/. Tests substitute a fake engine.

import type { ProviderProfile, VerificationEvidence } from './types.js';
import { providerStore } from './stores.js';

// Static, unlike every other aura-code import in this file.
//
// Both are needed synchronously: `checkPermission` gates an action about to
// happen, and `snapshotFiles` must capture the pre-execution file set in the
// same tick as the decision to run. They are also the two cheapest modules on
// the boundary — permissions pulls in readline, checks pulls in fs/path — so
// loading them eagerly costs nothing worth deferring. Everything expensive
// (providers, the agent loop, the terminal display) stays dynamic below.
import { PermissionSystem, setConfirmHandler } from 'aura-code/dist/safety/permissions.js';

/**
 * aura-code's confirm() otherwise opens a second readline on stdin and closes it,
 * which pauses stdin and swallows the answer — approvals never went through.
 * Route its prompts through the client's own line reader instead.
 */
export function installConfirmHandler(ask: (message: string) => Promise<boolean>): void {
  setConfirmHandler(async (message: string) => ask(message));
}
import { collectProjectFiles } from 'aura-code/dist/verify/checks.js';

// ─────────────────────────────────────────────────────────────────────────────
// Requests and results
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineRunRequest {
  /** Absolute project root. */
  projectRoot: string;
  /** The task text handed to the agent loop. */
  task: string;
  /** Resolved model id. */
  model: string;
  /**
   * True when `model` is the local (Archimedes) model. The active provider profile
   * points at a remote endpoint, so a local run must bypass it and go to Ollama.
   */
  local?: boolean;
  /** Agent instruction, used as the system prompt override. */
  instruction?: string;
  /** Tool allow-list. Enforced by the loop in addition to permissions. */
  allowedTools?: string[];
  /** Turn cap. */
  maxTurns?: number;
  /** Cooperative cancellation. */
  abortSignal?: AbortSignal;
}

export interface EngineRunResult {
  success: boolean;
  summary: string;
  turns: number;
  /** Tool calls made, used as verification evidence. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  tokens: { input: number; output: number };
  /** Set when the run failed. */
  error?: string;
}

export interface EngineVerifyRequest {
  projectRoot: string;
  /** The original request, so the gate can check task intent. */
  task: string;
  /** Wall-clock start, so the gate can tell which files this run touched. */
  taskStartedAt: number;
  /** Evidence from execution. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /**
   * Project file set captured BEFORE execution. The gate needs the pre/post pair
   * to distinguish created from pre-existing files — see architecture §14.2.
   */
  filesBefore: Set<string>;
  /** Optional test command the gate should run. */
  testCommand?: string;
}

export interface EngineVerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  /** Verifier's reasoning, empty when it passed. */
  suggestion: string;
  /** What the gate actually looked at. */
  evidence: VerificationEvidence;
}

/** Permission outcome, mirroring aura-code's PermissionSystem. */
export interface PermissionOutcome {
  allowed: boolean;
  /** Present when the action needs the user to confirm. */
  needsConfirmation?: boolean;
  reason?: string;
}

/** A model policy resolved against live availability and competence. */
export interface ResolvedModel {
  model: string;
  /** True when this is the local (Archimedes) model. */
  isLocal: boolean;
  /** Why this model was chosen — surfaced by `:status`, never hidden. */
  reason: string;
  /** Set when the requested policy could not be honoured and a fallback fired. */
  fallback?: { from: string; to: string; reason: string };
}

export interface ResolveModelRequest {
  policy:
    | { kind: 'local-first' }
    | { kind: 'cloud-only' }
    | { kind: 'local-only' }
    | { kind: 'pinned'; model: string };
  /** Task text, used for competence lookup on `local-first`. */
  task: string;
  projectRoot: string;
  /** Session-level override from `:model`, which wins over the agent policy. */
  override?: string;
}

/** One seat at a council. */
export interface CouncilSeat {
  role: string;
  /** The seat's answer. */
  answer: string;
}

export interface EngineCouncilRequest {
  projectRoot: string;
  /** One defined question. Councils do not free-associate. */
  question: string;
  /** Explicitly selected roles — one seat each, no unbounded spawning. */
  roles: string[];
  model: string;
}

export interface EngineCouncilResult {
  seats: CouncilSeat[];
  /** Seats that failed to answer. Synthesis proceeds without them. */
  failures: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything Aura OP One needs from aura-code. Five capabilities, no more:
 * execute, verify, record, permission-check, resolve a model — plus council
 * panel execution, which is aura-code's `runCouncil`.
 */
export interface Engine {
  run(req: EngineRunRequest): Promise<EngineRunResult>;
  verify(req: EngineVerifyRequest): Promise<EngineVerifyResult>;
  /** Record the engineering episode in aura-code's own store. */
  recordEpisode(projectRoot: string, episode: EngineEpisodeInput): Promise<void>;
  /** Permission check. Councils and mesh agents use this same path. */
  checkPermission(tool: string, input: Record<string, unknown>): PermissionOutcome;
  resolveModel(req: ResolveModelRequest): Promise<ResolvedModel>;
  /** Run council seats. Synthesis and verification stay in OP One. */
  runCouncilSeats(req: EngineCouncilRequest): Promise<EngineCouncilResult>;
  /** Snapshot the project's file set, for the verifier's pre/post pair. */
  snapshotFiles(projectRoot: string): Set<string>;
}

/** What aura-code's Archimedes-shaped episode store needs. */
export interface EngineEpisodeInput {
  id: string;
  task: string;
  usedLocalModel: boolean;
  localOutput?: string;
  largeModelUsed?: string;
  largeModelOutput?: string;
  verifierApproved: boolean;
  tokens: { local?: number; large?: number };
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production implementation — the only aura-code-aware code in the client
// ─────────────────────────────────────────────────────────────────────────────

export interface AuraCodeEngineOptions {
  /** Permission level, passed to aura-code's PermissionSystem. */
  permissionLevel?: 'read-only' | 'normal' | 'auto';
  /** Test command the verification gate should run. */
  testCommand?: string;
  /** Cloud model used when a policy resolves to cloud. */
  cloudModel?: string;
  /** Local model tag; defaults to aura-code's Archimedes default. */
  localModel?: string;
  /**
   * The provider profile to use. Read on every call — never cached — so a
   * `:provider` or `:model` change takes effect on the very next turn. Defaults
   * to the saved active profile; tests inject their own.
   */
  activeProvider?: () => ProviderProfile | undefined;
}

/**
 * Model names the client itself passes when it has no opinion — the mesh
 * fallback and `:council`. With a profile active they mean "the profile's model".
 */
const PLACEHOLDER_MODELS = new Set(['default', 'fallback']);

/** Endpoints that need no key still need a non-empty one for the OpenAI SDK. */
const KEYLESS_PLACEHOLDER = 'none';

/**
 * Wires the `Engine` interface onto aura-code. Imports are dynamic so that the
 * client's stores, verification lifecycle and command layer stay testable
 * without loading providers, tools or the terminal display.
 */
export function createAuraCodeEngine(opts: AuraCodeEngineOptions = {}): Engine {
  const permissionLevel = opts.permissionLevel ?? 'normal';

  // Ready before the first check, so there is no window in which an early
  // permission check fails closed and spuriously denies legitimate work.
  const permissions = new PermissionSystem(permissionLevel);

  const activeProvider = opts.activeProvider ?? (() => providerStore.active());

  return {
    async run(req: EngineRunRequest): Promise<EngineRunResult> {
      const { runAgentLoop } = await import('aura-code/dist/agent/loop.js');
      const { loadProjectContext } = await import('aura-code/dist/agent/context.js');
      const { createProvider } = await import('aura-code/dist/providers/factory.js');
      const { PermissionSystem } = await import('aura-code/dist/safety/permissions.js');
      const { createSilentDisplay } = await import('./display.js');

      const context = await loadProjectContext(req.projectRoot);

      // With a profile active, the base URL, key and model the person chose are
      // used as given — createProvider's routing by model-name prefix would send
      // `claude-*` to Anthropic's own SDK and demand an env var instead. The one
      // exception is the local model, which must reach Ollama, not the profile.
      const profile = req.local ? undefined : activeProvider();
      let provider;
      try {
        if (profile) {
          const { OpenAICompatibleProvider } = await import('aura-code/dist/providers/openai-compatible.js');
          const model = PLACEHOLDER_MODELS.has(req.model) ? profile.model : req.model;
          provider = new OpenAICompatibleProvider(
            { model, baseUrl: profile.baseUrl, apiKey: profile.apiKey || KEYLESS_PLACEHOLDER },
            profile.name,
          );
        } else {
          provider = createProvider({ model: req.model });
        }
      } catch (e) {
        return {
          success: false,
          summary: '',
          turns: 0,
          toolCalls: [],
          tokens: { input: 0, output: 0 },
          error: e instanceof Error ? e.message : String(e),
        };
      }

      try {
        const result = await runAgentLoop({
          provider,
          task: req.task,
          context,
          permissions: new PermissionSystem(permissionLevel),
          // ./display.ts types this structurally so the client's testable layers
          // never pull in the CLI tree; the cast is confined to this file, which
          // is the only aura-code-aware one by design.
          display: createSilentDisplay() as unknown as import('aura-code/dist/cli/display.js').Display,
          maxTurns: req.maxTurns ?? 12,
          systemPromptOverride: req.instruction,
          allowedTools: req.allowedTools,
          abortSignal: req.abortSignal,
          verify: false,
          disableSpawn: true,
        });

        return {
          success: result.success,
          summary: result.summary,
          turns: result.turns,
          toolCalls: result.toolCallLog,
          tokens: {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
          },
        };
      } catch (e) {
        return {
          success: false,
          summary: '',
          turns: 0,
          toolCalls: [],
          tokens: { input: 0, output: 0 },
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },

    async verify(req: EngineVerifyRequest): Promise<EngineVerifyResult> {
      const { verifyTask } = await import('aura-code/dist/verify/index.js');
      const testCommand = req.testCommand ?? opts.testCommand;

      const result = await verifyTask(
        {
          projectRoot: req.projectRoot,
          taskStartedAt: req.taskStartedAt,
          task: req.task,
          toolCalls: req.toolCalls,
          filesBefore: req.filesBefore,
          testCommand,
        },
        { enabled: true, maxRetries: 1, testCommand },
      );

      return {
        passed: result.passed,
        checks: result.checks,
        suggestion: result.suggestion,
        evidence: extractEvidence(req.toolCalls, testCommand),
      };
    },

    async recordEpisode(projectRoot: string, episode: EngineEpisodeInput): Promise<void> {
      const { saveEpisode } = await import('aura-code/dist/archimedes/episode-capture.js');
      await saveEpisode(projectRoot, {
        id: episode.id,
        timestamp: Date.now(),
        task: episode.task,
        projectRoot,
        archimedesAttempted: episode.usedLocalModel,
        archimedesSucceeded: episode.usedLocalModel && episode.verifierApproved,
        archimedesOutput: episode.localOutput,
        largeModelUsed: episode.largeModelUsed,
        largeModelOutput: episode.largeModelOutput,
        reviewerApproved: episode.verifierApproved,
        tokensUsed: { archimedes: episode.tokens.local, largeModel: episode.tokens.large },
        durationMs: episode.durationMs,
        taskCategory: categorize(episode.task),
      });
    },

    checkPermission(tool: string, input: Record<string, unknown>): PermissionOutcome {
      const r = permissions.check(tool, input);
      // aura-code names this `needsConfirm`; the client's vocabulary is
      // `needsConfirmation`. Translating at the seam is the point of the seam.
      return { allowed: r.allowed, needsConfirmation: r.needsConfirm, reason: r.reason };
    },

    async resolveModel(req: ResolveModelRequest): Promise<ResolvedModel> {
      // The profile's model is "the cloud model" once a provider is set up; the
      // env var and hard-coded default only serve installs that never ran setup.
      const profile = activeProvider();
      const cloud = opts.cloudModel ?? profile?.model ?? process.env.AURA_MODEL ?? 'claude-sonnet-4-5';

      // A session-level `:model` override wins over the agent's policy.
      if (req.override) {
        return { model: req.override, isLocal: false, reason: 'session override (:model)' };
      }

      if (req.policy.kind === 'pinned') {
        return { model: req.policy.model, isLocal: false, reason: 'pinned by agent policy' };
      }
      if (req.policy.kind === 'cloud-only') {
        return { model: cloud, isLocal: false, reason: 'agent policy: cloud-only' };
      }

      const { DEFAULT_ARCHIMEDES_CONFIG } = await import('aura-code/dist/archimedes/types.js');
      const local = opts.localModel ?? DEFAULT_ARCHIMEDES_CONFIG.modelName;
      const localUp = await localModelReachable(DEFAULT_ARCHIMEDES_CONFIG.ollamaBaseUrl);

      if (req.policy.kind === 'local-only') {
        // Fails closed: local-only never silently spends cloud tokens.
        return {
          model: local,
          isLocal: true,
          reason: localUp
            ? 'agent policy: local-only'
            : 'agent policy: local-only — local model unreachable, not falling back',
        };
      }

      // local-first: competence decides, and an unreachable local model falls back.
      if (!localUp) {
        return {
          model: cloud,
          isLocal: false,
          reason: 'local model unreachable',
          fallback: { from: local, to: cloud, reason: 'local model unreachable' },
        };
      }

      const { assessCompetence } = await import('aura-code/dist/archimedes/competence.js');
      const { loadEpisodes } = await import('aura-code/dist/archimedes/episode-capture.js');
      try {
        const episodes = await loadEpisodes(req.projectRoot);
        const decision = assessCompetence(episodes, req.task, {
          ...DEFAULT_ARCHIMEDES_CONFIG,
          modelName: local,
        });
        if (decision.useArchimedes) {
          return { model: local, isLocal: true, reason: `competence: ${decision.reason}` };
        }
        return { model: cloud, isLocal: false, reason: `escalated: ${decision.reason}` };
      } catch {
        return {
          model: cloud,
          isLocal: false,
          reason: 'competence lookup failed',
          fallback: { from: local, to: cloud, reason: 'competence lookup failed' },
        };
      }
    },

    async runCouncilSeats(req: EngineCouncilRequest): Promise<EngineCouncilResult> {
      const seats: CouncilSeat[] = [];
      let failures = 0;

      // Sequential and bounded by the explicitly selected roles — one seat each.
      for (const role of req.roles) {
        const res = await this.run({
          projectRoot: req.projectRoot,
          task: `You are the ${role} seat of a council answering exactly one question.\n\n` +
            `Question: ${req.question}\n\n` +
            `Answer from the ${role} perspective only. Be concise and concrete. ` +
            `State your position and your reasoning. Do not speculate about what ` +
            `other seats might say.`,
          model: req.model,
          maxTurns: 6,
        });

        const answer = (res.summary ?? '').trim();
        if (!res.success || !answer) {
          failures++;
          continue;
        }
        seats.push({ role, answer });
      }

      return { seats, failures };
    },

    snapshotFiles(projectRoot: string): Set<string> {
      // Synchronous by necessity: the snapshot must be taken before execution
      // starts, in the same tick as the decision to run.
      //
      // A missing or unreadable root yields an empty set rather than throwing —
      // the gate then simply treats every file as new, which is conservative.
      // Note this is the ONLY reason this returns empty; a failure to load the
      // collector would be a wiring bug and must not be swallowed here.
      return collectProjectFiles(projectRoot);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pulls structured evidence out of the tool-call log. aura-code's `Check` has no
 * machine-readable evidence field (architecture §14.3), so this is derived here
 * rather than parsed out of check prose.
 */
export function extractEvidence(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
  testCommand?: string,
): VerificationEvidence {
  const filesChanged: string[] = [];
  const testsExecuted: string[] = [];

  for (const call of toolCalls) {
    if (call.name === 'write_file' || call.name === 'edit_file') {
      const p = String(call.input.path ?? '');
      if (p && !filesChanged.includes(p)) filesChanged.push(p);
    }
    if (call.name === 'run_shell') {
      const cmd = String(call.input.command ?? '');
      if (looksLikeTestCommand(cmd, testCommand)) testsExecuted.push(cmd);
    }
    if (call.name === 'run_tests') {
      const cmd = String(call.input.command ?? 'run_tests');
      testsExecuted.push(cmd);
    }
  }

  return { toolCalls, filesChanged, testsExecuted };
}

function looksLikeTestCommand(cmd: string, testCommand?: string): boolean {
  if (testCommand && cmd.includes(testCommand)) return true;
  return /\b(npm (run )?test|vitest|jest|pytest|go test|cargo test|node --test)\b/.test(cmd);
}

function categorize(task: string): 'research' | 'implementation' | 'review' | 'refactor' | 'other' {
  const t = task.toLowerCase();
  if (/\b(review|audit|lint|check)\b/.test(t)) return 'review';
  if (/\b(research|explore|find|investigate|understand)\b/.test(t)) return 'research';
  if (/\b(refactor|restructure|rename|migrate)\b/.test(t)) return 'refactor';
  if (/\b(implement|fix|add|write|create|build|update)\b/.test(t)) return 'implementation';
  return 'other';
}

async function localModelReachable(baseUrl: string): Promise<boolean> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${root}/api/tags`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
