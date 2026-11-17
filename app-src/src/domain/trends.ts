import type { Attempt, Mastery, Question } from '../types'
import type { TaskRow } from '../db/schema'
import { localDayKey } from './metrics'
import { nextMasteryState, type ReviewEvent } from './review'
import { vocabKpFromQuestionId } from '../content/loader'

/** 单日聚合（七日趋势与周报共用）：首测与复测都计入 answered/correct，首测口径单列供折线 */
export interface DailyStat {
  /** 本地日 key（YYYY-MM-DD） */
  date: string
  /** 当日作答数（首测 + 复测） */
  answered: number
  /** 当日答对数（首测 + 复测） */
  correct: number
  /** 当日首测数 */
  firstAnswered: number
  /** 当日首测答对数 */
  firstCorrect: number
  /** 当日首测正确率；无首测为 null（图表跳点、文字显示"暂无"） */
  firstRate: number | null
}

/** 七日趋势合并输出（报告页图表 + 文字摘要） */
export interface SevenDayTrend {
  /** 升序 7 项（含今日） */
  days: DailyStat[]
  totalAnswered: number
  firstAnswered: number
  firstCorrect: number
  /** 七日整体首测正确率；无首测为 null */
  firstRate: number | null
}

/** 优先薄弱点（知识点粒度） */
export interface WeakPoint {
  /** 知识点 ID（选择题直接取 knowledgePointIds；词题为 vocab.<book>.<短单元名>） */
  kp: string
  firstAnswered: number
  firstCorrect: number
  /** 首测错误率（0-1） */
  wrongRate: number
}

/** 反复错题知识点（周报用）：本周答错 ≥2 次的知识点 */
export interface RepeatWrongKp {
  kp: string
  /** 本周错误作答次数（首测 + 复测；一题多知识点按各知识点各计 1 次） */
  wrongCount: number
}

/** 本周周报事实（规格 §7.5：本地计算，始终可见，AI 建议由 Task 11 叠加） */
export interface WeeklyFacts {
  /** 本周一的本地日 key（周一起始口径） */
  weekStart: string
  /** 本周有作答的不同本地日数 */
  studyDays: number
  /** 本周作答次数（首测 + 复测） */
  answeredCount: number
  /** 本周任务完成率（completed ÷ 本周任务总数）；本周无任务为 null */
  completionRate: number | null
  /** 本周首测正确率；无首测为 null */
  firstRate: number | null
  /** 本周复测正确率（与报告页复测正确率同口径：全部 phase=retry）；无复测为 null */
  delayedRate: number | null
  /** 本周答错 ≥2 次的知识点（错误次数降序，并列按 kp 字典序） */
  repeatWrongKps: RepeatWrongKp[]
  /** 当前快照中到期（nextReviewAt 本地日 ≤ 今日）未复测的知识点数 */
  overdueReviews: number
}

/** 知识点覆盖率（报告页指标区）：本周实际练到且属计划目标的知识点 ÷ 目标总数 */
export interface KpCoverage {
  covered: number
  target: number
  /** target 为 0 时 null（页面显示"暂无数据"） */
  rate: number | null
}

/** 本地日 key +days 天（跨月/跨年由 Date 构造器自动进位） */
function dayKeyOffset(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return localDayKey(new Date(y!, m! - 1, d! + days))
}

/** 周一起始的本周窗口 [周一, 周日]（本地日 key，含两端） */
function weekWindow(now: Date): [string, string] {
  const back = (now.getDay() + 6) % 7 // 周一→0 … 周日→6
  const start = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back))
  return [start, dayKeyOffset(start, 6)]
}

/** questionId → 知识点列表：选择题查 questions 表映射；词题不在表内，按 ID 约定派生
 *  （vocabKpFromQuestionId，与 repos.resolveQuestionKps 同口径；两边都未命中返回空） */
function buildKpIndex(questions: Question[]): Map<string, string[]> {
  return new Map(questions.map((question) => [question.id, question.knowledgePointIds]))
}

function kpsForQuestion(questionId: string, index: Map<string, string[]>): string[] {
  const kps = index.get(questionId)
  if (kps !== undefined) return kps
  const vocabKp = vocabKpFromQuestionId(questionId)
  return vocabKp !== undefined ? [vocabKp] : []
}

