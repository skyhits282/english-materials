import { describe, expect, it } from 'vitest'
import { deriveVocabQuestions } from './loader'
import type { VocabBook } from '../types'

const vocab: VocabBook = {
  book: 'g7a',
  contentVersion: '2026-11-16',
  units: [
    {
      id: 'v1-u1',
      order: 1,
      label: 'Starter Unit 1',
      words: [
        { id: 'v1-u1-1', no: 1, word: 'unit', variant: '', pos: 'n.', ipa: '/ˈjuːnɪt/', meaning: '单元' },
        { id: 'v1-u1-2', no: 2, word: 'centre', variant: 'center', pos: 'n.', ipa: '', meaning: '中心；中央' },
      ],
    },
  ],
}

describe('deriveVocabQuestions', () => {
  it('中→英默写题：ID 稳定、含 variant 同义答案', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({
      id: 'g7a-vocab-u1-0001',
      type: 'fill_in',
      unit: 'v1-u1',
      answerSpec: { acceptedAnswers: ['unit'] },
    })
    expect(qs[1]).toMatchObject({
      id: 'g7a-vocab-u1-0002',
      answerSpec: { acceptedAnswers: ['centre', 'center'] },
    })
  })

  it('同输入两次派生结果一致（题序与 ID 不变）', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u1')).toEqual(deriveVocabQuestions(vocab, 'v1-u1'))
  })

  it('未知单元返回空数组', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u99')).toEqual([])
  })

  it('每题带知识点 ID 与释义解析', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs[0]!.knowledgePointIds).toEqual(['vocab.g7a.u1'])
    expect(qs[0]!.explanation).toContain('unit')
    expect(qs[0]!.explanation).toContain('单元')
  })
})
