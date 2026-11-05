import { describe, it, expect } from 'vitest';
import {
  computeStruggleScore,
  computeInsights,
  computeTrend,
  isLikelySuboptimal,
  toolDepth,
  chatLoad,
  TREND_MIN_PROBLEMS,
} from '../progress-analytics';
import type { ProblemRecord, Attempt, ProblemPattern, AttemptOutcome, Complexity } from '../../types';

/**
 * Unit tests for the deterministic cross-problem analytics (Phase C + the
 * insights overhaul). Pure input->output aggregations: the reworked struggle
 * score, the achieved-vs-optimal flag (R3), the trend (R1), strongest/weakest
 * (R2), the usedActions tool-depth (R4), and the dashboard (R5). No AI, no
 * storage, no DOM.
 */

const DAY = 24 * 60 * 60 * 1000;

function attempt(
  o: AttemptOutcome,
  hintsUsed = 0,
  complexity: Complexity = { time: 'O(n)', space: 'O(n)' },
  extra: Partial<Attempt> = {},
): Attempt {
  return {
    date: Date.now(),
    outcome: o,
    approachSummary: 'x',
    solutionSummary: 'y',
    complexity,
    hintsUsed,
    usedActions: [],
    ...extra,
  };
}

let recSeq = 0;
function record(opts: {
  patterns: ProblemPattern[];
  difficulty?: ProblemRecord['difficulty'];
  attempts?: Attempt[];
  bestAttemptIndex?: number;
  lastUpdatedAt?: number;
  firstSolvedAt?: number;
}): ProblemRecord {
  const attempts = opts.attempts ?? [attempt('solved')];
  const slug = `p${recSeq++}`;
  return {
    schemaVersion: 2,
    slug,
    url: `https://leetcode.com/problems/${slug}/`,
    title: slug,
    difficulty: opts.difficulty ?? 'Medium',
    patterns: opts.patterns,
    attempts,
    bestAttemptIndex: opts.bestAttemptIndex ?? attempts.length - 1,
    firstSolvedAt: opts.firstSolvedAt ?? Date.now(),
    lastUpdatedAt: opts.lastUpdatedAt ?? Date.now(),
    notes: '',
  };
}

// ===========================================================================
// R3 — isLikelySuboptimal (TIME axis, ≥1 class, never on unknown/no-pin)
// ===========================================================================

describe('isLikelySuboptimal', () => {
  it('fires on a two-class gap: O(n^2) achieved vs O(n) optimal', () => {
    expect(isLikelySuboptimal({ time: 'O(n^2)', space: 'O(1)' }, { time: 'O(n)', space: 'O(n)' })).toBe(true);
  });

  it('fires on a one-class gap: O(n log n) achieved vs O(n) optimal', () => {
    expect(isLikelySuboptimal({ time: 'O(n log n)', space: 'O(1)' }, { time: 'O(n)', space: 'O(1)' })).toBe(true);
  });

  it('does NOT fire on the same class (achieved == optimal)', () => {
    expect(isLikelySuboptimal({ time: 'O(n)', space: 'O(1)' }, { time: 'O(n)', space: 'O(n)' })).toBe(false);
  });

  it('does NOT fire when achieved is BETTER than the (stale) optimal', () => {
    expect(isLikelySuboptimal({ time: 'O(n)', space: 'O(1)' }, { time: 'O(n^2)', space: 'O(1)' })).toBe(false);
  });

  it('does NOT fire when there is no optimal (no pin ⇒ no flag — R3.4)', () => {
    expect(isLikelySuboptimal({ time: 'O(n^2)', space: 'O(1)' }, null)).toBe(false);
    expect(isLikelySuboptimal({ time: 'O(n^2)', space: 'O(1)' }, undefined)).toBe(false);
  });

  it('does NOT fire when EITHER side is an unknown/odd notation (can\'t compare)', () => {
    expect(isLikelySuboptimal({ time: 'O(sqrt n)', space: 'O(1)' }, { time: 'O(n)', space: 'O(1)' })).toBe(false);
    expect(isLikelySuboptimal({ time: 'O(n^2)', space: 'O(1)' }, { time: 'O(weird)', space: 'O(1)' })).toBe(false);
  });

  it('ignores the SPACE axis (a space-only gap is not flagged — design §4.2)', () => {
    // Same time class, worse space — a deliberate trade-off, NOT flagged.
    expect(isLikelySuboptimal({ time: 'O(n)', space: 'O(n)' }, { time: 'O(n)', space: 'O(1)' })).toBe(false);
  });
});