/** 连续 7 个本地日 key（升序、含今日） */
export function last7Days(now: Date): string[] {
  const days: string[] = []
  for (let i = 6; i >= 0; i--) {
    days.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  return days
}

/** 按给定日 key 聚合每日作答（窗口外的作答忽略） */
export function dailyStats(attempts: Attempt[], days: readonly string[]): DailyStat[] {
  const byKey = new Map<string, DailyStat>()
  for (const day of days) {
    byKey.set(day, { date: day, answered: 0, correct: 0, firstAnswered: 0, firstCorrect: 0, firstRate: null })
  }
  for (const attempt of attempts) {
    const stat = byKey.get(localDayKey(new Date(attempt.submittedAt)))
    if (stat === undefined) continue
    stat.answered += 1
    if (attempt.isCorrect) stat.correct += 1
    if (attempt.phase === 'first') {
      stat.firstAnswered += 1
      if (attempt.isCorrect) stat.firstCorrect += 1
    }
  }
  for (const stat of byKey.values()) {
    stat.firstRate = stat.firstAnswered > 0 ? stat.firstCorrect / stat.firstAnswered : null
  }
  return days.map((day) => byKey.get(day)!)
}

/** 七日趋势（最近 7 个本地日）：晚于 now 的作答不计（now 可注入，测试与跨日边界用） */
export function sevenDayTrend(attempts: Attempt[], now: Date): SevenDayTrend {
  const days = last7Days(now)
  const cutoff = now.toISOString()
  const stats = dailyStats(attempts.filter((a) => a.submittedAt <= cutoff), days)
  const totalAnswered = stats.reduce((n, s) => n + s.answered, 0)
  const firstAnswered = stats.reduce((n, s) => n + s.firstAnswered, 0)
  const firstCorrect = stats.reduce((n, s) => n + s.firstCorrect, 0)
  return {
    days: stats,
    totalAnswered,
    firstAnswered,
    firstCorrect,
    firstRate: firstAnswered > 0 ? firstCorrect / firstAnswered : null,
  }
}

/** 优先薄弱点：首测错误率降序 top3 知识点（不足 3 个返回实际个数）。
 *  - 粒度：选择题用 question.knowledgePointIds；词题用 vocab.<book>.<短单元名>（Task 3 约定）；
 *  - 门槛：知识点首测作答 ≥ min 次才参与；错误率并列按首测题数降序，再并列按 kp 字典序；
 *  - 只统计 phase=first；晚于 now 的作答不计（now 可注入）。 */
export function weakPoints(attempts: Attempt[], questions: Question[], now: Date = new Date(), min = 3): WeakPoint[] {
  const index = buildKpIndex(questions)
  const cutoff = now.toISOString()
  const first = new Map<string, { answered: number; correct: number }>()
  for (const attempt of attempts) {
    if (attempt.phase !== 'first' || attempt.submittedAt > cutoff) continue
    for (const kp of kpsForQuestion(attempt.questionId, index)) {
      const stat = first.get(kp) ?? { answered: 0, correct: 0 }
      stat.answered += 1
      if (attempt.isCorrect) stat.correct += 1
      first.set(kp, stat)
    }
  }
  return [...first.entries()]
    .filter(([, stat]) => stat.answered >= min)
    .map(([kp, stat]) => ({
      kp,
      firstAnswered: stat.answered,
      firstCorrect: stat.correct,
      wrongRate: (stat.answered - stat.correct) / stat.answered,
    }))
    .sort((x, y) => y.wrongRate - x.wrongRate || y.firstAnswered - x.firstAnswered || (x.kp < y.kp ? -1 : 1))
    .slice(0, 3)
}

/** 复测按时率（口径为"事件级重放"，比行级近似更贴近真实履约；到期数为 0 返回 null）：
 *  - 按 attempts 升序重放 nextMasteryState（与提交时 applyMasteryUpdate 同一状态机），
 *    还原每次 phase=retry 提交当时该知识点在排期的 nextReviewAt；
 *  - 到期应复测（分母）＝ 复测提交时已到期（nextReviewAt 本地日 ≤ 提交本地日）的事件数，
 *    加上传入 mastery 快照中 nextReviewAt 本地日 ≤ 今日且尚未复测的行数（欠着的到期复测；
 *    正常调用时该快照与重放终态一致）。早于排期日的提前重练不计入分母（彼时未到期，重练会顺延排期）；
 *  - 按窗口完成（分子）＝ 复测提交本地日落在 [nextReviewAt 本地日, +1 天] 内。 */
export function reviewOnTimeRate(
  mastery: Mastery[],
  attempts: Attempt[],
  questions: Question[],
  now: Date = new Date(),
): number | null {
  const index = buildKpIndex(questions)
  const today = localDayKey(now)
  let due = 0
  let onTime = 0
  const stateByKp = new Map<string, Mastery>()
  const lastDayByQuestion = new Map<string, string>()
  const sorted = [...attempts].sort((x, y) => (x.submittedAt < y.submittedAt ? -1 : 1))
  for (const attempt of sorted) {
    const when = new Date(attempt.submittedAt)
    const localDay = localDayKey(when)
    for (const kp of kpsForQuestion(attempt.questionId, index)) {
      const prior = stateByKp.get(kp)
      if (attempt.phase === 'retry' && prior?.nextReviewAt !== undefined) {
        const dueDay = localDayKey(new Date(prior.nextReviewAt))
        if (dueDay <= localDay) {
          due += 1
          if (localDay === dueDay || localDay === dayKeyOffset(dueDay, 1)) onTime += 1
        }
      }
      const event: ReviewEvent = {
        phase: attempt.phase,
        isCorrect: attempt.isCorrect,
        localDay,
        ...(lastDayByQuestion.has(attempt.questionId)
          ? { previousLocalDay: lastDayByQuestion.get(attempt.questionId) }
          : {}),
      }
      stateByKp.set(kp, nextMasteryState(prior, kp, event, when))
    }
    lastDayByQuestion.set(attempt.questionId, localDay)
  }
  for (const row of mastery) {
    if (row.nextReviewAt !== undefined && localDayKey(new Date(row.nextReviewAt)) <= today) due += 1
  }
  return due === 0 ? null : onTime / due
}

/** 本周周报事实（周一起始的本周，now 可注入） */
export function weeklyFacts(
  attempts: Attempt[],
  tasks: TaskRow[],
  mastery: Mastery[],
  questions: Question[],
  now: Date = new Date(),
): WeeklyFacts {
  const index = buildKpIndex(questions)
  const [weekStart, weekEnd] = weekWindow(now)
  const today = localDayKey(now)
  const dayOf = (iso: string) => localDayKey(new Date(iso))
  const weekAttempts = attempts.filter((a) => {
    const day = dayOf(a.submittedAt)
    return day >= weekStart && day <= weekEnd
  })
  const first = weekAttempts.filter((a) => a.phase === 'first')
  const retry = weekAttempts.filter((a) => a.phase === 'retry')
  const weekTasks = tasks.filter((t) => t.day >= weekStart && t.day <= weekEnd)
  const completed = weekTasks.filter((t) => t.status === 'completed').length
  const wrongByKp = new Map<string, number>()
  for (const attempt of weekAttempts) {
    if (attempt.isCorrect) continue
    for (const kp of kpsForQuestion(attempt.questionId, index)) {
      wrongByKp.set(kp, (wrongByKp.get(kp) ?? 0) + 1)
    }
  }
  return {
    weekStart,
    studyDays: new Set(weekAttempts.map((a) => dayOf(a.submittedAt))).size,
    answeredCount: weekAttempts.length,
    completionRate: weekTasks.length > 0 ? completed / weekTasks.length : null,
    firstRate: first.length > 0 ? first.filter((a) => a.isCorrect).length / first.length : null,
    delayedRate: retry.length > 0 ? retry.filter((a) => a.isCorrect).length / retry.length : null,
    repeatWrongKps: [...wrongByKp.entries()]
      .filter(([, n]) => n >= 2)
      .map(([kp, wrongCount]) => ({ kp, wrongCount }))
      .sort((x, y) => y.wrongCount - x.wrongCount || (x.kp < y.kp ? -1 : 1)),
    overdueReviews: mastery.filter(
      (row) => row.nextReviewAt !== undefined && localDayKey(new Date(row.nextReviewAt)) <= today,
    ).length,
  }
}

/** 知识点覆盖率：目标集 = 本周（周一起始）计划任务 questionIds 覆盖的知识点（选择题经
 *  questions 表、词题经 ID 约定派生）；分子 = 本周实际作答覆盖且属目标集的知识点数。
 *  目标数为 0（本周无计划任务）返回 null。 */
export function knowledgePointCoverage(
  attempts: Attempt[],
  tasks: TaskRow[],
  questions: Question[],
  now: Date = new Date(),
): KpCoverage {
  const index = buildKpIndex(questions)
  const [weekStart, weekEnd] = weekWindow(now)
  const target = new Set<string>()
  for (const t of tasks) {
    if (t.day < weekStart || t.day > weekEnd) continue
    for (const questionId of t.questionIds) {
      for (const kp of kpsForQuestion(questionId, index)) target.add(kp)
    }
  }
  const covered = new Set<string>()
  if (target.size > 0) {
    for (const attempt of attempts) {
      const day = localDayKey(new Date(attempt.submittedAt))
      if (day < weekStart || day > weekEnd) continue
      for (const kp of kpsForQuestion(attempt.questionId, index)) {
        if (target.has(kp)) covered.add(kp)
      }
    }
  }
  return { covered: covered.size, target: target.size, rate: target.size > 0 ? covered.size / target.size : null }
}
