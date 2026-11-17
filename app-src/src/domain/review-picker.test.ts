import { describe, expect, it } from 'vitest'
import { pickReviewQuestions, REVIEW_LIMIT_DEFAULT, type ReviewPickInput } from './review-picker'
import type { Mastery } from '../types'

/** 本地固定时刻（与 review.test.ts 同口径：期望值按本地日推算断言，时区无关） */
const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)
const NOW = at(2026, 11, 17)

/** 本地某日零点转 UTC ISO（与 review.ts 的 nextReviewAt 存储口径一致） */
const midnight = (y: number, m: number, d: number): string => new Date(y, m - 1, d).toISOString()
const TODAY = midnight(2026, 11, 17)
const YESTERDAY = midnight(2026, 11, 16)
const TOMORROW = midnight(2026, 11, 18)

const row = (kp: string, nextReviewAt?: string): Mastery => ({
  knowledgePointId: kp,
  stage: nextReviewAt ? 'weak' : 'new',
  intervalDays: nextReviewAt ? 1 : 0,
  metrics: { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 },
  ...(nextReviewAt ? { nextReviewAt } : {}),
})

const pick = (over: Partial<ReviewPickInput>): ReturnType<typeof pickReviewQuestions> =>
  pickReviewQuestions({ now: NOW, masteryRows: [], wrongQuestionIdsByKp: new Map(), ...over })

/** 生成 p1…pN 形式的题 ID */
const ids = (p: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${p}${i + 1}`)

describe('到期判定（本地日历日口径）', () => {
  it('nextReviewAt 本地日 = 今日 → 入选', () => {
    const r = pick({ masteryRows: [row('k1', TODAY)], wrongQuestionIdsByKp: new Map([['k1', ['q1']]]) })
    expect(r.questionIds).toEqual(['q1'])
    expect(r.dueKpCount).toBe(1)
  })

  it('nextReviewAt 本地日早于今日（逾期）→ 入选', () => {
    const r = pick({ masteryRows: [row('k1', YESTERDAY)], wrongQuestionIdsByKp: new Map([['k1', ['q1']]]) })
    expect(r.questionIds).toEqual(['q1'])
    expect(r.dueKpCount).toBe(1)
  })

  it('nextReviewAt 在未来 → 不选', () => {
    const r = pick({ masteryRows: [row('k1', TOMORROW)], wrongQuestionIdsByKp: new Map([['k1', ['q1']]]) })
    expect(r.questionIds).toEqual([])
    expect(r.dueKpCount).toBe(0)
    expect(r.availableCount).toBe(0)
  })

  it('无 nextReviewAt（未排期）→ 不选', () => {
    const r = pick({ masteryRows: [row('k1')], wrongQuestionIdsByKp: new Map([['k1', ['q1']]]) })
    expect(r.questionIds).toEqual([])
    expect(r.dueKpCount).toBe(0)
  })

  it('到期但该知识点无曾答错题 → 题目为空，知识点仍计入 dueKpCount', () => {
    const r = pick({ masteryRows: [row('k1', TODAY)], wrongQuestionIdsByKp: new Map() })
    expect(r.questionIds).toEqual([])
    expect(r.dueKpCount).toBe(1)
    expect(r.availableCount).toBe(0)
  })
})

describe('知识点均衡（轮转抽取）', () => {
  it('每轮各知识点取一题：题多的知识点不垄断', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY), row('kB', TODAY), row('kC', TODAY)],
      wrongQuestionIdsByKp: new Map([
        ['kA', ids('a', 8)],
        ['kB', ['b1']],
        ['kC', ids('c', 2)],
      ]),
    })
    // 第 1 轮 kA/kB/kC 各取一题（kB 仅 1 题也应在本轮出现，而非排到 a 系题之后）
    expect(r.questionIds).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  })

  it('同一题挂在两个知识点下只选一次（跨知识点去重）', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY), row('kB', TODAY)],
      wrongQuestionIdsByKp: new Map([
        ['kA', ['x', 'a1']],
        ['kB', ['x', 'b1']],
      ]),
    })
    expect(r.questionIds).toEqual(['x', 'b1', 'a1'])
    expect(r.availableCount).toBe(3)
  })

  it('同知识点内重复题 ID 去重', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY)],
      wrongQuestionIdsByKp: new Map([['kA', ['a1', 'a1', 'a2']]]),
    })
    expect(r.questionIds).toEqual(['a1', 'a2'])
    expect(r.availableCount).toBe(2)
  })
})

describe('上限与不足', () => {
  it('默认上限为 10（常量导出）', () => {
    expect(REVIEW_LIMIT_DEFAULT).toBe(10)
  })

  it('候选超过 10 截断为 10，availableCount 不截断', () => {
    const r = pick({ masteryRows: [row('kA', TODAY)], wrongQuestionIdsByKp: new Map([['kA', ids('a', 12)]]) })
    expect(r.questionIds).toHaveLength(10)
    expect(r.availableCount).toBe(12)
  })

  it('不足 10 返回实际数', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY), row('kB', TODAY)],
      wrongQuestionIdsByKp: new Map([['kA', ['a1']], ['kB', ['b1', 'b2']]]),
    })
    expect(r.questionIds).toEqual(['a1', 'b1', 'b2'])
    expect(r.availableCount).toBe(3)
  })

  it('limit 覆盖默认值', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY), row('kB', TODAY)],
      wrongQuestionIdsByKp: new Map([['kA', ids('a', 5)], ['kB', ids('b', 5)]]),
      limit: 3,
    })
    expect(r.questionIds).toEqual(['a1', 'b1', 'a2'])
  })

  it('无任何到期 → 返回 []（调用方显示"今日无到期复习"）', () => {
    const r = pick({ masteryRows: [row('k1', TOMORROW), row('k2')], wrongQuestionIdsByKp: new Map([['k1', ['q1']]]) })
    expect(r.questionIds).toEqual([])
    expect(r.dueKpCount).toBe(0)
  })
})

describe('alreadyDoneToday（当日已复测不立即重复）', () => {
  it('已答过的题跳过', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY)],
      wrongQuestionIdsByKp: new Map([['kA', ['a1', 'a2']]]),
      alreadyDoneToday: new Set(['a1']),
    })
    expect(r.questionIds).toEqual(['a2'])
    expect(r.availableCount).toBe(1)
  })

  it('全部已答 → 返回 []（不再重复刷同题）', () => {
    const r = pick({
      masteryRows: [row('kA', TODAY)],
      wrongQuestionIdsByKp: new Map([['kA', ['a1', 'a2']]]),
      alreadyDoneToday: new Set(['a1', 'a2']),
    })
    expect(r.questionIds).toEqual([])
    expect(r.availableCount).toBe(0)
  })
})
