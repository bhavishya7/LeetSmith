import type { LLMRequest, LLMResponse, GeminiModel } from '../types';
import { getSystemPrompt, getChatSystemPrompt, buildUserMessage, formatProblemContext, wrapUntrusted, REGENERATE_NO_SOLUTION } from './prompts';

// Google Gemini via its OpenAI-compatible endpoint. This lets us keep the
// standard chat-completions request/response shape while using a free-tier
// provider (no billing required; over-limit requests are rejected, not billed).
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Minimal shape of the OpenAI-compatible chat-completions JSON we read. All
// fields optional — it's an untrusted external boundary, so every access is
// guarded with `?.` and a fallback.
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string; tool_calls?: RawToolCall[] };
    finish_reason?: LLMResponse['finishReason'];
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// --- Tool/function calling (E9, design §0/§7.1) ----------------------------
// The Gemini OpenAI-compatible endpoint supports function calling with the
// standard OpenAI shape (tools[] + tool_choice). We use it ONLY on the
// non-streaming tool-call rounds; the final answer streams via streamLLMRequest.

/** Raw tool_call as it arrives on the (untrusted) response — guarded parsing. */
interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** A normalized tool call the agent loop consumes. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments ({} when absent/malformed — our tools take none). */
  arguments: Record<string, unknown>;
}

/** One assistant turn from a non-streaming round: content + any tool calls. */
export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

/** OpenAI function-tool spec (as produced by chat-tools.toolSpecs()). */
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ToolRoundRequest {
  apiKey: string;
  model?: GeminiModel;
  maxTokens?: number;
  timeoutMs?: number;
  /** Full OpenAI-style message array (system + user + prior tool turns). */
  messages: Array<Record<string, unknown>>;
  /** The read-only tool allowlist offered this round. */
  tools: ToolSpec[];
}

/** Shape of the JSON error body Gemini returns on a failed request. */
interface APIErrorBody {
  error?: { message?: string };
}

/**
 * A user-facing API error carrying a `retryable` hint so the retry logic has a
 * reliable signal (vs. brittle message string-matching). `retryable` is true for
 * transient server-side conditions (5xx) and false for client errors the user
 * must fix (bad key, quota).
 */
export class APIError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.retryable = retryable;
  }
}

const DEFAULT_MODEL: GeminiModel = 'gemini-3.5-flash-lite';
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 20000;
// Retries for the streaming request on a TRANSIENT 5xx (e.g. a 503 "model
// overloaded"). Kept small: with exponential backoff (1s, 2s) two retries add
// at most ~3s before giving up with the friendly message, so a brief Google-side
// blip is absorbed without making a real outage feel frozen.
const STREAM_MAX_RETRIES = 2;

/**
 * Builds the UNTRUSTED data payload for a free-form chat question (B4): the
 * problem context, plus the user's current editor code when present. Both are
 * scraped/editor content, so they ride INSIDE the wrapUntrusted DATA block; the
 * user's actual question stays outside it as the instruction. Sending the code
 * lets chat answer "what is my code's complexity?" instead of claiming it can't
 * see any code. See .kiro/specs/leetsage-guardrail-hardening (B4).
 */
