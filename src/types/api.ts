import type { ActionType, ProblemContext, Complexity } from './models';

/** Gemini models exposed to the user (free-tier friendly). */
export type GeminiModel = 'gemini-3.5-flash-lite' | 'gemini-3.5-flash';

export interface LLMRequest {
  problemContext: ProblemContext;
  actionType: ActionType;
  systemPrompt: string;
  userMessage: string;
  apiKey: string;
  /** Which Gemini model to use. Defaults to flash-lite if omitted. */
  model?: GeminiModel;
  /** Per-response token cap. Defaults applied in the service if omitted. */
  maxTokens?: number;
  /** Hard request timeout in ms. Defaults applied in the service if omitted. */
  timeoutMs?: number;
  previousHintLevel?: number;
  userApproach?: string;
  /** A free-form user question. When set, it replaces the templated message. */
  userQuery?: string;
  /** The user's current editor code (for CHECK_APPROACH analysis). */
  userCode?: string;
  /** The editor language for the code above (e.g. "python", "cpp"). */
  codeLanguage?: string;
  /**
   * A deterministic digest of the session's structured activity, injected into
   * the GENERATE_REPORT message so the report reflects what the user actually
   * did (see session-digest.ts). Ignored by other actions.
   */
  sessionDigest?: string;
  /**
   * B10: the canonical pinned OPTIMAL complexity for this problem, injected as a
   * hard constraint so the model stops re-guessing (and drifting on) the optimal
   * between calls. Threaded into the templated action messages via
   * buildUserMessage. Ignored when omitted. See services/complexity-pin.ts.
   */
  pinnedOptimal?: Complexity;
  /**
   * Optional callback invoked once with token usage if the API surfaces it.
   * On the streaming path this fires when the final usage-only chunk arrives
   * (requires `stream_options.include_usage`); it may never fire if the
   * endpoint doesn't honor it — callers must treat usage as best-effort. Used
   * by the metrics instrumentation (see services/metrics-store.ts). Ignored if
   * omitted.
   */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  /**
   * B29: optional callback invoked once on the STREAMING path with the terminal
   * `finish_reason` when the stream ends, if the endpoint surfaces one. The
   * streaming loop otherwise only ever saw `delta.content`, so a token-cap
   * cutoff (`finish_reason: 'length'`, default maxTokens=800) was
   * indistinguishable from a clean `'stop'` finish and a truncated answer was
   * shown as complete. Callers use this to surface an honest "response was cut
   * off (token limit)" cue. Best-effort — may never fire if the endpoint omits
   * finish_reason; callers must treat a missing signal as a clean finish. This
   * mirrors the non-streaming paths, which already read finish_reason directly.
   * Ignored when omitted.
   */
  onFinish?: (reason: LLMResponse['finishReason']) => void;
  /**
   * Chat Enhancement (E9): optional override of the full OpenAI message array.
   * When set, the service sends these messages verbatim instead of building them
   * from problemContext/actionType — used by the agentic chat loop's streamed
   * FINAL answer, which carries the whole tool-augmented conversation. Ignored
   * when omitted (every existing call path is unaffected).
   */
  messages?: Array<Record<string, unknown>>;
  /**
   * E9: pins tool_choice on the streamed final answer to "none" so the terminal
   * call can't re-request tools (the loop is already bounded). Ignored when
   * omitted. Only meaningful alongside `messages`.
   */
  toolChoice?: 'none' | 'auto';
}

export interface LLMResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter';
  usage?: { promptTokens: number; completionTokens: number };
}

export interface APIConfig {
  /** Phase 1 uses Gemini exclusively (bring-your-own-key). */
  provider: 'gemini';
  apiKey: string;
  model: GeminiModel;
}

/**
 * Free-tier guardrails. Defaults are generous (well under Gemini's free
 * limits) but every value is user-adjustable. The kill switch is off by
 * default and, when on, blocks all API calls instantly.
 */
export interface GuardrailSettings {
  maxTokens: number;            // per-response token cap
  maxRequestsPerMinute: number; // local per-minute cap (stricter than Gemini)
  maxRequestsPerDay: number;    // local per-day cap
  cooldownMs: number;           // min gap between consecutive requests
  requestTimeoutMs: number;     // hard request timeout
  killSwitch: boolean;          // when true, block all requests
}

