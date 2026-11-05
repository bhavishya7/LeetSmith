import type { ProblemRecord, ProblemPattern, Complexity, ActionType, Attempt } from '../types';
import { complexityRank } from './progress-records';

/**
 * Cross-problem analytics (Progress-Tracking Phase C + the insights overhaul,
 * .kiro/specs/leetsage-progress-insights-overhaul).
 *
 * This is a DETERMINISTIC aggregation pipeline over the local records — no AI:
 *   load → group by pattern → score → rank → present.
 * Keeping computation (pure, testable) separate from presentation (the view)
 * is the clean architecture boundary the design calls for. Everything here is
 * pure input → output, so it's a prime unit-test target.
 *
 * The insights answer three user questions (design §1):
 *   R1 "Am I improving?"        → computeTrend
 *   R2 "What to work on next?"  → byPattern / weakestLink / strongestLink / revisit
 *   R3 "Correct but inefficient?" → efficiencyFlags (a FLAG, never a verdict)
 * plus a compact dashboard (R5). Honesty is cross-cutting (R7): the SYSTEM owns
 * facts (counts, dates, hints, achieved-vs-pinned CLASS GAPS); the MODEL owns
 * judgments (the pinned optimal value, the pattern labels).
 */

const DIFFICULTY_WEIGHT: Record<ProblemRecord['difficulty'], number> = {
  Easy: 1,
  Medium: 2,
  Hard: 3,
};

/** Days after which a solved problem is worth revisiting. */
const REVISIT_STALE_DAYS = 30;
/** hintsUsed at/above this counts as a "high-hint" struggle signal. */
const HIGH_HINT_THRESHOLD = 2;

/**
 * The `complexityRank` sentinel for an unknown/odd Big-O notation (it sorts
 * such values to the MIDDLE so they never falsely win "best"). We re-export it
 * here as a named constant so the achieved-vs-optimal flag can refuse to fire
 * when EITHER side is unknown — we only flag an UNAMBIGUOUS gap (R3.3/R3.4).
 */
export const UNKNOWN_RANK = 3.5;

/** Minimum problems before computeTrend will claim any direction (design §2.2). */
export const TREND_MIN_PROBLEMS = 5;
/**
 * A struggle-mean difference smaller than this (on the struggle-score scale) is
 * reported as "flat" rather than a direction — no false "you improved" on noise.
 */
export const TREND_EPSILON = 0.75;

// ---------------------------------------------------------------------------
// R3 — the achieved-vs-optimal "may be suboptimal" FLAG (pure; TIME axis only)
// ---------------------------------------------------------------------------

/**
 * Whether an attempt's ACHIEVED complexity is UNAMBIGUOUSLY worse than the
 * problem's canonical optimal — a candidate to review, NOT a verdict (R3).
 *
 *  - Uses the ALREADY-STORED optimal on the attempt (projected from the B10 pin
 *    at save time), NOT a fresh model re-judgment (R3.2) — and because it reads
 *    a stored RECORD field, it round-trips through export/import (R7b).
 *  - No optimal ⇒ false: no pin existed; absence of a flag is NOT a claim of
 *    optimality (R3.4 — the UI states this).
 *  - TIME axis only (design §4.2 / locked decision): space gaps are usually
 *    deliberate time/space trade-offs and the free model is noisier about them;
 *    flagging space would raise false "suboptimal" alarms.
 *  - Fires ONLY on a gap of at least one full complexity class per
 *    `complexityRank`. Unknown/odd notation on EITHER side ⇒ false (we can't
 *    compare confidently). Same-class / constant-factor / amortized differences
 *    collapse to the same coarse rank and are structurally excluded (R3.3).
 */
export function isLikelySuboptimal(achieved: Complexity, optimal: Complexity | null | undefined): boolean {
  if (!optimal) return false;
  const a = complexityRank(achieved.time);
  const o = complexityRank(optimal.time);
  if (a === UNKNOWN_RANK || o === UNKNOWN_RANK) return false; // can't compare ⇒ no flag
  return a - o >= 1;                                          // ≥ one full class worse
}

// ---------------------------------------------------------------------------
// R4 — the usedActions soft heuristic → a normalized tool-depth
// ---------------------------------------------------------------------------

