# Streaming Truncation Fix (B28 + B29) — Design

> **Design-only spec (documented deviation).** Per `.kiro/steering/workflow.md`
> → "Spec discipline": this is a **small, well-understood bug fix** in a single
> function, so it is design-only — requirements/tasks are folded in here. The two
> bugs were already **root-caused** (via a code trace during the
> `leetsage-progress-insights-overhaul` session) and logged in the bug registry
> (`leetsage-guardrail-hardening/requirements.md`, rows **B28** and **B29**); this
> doc is the fix plan + test strategy so a build session can implement cleanly.
>
> **Status:** 📐 Designed, NOT built. **Date:** 2026-11-01 (bugs observed) /
> captured as a spec 2026-11-XX.
> **Branch to use:** `fix/streaming-truncation` off `main`.
> **Scope:** both bugs live in ONE function — `streamLLMRequest` in
> `src/services/llm-service.ts` — so one branch, one fix, two test cases.

---

## 1. Symptom (what the user sees)

A coaching card finalizes **mid-sentence with content missing** — e.g. the answer
ends "…popping them off the moment" and then nothing — with **no error shown**. The
card looks complete but isn't. Observed repeatedly 2026-11-01 across several
problems, most on `UNDERSTAND_SOLUTION` and `CHECK_APPROACH`. Intermittent (depends
on network timing), which is the tell that it's a streaming/boundary issue, not a
model issue

**There are TWO independent root causes producing the same symptom**, plus a third
lower-confidence contributor. They are separable; fix B28 and B29, consider the
third only if the symptom persists.

---

## 2. Bug B28 — no cross-read SSE line buffer (PRIMARY, a real correctness defect)

### Root cause (verified in `streamLLMRequest`, `llm-service.ts`)

The SSE read loop decodes and splits **fresh on every `reader.read()`**:

```js
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const lines = decoder.decode(value).split('\n');   // ← fresh every read, no buffer
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed.choices?.[0]?.delta?.content;
      if (chunk) yield chunk;
      ...
    } catch { /* skip malformed chunk */ }            // ← silently drops a split line
  }
}
```

The network delivers bytes on **arbitrary boundaries**, so a `data: {json}` SSE line
is frequently split across two reads. The result:
1. First read ends with a partial `data: {"choices"...` → `JSON.parse` throws →
   **silently swallowed by the empty `catch`** → that content is **permanently
   dropped**.
2. Next read starts with the tail `...}` → also unparseable → also dropped.
3. The loop finishes normally and returns, so the UI commits a response **missing a
   chunk, with no error**.

Compounding bug: `decoder.decode(value)` lacks `{ stream: true }`, so a multi-byte
UTF-8 character split across two reads is mis-decoded too.

This affects **all streamed actions**; exempt actions (which stream live) just make
it more visible. It is intermittent because it depends on where the network happens
to chunk the bytes.

### Fix (the standard buffered-SSE-reader pattern)

Keep a `buffer` string across reads; only process COMPLETE lines; retain the
trailing partial line for the next read; flush on `done`:

```js
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });   // accumulate + streaming decode
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';                           // RETAIN the trailing partial line
  for (const line of lines) {
    // ...existing per-line handling (data: prefix, [DONE], JSON.parse, yield)...
    // NOTE: a `return` on [DONE] is fine; but see "flush" below for safety.
  }
}
// FLUSH: process whatever complete line remains in `buffer` after the stream ends
//   (decoder.decode() with no args flushes any pending multi-byte char first).
buffer += decoder.decode();
if (buffer.trim()) { /* run the same per-line handling once on the final buffer */ }
```

Design notes for the implementer:
- Factor the per-line handling (the `data:` prefix check, `[DONE]`, `JSON.parse`,
  `yield chunk`, the `usage` callback) into a small helper so the loop body and the
  final flush share ONE code path and can't diverge.
- **Keep the `catch`** as a genuine last-resort for a truly malformed frame — but it
  must no longer be swallowing *valid-but-split* lines (the buffer removes that case).
- `[DONE]` can itself be split across a boundary; because it's now only matched on a
  COMPLETE line pulled from the buffer, the split case is handled — but confirm the
  flush step also recognizes a trailing `[DONE]`.
- Do NOT change the request shape, the retry logic, or `humanizeTransportError` —
  only the read/parse loop.

---

## 3. Bug B29 — `finish_reason: "length"` silently treated as a clean finish (SECONDARY)

### Root cause (verified)

The streaming loop reads only `delta.content` and `usage` per frame — it **never
inspects `choices[0].finish_reason`**. When the model hits the token cap
(`DEFAULT_GUARDRAILS.maxTokens = 800`, `src/types/api.ts` — a single SHARED cap, no
per-action budget), the API emits a terminal frame with `finish_reason: "length"`,
the answer is genuinely cut off mid-thought, and the generator just returns —
**indistinguishable from a clean `"stop"` finish.** The user sees a truncated answer
presented as complete.

