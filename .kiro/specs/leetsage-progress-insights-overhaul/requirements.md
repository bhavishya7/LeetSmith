# Progress Insights Overhaul — Requirements

> **Requirements phase only.** This session writes requirements; **design + tasks
> + the deep code read go to a dedicated build session** (session handoff).
> **SUBSTANTIAL + guardrail-honesty-sensitive** (a data-model change + a reworked
> analytics pass + a judgment layer about what a "valuable, honest insight" is) →
> **full trilogy, sign-off between phases.** The build session writes tasks AFTER
> design + a deep read, pauses between phases, builds with `npm.cmd run build`,
> and **explains + STOPs for review before committing.**
>
> **Scope of THIS spec:** make the "My Progress" insights ACTUALLY valuable, using
> the data we already have (plus one new client-side-derived signal), kept honest
> about the free model's limits. The small UI navigation features (search / LeetCode
> link / filter+sort) are the SIBLING spec `leetsage-progress-quick-wins` (ships
> first). Submission verification ("Phase D") is explicitly NOT in this spec.

**Status:** 📝 Requirements draft — awaiting sign-off. Nothing built.
**Date:** 2026-10-20.

---

## Background / the problem (verified against `main`)

The current insight is effectively "average hints used," which is a weak proxy for
"how hard was this for me." Verified in `src/services/progress-analytics.ts`:

- `computeStruggleScore` has four inputs — `avgHintsUsed`, `avgAttempts`,
  `gaveUpRate`, `avgDifficultyWeight` — but **three are dead or near-dead in
  practice:**
  - **`gaveUpRate` is always 0.** No save path ever writes `outcome: 'gave-up'`
    (confirmed in `session-digest.ts buildRecordProjection`, which only emits
    `'solved'` or `'attempted'`); `'gave-up'` only enters via an imported file.
  - **`avgAttempts` is ~1 almost always** — `shouldReplaceLatest` de-dupes
    same-day/same-approach re-saves, and cross-day re-solves are rare, so the
    `max(0, avgAttempts-1)` term is usually 0.
  - **`avgDifficultyWeight`** is weighted only 0.5 over a coarse 1/2/3.
  - ⇒ **`avgHintsUsed * 2` is the effectively dominant term.** The UI even proves
    it: "Sorting (based on 4 problems; avg 1.8 hints)" surfaces only hints.

Meanwhile, **rich signals are already stored but never fed into insights**
(confirmed): per-attempt **achieved complexity** + the canonical **optimal from the
B10 complexity pin** (`src/services/complexity-pin.ts`); the full **difficulty mix**
per pattern (computed, never shown); the **attempt timeline** + `firstSolvedAt`
(only used for a staleness check); per-attempt **complexity progression**
(`complexityRank` exists). And `ProgressState.usedActions` is tracked live per
session but **never projected into the record.**

So: we can make insights dramatically more valuable mostly from data we ALREADY
have, with ONE new (client-side-derived) signal.

---

## Design intent — the three questions insights must answer (user, 2026-10-20)

Insights exist to answer exactly these three user questions. Every insight maps to
one; anything that doesn't is out of scope.

1. **"Am I improving?"** — a trend over time.
2. **"What should I work on next?"** — the weak pattern(s) to practice.
3. **"Do I solve correctly but inefficiently?"** — a flag that my solutions may not
   be at optimal complexity.

Plus supporting presentation: an overall **summary/dashboard**, **strongest AND
weakest** (not just weakest), **honest confidence framing** throughout.

