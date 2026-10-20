# LeetSage — Guardrail Hardening & Bug Registry: Requirements

> **Status: ✅ Built — B1, B2, B3 fixed and guarded.** A pre-launch hardening
> spec. It fixes a set of guardrail/UX bugs found in real use, and it establishes
> a **standing bug registry** (below) that future bugs append to, so bug fixes
> stay consolidated and each one is guarded by a test/eval instead of silently
> regressing. All three bugs are fixed, each backed by an automated guard; the
> full suite (191 tests incl. the guardrail eval) is green.
>
> Companion: [design.md](./design.md) · [tasks.md](./tasks.md) ·
> [../leetsage-structured-output/design.md](../leetsage-structured-output/design.md) ·
> [../leetsage-prompt-injection/design.md](../leetsage-prompt-injection/design.md) ·
> code: `src/services/solution-filter.ts`, `src/services/prompts.ts`,
> `src/sidepanel/App.tsx`, `src/evals/`.
>
> **Dependency note:** the `PATTERN_RECOGNITION` prompt bug (observed alongside
> these) is **deliberately NOT in this spec.** Whether to fix it depends on whether
> the `Pattern` action survives the action-streamlining work
> (`leetsage-action-streamlining`), so that spec owns it. Fixing a prompt for a
> button that may be cut would be wasted effort.

---

## Governing principle

**Every guardrail bug fix MUST add a test or eval case that would have caught it.**
The bug registry is only durable if each entry is backed by an automated guard
(Vitest test or a labeled eval case, gated by CI). A fix without a guard is
allowed to silently regress — which is how these bugs reached production in the
first place.

---

## The bugs in scope (found in real use, 2026)