Most exposed: `UNDERSTAND_SOLUTION` (a long worked explanation PLUS a trailing
structured JSON block — easily exceeds 800 tokens). This is a DIFFERENT bug from
B28: B28 *drops generated content* via a parse flaw; B29 is content that was *never
generated* because of the cap, then passed off as complete.

**Precedent to mirror:** the type already exists —
`finishReason: 'stop' | 'length' | 'content_filter'` (`api.ts` L66) — and the
NON-streaming paths already read it (`llm-service.ts` L161, L206:
`finishReason: data.choices?.[0]?.finish_reason ?? 'stop'`). Only the STREAMING path
ignores it.

### Fix (honesty — a truncated answer must never look complete)

- On the streaming path, read `parsed.choices?.[0]?.finish_reason` per frame and
  remember a terminal `"length"`.
- When the stream ends on `"length"`, surface a **subtle, honest "response was cut
  off (token limit)"** signal to the UI — NOT a silent finalize. Keep it a soft
  cue, not an error (the partial content is still useful).
- **AND/OR** raise `maxTokens` for the long-output actions (esp.
  `UNDERSTAND_SOLUTION`) so the cap is hit far less often. (Design decision for the
  build session: a per-action budget vs. a higher shared default. A per-action
  budget is cleaner — `UNDERSTAND_SOLUTION`/`GENERATE_REPORT` get more, hints stay
  small — but touches the request-building path; confirm the blast radius. The
  honest-signal half is the non-negotiable part; the budget bump is the quality-of-
  life half.)
- The signal needs a channel from the generator to the caller. Options for the
  implementer: a sentinel the caller checks, or extend the streaming request's
  callback surface (there's already an `onUsage` callback precedent). Keep it
  minimal and typed.

---

## 4. The third contributor (LOWER confidence — only if the symptom persists)

The 20s request timeout is a **single hard wall-clock deadline** (not an idle
timer), and the streaming path runs through `fetchWithRetry`. A slow or
transiently-503 response can be **torn down / re-issued while a late generation is
still in flight** — the likely cause of the "block finalized, then the full response
arrived afterward" variant, if that was observed.

- **Do NOT fix this reflexively.** B28 is the dominant cause; fix B28 + B29 first and
  re-observe. If the "late arrival overwrites / truncates" variant still shows up:
  - switch the streaming timeout to an **idle-based** timer (reset on each received
    chunk) so a steadily-streaming long answer isn't killed at a hard 20s;
  - add a **request-generation guard** in `App.tsx` so a late/retried stream can't
    commit over a newer one.
- This touches `App.tsx` and the timeout logic (wider blast radius than the
  self-contained B28/B29), so it's a documented STRETCH, gated on evidence.

---

## 5. Why unit tests, not manual repro (important)

B28 is **intermittent and network-timing-dependent** — you cannot reliably reproduce
it on demand, so "eyeball the extension" is NOT a valid verification. The fix MUST
be proven by unit tests that simulate the byte-boundary conditions deterministically.

**Required tests** (new `llm-service` streaming test file, or extend an existing
`llm-*` test; the repo is DOM-free `env=node` — mock the `reader`):
1. **B28 split-line reassembly:** feed a reader whose two `read()` values split a
   single `data: {…}` SSE line across the boundary; assert the content is yielded
   **whole** (no dropped chunk).
2. **B28 multi-byte char:** a multi-byte UTF-8 char split across two reads decodes
   correctly (not mojibake).
3. **B28 `[DONE]` across a boundary:** still terminates cleanly.
4. **B28 flush:** a complete final line left in the buffer when `done` arrives is
   still processed (its content yielded), not lost.
5. **B29 length cutoff:** a terminal frame with `finish_reason: 'length'` surfaces
   the truncation signal; a `'stop'` finish does NOT (no false positive).
6. **Regression:** a normal multi-frame stream (no splits) still yields identical
   content — the buffer change doesn't alter the happy path.

Simulate the reader with a stub exposing `read()` that returns a scripted sequence of
`{ done, value }` where `value` is `new TextEncoder().encode(chunk)` — this lets you
control exactly where the byte boundaries fall.

---

## 6. Scope guards

- **Only `streamLLMRequest`** changes for B28; B29 adds a `finish_reason` read on the
  same path + (optionally) a token-budget tweak in the request builder. Do NOT touch
  the filter/guardrail, the pre-display gate, the intent router, or the progress
  code.
- Do NOT change `humanizeTransportError`, `fetchWithRetry`, or the retry counts
  (unless doing the §4 stretch, which is gated on evidence).
- The non-streaming `sendLLMRequest` already handles `finish_reason` correctly —
  leave it alone (it's the precedent, not a target).
- Keep the request shape identical (same `stream_options`, `max_tokens` source,
  etc.) except the optional §3 budget bump.

## 7. Registry

B28 and B29 are already logged in `leetsage-guardrail-hardening/requirements.md`
(📝 open). On completion, flip both to ✅ fixed with the branch/commit, per the
standing bug-registry discipline (each fix ships with the guarding test from §5).
If the §4 stretch is built, log it as a third row (B30) or fold it into B28's note.
