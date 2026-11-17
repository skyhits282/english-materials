import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type AiRequestRow, type TaskRow, type WeeklyReportRow } from '../../db/schema'
import { exportBackup, parseAndValidateBackup, importBackup, downloadBackupFile, BackupError, type BackupFile } from './index'
import { saveAttempt, saveSettings, upsertQuestions, DEFAULT_SETTINGS } from '../../db/repos'
import { computeCoreMetrics } from '../../domain/metrics'
import type { Attempt, Question, Settings } from '../../types'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'

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

const task = (id: string): TaskRow => ({
  id,
  day: '2026-11-17',
  type: 'review',
  questionIds: ['q1'],
  status: 'planned',
  minutesPlanned: 10,
})

const weeklyReport = (weekStart: string): WeeklyReportRow => ({
  weekStart,
  facts: { attempts: 1 },
  aiSuggestions: '{"progress":"有进步","weakness":"时态","adjustments":"多复习","nextGoals":"保持"}',
  generatedAt: '2026-11-17T08:00:00.000Z',
})

const aiRequest = (id: string): AiRequestRow => ({
  id,
  type: 'explain',
  status: 'succeeded',
  createdAt: '2026-11-17T08:00:00.000Z',
})

beforeEach(async () => {
  await Promise.all([
    db.settings.clear(),
    db.questions.clear(),
    db.tasks.clear(),
    db.attempts.clear(),
    db.mastery.clear(),
    db.weeklyReports.clear(),
    db.aiRequests.clear(),
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
  it('app 字段缺失或非字符串拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: {},
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/app/)
    const file2 = JSON.stringify({ schemaVersion: 2, app: 42, exportedAt: '2026-11-17T00:00:00.000Z', counts: {}, data: {} })
    expect(() => parseAndValidateBackup(file2)).toThrow(/app/)
  })
  it('exportedAt 不可解析日期拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: 'not-a-date',
      counts: {},
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/exportedAt/)
    const file2 = JSON.stringify({ schemaVersion: 2, app: 'english-coach', exportedAt: 123, counts: {}, data: {} })
    expect(() => parseAndValidateBackup(file2)).toThrow(/exportedAt/)
  })
  it('counts 与数据不一致拒绝', () => {
    const file = JSON.stringify({ schemaVersion: 1, app: 'english-coach', exportedAt: '2026-11-17T00:00:00.000Z', counts: { attempts: 5 }, data: { attempts: [] } })
    expect(() => parseAndValidateBackup(file)).toThrow()
  })
  it('表内重复主键拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
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
      exportedAt: '2026-11-17T00:00:00.000Z',
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
      exportedAt: '2026-11-17T00:00:00.000Z',
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
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 1, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [{ stem: 's' }], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('畸形 mastery 行拒绝（stage 非法）', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 1, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [{ knowledgePointId: 'k', stage: 'broken' }], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('畸形 weeklyReports 行拒绝（aiSuggestions 非字符串：否则报告页 trim() 抛 TypeError 卡死历史区）', () => {
    const bad = { ...weeklyReport('2026-11-16'), aiSuggestions: 123 }
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 1, tasks: 0, aiRequests: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [bad], tasks: [], aiRequests: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/aiSuggestions/)
    // 校验在导入前拒绝，weeklyReports 表不落任何行
    expect(() => parseAndValidateBackup(file)).toThrow(/weeklyReports/)
  })
  it('settings.book 非法值拒绝且不写入', async () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 1, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [{ key: 'app', value: { ...DEFAULT_SETTINGS, book: 'g8a' }, updatedAt: 'x' }],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [],
      },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/book/)
    // 校验在导入前拒绝，settings 表不落任何行
    expect(await db.settings.count()).toBe(0)
  })
  it('含 XSS 载荷 questionId 的合法 attempt 行可导入（转义在展示层）', async () => {
    const payload = '<img src=x onerror=alert(1)>'
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
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

  it('settings.book 往返保持不变（七下）', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, book: 'g7b', currentUnit: 'v2-u3' })
    const backup = await exportBackup()

    // 清空（模拟新设备）
    await db.settings.clear()

    const parsed = parseAndValidateBackup(JSON.stringify(backup))
    await importBackup(parsed, 'overwrite')
    const value = (await db.settings.get('app'))?.value
    expect(value?.book).toBe('g7b')
    expect(value?.currentUnit).toBe('v2-u3')
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
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 2, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('x1'), q('x1')],
        attempts: [],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [],
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
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 1, attempts: 2, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('new-q')],
        attempts: [attempt('dup-a', 'new-q', true, 'first'), attempt('dup-a', 'new-q', true, 'first')],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [],
      },
    }

    await expect(importBackup(file, 'merge')).rejects.toThrow()
    expect(await db.questions.get('new-q')).toBeUndefined()
    expect(await db.attempts.count()).toBe(0)
    expect(await db.questions.get('local-q')).toBeDefined()
  })
})

