import { describe, it, expect } from 'vitest';
import { buildSessionDigest, extractSessionFacts, buildRecordProjection } from '../session-digest';
import type {
  LearningContent,
  ProgressState,
  AnalyzeData,
  UnderstandData,
  ReportData,
  ActionType,
} from '../../types';

/**
 * Unit tests for the deterministic session digest + record projection.
 *
 * These are pure functions that read the structured `data` off the session
 * history rather than re-summarizing prose. The key behaviors to pin:
 *  - digest is empty when there's nothing structured (caller falls back);
 *  - digest reflects what the user ACTUALLY did (hints, analyses, patterns);
 *  - the record projection treats the REPORT as authoritative, with session
 *    facts only as fallback, and stores the ACHIEVED complexity honestly.
 */

let idSeq = 0;
function content(actionType: ActionType, extra: Partial<LearningContent['metadata']> = {}): LearningContent {
  return {
    id: `c${idSeq++}`,
    type: 'FEEDBACK',
    actionType,
    content: 'prose',
    timestamp: Date.now(),
    expanded: false,
    metadata: extra,
  };
}

function analyze(d: Partial<AnalyzeData> = {}): AnalyzeData {
  return {
    approachDetected: 'brute-force nested loop',
    currentComplexity: { time: 'O(n^2)', space: 'O(1)' },
    optimalComplexity: { time: 'O(n)', space: 'O(n)' },
    issues: ['recomputes complement'],
    onOptimalPath: false,
    ...d,
  };
}

function understand(d: Partial<UnderstandData> = {}): UnderstandData {
  return {
    patterns: ['Hash Map'],
    keyInsight: 'store complements as you go',
    optimalComplexity: { time: 'O(n)', space: 'O(n)' },
    ...d,
  };
}

function progress(hintLevel: number): ProgressState {
  return {
    problemUrl: 'https://leetcode.com/problems/two-sum/',
    usedActions: new Set(),
    hintLevel,
    contentHistory: [],
    lastUpdated: Date.now(),
  };
}

describe('buildSessionDigest', () => {
  it('returns empty string when there is nothing structured', () => {
    expect(buildSessionDigest([], null)).toBe('');
    // A non-hint, non-query, no-data entry contributes nothing to the digest.
    expect(buildSessionDigest([content('BREAK_DOWN_PROBLEM')], progress(0))).toBe('');
  });

  it('reports a GET_HINT entry even when hintLevel is 0 (a hint was used)', () => {
    const digest = buildSessionDigest([content('GET_HINT')], progress(0));
    expect(digest).toContain('Hints used: 1');
  });

  it('reports hint usage with the depth reached', () => {
    const digest = buildSessionDigest([content('GET_HINT'), content('GET_HINT')], progress(2));
    expect(digest).toContain('Hints used: 2');
    expect(digest).toContain('approach-level hint');
  });

  it('summarizes a single analysis with its complexity and path', () => {
    const digest = buildSessionDigest(
      [content('CHECK_APPROACH', { structured: analyze() })],
      progress(0),
    );
    expect(digest).toContain('Analyzed their code once');
    expect(digest).toContain('brute-force nested loop');
    expect(digest).toContain('O(n^2) time / O(1) space');
    expect(digest).toContain('not yet on the optimal path');
  });

  it('summarizes multiple analyses as a first->latest progression', () => {
    const first = content('CHECK_APPROACH', { structured: analyze({ approachDetected: 'first' }) });
    const last = content('CHECK_APPROACH', {
      structured: analyze({ approachDetected: 'latest', currentComplexity: { time: 'O(n)', space: 'O(n)' } }),
    });
    const digest = buildSessionDigest([first, last], progress(0));
    expect(digest).toContain('Analyzed their code 2 times');
    expect(digest).toContain('first attempt "first"');
    expect(digest).toContain('latest "latest"');
  });

  it('includes UNDERSTAND_SOLUTION patterns + key insight', () => {
    const digest = buildSessionDigest(
      [content('UNDERSTAND_SOLUTION', { structured: understand() })],
      progress(0),
    );
    expect(digest).toContain('Pattern(s): Hash Map');
    expect(digest).toContain('store complements as you go');
  });

  it('counts free-form user questions', () => {
    const digest = buildSessionDigest(
      [content('CHECK_APPROACH', { structured: analyze() }), content('GET_HINT', { isUserQuery: true })],
      progress(0),
    );
    expect(digest).toContain('Asked 1 free-form question');
  });

  // B10 — the digest must emit ONE reconciled optimal line, never two
  // conflicting ones (an analysis' optimal AND an understanding's optimal).
  describe('B10 — single reconciled optimal line', () => {
    it('emits exactly one "optimal" line (not a per-analysis + per-understanding pair)', () => {
      const digest = buildSessionDigest(
        [
          content('CHECK_APPROACH', { structured: analyze({ optimalComplexity: { time: 'O(n)', space: 'O(n)' } }) }),
          content('UNDERSTAND_SOLUTION', { structured: understand({ optimalComplexity: { time: 'O(n log n)', space: 'O(1)' } }) }),
        ],
        progress(0),
      );
      // Match lines that state an optimal COMPLEXITY VALUE (not the "optimal
      // path" phrase on the analysis line). Exactly one — the reconciled line.
      const optimalLines = digest.split('\n').filter((l) => /optimal complexity/i.test(l));
      expect(optimalLines).toHaveLength(1);
      expect(optimalLines[0]).toContain('Canonical optimal');
    });

    it('prefers the PINNED optimal over the analysis/understanding values', () => {
      const digest = buildSessionDigest(
        [content('CHECK_APPROACH', { structured: analyze({ optimalComplexity: { time: 'O(n)', space: 'O(n)' } }) })],
        progress(0),
        { time: 'O(N*M)', space: 'O(N*M)' }, // the pin
      );
      expect(digest).toContain('Canonical optimal complexity for this problem: O(N*M) time / O(N*M) space');
      // The drifted O(n) is NOT presented as the optimal.
      expect(digest).not.toMatch(/optimal.*O\(n\) time \/ O\(n\) space/i);
    });

    it('the analysis line still reports the CURRENT (achieved) complexity, which is not pinned', () => {
      const digest = buildSessionDigest(
        [content('CHECK_APPROACH', { structured: analyze({ currentComplexity: { time: 'O(n^2)', space: 'O(1)' } }) })],
        progress(0),
        { time: 'O(N*M)', space: 'O(N*M)' },
      );
      // Current is reported from the analysis; optimal is the pin — they differ.
      expect(digest).toContain('O(n^2) time / O(1) space');
      expect(digest).toContain('Canonical optimal complexity for this problem: O(N*M)');
    });

    it('falls back to the latest understanding, then analysis, when no pin is given', () => {
      const digest = buildSessionDigest(
        [content('UNDERSTAND_SOLUTION', { structured: understand({ optimalComplexity: { time: 'O(V+E)', space: 'O(V)' } }) })],
        progress(0),
      );
      expect(digest).toContain('Canonical optimal complexity for this problem: O(V+E) time / O(V) space');
    });
  });
});

