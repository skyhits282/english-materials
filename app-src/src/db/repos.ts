import { db, type ContentMetaRow } from './schema'
import type { Attempt, Mastery, Question, Settings } from '../types'
import { nextMasteryState, type ReviewEvent } from '../domain/review'
import { localDayKey } from '../domain/metrics'

export const DEFAULT_SETTINGS: Settings = {
  grade: 7,
  book: 'g7a',
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

/** 提交挂钩：追加 attempt 并同事务更新各知识点 mastery（规格 §1.1 状态机）。
 *  词题不在 questions 表，但其 Question 对象（deriveVocabQuestions 派生）已带
 *  `vocab.<book>.<短单元名>` 格式的 knowledgePointIds，与选择题统一取该字段。
 *  事务外先查同题上次 attempt（此时新 attempt 尚未入库），以其本地日判定"同日重试不推进"；
 *  now 默认取 attempt.submittedAt（事件本地日与 nextReviewAt 均以它推算）。 */
export async function applyMasteryUpdate(
  attempt: Attempt,
  question: Question,
  now: Date = new Date(attempt.submittedAt),
): Promise<void> {
  // 上次 attempt 取提交时间最新的一条（主键为 UUID，索引序不保证时间序）
  const history = await db.attempts.where('questionId').equals(attempt.questionId).toArray()
  const previous = history.reduce<Attempt | undefined>(
    (latest, a) => (latest === undefined || a.submittedAt > latest.submittedAt ? a : latest),
    undefined,
  )
  const event: ReviewEvent = {
    phase: attempt.phase,
    isCorrect: attempt.isCorrect,
    localDay: localDayKey(now),
    ...(previous ? { previousLocalDay: localDayKey(new Date(previous.submittedAt)) } : {}),
  }
  const nextStates: Mastery[] = []
  for (const kp of question.knowledgePointIds) {
    nextStates.push(nextMasteryState(await db.mastery.get(kp), kp, event, now))
  }
  await db.transaction('rw', [db.attempts, db.mastery], async () => {
    await db.attempts.add(attempt)
    await db.mastery.bulkPut(nextStates)
  })
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

/** 前缀匹配专项 unit（如 'g7a-present' 命中 'g7a-present-l1'…）；调用方应传完整 special id，词汇单元（v1-u*）不写入 questions 表、不适用本查询 */
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