### B1 — Flagged content is visible before the filter gates it *(guardrail integrity)*
**Observed:** pressing `Concept` streamed a response that began with real
solution-adjacent content (the problem's algorithm name and detail) token-by-token
onto the screen; only *after* the full response arrived did `filterResponse` run
and replace it with the "Content filtered" message. The user could read the
flagged content before it was removed.
**Root cause:** in `App.tsx`, the response streams directly into the visible card
inside the `for await` loop; `filterResponse()` runs only *after* the stream
completes. The guardrail is a post-hoc replacement, not a pre-display gate.
**Severity:** high — for a genuine solution leak, the user reads the answer before
it's filtered, defeating the core "never reveal the solution" promise.

### B2 — Free-form chat forces a real-world analogy onto direct questions *(prompt correctness)*
**Observed:** asking a simple, direct question in chat (e.g. about a loop or a
function) returned a forced real-world analogy ~3/4 of the time, often irrelevant
to the actual question.
**Root cause:** the free-form `userQuery` path routes through the
`EXPLAIN_CONCEPT` system prompt, which literally instructs "Use a real-world
analogy…". A direct question is shoehorned into the concept-explanation template.
**Severity:** medium — wrong/annoying UX; undermines the chat escape-hatch. More
important if action-streamlining pushes more conceptual asks into chat.

### B3 — The solution filter misses compact "folded-conditional" pseudocode *(guardrail integrity)*
**Observed:** `Pattern` returned a fenced pseudocode block that was essentially the
whole binary-search algorithm, and the filter let it through.
**Root cause:** `looksLikeFullPseudocode()` requires `controlLines.length >= 5 &&
hasLoop && hasResult`. A compact algorithm with the conditional folded into the
loop header (e.g. `while left <= right: mid = …; if …: …; else: …`) has too few
line-leading control keywords and no line-leading `return`/result, so it slips
under the threshold — a false negative in the filter itself (independent of which
action produced it).
**Severity:** high — a real solution-leak path through the deterministic backstop.

> The `PATTERN_RECOGNITION` *prompt* also permitted that block by not forbidding
> code/pseudocode. That prompt fix is deferred to the streamlining spec (see the
> dependency note above). B3 here is about the **filter**, which must catch such a
> leak no matter what produced it.

### B4 — Free-form chat is blind to the user's editor code *(missing capability)* — ✅ fixed
**Observed** (during B1's visual review, 2026-09-23): asking chat "what is the
current time complexity" with a complete, Accepted solution in the editor returned
"you didn't include your code in the prompt". **Root cause:** the `userQuery` path
(`handleChatSubmit`) never called `extractCurrentCode` — only the templated
`CHECK_APPROACH`/`UNDERSTAND_SOLUTION`/`GENERATE_REPORT` actions sent editor code.
So chat literally could not see the code and correctly said so. **Not a B2
regression** (B2 only removed the forced analogy, which worked). **Fix:** chat now
always sends the (non-empty) editor code, folded into the `wrapUntrusted` DATA
block (`buildChatData`); the chat prompt is aware of it but must not assume it's
correct. **Decision — chat stays NON-EXEMPT (filtered):** an action button has a
fixed trusted intent, but chat is free text, so making code-bearing chat *exempt*
would let a "complete my stub" ask bypass the filter. Keeping chat filtered lets the
model analyze/quote pieces of the user's code while a full-solution dump is still
caught; "show me the solution" is redirected to the `Understand Solution` action.

### B5 — Heavy non-exempt actions feel slow behind the B1 gate *(perceived performance)* — ✅ fixed
**Observed** (same review): `Concept` showed ~5–6s of "Thinking…" before revealing,
while `Hint`/`Pattern` returned in ~1s. **Root cause:** B1's gate withholds the
whole stream until complete, so the user now waits the FULL generation time that
live streaming used to mask; `Concept` has the heaviest non-exempt prompt. The gate
is behaving correctly (design §1 called out this trade) — this is **perceived
performance**. **Fix:** the placeholder no longer reads as frozen — after a 3s grace
period `ThinkingIndicator` switches to "Still working on it…" plus an elapsed-seconds
counter, a lightweight proof-of-life (not a real progress bar; the model's progress
is unknowable). The gate itself is unchanged.

> B4 and B5 were surfaced by exercising the shipped B1 change — exactly the "get UI
> changes eyeballed" step catching real issues. Per the standing-registry principle
> each was logged as a row and then fixed in a follow-up pass (kept separate from the
> B1–B3 commits). The larger **intent-routing** idea that grew out of B4 (route a
> chat message to a matching action when one fits) is intentionally NOT built here —
> it's its own feature with a guardrail decision (routing free text into
> filter-exempt actions), tracked separately as a new spec.

---

## Requirements

### R1 — Pre-display gate (fixes B1)
- **R1.1** WHEN a **non-exempt** action (any action NOT in the solution-exempt set:
  `CHECK_APPROACH`, `UNDERSTAND_SOLUTION`, `GENERATE_REPORT`) is generating, THE
  SYSTEM SHALL show a non-content **placeholder** (e.g. "Analyzing…") in place of
  the raw streaming tokens, and SHALL NOT display the model's actual content until
  after `filterResponse` has run.
- **R1.2** WHEN the response passes the filter, THE SYSTEM SHALL reveal the
  (filtered) content.
- **R1.3** WHEN the response is filtered, THE SYSTEM SHALL show only the
  "Content filtered" message — the raw flagged content SHALL never have been
  visible.
- **R1.4** THE SYSTEM MAY continue to stream exempt actions
  (`CHECK_APPROACH`/`UNDERSTAND_SOLUTION`/`GENERATE_REPORT`) live, since solution
  content is allowed there and they bypass the filter — preserving their
  responsive UX. (Structured actions still strip their data block mid-stream as
  today.)
- **R1.5** The placeholder SHALL be an **animated, pulsing/fading multi-dot
  indicator** (dots cycling opacity in staggered sequence) paired with a **short,
  action-aware label** (e.g. Hint → "Thinking of a hint…", Break down → "Breaking
  it down…", Concept → "Explaining…", free-form chat → "Answering…"). It SHALL read
  as actively "working," never a frozen blank card. The exact wording and the
  animation timing are a UX detail to confirm with the user (visual review) during
  the build; a neutral fallback label ("Thinking…") is acceptable where no
  specific one fits.

### R2 — Direct-answer chat path (fixes B2)
- **R2.1** WHEN the user asks a free-form question (the `userQuery` path), THE
  SYSTEM SHALL use a prompt that answers the question **directly**, NOT the
  `EXPLAIN_CONCEPT` template.
- **R2.2** THE chat prompt SHALL NOT mandate a real-world analogy; it MAY use one
  only when genuinely helpful to the specific question.
- **R2.3** THE chat prompt SHALL still obey the no-solutions guardrail and the
  untrusted-content framing (`wrapUntrusted`) already applied to the query.
- **R2.4** Free-form chat SHALL remain subject to `filterResponse` (it is not an
  exempt action), and therefore also to the R1 pre-display gate.

### R3 — Close the filter blind spot (fixes B3)
- **R3.1** THE `looksLikeFullPseudocode` heuristic (or its replacement) SHALL flag
  a compact algorithm that folds its conditional into a loop header — i.e. detect
  full-procedure pseudocode even when line-leading `if`/`return` are absent —
  WITHOUT flagging short single-idea illustrative snippets or plain narrative
  prose.
- **R3.2** THE fix SHALL be validated by adding the real observed leak (the
  binary-search pseudocode block) and near-miss safe cases to the labeled
  guardrail eval dataset, and the eval SHALL report the updated catch/false-positive
  rates.

### R4 — Bug registry (standing, extensible)
- **R4.1** THE spec SHALL maintain a **bug registry** table (below): each row has an
  ID, symptom, root cause, fix, the guarding test/eval, and status.
- **R4.2** Future bugs SHALL be appended here (not scattered), and each fix SHALL
  add its guarding test/eval per the governing principle.

### R5 — Verification & no regressions
- **R5.1** All fixes SHALL be covered by Vitest tests and/or eval cases, gated by
  the existing CI + Husky pre-commit (`lint` + `test` + `build` must pass).
- **R5.2** The existing 149-test suite and guardrail eval SHALL continue to pass
  (no regressions); the eval's catch rate SHALL not decrease.

---

## Bug registry

| ID | Symptom | Root cause | Fix (req) | Guard | Status |
|----|---------|-----------|-----------|-------|--------|
| B1 | Flagged content visible before filter replaces it | Streams to view; filter runs post-stream | Pre-display gate for non-exempt actions (R1) | `src/sidepanel/__tests__/predisplay-gate.test.ts` (gate contract) | ✅ fixed |
| B2 | Chat forces irrelevant real-world analogy | `userQuery` uses `EXPLAIN_CONCEPT` prompt | Direct-answer chat prompt (R2) | `prompts.test.ts` — "direct-answer, no forced analogy (B2)" | ✅ fixed |
| B3 | Compact folded-conditional pseudocode leaks through filter | `looksLikeFullPseudocode` threshold blind spot | Detect folded-conditional algorithms (R3) | Eval cases `pos-pseudo-binsearch-folded[-prose]` + `solution-filter.test.ts` | ✅ fixed |
| B4 | Free-form chat can't answer questions about the user's own code (e.g. "what is the current time complexity" → "you didn't include your code") | The `userQuery` path in `handleChatSubmit` never extracts/sends the editor code — only the templated `CHECK_APPROACH`/`UNDERSTAND_SOLUTION`/`GENERATE_REPORT` actions call `extractCurrentCode`. Chat is blind to the editor. | `handleChatSubmit` now always sends the (non-empty) editor code; `buildChatData` folds it into the `wrapUntrusted` block. **Chat stays NON-EXEMPT** (still filtered) — the model may analyze/quote pieces but a full-solution dump is still caught; the prompt points a "show me the solution" ask to `Understand Solution` | `chat-code.test.ts` — code folded in / omitted; prompt aware-of-code but guardrailed | ✅ fixed |
| B5 | Non-exempt actions with heavy prompts (esp. `Concept`) show 5–6s of "Thinking…" before reveal — feels frozen | B1's pre-display gate withholds the whole stream until complete, so the user now waits the FULL generation time (which live streaming used to mask). `Concept`'s prompt is the heaviest non-exempt one. | `ThinkingIndicator` now runs an elapsed timer: after a 3s grace period it switches to a "Still working on it…" phrase + an elapsed-seconds counter, so the card visibly signals life instead of a frozen label. (Perceived-performance only — the gate is unchanged; not a real progress bar since the model's progress is unknowable.) | Visual review + the existing B1 gate test (labels still fixed strings) | ✅ fixed |

| B6 | Chat should route a question to a matching action (e.g. "is my code O(n²)?" → Analyze code) instead of always free-forming | Chat has no intent classifier; every message goes down the free-form path | **✅ Resolved by `leetsage-chat-intent-routing`** (built on branch `feature/chat-intent-routing`): a pure `classify → resolveOverlap → route` pipeline sits in front of the chat path. Classifier is a local heuristic (no extra API call); the decision is three-way (`route`/`ask`/`chat`); an exempt-action match is turned into a **confirm affordance** (never a silent route into a filter-exempt action, resolving the guardrail-hole the deferral flagged). | Labeled golden set (`intent-router/__tests__/golden-set.test.ts`) doubling as the router's accuracy metric, incl. an explicit "solution-seeking message never silently reaches an exempt action" test | ✅ fixed (in `leetsage-chat-intent-routing`) |
| B7 | Complexity badge splits on nested parens — `O(log(M) + log(N))` renders only `O(log(M)` as a yellow badge, the rest as plain text | `renderComplexity` regex `/O\(([^)]+)\)/` stops at the FIRST `)`, so any inner paren (`log(M)`, `O(N*log(N))`) truncates the match | Balanced-paren parser (`splitComplexity`/`matchingParen` in `complexity-parse.ts`) captures the whole `O(...)` incl. nested parens as one badge | `complexity-parse.test.ts` — nested / two-per-line / unbalanced / no-complexity cases | ✅ fixed |
| B8 | `Analyze code` under-credits optimality: didn't note that `O(log M + log N)` is equivalent to `O(log(M·N))`, so a user who reached optimal is told "Optimal: O(log(M*N))" as if different | Prompt/model reasoning — the coach doesn't apply log-equivalence to recognize the user matched optimal | Prompt nudge to recognize algebraic complexity equivalences (deferred — fuzzy, model-reasoning, not rendering) | (prompt-level; hard to guard deterministically) | 📝 deferred |
| B9 | Structured-action section HEADERS are hallucinated — observed `## 🌍 Real-Year Analogy` rendered in an `UNDERSTAND_SOLUTION` card where the prompt specifies **`## 🌍 Real-World Analogy`** (model wrote "Real-Year" for "Real-World"). Misleads the user and looks broken. | These headings are **NOT hardcoded/deterministic** — a common wrong assumption. The prompt only *describes* the section shape (`## 🌍 Real-World Analogy`, `## 🔑 Key Insight`, …) as instructions; the model reproduces the literal heading text token-by-token, so it can drift/hallucinate. `ContentDisplay` renders headings via raw `line.slice(3)` (no transform touches heading words — verified the `n→N`/superscript replaces run ONLY inside `O(...)` complexity segments), so the corruption is in the model output, not the renderer. Happens identically via a button press or a routed chat message. | Deferred (out of scope for `chat-intent-routing`, which must not modify prompts). Candidate fixes, in order of robustness: (a) **client-side canonicalization** — since the section set is fixed per action, post-process the response to snap near-miss headings back to the canonical strings (deterministic, testable); (b) strengthen the prompt to emit section headings verbatim / from a fixed list; (c) render section headings from a client-owned template keyed by position rather than trusting the model's heading text at all. Option (a) or (c) makes the headings deterministic again. | (none yet — belongs to a future prompt/rendering-hardening pass; a canonicalization helper would get a unit test) | 📝 deferred (documented) |
| B10 | **Optimal time/space complexity DRIFTS across messages in the same session** — e.g. `Analyze my code` says Optimal `O(N)/O(N)` and a later message says `O(N+M)/O(N+M)` for the same problem. The optimal is a FIXED property of a problem; it must not change within a session. | **No single source of truth for optimal complexity.** Each of CHECK_APPROACH / UNDERSTAND_SOLUTION / GENERATE_REPORT / TIME_COMPLEXITY_HINT / free-form chat is an INDEPENDENT model call that re-guesses it; parsed optimals are stored only as per-message `metadata.structured` artifacts; and the E9 two-layer memory does NOT pin it — the conversation window excludes action cards, and `buildSessionDigest` surfaces optimal only as *advisory prose* that can even carry **two conflicting lines** (latest analysis' vs. latest understanding's optimal). The only reconciliation (`extractSessionFacts` → report > latest-understand > latest-analysis) runs ONLY at report-save time and never feeds back into a prompt. (Full lifecycle trace: 2026-10-05.) | **Deferred to the E6 bug-hardening pass.** Fix direction: establish a single source of truth per problem — on the first authoritative optimal (CHECK_APPROACH / UNDERSTAND_SOLUTION), capture + persist it keyed on the normalized `/problems/{slug}/` URL, then feed it back into EVERY subsequent prompt (actions + chat) as a HARD constraint ("the established optimal is X; use exactly this, do not recompute"); fix the digest to emit ONE reconciled optimal line. Open decision: trust the first pin, or let UNDERSTAND_SOLUTION override + re-pin (GM leans the latter). Nuance: model-produced with no verifier, so "strict" = pin-and-reuse, not provably-correct. Related to but distinct from B8 (B8 = crediting equivalent notations; B10 = not drifting). See roadmap `PRE-LAUNCH-ROADMAP.md` backlog. | (none yet — the E6 fix adds a persistence + prompt-constraint test; a drift-across-two-calls test is the natural guard) | 🏗️ built, pending review (E6 batch 2 — pin the OPTIMAL only, keyed on slug, in a dedicated `complexity_pin_{slug}` store (`services/complexity-pin.ts`); authority rule (b): first emission pins, UNDERSTAND_SOLUTION overrides; injected as a hard constraint into CHECK_APPROACH / GENERATE_REPORT / chat prompts; digest emits ONE reconciled optimal line; cleared on "Reset this problem"; + hidden-CoT & constraint-anchored-variable levers. Guards: `complexity-pin.test.ts` (persistence, drift regression, authority rule, clear) + `prompts.test.ts` + `session-digest.test.ts`. Live-confirmed stable + correct on Longest Consecutive Sequence. Makes the optimal STABLE/self-consistent, NOT provably correct — correctness is E10) |
| B11 | **Duplicate "Try"** in the discovery UI — the chip row label `Try asking:` AND the rotating placeholder's `Try: …` prefix both say "Try", so on an empty/first-run chat (when both show) the user sees "Try" twice. | Two independent discovery surfaces each carried the word: the `Try asking:` chip-row label in `App.tsx` and the `Try: ` prefix on 5 of 6 `PLACEHOLDER_EXAMPLES` in `discovery-prompts.ts`. | Chips keep the `Try asking:` framing; the placeholder examples DROP the `Try: ` prefix and just show the example (single source of the word). | `discovery-prompts` test asserting the placeholder strings no longer carry the `Try: ` prefix | ✅ fixed (in `leetsage-chat-polish`, PR #20) |
| B12 | **Try chips populate but don't submit** — tapping a "Try asking…" chip only filled the input; the user still had to press Send, even though the chips are COMPLETE example questions (not templates needing input). | `onClick={() => setChatInput(chip)}` only set state; nothing fired the submit path. | Chip tap now calls `submitChat(chip)` so the message fires immediately (also exercising the real routing path). `submitChat` takes an explicit arg to avoid a set-state race rather than reading `chatInput` state. | test asserting a chip tap triggers the submit path (not just a state set) | ✅ fixed (in `leetsage-chat-polish`, PR #20) |

| B13 | **"Analyze my code" loses formatting when complexity contains `*`** — e.g. `O(N*M)` renders mangled (asterisks stripped, text italicized) in the Efficiency section. | `renderInline` (`ContentDisplay.tsx`) splits on markdown emphasis (`\*[^*]+\*` / `\*\*…\*\*`) BEFORE complexity parsing, so the literal `*` in `N*M` are consumed as italic delimiters and stripped before the (otherwise `*`-safe) `splitComplexity → renderComplexity` chain runs. Latent sibling: `/n/g → N` inside a complexity segment corrupts `O(min(a,b))` → `O(miN(a,b))`. | **Root fix:** render the Efficiency Current/Optimal complexity from the structured `AnalyzeData` (parsed/validated values) instead of re-parsing prose; the badge becomes authoritative and the markdown-eats-`*` class dies. Plus defense-in-depth: protect `O(...)` groups in `renderInline` before the emphasis split, and scope the `n→N` replace. | renderer/`complexity-parse` tests: `O(N*M)`, `O(N * M)`, `O(n*m)`, `O(min(a,b))`, `O(N log N)`, nested; badge reads from structured data when present | ✅ fixed (E6, R3 — `renderInline` now honors only `**bold**`/`` `code` `` so bare `*` in prose (`N * M`) and inside `O(N*M)` is no longer eaten as italic; `O(...)` masked before the emphasis split; `formatComplexityInner` fixes the `min`→`miN` over-replace. `complexity-parse.test.ts` incl. a prose-`*` regression guard. NOTE: the prose-driven-badge "root fix" (`applyStructuredComplexity`) was REVERTED — it no-oped in the common case (prose and JSON agree) and only added render risk; it also can't fix the O(N) drift since the JSON drifts too. Structured-driven badge deferred to B10) |
| B14 | **"Analyze my code" reports WRONG/UNSTABLE complexity** — reported `O(N)` for Encode and Decode Strings (verified-correct answer is `O(N·M)`); flip-flops run-to-run (an earlier run was correct). Also "suggests" the length-prefix approach the user ALREADY uses, and implies non-optimal when the user IS optimal. | **Prompt example-bleed:** `getSystemPrompt('CHECK_APPROACH')` hardcodes a Two-Sum example Efficiency section (`**Current:** O(N²)…/**Optimal:** O(N)…`) + narrative, and `ANALYZE_DATA_EXAMPLE` repeats `O(N^2)`/`O(N)`. The weak "SHAPE not text to copy" caveat lets `flash-lite` echo the example instead of computing from the user's code. Parser is innocent (passes strings through). | **Prompt fix:** replace concrete example Big-O with abstract placeholders + an explicit "compute from the actual code, do not reuse example values" instruction; keep section structure. | `prompts.test.ts` — CHECK_APPROACH prompt contains no concrete answerable example Big-O; full correctness guarded later by the eval | 🏗️ partial (E6, R1 — removed the Two-Sum example-bleed: abstract `O(<time>)` placeholders + "COMPUTE, DON'T COPY" in `prompts.ts`, guarded by `prompts.test.ts`. BUT dogfooding showed the model still flip-flops O(N) ↔ O(N·M) run-to-run on Encode/Decode Strings — removing the bleed was necessary, not sufficient. The run-to-run instability needs **B10** (pin one canonical optimal per problem) + the eval; NOT closed by this batch) |
| B15 | **"Analyze my code" gives advice that contradicts the user's actual code** (e.g. "use a length prefix" when they already do). | **Incomplete/empty code capture:** `extractCurrentCode`/`readEditorFromPage` (`code-extractor.ts`) falls back to **visible-only** `.view-lines` scraping and has **no retry/backoff**; a failed MAIN-world read or scrolled editor yields partial/empty code, so `buildUserMessage` says "editor is empty" and the model gives generic advice (which, via B14, becomes the hardcoded Two-Sum narrative). | Add retry/backoff (mirror the problem-data pull); prefer the full Monaco model; treat the visible-DOM fallback as DEGRADED; when truncated/empty, tell the model honestly ("code may be partial") and don't emit an authoritative complexity as if the whole solution was seen. | extractor model-vs-DOM selection tests; truncated/empty capture → honest "partial" prompt path | ✅ fixed (E6, R2 — full-Monaco-only source, DOM demoted to liveness signal, retry/backoff, discriminated `ok\|empty\|failed`; `code-extractor.test.ts`; pending live confirm) |
| R4-note (folds into B14/B15) | **Complexity shown as a bare, undefined symbol** — `O(N)` with no definition confused the user (LeetCode's N = #strings; some sources' N = total chars). | The prompt/coach never pins what the variable means. | Require either an explicit multi-variable form (`O(N·M)`) or a single symbol WITH its definition stated ("O(N) where N = total characters"); never an undefined bare `O(N)`. | prompt-level; guarded by the eval | 🏗️ partial (E6, R4 — "STATE YOUR VARIABLES" rule + a dedicated **Variables:** line in the CHECK_APPROACH prompt require every symbol to be defined; guarded in `prompts.test.ts`. Prompt-level only; whether a cheap model always complies is for the eval. Tied to B14's instability — not fully closed by this batch) |

| B16 | **"Analyze my code" headline complexity contradicts its own breakdown** — within ONE response, the `**Current:**` line read `O(N*M + C)` while the per-operation bullet right below it correctly said `O(C*N*M)`. (Distinct from B14's cross-run drift and B10's cross-message optimal drift — this is an intra-message inconsistency.) | The `**Current:**`/`**Optimal:**` headline was generated independently of the "Where the cost comes from" bullets, so the summary and the breakdown could disagree. | Prompt fix: compute the per-operation bullets FIRST, then set the headline to their aggregate (loops multiply, sequential steps add, drop lower-order terms); instruct the model to re-read the bullets and confirm the headline agrees. | `prompts.test.ts` — CHECK_APPROACH prompt carries the "headline must match your breakdown" rule | 🏗️ partial (E6 — prompt-level consistency rule added + guarded; whether a cheap model always complies, and whether the number is actually CORRECT, is for the correctness eval **E10**. NOT the same as B10) |

| B17 | **Stats-panel caption leaks an internal file name + misframes "cost"** — the "Session stats" readout says "Cost is an estimate from public per-token pricing (**see metrics-pricing.ts**)", exposing an internal source file to users, and presents an "Est. cost" that implies a bill. | Developer-oriented caption text shipped to the UI (`StatsPanel.tsx`); and the cost framing doesn't state that a free-tier user is NEVER charged (a 429 rejects, never bills — see DESIGN_DECISIONS ADR-007 clarification 2026-10-06). | Reword the caption: drop the `metrics-pricing.ts` reference entirely; state plainly that on the free tier the user pays nothing (the figure is a token-efficiency estimate at public pay-as-you-go rates, not a bill). UI text → user eyeballs before commit. | `StatsPanel` test / snapshot asserting the caption contains no internal file name and states the no-charge framing | 🏗️ built, pending review (E6 batch 2 — caption extracted to exported `COST_CAPTION` in `StatsPanel.tsx`: dropped the `metrics-pricing.ts` reference, states plainly the free-tier user is NOT charged and the figure is a pay-as-you-go estimate, not a bill. Guarded by `stats-caption.test.ts`. UI text → user eyeballs) |

| B18 | **A pointed complexity FOLLOW-UP about the user's own code misroutes to the generic `TIME_COMPLEXITY_HINT` action instead of chat/analyze** — observed (2026-10-06, Longest Consecutive Sequence): the user typed "how is it O(N) when the inner while loop can run N times?" expecting a conversational answer grounded in THEIR code; the intent router classified it as a complexity-hint intent and dispatched `TIME_COMPLEXITY_HINT`, so (a) the user's question never appeared as a chat bubble (the action path doesn't create one — only `handleChatSubmit` does), and (b) they got a generic, algorithm-withholding "Complexity Hint" card instead of an answer to the actual question. | `routeMessage` (`intent-router`) over-triggers on complexity keywords ("time complexity", "O(N)") and routes to `TIME_COMPLEXITY_HINT` even when the message is a *follow-up question about the user's existing code* (which should go to chat / analyze). The hint action is designed to AVOID revealing the algorithm, so it's the wrong target for "explain why MY code is O(N)". NOTE: this is a ROUTING defect, not a correctness defect — the Complexity Hint card it produced was objectively correct FOR THE ACTION IT RAN (correct Target O(N)/O(N), correct O(N log N) sort note); the failure is that it answered the wrong question, not that the content was wrong. | Intent-router scope (NOT touched in the B10 batch — explicit non-goal). Candidate fixes: tighten the classifier so an interrogative referencing the user's own code/result ("how is it…", "why is my…") routes to chat rather than the generic hint; and/or ensure a dispatched action still echoes the originating question as a bubble so the transcript isn't confusing. | intent-router classification test: a "how/why is my code O(…)" follow-up routes to chat, not `TIME_COMPLEXITY_HINT` | ✅ **resolved by redesign** 2026-10-15 (`leetsage-coaching-logic-overhaul`, PR #31 `afaf37a`). Addressed at the ROOT rather than by re-routing: `TIME_COMPLEXITY_HINT` is now **code-aware** — when the editor has code it reads it and emits the Analyze-style `## ⚡ Efficiency` card (Current / Optimal / Variables / "where the cost comes from" breakdown + an adaptive Hint-or-"you've hit optimal" line), so a complexity question landing on this action now gets a grounded answer about the user's OWN code instead of a generic target-complexity card. The misroute symptom (same generic answer every time) is gone because the destination action is no longer generic. (No-code → the old optimal-only hint; reuses the B10 pin for Optimal; stays NON-EXEMPT.) The underlying router text-classification is unchanged, but the user-visible defect is resolved. |

| B19 | **Content-script startup extraction logs a `Timeout:` error on non-problem pages** — the `chrome://extensions` "Errors" panel shows a `Timeout: a[href^="/problems/"]` / `Timeout: div.text-difficulty-*` (or "Failed after 3 attempts: …") from the minified `content.js`. Observed 2026-10-09 during E7 step-1 testing; cosmetic — does NOT affect function (the panel's pull-based `REQUEST_PROBLEM_DATA` path with retries + inject fallback still delivers data on real problem pages). | `content/index.ts` runs `extractProblemContext()` eagerly on EVERY matching page load. On a LeetCode page that isn't a problem-description view (submissions tab, slow load, list), `waitForElement`/`waitForElements` (`extractor.ts`) time out after 10s × 3 retries and the rejection is `console.error`'d, surfacing in the extensions Errors panel. It's an *expected* "not a problem page yet" condition being treated as a hard error. **NOT permission-related and NOT caused by E7** — verified the only E7 change was the manifest `contextMenus` removal (git diff). Pre-existing. | Treat "selectors not present / not a problem page" as an expected non-error: either (a) swallow the startup-extract rejection quietly (don't `console.error` the expected timeout), or (b) gate the eager on-load extract behind a quick "is this a problem page?" check so it doesn't run (and time out) where it can't succeed. Keep the pull-based path unchanged. | a test asserting the startup path does not throw/log on a non-problem DOM; the pull path still resolves on a problem DOM | 📝 open (→ future content-script cleanup; OUT OF SCOPE for E7 which is manifest-only. Captured during E7 step-1 live testing) |

| B20 | **Progress IMPORT silently strips `<` and `>` from notes → DATA LOSS.** Round-tripping study notes through export→import deletes every `<`/`>`: e.g. `` `left < right` `` becomes `` `left  right` ``, `` `nums[mid] > nums[right]` `` becomes `` `nums[mid]  nums[right]` ``. Observed 2026-10-09 (E7 forced an export/import via the storage-wipe reinstall; a `Copy All` diff showed 12 lost chars, all `<`/`>`). High severity — notes are full of comparison operators in code/complexity prose, so this corrupts real content on EVERY import. | `neutralizeString` in `progress-io.ts` strips ALL `<`/`>` (+ control chars) as an XSS defense (security-audit finding #8). But the renderer is already XSS-safe (React JSX, no `innerHTML` — audit #6/#14), so this sanitization is **defense-in-depth, not the only layer** — meaning it can be made far less aggressive safely. Stripping bare comparison operators is overkill and lossy. | Make the sanitizer neutralize only **tag-FORMING** `<`/`>` (e.g. `<` immediately followed by a letter/`/`, as in `<script`, `</`) rather than every angle bracket — OR HTML-entity-encode them so they survive round-trips (but entity-encoding risks non-idempotency; the audit's import pipeline prizes idempotency, so prefer the targeted tag-forming strip). Must stay idempotent (export→import→export→import stable). **NOT an E7 regression** — pre-existing in `progress-io.ts`, surfaced by the E7-forced import. User's real notes are safe in the external backup + original JSON; only the re-imported `chrome.storage` copy is corrupted. | `progress-io` test: a note containing `a < b` / `x > y` / `arr[i] <= arr[j]` survives import UNCHANGED; a real `<script>`-forming string is still neutralized; round-trip idempotency holds | ✅ **fixed** 2026-10-10 (PR #27, commit `7106dad`). `neutralizeString` in `progress-io.ts` now strips only **tag-forming** `<` — `s.replace(/<(?=[a-zA-Z/])/g, '')` — so bare comparison operators (`a < b`, `x > y`, `arr[i] <= arr[j]`) survive import UNCHANGED while `<script`/`</…` are still neutralized; stays idempotent across export→import→export. Reminder: re-import the ORIGINAL JSON from the external backup to restore any `<`/`>`-corrupted notes already in `chrome.storage`. |
| B21 | **Content script doesn't inject when arriving at an ALREADY-OPEN LeetCode tab from a non-LeetCode page** — the realistic first-run flow (user starts on another site, then clicks their existing LeetCode tab) leaves the panel NOT recognizing the problem until the LeetCode page is manually reloaded. Observed 2026-10-09 during E7 testing. "Every user will do this." | MV3 "stale tab" problem: a LeetCode tab opened BEFORE the extension was (re)installed has no auto-injected content script, so `pullFromActiveTab`'s `REQUEST_PROBLEM_DATA` hits "Receiving end does not exist." There IS a `chrome.scripting.executeScript` inject fallback in `App.tsx`, but it's guarded to `attempt === 0` and can be racy on an already-rendered page (problem DOM not immediately scrapeable; the single retry chain exhausts), so a manual page reload (which triggers Chrome's normal auto-injection) is needed. **NOT an E7 regression** — identical behavior under the old broad `http://*/*` host; E7 touches only the manifest permission, not injection timing. The user previously didn't hit it because they always started ON LeetCode. | Make the inject fallback more robust for the stale-tab case: allow the `executeScript` re-inject on more than just `attempt===0` (or on the `onActivated`/`onUpdated` sync path specifically), and/or widen the post-inject retry window so an already-rendered problem page is scraped without a manual reload. Keep the pull-based design. | a test/scenario: arriving at a pre-existing LeetCode tab (no content script) auto-injects + loads the problem without a manual reload | ✅ **fixed** 2026-10-10 (PR #27, commit `26a0691`). Hardened the `chrome.scripting.executeScript` inject fallback in `App.tsx` for the stale-tab case (arriving at a pre-existing LeetCode tab from a non-LeetCode page) so the content script is injected + the problem loads without a manual page reload. Pull-based design preserved. |

| B22 | **`Pattern Recognition` card renders `####` headings as literal text** — the card showed raw `#### ...` instead of a formatted heading (screenshot-confirmed on 167. Two Sum II). Looks broken. | The `PATTERN_RECOGNITION` prompt (`prompts.ts`) specified NO heading structure (unlike every other action prompt), so a cheap model free-styled `####` sub-sub-headings — and `ContentDisplay`'s `renderContent` only draws `## ` (h2) and `### ` (h3), so a `#### ` line falls through to the `<p>` branch and renders verbatim. A prompt gap, not a renderer bug (every other card renders correctly off its explicit `##`/`###` structure). | Rewrite the `PATTERN_RECOGNITION` prompt to prescribe an explicit `## Pattern Recognition` + `### <pattern>` structure (mirroring the other cards) and explicitly forbid headings deeper than `###`. No renderer change. (`leetsage-post-launch-ui-fixes` R1.) | `prompts.test.ts` — "explicit heading structure (B22)": asserts `## `/`### ` instructions present + `####` forbidden + content scope preserved | ✅ fixed (post-launch-ui-fixes; user-verified on the built extension) |
| B23 | **`Generate examples` shows a Time/Space Complexity line on every example** — repetitive noise; complexity belongs in Hint/Analyze, not on each example. | The `GENERATE_EXAMPLES` prompt never requested Time/Space (its only body lines are `**Input:**`/`**Output:**`/`**Why this helps:**`; the `<complexity>` in its heading is the Simple/Medium/Tricky DIFFICULTY). The lines are **model free-styling**, nudged by the shared `OUTPUT_RULES` "whenever you state complexity, give BOTH time and space". | Add an explicit negative clause: do NOT put a Time/Space complexity line on examples (that belongs in Hint/Analyze); keep Input/Output/"Why this helps" + the Simple/Medium/Tricky label. Prompt-only; `OUTPUT_RULES` untouched. (`leetsage-post-launch-ui-fixes` R2.) | `prompts.test.ts` — "no per-example complexity line (B23)": keeps the 3 useful lines + difficulty label; asserts the no-Time/Space clause | ✅ fixed (post-launch-ui-fixes; user-verified) |
| B24 | **Chat input placeholder shows "Configure your API key first" mid-stream** — the instant a request started with a VALID key, the placeholder wrongly told the user to configure a key (screenshot-confirmed). | `currentPlaceholder = canInteract ? examples : 'Configure your API key first'` with `canInteract = apiKeyConfigured && !!problemContext && !isLoading` (`App.tsx`). `canInteract` was overloaded for both "is the input usable?" (correct) AND "which placeholder copy?" (wrong), so `isLoading → canInteract false → ` the no-key copy. | Extract a pure `chatPlaceholder(state)` (`discovery-prompts.ts`) that branches on the SPECIFIC disabled reason in priority order: no-key → off-page → busy (`'Thinking…'`) → rotating example. `canInteract` still drives the actual `disabled=` wiring (that was correct). Also leaves a clean seam for the sibling spec's off-page gating. (`leetsage-post-launch-ui-fixes` R3.) | `discovery-prompts.test.ts` — "chatPlaceholder (B24)": busy-with-key ≠ no-key copy; no-key top priority; off-page vs. busy vs. healthy | ✅ fixed (post-launch-ui-fixes; busy state user-verified; off-page not observable until B26 is fixed) |
| B25 | **`Pattern Recognition` card free-styles a stray complexity line** — e.g. "Complexity for this pattern is typically O(N) time and O(1) space." — noise on a card whose job is RECOGNIZING the pattern, not analyzing its cost (surfaced right after B22 was fixed). | Same root cause as B23: the shared `OUTPUT_RULES` "always give complexity" nudge, with the pattern prompt leaving room. | Append a negative clause to the (B22-rewritten) `PATTERN_RECOGNITION` prompt: do NOT state time/space complexity here (belongs in Hint/Analyze); omit any "complexity for this pattern is…" line. Also added blank-line spacing between the pattern subheading / "How to spot it" / "Similar problems" for readability. Prompt-only. (`leetsage-post-launch-ui-fixes` R5.) | `prompts.test.ts` — the B22 `describe` extended with a "forbids a stray complexity line (B25)" assertion | ✅ fixed (post-launch-ui-fixes; user-verified) |
| B26 | **Off a problem page, the previous problem "sticks"** — navigating off a LeetCode problem keeps the stale `problemContext` loaded, so `!!problemContext` stays true: the panel still shows rotating suggestions, and the B24 off-page placeholder branch never fires (so it couldn't be verified live). | `problemContext` is not cleared when the user leaves a problem page. This is **off-page gating** behavior. | **OUT OF SCOPE for `leetsage-post-launch-ui-fixes`** (user's explicit call) — belongs to the sibling **`leetsage-coaching-logic-overhaul`** spec, which owns off-page input gating. The B24 placeholder already leaves a clean off-page branch for it to drive. Logged here so it isn't lost. | (none yet — the sibling spec adds the guard: leaving a problem page clears `problemContext` and the off-page placeholder shows) | ✅ **fixed** 2026-10-15 (`leetsage-coaching-logic-overhaul`, PR #31 `afaf37a`). Resolved via a sturdier approach than clearing `problemContext`: a URL-based `onCoachablePage` signal (the active tab's `/problems/` URL, set on mount + the existing `onActivated`/`onUpdated` listeners) now drives gating — `canInteract = apiKeyConfigured && onCoachablePage && !isLoading`, so off a problem page the inputs disable and an "Open a LeetCode problem to use the coaching tools" notice shows regardless of whether the stale `problemContext` lingers. The B24 off-page placeholder branch is now reachable (`chatPlaceholder` takes `onProblemPage`). Scroll/copy/Settings/Progress stay usable. |
| B27 | **A user cannot remove their API key through the UI** — after entering a key + acknowledging consent, clearing the key field leaves Save DISABLED (only Cancel works), so there is no path to remove or blank the key. | `SettingsModal` was a one-way "enter a key to start" form: both `canSaveSettings` (`apiKey.trim().length > 0 && …`) and `handleSave` (`if (!key) { setError('API key is required'); return; }`) hard-require a non-empty key — nothing persists an empty key. Downstream, an empty key is ALREADY a fully-supported "unusable" state (every action/chat early-returns; `apiKeyConfigured` false disables everything + shows the no-key banner). | Add an explicit **"Remove key" button** next to the key field (deliberate removal, not an accidental blank), with an **in-panel themed confirm** (not a native `window.confirm`, which pops out-of-theme centered on the browser). Relax `canSaveSettings` so an empty key is saveable (removal) while a key-present save STILL requires consent. On removal, reset consent to unacknowledged (`consentAcknowledged:false`, `consentVersion:0`) — with no key nothing is sent, `isAlreadyConsented` is already key-conditional, and re-entering a key re-shows the consent gate. The consent SURFACE now reacts to the live key (clearing it flips the static "✓ acknowledged" box to the interactive, unticked checkbox; the box can't show ticked with no key). Pure `buildSettingsOnSave` encodes the consent-reset rule. (`leetsage-post-launch-ui-fixes` R6.) | `consent-gate.test.ts` — empty key saveable, non-empty still requires consent, `buildSettingsOnSave` resets consent on empty / sets it on present-key / preserves other fields | ✅ fixed (post-launch-ui-fixes; user-verified: removal works, in-panel confirm, consent unticks on removal, re-key re-shows consent) |

*(Append future bugs below this line as new rows.)*

---

## Non-goals / explicitly out of scope

- **The `PATTERN_RECOGNITION` prompt fix** — deferred to
  `leetsage-action-streamlining` (depends on whether `Pattern` survives).
- Reworking the action set / reducing options — that is the streamlining spec.
- Any new coaching capability — this is hardening only (feature-freeze mindset
  toward launch).
