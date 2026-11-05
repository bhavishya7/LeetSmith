# Progress Insights Overhaul — Tasks

> **Tasks phase.** Written **after** the deep code read + signed-off `design.md`.
> Ordered so each task is independently buildable + testable, data-model first
> (the three touch-points) → pure analytics → UI → round-trip verification.
> Every new computation is **pure + deterministic**, unit-tested **DOM-free**
> (`env=node`). Build with `npm.cmd run build`, test with `npm.cmd run test`.
>
> **Status:** 📋 Tasks draft — awaiting sign-off. Nothing built.
> **Date:** 2026-11-01. **Branch:** `feature/progress-insights-overhaul`.
> **Baseline:** build clean, 573 tests / 33 files green.
>
> **HARD GATE:** after implementation + build + tests, **EXPLAIN and STOP for the
> user to eyeball the reloaded extension** (R1–R5 are visual/UX). Do NOT commit or
> run the historian without the user triggering it.

---

## Phase 1 — Data model + the three touch-points (R4, R4b)

> The riskiest part: a new persisted field has THREE mandatory touch-points
> (projection, storage-read migrate, import sanitizer). Do them together so the
> field can never silently die on a round-trip (R4b / bug-class B20).

- [ ] **T1.1 — Extend `Attempt` + bump schema (R4.1, R4.4, R3.2).**
  In `src/types/models.ts`:
  - Add `usedActions?: ActionType[]` and `optimalComplexity?: Complexity` to `Attempt`
    (both optional; absence = "none/unknown", never struggle, never a flag).
  - Bump `PROBLEM_RECORD_SCHEMA_VERSION` `1 → 2`.
  - Add a comment documenting the **three touch-points rule** for any future field
    (projection → `migrate()` → import sanitizer).

- [ ] **T1.2 — Storage-read migration v1→v2 (R4.4).**
  In `src/services/progress-records.ts` `migrate()`: when `r.schemaVersion < 2`, map
  over `r.attempts` and default each attempt's `usedActions` to `[]` (leave
  `optimalComplexity` absent), then set `schemaVersion: 2`. Keep it ordered +
  idempotent (running on a v2 record is a no-op).

- [ ] **T1.3 — Project the new fields at save time (R4.1, R4.2, R3.2).**
  - `src/services/session-digest.ts`: extend `buildRecordProjection(...)` to accept
    `usedActions: ActionType[]` and `optimalComplexity: Complexity | null`, and write
    them onto the returned `Attempt` (omit `optimalComplexity` when null — do NOT
    fabricate `O(?)`).
  - `src/sidepanel/App.tsx` `handleSaveToProgress`: compute
    `Array.from(progress.usedActions)` and
    `(await getComplexityPin(slugFromUrl(problemContext.url)))?.optimal ?? null`
    (reuse the already-imported `getComplexityPin`), and pass both into
    `buildRecordProjection`. **No change to `GENERATE_REPORT` output/prose** (R6).

- [ ] **T1.4 — Import sanitizer: the missed touch-point (R4b.1, R4b.2, R4b.3).**
  In `src/services/progress-io.ts`:
  - Add an `ACTION_TYPES` allowlist constant (the 9 `ActionType` values; keep in sync
    with `models.ts`, like the existing `PATTERNS` list) + a pure
    `sanitizeUsedActions(raw): ActionType[]` (array-only, keep known strings, dedupe,
    bounded; anything else ⇒ `[]`).
  - Add `sanitizeComplexity(raw): Complexity | null` (object with non-empty
    `time`/`space`, each run through `neutralizeString(.., 100)`; else null) — reused
    for `optimalComplexity`.
  - Extend `sanitizeAttempt` to copy `usedActions` (always set, default `[]`) and set
    `optimalComplexity` **only when present + valid** (allowlist discipline; never
    spread the untrusted object).

