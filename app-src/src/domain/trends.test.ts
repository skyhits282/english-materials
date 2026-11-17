import { describe, expect, it } from 'vitest'
import type { DailyStat, WeeklyFacts } from './trends'
import {
  dailyStats,
  knowledgePointCoverage,
  last7Days,
  reviewOnTimeRate,
  sevenDayTrend,
  weakPoints,
  weeklyFacts,
} from './trends'
import { renderTrendChart } from '../ui/chart'
import type { Attempt, Mastery, Question } from '../types'
import type { TaskRow } from '../db/schema'

/** 本地某日指定时刻的 ISO（时区无关：任意测试机时区下都落在同一本地日） */
const at = (y: number, m: number, d: number, h = 10, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString()

/** 本地某日零点的 ISO（mastery.nextReviewAt 的存储口径：本地零点转 UTC） */
const midnight = (y: number, m: number, d: number): string => new Date(y, m - 1, d).toISOString()

const a = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry', submittedAt: string): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase,
  submittedAt,
})

const q = (id: string, knowledgePointIds: string[]): Question => ({
  id,
  contentVersion: 'test',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: '',
  knowledgePointIds,
  type: 'single_choice',
  stem: '',
  options: [],
  answerSpec: { correctOptionIndex: 0 },
  explanation: '',
  difficulty: 1,
  estimatedSeconds: 30,
})

const task = (id: string, day: string, status: TaskRow['status'], questionIds: string[]): TaskRow => ({
  id,
  day,
  type: 'special',
  questionIds,
  status,
  minutesPlanned: 10,
})

const mastery = (kp: string, nextReviewAt?: string): Mastery => ({
  knowledgePointId: kp,
  stage: 'weak',
  intervalDays: 1,
  ...(nextReviewAt !== undefined ? { nextReviewAt } : {}),
  metrics: { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 },
})

describe('last7Days（连续 7 个本地日 key）', () => {
  it('升序 7 项、含今日', () => {
    expect(last7Days(new Date(2026, 10, 17, 23, 30))).toEqual([
      '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17',
    ])
  })
  it('跨月边界', () => {
    expect(last7Days(new Date(2026, 11, 1, 8))).toEqual([
      '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01',
    ])
  })
})

describe('dailyStats（首测+复测都计入 answered/correct）', () => {
  it('按日聚合，窗口外的作答忽略', () => {
    const stats = dailyStats(
      [
        a('1', 'q1', true, 'first', at(2026, 11, 16)),
        a('2', 'q1', false, 'retry', at(2026, 11, 16, 11)),
        a('3', 'q2', true, 'first', at(2026, 11, 17)),
        a('4', 'q3', false, 'first', at(2026, 11, 10)),
      ],
      ['2026-11-16', '2026-11-17'],
    )
    expect(stats).toEqual([
      { date: '2026-11-16', answered: 2, correct: 1, firstAnswered: 1, firstCorrect: 1, firstRate: 1 },
      { date: '2026-11-17', answered: 1, correct: 1, firstAnswered: 1, firstCorrect: 1, firstRate: 1 },
    ])
  })
  it('无首测的日期 firstRate 为 null；空 attempts 全零不抛错', () => {
    const stats = dailyStats([], ['2026-11-16'])
    expect(stats).toEqual([
      { date: '2026-11-16', answered: 0, correct: 0, firstAnswered: 0, firstCorrect: 0, firstRate: null },
    ])
  })
})

describe('sevenDayTrend（七日窗口聚合）', () => {
  const now = new Date(2026, 10, 17, 12)
  it('合并输出：天数、题量、首测口径', () => {
    const trend = sevenDayTrend(
      [
        a('1', 'q1', false, 'first', at(2026, 11, 15)),
        a('2', 'q2', true, 'first', at(2026, 11, 15, 11)),
        a('3', 'q1', true, 'retry', at(2026, 11, 16)),
        a('4', 'q9', true, 'first', at(2026, 11, 3)), // 7 天窗口外
      ],
      now,
    )
    expect(trend.days).toHaveLength(7)
    expect(trend.days[0]!.date).toBe('2026-11-11')
    expect(trend.days[6]!.date).toBe('2026-11-17')
    expect(trend.totalAnswered).toBe(3)
    expect(trend.firstAnswered).toBe(2)
    expect(trend.firstCorrect).toBe(1)
    expect(trend.firstRate).toBe(0.5)
  })
  it('晚于 now 的作答不计（注入 now 可测）', () => {
    const trend = sevenDayTrend([a('1', 'q1', true, 'first', at(2026, 11, 18))], now)
    expect(trend.totalAnswered).toBe(0)
  })
  it('空 attempts：不抛错，firstRate 为 null', () => {
    const trend = sevenDayTrend([], now)
    expect(trend.totalAnswered).toBe(0)
    expect(trend.firstRate).toBeNull()
  })
})