// ===========================================================================
// R4 + option (c) — tiered toolDepth + chatLoad (usedActions/chat heuristics)
// ===========================================================================

describe('toolDepth (tiered weights)', () => {
  it('is 0 for empty/absent usedActions (old record ⇒ never struggle)', () => {
    expect(toolDepth([])).toBe(0);
    expect(toolDepth(undefined)).toBe(0);
  });

  it('EXCLUDES hints and GENERATE_REPORT (own term / save trigger)', () => {
    expect(toolDepth(['GET_HINT'])).toBe(0);
    expect(toolDepth(['GENERATE_REPORT'])).toBe(0);
  });

  it('weights by how strongly the tool implies being STUCK, not tool "depth"', () => {
    // UNDERSTAND_SOLUTION (1.0) > EXPLAIN_CONCEPT (0.3) for a single tool.
    expect(toolDepth(['UNDERSTAND_SOLUTION'])).toBeGreaterThan(toolDepth(['EXPLAIN_CONCEPT']));
    // Cap is 2.0 → a single 1.0 tool normalizes to 0.5.
    expect(toolDepth(['UNDERSTAND_SOLUTION'])).toBeCloseTo(0.5);
    expect(toolDepth(['EXPLAIN_CONCEPT'])).toBeCloseTo(0.15);
    // Revised ordering: breakdown/pattern (stuck on the approach) rank ABOVE
    // analyze/complexity (often verifying correct code, not struggling).
    expect(toolDepth(['BREAK_DOWN_PROBLEM'])).toBeGreaterThan(toolDepth(['CHECK_APPROACH']));
    expect(toolDepth(['PATTERN_RECOGNITION'])).toBeGreaterThan(toolDepth(['TIME_COMPLEXITY_HINT']));
  });

  it('sums distinct tools and saturates at the cap (1.0)', () => {
    // 1.0 + 0.4 + 0.7 = 2.1 → capped at 2.0 → normalized 1.0.
    expect(toolDepth(['UNDERSTAND_SOLUTION', 'CHECK_APPROACH', 'BREAK_DOWN_PROBLEM'])).toBe(1);
    // dedupe: repeats don't inflate.
    expect(toolDepth(['CHECK_APPROACH', 'CHECK_APPROACH'])).toBeCloseTo(0.2); // 0.4/2.0
  });
});

describe('chatLoad', () => {
  it('is 0 for absent/zero chat questions', () => {
    expect(chatLoad(undefined)).toBe(0);
    expect(chatLoad(0)).toBe(0);
  });
  it('rises with questions and saturates at the cap (4)', () => {
    expect(chatLoad(1)).toBeCloseTo(0.25);
    expect(chatLoad(2)).toBeCloseTo(0.5);
    expect(chatLoad(4)).toBe(1);
    expect(chatLoad(10)).toBe(1);
  });
});

// ===========================================================================
// Reworked struggle score (R2.1 + option c)
// ===========================================================================

describe('computeStruggleScore (reworked)', () => {
  const score = (o: Partial<Parameters<typeof computeStruggleScore>[0]>) =>
    computeStruggleScore({ avgHintsUsed: 0, avgDifficultyWeight: 0, suboptimalRate: 0, avgToolDepth: 0, avgChatLoad: 0, ...o });

  it('rises with every signal (hints, difficulty, suboptimal, tool depth, chat)', () => {
    const low = score({ avgDifficultyWeight: 1 });
    const high = score({ avgHintsUsed: 3, avgDifficultyWeight: 3, suboptimalRate: 1, avgToolDepth: 1, avgChatLoad: 1 });
    expect(high).toBeGreaterThan(low);
  });

  it('has no gave-up input; each signal contributes its documented weight', () => {
    expect(score({ avgHintsUsed: 2 })).toBe(3);      // 2 * 1.5
    expect(score({ suboptimalRate: 1 })).toBe(3);    // 1 * 3.0
    expect(score({ avgToolDepth: 1 })).toBe(1.5);    // 1 * 1.5
    expect(score({ avgChatLoad: 1 })).toBe(1);       // 1 * 1.0
  });

  it('is multi-signal: tool depth + chat + a gap can outweigh pure hints', () => {
    const aHints = score({ avgHintsUsed: 3, avgDifficultyWeight: 1 });                                 // 4.5 + 1 = 5.5
    const bOther = score({ avgDifficultyWeight: 1, suboptimalRate: 1, avgToolDepth: 1, avgChatLoad: 1 }); // 1+3+1.5+1 = 6.5
    expect(bOther).toBeGreaterThan(aHints); // struggle is NOT just hints anymore
  });
});

