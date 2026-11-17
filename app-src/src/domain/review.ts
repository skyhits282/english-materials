import type { Attempt, Mastery, MasteryStage } from '../types'

/** 提交事件（由 repos 层从 attempt 与同题上次 attempt 派生） */
export interface ReviewEvent {
  phase: Attempt['phase']
  isCorrect: boolean
  /** 本次提交的本地日 key（YYYY-MM-DD） */
  localDay: string
  /** 同一题上一次提交的本地日 key（无历史为 undefined） */
  previousLocalDay?: string
}

/** 合法推进档（规格 §1.1 的 1/3/7/14 天档） */
type AdvanceKey = 1 | 3 | 7 | 14

/** 间隔推进表（规格 §1.1）：当前档 → 复测正确后的新档 */
const ADVANCE: Readonly<Record<AdvanceKey, { stage: MasteryStage; intervalDays: number }>> = {
  1: { stage: 'consolidating', intervalDays: 3 },
  3: { stage: 'consolidating', intervalDays: 7 },
  7: { stage: 'mastered', intervalDays: 14 },
  14: { stage: 'mastered', intervalDays: 14 },
}

/** 数值是否为合法推进档 */
function asAdvanceKey(v: number): AdvanceKey | undefined {
  return v === 1 || v === 3 || v === 7 || v === 14 ? v : undefined
}

/** 旧行缺 intervalDays 时按 stage 兜底的默认档（mastery 现为空表，纯防御） */
const STAGE_DEFAULT_INTERVAL: Readonly<Record<MasteryStage, number>> = {
  new: 0,
  weak: 1,
  consolidating: 3,
  mastered: 14,
}

/** 推进档解析：intervalDays 命中 ADVANCE 表用之，否则按 stage 兜底（旧行缺档/非法档防御）。
 *  返回 0 表示未排期（不推进）；非 0 时必为 ADVANCE 表的合法键，后续索引无需非空断言。 */
function resolveAdvanceInterval(row: Pick<Mastery, 'intervalDays' | 'stage'>): AdvanceKey | 0 {
  const direct = asAdvanceKey(row.intervalDays)
  if (direct !== undefined) return direct
  return asAdvanceKey(STAGE_DEFAULT_INTERVAL[row.stage]) ?? 0
}

/** 本地日历日 +days 天的本地零点，转 UTC ISO 存储（跨月/跨年由 Date 构造器自动进位） */
export function localMidnightAfter(now: Date, days: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).toISOString()
}

/** 纯函数：给定当前 mastery（undefined=首条）与提交事件，返回新 mastery。
 *  规格依据：spec §1.1 转移表 + 同日重试不推进（同日仅聚合指标与刷新 lastAttemptAt，
 *  stage/intervalDays/nextReviewAt 原样返回）。 */
export function nextMasteryState(
  current: Mastery | undefined,
  knowledgePointId: string,
  event: ReviewEvent,
  now: Date,
): Mastery {
  const sameDay = event.previousLocalDay !== undefined && event.localDay === event.previousLocalDay
  const metrics: Mastery['metrics'] = {
    testedCount: (current?.metrics.testedCount ?? 0) + 1,
    firstTryCorrect: current?.metrics.firstTryCorrect ?? 0,
    delayedReviewCorrect: current?.metrics.delayedReviewCorrect ?? 0,
  }
  if (event.phase === 'first' && event.isCorrect) metrics.firstTryCorrect += 1
  // 只有隔日及以后的复测才计入"延迟复测"口径（同日即时重试不推进也不计）
  if (event.phase === 'retry' && !sameDay && event.isCorrect) metrics.delayedReviewCorrect += 1
  const lastAttemptAt = now.toISOString()

  // 同日重试：状态机不推进
  if (current && sameDay) {
    return { ...current, metrics, lastAttemptAt }
  }

  let stage: MasteryStage
  let intervalDays: number
  let nextReviewAt: string | undefined

  if (!current) {
    // 首条：首测错误进 weak 次日复测；首测正确保持 new、不排期
    stage = event.isCorrect ? 'new' : 'weak'
    intervalDays = event.isCorrect ? 0 : 1
    nextReviewAt = event.isCorrect ? undefined : localMidnightAfter(now, 1)
  } else if (!event.isCorrect) {
    // 复测错误（或新题首测错误）：一律回到 weak、次日
    stage = 'weak'
    intervalDays = 1
    nextReviewAt = localMidnightAfter(now, 1)
  } else if (event.phase === 'first') {
    // 新题首测正确：不推进既有排期（推进只走隔日复测口径）
    stage = current.stage
    intervalDays = current.intervalDays
    nextReviewAt = current.nextReviewAt
  } else {
    const interval = resolveAdvanceInterval(current)
    if (interval === 0) {
      // 未排期（new）知识点复测正确：仍不排期
      stage = current.stage
      intervalDays = 0
      nextReviewAt = current.nextReviewAt
    } else {
      const adv = ADVANCE[interval]
      stage = adv.stage
      intervalDays = adv.intervalDays
      nextReviewAt = localMidnightAfter(now, intervalDays)
    }
  }

  return {
    knowledgePointId,
    stage,
    intervalDays,
    ...(nextReviewAt !== undefined ? { nextReviewAt } : {}),
    lastAttemptAt,
    metrics,
  }
}
