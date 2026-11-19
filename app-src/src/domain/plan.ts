import type { Question, Settings, VocabBook } from '../types'
import type { TaskRow, TaskType } from '../db/schema'
import { deriveVocabQuestions } from '../content/loader'
import { localDayKey } from './metrics'

/** 每日计划四段时长比例（百分比，规格 §2.2：到期复习 30 / 单元词汇 40 / 专项巩固 20 / 学习小结 10） */
export const PLAN_RATIO = { review: 30, unit: 40, special: 20, summary: 10 } as const

/** unit（词汇默写）任务题数上限 */
export const UNIT_QUESTION_MAX = 20
/** special（专项巩固）任务题数上限 */
export const SPECIAL_QUESTION_MAX = 10

export interface PlanContext {
  /** 本地日 key（YYYY-MM-DD） */
  day: string
  /** dailyMinutes、studyDaysPerWeek、book、currentUnit */
  settings: Settings
  /** 由调用方按 studyDaysPerWeek 约定判定（isStudyDay(day, studyDaysPerWeek)） */
  isStudyDay: boolean
  /** 今日到期复测题（Task 4 引擎产出） */
  reviewQuestions: string[]
  /** 知识点 → 曾错题（用于专项巩固选薄弱专项） */
  wrongByKp: Map<string, string[]>
  /** 昨日 deferred/skipped 的任务（deferred 结转、skipped 不结转） */
  yesterdayUnfinished: TaskRow[]
  /** 可用专项集合 id（g7a-present…g7b-tenses，顺序即并列时的优先序） */
  specialSets: string[]
  /** 两册词汇题库：unit 任务经 deriveVocabQuestions 派生词题（纯函数无 IO，由调用方传入） */
  vocab: VocabBook[]
  /** 专项集合 id → 该专项全部题（薄弱聚合与预算选题用，含 estimatedSeconds） */
  specialQuestions: Map<string, Question[]>
}

/** 学习日判定：以周一起始的 studyDaysPerWeek 天为学习日（默认 6 → 周一…周六学习、周日休息），纯日期数学 */
export function isStudyDay(day: string, studyDaysPerWeek: number): boolean {
  const [y, m, d] = day.split('-').map(Number)
  const weekday = new Date(y!, m! - 1, d!).getDay()
  // 周一映射为 0 … 周日映射为 6，落在前 studyDaysPerWeek 天内即学习日
  return ((weekday + 6) % 7) < studyDaysPerWeek
}

/** 结转回溯窗口（天）：超出视为放弃，防全历史扫描（规格 §1.2） */
export const CARRY_LOOKBACK_DAYS = 14

/** 结转回溯窗口起点（含）：今日往前 CARRY_LOOKBACK_DAYS 天的本地日 key */
export function carryWindowStart(todayKey: string): string {
  const [y, m, d] = todayKey.split('-').map(Number)
  return localDayKey(new Date(y!, m! - 1, d! - CARRY_LOOKBACK_DAYS))
}

/** 结转来源挑选（规格 §1.2）：窗口行里最近一个有任务日的 deferred 任务；
 *  更早的日子不看（其 deferred 已被更近一次计划生成消费），当日行不参与。
 *  纯函数无 IO：调用方应传入窗口行，函数内部仍防御性过滤窗口外与当日行。 */
export function pickCarrySource(priorTasks: TaskRow[], todayKey: string): TaskRow[] {
  const start = carryWindowStart(todayKey)
  const before = priorTasks.filter((t) => t.day >= start && t.day < todayKey)
  if (before.length === 0) return []
  const latestDay = before.reduce((max, t) => (t.day > max ? t.day : max), before[0]!.day)
  return before.filter((t) => t.day === latestDay && t.status === 'deferred')
}

/** 四段分钟分配：前三段按比例向下取整，尾余全部归 summary（各任务 minutesPlanned 之和恒等于总分钟） */
interface MinutesAllocation {
  review: number
  unit: number
  special: number
  summary: number
}

function allocateMinutes(total: number): MinutesAllocation {
  const review = Math.floor((total * PLAN_RATIO.review) / 100)
  const unit = Math.floor((total * PLAN_RATIO.unit) / 100)
  const special = Math.floor((total * PLAN_RATIO.special) / 100)
  return { review, unit, special, summary: total - review - unit - special }
}

/** 按预算与估计用时贪心选题：可容纳即选、超预算跳过继续尝试后面的题；题数不超过 cap，used 去重 */
function pickByBudget(questions: Question[], budgetSeconds: number, cap: number, used: Set<string>): string[] {
  const ids: string[] = []
  let seconds = 0
  for (const q of questions) {
    if (ids.length >= cap) break
    if (used.has(q.id)) continue
    if (seconds + q.estimatedSeconds > budgetSeconds) continue
    seconds += q.estimatedSeconds
    used.add(q.id)
    ids.push(q.id)
  }
  return ids
}