// ===========================================================================
// computeInsights — totals, fan-out, confidence (existing behavior preserved)
// ===========================================================================

describe('computeInsights — totals and fan-out', () => {
  it('counts problems and attempts; a problem fans out into all its patterns', () => {
    const records = [
      record({ patterns: ['Hash Map', 'Two Pointers'], attempts: [attempt('solved'), attempt('solved')] }),
      record({ patterns: ['Hash Map'] }),
    ];
    const insights = computeInsights(records);
    expect(insights.totalProblems).toBe(2);
    expect(insights.totalAttempts).toBe(3);
    expect(insights.byPattern.find(p => p.pattern === 'Hash Map')?.problemCount).toBe(2);
    expect(insights.byPattern.find(p => p.pattern === 'Two Pointers')?.problemCount).toBe(1);
  });

  it('returns empty structures for no records', () => {
    const insights = computeInsights([]);
    expect(insights.totalProblems).toBe(0);
    expect(insights.byPattern).toEqual([]);
    expect(insights.weakestLink).toBeNull();
    expect(insights.strongestLink).toBeNull();
    expect(insights.revisit).toEqual([]);
    expect(insights.efficiencyFlags).toEqual([]);
    expect(insights.trend.direction).toBe('insufficient');
  });
});

describe('computeInsights — low-confidence gate (<3 problems)', () => {
  it('flags a pattern with fewer than 3 problems as lowConfidence', () => {
    const records = [record({ patterns: ['Greedy'] }), record({ patterns: ['Greedy'] })];
    expect(computeInsights(records).byPattern.find(p => p.pattern === 'Greedy')?.lowConfidence).toBe(true);
  });

  it('does not flag a pattern with 3+ problems', () => {
    const records = [record({ patterns: ['DFS'] }), record({ patterns: ['DFS'] }), record({ patterns: ['DFS'] })];
    expect(computeInsights(records).byPattern.find(p => p.pattern === 'DFS')?.lowConfidence).toBe(false);
  });

  it('prefers a confident pattern as weakest-link even if a low-confidence one scores higher', () => {
    const records = [
      record({ patterns: ['Backtracking'], attempts: [attempt('attempted', 3)], bestAttemptIndex: 0, difficulty: 'Hard' }),
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('solved', 3)], bestAttemptIndex: 0 }),
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('solved', 3)], bestAttemptIndex: 0 }),
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('solved', 2)], bestAttemptIndex: 0 }),
    ];
    const insights = computeInsights(records);
    expect(insights.weakestLink?.pattern).toBe('Dynamic Programming');
    expect(insights.weakestLink?.lowConfidence).toBe(false);
  });

  it('still surfaces a low-confidence weakest-link (flagged) when everything is low-confidence', () => {
    const records = [record({ patterns: ['Trie'], attempts: [attempt('attempted', 2)], bestAttemptIndex: 0 })];
    const insights = computeInsights(records);
    expect(insights.weakestLink?.pattern).toBe('Trie');
    expect(insights.weakestLink?.lowConfidence).toBe(true);
  });
});

describe('computeInsights — ranking', () => {
  it('sorts byPattern most-struggled first', () => {
    const records = [
      record({ patterns: ['Hash Map'], attempts: [attempt('solved', 0)], bestAttemptIndex: 0, difficulty: 'Easy' }),
      record({ patterns: ['Graph'], attempts: [attempt('attempted', 3)], bestAttemptIndex: 0, difficulty: 'Hard' }),
    ];
    expect(computeInsights(records).byPattern[0].pattern).toBe('Graph');
  });
});

// ===========================================================================
// R2.2 — strongest link
// ===========================================================================

