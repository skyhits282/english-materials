import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/schema'
import { exportBackup, parseAndValidateBackup, importBackup, BackupError, type BackupFile } from './index'
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
  it('表内重复主键拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 2, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [q('x1'), q('x1')], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(/重复主键/)
  })
  it('注入载荷原样保留在错误消息中（由 UI 转义）', () => {
    const file = JSON.stringify({ schemaVersion: '<img src=x onerror=alert(1)>', data: {} })
    let caught: unknown
    try {
      parseAndValidateBackup(file)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BackupError)
    expect((caught as Error).message).toContain('<img src=x onerror=alert(1)>')
  })
  it('畸形 settings 行拒绝（缺 key）', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 1, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [{ id: 's', dailyMinutes: 40 }], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/settings/)
  })
  it('畸形 settings 行拒绝（value 非对象）', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 1, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [{ key: 'app', value: 40, updatedAt: 'x' }], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/settings/)
  })
  it('畸形 questions 行拒绝（缺 id）', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 1, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [{ stem: 's' }], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('畸形 mastery 行拒绝（stage 非法）', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 1, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [{ knowledgePointId: 'k', stage: 'broken' }], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('含 XSS 载荷 questionId 的合法 attempt 行可导入（转义在展示层）', async () => {
    const payload = '<img src=x onerror=alert(1)>'
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 1, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [{ ...attempt('a1', payload, false, 'first') }],
        mastery: [],
        weeklyReports: [],
      },
    })
    const parsed = parseAndValidateBackup(file)
    expect(parsed.counts.attempts).toBe(1)
    const result = await importBackup(parsed, 'merge')
    expect(result.attemptsAdded).toBe(1)
    const stored = await db.attempts.get('a1')
    expect(stored?.questionId).toBe(payload)
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

describe('覆盖导入事务性', () => {
  it('中途失败回滚，不清空本地数据', async () => {
    await upsertQuestions([q('local-q')])
    await saveAttempt(attempt('local-a1', 'local-q', true, 'first'))

    const file: BackupFile = {
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 2, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('x1'), q('x1')],
        attempts: [],
        mastery: [],
        weeklyReports: [],
      },
    }

    await expect(importBackup(file, 'overwrite')).rejects.toThrow()
    expect(await db.attempts.count()).toBe(1)
    expect(await db.attempts.get('local-a1')).toBeDefined()
    expect(await db.questions.get('local-q')).toBeDefined()
  })
})

describe('合并导入事务性', () => {
  it('中途失败回滚，不写入部分数据', async () => {
    await upsertQuestions([q('local-q')])

    // 同一备份内两条 attempt 主键相同：合并路径 bulkAdd 第二条时约束冲突，此前写入的题目应一并回滚
    const file: BackupFile = {
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 1, attempts: 2, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('new-q')],
        attempts: [attempt('dup-a', 'new-q', true, 'first'), attempt('dup-a', 'new-q', true, 'first')],
        mastery: [],
        weeklyReports: [],
      },
    }

    await expect(importBackup(file, 'merge')).rejects.toThrow()
    expect(await db.questions.get('new-q')).toBeUndefined()
    expect(await db.attempts.count()).toBe(0)
    expect(await db.questions.get('local-q')).toBeDefined()
  })
})
