/**
 * Core data models for LeetSmith AI Learning Assistant
 */

export interface ProblemContext {
  title: string;
  url: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  description: string;
  examples: Example[];
  constraints: string[];
  testCases: TestCase[];
  extractedAt: number;
}

export interface Example {
  input: string;
  output: string;
  explanation?: string;
}

export interface TestCase {
  input: string;
  expectedOutput: string;
}

export type ActionType =
  | 'GET_HINT'
  | 'GENERATE_EXAMPLES'
  | 'BREAK_DOWN_PROBLEM'
  | 'EXPLAIN_CONCEPT'
  | 'CHECK_APPROACH'
  | 'TIME_COMPLEXITY_HINT'
  | 'PATTERN_RECOGNITION'
  | 'UNDERSTAND_SOLUTION'
  | 'GENERATE_REPORT';

export type ContentType =
  | 'HINT'
  | 'EXAMPLES'
  | 'BREAKDOWN'
  | 'EXPLANATION'
  | 'FEEDBACK'
  | 'CHAT_MESSAGE';

export interface LearningContent {
  id: string;
  type: ContentType;
  actionType: ActionType;
  content: string;
  timestamp: number;
  expanded: boolean;
  metadata?: ContentMetadata;
}

export interface ContentMetadata {
  hintLevel?: number;
  exampleComplexity?: 'Simple' | 'Medium' | 'Tricky';
  subProblems?: SubProblem[];
  /** True when this entry is the user's own free-form question (chat bubble). */
  isUserQuery?: boolean;
  /**
   * The machine-readable `data` block extracted from a structured action's
   * response (see StructuredResponse). Only present for actions that emit one
   * (currently CHECK_APPROACH → AnalyzeData, UNDERSTAND_SOLUTION →
   * UnderstandData). Downstream consumers — the report digest, progress
   * records, analytics, evals — read THIS, never the prose. Absent when the
   * model returned no/invalid data block (prose-only fallback).
   */
  structured?: StructuredData;
  /**
   * True once this report card has been saved to My Progress. Lives on the
   * card's metadata (not ephemeral UI state) so the "✓ Saved" state PERSISTS
   * with the session — when contentHistory is restored after navigating away,
   * the saved state comes back with it instead of resetting. Only meaningful on
   * GENERATE_REPORT cards.
   */
  savedToProgress?: boolean;
}

/**
 * Structured-output contract (see .kiro/specs/leetsage-structured-output).
 *
 * Each structured action returns BOTH a human-readable `prose` rendering and a
 * small, schema-conforming `data` object. The prose is what the user reads
 * (unchanged UX); the `data` is the single source of truth other code consumes
 * instead of re-parsing prose. The `data` block is authoritative — prose must
 * match it, not the other way around.
 */
export interface StructuredResponse<T> {
  /** The Markdown the user sees, rendered as today. */
  prose: string;
  /** Machine-readable facts for the report / records / analytics / evals. */
  data: T;
}

/** Time + space complexity as plain-text Big-O strings, e.g. "O(N)"/"O(1)". */
export interface Complexity {
  time: string;
  space: string;
}

/**
 * Fixed algorithmic-pattern vocabulary. A closed set keeps analytics and
 * "weakest link" grouping reliable (free-text pattern names don't group). Kept
 * in sync with the progress-tracking design; extend deliberately, not ad hoc.
 */
export type ProblemPattern =
  | 'Hash Map'
  | 'Two Pointers'
  | 'Sliding Window'
  | 'Binary Search'
  | 'BFS'
  | 'DFS'
  | 'Backtracking'
  | 'Dynamic Programming'
  | 'Greedy'
  | 'Stack'
  | 'Queue'
  | 'Heap'
  | 'Linked List'
  | 'Tree'
  | 'Graph'
  | 'Sorting'
  | 'Prefix Sum'
  | 'Bit Manipulation'
  | 'Math'
  | 'Recursion'
  | 'Union Find'
  | 'Trie'
  | 'Other';

/** Structured `data` for CHECK_APPROACH (Analyze my code). */
export interface AnalyzeData {
  /** Short description of the approach detected, e.g. "brute-force nested loop". */
  approachDetected: string;
  currentComplexity: Complexity;
  optimalComplexity: Complexity;
  /** Style / correctness-risk notes surfaced in the analysis. */
  issues: string[];
  /** Whether their current approach is heading toward the optimal one. */
  onOptimalPath: boolean;
}

