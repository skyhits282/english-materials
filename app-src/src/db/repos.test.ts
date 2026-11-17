import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  saveAttempt,
  hasPriorAttempt,
  attemptsForQuestion,
  listAttempts,
  upsertQuestions,
  questionsByUnitPrefix,
  putContentMeta,
  getContentMeta,
  applyMasteryUpdate,
} from './repos'
import type { Attempt, Question, Settings } from '../types'

const q = (id: string, unit: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit,
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

const attempt = (id: string, questionId: string, isCorrect: boolean): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase: 'first',
  submittedAt: '2026-11-16T10:00:00.000Z',
})

beforeEach(async () => {
  await Promise.all([
    db.settings.clear(),
    db.questions.clear(),
    db.attempts.clear(),
    db.contentMeta.clear(),
    db.aiRequests.clear(),
    db.mastery.clear(),
  ])
})

describe('settings', () => {
  it('无记录时返回默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })
  it('保存后可读回且 updatedAt 存在', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, dailyMinutes: 25 })
    const s = await getSettings()
    expect(s.dailyMinutes).toBe(25)
    const row = await db.settings.get('app')
    expect(row?.updatedAt).toBeTruthy()
  })
  it('旧版本行缺失字段时合并默认值', async () => {
    await db.settings.put({ key: 'app', value: { grade: 7 } as unknown as Settings, updatedAt: '2026-01-01T00:00:00.000Z' })
    const s = await getSettings()
    expect(s.dailyMinutes).toBe(DEFAULT_SETTINGS.dailyMinutes)
  })
})

describe('attempts（只追加）', () => {
  it('同一 ID 重复保存不覆盖（add 语义）', async () => {
    await saveAttempt(attempt('a1', 'q1', false))
    await expect(saveAttempt(attempt('a1', 'q1', true))).rejects.toThrow()
    const rows = await attemptsForQuestion('q1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.isCorrect).toBe(false)
  })
  it('hasPriorAttempt 反映历史存在性', async () => {
    expect(await hasPriorAttempt('q1')).toBe(false)
    await saveAttempt(attempt('a1', 'q1', false))
    expect(await hasPriorAttempt('q1')).toBe(true)
  })
  it('listAttempts 按 submittedAt 升序', async () => {
    await saveAttempt({ ...attempt('a2', 'q9', true), submittedAt: '2026-11-16T12:00:00.000Z' })
    await saveAttempt({ ...attempt('a1', 'q9', false), submittedAt: '2026-11-16T11:00:00.000Z' })
    const rows = await listAttempts()
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2'])
  })
})

describe('questions', () => {
  it('按 unit 前缀查询专项全部题', async () => {
    await upsertQuestions([q('g7a-present-l1-0001', 'g7a-present-l1'), q('g7a-present-l6-0048', 'g7a-present-l6'), q('g7a-nouns-l1-0001', 'g7a-nouns-l1')])
    expect(await questionsByUnitPrefix('g7a-present')).toHaveLength(2)
  })
})

describe('contentMeta', () => {
  it('写入后可按 contentId 读回', async () => {
    await putContentMeta({
      contentId: 'g7a',
      version: '2026-11-16',
      questionCount: 192,
      vocabWordCount: 184,
      books: [],
      files: [],
    })
    expect((await getContentMeta('g7a'))?.version).toBe('2026-11-16')
  })
})

describe('aiRequests', () => {
  it('aiRequests 同 createdAt 不同 id 不冲突', async () => {
    const row = (id: string) => ({ id, type: 'explain', status: 'done', createdAt: '2026-11-16T10:00:00.000Z' })
    await db.aiRequests.add(row('r1'))
    await db.aiRequests.add(row('r2'))
    expect(await db.aiRequests.count()).toBe(2)
  })
})

describe('applyMasteryUpdate（mastery 提交挂钩）', () => {
  /** 本地固定时刻，保证本地日断言与运行时区无关 */
  const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)

  const sub = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry', when: Date): Attempt => ({
    id,
    questionId,
    answer: 'x',
    isCorrect,
    phase,
    submittedAt: when.toISOString(),
  })

  it('首错：保存 attempt 并创建 weak/1 天 mastery 行（同事务）', async () => {
    const now = at(2026, 11, 17)
    const q1 = { ...q('g7a-vocab-u1-0001', 'v1-u1'), knowledgePointIds: ['vocab.g7a.u1'] }
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', now), q1, now)
    expect(await db.attempts.count()).toBe(1)
    const row = await db.mastery.get('vocab.g7a.u1')
    expect(row?.stage).toBe('weak')
    expect(row?.intervalDays).toBe(1)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 18).toISOString())
    expect(row?.metrics).toEqual({ testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 })
  })

  it('同日再错不推进（stage/interval/nextReviewAt 不变，仅 testedCount 累加）', async () => {
    const day1 = at(2026, 11, 17, 9)
    const q1 = { ...q('q1', 'v1-u1'), knowledgePointIds: ['k'] }
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', day1), q1, day1)
    const day1Later = at(2026, 11, 17, 15)
    await applyMasteryUpdate(sub('a2', q1.id, false, 'retry', day1Later), q1, day1Later)
    const row = await db.mastery.get('k')
    expect(row?.stage).toBe('weak')
    expect(row?.intervalDays).toBe(1)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 18).toISOString())
    expect(row?.metrics.testedCount).toBe(2)
  })

  it('隔日复测正确：推进 consolidating/3 天，并按历史 attempt 判定隔日', async () => {
    const q1 = { ...q('q1', 'v1-u1'), knowledgePointIds: ['k'] }
    const day1 = at(2026, 11, 16)
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', day1), q1, day1)
    const day2 = at(2026, 11, 17)
    await applyMasteryUpdate(sub('a2', q1.id, true, 'retry', day2), q1, day2)
    const row = await db.mastery.get('k')
    expect(row?.stage).toBe('consolidating')
    expect(row?.intervalDays).toBe(3)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 20).toISOString())
    expect(row?.metrics).toEqual({ testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 1 })
  })

  it('多知识点逐个更新（词题与选择题共用 question.knowledgePointIds）', async () => {
    const q1 = { ...q('q1', 'g7a-present-l1'), knowledgePointIds: ['grammar.present.basic', 'grammar.present.usage'] }
    const now = at(2026, 11, 17)
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', now), q1, now)
    expect(await db.mastery.count()).toBe(2)
    expect((await db.mastery.get('grammar.present.basic'))?.stage).toBe('weak')
    expect((await db.mastery.get('grammar.present.usage'))?.stage).toBe('weak')
  })
})