describe('computeInsights — strongest link (R2.2)', () => {
  it('surfaces the lowest-struggle confident pattern as strongest, distinct from weakest', () => {
    const records = [
      // Hash Map: easy, no hints, optimal → low struggle (strongest)
      record({ patterns: ['Hash Map'], attempts: [attempt('solved', 0, { time: 'O(n)', space: 'O(n)' }, { optimalComplexity: { time: 'O(n)', space: 'O(n)' } })], bestAttemptIndex: 0, difficulty: 'Easy' }),
      record({ patterns: ['Hash Map'], attempts: [attempt('solved', 0)], bestAttemptIndex: 0, difficulty: 'Easy' }),
      record({ patterns: ['Hash Map'], attempts: [attempt('solved', 0)], bestAttemptIndex: 0, difficulty: 'Easy' }),
      // Dynamic Programming: hard, many hints, a real gap → high struggle (weakest)
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('attempted', 3, { time: 'O(n^2)', space: 'O(1)' }, { optimalComplexity: { time: 'O(n)', space: 'O(n)' } })], bestAttemptIndex: 0, difficulty: 'Hard' }),
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('attempted', 3)], bestAttemptIndex: 0, difficulty: 'Hard' }),
      record({ patterns: ['Dynamic Programming'], attempts: [attempt('attempted', 2)], bestAttemptIndex: 0, difficulty: 'Hard' }),
    ];
    const insights = computeInsights(records);
    expect(insights.weakestLink?.pattern).toBe('Dynamic Programming');
    expect(insights.strongestLink?.pattern).toBe('Hash Map');
  });

  it('returns null strongest when there is only one confident pattern', () => {
    const records = [record({ patterns: ['DFS'] }), record({ patterns: ['DFS'] }), record({ patterns: ['DFS'] })];
    expect(computeInsights(records).strongestLink).toBeNull();
  });

  it('returns null strongest when everything is low-confidence', () => {
    const records = [record({ patterns: ['Trie'] }), record({ patterns: ['Heap'] })];
    expect(computeInsights(records).strongestLink).toBeNull();
  });
});

// ===========================================================================
// R3 — efficiencyFlags
// ===========================================================================

describe('computeInsights — efficiencyFlags (R3)', () => {
  it('flags a problem whose best attempt is a ≥1-class gap vs its stored optimal', () => {
    const records = [
      record({ patterns: ['Dynamic Programming'], bestAttemptIndex: 0, attempts: [
        attempt('solved', 0, { time: 'O(n^2)', space: 'O(1)' }, { optimalComplexity: { time: 'O(n)', space: 'O(n)' } }),
      ] }),
    ];
    const flags = computeInsights(records).efficiencyFlags;
    expect(flags).toHaveLength(1);
    expect(flags[0].achieved.time).toBe('O(n^2)');
    expect(flags[0].optimal.time).toBe('O(n)');
  });

  it('does NOT flag a problem with no stored optimal (old record)', () => {
    const records = [record({ patterns: ['Hash Map'], bestAttemptIndex: 0, attempts: [
      attempt('solved', 0, { time: 'O(n^2)', space: 'O(1)' }), // no optimalComplexity
    ] })];
    expect(computeInsights(records).efficiencyFlags).toEqual([]);
  });

  it('does NOT flag a same-class problem', () => {
    const records = [record({ patterns: ['Hash Map'], bestAttemptIndex: 0, attempts: [
      attempt('solved', 0, { time: 'O(n)', space: 'O(n)' }, { optimalComplexity: { time: 'O(n)', space: 'O(n)' } }),
    ] })];
    expect(computeInsights(records).efficiencyFlags).toEqual([]);
  });
});

// ===========================================================================
// R2.4 — revisit reasons (gave-up dropped; may-be-suboptimal added)
// ===========================================================================

describe('computeInsights — revisit list (reworked reasons)', () => {
  it('lists a suboptimal problem with reason may-be-suboptimal (highest precedence)', () => {
    const records = [record({ patterns: ['Stack'], bestAttemptIndex: 0, attempts: [
      attempt('solved', 3, { time: 'O(n^2)', space: 'O(1)' }, { optimalComplexity: { time: 'O(n)', space: 'O(n)' } }),
    ] })];
    const revisit = computeInsights(records).revisit;
    expect(revisit).toHaveLength(1);
    expect(revisit[0].reason).toBe('may-be-suboptimal'); // wins over high-hints
  });

  it('lists a high-hint problem with reason high-hints', () => {
    const records = [record({ patterns: ['Stack'], attempts: [attempt('solved', 2)], bestAttemptIndex: 0 })];
    expect(computeInsights(records).revisit[0].reason).toBe('high-hints');
  });

  it('lists a stale (>30 days) problem with reason stale', () => {
    const old = Date.now() - 40 * DAY;
    const records = [record({ patterns: ['Stack'], attempts: [attempt('solved', 0)], bestAttemptIndex: 0, lastUpdatedAt: old })];
    expect(computeInsights(records).revisit[0].reason).toBe('stale');
  });

  it('does not list a fresh, low-hint, in-class, solved problem', () => {
    const records = [record({ patterns: ['Stack'], attempts: [attempt('solved', 0)], bestAttemptIndex: 0 })];
    expect(computeInsights(records).revisit).toEqual([]);
  });

  it('never emits the old gave-up reason', () => {
    const records = [record({ patterns: ['Stack'], attempts: [attempt('gave-up', 3)], bestAttemptIndex: 0 })];
    const reasons = computeInsights(records).revisit.map(r => r.reason);
    expect(reasons).not.toContain('gave-up');
  });
});