export function buildChatData(request: LLMRequest): string {
  const ctx = formatProblemContext(request.problemContext);
  const code = request.userCode?.trim();
  if (!code) return ctx;
  const lang = request.codeLanguage ?? 'unknown';
  return `${ctx}\n\nMy current editor code (language: ${lang}) — may be incomplete or untested:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
}

function buildMessages(request: LLMRequest) {
  // Free-form chat uses its OWN direct-answer prompt (B2), not the templated
  // action prompt. Reusing EXPLAIN_CONCEPT here forced an analogy onto every
  // question; the chat prompt answers directly while keeping the same guardrail
  // + output rules. See .kiro/specs/leetsage-guardrail-hardening.
  const systemPrompt = request.userQuery ? getChatSystemPrompt() : getSystemPrompt(request.actionType);
  // Free-form questions replace the templated message but stay grounded by
  // prepending the problem context so the coach knows what we're working on.
  // The problem context is UNTRUSTED (scraped page content), so it rides inside
  // the same injection-hardening wrapper as the templated actions; the user's
  // own question stays outside the block as the instruction. (See
  // .kiro/specs/leetsage-prompt-injection.)
  const userMessage = request.userQuery
    ? wrapUntrusted(buildChatData(request), `My question: ${request.userQuery}`)
    : buildUserMessage(request.actionType, request.problemContext, {
        hintLevel: request.previousHintLevel,
        userApproach: request.userApproach,
        userCode: request.userCode,
        codeLanguage: request.codeLanguage,
        sessionDigest: request.sessionDigest,
        pinnedOptimal: request.pinnedOptimal,
      });
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
}

export async function sendLLMRequest(request: LLMRequest): Promise<LLMResponse> {
  const model = request.model ?? DEFAULT_MODEL;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    messages: buildMessages(request),
    max_tokens: maxTokens,
    temperature: 0.7,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithRetry(`${GEMINI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.apiKey}` },
      body, signal: controller.signal,
    }, 2);
    const data = await response.json() as ChatCompletionResponse;
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
    };
  } finally { clearTimeout(timeoutId); }
}

/**
 * BOUNDED REGENERATE (coaching-logic-overhaul R6.8). The single retry used by
 * the App recovery helper when a first answer leaked so badly that redaction
 * left nothing teachable (`redactionMode: 'full'`). It re-issues the SAME
 * request (same action/chat prompt, same untrusted data block) with
 * `REGENERATE_NO_SOLUTION` appended to the system prompt, telling the model its
 * prior answer over-shared and to teach at a coaching level this time.
 *
 * NON-streaming on purpose: the B1 pre-display gate withholds non-exempt output
 * until after the output filter runs anyway, so there is no streaming UX to
 * preserve here — we just need the final text to re-filter. The caller
 * (App.tsx) is responsible for recording it against the usage cap and
 * re-running `filterResponse` on the result (never trusted blindly — it may
 * still leak, in which case the caller shows the reworded full message).
 */
export async function regenerateWithoutSolution(request: LLMRequest): Promise<LLMResponse> {
  const model = request.model ?? DEFAULT_MODEL;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Reuse the normal message assembly, then reinforce the system message so the
  // ONE retry is steered away from the full-solution drift that got filtered.
  const messages = buildMessages(request).map((m) =>
    m.role === 'system' ? { ...m, content: `${m.content}\n${REGENERATE_NO_SOLUTION}` } : m,
  );

  const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithRetry(`${GEMINI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.apiKey}` },
      body, signal: controller.signal,
    }, 2);
    const data = await response.json() as ChatCompletionResponse;
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
    };
  } catch (err) {
    throw humanizeTransportError(err, timeoutMs);
  } finally { clearTimeout(timeoutId); }
}

/**
 * One NON-STREAMING tool-call round (E9, design §2/§7.1). Sends the full message
 * array with the read-only tool allowlist and `tool_choice:"auto"`, and returns
 * the assistant turn: its content plus any tool calls it requested. The agent
 * loop (chat-agent.ts) runs the requested tools locally (zero-API), appends the
 * fenced results, and calls this again — bounded by MAX_TOOL_ROUNDS.
 *
 * Non-streaming because the OpenAI-compatible endpoint returns tool_calls on the
 * plain completion; parsing tool-call deltas off a stream is deferred (v1.1).
 * Guarded throughout — the response is an untrusted external boundary.
 */
export async function sendToolRound(request: ToolRoundRequest): Promise<AssistantTurn> {
  const model = request.model ?? DEFAULT_MODEL;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: 'auto',
    max_tokens: maxTokens,
    temperature: 0.7,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithRetry(`${GEMINI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.apiKey}` },
      body, signal: controller.signal,
    }, 2);
    const data = await response.json() as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content ?? '',
      toolCalls: parseToolCalls(message?.tool_calls),
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  } catch (err) {
    // Same friendly-error boundary as the streaming path: a timeout/abort or a
    // network blip on the agent's tool round must not surface as a raw
    // DOMException ("signal is aborted without reason") or a bare TypeError.
    throw humanizeTransportError(err, timeoutMs);
  } finally { clearTimeout(timeoutId); }
}

/** Normalize raw tool_calls off the untrusted response into ToolCall[]. */
function parseToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const c of raw) {
    const name = c?.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = c?.function?.arguments;
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch { /* malformed args → empty object; our tools take no args anyway */ }
    }
    calls.push({ id: c.id ?? `call_${calls.length}`, name, arguments: args });
  }
  return calls;
}

export async function* streamLLMRequest(request: LLMRequest): AsyncGenerator<string> {
  const model = request.model ?? DEFAULT_MODEL;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.apiKey}` },
      body: JSON.stringify({
        model,
        // E9: the agent loop passes the full tool-augmented message array for the
        // streamed final answer; everyone else builds messages the usual way.
        messages: request.messages ?? buildMessages(request),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: true,
        // Ask the OpenAI-compatible endpoint to emit a final usage-only chunk
        // (empty `choices`, populated `usage`) right before [DONE]. This is how
        // we get token counts on the streaming path for the metrics
        // instrumentation. Best-effort: if the endpoint ignores it, onUsage
        // simply never fires and metrics record the request as tokens-absent.
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    };
    // Use fetchWithRetry so a TRANSIENT 5xx (e.g. the common free-tier 503
    // "model overloaded") is absorbed by the exponential backoff instead of
    // failing the whole coaching request on the first blip. fetchWithRetry
    // consumes only the error body on failure; the success Response's streaming
    // body is still untouched and read below. Non-retryable errors (bad key,
    // quota) throw immediately with their friendly message.
    const response = await fetchWithRetry(`${GEMINI_BASE_URL}/chat/completions`, init, STREAM_MAX_RETRIES);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    // B29: remember the terminal finish_reason so a token-cap cutoff
    // (`'length'`) can surface an honest "cut off" signal instead of looking
    // like a clean finish. Mirrors what the non-streaming paths already read.
    let finishReason: LLMResponse['finishReason'] | undefined;

    // B28: buffered SSE reader. The network delivers bytes on ARBITRARY
    // boundaries, so a `data: {json}` SSE line is frequently split across two
    // reads. The old loop decoded+split FRESH each read with no buffer, so a
    // split line failed JSON.parse and was silently dropped by the catch —
    // permanently losing that content while the loop returned normally (a
    // truncated card, no error). We now keep a `buffer` string across reads,
    // process only COMPLETE lines, and RETAIN the trailing partial line for the
    // next read; `{ stream: true }` also fixes a multi-byte UTF-8 char split
    // across reads. `handleLine` is the SINGLE per-line code path shared by the
    // loop and the final flush so they can't diverge; it returns true when a
    // `[DONE]` sentinel is seen so the caller can stop.
    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (line: string): { done: boolean; chunk?: string } => {
      if (!line.startsWith('data: ')) return { done: false };
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { done: true };
      try {
        const parsed = JSON.parse(data);
        // B29: capture a terminal finish_reason when present (the final content
        // frame carries it; the usage-only frame does not). Last non-null wins.
        const fr = parsed.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        // The usage-only chunk carries no content; surface it once via the
        // optional callback. Guarded (untrusted external boundary).
        const u = parsed.usage;
        if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
          request.onUsage?.({ promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens });
        }
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) return { done: false, chunk };
      } catch { /* genuinely malformed frame — now a true last resort, not a split line */ }
      return { done: false };
    };

    let sawDone = false;
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // RETAIN the trailing partial line (may be an incomplete `data: {…}`).
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const r = handleLine(line);
        if (r.chunk) yield r.chunk;
        if (r.done) { sawDone = true; break; }
      }
    }

    // FLUSH: the stream ended (or [DONE] arrived). decoder.decode() with no args
    // flushes any pending multi-byte char; then process whatever COMPLETE line
    // remains in the buffer so its content (or a trailing [DONE]/finish_reason)
    // isn't lost — closing B28's dropped-final-chunk case.
    if (!sawDone) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const r = handleLine(buffer);
        if (r.chunk) yield r.chunk;
      }
    }

    // B29: if the stream ended because the model hit the token cap, tell the
    // caller so it can show an honest "response was cut off" cue instead of
    // presenting a truncated answer as complete. A clean 'stop' (or no signal)
    // does NOT fire this.
    if (finishReason === 'length') request.onFinish?.('length');
    else if (finishReason) request.onFinish?.(finishReason);
  } catch (err) {
    // Normalize low-level failures into friendly, user-facing messages. An
    // APIError (from buildAPIError) is already friendly — rethrow as-is. An
    // abort (our timeout firing, or the user navigating) surfaces as a raw
    // DOMException "signal is aborted without reason", which must NOT reach the
    // UI; map it to a plain timeout message. A bare TypeError from fetch is a
    // network/connectivity failure.
    throw humanizeTransportError(err, timeoutMs);
  } finally { clearTimeout(timeoutId); }
}

