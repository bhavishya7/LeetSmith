# Progress Insights Overhaul — Design

> **Design phase.** Requirements are signed off (`requirements.md`). This document
> is written **after a deep read** of the files listed in the requirements' "Notes
> for the design/tasks session" block. It decides the *how* for R1–R7b; `tasks.md`
> comes next (a separate phase, after sign-off on this design).
>
> **SUBSTANTIAL + guardrail-honesty-sensitive** → full trilogy. This design pauses
> for the user's sign-off before `tasks.md`.
>
> **Status:** 📐 Design draft — awaiting sign-off.
> **Date:** 2026-11-01. **Branch:** `feature/progress-insights-overhaul`.
> **Baseline protected:** build clean, 573 tests / 33 files green.

---

## 0. What the deep read established (the facts the design rests on)

Confirmed by reading `progress-analytics.ts`, `types/models.ts`,
`session-digest.ts`, `progress-records.ts`, `complexity-pin.ts`, `progress-io.ts`,
`ProgressView.tsx`, and `App.tsx handleSaveToProgress`:

1. **`usedActions` is a live `Set<ActionType>`** on `ProgressState`, populated in
   `background/index.ts` + `services/progress-tracker.ts` (`usedActions.add(actionType)`
   on every action), serialized to an **array** by `storage.ts` (`Array.from(...)`).
   It is already in scope at the save call-site (`App.tsx handleSaveToProgress`
   closes over `progress`). A `Set` is not JSON-serializable → the stored shape on
   `Attempt` must be an **array of `ActionType`**.

2. **🚨 The B10 complexity pin lives in a SEPARATE store** (`complexity_pin_{slug}`
   in `complexity-pin.ts`) that is **NOT part of the export envelope** (`progress-io.ts`
   exports only `records`). This is the single most important design fact for R3:
   > If the achieved-vs-optimal flag read the *pin* at insight time, the flag would
   > **vanish after an export→import into a clean install** (R7b.1/R7b.3 violation) —
   > the pins don't travel with the records.
   **Resolution:** project the pinned optimal onto the **`Attempt` itself at save
   time** (`Attempt.optimalComplexity`), so the comparison `achieved vs optimal` is a
   pure function of the **exported record data**. The pin stays the *source* of the
   value at capture time (R3.2 — reuse the stored pin, no fresh model call); the
   record is where it's *persisted* so it round-trips.

3. **Three mandatory touch-points for every new persisted field** (the general rule
   the requirements call out, verified in code):
   - **(1) capture/projection** — `buildRecordProjection` in `session-digest.ts`
     (assembles the `Attempt`), fed from `handleSaveToProgress`.
   - **(2) storage-read migration** — `migrate()` in `progress-records.ts`.
   - **(3) import sanitizer** — `sanitizeAttempt` in `progress-io.ts` (allowlist:
     "reconstruct, don't validate-in-place"). **Miss #3 ⇒ silent data loss on import.**

4. **`complexityRank(bigO: string): number`** already exists in `progress-records.ts`
   — a coarse 0–7 ordering of common Big-O classes (`O(1)`=0 … `O(n!)`=7; unknown →
   3.5 "middle, never a false best"). The R3 ≥1-class-gap test builds on this exact
   function (reused, not reinvented).

5. **`computeStruggleScore`** today = `avgHintsUsed*2 + max(0,avgAttempts-1)*1.5 +
   gaveUpRate*4 + avgDifficultyWeight*0.5`. Verified that `gaveUpRate` is always 0
   (no save path writes `gave-up`), `avgAttempts` is ~1 (de-dupe), so **hints
   dominate**. The rework removes `gaveUpRate`, adds achieved-vs-optimal + usedActions.

6. **`AttemptOutcome`** is still `'solved' | 'attempted' | 'gave-up'` and
   `OUTCOMES` in `progress-io.ts` still lists `'gave-up'` for *import* enum-checking.
   We **drop `gave-up` from SCORING** (R2) but **keep the type + importer enum**: an
   imported file may legitimately contain `gave-up` (the type is part of the stored
   contract), and removing it from the importer allowlist would silently rewrite old
   `gave-up` attempts to `attempted` — a data mutation we don't want. "Drop" means
   *stop scoring on it*, not *delete the enum*.

---

## 1. The three questions → the shapes we compute