describe('weakPoints（首测错误率降序 top3 知识点）', () => {
  const questions = [
    q('qa1', ['kp.a']), q('qa2', ['kp.a']), q('qa3', ['kp.a']),
    q('qb1', ['kp.b']), q('qb2', ['kp.b']), q('qb3', ['kp.b']),
    q('qc1', ['kp.c']), q('qc2', ['kp.c']),
  ]
  const now = new Date(2026, 10, 17, 12)
  const attempts = [
    // kp.a：3 次首测 1 对（错误率 2/3）
    a('1', 'qa1', true, 'first', at(2026, 11, 14)),
    a('2', 'qa2', false, 'first', at(2026, 11, 14, 11)),
    a('3', 'qa3', false, 'first', at(2026, 11, 15)),
    // 复测不计入首测口径
    a('4', 'qa1', true, 'retry', at(2026, 11, 16)),
    // kp.b：3 次首测全错（错误率 1）
    a('5', 'qb1', false, 'first', at(2026, 11, 14)),
    a('6', 'qb2', false, 'first', at(2026, 11, 15)),
    a('7', 'qb3', false, 'first', at(2026, 11, 16)),
    // kp.c：仅 2 次首测（低于门槛 3，即使全错也不参与）
    a('8', 'qc1', false, 'first', at(2026, 11, 15)),
    a('9', 'qc2', false, 'first', at(2026, 11, 16)),
    // 词题：不在 questions 表，按 ID 约定派生知识点 vocab.g7a.u4（3 次首测全错，与 kp.b 并列）
    a('10', 'g7a-vocab-u4-0001', false, 'first', at(2026, 11, 15)),
    a('11', 'g7a-vocab-u4-0002', false, 'first', at(2026, 11, 16)),
    a('12', 'g7a-vocab-u4-0003', false, 'first', at(2026, 11, 16, 11)),
  ]

  it('按错误率降序取 top3；错误率与题数均并列时按 kp 字典序；低于门槛排除；词题按 ID 派生', () => {
    expect(weakPoints(attempts, questions, now)).toEqual([
      { kp: 'kp.b', firstAnswered: 3, firstCorrect: 0, wrongRate: 1 },
      { kp: 'vocab.g7a.u4', firstAnswered: 3, firstCorrect: 0, wrongRate: 1 },
      { kp: 'kp.a', firstAnswered: 3, firstCorrect: 1, wrongRate: 2 / 3 },
    ])
  })
  it('晚于 now 的作答不计入', () => {
    const later = [...attempts, a('13', 'qb1', false, 'first', at(2026, 11, 18))]
    expect(weakPoints(later, questions, now)[0]!.firstAnswered).toBe(3)
  })
  it('min 参数可调（=2 时 kp.c 参与）', () => {
    const top = weakPoints(attempts, questions, now, 2)
    expect(top.map((w) => w.kp)).toEqual(['kp.b', 'vocab.g7a.u4', 'kp.c'])
  })
  it('错误率并列时按题数降序', () => {
    const qs = [q('x1', ['kpx']), q('x2', ['kpx']), q('y1', ['kpy']), q('y2', ['kpy']), q('y3', ['kpy']), q('y4', ['kpy'])]
    const atts = [
      // kpx：2 次首测错 1（错误率 1/2）；kpy：4 次首测错 2（错误率 1/2）→ 并列，kpy 题数多在前
      a('1', 'x1', false, 'first', at(2026, 11, 14)),
      a('2', 'x2', true, 'first', at(2026, 11, 14, 11)),
      a('3', 'y1', false, 'first', at(2026, 11, 15)),
      a('4', 'y2', false, 'first', at(2026, 11, 15, 11)),
      a('5', 'y3', true, 'first', at(2026, 11, 16)),
      a('6', 'y4', true, 'first', at(2026, 11, 16, 11)),
    ]
    const top = weakPoints(atts, qs, now, 2)
    expect(top.map((w) => w.kp)).toEqual(['kpy', 'kpx'])
    expect(top[0]!.wrongRate).toBe(0.5)
  })
  it('空 attempts 返回空数组', () => {
    expect(weakPoints([], questions, now)).toEqual([])
  })
})

