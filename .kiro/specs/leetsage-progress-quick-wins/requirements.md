# Progress Screen Quick Wins — Requirements

> **Requirements phase only.** Per the standing workflow, this session writes
> requirements; **design + tasks + the deep code read are for a dedicated build
> session** (see the session handoff). Per `.kiro/steering/workflow.md`, that
> session writes tasks AFTER design + a deep read, pauses between phases, builds
> with `npm.cmd run build`, and **explains + STOPs for review before committing.**
>
> **Scope of THIS spec:** the small, well-understood UI improvements to the "My
> Progress" screen — a problem search box, a direct LeetCode link per problem, and
> list filter/sort controls. The big insights/analytics overhaul is the SIBLING
> spec **`leetsage-progress-insights-overhaul`** (written next); these two were
> split by the user so the easy value ships fast while insights gets the room it
> needs.

**Status:** 📝 Requirements draft — awaiting sign-off. Nothing built.
**Date:** 2026-10-20.
**Motivation:** the progress screen has grown to ~29+ tracked problems; at that
size, a flat recency-sorted list with no search/filter is hard to navigate, and
there's no quick way to jump back to the actual LeetCode problem.

---

## Background (verified against `main`)

Confirmed in `src/components/ProgressView.tsx` and `src/types/models.ts`:
- The list renders `ProblemIndexEntry[]` sorted by `lastUpdatedAt` desc (a FIXED
  recency sort set in the loading `useEffect`). There is **no search, no sort
  control, and no filter UI** anywhere on the screen.
- Each list row shows: title, difficulty (color-coded), pattern chips, "Updated
  {timeAgo}", "View →". Clicking a row opens the in-panel detail view.
- `ProblemIndexEntry` already carries `slug, url, title, difficulty, patterns,
  attemptCount, lastUpdatedAt` — so **search, sort, and filter can all be driven
  by the index alone** (no need to load full records).
- The problem's `url` (normalized `/problems/{slug}/`) **is already stored** on
  every record and index entry — it is simply never rendered as a link today.

So all three features here are achievable from data that already exists; this is
UI work, not a data-model change.

---

## Requirements

### R1 — Search the problem list

- **R1.1** THE progress list SHALL have a search box at the top that filters the
  visible problems as the user types.
- **R1.2** Search SHALL match against the problem **title** (case-insensitive,
  substring). (Design may additionally match the slug and/or pattern names — a
  design decision; title match is the required baseline.)
- **R1.3** Search SHALL filter the already-loaded index client-side (no new data
  load, no network); results update live as the user types.
- **R1.4** WHEN a search yields no matches, THE SYSTEM SHALL show a clear "no
  problems match" empty state rather than a blank area.
- **R1.5** Search SHALL compose with the filters/sort (R3): the visible set is the
  index after search AND filters are applied, in the chosen sort order.
- **R1.6** Search state SHALL NOT persist across sessions (it resets on reopen);
  it is a transient navigation aid, not a saved preference. (Design may revisit,
  but default is transient.)

### R2 — Direct LeetCode link per problem

- **R2.1** Each problem SHALL expose a way to open its LeetCode page directly
  (using the stored `url`), opening in a **new tab** (`target="_blank"` +
  `rel="noopener noreferrer"`).
- **R2.2** The link SHALL be present in the **detail view** (R2.2a) and SHOULD be
  available from the **list row** (R2.2b) — design decides the exact affordance
  (e.g. a small ↗ icon) so a list-row link does NOT hijack the existing
  row-click-opens-detail behavior.
- **R2.3** THE link SHALL use the record's stored normalized `url`; it SHALL NOT
  reconstruct a URL from the slug (the stored url is the source of truth).
- **R2.4** IF a record somehow has no/empty `url` (older/imported records), the
  link affordance SHALL be hidden for that record rather than rendering a broken
  link.

### R3 — Filter & sort the list

- **R3.1** THE list SHALL offer a **sort** control with at least: most recently
  updated (current default), difficulty, and title (A–Z). (Design may add
  "oldest" / "most attempts.")
- **R3.2** THE list SHALL offer **filter** controls for at least **difficulty**
  (Easy / Medium / Hard) and **pattern** (the `ProblemPattern` vocabulary present
  in the user's records). Multiple filters compose (AND across categories).
- **R3.3** Filters SHALL be driven off the `ProblemIndexEntry` fields already in
  memory (difficulty, patterns) — no record load, no network.
- **R3.4** THE active filter/sort state SHALL be clearly visible (the user can see
  what's applied) and easily cleared (a "clear"/"reset" affordance).
- **R3.5** Sort + filter + search (R1) SHALL compose predictably: filter and
  search narrow the set; sort orders the result.
- **R3.6** THE filter/sort UI SHALL be compact — this is a narrow side panel, so
  controls must fit without crowding the list (design constraint, not decoration).
- **R3.7** Default state (no search, no filter, recency sort) SHALL match today's
  behavior exactly, so nothing regresses for a user who ignores the new controls.

### R4 — No regressions / constraints

- **R4.1** THE detail view, insights panel, export/import toolbar, and record
  save/delete SHALL continue to work unchanged.
- **R4.2** All three features SHALL work from the in-memory index/records already
  loaded; NO new permissions, NO network calls, NO new storage.
- **R4.3** Each feature SHALL have a test where the logic is testable as a pure
  function (the project's DOM-free vitest env): the search/filter/sort predicate
  and comparator SHALL be extracted as pure functions and unit-tested (empty
  query, no matches, composed filter+search+sort, missing-url hidden link).
- **R4.4** THE new controls SHALL respect the existing dark/light theme and the
  narrow-panel layout.

---

## Out of scope (so docs don't overstate)

- **The insights / analytics overhaul** — the three insight questions
  (improving / what-to-work-on / correct-but-inefficient), the dashboard summary
  stats, strongest-vs-weakest, achieved-vs-optimal, the `usedActions` heuristic,
  and the data-model change — all in the SIBLING spec
  `leetsage-progress-insights-overhaul`.
- **Any data-model / schema change.** This spec is read-only over existing data.
- **Submission verification / Phase D** — explicitly deferred project-wide.
- **The future "optimize-nudge" action** — captured separately in
  `leetsage-optimize-nudge/` (idea only, not scheduled).

## Notes for the design/tasks session (deep read first)

- Read `src/components/ProgressView.tsx` in full — the list render (~line 436),
  the loading `useEffect` that sorts by `lastUpdatedAt`, `PatternChips`, the
  detail view (`RecordDetail`), and the toolbar — to find the cleanest seam to add
  the controls without disturbing the detail/insights/export paths.
- `ProblemIndexEntry` (`src/types/models.ts`) is the data source for list/search/
  filter/sort — confirm every field the controls need is on it (it is: title,
  difficulty, patterns, url, lastUpdatedAt, attemptCount).
- Extract the search/filter/sort as PURE functions (e.g. a
  `filterSortProblems(entries, { query, difficulty, patterns, sort })`) so they're
  unit-testable under `env=node` (the repo has no jsdom — see how
  `discovery-prompts`/`chatPlaceholder` were tested DOM-free).
- The LeetCode link in a list row must not swallow the row's open-detail click —
  mind the click target (a nested `<a>` with `stopPropagation`, or an icon outside
  the row button).
- Write tasks only AFTER the deep read.