describe('extractSessionFacts', () => {
  it('returns empty-ish facts for an empty session', () => {
    const facts = extractSessionFacts([], null);
    expect(facts.patterns).toEqual([]);
    expect(facts.optimalComplexity).toBeNull();
    expect(facts.achievedComplexity).toBeNull();
    expect(facts.approachSummary).toBe('');
    expect(facts.onOptimalPath).toBe(false);
    expect(facts.hintsUsed).toBe(0);
  });

  it('pulls achieved complexity + approach from the latest analysis', () => {
    const facts = extractSessionFacts(
      [
        content('CHECK_APPROACH', { structured: analyze({ approachDetected: 'old' }) }),
        content('CHECK_APPROACH', {
          structured: analyze({ approachDetected: 'new', currentComplexity: { time: 'O(n log n)', space: 'O(n)' } }),
        }),
      ],
      progress(1),
    );
    expect(facts.approachSummary).toBe('new');
    expect(facts.achievedComplexity).toEqual({ time: 'O(n log n)', space: 'O(n)' });
    expect(facts.hintsUsed).toBe(1);
  });

  it('unions patterns across multiple understandings', () => {
    const facts = extractSessionFacts(
      [
        content('UNDERSTAND_SOLUTION', { structured: understand({ patterns: ['Hash Map'] }) }),
        content('UNDERSTAND_SOLUTION', { structured: understand({ patterns: ['Hash Map', 'Two Pointers'] }) }),
      ],
      null,
    );
    expect(facts.patterns).toEqual(['Hash Map', 'Two Pointers']);
  });

  it('prefers understanding optimal complexity over analysis optimal', () => {
    const facts = extractSessionFacts(
      [
        content('CHECK_APPROACH', { structured: analyze({ optimalComplexity: { time: 'O(n)', space: 'O(1)' } }) }),
        content('UNDERSTAND_SOLUTION', { structured: understand({ optimalComplexity: { time: 'O(n)', space: 'O(n)' } }) }),
      ],
      null,
    );
    expect(facts.optimalComplexity).toEqual({ time: 'O(n)', space: 'O(n)' });
  });
});

