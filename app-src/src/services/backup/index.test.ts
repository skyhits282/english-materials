import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/schema'
import { exportBackup, parseAndValidateBackup, importBackup } from './index'
import { saveAttempt, saveSettings, upsertQuestions, DEFAULT_SETTINGS } from '../../db/repos'
import { computeCoreMetrics } from '../../domain/metrics'
import type { Attempt, Question } from '../../types'

const q = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: 'stem',
  options: ['a', 'b', 'c', 'd'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

const attempt = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry'): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase,
  submittedAt: '2026-11-16T10:00:00.000Z',
})

beforeEach(async () => {
  await Promise.all([
    db.settings.clear(),
    db.questions.clear(),
    db.attempts.clear(),
    db.mastery.clear(),
    db.weeklyReports.clear(),
    db.contentMeta.clear(),
  ])
})

describe('parseAndValidateBackup', () => {
  it('非 JSON 拒绝', () => {
    expect(() => parseAndValidateBackup('not json')).toThrow()
  })
  it('schemaVersion 不符拒绝', () => {
    const file = JSON.stringify({ schemaVersion: 99, data: {} })
    expect(() => parseAndValidateBackup(file)).toThrow(/版本/)
  })
  it('counts 与数据不一致拒绝', () => {
    const file = JSON.stringify({ schemaVersion: 1, app: 'english-coach', exportedAt: 'x', counts: { attempts: 5 }, data: { attempts: [] } })
    expect(() => parseAndValidateBackup(file)).toThrow()
  })
})

describe('导出→清空→导入（T08）', () => {
  it('记录数与指标一致', async () => {
    await upsertQuestions([q('q1'), q('q2')])
    await saveSettings({ ...DEFAULT_SETTINGS, dailyMinutes: 25 })
    await saveAttempt(attempt('a1', 'q1', true, 'first'))
    await saveAttempt(attempt('a2', 'q2', false, 'first'))

    const backup = await exportBackup()
    expect(backup.counts.attempts).toBe(2)

    // 清空（模拟新设备）
    await Promise.all([db.attempts.clear(), db.questions.clear(), db.settings.clear()])

    const text = JSON.stringify(backup)
    const parsed = parseAndValidateBackup(text)
    const result = await importBackup(parsed, 'overwrite')
    expect(result.attemptsAdded).toBe(2)

    const attempts = await db.attempts.toArray()
    expect(computeCoreMetrics(attempts)).toEqual(computeCoreMetrics([attempt('a1', 'q1', true, 'first'), attempt('a2', 'q2', false, 'first')]))
    expect(await db.questions.count()).toBe(2)
    expect((await db.settings.get('app'))?.value.dailyMinutes).toBe(25)
  })

  it('合并模式不覆盖已有 attempt 历史', async () => {
    await saveAttempt(attempt('a1', 'q1', false, 'first'))
    const backup = await exportBackup()
    await saveAttempt(attempt('a2', 'q2', true, 'first'))

    const result = await importBackup(backup, 'merge')
    expect(result.attemptsAdded).toBe(0)
    expect(result.attemptsSkipped).toBe(1)
    // 本地 a2 仍在
    expect(await db.attempts.count()).toBe(2)
  })
})