- [ ] **T1.5 — Tests: projection, migration, convergence (R4.4, R4b.4, R8.3).**
  - `session-digest.test.ts`: `buildRecordProjection` writes `usedActions` +
    `optimalComplexity`; omits `optimalComplexity` when null.
  - `progress-records.test.ts`: a v1 record (attempts without the fields) migrates to
    v2 with `usedActions: []`, no `optimalComplexity`, schemaVersion 2; idempotent.
  - **Convergence (R4b.4):** assert the storage-read default and the import-sanitizer
    default produce an **identical** attempt for the same old (field-less) input — the
    "cannot diverge" guarantee.

**Build + test after Phase 1** (new fields compile; migration + sanitizer green).

---

## Phase 2 — Pure analytics: scoring, trend, flag, dashboard (R1, R2, R3, R5)

> All in `src/services/progress-analytics.ts`, all pure, all injected-`now` for
> time-relative bits. Extend `ProgressInsights` + `computeInsights`.

- [ ] **T2.1 — `isLikelySuboptimal` + `UNKNOWN_RANK` (R3.2, R3.3, R3.4).**
  Export `UNKNOWN_RANK = 3.5` (the existing `complexityRank` sentinel). Add pure
  `isLikelySuboptimal(achieved, optimal: Complexity | null): boolean`:
  null optimal ⇒ false; either side ranks to `UNKNOWN_RANK` ⇒ false;
  **TIME axis only**; fire iff `rank(achieved.time) - rank(optimal.time) >= 1`.

- [ ] **T2.2 — Rework `computeStruggleScore` (R2.1).**
  New inputs `{ avgHintsUsed, avgDifficultyWeight, suboptimalRate, avgToolDepth }`;
  weights `1.5 / 1.0 / 3.0 / 1.0` (documented + tunable); **remove `gaveUpRate`**.
  Update the existing struggle-score tests to the new signature.

- [ ] **T2.3 — Tool-depth from `usedActions` (R4.3).**
  Pure `toolDepth(usedActions: ActionType[]): number` in `[0,1]` — coarse, capped,
  based on **distinct non-hint coaching actions** (avoid double-counting hints, which
  already have their own term). Small by construction so it's a nudge, not a driver.

- [ ] **T2.4 — Extend per-pattern stats + strongest link (R2.2, R2.3).**
  In `computeInsights`, per pattern compute `suboptimalRate` (share of the pattern's
  problems whose **best attempt** trips `isLikelySuboptimal`) and `avgToolDepth`
  (mean `toolDepth` over best attempts); feed the reworked score. Add
  `strongestLink: PatternStat | null` = lowest-struggle **confident** pattern, set
  only when meaningfully lower than weakest and not all-low-confidence; else null.

- [ ] **T2.5 — Rework the revisit reasons (R2.4).**
  `RevisitItem.reason` → `'may-be-suboptimal' | 'high-hints' | 'stale'` (drop
  `'gave-up'`). Precedence per problem: `may-be-suboptimal` → `high-hints` → `stale`.
  `may-be-suboptimal` uses `isLikelySuboptimal` on the best attempt.

- [ ] **T2.6 — `computeTrend` (R1).**
  Pure `computeTrend(records, now): TrendInsight`. One datapoint per problem (best
  attempt), ordered by `firstSolvedAt` (fallback earliest attempt date); per-problem
  struggle value from the same signals; split earlier/recent halves; compare means.
  `TREND_MIN_PROBLEMS = 5`, `TREND_EPSILON` (documented). Output
  `{ direction: 'improving'|'flat'|'needs-work'|'insufficient', sampleSize,
  earlierMean, recentMean }`. **No percentages.** Order-relative (not wall-clock).

- [ ] **T2.7 — `efficiencyFlags` + `DashboardStats` (R3.1, R5.1).**
  `efficiencyFlags: EfficiencyFlag[]` ({slug,title,achieved,optimal}) — one per problem
  whose best attempt trips `isLikelySuboptimal`. `DashboardStats` (byDifficulty,
  patternCoverage, activeDays, lastActiveAt, reviewedCandidates = flags.length).
  Wire both into `ProgressInsights` + `computeInsights`.