/** 从 wrongByKp 聚合各专项"错误率"（该专项曾错题数 / 题目总数），返回错误率最高的专项 id；
 *  并列时取 specialSets 顺序靠前的；无任何错题返回 undefined（调用方回退当前册首个专项） */
function pickWeakestSpecial(ctx: PlanContext, wrongIds: Set<string>): string | undefined {
  let weakest: string | undefined
  let bestRate = 0
  for (const sid of ctx.specialSets) {
    const questions = ctx.specialQuestions.get(sid)
    if (!questions || questions.length === 0) continue
    const wrongCount = questions.reduce((n, q) => n + (wrongIds.has(q.id) ? 1 : 0), 0)
    const rate = wrongCount / questions.length
    if (rate > bestRate) {
      bestRate = rate
      weakest = sid
    }
  }
  return weakest
}

/** 每日计划生成（规格 §2.1/§2.2）：纯函数无 IO，输出即 tasks 表行。
 *  非学习日返回 []（今日页显示"今日休息"）；任务 id 形如 task-<day>-<type>，同日按 day 查重不重建；
 *  同一 questionId 不得出现在两个任务（生成顺序 review → unit → special，先占先得）。 */
export function generatePlan(ctx: PlanContext): TaskRow[] {
  if (!ctx.isStudyDay) return []

  const alloc = allocateMinutes(ctx.settings.dailyMinutes)
  const used = new Set<string>()

  // 结转：昨日 deferred 的题优先编入复习段（questionIds 保留；skipped 不结转）
  const carryIds: string[] = []
  for (const task of ctx.yesterdayUnfinished) {
    if (task.status !== 'deferred') continue
    for (const id of task.questionIds) {
      if (used.has(id)) continue
      used.add(id)
      carryIds.push(id)
    }
  }

  // review 段：结转题 + 今日到期复测题（questionIds 原样快照、不截断），去重
  const reviewIds = [...carryIds]
  for (const id of ctx.reviewQuestions) {
    if (used.has(id)) continue
    used.add(id)
    reviewIds.push(id)
  }

  const tasks: TaskRow[] = []
  const mkTask = (type: TaskType, questionIds: string[], minutes: number): TaskRow => ({
    id: `task-${ctx.day}-${type}`,
    day: ctx.day,
    type,
    questionIds,
    status: 'planned',
    minutesPlanned: minutes,
  })

  // review 任务：有到期复测题或结转题才生成；份额空时并入 unit
  let unitMinutes = alloc.unit
  if (reviewIds.length > 0) {
    tasks.push(mkTask('review', reviewIds, alloc.review))
  } else {
    unitMinutes += alloc.review
  }

  // unit 任务：当前 book/currentUnit 派生词汇默写题，按预算估取、上限 20
  // （词题估计用时 20s/题是 content/loader.ts toVocabQuestion 的定值 estimatedSeconds，预算换算据此进行）
  const vocabQuestions = deriveVocabQuestions(ctx.vocab, ctx.settings.currentUnit)
  const unitIds = pickByBudget(vocabQuestions, unitMinutes * 60, UNIT_QUESTION_MAX, used)
  let summaryMinutes = alloc.summary
  if (unitIds.length > 0) {
    tasks.push(mkTask('unit', unitIds, unitMinutes))
  } else {
    summaryMinutes += unitMinutes
  }

  // special 任务：全量曾错题（含词题）参与薄弱聚合
  const wrongIds = new Set<string>()
  for (const ids of ctx.wrongByKp.values()) {
    for (const id of ids) wrongIds.add(id)
  }
  const hasSpecialQuestions = (sid: string): boolean => (ctx.specialQuestions.get(sid)?.length ?? 0) > 0
  const chosen =
    pickWeakestSpecial(ctx, wrongIds) ??
    // 无任何错题 → 当前 book 第一个有题可练的专项（specialSets 顺序）
    ctx.specialSets.find((sid) => sid.startsWith(`${ctx.settings.book}-`) && hasSpecialQuestions(sid)) ??
    ctx.specialSets.find(hasSpecialQuestions)
  if (chosen !== undefined) {
    // 巩固优先：该专项曾错题在前（保持题序）、其余按题序补足预算，上限 10
    const questions = ctx.specialQuestions.get(chosen) ?? []
    const ordered = [
      ...questions.filter((q) => wrongIds.has(q.id)),
      ...questions.filter((q) => !wrongIds.has(q.id)),
    ]
    const specialIds = pickByBudget(ordered, alloc.special * 60, SPECIAL_QUESTION_MAX, used)
    if (specialIds.length > 0) tasks.push(mkTask('special', specialIds, alloc.special))
    else summaryMinutes += alloc.special
  } else {
    summaryMinutes += alloc.special
  }

  // summary 任务：固定收尾，questionIds 为空、minutesPlanned 为尾余
  tasks.push(mkTask('summary', [], summaryMinutes))
  return tasks
}
