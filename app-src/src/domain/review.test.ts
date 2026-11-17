import { describe, expect, it } from 'vitest'
import { localMidnightAfter, nextMasteryState, type ReviewEvent } from './review'
import { localDayKey } from './metrics'
import type { AttemptPhase, Mastery } from '../types'

/** 本地固定时刻（测试与运行时区无关：期望值均按同一本地日推算口径断言） */
const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)

const NOW = at(2026, 11, 17)
const NEXT_DAY = new Date(2026, 10, 18).toISOString()

const ev = (
  phase: AttemptPhase,
  isCorrect: boolean,
  now: Date,
  previousLocalDay?: string,
): ReviewEvent => ({
  phase,
  isCorrect,
  localDay: localDayKey(now),
  ...(previousLocalDay !== undefined ? { previousLocalDay } : {}),
})

/** 上一日的本地日 key（隔日事件用） */
const prevDayOf = (now: Date): string => localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

const row = (stage: Mastery['stage'], intervalDays: number, metrics: Mastery['metrics'], nextReviewAt?: string): Mastery => ({
  knowledgePointId: 'k',
  stage,
  intervalDays,
  metrics,
  ...(nextReviewAt ? { nextReviewAt } : {}),
})

const KP = 'vocab.g7a.u1'

describe('nextMasteryState（规格 §1.1 转移表）', () => {
  it('首测错误（无 mastery 行）→ weak、interval 1、次日本地零点', () => {
    const m = nextMasteryState(undefined, KP, ev('first', false, NOW), NOW)
    expect(m).toEqual({
      knowledgePointId: KP,
      stage: 'weak',
      intervalDays: 1,
      nextReviewAt: NEXT_DAY,
      lastAttemptAt: NOW.toISOString(),
      metrics: { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 },
    })
  })

  it('首测正确（无 mastery 行）→ new、未排期、firstTryCorrect 计 1', () => {
    const m = nextMasteryState(undefined, KP, ev('first', true, NOW), NOW)
    expect(m.stage).toBe('new')
    expect(m.intervalDays).toBe(0)
    expect(m.nextReviewAt).toBeUndefined()
    expect(m.metrics).toEqual({ testedCount: 1, firstTryCorrect: 1, delayedReviewCorrect: 0 })
  })

  it('隔日复测错误（stage weak）→ 仍 weak、1 天、次日；仅计 tested', () => {
    const cur = row('weak', 1, { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 }, NEXT_DAY)
    const m = nextMasteryState(cur, KP, ev('retry', false, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
    expect(m.metrics).toEqual({ testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 0 })
  })

  it('隔日复测正确（weak、1 天档）→ consolidating、3 天', () => {
    const cur = row('weak', 1, { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 }, NEXT_DAY)
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('consolidating')
    expect(m.intervalDays).toBe(3)
    expect(m.nextReviewAt).toBe(new Date(2026, 10, 20).toISOString())
    expect(m.metrics.delayedReviewCorrect).toBe(1)
  })

  it('隔日复测正确（consolidating、3 天档）→ consolidating、7 天', () => {
    const cur = row('consolidating', 3, { testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 1 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('consolidating')
    expect(m.intervalDays).toBe(7)
    expect(m.nextReviewAt).toBe(new Date(2026, 10, 24).toISOString())
  })

  it('隔日复测正确（consolidating、7 天档）→ mastered、14 天', () => {
    const cur = row('consolidating', 7, { testedCount: 3, firstTryCorrect: 0, delayedReviewCorrect: 2 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('mastered')
    expect(m.intervalDays).toBe(14)
    expect(m.nextReviewAt).toBe(new Date(2026, 11, 1).toISOString())
  })

  it('mastered 到期复测错误 → 回退 weak、1 天、次日', () => {
    const cur = row('mastered', 14, { testedCount: 4, firstTryCorrect: 0, delayedReviewCorrect: 3 })
    const m = nextMasteryState(cur, KP, ev('retry', false, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
    expect(m.metrics).toEqual({ testedCount: 5, firstTryCorrect: 0, delayedReviewCorrect: 3 })
  })

  it('mastered 到期复测正确 → 保持 mastered、再排 14 天', () => {
    const cur = row('mastered', 14, { testedCount: 4, firstTryCorrect: 0, delayedReviewCorrect: 3 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('mastered')
    expect(m.intervalDays).toBe(14)
    expect(m.nextReviewAt).toBe(new Date(2026, 11, 1).toISOString())
    expect(m.metrics.delayedReviewCorrect).toBe(4)
  })
})

describe('同日重试不推进', () => {
  it('同日 retry（weak）→ stage/interval/nextReviewAt 原样，仅计 tested 与刷新 lastAttemptAt', () => {
    const cur = row('weak', 1, { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 }, NEXT_DAY)
    const m = nextMasteryState(cur, KP, ev('retry', false, NOW, localDayKey(NOW)), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
    expect(m.metrics).toEqual({ testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 0 })
    expect(m.lastAttemptAt).toBe(NOW.toISOString())
  })

  it('同日 retry 答对也不推进、不计 delayedReviewCorrect', () => {
    const cur = row('consolidating', 3, { testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 1 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, localDayKey(NOW)), NOW)
    expect(m.stage).toBe('consolidating')
    expect(m.intervalDays).toBe(3)
    expect(m.metrics).toEqual({ testedCount: 3, firstTryCorrect: 0, delayedReviewCorrect: 1 })
  })

  it('同日 retry（mastered）不回退', () => {
    const cur = row('mastered', 14, { testedCount: 4, firstTryCorrect: 0, delayedReviewCorrect: 3 })
    const m = nextMasteryState(cur, KP, ev('retry', false, NOW, localDayKey(NOW)), NOW)
    expect(m.stage).toBe('mastered')
    expect(m.intervalDays).toBe(14)
  })
})

describe('已有行的其余事件', () => {
  it('新题首测错误（已有 consolidating 行）→ 回退 weak、次日', () => {
    const cur = row('consolidating', 3, { testedCount: 2, firstTryCorrect: 1, delayedReviewCorrect: 1 })
    const m = nextMasteryState(cur, KP, ev('first', false, NOW), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
    expect(m.metrics).toEqual({ testedCount: 3, firstTryCorrect: 1, delayedReviewCorrect: 1 })
  })

  it('新题首测正确（已有 weak 行）→ 状态不推进，firstTryCorrect 累加', () => {
    const cur = row('weak', 1, { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 }, NEXT_DAY)
    const m = nextMasteryState(cur, KP, ev('first', true, NOW), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
    expect(m.metrics).toEqual({ testedCount: 2, firstTryCorrect: 1, delayedReviewCorrect: 0 })
  })

  it('new 行（首测全对、未排期）隔日复测正确 → 仍不排期', () => {
    const cur = row('new', 0, { testedCount: 1, firstTryCorrect: 1, delayedReviewCorrect: 0 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('new')
    expect(m.intervalDays).toBe(0)
    expect(m.nextReviewAt).toBeUndefined()
    expect(m.metrics.delayedReviewCorrect).toBe(1)
  })

  it('new 行隔日复测错误 → 进入 weak、次日', () => {
    const cur = row('new', 0, { testedCount: 1, firstTryCorrect: 1, delayedReviewCorrect: 0 })
    const m = nextMasteryState(cur, KP, ev('retry', false, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
  })
})

describe('本地日推算（注入 now）', () => {
  it('跨月：11-30 首错 → 次日为 12-01 本地零点', () => {
    const now = at(2026, 11, 30, 20)
    const m = nextMasteryState(undefined, KP, ev('first', false, now), now)
    expect(localDayKey(new Date(m.nextReviewAt!))).toBe('2026-12-01')
    expect(m.nextReviewAt).toBe(new Date(2026, 11, 1).toISOString())
  })

  it('跨年：12-31 隔日复测对（1 天档）→ 3 天后为 01-03 本地零点', () => {
    const now = at(2026, 12, 31, 9)
    const cur = row('weak', 1, { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 })
    const m = nextMasteryState(cur, KP, ev('retry', true, now, prevDayOf(now)), now)
    expect(m.nextReviewAt).toBe(new Date(2027, 0, 3).toISOString())
    expect(localDayKey(new Date(m.nextReviewAt!))).toBe('2027-01-03')
  })

  it('localMidnightAfter 结果总是本地零点（小时/分/秒为 0）', () => {
    const iso = localMidnightAfter(at(2026, 2, 28, 23), 1)
    const d = new Date(iso)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(localDayKey(d)).toBe('2026-03-01')
  })
})

describe('metrics 累加规则（跨事件序列）', () => {
  it('首错→隔日对→隔日对→同日错：tested/firstTryCorrect/delayedReviewCorrect 按口径累加', () => {
    let m = nextMasteryState(undefined, KP, ev('first', false, NOW), NOW)
    expect(m.metrics).toEqual({ testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 })
    const d2 = at(2026, 11, 18)
    m = nextMasteryState(m, KP, ev('retry', true, d2, localDayKey(NOW)), d2)
    expect(m.metrics).toEqual({ testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 1 })
    const d3 = at(2026, 11, 21)
    m = nextMasteryState(m, KP, ev('retry', true, d3, localDayKey(at(2026, 11, 20))), d3)
    expect(m.metrics).toEqual({ testedCount: 3, firstTryCorrect: 0, delayedReviewCorrect: 2 })
    const d4 = at(2026, 11, 21, 15)
    m = nextMasteryState(m, KP, ev('retry', false, d4, localDayKey(d3)), d4)
    expect(m.metrics).toEqual({ testedCount: 4, firstTryCorrect: 0, delayedReviewCorrect: 2 })
    expect(m.stage).toBe('consolidating')
    expect(m.intervalDays).toBe(7)
  })
})

describe('防御分支（Task 9 补测试）', () => {
  it('旧行 intervalDays 不在 ADVANCE 表（如 5）→ 按 stage 兜底档推进（consolidating→3 天档→7 天）', () => {
    const cur = row('consolidating', 5, { testedCount: 3, firstTryCorrect: 0, delayedReviewCorrect: 2 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('consolidating')
    expect(m.intervalDays).toBe(7)
    expect(m.nextReviewAt).toBe(new Date(2026, 10, 24).toISOString())
  })

  it('旧行 intervalDays 非法且 stage=new（兜底 0=未排期）→ 复测正确仍不排期', () => {
    const cur = row('new', 5, { testedCount: 1, firstTryCorrect: 1, delayedReviewCorrect: 0 })
    const m = nextMasteryState(cur, KP, ev('retry', true, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('new')
    expect(m.intervalDays).toBe(0)
    expect(m.nextReviewAt).toBeUndefined()
  })

  it('有提交历史但 mastery 行缺失（防御）→ 隔日 retry 答错按首错处理：weak、次日', () => {
    const m = nextMasteryState(undefined, KP, ev('retry', false, NOW, prevDayOf(NOW)), NOW)
    expect(m.stage).toBe('weak')
    expect(m.intervalDays).toBe(1)
    expect(m.nextReviewAt).toBe(NEXT_DAY)
  })

  it('有提交历史但 mastery 行缺失（防御）→ 同日 retry 与无历史同口径，不因缺行抛错', () => {
    const m = nextMasteryState(undefined, KP, ev('retry', true, NOW, localDayKey(NOW)), NOW)
    expect(m.stage).toBe('new')
    expect(m.intervalDays).toBe(0)
    expect(m.metrics).toEqual({ testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 })
  })
})