- [ ] **T2.8 — Analytics tests (R8.2).**
  Reworked struggle (no gaveUp input; hints not dominant; a high-suboptimal pattern can
  outrank a high-hint one); `isLikelySuboptimal` (fires `O(n²)`vs`O(n)` + `O(n log n)`
  vs`O(n)`; NOT same-class / null optimal / unknown-notation either side); trend
  (improving/needs-work/flat/insufficient, deterministic `now`, order-relative);
  strongest-link selection + its null cases; revisit reasons + precedence; dashboard
  counts.

**Build + test after Phase 2** (analytics green; UI not yet wired).

---

## Phase 3 — UI: the four-block insights panel (R1–R5, R7)

> `src/components/ProgressView.tsx` `InsightsPanel`. Compact for the narrow panel
> (R5.3), dark/light safe, confidence framing kept (R7.1). No new logic — pure
> presentation of `ProgressInsights`. Layout per the signed-off mock.

- [ ] **T3.1 — Trend card (R1.1, R1.3).** ↗/→/↘ + qualitative phrase + the sample
  count; "not enough data yet" for `insufficient`; the one-line "practice signal, not a
  verified score" caveat. No percentages.

- [ ] **T3.2 — Weakest + Strongest (R2.2, R2.3).** Both ends with the confidence badge;
  strongest hidden when null. Keep the existing "based on N problems" framing but drop
  the hints-only parenthetical (ranking is multi-signal now).

- [ ] **T3.3 — Review candidates block (R3.1, R3.4, R3.5).** The `efficiencyFlags` list
  as **tentative "candidates to review"** (e.g. "Course Schedule — O(n²) vs O(n)"); the
  always-visible caveat incl. "a problem not listed isn't guaranteed optimal." Empty ⇒
  hide the block (don't imply "all optimal").

- [ ] **T3.4 — Dashboard strip (R5.1, R5.3).** Compact difficulty/pattern/activity row
  at the BOTTOM; `reviewedCandidates` phrased under the R3 caveat ("N worth a second
  look"), never "X% optimal".

- [ ] **T3.5 — Keep `INSIGHTS_MIN_PROBLEMS` gating + no-regression (R8.1).** Panel still
  hidden under the minimum; list/detail/export/import/save/delete + quick-wins
  search/filter/sort untouched.

**Build after Phase 3** (visual — the user eyeballs it at the STOP gate).

---

## Phase 4 — Round-trip + final verification (R4b.5, R7b, R8)

- [ ] **T4.1 — R4b round-trip tests (`progress-io.test.ts`).**
  (a) attempt with `usedActions` + `optimalComplexity` survives export→import intact;
  (b) an OLD export WITHOUT the fields imports cleanly (defaults `[]` / absent, not
  mis-scored, not flagged); (c) export→import→export→import idempotent with the new
  fields; untrusted `usedActions` (bad types, unknown strings, over-long) sanitizes to
  a safe allowlisted array.

- [ ] **T4.2 — R7b.3 acceptance test.** Build records → export → import into EMPTY
  storage → assert pure-function insights match (trend direction, weakest/strongest
  pattern, `efficiencyFlags` slugs, dashboard counts); only wall-clock-relative framing
  (the `stale` reason) may differ.

- [ ] **T4.3 — Full build + full test suite.** `npm.cmd run build` clean;
  `npm.cmd run test` all green (573 baseline + new). If the terminal garbles output,
  Tee to a temp file, read it, delete it.

- [ ] **T4.4 — EXPLAIN + STOP (hard gate).** Summarize what/why/how; list the visual
  blocks for the user to eyeball in the reloaded extension. **Do NOT commit, do NOT run
  the historian** until the user triggers it. Flip `.kiro/specs/README.md` status only
  when the user says so.

---

## Touch-point checklist (quick reference for review)
| New field | (1) projection | (2) migrate | (3) import sanitizer |
|---|---|---|---|
| `Attempt.usedActions` | T1.3 | T1.2 | T1.4 |
| `Attempt.optimalComplexity` | T1.3 | T1.2 (absent default) | T1.4 |
| `Attempt.chatCount` (option c) | session-digest + App | absent ⇒ 0 (no change needed) | `sanitizeCount` in sanitizeAttempt |
