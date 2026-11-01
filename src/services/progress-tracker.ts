import type { ActionType, ProgressState, LearningContent } from '../types';
import { saveProgress, getProgress, resetProgress } from './storage';

function createInitialProgress(problemUrl: string): ProgressState {
  return { problemUrl, usedActions: new Set<ActionType>(), hintLevel: 0, contentHistory: [], lastUpdated: Date.now() };
}

export async function trackAction(problemUrl: string, actionType: ActionType): Promise<ProgressState> {
  let progress = await getProgress(problemUrl);
  if (!progress) progress = createInitialProgress(problemUrl);
  progress.usedActions.add(actionType);
  if (actionType === 'GET_HINT') progress.hintLevel = Math.min(progress.hintLevel + 1, 3);
  progress.lastUpdated = Date.now();
  await saveProgress(problemUrl, progress);
  return progress;
}

export async function appendContent(problemUrl: string, content: LearningContent): Promise<void> {
  let progress = await getProgress(problemUrl);
  if (!progress) progress = createInitialProgress(problemUrl);
  progress.contentHistory.push(content);
  progress.lastUpdated = Date.now();
  await saveProgress(problemUrl, progress);
}

export async function loadProgress(problemUrl: string): Promise<ProgressState | null> {
  return getProgress(problemUrl);
}

/**
 * Mark a report card as saved-to-progress in the PERSISTED session, so the
 * "✓ Saved" state survives navigating away and back (the card is restored from
 * contentHistory with its `savedToProgress` flag intact). No-op if the problem
 * or card isn't found. See App.handleSaveToProgress.
 */
export async function markReportSaved(problemUrl: string, contentId: string): Promise<void> {
  const progress = await getProgress(problemUrl);
  if (!progress) return;
  const card = progress.contentHistory.find(c => c.id === contentId);
  if (!card) return;
  card.metadata = { ...card.metadata, savedToProgress: true };
  progress.lastUpdated = Date.now();
  await saveProgress(problemUrl, progress);
}

export async function clearProgress(problemUrl: string): Promise<void> {
  await resetProgress(problemUrl);
}

export async function hasUsedAction(problemUrl: string, actionType: ActionType): Promise<boolean> {
  const progress = await getProgress(problemUrl);
  return progress?.usedActions.has(actionType) ?? false;
}

export async function getHintLevel(problemUrl: string): Promise<number> {
  const progress = await getProgress(problemUrl);
  return progress?.hintLevel ?? 0;
}