describe('reviewOnTimeRate（事件级重放口径）', () => {
  const questions = [q('q1', ['kp.a'])]
  const now = new Date(2026, 10, 17, 20)

  it('到期且窗口内完成的复测计按时：两连按时的隔日复测 → 100%', () => {
    const attempts = [
      a('1', 'q1', false, 'first', at(2026, 11, 10)), // 首测错 → 次日（11-11）到期
      a('2', 'q1', true, 'retry', at(2026, 11, 11)), // 到期当日复测 → 按时；推进 3 天 → 11-14
      a('3', 'q1', true, 'retry', at(2026, 11, 14)), // 到期当日复测 → 按时；推进 7 天 → 11-21
    ]
    const masteryRows = [mastery('kp.a', midnight(2026, 11, 21))]
    expect(reviewOnTimeRate(masteryRows, attempts, questions, now)).toBe(1)
  })

  it('逾期后补复测：计入到期但不计入按时', () => {
    const attempts = [
      a('1', 'q1', false, 'first', at(2026, 11, 10)), // → 11-11 到期
      a('2', 'q1', true, 'retry', at(2026, 11, 16)), // 窗口 [11-11, 11-12] 外 → 不按时
    ]
    const masteryRows = [mastery('kp.a', midnight(2026, 11, 19))]
    expect(reviewOnTimeRate(masteryRows, attempts, questions, now)).toBe(0)
  })

  it('当前快照中到期未复测的行计入分母', () => {
    const attempts = [a('1', 'q1', false, 'first', at(2026, 11, 10))] // → 11-11 到期，一直未复测
    const masteryRows = [mastery('kp.a', midnight(2026, 11, 11))]
    expect(reviewOnTimeRate(masteryRows, attempts, questions, now)).toBe(0)
  })

  it('到期数为 0 返回 null（页面显示不适用）', () => {
    expect(reviewOnTimeRate([], [], questions, now)).toBeNull()
    expect(reviewOnTimeRate([mastery('kp.a', midnight(2026, 11, 21))], [], questions, now)).toBeNull()
    expect(reviewOnTimeRate([mastery('kp.a')], [], questions, now)).toBeNull()
  })

  it('同日重试属提前重练：排期未到不计入分母，仅欠账的到期复测计 1', () => {
    const attempts = [
      a('1', 'q1', false, 'first', at(2026, 11, 12)), // → 11-13 到期
      a('2', 'q1', false, 'retry', at(2026, 11, 12, 11)), // 同日重试不推进、未到期 → 不计
    ]
    const masteryRows = [mastery('kp.a', midnight(2026, 11, 13))]
    expect(reviewOnTimeRate(masteryRows, attempts, questions, now)).toBe(0)
  })

  it('多知识点题目的复测按各知识点分别计事件', () => {
    const multi = [q('q1', ['kp.a', 'kp.b'])]
    const attempts = [
      a('1', 'q1', false, 'first', at(2026, 11, 10)),
      a('2', 'q1', true, 'retry', at(2026, 11, 11)),
    ]
    const masteryRows = [mastery('kp.a', midnight(2026, 11, 21)), mastery('kp.b', midnight(2026, 11, 21))]
    expect(reviewOnTimeRate(masteryRows, attempts, multi, now)).toBe(1)
  })
})

describe('weeklyFacts（周一起始的本周事实）', () => {
  const questions = [q('q1', ['kp.a']), q('q2', ['kp.b'])]
  // 2026-11-17 为周二：本周 = 11-16（周一）~ 11-22（周日）
  const now = new Date(2026, 10, 17, 20)
  const attempts = [
    a('1', 'q1', false, 'first', at(2026, 11, 15)), // 上周日：不计
    a('2', 'q1', false, 'first', at(2026, 11, 16)), // 周一
    a('3', 'q1', false, 'retry', at(2026, 11, 16, 11)),
    a('4', 'q2', true, 'first', at(2026, 11, 17)), // 周二
    a('5', 'g7a-vocab-u4-0001', false, 'first', at(2026, 11, 17, 11)), // 词题错 1 次（<2，非反复错）
  ]
  const tasks = [
    task('t1', '2026-11-16', 'completed', ['q1']),
    task('t2', '2026-11-16', 'planned', []),
    task('t3', '2026-11-15', 'completed', ['q2']), // 上周任务不计
  ]
  const masteryRows = [
    mastery('kp.a', midnight(2026, 11, 18)), // 未到期
    mastery('kp.b', midnight(2026, 11, 15)), // 已到期未复测 → 1
  ]

  it('聚合各字段', () => {
    const f: WeeklyFacts = weeklyFacts(attempts, tasks, masteryRows, questions, now)
    expect(f.weekStart).toBe('2026-11-16')
    expect(f.studyDays).toBe(2) // 11-16、11-17
    expect(f.answeredCount).toBe(4)
    expect(f.completionRate).toBe(0.5) // t1/t2
    expect(f.firstRate).toBe(1 / 3) // 周内首测 3 次 1 对（q1 错、q2 对、词题错）
    expect(f.delayedRate).toBe(0) // 周内复测 1 次错
    expect(f.repeatWrongKps).toEqual([{ kp: 'kp.a', wrongCount: 2 }]) // 周一两次错
    expect(f.overdueReviews).toBe(1)
  })

  it('attempt 恰在周界：周一零点计入、上周日 23:59 不计', () => {
    const boundary = [
      a('1', 'q1', true, 'first', at(2026, 11, 16, 0)), // 本周一 00:00
      a('2', 'q2', true, 'first', at(2026, 11, 15, 23, 59)), // 上周日 23:59
    ]
    const f = weeklyFacts(boundary, [], [], questions, now)
    expect(f.answeredCount).toBe(1)
    expect(f.studyDays).toBe(1)
  })

  it('空数据不抛错，比率全为 null', () => {
    const f = weeklyFacts([], [], [], [], now)
    expect(f.weekStart).toBe('2026-11-16')
    expect(f.studyDays).toBe(0)
    expect(f.answeredCount).toBe(0)
    expect(f.completionRate).toBeNull()
    expect(f.firstRate).toBeNull()
    expect(f.delayedRate).toBeNull()
    expect(f.repeatWrongKps).toEqual([])
    expect(f.overdueReviews).toBe(0)
  })

  it('周日查看时本周仍为上周一；周一查看时翻到新一周', () => {
    const sunday = new Date(2026, 10, 22, 12)
    expect(weeklyFacts([], [], [], [], sunday).weekStart).toBe('2026-11-16')
    const monday = new Date(2026, 10, 23, 8)
    expect(weeklyFacts([], [], [], [], monday).weekStart).toBe('2026-11-23')
  })
})