/**
 * Maps a low-level fetch/abort failure to a friendly Error for the chat UI.
 * APIError instances are already user-facing and pass through unchanged.
 * Exported for unit testing the mapping (the abort case is the "signal is
 * aborted without reason" leak this fixes).
 */
export function humanizeTransportError(err: unknown, timeoutMs: number): Error {
  if (err instanceof APIError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(`The request took longer than ${Math.round(timeoutMs / 1000)}s and timed out. Google's service may be slow right now — please try again.`);
  }
  // fetch() rejects with a TypeError on network/DNS/offline failures.
  if (err instanceof TypeError) {
    return new Error("Couldn't reach Google's Gemini service. Check your internet connection and try again.");
  }
  if (err instanceof Error) return err;
  return new Error('Something went wrong. Please try again.');
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries: number): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw await buildAPIError(response);
      return response;
    } catch (error) {
      lastError = error as Error;
      // Stop immediately on a user-aborted request or a NON-retryable API error
      // (bad key, quota, other 4xx) — retrying those is pointless. Transient 5xx
      // (APIError.retryable === true) and network blips fall through to the
      // exponential backoff below. The retryable flag replaces the old brittle
      // message string-match.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof APIError && !error.retryable) throw error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastError ?? new Error('Request failed');
}

/**
 * Turns a non-OK Gemini response into a USER-FACING, friendly error. The chat
 * UI shows `error.message` directly, so these strings are written for a learner,
 * not a developer — apologetic and actionable, never a raw status code.
 *
 * Status reference (Gemini / OpenAI-compatible endpoint):
 *  - 401/403: bad or unauthorized key (user action: fix the key).
 *  - 429:     rate limit / free-tier quota (user action: wait).
 *  - 500/502/503/504: Google's service is overloaded or briefly down — a
 *    TRANSIENT, server-side condition the user can't fix except by retrying.
 *    503 ("Service Unavailable") is the common free-tier "model overloaded" one.
 */
async function buildAPIError(response: Response): Promise<APIError> {
  // Keep the raw provider detail for logs, but never surface it verbatim.
  let detail = `HTTP ${response.status}`;
  try { const body = await response.json() as APIErrorBody; detail = body?.error?.message ?? detail; } catch { /* ignore */ }

  const status = response.status;
  if (status === 401 || status === 403) {
    return new APIError('Your Gemini API key looks invalid or unauthorized. Double-check it in Settings ⚙️ and try again.', status, false);
  }
  if (status === 429) {
    return new APIError("You've hit the Gemini free-tier limit for now. Give it a minute, then try again.", status, false);
  }
  if (status >= 500) {
    // 500/502/503/504 — overloaded / temporarily down on Google's side.
    // Transient and server-side, so this is RETRYABLE.
    return new APIError("Sorry — Google's Gemini service is busy right now and couldn't respond. This is temporary; please try again in a moment.", status, true);
  }
  // Any other 4xx we didn't special-case: stay friendly, drop the status code.
  // Not retryable (a client-side problem the retry won't fix).
  return new APIError(`Sorry, something went wrong talking to Gemini (${detail}). Please try again.`, status, false);
}
