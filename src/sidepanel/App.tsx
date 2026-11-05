import React, { useState, useEffect, useCallback } from 'react';
import QuickActions from '../components/QuickActions';
import ContentDisplay from '../components/ContentDisplay';
import SettingsModal from '../components/SettingsModal';
import ProgressView from '../components/ProgressView';
import { StuckTimer } from '../services/stuck-timer';
import type { ProblemContext, ProgressState, LearningContent, ActionType, UserSettings, StuckSuggestion } from '../types';
import { loadProgress, trackAction, appendContent, clearProgress, markReportSaved } from '../services/progress-tracker';
import { getSettings, saveSettings } from '../services/storage';
import { streamLLMRequest, sendToolRound, buildChatData, regenerateWithoutSolution } from '../services/llm-service';
import { filterResponse, isSolutionExemptAction } from '../services/solution-filter';
import { decideRecovery, resolveRegenerated } from '../services/filter-recovery';
import { checkRateLimit, checkHardBudget, recordRequest, getUsageToday } from '../services/rate-limiter';
import { recordMetric } from '../services/metrics-store';
import { extractCurrentCode } from '../services/code-extractor';
import { parseStructuredResponse, stripDataBlockForDisplay } from '../services/structured-parser';
import { buildSessionDigest, extractSessionFacts, buildRecordProjection } from '../services/session-digest';
import { saveAttempt, slugFromUrl } from '../services/progress-records';
import { getComplexityPin, recordOptimalPin, clearComplexityPin } from '../services/complexity-pin';
import { routeMessage } from '../services/intent-router';
import {
  classifyPullResult,
  decidePullAction,
  DELAY_MS,
  POST_INJECT_DELAY_MS,
} from '../services/active-tab-pull';
import ConfirmAffordance from '../components/ConfirmAffordance';
import UsageReservoir from '../components/UsageReservoir';
import WelcomeCard from '../components/WelcomeCard';
import { PLACEHOLDER_EXAMPLES, TRY_ASKING_CHIPS, resolveSubmitText, chatPlaceholder } from '../components/discovery-prompts';
import { getChatAgentSystemPrompt, wrapUntrusted, wrapToolResult } from '../services/prompts';
import { buildConversationWindow } from '../services/chat-window';
import { toolSpecs, toolLabel, runTool, type ToolContext } from '../services/chat-tools';
import { runChatAgent } from '../services/chat-agent';

function generateId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }

/** Resolves the active tab's id if it's a LeetCode problem page, else null. */
function getActiveLeetCodeTabId(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      resolve(tab?.id && tab.url?.includes('leetcode.com/problems/') ? tab.id : null);
    });
  });
}

function actionToContentType(actionType: ActionType): LearningContent['type'] {
  const map: Record<ActionType, LearningContent['type']> = {
    GET_HINT: 'HINT', GENERATE_EXAMPLES: 'EXAMPLES', BREAK_DOWN_PROBLEM: 'BREAKDOWN',
    EXPLAIN_CONCEPT: 'EXPLANATION', CHECK_APPROACH: 'FEEDBACK', TIME_COMPLEXITY_HINT: 'HINT', PATTERN_RECOGNITION: 'EXPLANATION',
    UNDERSTAND_SOLUTION: 'EXPLANATION', GENERATE_REPORT: 'EXPLANATION',
  };
  return map[actionType];
}

