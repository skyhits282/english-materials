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
  upsertQuestions,
  questionsByUnitPrefix,
  putContentMeta,
  getContentMeta,
} from './repos'
import type { Attempt, Question } from '../types'

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
      files: [],
    })
    expect((await getContentMeta('g7a'))?.version).toBe('2026-11-16')
  })
})
