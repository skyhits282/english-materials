import { db, type ContentMetaRow, type TaskRow, type TaskType } from './schema'
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

/** 全表扫描 attempts 汇总曾答错题 ID（attempts 无 isCorrect 索引：量级 <2 万，单次全表扫描
 *  比按 questionId 索引逐题反查（<1000 题 × N 次索引往返）更省；getReviewSet 与 buildWrongByKp 共用） */
async function scanWrongQuestionIds(): Promise<Set<string>> {
  const wrong = new Set<string>()
  await db.attempts.each((a) => {
    if (!a.isCorrect) wrong.add(a.questionId)
  })
  return wrong
}

/** questionId → 知识点列表的查表底座：选择题全量读 questions 表建映射（词题不在表内，由 resolveQuestionKps 兜底） */
async function kpsByQuestionId(): Promise<Map<string, string[]>> {
  const kpByQuestionId = new Map<string, string[]>()
  for (const q of await db.questions.toArray()) kpByQuestionId.set(q.id, q.knowledgePointIds)
  return kpByQuestionId
}

/** questionId → 知识点列表：选择题查 questions 表；词题不在表内，按 ID 约定派生（loader.vocabKpFromQuestionId） */
function resolveQuestionKps(qid: string, kpByQuestionId: Map<string, string[]>): string[] {
  const kps = kpByQuestionId.get(qid)
  if (kps !== undefined) return kps
  const vocabKp = vocabKpFromQuestionId(qid)
  return vocabKp !== undefined ? [vocabKp] : []
}

/** 曾答错题 → 按知识点分组（可选 dueKps 过滤：getReviewSet 只保留到期知识点，buildWrongByKp 全量不过滤） */
function groupWrongByKp(
  wrongQuestionIds: Set<string>,
  kpByQuestionId: Map<string, string[]>,
  dueKps?: Set<string>,
): Map<string, string[]> {
  const wrongByKp = new Map<string, string[]>()
  for (const qid of wrongQuestionIds) {
    for (const kp of resolveQuestionKps(qid, kpByQuestionId)) {
      if (dueKps !== undefined && !dueKps.has(kp)) continue
      const list = wrongByKp.get(kp)
      if (list) list.push(qid)
      else wrongByKp.set(kp, [qid])
    }
  }
  return wrongByKp
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

  // 当日已答（含当日复测答对）的题剔除，避免立即重复（attempts 全表扫描，口径同 scanWrongQuestionIds）
  const doneToday = new Set<string>()
  await db.attempts.each((a) => {
    if (isSameLocalDay(a.submittedAt, todayKey)) doneToday.add(a.questionId)
  })

  const wrongByKp = groupWrongByKp(await scanWrongQuestionIds(), await kpsByQuestionId(), dueKps)

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
 *  与 getReviewSet 内部的 wrongByKp 不同：不做 dueKps 过滤，供计划生成做全量专项薄弱度聚合。 */
async function buildWrongByKp(): Promise<Map<string, string[]>> {
  return groupWrongByKp(await scanWrongQuestionIds(), await kpsByQuestionId())
}

/** 任务返回顺序（与 generatePlan 生成序一致；tasks 的 day 索引查询按主键字典序返回，
 *  须统一排序，否则同日第二次调用（今日页刷新）会出现顺序跳变） */
const TASK_TYPE_ORDER: TaskType[] = ['review', 'unit', 'special', 'summary']

function sortTasksByType(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => TASK_TYPE_ORDER.indexOf(a.type) - TASK_TYPE_ORDER.indexOf(b.type))
}

/** 每日计划（规格 §2.1）：当日（本地日 key）无任务才生成，同一天重复打开不重建（按 day 查重）。
 *  review 段取 Task 4 引擎（getReviewSet）产出；昨日 deferred/skipped 任务一并传入，deferred 由
 *  generatePlan 优先编入复习段（skipped 不结转）；now 可注入（测试与跨日边界用）。 */
export async function getOrCreatePlan(inputs: PlanInputs, now: Date = new Date()): Promise<TaskRow[]> {
  const dayKey = localDayKey(now)
  const existing = await db.tasks.where('day').equals(dayKey).toArray()
  if (existing.length > 0) return sortTasksByType(existing)

  const settings = await getSettings()
  // 已知边界：结转只回看恰好"昨天"一日——周六 deferred、周日休息时，周一生成计划查不到该 deferred（丢结转）。
  // 改进方向为"回溯至最近一个学习日"再查 deferred，暂按 Task 5 计划口径保持现行为。
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
  return sortTasksByType(plan)
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

/** 按 id 取任务（练习页回写前预查状态、规避非法转移用） */
export async function getTask(id: string): Promise<TaskRow | undefined> {
  return db.tasks.get(id)
}

/** 清除某日全部任务行（今日页播种重试用：当日计划是在题库缺失时生成的残缺计划，重建前调用） */
export async function clearDayTasks(day: string): Promise<void> {
  await db.tasks.where('day').equals(day).delete()
}

/** 任务一步完成回写（练习页完成节点与今日页小结勾选共用）：单 rw 事务内读取+校验+写入，
 *  planned 先补 in_progress（瞬态）再 completed（规避 planned→completed 非法直转）、in_progress 直转；
 *  任务不存在或终态（completed/deferred/skipped）返回 false 且不落库。 */
export async function completeTask(id: string): Promise<boolean> {
  return db.transaction('rw', db.tasks, async () => {
    const row = await db.tasks.get(id)
    if (row === undefined) return false
    if (row.status !== 'planned' && row.status !== 'in_progress') return false
    if (row.status === 'planned') await db.tasks.update(id, { status: 'in_progress' })
    await db.tasks.update(id, { status: 'completed' })
    return true
  })
}

/** 播种重试是否需要清除当日任务重建：仅当计划本身残缺（学习日生成的计划缺专项段——
 *  questions 表无题可选时 generatePlan 不会产出 special 任务）。瞬时 bundle 失败但计划完整时
 *  返回 false：重试只重拉 bundle 与播种，不得重置已完成任务状态。 */
export function isPlanIncomplete(tasks: TaskRow[]): boolean {
  return tasks.length > 0 && !tasks.some((t) => t.type === 'special')
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