export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  maxTokens: 800,
  maxRequestsPerMinute: 8,
  maxRequestsPerDay: 200,
  cooldownMs: 2000,
  requestTimeoutMs: 20000,
  killSwitch: false,
};

export interface UserSettings {
  apiConfig: APIConfig;
  guardrails: GuardrailSettings;
  enableStuckTimer: boolean;
  stuckTimerDelay: number;
  enableChatMode: boolean;
  theme: 'light' | 'dark' | 'auto';
  /**
   * Data-use consent gate (E8 / CWS prominent-disclosure requirement).
   * The user must affirmatively acknowledge, in-UI, that LeetSmith sends the
   * current problem + their code to Google's Gemini API (via their own key)
   * before the key can be saved — and thus before any coaching can run.
   * Optional so settings persisted BEFORE this field existed read as
   * not-consented (undefined → the gate shows once). Never migrated.
   */
  consentAcknowledged?: boolean;
  /**
   * Version of the disclosure the user consented to. If this is lower than the
   * current CONSENT_VERSION (e.g. the data practices materially changed), the
   * gate re-prompts. Absent on pre-existing data → treated as not-consented.
   */
  consentVersion?: number;
}

/**
 * Current data-disclosure version. Bump this ONLY when the disclosed data
 * practices materially change (CWS "disclose post-install changes" rule) — a
 * stored consentVersion below this re-triggers the in-UI consent gate.
 */
export const CONSENT_VERSION = 1;

/**
 * Per-day usage tracking, persisted so it survives service-worker sleep.
 * recentTimestamps holds request times within the last minute for the
 * per-minute window; count is the running total for `date`.
 */
export interface UsageState {
  date: string;             // YYYY-MM-DD (local)
  count: number;            // requests made today
  recentTimestamps: number[]; // epoch ms of recent requests (last ~60s)
}

/**
 * A single captured AI request — the rolling-window sample for runtime metrics
 * (latency / tokens / est. cost). All local; never leaves the browser.
 */
export interface RequestMetricSample {
  ts: number;                 // epoch ms when recorded
  model: GeminiModel;
  latencyMs: number;          // wall-clock around the call
  promptTokens?: number;      // absent when usage unavailable (streaming w/o include_usage)
  completionTokens?: number;
  estCostUsd?: number;        // derived; absent when tokens absent
  tokensCaptured: boolean;    // explicit honesty flag: was token usage available?
}

/**
 * Persisted metrics state (one chrome.storage.local key). Bounded: `samples`
 * is a capped rolling window (for percentile math) and `lifetime` holds running
 * aggregates that survive window eviction (so totals stay truthful without
 * keeping unbounded history).
 */
export interface MetricsState {
  version: 1;
  samples: RequestMetricSample[];
  lifetime: {
    totalRequests: number;
    tokensCapturedRequests: number; // denominator for token/cost averages
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalEstCostUsd: number;
  };
}

/** Aggregated, display-ready metrics computed by the pure summarize() fn. */
export interface MetricsSummary {
  totalRequests: number;        // lifetime
  windowSize: number;           // samples currently in the rolling window
  p50LatencyMs: number | null;  // null when no samples
  p95LatencyMs: number | null;
  avgTokensPerRequest: number | null;   // null when no tokens ever captured
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  tokensCapturedRequests: number;
  avgEstCostUsd: number | null; // per captured request
  totalEstCostUsd: number;      // lifetime
}

/** Result of a guardrail pre-check before making a request. */
export interface GuardrailCheck {
  allowed: boolean;
  reason?: string;
  /** ms the caller should wait before retrying (for cooldown/rate limits). */
  retryAfterMs?: number;
}

export interface FilterResult {
  filteredContent: string;
  wasFiltered: boolean;
  filterReason?: string;
  /**
   * How the content was handled when a leak was detected (coaching-logic-overhaul
   * R6). Lets the App-level recovery helper decide whether to show the partial
   * result as-is or attempt one bounded regenerate. The eval gate ignores this —
   * it reads only `wasFiltered` — so the safety numbers are invariant to it.
   *   - 'none'    — nothing detected (clean passthrough), wasFiltered false.
   *   - 'partial' — leak(s) removed, meaningful teaching preserved, wasFiltered true.
   *   - 'full'    — nothing teachable survived; filteredContent is the reworded
   *                 message, wasFiltered true.
   */
  redactionMode?: 'none' | 'partial' | 'full';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