const App: React.FC = () => {
  const [problemContext, setProblemContext] = useState<ProblemContext | null>(null);
  // R4 (off-page gating): is the ACTIVE TAB a coachable LeetCode problem page?
  // This is a URL-based signal (set from chrome.tabs), DELIBERATELY independent
  // of `problemContext` — the problem context is pull-based and null for a
  // multi-second window on a REAL problem page during the MV3 load/retry, so
  // gating inputs on `!!problemContext` would wrongly disable them on a genuine
  // page (violating the R4.4 hard bar). The URL matches immediately on a real
  // page, so it never false-negatives. See .kiro/specs/leetsage-coaching-logic-overhaul §2.
  const [activeTabIsProblem, setActiveTabIsProblem] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [learningContent, setLearningContent] = useState<LearningContent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  // E4: re-openable welcome overlay (the header "?" button). The welcome also
  // shows automatically as the empty state; this lets users revisit it any time.
  const [showWelcome, setShowWelcome] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [stuckSuggestion, setStuckSuggestion] = useState<StuckSuggestion | null>(null);
  const [usageCount, setUsageCount] = useState(0);
  // E9: the agentic chat loop's current PROCESS step label ("Reading your
  // code…", "Answering…") shown on the streaming card's thinking placeholder.
  // Process-only (never answer content) — safe to show live. null when idle.
  const [agentStepLabel, setAgentStepLabel] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  // Tracks whether the chat input is focused, so the decorative "you can type
  // here" blinking caret only shows while the field is empty AND unfocused
  // (the real text caret takes over on focus — never two carets at once).
  const [chatFocused, setChatFocused] = useState(false);
  // Chat intent routing: a pending confirm affordance (exempt guardrail OR the
  // borderline `ask` outcome). `query` is the original message so "Just answer"
  // can fall through to chat with it. See .kiro/specs/leetsage-chat-intent-routing.
  const [pendingConfirm, setPendingConfirm] = useState<{ action: ActionType; reason: 'exempt' | 'borderline'; query: string } | null>(null);
  // Discovery (R8): rotating-placeholder index + a dismissible "Try asking…" row.
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [showTryChips, setShowTryChips] = useState(true);
  // "Reset this problem" is destructive (wipes the session's history +
  // progress), so it's a two-step confirm rather than a one-tap action.
  const [confirmReset, setConfirmReset] = useState(false);
  const stuckTimerRef = React.useRef<StuckTimer | null>(null);

  // Always-fresh mirror of learningContent. handleActionClick is a useCallback
  // that does NOT list learningContent as a dependency (to avoid recreating it
  // on every streamed chunk), so the closure's learningContent goes stale.
  // buildSessionDigest for the report must read the CURRENT history, so we read
  // it through this ref instead of the captured variable.
  const learningContentRef = React.useRef<LearningContent[]>([]);
  useEffect(() => { learningContentRef.current = learningContent; }, [learningContent]);

  // Applies a freshly obtained problem context to state + loads its progress.
  const applyProblem = useCallback((ctx: ProblemContext) => {
    setProblemContext(prev => {
      // Same problem (URL is normalized to /problems/{slug}/, so it's stable
      // across submissions/tab changes): keep the live in-memory content and
      // progress as-is. Re-extraction on submit must NOT wipe the session.
      if (prev && prev.url === ctx.url) return ctx;

      // Genuinely a different problem: reset transient content and load that
      // problem's saved progress/history.
      setLearningContent([]);
      loadProgress(ctx.url).then(p => { setProgress(p); if (p) setLearningContent(p.contentHistory); });
      return ctx;
    });
  }, []);

  // Pull problem data directly from the active tab's content script.
  // This is the reliable path — the panel asks when it's ready, avoiding
  // the MV3 race where the background worker is asleep at page-load time.
  //
  // Retries with backoff: on a fresh page load the content script may not be
  // injected yet, or its initial extraction may still be running, so a single
  // request can come back empty. We retry a few times over a few seconds.
  // `attempt` counts message round-trips; `hasInjected` is a one-shot guard so
  // we inject content.js at most once per pull cycle (B21). The decision of
  // what to do after each round-trip lives in the pure `decidePullAction` brain
  // (src/services/active-tab-pull.ts) so it's unit-testable without chrome.*.
  const pullFromActiveTab = useCallback((attempt = 0, hasInjected = false) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      // R4: update the URL-based "on a problem page" flag on every pull cycle —
      // this is the gating signal, and it's correct whether or not the pull
      // ultimately succeeds in loading the context.
      const onProblemPage = !!tab?.url?.includes('leetcode.com/problems/');
      setActiveTabIsProblem(onProblemPage);
      if (!tab?.id || !onProblemPage) return;
      const tabId = tab.id;

      const ask = () => chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PROBLEM_DATA' }, (response) => {
        const lastError = chrome.runtime.lastError;
        const outcome = classifyPullResult(response, lastError?.message);
        const next = decidePullAction(outcome, { attempt, hasInjected });

        switch (next) {
          case 'apply':
            applyProblem(response!.data as ProblemContext);
            return;

          case 'inject':
            // No content script on this tab — happens on a LeetCode tab that was
            // open BEFORE the extension was (re)installed (Chrome only
            // auto-injects on fresh loads). Inject content.js once, then re-pull
            // with hasInjected=true so we don't inject again, and keep retrying
            // across the wider window until the already-rendered page is scraped.
            chrome.scripting.executeScript(
              { target: { tabId }, files: ['content.js'] },
              () => {
                void chrome.runtime.lastError; // swallow a benign re-inject error
                setTimeout(() => pullFromActiveTab(attempt + 1, true), POST_INJECT_DELAY_MS);
              }
            );
            return;

          case 'retry':
            setTimeout(() => pullFromActiveTab(attempt + 1, hasInjected), DELAY_MS);
            return;

          case 'giveup':
          default:
            return;
        }
      });

      ask();
    });
  }, [applyProblem]);

  useEffect(() => {
    // 1) Fast path: show whatever is cached in storage immediately.
    chrome.storage.local.get('problemData', (result) => {
      if (result.problemData) applyProblem(result.problemData as ProblemContext);
    });

    // 2) Reliable path: actively pull the current problem from the tab.
    pullFromActiveTab();

    // 3) Keep in sync when the user switches tabs or navigates.
    const onActivated = () => { pullFromActiveTab(); };
    const onUpdated = (_tabId: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (info.status === 'complete' && tab.active) { pullFromActiveTab(); }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    // 4) Still honor storage changes (push path) as a bonus.
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.problemData?.newValue) applyProblem(changes.problemData.newValue as ProblemContext);
    };
    chrome.storage.onChanged.addListener(storageListener);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, [applyProblem, pullFromActiveTab]);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      stuckTimerRef.current = new StuckTimer((suggestion) => setStuckSuggestion(suggestion), s.enableStuckTimer);
    });
    getUsageToday().then(u => setUsageCount(u.count));

    // Refresh the usage counter whenever the panel becomes visible again.
    // getUsageToday() keys on the current date, so this also clears a stale
    // count left over from a previous day (the daily reset).
    const onVisible = () => { if (!document.hidden) getUsageToday().then(u => setUsageCount(u.count)); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (problemContext) {
      stuckTimerRef.current?.start({
        difficulty: problemContext.difficulty,
        hintsExhausted: (progress?.hintLevel ?? 0) >= 3,
      });
    }
  }, [problemContext?.url, progress?.hintLevel]);

  // Discovery (R8): cycle the placeholder examples so users learn the intents
  // that lost their buttons. Purely presentational — no API call. Pauses while
  // the user is typing (a non-empty input keeps a static placeholder). A calm
  // 5s cadence so each suggestion is comfortably readable.
  useEffect(() => {
    if (chatInput.trim()) return;
    const id = setInterval(() => {
      setPlaceholderIdx(i => (i + 1) % PLACEHOLDER_EXAMPLES.length);
    }, 5000);
    return () => clearInterval(id);
  }, [chatInput]);

  // R6/R6b: graceful filter recovery shared by BOTH filter callers
  // (handleActionClick + handleChatSubmit) so behavior can't diverge. Runs the
  // (pure, sync) filter, then:
  //   - clean/partial → return the content as-is (partial keeps teaching; no
  //     regenerate, no credit spent — R6.8.3).
  //   - full → if the budget allows, spend ONE counted regenerate; re-filter it;
  //     show it when clean, else the reworded full message. Never a 2nd regen.
  // `regenParams` carries what regenerateWithoutSolution needs to re-issue the
  // SAME action/chat request (problemContext + action + userCode/userQuery).
  // See .kiro/specs/leetsage-coaching-logic-overhaul §4.3–§4.5.
  const recoverFilteredResponse = useCallback(async (
    prose: string,
    actionType: ActionType,
    regenParams: { userApproach?: string; userCode?: string; codeLanguage?: string; userQuery?: string },
  ): Promise<string> => {
    if (!settings?.apiConfig.apiKey || !problemContext) {
      return filterResponse(prose, actionType).filteredContent;
    }
    const filtered = filterResponse(prose, actionType);
    // Only the `full` branch may regenerate; check the budget first (R6.9.2).
    // Fix 1a: the regenerate is a CONTINUATION of this already-paid request, so
    // only the HARD limits (kill switch + daily cap) gate it — not the soft
    // per-minute/cooldown pacing (which would otherwise skip the regenerate
    // during rapid testing and leave the user with the bare fallback).
    let budgetAllowed = false;
    if (filtered.wasFiltered && filtered.redactionMode === 'full') {
      budgetAllowed = (await checkHardBudget(settings.guardrails)).allowed;
    }
    const decision = decideRecovery(filtered, { budgetAllowed });

    if (decision === 'show-clean' || decision === 'show-partial' || decision === 'show-full') {
      return filtered.filteredContent;
    }

    // decision === 'regenerate' — ONE bounded, counted retry (R6.8/R6.9.1).
    try {
      const usage = await recordRequest();
      setUsageCount(usage.count);
      const startedAt = performance.now();
      const regen = await regenerateWithoutSolution({
        problemContext, actionType, systemPrompt: '', userMessage: '',
        apiKey: settings.apiConfig.apiKey, model: settings.apiConfig.model,
        maxTokens: settings.guardrails.maxTokens, timeoutMs: settings.guardrails.requestTimeoutMs,
        userApproach: regenParams.userApproach, userCode: regenParams.userCode,
        codeLanguage: regenParams.codeLanguage, userQuery: regenParams.userQuery,
      });
      void recordMetric({
        model: settings.apiConfig.model,
        latencyMs: performance.now() - startedAt,
        usage: regen.usage,
      }).catch(() => { /* metrics are non-critical */ });
      // Re-filter the regenerated answer ONCE; show it when clean, else the
      // reworded full message (never a second regenerate).
      const regenFilter = filterResponse(regen.content, actionType);
      return resolveRegenerated(regen.content, regenFilter, filtered.filteredContent);
    } catch {
      // A regenerate failure (network/timeout) must not lose the response — fall
      // back to the reworded full message we already have.
      return filtered.filteredContent;
    }
  }, [settings, problemContext]);

  const handleActionClick = useCallback(async (actionType: ActionType, userApproach?: string) => {
    if (!settings?.apiConfig.apiKey) return;
    // R4.4: inputs are gated on the URL signal, so a click can arrive on a real
    // problem page while the context pull is still in flight. Surface an honest,
    // transient "still reading" message instead of a silent no-op or an
    // ungrounded answer. pullFromActiveTab is already racing to fill the context.
    if (!problemContext) {
      if (activeTabIsProblem) setError('Still reading this problem — give it a moment and try again.');
      return;
    }

    // The user is interacting — dismiss any stale "are you stuck?" suggestion.
    setStuckSuggestion(null);

    // Guardrail pre-check: kill switch, daily/per-minute caps, cooldown.
    const check = await checkRateLimit(settings.guardrails);
    if (!check.allowed) {
      const wait = check.retryAfterMs ? ` (try again in ${Math.ceil(check.retryAfterMs / 1000)}s)` : '';
      setError((check.reason ?? 'Request blocked by rate limits.') + wait);
      return;
    }

    // For code-aware actions: read the user's current editor code first so the
    // analysis is grounded in what they've actually written. R2/B15: the read
    // now returns a discriminated ok | empty | failed status so we never send a
    // partial scrape or treat a failed read as "empty".
    let userCode: string | undefined;
    let codeLanguage: string | undefined;
    let codeReadStatus: 'ok' | 'empty' | 'failed' | undefined;
    if (actionType === 'CHECK_APPROACH' || actionType === 'UNDERSTAND_SOLUTION' || actionType === 'GENERATE_REPORT' || actionType === 'TIME_COMPLEXITY_HINT') {
      const tabId = await getActiveLeetCodeTabId();
      if (tabId != null) {
        const extracted = await extractCurrentCode(tabId);
        codeReadStatus = extracted.status;
        if (extracted.status === 'ok') { userCode = extracted.code; codeLanguage = extracted.language; }
      } else {
        codeReadStatus = 'failed';
      }

      // CHECK_APPROACH ("Analyze my code") is ONLY meaningful with the user's
      // actual, fully-captured code. If the read failed, refuse to run a generic
      // analysis (the old behavior silently analyzed as if the editor were
      // empty, producing confident-but-wrong advice). Surface an honest error so
      // the user can retry. UNDERSTAND_SOLUTION / GENERATE_REPORT can still
      // proceed without code (they explain/record the optimal), so only
      // CHECK_APPROACH hard-stops here.
      if (actionType === 'CHECK_APPROACH' && codeReadStatus === 'failed') {
        setError("Couldn't read your editor code. Make sure you're on the problem's Code tab, then try again.");
        return;
      }
    }

    // B10: read the canonical pinned optimal for this problem (if any). It is
    // fed into the prompt as a hard constraint so the model stops re-guessing
    // (and drifting on) the optimal. UNDERSTAND_SOLUTION is the canonical
    // authority and may OVERRIDE the pin, so we do NOT constrain it with the
    // existing pin (buildUserMessage's UNDERSTAND_SOLUTION case ignores it); we
    // still re-pin from whatever it emits below. See services/complexity-pin.ts.
    const existingPin = await getComplexityPin(slugFromUrl(problemContext.url));
    const pinnedOptimal = actionType === 'UNDERSTAND_SOLUTION' ? undefined : existingPin?.optimal;

    // For the report, assemble a deterministic digest of the session's
    // structured activity so the report reflects what the user actually did
    // rather than a generic writeup (see session-digest.ts). B10: feed the
    // pinned optimal so the digest emits ONE reconciled optimal line.
    const sessionDigest = actionType === 'GENERATE_REPORT'
      ? buildSessionDigest(learningContentRef.current, progress, existingPin?.optimal)
      : undefined;

    setIsLoading(true); setError(null);
    const contentId = generateId();
    setStreamingId(contentId);
    const newContent: LearningContent = {
      id: contentId, type: actionToContentType(actionType), actionType, content: '', timestamp: Date.now(), expanded: true,
      metadata: actionType === 'GET_HINT' ? { hintLevel: (progress?.hintLevel ?? 0) + 1 } : undefined,
    };
    setLearningContent(prev => [...prev, newContent]);
    try {
      // Record the request against today's usage (counts toward the caps).
      const usage = await recordRequest();
      setUsageCount(usage.count);

      let fullContent = '';
      // B1 pre-display gate: for NON-EXEMPT actions the guardrail (filterResponse)
      // must run BEFORE any model content is shown, so a leak is never briefly
      // visible. We accumulate tokens in `fullContent` but do NOT render them
      // mid-stream; the card shows an animated "thinking" placeholder (driven by
      // an empty `content` + streamingId in ContentDisplay) until we commit the
      // filtered result below. EXEMPT actions (solutions allowed, filter bypassed)
      // keep streaming live for responsive UX.
      // See .kiro/specs/leetsage-guardrail-hardening (B1).
      const streamLive = isSolutionExemptAction(actionType);
      // Runtime metrics: wall-clock latency around the call + token usage if the
      // stream surfaces it. Recorded best-effort after the stream (see below).
      const startedAt = performance.now();
      let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;
      // B29: the stream sets this when it ended on a token-cap cutoff
      // (finish_reason 'length') so we can append an honest "cut off" cue to the
      // finalized card instead of presenting a truncated answer as complete.
      let wasCutOff = false;
      for await (const chunk of streamLLMRequest({
        problemContext, actionType, systemPrompt: '', userMessage: '',
        apiKey: settings.apiConfig.apiKey, model: settings.apiConfig.model,
        maxTokens: settings.guardrails.maxTokens, timeoutMs: settings.guardrails.requestTimeoutMs,
        previousHintLevel: progress?.hintLevel ?? 0, userApproach, userCode, codeLanguage, sessionDigest, pinnedOptimal,
        onUsage: (u) => { capturedUsage = u; },
        onFinish: (reason) => { if (reason === 'length') wasCutOff = true; },
      })) {
        fullContent += chunk;
        // Only exempt actions paint tokens as they arrive. For exempt structured
        // actions, hide the trailing data block while streaming so the raw JSON
        // never flashes in the card (§6.2: stream the prose, finalize the data
        // block once complete). Non-exempt actions render nothing here — the
        // placeholder holds until the filtered commit.
        if (streamLive) {
          const display = stripDataBlockForDisplay(fullContent, actionType);
          setLearningContent(prev => prev.map(c => c.id === contentId ? { ...c, content: display } : c));
        }
      }
      // Record runtime metrics (best-effort — never let a metrics write break the
      // response or the rate-limit accounting; design R7).
      void recordMetric({
        model: settings.apiConfig.model,
        latencyMs: performance.now() - startedAt,
        usage: capturedUsage,
      }).catch(() => { /* metrics are non-critical */ });
      // Split prose from the machine-readable data block, then filter the prose.
      // structured?.data (if any) is stored on metadata for the report/records/
      // analytics to consume — the prose is never re-parsed for facts (§2, §4).
      const { prose, data } = parseStructuredResponse(fullContent, actionType);
      // R6/R6b: redact-and-recover (may spend ONE bounded regenerate in the
      // would-be-blank case) instead of blanking. Exempt actions are untouched
      // by filterResponse inside the helper.
      const filteredContent = await recoverFilteredResponse(prose, actionType, { userApproach, userCode, codeLanguage });
      const finalContent: LearningContent = {
        ...newContent,
        // B29: a subtle, honest cue when the model hit the token cap mid-thought.
        // The partial content is still useful, so this is a soft note (not an
        // error) appended after the (filtered) prose.
        content: wasCutOff ? `${filteredContent}\n\n_⚠️ This response was cut off (token limit) — ask a follow-up for the rest._` : filteredContent,
        metadata: data
          ? { ...(newContent.metadata ?? {}), structured: data }
          : newContent.metadata,
      };
      setLearningContent(prev => prev.map(c => c.id === contentId ? finalContent : c));
      const updatedProgress = await trackAction(problemContext.url, actionType);
      setProgress(updatedProgress);
      await appendContent(problemContext.url, finalContent);
      // B10: pin the canonical optimal from this action's structured data,
      // applying the authority rule (first emission pins; UNDERSTAND_SOLUTION
      // overrides). Best-effort — a pin write must never break the action.
      if (data && 'optimalComplexity' in data) {
        await recordOptimalPin(problemContext.url, data.optimalComplexity, actionType).catch(() => { /* pin is non-critical */ });
      }
      stuckTimerRef.current?.start({ difficulty: problemContext.difficulty, hintsExhausted: updatedProgress.hintLevel >= 3 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLearningContent(prev => prev.filter(c => c.id !== contentId));
    } finally { setIsLoading(false); setStreamingId(null); }
  }, [problemContext, settings, progress, activeTabIsProblem, recoverFilteredResponse]);

  // Free-form question: adds a user bubble, then streams a coaching answer.
  const handleChatSubmit = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q || !settings?.apiConfig.apiKey) return;
    // R4.4 (same as handleActionClick): on a real problem page but context still
    // loading → honest transient message, not a silent drop.
    if (!problemContext) {
      if (activeTabIsProblem) setError('Still reading this problem — give it a moment and try again.');
      return;
    }

    // The user is interacting — dismiss any stale "are you stuck?" suggestion.
    setStuckSuggestion(null);

    const check = await checkRateLimit(settings.guardrails);
    if (!check.allowed) {
      const wait = check.retryAfterMs ? ` (try again in ${Math.ceil(check.retryAfterMs / 1000)}s)` : '';
      setError((check.reason ?? 'Request blocked by rate limits.') + wait);
      return;
    }

    // B4: free-form chat used to be blind to the editor, so "what is my code's
    // time complexity?" got "you didn't include your code". Read the current
    // editor code and send it along (when non-empty) so chat can answer about
    // the user's own work — like a tutor who can see their screen. Chat stays
    // NON-EXEMPT (filtered): the model may analyze/quote short pieces, but a
    // full-solution dump is still caught by filterResponse below.
    // See .kiro/specs/leetsage-guardrail-hardening (B4).
    let userCode: string | undefined;
    let codeLanguage: string | undefined;
    {
      const tabId = await getActiveLeetCodeTabId();
      if (tabId != null) {
        const extracted = await extractCurrentCode(tabId);
        // Only attach code on a trustworthy full read. On empty/failed we send
        // no code — the agent loop can call getEditorCode as a fallback, and the
        // chat prompt handles "no code present" gracefully. We never pass a
        // partial fragment (R2/B15).
        if (extracted.status === 'ok') {
          userCode = extracted.code;
          codeLanguage = extracted.language;
        }
      }
    }

    // User bubble
    const userMsg: LearningContent = {
      id: generateId(), type: 'CHAT_MESSAGE', actionType: 'CHECK_APPROACH', content: q,
      timestamp: Date.now(), expanded: true, metadata: { isUserQuery: true },
    };
    // Assistant response card
    const respId = generateId();
    const respMsg: LearningContent = {
      id: respId, type: 'CHAT_MESSAGE', actionType: 'EXPLAIN_CONCEPT', content: '',
      timestamp: Date.now(), expanded: true,
    };
    setLearningContent(prev => [...prev, userMsg, respMsg]);
    setIsLoading(true); setError(null); setStreamingId(respId); setAgentStepLabel(null);

    try {
      // E9 — the agentic chat path (replaces the single stateless call).
      //
      // Build the ONE user turn carrying everything the model needs, all fenced
      // as untrusted DATA (R5.1): problem + code (buildChatData) + the two memory
      // layers — the zero-API sessionDigest (long-term "what they did", R3) and a
      // bounded conversation window (short-term "what was just said", R4), both
      // read from learningContentRef so they're never the stale useCallback
      // closure. The live question stays OUTSIDE the fence as the instruction.
      // B10: fold the canonical pinned optimal into the chat context (both the
      // digest's reconciled line and an explicit constraint line) so the agent
      // answers complexity questions against the SAME fixed optimal as the
      // actions, not a fresh re-guess.
      const chatPin = (await getComplexityPin(slugFromUrl(problemContext.url)))?.optimal;
      const digest = buildSessionDigest(learningContentRef.current, progress, chatPin);
      const window = buildConversationWindow(learningContentRef.current);
      const pinLine = chatPin
        ? `ESTABLISHED OPTIMAL (authoritative for this problem — do not recompute): ${chatPin.time} time / ${chatPin.space} space.`
        : '';
      const dataBlock = [buildChatData({
        problemContext, actionType: 'EXPLAIN_CONCEPT', systemPrompt: '', userMessage: '',
        apiKey: '', userQuery: q, userCode, codeLanguage,
      }), pinLine, digest, window].filter(Boolean).join('\n\n');
      const initialMessages: Array<Record<string, unknown>> = [
        { role: 'system', content: getChatAgentSystemPrompt(!!userCode) },
        { role: 'user', content: wrapUntrusted(dataBlock, `My question: ${q}`) },
      ];

      // Deps for the bounded loop. recordRound is the honest per-request counter:
      // called once per network round (tool round or final answer), so a message
      // that costs N requests counts as N against the 200/day budget (R7.2).
      const toolContext: ToolContext = { problemContext, getTabId: getActiveLeetCodeTabId };
      const startedAt = performance.now();
      let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
      // B29: set when the final streamed answer hit the token cap, so we append
      // the same honest "cut off" cue as the action path.
      let wasCutOff = false;

      const result = await runChatAgent(initialMessages, {
        runToolRound: (messages) => sendToolRound({
          apiKey: settings.apiConfig.apiKey, model: settings.apiConfig.model,
          maxTokens: settings.guardrails.maxTokens, timeoutMs: settings.guardrails.requestTimeoutMs,
          messages, tools: toolSpecs(),
        }),
        streamFinal: async (messages) => {
          let full = '';
          for await (const chunk of streamLLMRequest({
            problemContext, actionType: 'EXPLAIN_CONCEPT', systemPrompt: '', userMessage: '',
            apiKey: settings.apiConfig.apiKey, model: settings.apiConfig.model,
            maxTokens: settings.guardrails.maxTokens, timeoutMs: settings.guardrails.requestTimeoutMs,
            // Pass the full tool-augmented conversation; pin tool_choice:none so
            // the terminal answer can't re-request tools (the loop is bounded).
            messages, toolChoice: 'none',
            onUsage: (u) => { finalUsage = u; },
            onFinish: (reason) => { if (reason === 'length') wasCutOff = true; },
          })) {
            // B1: non-exempt chat withholds tokens mid-stream; we accumulate and
            // reveal once after the filter below. Same as the shipped behavior.
            full += chunk;
          }
          return full;
        },
        runTool: async (call) => wrapToolResult(call.name, await runTool(call.name, toolContext)),
        checkBudget: () => checkRateLimit(settings.guardrails),
        recordRound: async (usage) => {
          const u = await recordRequest();
          setUsageCount(u.count);
          // Best-effort metrics per round (never breaks the response; R7).
          void recordMetric({
            model: settings.apiConfig.model,
            latencyMs: performance.now() - startedAt,
            usage: usage ?? finalUsage,
          }).catch(() => { /* metrics are non-critical */ });
        },
        onStep: (step) => {
          setAgentStepLabel(step.kind === 'tool' ? step.label : step.kind === 'answering' ? 'Answering' : 'Thinking');
        },
        toolLabel,
      });

      // Single filtered reveal (B1): the loop's final answer is NON-EXEMPT, so it
      // passes through filterResponse before anything is shown — a full-solution
      // answer is still caught, exactly like the shipped chat path. R6/R6b:
      // redact-and-recover (one bounded regenerate in the would-be-blank case)
      // via the SAME shared helper the action path uses.
      const filteredContent = await recoverFilteredResponse(result.answer, 'EXPLAIN_CONCEPT', { userQuery: q, userCode, codeLanguage });
      const finalResp = { ...respMsg, content: wasCutOff ? `${filteredContent}\n\n_⚠️ This response was cut off (token limit) — ask a follow-up for the rest._` : filteredContent };
      setLearningContent(prev => prev.map(c => c.id === respId ? finalResp : c));
      await appendContent(problemContext.url, userMsg);
      await appendContent(problemContext.url, finalResp);
      stuckTimerRef.current?.start({ difficulty: problemContext.difficulty, hintsExhausted: (progress?.hintLevel ?? 0) >= 3 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLearningContent(prev => prev.filter(c => c.id !== respId));
    } finally { setIsLoading(false); setStreamingId(null); setAgentStepLabel(null); }
  }, [problemContext, settings, progress, activeTabIsProblem, recoverFilteredResponse]);

  const handleReset = useCallback(async () => {
    if (!problemContext) return;
    await clearProgress(problemContext.url);
    // B10: the pinned optimal is session/problem-scoped and can be wrong (no
    // verifier exists) — "Reset this problem" is the escape hatch that clears it
    // so a bad pin is never inescapable.
    await clearComplexityPin(slugFromUrl(problemContext.url)).catch(() => { /* non-critical */ });
    setProgress(null); setLearningContent([]);
    setConfirmReset(false);
  }, [problemContext]);

  // Persist a generated report to "My Progress" as a ProblemRecord attempt.
  // The record's facts (patterns, complexity, approach) are projected from the
  // session's structured data — the same data the report itself was built from.
  const handleSaveToProgress = useCallback(async (item: LearningContent) => {
    if (!problemContext) return;
    try {
      const facts = extractSessionFacts(learningContentRef.current, progress);
      // The report card's own structured data (ReportData) is the primary,
      // always-available source of patterns/complexity — even when the user
      // never ran Understand Solution. It has approachSummary + solvedOptimally
      // (not keyInsight/approachDetected), which is how we tell it apart.
      const s = item.metadata?.structured;
      const reportData =
        s && 'solvedOptimally' in s ? s : null;
      // Re-read the editor language so the attempt records it (best-effort).
      let language: string | undefined;
      const tabId = await getActiveLeetCodeTabId();
      if (tabId != null) {
        const extracted = await extractCurrentCode(tabId);
        if (extracted.status === 'ok') language = extracted.language;
      }
      // v2 (progress-insights-overhaul): project two new client-side signals onto
      // the attempt — (1) the coaching actions used this session (live Set, no new
      // model output), and (2) the canonical optimal from the B10 pin (reused, NOT
      // re-judged). Storing the pin value ON the attempt is what lets the
      // achieved-vs-optimal flag round-trip through export/import (the pin store
      // itself isn't exported). See design §0.2 / §4.1 / §5.2.
      const usedActions = Array.from(progress?.usedActions ?? new Set<ActionType>());
      const pinnedOptimal = (await getComplexityPin(slugFromUrl(problemContext.url)))?.optimal ?? null;
      // Free-form chat questions this session (same isUserQuery count the report
      // digest uses) — a soft struggle signal projected onto the attempt.
      const chatCount = learningContentRef.current.filter(c => c.metadata?.isUserQuery).length;
      const projection = buildRecordProjection(facts, reportData, item.content, language, usedActions, pinnedOptimal, chatCount);
      await saveAttempt({
        slug: slugFromUrl(problemContext.url),
        url: problemContext.url,
        title: problemContext.title,
        difficulty: problemContext.difficulty,
        patterns: projection.patterns,
        attempt: projection.attempt,
        notes: item.content,
      });
      // Persist the saved flag onto the card in the stored session so the
      // "✓ Saved" state survives navigating away + back (the card is restored
      // from contentHistory with this flag). Also update in-memory content so
      // the button flips to "Saved" immediately this render.
      await markReportSaved(problemContext.url, item.id);
      setLearningContent(prev => prev.map(c =>
        c.id === item.id ? { ...c, metadata: { ...c.metadata, savedToProgress: true } } : c,
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save to My Progress');
    }
  }, [problemContext, progress]);

  const handleSettingsSave = useCallback((newSettings: UserSettings) => { setSettings(newSettings); setShowSettings(false); }, []);
  const apiKeyConfigured = Boolean(settings?.apiConfig.apiKey);

  // Manual light/dark toggle (defaults to dark). Persists to settings.
  const isDark = settings ? settings.theme !== 'light' : true;
  const toggleTheme = useCallback(async () => {
    if (!settings) return;
    const next: UserSettings = { ...settings, theme: isDark ? 'light' : 'dark' };
    setSettings(next);
    await saveSettings(next);
  }, [settings, isDark]);

  const difficultyColor: Record<string, string> = {
    Easy: 'text-green-500', Medium: 'text-yellow-500', Hard: 'text-red-500',
  };

  // R4: gate inputs on the URL-based "on a coachable problem page" signal, NOT
  // on `!!problemContext`. The URL matches immediately on a real page, so inputs
  // are enabled the instant the user is on a problem — they never flip to
  // "off-page" during the sub-second context pull (the R4.4 hard bar). If the
  // context is still loading when the user clicks, handleActionClick/
  // handleChatSubmit surface a transient "reading this problem" message rather
  // than a wrong answer. See .kiro/specs/leetsage-coaching-logic-overhaul §2.
  const onCoachablePage = activeTabIsProblem;
  const canInteract = apiKeyConfigured && onCoachablePage && !isLoading;

  // Chat intent routing (design §7): the chat box is a smart entry point. Before
  // sending a message to the free-form chat path, run the PURE pipeline
  // (classify → resolveOverlap → route) and interpret its effect:
  //   - dispatch → run the matched action, exactly like pressing its button (R7).
  //   - confirm  → surface the confirm affordance (exempt guardrail OR borderline
  //                ask). "Yes" → the action; "Just answer" → chat.
  //   - chat     → the existing free-form chat path, unchanged.
  // The router is a PRE-STEP only: filterResponse, the pre-display gate, and
  // getChatSystemPrompt are untouched — routing sits in front of them.
  // `text` lets a caller submit an explicit message (e.g. a tapped "Try asking…"
  // chip, B12) instead of only the live `chatInput` state — avoiding a set-state
  // race where reading `chatInput` right after `setChatInput(chip)` would still
  // see the old value. The input bar's Send/Enter pass nothing and fall back to
  // the current input. See .kiro/specs/leetsage-chat-polish (B12).
  const submitChat = (text?: string) => {
    const q = resolveSubmitText(text, chatInput);
    if (!q) return;
    // A new submission supersedes any stale confirm prompt.
    setPendingConfirm(null);

    // Context for classification: does the editor currently have code? We reuse
    // the already-loaded problem context; hasCode is best-effort from what chat
    // will read anyway. We don't block the classify on an async editor read —
    // the routed action re-reads the live code itself (handleActionClick), so a
    // false "no code" here at worst under-sharpens (falls to chat/ask), never
    // misroutes into an exempt action silently.
    const effect = routeMessage(q, { hasCode: !!problemContext });

    switch (effect.kind) {
      case 'dispatch':
        // Non-exempt route: fire the action now (identical to a button press).
        // It still flows through filterResponse + the pre-display gate.
        handleActionClick(effect.action);
        setChatInput('');
        return;
      case 'confirm':
        // Exempt route OR borderline ask: never silent. Ask first. `reason`
        // drives the affordance's copy + emphasis (exempt = louder heads-up).
        setPendingConfirm({ action: effect.action, reason: effect.reason, query: q });
        return;
      case 'chat':
        handleChatSubmit(q);
        setChatInput('');
        return;
    }
  };

  // Confirm affordance — "Yes": run the matched action like a button press, then
  // clear the input + prompt.
  const confirmRoutedAction = () => {
    if (!pendingConfirm) return;
    const { action } = pendingConfirm;
    setPendingConfirm(null);
    setChatInput('');
    handleActionClick(action);
  };

  // Confirm affordance — "Just answer": fall through to free-form chat with the
  // original message (the deliberate-act guardrail: a solution-bearing action is
  // never reached without the explicit "Yes" tap).
  const dismissRoutedAction = () => {
    if (!pendingConfirm) return;
    const { query } = pendingConfirm;
    setPendingConfirm(null);
    setChatInput('');
    handleChatSubmit(query);
  };

  // B24: derive the placeholder from the SPECIFIC disabled reason (no-key vs.
  // off-page vs. busy) instead of the overloaded `canInteract` — which collapsed
  // all three into the no-key copy, so a mid-stream request wrongly told a
  // key-configured user to "Configure your API key first". `canInteract` still
  // drives the actual enable/disable wiring below (that part was correct).
  const currentPlaceholder = chatPlaceholder({
    apiKeyConfigured,
    onProblemPage: onCoachablePage, // R4: URL-based; drives the off-page copy
    hasProblem: !!problemContext,   // context loaded; drives the "reading…" copy
    isLoading,
    rotatingExample: PLACEHOLDER_EXAMPLES[placeholderIdx],
  });
  // The decorative "you can type here" caret shows only when the field is usable,
  // empty, and unfocused (the real text caret takes over on focus).
  const showIdleCaret = canInteract && !chatFocused && !chatInput;

  return (
    <div className={`${isDark ? 'dark' : ''} relative flex flex-col h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm`}>
      {/* Sage identity strip: a thin gradient bar at the very top so the panel
          carries its signature color even before any content loads. */}
      <div className="leetsage-sage-fill h-0.5 shrink-0" aria-hidden="true" />
      {/* Single consolidated header: problem title + difficulty on the left,
          usage counter + theme + settings on the right. (Chrome's side-panel
          title bar already shows the "LeetSmith" name, so we don't repeat it.) */}
      <div className="flex items-start justify-between gap-2 px-3 py-2.5 bg-white dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700 shrink-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 flex-1">
          {problemContext ? (
            <>
              <span className="text-sm font-semibold break-words">{problemContext.title}</span>
              <span className={`text-xs font-bold shrink-0 ${difficultyColor[problemContext.difficulty] ?? 'text-neutral-400'}`}>
                {problemContext.difficulty}
              </span>
            </>
          ) : (
            <span className="text-xs text-neutral-400 italic">Open a LeetCode problem to get started</span>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <button onClick={() => setShowProgress(v => !v)} className={`leetsage-pressable transition-colors ${showProgress ? 'text-teal-500' : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200'}`} aria-label="My Progress" aria-pressed={showProgress} title="My Progress">📈</button>
          <button onClick={() => setShowWelcome(true)} className="leetsage-pressable text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors" aria-label="What is LeetSmith?" title="What is LeetSmith?">❔</button>
          <button onClick={toggleTheme} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors" aria-label="Toggle theme" title={isDark ? 'Switch to light' : 'Switch to dark'}>
            {isDark ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setShowSettings(true)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors" aria-label="Settings">⚙️</button>
        </div>
      </div>

      {/* My Progress is a full-panel screen that replaces the coaching UI
          (below the shared header) rather than a modal — reads better in a
          narrow side panel. Toggle it from the 📈 header button. */}
      {showProgress ? (
        <ProgressView onClose={() => setShowProgress(false)} />
      ) : (
      <>
      {/* API key prompt */}
      {!apiKeyConfigured && (
        <button onClick={() => setShowSettings(true)}
          className="mx-3 mt-2 text-xs text-center py-1.5 bg-orange-500/10 border border-orange-500/30 rounded text-orange-500 hover:bg-orange-500/20 transition-colors shrink-0">
          ⚠️ Add your free Gemini API key to get started →
        </button>
      )}

      {/* Conversation / content stream */}
      <ContentDisplay content={learningContent} isLoading={isLoading} streamingId={streamingId} onSaveToProgress={handleSaveToProgress} agentStepLabel={agentStepLabel ?? undefined} />

      {/* Errors + stuck suggestion */}
      {error && (
        <div className="mx-3 mb-2 p-2.5 bg-red-500/10 border border-red-500/30 rounded text-red-500 text-xs shrink-0">
          <p className="leading-relaxed">{error}</p>
          <div className="flex justify-end mt-1.5">
            <button
              onClick={() => setError(null)}
              className="leetsage-pressable px-2.5 py-1 rounded border border-red-500/40 hover:bg-red-500/15 font-medium transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {stuckSuggestion && !(stuckSuggestion.suggestedAction === 'GET_HINT' && (progress?.hintLevel ?? 0) >= 3) && (
        <div className="mx-3 mb-2 p-2 bg-blue-500/10 border border-blue-500/30 rounded text-xs flex items-center justify-between shrink-0">
          <span className="text-blue-500">{stuckSuggestion.message}</span>
          <div className="flex gap-2 ml-2 shrink-0">
            <button onClick={() => { handleActionClick(stuckSuggestion.suggestedAction); setStuckSuggestion(null); }} className="text-blue-500 underline">Try it</button>
            <button onClick={() => setStuckSuggestion(null)} className="text-neutral-400">✕</button>
          </div>
        </div>
      )}

      {/* Chat intent routing: confirm affordance for an exempt-action match or a
          borderline `ask`. Reused for both — keyed on { prompt, action }. */}
      {pendingConfirm && (
        <ConfirmAffordance
          reason={pendingConfirm.reason}
          action={pendingConfirm.action}
          onConfirm={confirmRoutedAction}
          onDismiss={dismissRoutedAction}
        />
      )}

      {/* Bottom input bar: quick-command chips + free-form text input */}
      <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 space-y-2">
        {/* R4.3: off-page clear state. Shown only when a key IS configured (so it
            doesn't stack with the no-key banner) and the active tab is NOT a
            coachable problem page. The coaching INPUTS are disabled here, but the
            rest of the panel (scroll, copy, Settings, Progress) stays usable. */}
        {apiKeyConfigured && !onCoachablePage && (
          <div className="text-xs text-center py-1.5 bg-neutral-500/10 border border-neutral-400/30 rounded text-neutral-500 dark:text-neutral-400">
            Open a LeetCode problem to use the coaching tools.
          </div>
        )}
        <QuickActions progress={progress} disabled={!canInteract} isLoading={isLoading} onAction={handleActionClick} />

        {/* Discovery (R8): dismissible "Try asking…" chips teach the intents that
            no longer have buttons. B12 (chat-polish): these are COMPLETE example
            questions, so tapping one SUBMITS immediately via submitChat(chip)
            (which also exercises the real routing path) — no second "press Send"
            step. A future template-style chip (needing user input) would populate
            instead; see design §4.3. */}
        {canInteract && showTryChips && learningContent.length === 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-400 shrink-0">Try asking:</span>
            {TRY_ASKING_CHIPS.map(chip => (
              <button
                key={chip}
                onClick={() => submitChat(chip)}
                className="leetsage-pressable text-[11px] px-2.5 py-1 rounded-full border border-[var(--sage-ring)] text-neutral-600 dark:text-neutral-300 bg-[var(--sage-tint)] hover:bg-[var(--sage-tint-hover)] hover:border-[var(--sage-mid)] transition-colors"
              >
                {chip}
              </button>
            ))}
            <button
              onClick={() => setShowTryChips(false)}
              aria-label="Dismiss suggestions"
              title="Dismiss suggestions"
              className="ml-auto text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 shrink-0"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onFocus={() => setChatFocused(true)}
              onBlur={() => setChatFocused(false)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat(); } }}
              disabled={!canInteract}
              placeholder={currentPlaceholder}
              // Padding is a CONSTANT px-3.5 in every state. The decorative caret
              // is positioned at the SAME x as the real text caret (left: 0.875rem
              // == pl-3.5), so focusing swaps one caret for the other at the exact
              // same spot — no horizontal jump. The rotating placeholder stays
              // visible while idle; the 2px caret sits just in front of its text,
              // like a cursor before text.
              className="leetsage-sage-focus w-full text-xs bg-neutral-100 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 rounded-full py-2 px-3.5 focus:outline-none focus:border-[var(--sage-mid)] disabled:opacity-50"
            />
            {/* Decorative "you can type here" caret: only while enabled, empty,
                and unfocused. On focus the real text caret takes over. */}
            {showIdleCaret && (
              <span className="leetsage-input-caret" aria-hidden="true" />
            )}
          </div>
          <button
            onClick={() => submitChat()}
            disabled={!canInteract || !chatInput.trim()}
            className="leetsage-pressable leetsage-sage-fill text-xs px-3.5 py-2 rounded-full shadow-sm hover:brightness-105 disabled:opacity-40 disabled:brightness-100 shrink-0"
          >
            Send
          </button>
        </div>

        {/* E9: "Daily usage" (left) and "Reset this problem" (right) share ONE
            row — the usage indicator lives right where requests are spent, and
            co-locating it with reset avoids a near-empty extra row of whitespace.
            The draining droplet is the obscured signal (no raw number; the exact
            count is in Settings); label + green→amber→red tint carry the
            "running low" cue. See design §6 (R11). */}
        {settings && (
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-neutral-400 dark:text-neutral-500 shrink-0" title={`Daily usage (resets at midnight; exact count in Settings)`}>
              <UsageReservoir used={usageCount} max={settings.guardrails.maxRequestsPerDay} />
              <span>Daily usage</span>
            </div>
            {progress && learningContent.length > 0 && (
              confirmReset ? (
                <div className="flex items-center gap-2">
                  <span className="text-neutral-500 dark:text-neutral-400 hidden sm:inline">Reset? Clears history.</span>
                  <button onClick={handleReset} className="px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors font-medium">
                    Reset
                  </button>
                  <button onClick={() => setConfirmReset(false)} className="px-2 py-0.5 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors">
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmReset(true)} className="text-neutral-400 hover:text-red-500 transition-colors shrink-0">
                  Reset this problem
                </button>
              )
            )}
          </div>
        )}
      </div>
      </>
      )}

      {/* E4: re-openable welcome overlay (header "?" button). Same WelcomeCard
          as the empty state; a backdrop tap or "Got it" dismisses it. */}
      {showWelcome && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center px-6 bg-black/40 backdrop-blur-[1px] leetsage-enter"
          onClick={() => setShowWelcome(false)}
          role="dialog"
          aria-modal="true"
          aria-label="About LeetSmith"
        >
          <div
            className="leetsage-pop-in bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-lg px-5 py-5"
            onClick={e => e.stopPropagation()}
          >
            <WelcomeCard onDismiss={() => setShowWelcome(false)} />
          </div>
        </div>
      )}

      {showSettings && <SettingsModal currentSettings={settings} onSave={handleSettingsSave} onClose={() => setShowSettings(false)} />}
    </div>
  );
};

export default App;
