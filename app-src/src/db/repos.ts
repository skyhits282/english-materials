import { db, type ContentMetaRow, type TaskRow } from './schema'
import type { Attempt, Mastery, Question, Settings, VocabBook } from '../types'
import { nextMasteryState, type ReviewEvent } from '../domain/review'
import { localDayKey, isSameLocalDay } from '../domain/metrics'
import { pickReviewQuestions } from '../domain/review-picker'
import { generatePlan, isStudyDay } from '../domain/plan'
import { SPECIALS } from '../content/sets'
import { vocabKpFromQuestionId } from '../content/loader'

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

export interface ReviewSet {
  /** 本次复测题目 ID（轮转均衡、上限 10；词题 ID 原样保留，由练习页解析器显示） */
  questionIds: string[]
  /** 到期知识点数 */
  dueKpCount: number
  /** 去重并剔除当日已答后的可复测题目总数（不含上限截断） */
  availableCount: number
}

/** 复测选题（规格 §1.2）：到期 mastery 知识点 × 历史曾答错题，交纯函数 pickReviewQuestions 均衡抽取。
 *  now 可注入（测试与跨日边界用），默认当前时刻。 */
export async function getReviewSet(now: Date = new Date()): Promise<ReviewSet> {
  const nowIso = now.toISOString()
  const todayKey = localDayKey(now)
  // 索引预筛（nextReviewAt 存本地零点转的 UTC ISO；Dexie 4 的 <= 查询为 belowOrEqual），
  // 再按本地日口径兜底过滤：正时区下"明日本地零点"的 UTC 值可能早于 now，索引命中但本地日未到期，须剔除
  const dueRows = (await db.mastery.where('nextReviewAt').belowOrEqual(nowIso).toArray()).filter(
    (row) => row.nextReviewAt !== undefined && localDayKey(new Date(row.nextReviewAt)) <= todayKey,
  )
  if (dueRows.length === 0) return { questionIds: [], dueKpCount: 0, availableCount: 0 }
  const dueKps = new Set(dueRows.map((row) => row.knowledgePointId))

  // attempts 无 isCorrect 索引：量级 <2 万，单次全表扫描同时汇总"曾答错题"与"当日已答"，
  // 比按 questionId 索引逐题反查（<1000 题 × N 次索引往返）更省
  const wrongQuestionIds = new Set<string>()
  const doneToday = new Set<string>()
  await db.attempts.each((a) => {
    if (!a.isCorrect) wrongQuestionIds.add(a.questionId)
    if (isSameLocalDay(a.submittedAt, todayKey)) doneToday.add(a.questionId)
  })

  // questionId → 知识点：选择题查 questions 表；词题不在表内，按 ID 约定派生（loader.vocabKpFromQuestionId）
  const kpByQuestionId = new Map<string, string[]>()
  for (const q of await db.questions.toArray()) kpByQuestionId.set(q.id, q.knowledgePointIds)

  const wrongByKp = new Map<string, string[]>()
  for (const qid of wrongQuestionIds) {
    let kps = kpByQuestionId.get(qid)
    if (kps === undefined) {
      const vocabKp = vocabKpFromQuestionId(qid)
      kps = vocabKp !== undefined ? [vocabKp] : []
    }
    for (const kp of kps) {
      if (!dueKps.has(kp)) continue
      const list = wrongByKp.get(kp)
      if (list) list.push(qid)
      else wrongByKp.set(kp, [qid])
    }
  }

  // dueRows 按 nextReviewAt 索引序（更逾期在前）传入，轮转顺序随之确定
  return pickReviewQuestions({ now, masteryRows: dueRows, wrongQuestionIdsByKp: wrongByKp, alreadyDoneToday: doneToday })
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

/** 每日计划生成的调用方输入：题库内容（生成器是纯函数无 IO，页面经 fetchContentBundle 取得后传入） */
export interface PlanInputs {
  /** 两册词汇（unit 任务派生词题用） */
  vocab: VocabBook[]
}

/** 知识点 → 全量曾答错题（含词题：不在 questions 表的按 ID 约定派生知识点）。
 *  与 getReviewSet 内部的 wrongByKp 不同：不过滤到期知识点，供计划生成做全量专项薄弱度聚合。 */
async function buildWrongByKp(): Promise<Map<string, string[]>> {
  const wrongIds = new Set<string>()
  await db.attempts.each((a) => {
    if (!a.isCorrect) wrongIds.add(a.questionId)
  })
  const map = new Map<string, string[]>()
  if (wrongIds.size === 0) return map
  const kpByQuestionId = new Map<string, string[]>()
  for (const question of await db.questions.toArray()) kpByQuestionId.set(question.id, question.knowledgePointIds)
  for (const qid of wrongIds) {
    let kps = kpByQuestionId.get(qid)
    if (kps === undefined) {
      const vocabKp = vocabKpFromQuestionId(qid)
      kps = vocabKp !== undefined ? [vocabKp] : []
    }
    for (const kp of kps) {
      const list = map.get(kp)
      if (list) list.push(qid)
      else map.set(kp, [qid])
    }
  }
  return map
}

/** 每日计划（规格 §2.1）：当日（本地日 key）无任务才生成，同一天重复打开不重建（按 day 查重）。
 *  review 段取 Task 4 引擎（getReviewSet）产出；昨日 deferred/skipped 任务一并传入，deferred 由
 *  generatePlan 优先编入复习段（skipped 不结转）；now 可注入（测试与跨日边界用）。 */
export async function getOrCreatePlan(inputs: PlanInputs, now: Date = new Date()): Promise<TaskRow[]> {
  const dayKey = localDayKey(now)
  const existing = await db.tasks.where('day').equals(dayKey).toArray()
  if (existing.length > 0) return existing

  const settings = await getSettings()
  const yesterdayKey = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const yesterdayUnfinished = (await db.tasks.where('day').equals(yesterdayKey).toArray()).filter(
    (t) => t.status === 'deferred' || t.status === 'skipped',
  )
  const specialSets = SPECIALS.map((s) => s.id)
  const specialQuestions = new Map<string, Question[]>()
  for (const sid of specialSets) specialQuestions.set(sid, await questionsByUnitPrefix(sid))

  const plan = generatePlan({
    day: dayKey,
    settings,
    isStudyDay: isStudyDay(dayKey, settings.studyDaysPerWeek),
    reviewQuestions: (await getReviewSet(now)).questionIds,
    wrongByKp: await buildWrongByKp(),
    yesterdayUnfinished,
    specialSets,
    vocab: inputs.vocab,
    specialQuestions,
  })
  if (plan.length === 0) return plan // 非学习日：不写任务（今日页显示"今日休息"）
  await db.transaction('rw', db.tasks, async () => {
    await db.tasks.bulkPut(plan)
  })
  return plan
}

/** 任务状态合法转移表：planned→in_progress→completed 主线，planned/in_progress 可转 skipped/deferred；
 *  completed/skipped/deferred 为终态（结转与否由次日计划生成处理，不在此回改） */
const TASK_TRANSITIONS: Record<TaskRow['status'], TaskRow['status'][]> = {
  planned: ['in_progress', 'skipped', 'deferred'],
  in_progress: ['completed', 'skipped', 'deferred'],
  completed: [],
  skipped: [],
  deferred: [],
}

/** 更新任务状态：非法转移（含终态再转移）抛错且不落库 */
export async function updateTaskStatus(id: string, status: TaskRow['status']): Promise<void> {
  await db.transaction('rw', db.tasks, async () => {
    const row = await db.tasks.get(id)
    if (row === undefined) throw new Error(`任务不存在：${id}`)
    if (!TASK_TRANSITIONS[row.status].includes(status)) {
      throw new Error(`非法任务状态转移：${row.status} → ${status}（任务 ${id}）`)
    }
    await db.tasks.update(id, { status })
  })
}