Every new insight is a **pure function of `ProblemRecord[]`** (plus `Date.now()` for
time-relative views, injected so tests are deterministic). All live in
`progress-analytics.ts` alongside the existing `computeInsights`.

```
ProgressInsights (extended)
├── totalProblems, totalAttempts           (existing)
├── byPattern: PatternStat[]               (existing shape, reworked score)
├── weakestLink: PatternStat | null        (existing)
├── strongestLink: PatternStat | null      (NEW — R2.2)
├── revisit: RevisitItem[]                 (existing shape, reworked reasons)
├── trend: TrendInsight                    (NEW — R1)
├── efficiencyFlags: EfficiencyFlag[]      (NEW — R3)
└── dashboard: DashboardStats              (NEW — R5)
```

---

## 2. R1 — "Am I improving?" (trend over the stored timeline)

### 2.1 What we have to work with
Per-attempt facts that are honest and already stored: `Attempt.date`,
`Attempt.hintsUsed`, `Attempt.outcome`, `Attempt.complexity`, plus (new, R4)
`Attempt.optimalComplexity` and `Attempt.usedActions`. We do **not** have verified
solve/fail (Phase D) — so the trend is explicitly a signal from inferred data (R1.3).

### 2.2 The window (R1.2 — decision)
A **recent-vs-earlier split over a per-problem struggle signal**, not a time-bucketed
chart (a chart doesn't fit the narrow panel and implies more precision than we have).

- **One datapoint per PROBLEM** (its best attempt), ordered by `firstSolvedAt`
  (falling back to the earliest attempt date). Per-problem, not per-attempt, because
  the de-dupe logic (`shouldReplaceLatest`) makes per-attempt noisy and a "problem"
  is the honest unit of practice.
- Compute a **per-problem struggle value** = the same signal the reworked
  `computeStruggleScore` uses, evaluated for that one problem (hints + difficulty +
  achieved-vs-optimal + usedActions). Lower = did better.
- Split the ordered list into **earlier half** and **recent half**. Compare the mean
  struggle of each half.
- **Thresholds (documented, tunable):** require **at least `TREND_MIN_PROBLEMS = 5`**
  problems (~2–3 per half) before claiming any trend. Below that → `direction: 'insufficient'`
  with the honest copy "not enough data yet" (R1.2/R7.3). A change smaller than
  `TREND_EPSILON` (a small fraction of the scale) → `direction: 'flat'` (no false
  "you improved").
- Output: `{ direction: 'improving' | 'flat' | 'needs-work' | 'insufficient',
  sampleSize, earlierMean, recentMean }`. **No percentages** (R1.3 — no false
  precision). The UI renders a qualitative phrase + a simple visual cue (e.g. ↗ / → /
  ↘ and the counts it's based on), never "+23%".

### 2.3 Honesty framing (R1.3)
The trend card carries a one-line caveat: based on hints, self-reported outcomes and
earlier complexity analysis — a practice signal, not a verified skill score.

### 2.4 Round-trip (R7b.2)
The "earlier vs recent" split is a pure function of the stored records → it
round-trips (R7b.1). It is **time-ORDERING-relative but not wall-clock-relative** (it
uses relative order, not "now"), so an import later in time does not shift it. (The
*stale* reason in revisit IS wall-clock-relative — see §4.3 — and that's allowed to
shift per R7b.2.)

---

## 3. R2 — "What should I work on next?" (reworked scoring, strongest + weakest)

### 3.1 The reworked `computeStruggleScore` (decision)
Replace the four inputs with signals that are actually live. New signature:

```ts
computeStruggleScore({
  avgHintsUsed,            // kept — real signal
  avgDifficultyWeight,     // kept, re-weighted up
  suboptimalRate,          // NEW (R3) — share of this pattern's problems flagged ≥1-class gap
  avgToolDepth,            // NEW (R4) — usedActions heuristic, normalized 0..1
}): number
```

Weights (documented + tunable, mirroring the existing "weights are a judgement call"
comment):

```
avgHintsUsed       * 1.5     // was *2 and dominant; demoted so it's one voice of several
avgDifficultyWeight* 1.0     // was *0.5; a Hard pattern is genuinely more struggle
suboptimalRate     * 3.0     // strong, honest signal: a real ≥1-class gap on stored data
avgToolDepth       * 1.0     // SOFT nudge (R4.3) — small, never dominant
```

- **`gaveUpRate` term removed entirely** (R2.1).
- `suboptimalRate` is the fraction of the pattern's problems whose best attempt is
  flagged by the R3 ≥1-class-gap test (pure, from stored fields).
- `avgToolDepth` is the mean over the pattern's problems of a **normalized
  tool-depth** derived from `Attempt.usedActions` (see §5.3). Small weight so curiosity
  ≠ struggle (R4.3).

### 3.2 Strongest + weakest (R2.2)
Same computation, both ends. `weakestLink` = highest struggle among confident patterns
(unchanged selection logic). `strongestLink` = **lowest** struggle among confident
patterns, and **only when it's meaningfully lower** than the weakest (don't call a
pattern "strong" when everything scores the same / there's only one pattern). Both
carry the existing `lowConfidence` gating (R2.3). When all patterns are low-confidence,
`strongestLink` is `null` (we won't hand out a "strength" badge on a trivial sample).

### 3.3 Revisit list, re-based (R2.4)
`RevisitItem.reason` becomes `'high-hints' | 'may-be-suboptimal' | 'stale'`
(**`'gave-up'` reason dropped** — R2.4). Precedence per problem (first match wins):
`may-be-suboptimal` → `high-hints` → `stale`. The "may be suboptimal" reason is the R3
flag (tentative framing in the UI, §4). Reasons stay honest + specific (R2.4).

### 3.4 Pattern-label honesty (R2.5)
Unchanged: patterns come from the closed LLM vocabulary; the confidence badge already
communicates "don't treat these as authoritative." No new claim added.

---

## 4. R3 — "Correct but inefficient?" — the sensitive one (a FLAG, never a verdict)

### 4.1 Data source (R3.2 + the round-trip fix)
As established in §0.2: compare **`Attempt.complexity` (achieved)** against
**`Attempt.optimalComplexity` (the pin value, projected onto the record at save
time)** — NOT a fresh model call, and NOT the live pin store (so it round-trips).

### 4.2 The ≥1-class-gap test (R3.3 — the whole point)
A pure helper in `progress-analytics.ts`:

```ts
// Fires ONLY on an unambiguous, at-least-one-full-class gap on the TIME axis.
export function isLikelySuboptimal(achieved: Complexity, optimal: Complexity | null): boolean {
  if (!optimal) return false;                          // R3.4 — no pin ⇒ no flag
  const a = complexityRank(achieved.time);
  const o = complexityRank(optimal.time);
  if (a === UNKNOWN_RANK || o === UNKNOWN_RANK) return false;  // 3.5 sentinel ⇒ can't compare ⇒ no flag
  return a - o >= 1;                                   // ≥ one full class worse
}
```

- Uses the existing `complexityRank` (§0.4). We add an exported `UNKNOWN_RANK = 3.5`
  constant (the existing sentinel) so "unknown/odd notation" on *either* side ⇒ **no
  flag** (R3.3/R3.4 — never fire on something we can't compare).
- **Time axis only.** Space-complexity gaps are noisier and less interview-meaningful;
  flagging on space would raise false positives. Documented as a deliberate scope
  choice.
- `>= 1` on the integer-ish ranks means `O(n²)` (4) vs `O(n)` (2) fires (gap 2);
  `O(n log n)` (3) vs `O(n)` (2) fires (gap 1 — a full class); same-class or
  constant-factor/amortized differences (same rank) do **not** fire (R3.3). Because
  the ranks are coarse, borderline distinctions the free model is unreliable about
  collapse to the same rank and are structurally excluded.

### 4.3 What the flag produces
```ts
interface EfficiencyFlag { slug; title; achieved: Complexity; optimal: Complexity; }
```
One per problem whose **best attempt** trips `isLikelySuboptimal`. Surfaced as
**"candidates to review"** (R3.1) — tentative copy, never "you are inefficient."

### 4.4 Honesty note, visible to the user (R3.5 + R3.4)
The R3 UI block carries a short, always-visible caveat, roughly:
> Based on the earlier complexity analysis for each problem (which the free model can
> get wrong on subtle optimizations). These are **candidates to double-check**, not a
> grade — and a problem **not** listed here isn't guaranteed optimal.

That second clause is R3.4 made visible: absence of a flag is not a claim of
optimality.

### 4.5 Why not re-judge at insight time (R3.2, locked)
Re-calling the model would (a) cost API calls, (b) reintroduce the exact B10 drift the
pin was built to kill, and (c) still be unverifiable. We reuse the already-established
value. Insight-time computation stays pure + offline.

---

## 5. R4 — the one new capture: `usedActions` projected into the `Attempt`

### 5.1 Stored shape (decision)
`Attempt.usedActions?: ActionType[]` — a plain array (Set isn't serializable, §0.1).
Optional in the type; **absence means "none/unknown recorded"** (never struggle). Also
add `Attempt.optimalComplexity?: Complexity` here (the R3 value from §4.1) in the same
schema bump — both are new persisted fields riding the same version increment.

### 5.2 Projection at save time (R4.1/R4.2)
In `handleSaveToProgress` (`App.tsx`):
- Read `progress.usedActions` (the live Set already in scope) → `Array.from(...)`.
- Read the pin: `(await getComplexityPin(slug))?.optimal ?? null` → the attempt's
  `optimalComplexity` (reuse the already-imported `getComplexityPin`).
- Pass both into `buildRecordProjection` (extend its signature) so the `Attempt`
  carries them. **No change to `GENERATE_REPORT`'s model output or prose** (R4.2/R6) —
  this is pure client-side projection of already-tracked state.

### 5.3 How it scores (R4.3 — soft nudge, documented weight)
`usedActions` → a normalized **tool-depth** in `[0,1]`:
- Map the *coaching-depth* actions to a small weight set. Reaching for deeper coaching
  (`UNDERSTAND_SOLUTION`, repeated `GET_HINT` via `hintsUsed` which we already score,
  `CHECK_APPROACH`) is a weak "this was harder" signal; using one tool is not proof.
- Keep it deliberately coarse + capped so it's a nudge, never a driver (weight 1.0 in
  §3.1, and the normalized value maxes at 1). Documented as tunable, like the other
  weights. We avoid double-counting hints (hints already have their own term) by
  basing tool-depth on the *distinct non-hint* coaching actions used.

### 5.4 Surface visibility (R4.5 — decision)
Default **invisible** — an internal scoring input. We will **not** add a new user-
facing "tools used" readout in v1 (no genuinely useful honest presentation that earns
panel space). It may inform the revisit reason indirectly (via the struggle score) but
is not shown as its own line. (If review wants it in the detail view, that's a trivial
add later.)

### 5.5 Migration (R4.4) — shared rule
Extend `migrate()` in `progress-records.ts`: bump
`PROBLEM_RECORD_SCHEMA_VERSION 1 → 2`; for any attempt lacking the new fields, default
`usedActions` to `[]` (⇒ tool-depth 0 ⇒ no struggle contribution) and leave
`optimalComplexity` absent (⇒ R3 flag can't fire ⇒ never a false "suboptimal"). The
migration walks `record.attempts` and fills defaults per attempt.

---

## 6. R4b — export/import MUST round-trip `usedActions` (+ `optimalComplexity`)

### 6.1 The shared defaulting rule (R4b.4 — one rule, two call-sites)
Factor the per-attempt field defaulting/sanitizing into **one pure helper** so the
storage-read migration and the import sanitizer **cannot diverge**:

```ts
// in a place both modules can import without a cycle — see §6.3
export function sanitizeUsedActions(raw: unknown): ActionType[];   // allowlist to ActionType, bounded, deduped
export function defaultAttemptFields(a): { usedActions: ActionType[]; optimalComplexity?: Complexity };
```

- `sanitizeUsedActions`: accept only an array; keep only strings in the known
  `ActionType` vocabulary; dedupe; cap length (there are only 9 action types, so cap
  at a small bound). Anything else ⇒ `[]` (R4b.2/R4b.3 — untrusted input, safe
  default).
- `optimalComplexity` on import: sanitize exactly like `Attempt.complexity` already is
  (`neutralizeString` on `.time`/`.space`, the same 100-char cap); **absent ⇒ omit**
  (do not fabricate `O(?)` — an absent optimal must mean "no flag," matching the
  migration).

### 6.2 Extend `sanitizeAttempt` (R4b.1) — the missed touch-point
`sanitizeAttempt` in `progress-io.ts` builds a fresh `Attempt` by explicit field copy.
Add:
```ts
attempt.usedActions = sanitizeUsedActions(readProp(o, 'usedActions'));
const opt = sanitizeComplexity(readProp(o, 'optimalComplexity'));  // only set if both fields present + non-empty
if (opt) attempt.optimalComplexity = opt;
```
Keeping the allowlist discipline: we copy ONLY these known fields through sanitizers;
nothing is spread.

### 6.3 Avoiding an import cycle (decision)
`progress-io.ts` already imports from `progress-records.ts` (`migrate`,
`computeBestAttemptIndex`). The `ActionType` vocabulary is a plain constant. Put the
`ACTION_TYPES` list + `sanitizeUsedActions` either in `progress-io.ts` (and have the
`migrate()` default reference a tiny local default, with a shared test asserting
equivalence) **or** in a small shared module. **Decision:** keep the canonical
`ACTION_TYPES` allowlist + `sanitizeUsedActions` in `progress-io.ts` (the security
boundary), and have `migrate()`'s default be the trivial `[]` (which is the same result
`sanitizeUsedActions` yields for a missing field) — then a **test asserts both paths
produce identical output for an old attempt** (R4b.4/R4b.5), pinning the "cannot
diverge" guarantee without creating a new cross-module dependency from
`progress-records` → `progress-io` (which would be the wrong direction / a cycle).

### 6.4 Round-trip tests (R4b.5)
- (a) a record whose attempt has `usedActions` + `optimalComplexity` →
  `serializeProgressExport` → `parseImport` → fields intact.
- (b) an OLD export (attempt **without** the fields) imports cleanly: `usedActions`
  defaults to `[]`, `optimalComplexity` absent, and the problem is **not** flagged
  suboptimal and **not** scored as struggle.
- (c) idempotency: export→import→export→import stable with the new fields.

---

## 7. R5 — compact dashboard / summary stats

`DashboardStats` (pure, from the loaded records/index):
```ts
interface DashboardStats {
  byDifficulty: { Easy: number; Medium: number; Hard: number };   // problem counts
  patternCoverage: number;         // distinct patterns touched (of the vocabulary)
  activeDays: number;              // distinct calendar days with an attempt (activity)
  lastActiveAt: number;            // most recent attempt date (for "last active N ago")
  reviewedCandidates: number;      // = efficiencyFlags.length (inherits R3 framing)
}
```
- **Compact** (R5.3): a small stat strip (difficulty mix, patterns covered, activity),
  rendered **below** the three core insight blocks (trend, weakest/strongest, review
  candidates) so it never buries them.
- The `reviewedCandidates` count is shown **only under the R3 caveat** (R5.2) — it is
  "based on the analysis," not a graded "solved-optimally rate." We deliberately phrase
  it as "N worth a second look," not "X% optimal."

---

## 8. R6 — report prose unchanged (scope guard)

No change to `GENERATE_REPORT` prompt, prose, or its `ReportData` contract. The only
save-time change is projecting the already-tracked `usedActions` + reading the existing
pin — both client-side, neither touches the guardrail-exempt structured-output path
(R6.1). Any future prose change is a separate spec (R6.2).

---

## 9. R7 / R7b — honest framing + round-trip fidelity (cross-cutting)

- **The split holds** (R7.2): *system owns facts* (counts, dates, hints, the
  achieved-vs-pinned **class gap** which is arithmetic on stored strings); *model owns
  judgments* (the pin value itself, the pattern labels). Every card states what it's
  based on (R7.1); thin data says "not enough data yet" (R7.3).
- **Round-trip (R7b):** because R3 now reads `Attempt.optimalComplexity` from the
  **record** (not the un-exported pin), every derived insight — trend, weakest/
  strongest, efficiency flags, dashboard counts — is a pure function of exported fields
  and regenerates identically after import (R7b.1/R7b.3), **provided** R4b lands (the
  fields round-trip). The **only** legitimately-shifting view is the wall-clock-
  relative `stale` revisit reason (R7b.2) — that's correct, not a bug.
- **Acceptance check (R7b.3):** a test (or documented manual check) exports a set,
  re-imports into empty storage, and asserts the pure-function insights match (trend
  direction, weakest/strongest pattern, efficiency flag slugs, dashboard counts),
  tolerating only wall-clock-relative framing.

---

## 10. Files touched (plan)

| File | Change |
|---|---|
| `src/types/models.ts` | `Attempt.usedActions?: ActionType[]`, `Attempt.optimalComplexity?: Complexity`; bump `PROBLEM_RECORD_SCHEMA_VERSION 1→2`; comment the 3 touch-points rule. |
| `src/services/session-digest.ts` | `buildRecordProjection` gains `usedActions` + `optimalComplexity` params; projects them onto the `Attempt`. |
| `src/sidepanel/App.tsx` | `handleSaveToProgress`: `Array.from(progress.usedActions)` + `getComplexityPin(slug)?.optimal`, pass both into the projection. |
| `src/services/progress-records.ts` | `migrate()` v1→v2 per-attempt default (`usedActions: []`, `optimalComplexity` absent). |
| `src/services/progress-io.ts` | `ACTION_TYPES` allowlist + `sanitizeUsedActions` + `sanitizeComplexity`; extend `sanitizeAttempt`; (export serializes new fields automatically). |
| `src/services/progress-analytics.ts` | reworked `computeStruggleScore`; `isLikelySuboptimal` + `UNKNOWN_RANK`; `computeTrend`; `strongestLink`; reworked revisit reasons; `DashboardStats`; extend `ProgressInsights` + `computeInsights`. |
| `src/components/ProgressView.tsx` | `InsightsPanel` extended: trend card, weakest **and** strongest, "may be suboptimal" candidates block with the visible caveat, compact dashboard strip — all compact, dark/light safe, confidence framing kept. |
| tests | new/updated unit tests per R8 (all DOM-free `env=node`). |

## 10b. Review decisions (locked with the user, 2026-11-01)
- **`usedActions` visibility:** Option **A — invisible**. It is a scoring ingredient
  behind the weakest/strongest ranking + revisit reasons only; **no new user-facing
  line** (not in the insights panel, not in the detail view). (R4.5.)
- **R3 flag axis:** **TIME axis only.** Space-complexity gaps are typically deliberate
  time/space trade-offs and the free model is noisier about space; flagging space would
  raise false "suboptimal" alarms. (R3.3.)
- **Trend threshold:** `TREND_MIN_PROBLEMS = 5`.

### Richer heuristic + badge removal (option (c), after review, 2026-11-01)
Review pushed on "are we still just relying on hints?" — correctly. The answer is no
(struggle was already 4 signals), but the user asked to make the non-hint signals
first-class. Landed as option (c):
- **Positive, objective copy only.** All "can't verify / not a / isn't guaranteed"
  phrasing removed from the surface (tooltips + the R3 title "Correct but maybe
  inefficient?" → "Room to optimize"). The honesty MECHANISM stays in the code/design
  (the flag still only fires on an unambiguous ≥1-class gap; thin data still says "not
  enough data yet") — we just stopped advertising limitations to the user (user's call).
- **Confidence badge REMOVED.** The standalone "Medium confidence" header badge was
  unclear out of context. The `lowConfidence` gate still governs WHETHER weakest/
  strongest surface (R2.3) — only the badge UI is gone.
- **Third new stored field: `Attempt.chatCount`** — the count of free-form chat
  questions that session (the same `isUserQuery` count the digest uses). Same THREE
  touch-points + round-trip + convergence as the other two fields (projection in
  session-digest/App, absent-default on read, `sanitizeCount` in the importer, tests).
- **Tiered tool weights.** `toolDepth` is no longer flat-count/3. Each distinct
  coaching tool carries a depth weight, summed, capped at 2.0, normalized to [0,1].
  **Ordering principle (revised after review): weight by how strongly the tool implies
  the user was STUCK, not by how "advanced" the tool is.** The key insight from review:
  analyzing code or checking its Big-O is frequently a *confidence / verification*
  behavior (a correct solver sanity-checking what they wrote), NOT a struggle signal —
  so those rank LOW even though they're "advanced" tools. Asking for the problem to be
  decomposed, or the pattern named, is a genuine "I don't know how to approach this"
  tell — so those rank HIGH. Final weights:
  `UNDERSTAND_SOLUTION` 1.0 (asked for the full solution — clearest stuck tell) ·
  `BREAK_DOWN_PROBLEM` 0.7 (can't start/decompose) ·
  `PATTERN_RECOGNITION` 0.6 (can't see the technique) ·
  `CHECK_APPROACH` 0.4 (often verifying correct code) ·
  `TIME_COMPLEXITY_HINT` 0.4 (often just checking Big-O) ·
  `GENERATE_EXAMPLES`/`EXPLAIN_CONCEPT` 0.3 (mild/exploratory);
  `GET_HINT`/`GENERATE_REPORT` excluded. These are heuristic judgement calls (no ground
  truth), documented as tunable.
- **New struggle weighting (documented + tunable):**
  `hints×1.5 + difficulty×1.0 + suboptimalRate×3.0 + toolDepth×1.5 + chatLoad×1.0`,
  where `chatLoad = min(chatCount,4)/4`. Hints are now demonstrably just one of five
  voices (a test proves tool-depth + chat + a gap outweigh pure hints).

### UI polish pass (after the first visual review, 2026-11-01)
A build-then-eyeball round surfaced real UX issues; fixed as presentation-only changes
(no logic/scope change):
- **Type scale + contrast:** card titles bumped to ~13px semibold, neutral-800/100
  (were ~11px neutral-400 and hard to read); insight values larger; the "📊 Insights"
  header to 15px bold.
- **Trend verdict is plain language + an explanatory subline**, not a bare arrow. A
  HEADLINE answers the question ("You're improving / About the same / Getting tougher /
  Not enough data yet"), and a one-line "because…" subline says what we mean in human
  terms (e.g. "You're reaching for fewer hints and hitting better complexity than when
  you started"). The emoji is a mere accent. This came from review feedback that a lone
  "Holding steady" + arrow wasn't immediately interpretable.
- **Honesty caveats → ⓘ click POPOVER** on each card title (the `InfoHint` affordance).
  A second review found the native `title` tooltip unreliable (hover-only, suppressed on
  some setups — showed nothing), so `InfoHint` is now a real click-to-toggle inline
  popover (keyboard-accessible, closes on outside-click/Escape). R7 is still satisfied —
  the caveat text is one click away — without cluttering the panel.
- **Trend sparkline: BUILT then REMOVED (documented reversal).** A first attempt added a
  12-bar per-problem "struggle" sparkline. Review correctly flagged it as decoration: the
  y-axis would be an invented, unitless composite (hints + difficulty + efficiency + tool
  depth), so labeling an axis or adding per-bar hovers would CLAIM precision we don't
  have — the exact honesty trap design §2.2 / R1.3 warns against. Dropped entirely
  (`TrendInsight.series` / `TREND_SPARK_MAX` reverted); the plain-language headline +
  subline carry the trend honestly instead. A true line chart stays rejected for the same
  reason.

## 11. Out of scope (reaffirmed)
Submission verification / Phase D; re-judging optimality at insight time; `gave-up`
*scoring* (the enum stays for import fidelity); report-prose changes; time-spent
capture; search/filter/sort (sibling spec); the optimize-nudge action.

## 12. Test plan (R8 — all pure / DOM-free)
1. **Reworked struggle score** — rises with hints/difficulty/suboptimalRate/toolDepth;
   `gaveUpRate` no longer an input; hints no longer dominant (a high-suboptimal pattern
   can outrank a high-hint one).
2. **Trend** — improving / needs-work / flat / **insufficient** ("no trend" under
   `TREND_MIN_PROBLEMS = 5`); deterministic with injected `now`; order-relative (stable
   across a later import).
3. **`isLikelySuboptimal`** — fires on `O(n²)` vs `O(n)` and `O(n log n)` vs `O(n)`
   (≥1 class); does **NOT** fire on same-class, on no pin (null optimal), or on
   unknown-notation either side.
4. **`usedActions` projection** — `buildRecordProjection` writes the array;
   tool-depth normalizes + contributes only a small nudge.
5. **Schema migration v1→v2** — an old record (no new fields) migrates cleanly:
   `usedActions: []`, no `optimalComplexity`, not mis-scored as struggle, not flagged.
6. **R4b round-trip** — (a) field intact through export→import; (b) old-export-without-
   the-field defaults safely + not mis-scored/flagged; (c) idempotency stable.
7. **R4b.4 convergence** — the storage-read default and the import default produce an
   identical attempt for the same old input.
8. **R7b.3** — export→import-into-empty ⇒ pure-function insights match (trend dir,
   weakest/strongest, flag slugs, dashboard counts).