// ===========================================================================
// R1 — computeTrend
// ===========================================================================

describe('computeTrend (R1)', () => {
  function timeline(structs: Array<{ hints: number; day: number; achieved?: Complexity; optimal?: Complexity }>): ProblemRecord[] {
    return structs.map(s => record({
      patterns: ['Hash Map'],
      firstSolvedAt: Date.now() - s.day * DAY,
      bestAttemptIndex: 0,
      attempts: [attempt('solved', s.hints, s.achieved ?? { time: 'O(n)', space: 'O(n)' }, s.optimal ? { optimalComplexity: s.optimal } : {})],
    }));
  }

  it('says insufficient below TREND_MIN_PROBLEMS (never invents a trend)', () => {
    const recs = timeline([{ hints: 3, day: 4 }, { hints: 3, day: 3 }, { hints: 0, day: 2 }]); // 3 < 5
    const t = computeTrend(recs);
    expect(t.direction).toBe('insufficient');
    expect(t.sampleSize).toBe(3);
  });

  it('says improving when recent struggle is lower than earlier', () => {
    // earliest → latest: high-hint early, low-hint recent
    const recs = timeline([
      { hints: 3, day: 10 }, { hints: 3, day: 9 }, { hints: 2, day: 8 },
      { hints: 0, day: 2 }, { hints: 0, day: 1 }, { hints: 0, day: 0 },
    ]);
    expect(computeTrend(recs).direction).toBe('improving');
  });

  it('says needs-work when recent struggle is higher than earlier', () => {
    const recs = timeline([
      { hints: 0, day: 10 }, { hints: 0, day: 9 }, { hints: 0, day: 8 },
      { hints: 3, day: 2 }, { hints: 3, day: 1 }, { hints: 2, day: 0 },
    ]);
    expect(computeTrend(recs).direction).toBe('needs-work');
  });

  it('says flat when recent and earlier are within epsilon', () => {
    const recs = timeline([
      { hints: 1, day: 10 }, { hints: 1, day: 9 }, { hints: 1, day: 8 },
      { hints: 1, day: 2 }, { hints: 1, day: 1 }, { hints: 1, day: 0 },
    ]);
    expect(computeTrend(recs).direction).toBe('flat');
  });

  it('is ORDER-relative, not wall-clock: shifting all dates later does not change direction', () => {
    const base = timeline([
      { hints: 3, day: 10 }, { hints: 3, day: 9 }, { hints: 2, day: 8 },
      { hints: 0, day: 2 }, { hints: 0, day: 1 }, { hints: 0, day: 0 },
    ]);
    const shifted = base.map(r => ({ ...r, firstSolvedAt: r.firstSolvedAt + 100 * DAY }));
    expect(computeTrend(shifted).direction).toBe(computeTrend(base).direction);
  });
});

// ===========================================================================
// R5 — dashboard
// ===========================================================================

describe('computeInsights — dashboard (R5)', () => {
  it('counts difficulty mix, pattern coverage, active days, and review candidates', () => {
    const d1 = Date.parse('2026-10-01T10:00:00Z');
    const d2 = Date.parse('2026-10-02T10:00:00Z');
    const records = [
      record({ patterns: ['Hash Map'], difficulty: 'Easy', bestAttemptIndex: 0, attempts: [attempt('solved', 0, { time: 'O(n)', space: 'O(n)' }, { date: d1 })] }),
      record({ patterns: ['Graph'], difficulty: 'Hard', bestAttemptIndex: 0, attempts: [
        attempt('solved', 0, { time: 'O(n^2)', space: 'O(1)' }, { date: d2, optimalComplexity: { time: 'O(n)', space: 'O(n)' } }),
      ] }),
    ];
    const dash = computeInsights(records).dashboard;
    expect(dash.byDifficulty).toEqual({ Easy: 1, Medium: 0, Hard: 1 });
    expect(dash.patternCoverage).toBe(2);
    expect(dash.activeDays).toBe(2);
    expect(dash.reviewedCandidates).toBe(1); // the Graph O(n^2) vs O(n)
    expect(dash.lastActiveAt).toBe(d2);
  });
});

describe('constants', () => {
  it('TREND_MIN_PROBLEMS is 5', () => {
    expect(TREND_MIN_PROBLEMS).toBe(5);
  });
});