/**
 * TIERED per-action depth weights (design §5.3, option (c)).
 *
 * ORDERING PRINCIPLE (revised after review): weight by how strongly the tool
 * implies the user was STUCK — NOT by how "deep" the tool is. The distinction
 * matters: analyzing your code or checking its Big-O is often a CONFIDENCE /
 * verification behavior (a correct solver sanity-checking what they wrote), not
 * a struggle signal — so those rank LOW despite being "advanced" tools. Asking
 * the problem to be decomposed, or the pattern named, is a genuine "I don't know
 * how to approach this" tell — so those rank HIGH.
 *   - UNDERSTAND_SOLUTION 1.0 — asked for the full solution: clearest stuck tell
 *   - BREAK_DOWN_PROBLEM  0.7 — "I can't start / decompose this"
 *   - PATTERN_RECOGNITION 0.6 — "I can't see which technique applies"
 *   - CHECK_APPROACH      0.4 — often verifying CORRECT code, not struggling
 *   - TIME_COMPLEXITY_HINT 0.4 — often just checking Big-O of correct code
 *   - GENERATE_EXAMPLES / EXPLAIN_CONCEPT 0.3 — mild / exploratory / curiosity
 * EXCLUDED: GET_HINT (its own `avgHintsUsed` term — no double count) and
 * GENERATE_REPORT (the act that TRIGGERS the save, not a struggle signal).
 * These are heuristic judgement calls (no ground truth for "tapping X ⇒ struggle
 * Y"); documented here as tunable, not magic.
 */
const DEPTH_WEIGHTS: Partial<Record<ActionType, number>> = {
  UNDERSTAND_SOLUTION: 1.0,
  BREAK_DOWN_PROBLEM: 0.7,
  PATTERN_RECOGNITION: 0.6,
  CHECK_APPROACH: 0.4,
  TIME_COMPLEXITY_HINT: 0.4,
  GENERATE_EXAMPLES: 0.3,
  EXPLAIN_CONCEPT: 0.3,
};

/**
 * Normalized tool-depth in [0,1] from an attempt's `usedActions` (R4.3), using
 * the TIERED weights above. Sums the weight of each DISTINCT tool used, then
 * normalizes against a cap so it stays a SOFT nudge (never dominates): a user
 * who taps everything maxes out gently rather than running away with the score.
 * Empty / absent (an old record) ⇒ 0 (never struggle). Pure.
 */
const TOOL_DEPTH_CAP = 2.0; // ~UNDERSTAND(1.0)+CHECK_APPROACH(0.7)+a light one saturates
export function toolDepth(usedActions: ActionType[] | undefined): number {
  if (!usedActions || usedActions.length === 0) return 0;
  const distinct = new Set(usedActions);
  let sum = 0;
  for (const a of distinct) sum += DEPTH_WEIGHTS[a] ?? 0;
  return Math.min(sum, TOOL_DEPTH_CAP) / TOOL_DEPTH_CAP;
}

/**
 * Normalized chat-questions signal in [0,1] from an attempt's `chatCount`
 * (option (c)). More free-form questions on a problem is a weak "this was
 * harder" signal; capped so a chatty-but-curious user isn't over-weighted.
 * 0 / absent ⇒ 0. Pure.
 */
const CHAT_CAP = 4; // 4+ questions saturates the signal
export function chatLoad(chatCount: number | undefined): number {
  if (!chatCount || chatCount <= 0) return 0;
  return Math.min(chatCount, CHAT_CAP) / CHAT_CAP;
}

// ---------------------------------------------------------------------------
// Struggle score (reworked — design §3.1)
// ---------------------------------------------------------------------------

/**
 * Struggle score: higher = more struggle. Reworked for the insights overhaul
 * (R2.1) + option (c). The weights are a judgement call — documented here so
 * they're tunable, not magic — and chosen so NO single signal dominates (the old
 * score was ~all hints; `gaveUpRate` was always 0 and is removed entirely). The
 * whole point is that struggle is read from MANY coaching signals, not hints:
 *   - hints            1.5  (one voice of several, demoted from the old *2)
 *   - difficulty       1.0  (a Hard pattern is genuinely more struggle)
 *   - suboptimalRate   3.0  (a real, honest ≥1-class complexity gap — strongest)
 *   - toolDepth        1.5  (TIERED usedActions: analyze/understand/breakdown/
 *                            pattern/complexity/examples — weighted by depth)
 *   - chatLoad         1.0  (free-form questions asked — a soft nudge)
 */
