import { db, type ContentMetaRow } from './schema'
import type { Attempt, Question, Settings } from '../types'

export const DEFAULT_SETTINGS: Settings = {
  grade: 7,
  currentUnit: 'v1-u4',
  dailyMinutes: 35,
  studyDaysPerWeek: 6,
  aiEnabled: false,
  studentLabel: '学生1',
}

const SETTINGS_KEY = 'app'

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_KEY)
  return row ? { ...DEFAULT_SETTINGS, ...row.value } : { ...DEFAULT_SETTINGS }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await db.settings.put({ key: SETTINGS_KEY, value: settings, updatedAt: new Date().toISOString() })
}

/** 只追加：ID 冲突直接抛错，保证历史不可改写（T02） */
export async function saveAttempt(attempt: Attempt): Promise<void> {
  await db.attempts.add(attempt)
}

export async function listAttempts(): Promise<Attempt[]> {
  return db.attempts.orderBy('submittedAt').toArray()
}

export async function attemptsForQuestion(questionId: string): Promise<Attempt[]> {
  return db.attempts.where('questionId').equals(questionId).toArray()
}

export async function hasPriorAttempt(questionId: string): Promise<boolean> {
  return (await db.attempts.where('questionId').equals(questionId).count()) > 0
}

export async function upsertQuestions(questions: Question[]): Promise<void> {
  await db.questions.bulkPut(questions)
}

export async function questionsByUnitPrefix(prefix: string): Promise<Question[]> {
  return db.questions.where('unit').startsWith(prefix).toArray()
}

export async function listAllQuestions(): Promise<Question[]> {
  return db.questions.toArray()
}

export async function putContentMeta(meta: ContentMetaRow): Promise<void> {
  await db.contentMeta.put(meta)
}

export async function getContentMeta(contentId: string): Promise<ContentMetaRow | undefined> {
  return db.contentMeta.get(contentId)
}
