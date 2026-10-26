# Optimize-Nudge Action — Idea Capture (NOT scheduled)

> **Status: 📝 Idea only — captured 2026-10-20, NOT yet scheduled.** Written down
> so it survives the session boundary. **Do not build this yet** — per the user,
> the insights overhaul (`leetsage-progress-insights-overhaul`) comes first, then
> this. This file is a placeholder to hold the idea + the open design question, not
> a worked design.
>
> This is a design-only stub (no requirements/tasks yet) because it's a captured
> idea, not an active feature. When it's scheduled, promote it to a full spec.

## The idea

A coaching response that pushes a user toward the OPTIMAL solution when their code
is correct-but-suboptimal — modeled on the one external tool the user reaches for
most (LeetCode's own AI "Optimize Solution" option), but **on LeetSmith's
identity**.

**The crucial difference (this is the whole point):** LeetCode's "Optimize
Solution" hands over the **entire optimized code** (observed 2026-10-20: it
returned a complete `class Solution` implementation). LeetSmith must NOT. Instead
it gives a **hard nudge toward optimal**:
- what in their current approach is suboptimal (the bottleneck),
- the complexity gap (their achieved Big-O vs. the optimal Big-O),
- WHICH parts can improve and the DIRECTION of the improvement (the insight / the
  technique to reach for),
- **without writing the optimal code for them.**

This is squarely on-identity: "teach, never solve." It's the *optimization* analog
of the existing hint ladder — a push, not an answer.

## Why it's compelling

- It targets the single most-reached-for external behavior (the user's own usage
  of LeetCode's optimizer), so there's demonstrated demand.
- It's a natural fit for the product's differentiator: the whole value is that it
  stops at the nudge where the competitor hands over the answer.
- Much of the machinery already exists: `CHECK_APPROACH` already computes
  achieved-vs-optimal complexity and `onOptimalPath`; the complexity PIN already
  holds the canonical optimal; the solution-filter already blocks full solutions.

## The open design question (decide when scheduled)

**Is this a NEW action, or folded into Analyze (`CHECK_APPROACH`)?**
- **New dedicated action** (e.g. `OPTIMIZE_NUDGE`): cleaner intent, its own prompt
  tuned for "nudge toward optimal," its own card. Cost: a 5th chip (the bar is
  deliberately 4) or it lives only behind chat-intent-routing. Adds a 10th
  `ActionType`.
- **Folded into Analyze:** reuses the code-reading + complexity machinery, but the
  Analyze card is **already crowded** (Approach / Efficiency / Code Style, and the
  Efficiency block already shows current-vs-optimal). Adding an "how to optimize"
  section risks overloading it further (and the user flagged the card is busy).

Leaning (tentative, revisit at scheduling): a **separate action reachable via
chat-intent-routing** (type "how do I optimize this?" / "make it faster") rather
than a 5th always-visible chip — keeps the 4-chip bar, reuses the routing seam the
retired actions already use, and gives the nudge its own focused prompt + card.

## Guardrail note (must hold when built)

The nudge is **NON-EXEMPT** — it must pass through `filterResponse` like Hint. The
risk: "here's how to optimize" prompts drift toward writing the optimal code. The
prompt must push insight + direction + the complexity target, and the deterministic
filter stays the backstop. Do NOT add it to `SOLUTION_EXEMPT_ACTIONS`. (Unlike
`UNDERSTAND_SOLUTION`, which IS exempt because its job is to explain the optimal
solution — the optimize-nudge deliberately withholds it.)

## Dependencies / sequencing

1. `leetsage-progress-insights-overhaul` ships FIRST (user's call, 2026-10-20).
2. Then schedule this: promote to a full spec (requirements → design → tasks),
   resolve the new-action-vs-Analyze question, with the guardrail note above.