export function computeStruggleScore(input: {
  avgHintsUsed: number;
  avgDifficultyWeight: number;
  suboptimalRate: number;   // 0..1 — share of the pattern's problems flagged by isLikelySuboptimal
  avgToolDepth: number;     // 0..1 — mean tiered toolDepth over the pattern's problems
  avgChatLoad: number;      // 0..1 — mean chatLoad over the pattern's problems
}): number {
  const { avgHintsUsed, avgDifficultyWeight, suboptimalRate, avgToolDepth, avgChatLoad } = input;
  return (
    avgHintsUsed * 1.5 +
    avgDifficultyWeight * 1.0 +
    suboptimalRate * 3.0 +
    avgToolDepth * 1.5 +
    avgChatLoad * 1.0
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PatternStat {
  pattern: ProblemPattern;
  problemCount: number;      // distinct problems tagged with this pattern
  avgHintsUsed: number;      // averaged over those problems' best attempts
  avgAttempts: number;       // avg number of saved attempts per problem
  difficultyMix: { Easy: number; Medium: number; Hard: number };
  suboptimalRate: number;    // share flagged by isLikelySuboptimal (R3)
  avgToolDepth: number;      // mean tiered toolDepth over best attempts (R4)
  avgChatLoad: number;       // mean chatLoad over best attempts (option c)
  struggleScore: number;     // higher = more struggle (see computeStruggleScore)
  /** True when problemCount is too small to trust the ranking. */
  lowConfidence: boolean;
}

export interface RevisitItem {
  slug: string;
  title: string;
  /** `gave-up` dropped (design §3.3); `may-be-suboptimal` is the R3 flag. */
  reason: 'may-be-suboptimal' | 'high-hints' | 'stale';
}

/** R1 — the trend answer. Qualitative, no false precision (no percentages). */
export interface TrendInsight {
  direction: 'improving' | 'flat' | 'needs-work' | 'insufficient';
  sampleSize: number;   // problems the trend is based on
  earlierMean: number;  // mean struggle of the earlier half (for debugging/tests)
  recentMean: number;   // mean struggle of the recent half
}

/** R3 — one candidate-to-review (a flag, framed tentatively in the UI). */
export interface EfficiencyFlag {
  slug: string;
  title: string;
  achieved: Complexity;
  optimal: Complexity;
}

/** R5 — compact at-a-glance dashboard. */
export interface DashboardStats {
  byDifficulty: { Easy: number; Medium: number; Hard: number };
  patternCoverage: number;   // distinct patterns touched
  activeDays: number;        // distinct local calendar days with an attempt
  lastActiveAt: number;      // most recent attempt date (0 if none)
  reviewedCandidates: number; // = efficiencyFlags.length (inherits R3 framing)
}

export interface ProgressInsights {
  totalProblems: number;
  totalAttempts: number;
  byPattern: PatternStat[];           // ranked, most-struggled first
  weakestLink: PatternStat | null;
  strongestLink: PatternStat | null;  // R2.2 — positive signal
  revisit: RevisitItem[];
  trend: TrendInsight;                // R1
  efficiencyFlags: EfficiencyFlag[];  // R3
  dashboard: DashboardStats;          // R5
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bestAttempt(r: ProblemRecord): Attempt | undefined {
  return r.attempts[r.bestAttemptIndex] ?? r.attempts[r.attempts.length - 1];
}

/** The per-problem struggle value (used by the trend + as the pattern input). */
function problemStruggle(r: ProblemRecord): number {
  const best = bestAttempt(r);
  const hints = best?.hintsUsed ?? 0;
  const suboptimal = best && isLikelySuboptimal(best.complexity, best.optimalComplexity) ? 1 : 0;
  const depth = toolDepth(best?.usedActions);
  const chat = chatLoad(best?.chatCount);
  return computeStruggleScore({
    avgHintsUsed: hints,
    avgDifficultyWeight: DIFFICULTY_WEIGHT[r.difficulty],
    suboptimalRate: suboptimal,
    avgToolDepth: depth,
    avgChatLoad: chat,
  });
}

/** When a problem was first worked (for ordering the trend); best-effort. */
function problemStart(r: ProblemRecord): number {
  if (r.firstSolvedAt && r.firstSolvedAt > 0) return r.firstSolvedAt;
  const first = r.attempts[0];
  return first?.date ?? r.lastUpdatedAt;
}

// ---------------------------------------------------------------------------
// R1 — "Am I improving?" (recent-vs-earlier over per-problem struggle)
// ---------------------------------------------------------------------------

/**
 * Computes an HONEST improvement trend (design §2). One datapoint per PROBLEM
 * (its per-problem struggle), ordered by when the problem was first worked, then
 * split into an earlier half and a recent half; lower struggle = did better.
 *
 *  - Below TREND_MIN_PROBLEMS ⇒ `insufficient` ("not enough data yet") — never
 *    invent a trend (R1.2/R7.3).
 *  - A recent-vs-earlier change within TREND_EPSILON ⇒ `flat` (no false claim).
 *  - No percentages (R1.3 — no false precision). ORDER-relative, not wall-clock-
 *    relative, so a later import doesn't shift it (R7b.2).
 */
export function computeTrend(records: ProblemRecord[]): TrendInsight {
  const ordered = records
    .filter(r => r.attempts.length > 0)
    .slice()
    .sort((a, b) => problemStart(a) - problemStart(b));

  if (ordered.length < TREND_MIN_PROBLEMS) {
    return { direction: 'insufficient', sampleSize: ordered.length, earlierMean: 0, recentMean: 0 };
  }

  const struggles = ordered.map(problemStruggle); // oldest → newest
  const mid = Math.floor(ordered.length / 2);
  const earlier = struggles.slice(0, mid);
  const recent = struggles.slice(struggles.length - mid); // symmetric halves; a middle item (odd N) is ignored
  const earlierMean = mean(earlier);
  const recentMean = mean(recent);

  const delta = recentMean - earlierMean; // negative = struggle went DOWN = improving
  let direction: TrendInsight['direction'];
  if (Math.abs(delta) < TREND_EPSILON) direction = 'flat';
  else if (delta < 0) direction = 'improving';
  else direction = 'needs-work';

  return { direction, sampleSize: ordered.length, earlierMean, recentMean };
}

// ---------------------------------------------------------------------------
// computeInsights — the top-level aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregates records into per-pattern stats + weakest/strongest + revisit +
 * trend + efficiency flags + dashboard. A problem with N patterns fans out into
 * all N pattern buckets. Pure.
 */
export function computeInsights(records: ProblemRecord[]): ProgressInsights {
  const totalAttempts = records.reduce((sum, r) => sum + r.attempts.length, 0);

  // Group problems by pattern (fan-out).
  const buckets = new Map<ProblemPattern, ProblemRecord[]>();
  for (const r of records) {
    for (const p of r.patterns) {
      const arr = buckets.get(p) ?? [];
      arr.push(r);
      buckets.set(p, arr);
    }
  }

  const byPattern: PatternStat[] = [];
  for (const [pattern, recs] of buckets) {
    const problemCount = recs.length;
    const bests = recs.map(bestAttempt).filter((a): a is Attempt => !!a);
    const avgHintsUsed = mean(bests.map(a => a.hintsUsed));
    const avgAttempts = mean(recs.map(r => r.attempts.length));
    const difficultyMix = { Easy: 0, Medium: 0, Hard: 0 };
    for (const r of recs) difficultyMix[r.difficulty]++;
    const avgDifficultyWeight = mean(recs.map(r => DIFFICULTY_WEIGHT[r.difficulty]));
    // R3 — share of this pattern's problems whose best attempt is UNAMBIGUOUSLY
    // worse than optimal (stored field; no model call).
    const flaggedCount = recs.filter(r => {
      const b = bestAttempt(r);
      return b ? isLikelySuboptimal(b.complexity, b.optimalComplexity) : false;
    }).length;
    const suboptimalRate = problemCount > 0 ? flaggedCount / problemCount : 0;
    // R4 + option (c) — mean tiered tool-depth + mean chat-load over best
    // attempts (both soft nudges).
    const avgToolDepth = mean(bests.map(a => toolDepth(a.usedActions)));
    const avgChatLoad = mean(bests.map(a => chatLoad(a.chatCount)));

    byPattern.push({
      pattern,
      problemCount,
      avgHintsUsed,
      avgAttempts,
      difficultyMix,
      suboptimalRate,
      avgToolDepth,
      avgChatLoad,
      struggleScore: computeStruggleScore({ avgHintsUsed, avgDifficultyWeight, suboptimalRate, avgToolDepth, avgChatLoad }),
      lowConfidence: problemCount < 3,   // don't overclaim on tiny N (design §7)
    });
  }

  byPattern.sort((a, b) => b.struggleScore - a.struggleScore);

  // Weakest link: highest struggle among patterns we have *some* confidence in;
  // if everything is low-confidence, still surface the top one but flagged.
  const confident = byPattern.filter(p => !p.lowConfidence);
  const weakestLink = confident[0] ?? byPattern[0] ?? null;

  // Strongest link (R2.2): the LOWEST-struggle CONFIDENT pattern — but only when
  // it's a distinct, meaningfully-lower pattern than the weakest (don't award a
  // "strength" when everything scores the same, there's only one pattern, or
  // nothing is confident enough to trust).
  let strongestLink: PatternStat | null = null;
  if (confident.length >= 2) {
    const candidate = confident[confident.length - 1]; // byPattern is struggle-desc
    if (
      candidate.pattern !== weakestLink?.pattern &&
      (weakestLink ? weakestLink.struggleScore - candidate.struggleScore >= TREND_EPSILON : true)
    ) {
      strongestLink = candidate;
    }
  }

  // Revisit list: may-be-suboptimal (R3) → high-hint → stale-since-last-touch.
  // (`gave-up` reason dropped — design §3.3.)
  const now = Date.now();
  const staleMs = REVISIT_STALE_DAYS * 24 * 60 * 60 * 1000;
  const revisit: RevisitItem[] = [];
  for (const r of records) {
    const best = bestAttempt(r);
    if (best && isLikelySuboptimal(best.complexity, best.optimalComplexity)) {
      revisit.push({ slug: r.slug, title: r.title, reason: 'may-be-suboptimal' });
    } else if ((best?.hintsUsed ?? 0) >= HIGH_HINT_THRESHOLD) {
      revisit.push({ slug: r.slug, title: r.title, reason: 'high-hints' });
    } else if (now - r.lastUpdatedAt > staleMs) {
      revisit.push({ slug: r.slug, title: r.title, reason: 'stale' });
    }
  }

  // R3 — the explicit efficiency flags list (candidates to review).
  const efficiencyFlags: EfficiencyFlag[] = [];
  for (const r of records) {
    const best = bestAttempt(r);
    if (best && best.optimalComplexity && isLikelySuboptimal(best.complexity, best.optimalComplexity)) {
      efficiencyFlags.push({ slug: r.slug, title: r.title, achieved: best.complexity, optimal: best.optimalComplexity });
    }
  }

  return {
    totalProblems: records.length,
    totalAttempts,
    byPattern,
    weakestLink,
    strongestLink,
    revisit,
    trend: computeTrend(records),
    efficiencyFlags,
    dashboard: computeDashboard(records, efficiencyFlags.length),
  };
}

// ---------------------------------------------------------------------------
// R5 — compact dashboard
// ---------------------------------------------------------------------------

function computeDashboard(records: ProblemRecord[], reviewedCandidates: number): DashboardStats {
  const byDifficulty = { Easy: 0, Medium: 0, Hard: 0 };
  const patterns = new Set<ProblemPattern>();
  const days = new Set<string>();
  let lastActiveAt = 0;
  for (const r of records) {
    byDifficulty[r.difficulty]++;
    for (const p of r.patterns) patterns.add(p);
    for (const a of r.attempts) {
      const d = new Date(a.date);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      if (a.date > lastActiveAt) lastActiveAt = a.date;
    }
  }
  return {
    byDifficulty,
    patternCoverage: patterns.size,
    activeDays: days.size,
    lastActiveAt,
    reviewedCandidates,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