/** Structured `data` for UNDERSTAND_SOLUTION (optimal-solution explanation). */
export interface UnderstandData {
  patterns: ProblemPattern[];
  /** The single "aha" observation that makes the optimal solution work. */
  keyInsight: string;
  optimalComplexity: Complexity;
}

/**
 * Structured `data` for GENERATE_REPORT. The report is the primary producer of
 * the facts a persistent ProblemRecord needs, so it emits patterns + complexity
 * + approach directly — this way records populate reliably even when the user
 * never ran UNDERSTAND_SOLUTION (which is the only other source of patterns).
 */
export interface ReportData {
  patterns: ProblemPattern[];
  /** Short summary of the approach the report describes (theirs, or optimal). */
  approachSummary: string;
  optimalComplexity: Complexity;
  /** True if the report judges the solution reached the optimal approach. */
  solvedOptimally: boolean;
}

/**
 * Structured `data` for TIME_COMPLEXITY_HINT (the code-aware complexity hint).
 * See .kiro/specs/leetsage-coaching-logic-overhaul §1 (R1–R3). Unlike Analyze,
 * `currentComplexity` is NULLABLE: it is null when the editor code could not be
 * read (empty/failed), in which case the hint falls back to the optimal-only
 * shape and makes NO claim about the user's code (R2.2 — never fabricate a
 * Current). `onOptimalPath` is the model's own judgement of whether the user's
 * current code already matches optimal; it drives whether the card shows a Hint
 * section (worse-than-optimal) or just the "you've hit optimal" affirmation.
 */
export interface ComplexityHintData {
  /** The user's current code complexity, or null when no code was read. */
  currentComplexity: Complexity | null;
  optimalComplexity: Complexity;
  /** Model's judgement: is the current code already at the optimal complexity? */
  onOptimalPath: boolean;
}

/** Union of every action's structured `data` shape. */
export type StructuredData = AnalyzeData | UnderstandData | ReportData | ComplexityHintData;

// ---------------------------------------------------------------------------
// Progress tracking — Phase B persistent records (see
// .kiro/specs/leetsage-progress-tracking/design.md §3).
//
// NOTE ON SCHEMA DRIFT: the design doc's illustrative schema used kebab-case
// pattern tags (`hash-map`) and split complexity into two strings. We instead
// reuse the SHIPPED structured-output types — Title-Case `ProblemPattern` and
// the `Complexity` object — so records populate directly from
// `ContentMetadata.structured` with no translation layer and one vocabulary.
// ---------------------------------------------------------------------------

/**
 * Bump when ProblemRecord's shape changes; drives migrate() (design §6).
 *
 * v2 (leetsage-progress-insights-overhaul) added three per-Attempt fields:
 * `usedActions`, `optimalComplexity`, and `chatCount`.
 *
 * ⚠️ THE THREE-TOUCH-POINT RULE for any NEW persisted record/attempt field —
 * a field has THREE mandatory homes, not one. Miss any one and the field is
 * silently wrong on a round-trip:
 *   1. CAPTURE / PROJECTION — where the value is written at save time
 *      (`buildRecordProjection` in session-digest.ts, fed from
 *      App.tsx handleSaveToProgress).
 *   2. STORAGE-READ MIGRATION — `migrate()` in progress-records.ts, so an older
 *      stored record reads cleanly with a safe default.
 *   3. IMPORT SANITIZER — `sanitizeAttempt`/`sanitizeRecord` in progress-io.ts.
 *      The importer is an ALLOWLIST ("reconstruct, don't validate-in-place"):
 *      it copies ONLY explicitly-known fields, so a new field NOT added here is
 *      silently DROPPED on import (bug-class B20). (2) and (3) MUST share one
 *      defaulting rule so an old stored record and an old imported file end up
 *      identical.
 */
export const PROBLEM_RECORD_SCHEMA_VERSION = 2;

export type AttemptOutcome = 'solved' | 'attempted' | 'gave-up';

/**
 * One saved attempt at a problem. Append-only: each "Save to my progress"
 * pushes a new Attempt rather than overwriting, so the record keeps a timeline
 * (event-log thinking — design §3.1). Fields are projected from the session's
 * structured data + editor code at save time.
 */