`gave-up` is **dropped entirely** from scoring (user's call — it's a negative we
can't measure honestly and is a dead signal today).

---

## Requirements

### R1 — "Am I improving?" (trend over time)

- **R1.1** THE insights SHALL present a trend signal answering whether the user is
  improving over time, derived from the attempt timeline already stored
  (`Attempt.date`, `firstSolvedAt`, per-attempt `hintsUsed`/`complexity`).
- **R1.2** THE trend SHALL be computed over a meaningful window (design decides:
  e.g. recent N problems vs. earlier, or a time-bucketed view) and SHALL degrade
  gracefully when there's too little history to claim a trend (say "not enough data
  yet," never invent a trend).
- **R1.3** THE trend SHALL be framed HONESTLY: it is a signal from inferred data
  (hints, self-reported outcomes), not a verified skill measurement. No
  false precision (e.g. no "you improved 23%").

### R2 — "What should I work on next?" (weak patterns) — reworked scoring

- **R2.1** THE weakest-link / what-to-practice ranking SHALL NOT be driven almost
  entirely by hint count. It SHALL combine the signals that are actually
  meaningful: hints, difficulty mix, achieved-vs-optimal gaps (R3), and the new
  `usedActions` heuristic (R4) — with `gave-up` removed.
- **R2.2** THE SYSTEM SHALL surface BOTH a **weakest** area (practice this) AND a
  **strongest** area (positive signal) — same computation, both ends.
- **R2.3** THE ranking SHALL keep the existing confidence gating (`lowConfidence`
  on thin pattern counts; the panel's Low/Medium/High label) and SHALL NOT promote
  a pattern to "weakest" on a trivially small sample without flagging it.
- **R2.4** THE "worth revisiting" list SHALL remain, re-based on the new scoring
  (not just `hintsUsed >= 2`); its reasons SHALL be honest and specific (e.g.
  "high hints", "may be suboptimal", "stale") — dropping the `gave-up` reason.
- **R2.5** Patterns come from the LLM (closed `ProblemPattern` vocabulary, no
  LeetCode-tag ground truth). Insights SHALL NOT imply the pattern labels are
  authoritative; the confidence framing covers this.

### R3 — "Correct but inefficient?" — achieved-vs-optimal, as a FLAG not a VERDICT

> ⚠️ **The sensitive one.** The free model (Flash-Lite) can call a solution
> "optimal" when a subtle improvement exists (amortized, constant-factor, a missed
> log factor). Presenting the model's optimality judgment as a measurement would
> violate the product's "the model owns judgments, the system owns facts"
> principle. This requirement is written to extract the value WITHOUT over-claiming.

- **R3.1** THE SYSTEM SHALL surface solutions that **may** not be at optimal
  complexity — as **candidates for the user to review**, never as a verdict that
  the user "is inefficient." Framing is tentative ("these may have room to
  improve — worth a second look"), never declarative.
- **R3.2** THE comparison SHALL use the **already-stored achieved complexity** vs.
  the **canonical B10 complexity pin** for the problem — NOT a fresh model
  re-judgment at insight time (consistency with what Analyze/Understand already
  established, and no new API calls).
- **R3.3** THE flag SHALL fire ONLY on an **unambiguous gap** — a difference of at
  least one full complexity class per `complexityRank` (e.g. achieved O(n²) vs.
  pinned O(n)). It SHALL NOT fire on borderline / same-class / constant-factor /
  amortized distinctions the free model is unreliable about (R3's whole point).
- **R3.4** WHERE no pin exists, or the achieved/optimal can't be compared
  confidently, the problem SHALL simply NOT be flagged (absence of a flag is not a
  claim of optimality — state this in the framing so a missing flag is never read
  as "this is optimal").
- **R3.5** THE honesty note SHALL be visible to the user (not just in code): the
  flag is based on the model's earlier complexity analysis, which can miss subtle
  optimizations — so it points at candidates to check, it doesn't grade them.

### R4 — The new signal: `usedActions`, projected into the record (heuristic)

- **R4.1** THE save path SHALL project the session's `usedActions`
  (`ProgressState.usedActions`, already tracked live) into the saved `Attempt` as a
  new field. This is the ONLY new data capture in this spec.
- **R4.2** `usedActions` SHALL be captured from the **already-tracked client-side
  session state at save time** — NOT by changing what `GENERATE_REPORT`'s model
  output emits, and NOT shown in the chat/report prose. The report's visible
  content is UNCHANGED (R6).
- **R4.3** `usedActions` SHALL feed the struggle/what-to-work-on scoring as a
  **soft heuristic nudge**, never a hard claim: reaching for more / deeper coaching
  tools on a problem is a weak signal of more struggle, but using a tool is not
  proof of struggle (the user may be curious). Design sets the (small) weight and
  documents it as tunable, like the existing `computeStruggleScore` weights.
- **R4.4** THE data-model change SHALL bump `PROBLEM_RECORD_SCHEMA_VERSION` and
  extend `migrate()` so older records (without `usedActions`) read cleanly with a
  sensible default (treat as "unknown / none recorded", NOT as a struggle signal).
- **R4.5** `usedActions` SHALL remain invisible to the user on the surface unless
  design finds a genuinely useful honest presentation (e.g. in the detail view);
  by default it is an internal scoring input.

### R4b — Export / import MUST round-trip the new field (no silent data loss)

> 🚨 **Critical, easy-to-miss.** Verified in `src/services/progress-io.ts`: export
> is a whole-object serialize (so a new field is written to the JSON
> automatically), BUT import follows a **"reconstruct, don't validate-in-place"
> allowlist** — `sanitizeAttempt` / `sanitizeRecord` build a FRESH object copying
> ONLY explicitly-known fields through sanitizers. **Any field not added to the
> sanitizer is silently dropped on import.** So without this requirement,
> `usedActions` would export fine but vanish on re-import, leaving a user's
> dashboard subtly WRONG after a round-trip, with no error. (The project already
> has bug B20 for a past import data-loss issue — this class of bug is a known
> sensitivity here.)

- **R4b.1** THE import reconstructor (`sanitizeAttempt` and/or `sanitizeRecord` in
  `progress-io.ts`) SHALL be extended to copy + sanitize the new `usedActions`
  field, so an exported record round-trips with the field intact.
- **R4b.2** THE sanitizer SHALL apply a safe default when the field is ABSENT (an
  export from an older version, or a hand-edited file) — the SAME default as the
  storage-read migration (R4.4): "none / unknown", never treated as struggle.
- **R4b.3** THE `usedActions` value SHALL be sanitized like every other imported
  field (allowlist to the known `ActionType` vocabulary, bounded, no trusting the
  file's shape) — it is untrusted input into privileged storage like the rest.
- **R4b.4** THE import path and the storage-read path SHALL share ONE migration /
  defaulting rule for the new field so they cannot diverge (an old file imported
  and an old stored record read must end up identical).
- **R4b.5** Tests SHALL prove the round-trip: (a) a record with `usedActions`
  exports and re-imports with the field intact; (b) an OLD export WITHOUT the field
  imports cleanly with the default and is not mis-scored as struggle; (c) the
  existing export/import idempotency (export→import→export→import stable) still
  holds with the new field.

> **General rule for any future record field (document it):** a new persisted
> field has three mandatory touch-points, not one — (1) capture/projection, (2)
> the storage-read `migrate()`, and (3) the import sanitizer in `progress-io.ts`.
> Miss #3 and the field silently dies on a round-trip. Worth a note in the design
> so this doesn't recur for the next field someone adds.

### R5 — Dashboard / summary stats

- **R5.1** THE insights area SHALL include an at-a-glance summary: counts by
  difficulty, coverage across patterns, and an activity signal over time — built
  from the index/records already loaded.
- **R5.2** A **solved-optimally rate** (or equivalent correct-but-inefficient
  share) MAY be surfaced — but ONLY under the same tentative framing as R3 (it
  inherits R3's model-limitation caveat; it is a "based on the analysis" figure,
  not a graded score).
- **R5.3** THE dashboard SHALL be compact and fit the narrow side panel (layout
  constraint), and SHALL NOT bury the three core insights (R1–R3) under vanity
  metrics.

### R6 — The saved report prose is UNCHANGED (scope guard)

- **R6.1** THIS spec SHALL NOT change the visible content/prose of a
  `GENERATE_REPORT` response, nor its structured-output contract beyond what R4
  needs. The only save-time change is projecting the already-tracked `usedActions`
  into the record. (Rationale: changing the report's model output touches the
  guardrail-exempt structured-output path — a much larger blast radius — for no
  insight gain, since `usedActions` is already available client-side.)
- **R6.2** IF a future change to the report prose is wanted, it is a SEPARATE
  concern/spec, not folded in here.

### R7 — Honest framing (cross-cutting, non-negotiable)

- **R7.1** Every insight SHALL state or clearly imply what it's based on, so the
  user can calibrate trust (keep + extend the existing confidence badge).
- **R7.2** No insight SHALL present an inferred or model-judged signal as a
  verified measurement. The governing split stands: **the model owns judgments
  (optimality, patterns); the system owns facts (counts, dates, hints used,
  achieved-vs-pinned class gaps).**
- **R7.3** Where data is thin, the honest answer is "not enough data yet," shown
  plainly — never a fabricated trend or ranking.

### R7b — Export/import fidelity of the dashboard as a whole

> Clarifies what "the dashboard looks the same after export→import" means, so the
> design holds the right bar.

- **R7b.1** Insights are COMPUTED from records (`computeInsights` runs over loaded
  records), so any DERIVED insight (trend, weakest/strongest, achieved-vs-optimal
  flag, dashboard counts) SHALL regenerate identically after a round-trip **as long
  as the underlying stored fields round-trip** (R4b). The design SHALL ensure no
  insight depends on a stored field the importer drops.
- **R7b.2** Time-RELATIVE insights (e.g. a "recent vs. earlier" trend, a
  stale-since-N-days flag) MAY legitimately differ after an import that happens
  later in wall-clock time — that is CORRECT behavior (the data is the same; "now"
  moved), NOT a round-trip bug. The design SHALL NOT try to freeze wall-clock-
  relative views, but SHALL make sure they degrade honestly (R1.2/R7.3) rather
  than showing a misleading jump.
- **R7b.3** THE acceptance bar: export a dashboard, re-import into a clean install,
  and every insight that is a pure function of the stored records SHALL match;
  only wall-clock-relative framing may shift. A test or a documented manual check
  SHALL cover this.

### R8 — No regressions / testability

- **R8.1** THE detail view, list, export/import, save/delete, and the quick-wins
  search/filter/sort (sibling spec) SHALL keep working.
- **R8.2** `computeInsights` and every new scoring/trend/flag helper SHALL stay
  **pure + deterministic** and be unit-tested DOM-free (`env=node`), including:
  the reworked struggle score, the trend computation (incl. the thin-data "no
  trend" case), the achieved-vs-optimal flag (fires on a ≥1-class gap, does NOT
  fire on same-class / no-pin), and the `usedActions` projection + migration.
- **R8.3** THE schema migration (R4.4) SHALL have a test proving an old record
  (no `usedActions`) migrates cleanly and is not mis-scored as struggle.

---

## Out of scope (so docs don't overstate)

- **Submission verification / Phase D** — verified solved/failed outcomes. Deferred
  project-wide; insights here stay on inferred-but-honest data.
- **Re-judging optimality at insight time** — explicitly rejected (R3.2): we reuse
  the stored pin, we do not spend API calls or trust a fresh model call to grade
  optimality. The free model's optimality limits are the reason (user's concern).
- **`gave-up`** — dropped from scoring entirely.
- **Changing the `GENERATE_REPORT` prose** — scope-guarded out (R6).
- **Time-spent / duration capture** — considered, NOT included (noisy; not needed
  for the three questions).
- **Search / LeetCode link / filter+sort** — sibling spec `leetsage-progress-quick-wins`.
- **The "optimize-nudge" action** — separate idea stub (`leetsage-optimize-nudge/`).

## Notes for the design/tasks session (deep read first)

- Read `src/services/progress-analytics.ts` (`computeInsights`,
  `computeStruggleScore`, `bestAttempt`, `complexityRank` usage), `src/types/models.ts`
  (`ProblemRecord`, `Attempt`, `AttemptOutcome`, `ProblemPattern`),
  `src/services/session-digest.ts` (`buildRecordProjection` / `extractSessionFacts`
  — where the `Attempt` is assembled at save time; this is where `usedActions`
  gets projected in), `src/services/progress-records.ts` (`saveAttempt`, `migrate`,
  `computeBestAttemptIndex`, `shouldReplaceLatest`), `src/services/complexity-pin.ts`
  (the canonical optimal source for R3), and `src/components/ProgressView.tsx`
  (`InsightsPanel` + the save call-site in `App.tsx handleSaveToProgress`).
- Confirm HOW `usedActions` flows: `ProgressState.usedActions: Set<ActionType>` is
  live per session — trace it to the save handler and decide the serialized shape
  on `Attempt` (a Set isn't JSON-serializable; store an array or a small count/map).
- For R3: confirm the pin's availability at save time and whether the achieved
  complexity + pin are both reliably present per record; design the ≥1-class-gap
  test against `complexityRank`.
- Decide the trend window (R1) and the (small, documented) `usedActions` weight (R4).
- Keep every new computation pure and unit-tested DOM-free (the repo has no jsdom).
- Write tasks only AFTER the deep read.