describe('buildRecordProjection — report is authoritative', () => {
  const reportData = (d: Partial<ReportData> = {}): ReportData => ({
    patterns: ['Hash Map'],
    approachSummary: 'single-pass hash map',
    optimalComplexity: { time: 'O(n)', space: 'O(n)' },
    solvedOptimally: true,
    ...d,
  });

  it('uses report approach/patterns over stale session facts', () => {
    const facts = extractSessionFacts(
      [content('CHECK_APPROACH', { structured: analyze({ approachDetected: 'stale brute force' }) })],
      progress(0),
    );
    const proj = buildRecordProjection(facts, reportData(), '# Report', 'python');
    expect(proj.attempt.approachSummary).toBe('single-pass hash map');
    expect(proj.attempt.outcome).toBe('solved');
    expect(proj.attempt.language).toBe('python');
    expect(proj.patterns).toContain('Hash Map');
  });

  it('when solvedOptimally, achieved complexity equals the optimal', () => {
    const facts = extractSessionFacts(
      [content('CHECK_APPROACH', { structured: analyze({ currentComplexity: { time: 'O(n^2)', space: 'O(1)' } }) })],
      progress(0),
    );
    const proj = buildRecordProjection(facts, reportData({ solvedOptimally: true }), '# Report');
    expect(proj.attempt.complexity).toEqual({ time: 'O(n)', space: 'O(n)' });
  });

  it('when NOT solved optimally, stores the measured (non-optimal) complexity', () => {
    const facts = extractSessionFacts(
      [content('CHECK_APPROACH', { structured: analyze({ currentComplexity: { time: 'O(n^2)', space: 'O(1)' } }) })],
      progress(0),
    );
    const proj = buildRecordProjection(facts, reportData({ solvedOptimally: false }), '# Report');
    expect(proj.attempt.outcome).toBe('attempted');
    expect(proj.attempt.complexity).toEqual({ time: 'O(n^2)', space: 'O(1)' });
  });

  it('falls back to session facts when there is no report data', () => {
    const facts = extractSessionFacts(
      [content('CHECK_APPROACH', { structured: analyze({ approachDetected: 'my approach', onOptimalPath: true }) })],
      progress(2),
    );
    const proj = buildRecordProjection(facts, null, '# Report');
    expect(proj.attempt.approachSummary).toBe('my approach');
    expect(proj.attempt.outcome).toBe('solved'); // onOptimalPath -> solved
    expect(proj.attempt.hintsUsed).toBe(2);
  });

  it('degrades to placeholders when nothing is available', () => {
    const facts = extractSessionFacts([], null);
    const proj = buildRecordProjection(facts, null, '');
    expect(proj.attempt.complexity).toEqual({ time: 'O(?)', space: 'O(?)' });
    expect(proj.attempt.approachSummary).toBe('Approach not captured.');
    expect(proj.attempt.outcome).toBe('attempted');
  });

  it('stores the report markdown as the solution summary', () => {
    const facts = extractSessionFacts([], null);
    const proj = buildRecordProjection(facts, reportData(), '# My Report\nnotes');
    expect(proj.attempt.solutionSummary).toBe('# My Report\nnotes');
  });

  // v2 (progress-insights-overhaul) — the two new projected fields.
  describe('v2 — usedActions + optimalComplexity projection', () => {
    it('defaults usedActions to [] when the arg is omitted (never undefined)', () => {
      const proj = buildRecordProjection(extractSessionFacts([], null), reportData(), '# R');
      expect(proj.attempt.usedActions).toEqual([]);
    });

    it('projects + dedupes the usedActions array onto the attempt', () => {
      const proj = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', 'python',
        ['GET_HINT', 'CHECK_APPROACH', 'GET_HINT'],
      );
      expect(proj.attempt.usedActions).toEqual(['GET_HINT', 'CHECK_APPROACH']);
    });

    it('attaches optimalComplexity when a pinned optimal is provided', () => {
      const proj = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', undefined,
        [], { time: 'O(n)', space: 'O(1)' },
      );
      expect(proj.attempt.optimalComplexity).toEqual({ time: 'O(n)', space: 'O(1)' });
    });

    it('OMITS optimalComplexity when the pinned optimal is null (never fabricates O(?))', () => {
      const proj = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', undefined, [], null,
      );
      expect('optimalComplexity' in proj.attempt).toBe(false);
    });

    it('OMITS optimalComplexity when the pin is a half-empty pair', () => {
      const proj = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', undefined, [],
        { time: 'O(n)', space: '' },
      );
      expect('optimalComplexity' in proj.attempt).toBe(false);
    });

    it('projects a positive chatCount; omits it when zero (old-record parity)', () => {
      const withChat = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', undefined, [], null, 3,
      );
      expect(withChat.attempt.chatCount).toBe(3);
      const noChat = buildRecordProjection(
        extractSessionFacts([], null), reportData(), '# R', undefined, [], null, 0,
      );
      expect('chatCount' in noChat.attempt).toBe(false);
    });
  });
});
