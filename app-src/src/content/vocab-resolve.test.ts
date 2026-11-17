import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildVocabResolver } from './vocab-resolve'
import { deriveVocabQuestions, vocabQuestionId } from './loader'
import type { VocabBook } from '../types'

// 与实际 vocab.json 结构一致：题 ID 形如 g7a-vocab-u1-0001（book 前缀消歧册别，v1-/v2- 前缀被剥掉）
const vocab: VocabBook[] = [
  {
    book: 'g7a',
    contentVersion: 't',
    units: [
      {
        id: 'v1-u1',
        order: 1,
        label: 'Starter Unit 1',
        words: [
          { id: 'v1-u1-1', no: 1, word: 'guitar', variant: '', pos: 'n.', ipa: '', meaning: '吉他' },
          { id: 'v1-u1-2', no: 2, word: 'centre', variant: 'center', pos: 'n.', ipa: '', meaning: '中心；中央' },
        ],
      },
    ],
  },
  {
    book: 'g7b',
    contentVersion: 't',
    units: [
      {
        id: 'v2-u1',
        order: 1,
        label: 'Unit 1',
        words: [{ id: 'v2-u1-1', no: 1, word: 'fox', variant: '', pos: 'n.', ipa: '', meaning: '狐狸' }],
      },
    ],
  },
]

describe('buildVocabResolver', () => {
  it('解析七上词汇默写题 ID 为中文释义题干与英文答案', () => {
    const r = buildVocabResolver(vocab)
    const hit = r.resolve('g7a-vocab-u1-0001')
    expect(hit?.stem).toContain('吉他')
    expect(hit?.stem).toContain('默写')
    expect(hit?.stem).toContain('（n.）')
    expect(hit?.answer).toBe('guitar')
    expect(hit?.variant).toBe('')
  })

  it('解析结果携带册别与单元 id（供 mastery 知识点 ID 等下游派生）', () => {
    const r = buildVocabResolver(vocab)
    const a = r.resolve('g7a-vocab-u1-0001')
    expect(a?.book).toBe('g7a')
    expect(a?.unitId).toBe('v1-u1')
    const b = r.resolve('g7b-vocab-u1-0001')
    expect(b?.book).toBe('g7b')
    expect(b?.unitId).toBe('v2-u1')
  })

  it('解析七下题 ID（g7b 前缀对应 v2- 单元）并保留同义变体拼写', () => {
    const r = buildVocabResolver(vocab)
    expect(r.resolve('g7b-vocab-u1-0001')?.answer).toBe('fox')
    const v = r.resolve('g7a-vocab-u1-0002')
    expect(v?.answer).toBe('centre')
    expect(v?.variant).toBe('center')
  })

  it('与 deriveVocabQuestions 派生的题目 ID 严格一致（防两处拼接漂移）', () => {
    const r = buildVocabResolver(vocab)
    for (const book of vocab) {
      for (const unit of book.units) {
        for (const q of deriveVocabQuestions(vocab, unit.id)) {
          const hit = r.resolve(q.id)
          expect(hit, q.id).toBeDefined()
          expect(hit?.answer).toBe(q.answerSpec.acceptedAnswers?.[0])
          expect(hit?.stem).toContain(q.stem)
        }
      }
    }
  })

  it('非词汇题 ID、未知/越界序号与空串返回 undefined', () => {
    const r = buildVocabResolver(vocab)
    expect(r.resolve('g7a-present-l1-0001')).toBeUndefined()
    expect(r.resolve('g7a-vocab-u9-9999')).toBeUndefined()
    expect(r.resolve('g7a-vocab-u1-0003')).toBeUndefined()
    expect(r.resolve('')).toBeUndefined()
  })

  it('空词汇数组（bundle 加载失败/为空）全部返回 undefined', () => {
    const r = buildVocabResolver([])
    expect(r.resolve('g7a-vocab-u1-0001')).toBeUndefined()
    expect(r.resolve('g7b-vocab-u1-0001')).toBeUndefined()
  })
})

// 真实数据全量 round-trip：防止派生/解析/数据三方漂移（Task 2 审查遗留项）
describe('buildVocabResolver × 真实 vocab.json', () => {
  const vocab = JSON.parse(
    readFileSync(new URL('../../public/content/g7a/vocab.json', import.meta.url), 'utf-8'),
  ) as VocabBook[]

  it('两册 470 词全部可解析：map 大小 470、题目 ID 无重复、题干与答案非空', () => {
    const r = buildVocabResolver(vocab)
    const ids: string[] = []
    for (const book of vocab) {
      for (const unit of book.units) {
        for (const w of unit.words) {
          ids.push(vocabQuestionId(book.book, unit.id, w.no))
          const hit = r.resolve(ids[ids.length - 1]!)
          expect(hit, `${book.book}/${unit.id}/no${w.no}`).toBeDefined()
          expect(hit!.stem.length, `${book.book}/${unit.id}/no${w.no} 题干为空`).toBeGreaterThan(0)
          expect(hit!.answer.length, `${book.book}/${unit.id}/no${w.no} 答案为空`).toBeGreaterThan(0)
        }
      }
    }
    // 派生题目 ID 无重复（重复会在 resolver map 中折叠覆盖）
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(470)
    // map 大小即解析条目数（与派生 ID 一一对应）
    expect(r.size).toBe(470)
  })
})