describe('knowledgePointCoverage（本周作答知识点 ÷ 计划目标知识点）', () => {
  const questions = [q('q1', ['kp.a']), q('q2', ['kp.b']), q('q3', ['kp.c'])]
  const now = new Date(2026, 10, 17, 20)
  it('目标取本周任务题目覆盖的知识点；只统计命中目标的部分', () => {
    const tasks = [task('t1', '2026-11-17', 'completed', ['q1', 'q2', 'g7a-vocab-u4-0001'])]
    const attempts = [
      a('1', 'q1', true, 'first', at(2026, 11, 17)), // kp.a
      a('2', 'g7a-vocab-u4-0001', true, 'first', at(2026, 11, 17, 11)), // vocab.g7a.u4
      a('3', 'q3', true, 'first', at(2026, 11, 17, 12)), // kp.c：不在目标内
      a('4', 'q2', true, 'first', at(2026, 11, 10)), // 上周作答不计
    ]
    const c = knowledgePointCoverage(attempts, tasks, questions, now)
    expect(c.target).toBe(3)
    expect(c.covered).toBe(2)
    expect(c.rate).toBe(2 / 3)
  })
  it('无目标任务返回 null', () => {
    expect(knowledgePointCoverage([], [], questions, now).rate).toBeNull()
  })
})

describe('renderTrendChart（内联 SVG 七日柱状图）', () => {
  const days: DailyStat[] = [
    { date: '2026-11-11', answered: 0, correct: 0, firstAnswered: 0, firstCorrect: 0, firstRate: null },
    { date: '2026-11-12', answered: 4, correct: 3, firstAnswered: 3, firstCorrect: 2, firstRate: 2 / 3 },
    { date: '2026-11-13', answered: 2, correct: 2, firstAnswered: 2, firstCorrect: 2, firstRate: 1 },
    { date: '2026-11-14', answered: 5, correct: 1, firstAnswered: 4, firstCorrect: 1, firstRate: 0.25 },
    { date: '2026-11-15', answered: 0, correct: 0, firstAnswered: 0, firstCorrect: 0, firstRate: null },
    { date: '2026-11-16', answered: 3, correct: 2, firstAnswered: 3, firstCorrect: 2, firstRate: 2 / 3 },
    { date: '2026-11-17', answered: 1, correct: 1, firstAnswered: 1, firstCorrect: 1, firstRate: 1 },
  ]

  it('返回 viewBox 700x220 的内联 SVG', () => {
    const svg = renderTrendChart(days)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 700 220"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })
  it('无数据日柱高为 0 但保留日期标签与悬停 title', () => {
    const svg = renderTrendChart(days)
    expect(svg).toContain('2026-11-11')
    expect(svg).toContain('<title>2026-11-11 · 0 题 · 首测正确率 暂无</title>')
    expect(svg).toContain('<title>2026-11-12 · 4 题 · 首测正确率 67%</title>')
  })
  it('首测正确率 ≥2 个点时绘制折线与点', () => {
    const svg = renderTrendChart(days)
    expect(svg).toContain('<polyline')
    expect(svg).toContain('<circle')
  })
  it('全部无首测时不绘制折线', () => {
    const svg = renderTrendChart(days.map((d) => ({ ...d, firstRate: null })))
    expect(svg).not.toContain('<polyline')
    expect(svg).not.toContain('<circle')
  })
})
