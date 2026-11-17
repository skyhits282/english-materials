import { describe, expect, it } from 'vitest'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from './metrics'
import type { Attempt } from '../types'

const a = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry', submittedAt: string): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase,
  submittedAt,
})

describe('computeCoreMetrics（口径见规格 7.5）', () => {
  it('首测正确率只算 phase=first，不含重答', () => {
    const attempts = [
      a('1', 'q1', true, 'first', '2026-11-16T02:00:00.000Z'),
      a('2', 'q2', false, 'first', '2026-11-16T02:01:00.000Z'),
      a('3', 'q2', true, 'retry', '2026-11-16T02:02:00.000Z'),
    ]
    const m = computeCoreMetrics(attempts)
    expect(m.totalAttempts).toBe(3)
    expect(m.firstAttempts).toBe(2)
    expect(m.firstCorrect).toBe(1)
    expect(m.firstTryCorrectRate).toBe(0.5)
    expect(m.retryAttempts).toBe(1)
    expect(m.retryCorrect).toBe(1)
    expect(m.wrongQuestions).toBe(1)
  })
  it('无首测时正确率为 null（不是 0）', () => {
    const m = computeCoreMetrics([a('1', 'q1', true, 'retry', '2026-11-16T02:00:00.000Z')])
    expect(m.firstTryCorrectRate).toBeNull()
  })
  it('空数据', () => {
    const m = computeCoreMetrics([])
    expect(m.totalAttempts).toBe(0)
    expect(m.firstTryCorrectRate).toBeNull()
  })
})

describe('本地日历日', () => {
  it('localDayKey 生成 YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 10, 16, 23, 30))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('isSameLocalDay 按本地时区比较', () => {
    // 本地 2026-11-16 07:00 == UTC 2026-11-15 23:00（东八区）
    const localKey = localDayKey(new Date(2026, 10, 16, 7, 0))
    expect(isSameLocalDay('2026-11-15T23:00:00.000Z', localKey)).toBe(true)
    expect(isSameLocalDay('2026-11-16T23:00:00.000Z', localKey)).toBe(false)
  })
})
