import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/schema'
import { seedContent } from './seed'
import type { ContentBundle, Question } from '../types'

const q = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'g7a-present-l1',
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

const bundle = (): ContentBundle => ({
  questions: [q('q1'), q('q2')],
  vocab: { book: 'g7a', contentVersion: 'v', units: [] },
  meta: { contentId: 'g7a', version: 'v1', questionCount: 2, vocabWordCount: 0, files: [] },
})

beforeEach(async () => {
  await Promise.all([db.questions.clear(), db.contentMeta.clear()])
})

describe('seedContent', () => {
  it('首次播种：写入题目与 contentMeta', async () => {
    const result = await seedContent(bundle())
    expect(result).toEqual({ inserted: 2, skipped: false })
    expect(await db.questions.count()).toBe(2)
    expect((await db.contentMeta.get('g7a'))?.version).toBe('v1')
  })
  it('版本未变时跳过，不重复写入', async () => {
    await seedContent(bundle())
    const result = await seedContent(bundle())
    expect(result).toEqual({ inserted: 0, skipped: true })
    expect(await db.questions.count()).toBe(2)
  })
  it('版本升级时重新播种并更新 contentMeta', async () => {
    await seedContent(bundle())
    const upgraded = bundle()
    upgraded.meta = { ...upgraded.meta, version: 'v2' }
    const result = await seedContent(upgraded)
    expect(result).toEqual({ inserted: 2, skipped: false })
    expect((await db.contentMeta.get('g7a'))?.version).toBe('v2')
    expect(await db.questions.count()).toBe(2)
  })
})