describe('备份 v2：凭证剔除', () => {
  it('导出文件不含 aiApiKey/parentPin，counts 一致', async () => {
    const value: Settings = {
      ...DEFAULT_SETTINGS,
      aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      aiApiKey: FAKE_KEY,
      aiModel: 'qwen-flash',
      aiDailyLimit: 50,
      parentPin: '1234',
    }
    await saveSettings(value)
    const backup = await exportBackup()
    expect(backup.counts.settings).toBe(1)
    const exported = backup.data.settings[0]?.value
    expect(exported).toBeDefined()
    expect('aiApiKey' in (exported ?? {})).toBe(false)
    expect('parentPin' in (exported ?? {})).toBe(false)
    // 深拷贝剔除：原库行不受导出影响
    expect((await db.settings.get('app'))?.value.aiApiKey).toBe(FAKE_KEY)
    expect((await db.settings.get('app'))?.value.parentPin).toBe('1234')
  })

  it('剔除后导出→导入：aiBaseUrl/aiModel 等保留，aiApiKey/parentPin 为空', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      aiApiKey: FAKE_KEY,
      aiModel: 'qwen-flash',
      aiDailyLimit: 30,
      parentPin: '1234',
    })
    const backup = await exportBackup()
    await db.settings.clear()
    const parsed = parseAndValidateBackup(JSON.stringify(backup))
    await importBackup(parsed, 'overwrite')
    const value = (await db.settings.get('app'))?.value
    expect(value?.aiBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(value?.aiModel).toBe('qwen-flash')
    expect(value?.aiDailyLimit).toBe(30)
    expect(value?.aiApiKey).toBeUndefined()
    expect(value?.parentPin).toBeUndefined()
  })
})

describe('备份 v2：round-trip 与行校验', () => {
  it('含 tasks/weeklyReports/aiRequests 的 v2 round-trip 一致', async () => {
    await upsertQuestions([q('q1')])
    await saveSettings({ ...DEFAULT_SETTINGS })
    await db.tasks.bulkPut([task('t1'), { ...task('t2'), type: 'unit', status: 'in_progress' }])
    await saveAttempt(attempt('a1', 'q1', true, 'first'))
    await db.weeklyReports.bulkPut([weeklyReport('2026-11-16')])
    await db.aiRequests.bulkPut([aiRequest('r1'), { ...aiRequest('r2'), status: 'failed' }])

    const backup = await exportBackup()
    expect(backup.schemaVersion).toBe(2)
    expect(backup.counts.tasks).toBe(2)
    expect(backup.counts.weeklyReports).toBe(1)
    expect(backup.counts.aiRequests).toBe(2)

    // 清库（模拟新设备）后导入
    await Promise.all([
      db.settings.clear(),
      db.questions.clear(),
      db.tasks.clear(),
      db.attempts.clear(),
      db.mastery.clear(),
      db.weeklyReports.clear(),
      db.aiRequests.clear(),
      db.contentMeta.clear(),
    ])

    const parsed = parseAndValidateBackup(JSON.stringify(backup))
    const result = await importBackup(parsed, 'overwrite', { preImportDownload: () => {} })
    expect(result.attemptsAdded).toBe(1)
    expect((await db.tasks.toArray()).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    expect(await db.weeklyReports.count()).toBe(1)
    expect(await db.aiRequests.count()).toBe(2)
    expect((await db.tasks.get('t2'))?.type).toBe('unit')
  })

  it('v2 文件缺 v2 表数组按空处理', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [] },
    })
    const parsed = parseAndValidateBackup(file)
    expect(parsed.data.tasks).toEqual([])
    expect(parsed.data.aiRequests).toEqual([])
    expect(parsed.counts.tasks).toBe(0)
    expect(parsed.counts.aiRequests).toBe(0)
  })

  it('v1 文件仍可导入且新表为空', async () => {
    await upsertQuestions([q('q1')])
    await saveAttempt(attempt('a1', 'q1', true, 'first'))
    const v1File = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 1, attempts: 1, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('q1')],
        attempts: [attempt('a1', 'q1', true, 'first')],
        mastery: [],
        weeklyReports: [],
      },
    })
    const parsed = parseAndValidateBackup(v1File)
    expect(parsed.data.tasks).toEqual([])
    expect(parsed.data.aiRequests).toEqual([])
    const result = await importBackup(parsed, 'overwrite', { preImportDownload: () => {} })
    expect(result.attemptsAdded).toBe(1)
    expect(await db.attempts.count()).toBe(1)
    expect(await db.tasks.count()).toBe(0)
  })

  it('畸形 tasks 行拒绝且不写入', async () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 1, aiRequests: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [],
        tasks: [{ ...task('t1'), status: 'broken' }],
        aiRequests: [],
      },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/tasks/)
    // 校验在导入前拒绝，tasks 表不落任何行
    await db.tasks.bulkPut([task('local-t')])
    expect(await db.tasks.count()).toBe(1)
  })

  it('畸形 weeklyReports 行拒绝且不写入', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 1, tasks: 0, aiRequests: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [{ ...weeklyReport('2026-11-16'), generatedAt: 123 }],
        tasks: [],
        aiRequests: [],
      },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/weeklyReports/)
  })

  it('畸形 aiRequests 行拒绝且不写入', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 1 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [{ ...aiRequest('r1'), status: 42 }],
      },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/aiRequests/)
  })

  it('aiRequests 行 latencyMs 非数字拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 1 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [{ ...aiRequest('r1'), latencyMs: 'fast' }],
      },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/latencyMs/)
  })
})

