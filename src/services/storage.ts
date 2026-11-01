import type { ProblemContext, ProgressState, UserSettings, UsageState } from '../types';
import { DEFAULT_GUARDRAILS } from '../types';
import { normalizeSort, type Sort } from '../components/progress-list-controls';

export const STORAGE_KEYS = {
  PROBLEM_DATA: 'problemData',
  USER_SETTINGS: 'userSettings',
  USAGE_PREFIX: 'usage_',
  /** The persisted "My Progress" list sort preference (quick-wins §4.6). */
  PROGRESS_LIST_SORT: 'progress_list_sort',
  usageKey: (date: string) => `usage_${date}`,
  progressPrefix: (url: string) => `progress_${url}`,
} as const;

/** Local date string YYYY-MM-DD for keying daily usage. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function getUsage(): Promise<UsageState> {
  const key = STORAGE_KEYS.usageKey(todayKey());
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result[key] ?? { date: todayKey(), count: 0, recentTimestamps: [] });
    });
  });
}

export async function saveUsage(usage: UsageState): Promise<void> {
  const key = STORAGE_KEYS.usageKey(usage.date);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: usage }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function saveProblemContext(context: ProblemContext): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.PROBLEM_DATA]: context }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getProblemContext(): Promise<ProblemContext | null> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STORAGE_KEYS.PROBLEM_DATA, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result[STORAGE_KEYS.PROBLEM_DATA] || null);
    });
  });
}

export async function saveProgress(problemUrl: string, progress: ProgressState): Promise<void> {
  return new Promise((resolve, reject) => {
    const storableProgress = { ...progress, usedActions: Array.from(progress.usedActions) };
    const key = STORAGE_KEYS.progressPrefix(problemUrl);
    chrome.storage.local.set({ [key]: storableProgress }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getProgress(problemUrl: string): Promise<ProgressState | null> {
  return new Promise((resolve, reject) => {
    const key = STORAGE_KEYS.progressPrefix(problemUrl);
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!result[key]) resolve(null);
      else resolve({ ...result[key], usedActions: new Set(result[key].usedActions) });
    });
  });
}

export async function resetProgress(problemUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = STORAGE_KEYS.progressPrefix(problemUrl);
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.USER_SETTINGS]: settings }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getSettings(): Promise<UserSettings> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STORAGE_KEYS.USER_SETTINGS, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        const stored = result[STORAGE_KEYS.USER_SETTINGS] as UserSettings | undefined;
        if (stored) {
          // Backfill guardrails for settings saved before they existed.
          resolve({ ...stored, guardrails: stored.guardrails ?? DEFAULT_GUARDRAILS });
        } else {
          resolve({
            apiConfig: { provider: 'gemini', apiKey: '', model: 'gemini-3.5-flash-lite' },
            guardrails: DEFAULT_GUARDRAILS,
            enableStuckTimer: true,
            stuckTimerDelay: 300000,
            enableChatMode: false,
            theme: 'dark',
          });
        }
      }
    });
  });
}

/**
 * The persisted "My Progress" list sort preference (quick-wins design §4.6):
 * the sort FIELD + DIRECTION. Only the sort persists — search and difficulty/
 * pattern filters stay transient. `normalizeSort` fails safe to the default
 * ({recent, desc}) when the value is absent, the old bare-string format, or
 * otherwise invalid, so an untouched install and a tampered value both behave
 * like today (requirements R3.7).
 */
export async function getProgressListSort(): Promise<Sort> {
  const key = STORAGE_KEYS.PROGRESS_LIST_SORT;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(normalizeSort(result[key]));
    });
  });
}

export async function saveProgressListSort(sort: Sort): Promise<void> {
  const key = STORAGE_KEYS.PROGRESS_LIST_SORT;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: sort }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