export interface Attempt {
  date: number;                 // epoch ms
  outcome: AttemptOutcome;
  approachSummary: string;      // from AnalyzeData.approachDetected (latest)
  solutionSummary: string;      // language-agnostic outline (not a code dump)
  complexity: Complexity;       // the attempt's achieved time/space
  hintsUsed: number;            // from ProgressState.hintLevel
  language?: string;            // editor language, if known
  /**
   * v2 — the coaching actions the user reached for this session (projected from
   * the live ProgressState.usedActions Set at save time; a Set isn't
   * JSON-serializable so we store an array). A SOFT struggle-heuristic input to
   * analytics only — never shown to the user (design §5.4). Absent/[] on older
   * records ⇒ "none recorded", never treated as struggle (migration default).
   */
  usedActions?: ActionType[];
  /**
   * v2 — the canonical optimal complexity for this problem at save time,
   * projected from the B10 complexity pin (NOT a fresh model judgment). Stored
   * ON the record (not read from the separate, un-exported pin store) so the
   * achieved-vs-optimal "may be suboptimal" flag is a pure function of EXPORTED
   * data and round-trips (design §0.2 / §4.1 / R7b). Absent ⇒ no pin existed ⇒
   * the problem is never flagged (absence is not a claim of optimality — R3.4).
   */
  optimalComplexity?: Complexity;
  /**
   * v2 — how many free-form chat questions the user asked this session (the
   * same `isUserQuery` count the report digest uses). A struggle-heuristic
   * input only (never shown): more questions on a problem is a weak "this was
   * harder" signal. Absent/0 on older records ⇒ never treated as struggle
   * (migration default). Bounded when scored so a chatty-but-curious user isn't
   * over-weighted (design §5.3).
   */
  chatCount?: number;
}

/** A stable, versioned record of one problem the user has worked on. */
export interface ProblemRecord {
  schemaVersion: number;        // for migrations (design §6)
  slug: string;                 // normalized problem key, e.g. "two-sum" — the PK
  url: string;                  // normalized /problems/{slug}/ URL
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  patterns: ProblemPattern[];   // fixed-vocabulary tags — powers analytics
  attempts: Attempt[];          // history; append on each save
  bestAttemptIndex: number;     // denormalized pointer into attempts[]
  firstSolvedAt: number;        // epoch ms
  lastUpdatedAt: number;        // epoch ms
  notes: string;                // free-form note (the generated report markdown)
}

/**
 * A small projection of a ProblemRecord for the "My Progress" list + analytics
 * (design §3.2 — the secondary index / summary table). Reading the list and
 * computing pattern/difficulty counts only needs these fields, so we avoid
 * loading every full record.
 */
export interface ProblemIndexEntry {
  slug: string;
  url: string;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  patterns: ProblemPattern[];
  attemptCount: number;
  lastUpdatedAt: number;
}

export interface SubProblem {
  id: string;
  title: string;
  description: string;
  relevantConcepts: string[];
  suggestedDataStructures: string[];
  expanded: boolean;
}

export interface ProgressState {
  problemUrl: string;
  usedActions: Set<ActionType>;
  hintLevel: number;
  contentHistory: LearningContent[];
  lastUpdated: number;
}

export interface GeneratedExample {
  input: string;
  output: string;
  complexity: 'Simple' | 'Medium' | 'Tricky';
  explanation: string;
  edgeCaseType?: string;
}

export interface GeneratedExamples {
  examples: GeneratedExample[];
  comparisonView: ComparisonData;
}

export interface ComparisonData {
  originalExamples: Example[];
  generatedExamples: GeneratedExample[];
  coverageAnalysis: string;
}

export interface ProblemBreakdown {
  subProblems: SubProblem[];
  visualizationType: 'checklist' | 'flowchart';
  overallStrategy: string;
}

export interface Hint {
  level: number;
  title: string;
  content: string;
  isLastHint: boolean;
}

export interface StuckSuggestion {
  message: string;
  suggestedAction: ActionType;
  canDismiss: boolean;
}

export interface ActionButton {
  type: ActionType;
  label: string;
  icon: string;
  description: string;
  used: boolean;
}