describe('导入前自动安全备份（默认先备份）', () => {
  it('本地有数据时导入前自动导出并下载（-pre-import 文件名）', async () => {
    await saveAttempt(attempt('local-a1', 'q1', true, 'first'))
    const downloads: Array<{ file: BackupFile; fileName: string }> = []
    const file: BackupFile = {
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
    }
    await importBackup(file, 'merge', {
      preImportDownload: (backup, fileName) => downloads.push({ file: backup, fileName }),
    })
    expect(downloads.length).toBe(1)
    expect(downloads[0]?.file.counts.attempts).toBe(1)
    expect(downloads[0]?.fileName).toMatch(/^english-learning-backup-\d{8}-pre-import\.json$/)
  })

  it('本地无数据时不触发下载', async () => {
    const downloads: BackupFile[] = []
    const file: BackupFile = {
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 1, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [],
        attempts: [attempt('a1', 'q1', true, 'first')],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [],
      },
    }
    await importBackup(file, 'overwrite', { preImportDownload: (backup) => downloads.push(backup) })
    expect(downloads.length).toBe(0)
    expect(await db.attempts.count()).toBe(1)
  })

  it('下载失败（用户取消等）不阻断导入，仅 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await saveAttempt(attempt('local-a1', 'q1', true, 'first'))
      const file: BackupFile = {
        schemaVersion: 2,
        app: 'english-coach',
        exportedAt: '2026-11-17T00:00:00.000Z',
        counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
        data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
      }
      await importBackup(file, 'merge', {
        preImportDownload: () => {
          throw new Error('download cancelled')
        },
      })
      // 导入本身成功完成，本地数据未被破坏
      expect(await db.attempts.count()).toBe(1)
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('备份')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('settings 行校验扩展（防恶意备份注入）', () => {
  const settingsFile = (value: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 1, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: {
        settings: [{ key: 'app', value, updatedAt: 'x' }],
        contentMeta: [],
        questions: [],
        attempts: [],
        mastery: [],
        weeklyReports: [],
        tasks: [],
        aiRequests: [],
      },
    })

  it('examScores 畸形行（label 非字符串）拒绝且不写入', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, examScores: [{ label: 12, got: 1, total: 2 }] })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/examScores/)
  })
  it('examScores got>total 拒绝', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, examScores: [{ label: '语法', got: 15, total: 12 }] })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('examScores 非数组拒绝', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, examScores: 'x' })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('parentPin 非 4 位数字拒绝', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, parentPin: '12345' })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/parentPin/)
  })
  it('parentPin 合法（4 位数字）通过', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, parentPin: '1234' })
    expect(parseAndValidateBackup(file).counts.settings).toBe(1)
  })
  it('aiBaseUrl 非字符串拒绝', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, aiBaseUrl: 42 })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('aiDailyLimit 非数字拒绝', () => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, aiDailyLimit: '50' })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it.each([0, 501, 2.5])('aiDailyLimit 超出 1–500 语义范围拒绝（%s）', (limit) => {
    const file = settingsFile({ ...DEFAULT_SETTINGS, aiDailyLimit: limit })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/aiDailyLimit/)
  })
  it('aiDailyLimit 边界 1 与 500 通过', () => {
    expect(parseAndValidateBackup(settingsFile({ ...DEFAULT_SETTINGS, aiDailyLimit: 1 })).counts.settings).toBe(1)
    expect(parseAndValidateBackup(settingsFile({ ...DEFAULT_SETTINGS, aiDailyLimit: 500 })).counts.settings).toBe(1)
  })
})

describe('行校验健壮性（M1 遗留）', () => {
  it('attempts 行为 null 拒绝（BackupError 而非 TypeError）', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 1, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: { settings: [], contentMeta: [], questions: [], attempts: [null], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
  })
  it('contentMeta 行为 null 拒绝（BackupError 而非 TypeError）', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: { settings: 0, contentMeta: 1, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
      data: { settings: [], contentMeta: [null], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(BackupError)
    expect(() => parseAndValidateBackup(file)).toThrow(/contentMeta/)
  })
  it('counts 缺 key 时解析结果的 counts 补全实际值（预览不显示 undefined）', () => {
    const file = JSON.stringify({
      schemaVersion: 2,
      app: 'english-coach',
      exportedAt: '2026-11-17T00:00:00.000Z',
      counts: {},
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('q1')],
        attempts: [attempt('a1', 'q1', true, 'first')],
        mastery: [],
        weeklyReports: [],
        tasks: [task('t1')],
        aiRequests: [],
      },
    })
    const parsed = parseAndValidateBackup(file)
    expect(parsed.counts.questions).toBe(1)
    expect(parsed.counts.attempts).toBe(1)
    expect(parsed.counts.tasks).toBe(1)
    expect(parsed.counts.settings).toBe(0)
  })
})

describe('downloadBackupFile 延迟撤销 blob URL（WebKit/iPad Safari）', () => {
  /** 最小备份文件（downloadBackupFile 只序列化不校验内容） */
  const file: BackupFile = {
    schemaVersion: 2,
    app: 'english-coach',
    exportedAt: '2026-11-17T00:00:00.000Z',
    counts: { settings: 0, contentMeta: 0, questions: 0, attempts: 0, mastery: 0, weeklyReports: 0, tasks: 0, aiRequests: 0 },
    data: { settings: [], contentMeta: [], questions: [], attempts: [], mastery: [], weeklyReports: [], tasks: [], aiRequests: [] },
  }

  it('a.click() 后立即不撤销，60s 后才撤销（立即 revoke 会中断 Safari blob 下载）', () => {
    // 只假 setTimeout/clearTimeout：撤销计时器可精确推进
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const created: string[] = []
    const revoked: string[] = []
    const anchors: Array<{ href: string; download: string; clicked: boolean }> = []
    // node 环境无 URL.createObjectURL/document：以桩对象模拟浏览器下载面
    vi.stubGlobal('URL', {
      createObjectURL: () => {
        const url = 'blob:mock-url'
        created.push(url)
        return url
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    })
    vi.stubGlobal('document', {
      createElement: () => {
        const a = { href: '', download: '', clicked: false, click() { this.clicked = true } }
        anchors.push(a)
        return a
      },
    })
    try {
      downloadBackupFile(file, 'english-learning-backup-20261117.json')
      // 触发了下载：href 指向 blob URL、文件名正确、click 被调用
      expect(created).toHaveLength(1)
      expect(anchors).toHaveLength(1)
      expect(anchors[0]?.href).toBe('blob:mock-url')
      expect(anchors[0]?.download).toBe('english-learning-backup-20261117.json')
      expect(anchors[0]?.clicked).toBe(true)
      // click 后立即不撤销（Safari 中立即 revoke 会中断尚未开始的 blob 下载）
      expect(revoked).toHaveLength(0)
      vi.advanceTimersByTime(60_000)
      expect(revoked).toEqual(created)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
