import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveVocabQuestions, findVocabUnit, vocabUnitsForBook } from './loader'
import type { VocabBook } from '../types'

const word = (over: Partial<VocabBook['units'][number]['words'][number]>) => ({
  id: '',
  no: 1,
  word: 'word',
  variant: '',
  pos: 'n.',
  ipa: '',
  meaning: '词',
  ...over,
})

const vocab: VocabBook[] = [
  {
    book: 'g7a',
    contentVersion: '2026-11-16',
    units: [
      {
        id: 'v1-u1',
        order: 1,
        label: 'Starter Unit 1',
        words: [
          word({ id: 'v1-u1-1', no: 1, word: 'unit', pos: 'n.', ipa: '/ˈjuːnɪt/', meaning: '单元' }),
          word({ id: 'v1-u1-2', no: 2, word: 'centre', variant: 'center', meaning: '中心；中央' }),
        ],
      },
    ],
  },
  {
    book: 'g7b',
    contentVersion: '2026-11-16',
    units: [
      {
        id: 'v2-u1',
        order: 1,
        label: 'Unit 1',
        words: [word({ id: 'v2-u1-1', no: 1, word: 'fox', pos: 'n.', ipa: '/fɒks/', meaning: '狐狸' })],
      },
    ],
  },
]

describe('deriveVocabQuestions', () => {
  it('中→英默写题：ID 稳定、含 variant 同义答案（七上沿用 M1 格式）', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({
      id: 'g7a-vocab-u1-0001',
      type: 'fill_in',
      unit: 'v1-u1',
      term: 'A',
      answerSpec: { acceptedAnswers: ['unit'] },
    })
    expect(qs[1]).toMatchObject({
      id: 'g7a-vocab-u1-0002',
      answerSpec: { acceptedAnswers: ['centre', 'center'] },
    })
  })

  it('七下单元：按 v2- 前缀定位册，题目 ID 与知识点带 g7b', () => {
    const qs = deriveVocabQuestions(vocab, 'v2-u1')
    expect(qs).toHaveLength(1)
    expect(qs[0]).toMatchObject({
      id: 'g7b-vocab-u1-0001',
      unit: 'v2-u1',
      term: 'B',
    })
    expect(qs[0]!.knowledgePointIds).toEqual(['vocab.g7b.u1'])
    expect(qs[0]!.stem).toContain('狐狸')
  })

  it('同输入两次派生结果一致（题序与 ID 不变）', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u1')).toEqual(deriveVocabQuestions(vocab, 'v1-u1'))
    expect(deriveVocabQuestions(vocab, 'v2-u1')).toEqual(deriveVocabQuestions(vocab, 'v2-u1'))
  })

  it('未知单元返回空数组', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u99')).toEqual([])
    expect(deriveVocabQuestions(vocab, 'v3-u1')).toEqual([])
  })

  it('每题带知识点 ID 与释义解析', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs[0]!.knowledgePointIds).toEqual(['vocab.g7a.u1'])
    expect(qs[0]!.explanation).toContain('unit')
    expect(qs[0]!.explanation).toContain('单元')
  })
})

describe('词汇册查询', () => {
  it('findVocabUnit 跨两册按 unit id 查找', () => {
    expect(findVocabUnit(vocab, 'v1-u1')?.label).toBe('Starter Unit 1')
    expect(findVocabUnit(vocab, 'v2-u1')?.label).toBe('Unit 1')
    expect(findVocabUnit(vocab, 'v9-u1')).toBeUndefined()
  })

  it('vocabUnitsForBook 返回指定册的单元列表', () => {
    expect(vocabUnitsForBook(vocab, 'g7a')).toHaveLength(1)
    expect(vocabUnitsForBook(vocab, 'g7b')).toHaveLength(1)
    expect(vocabUnitsForBook(vocab, 'g8a')).toEqual([])
  })
})

describe('fetchContentBundle 失败后可重试', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('非 2xx 拒绝后，再次调用会重新 fetch', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (urls.length <= 3) return { ok: false, status: 404 } // 第一轮三个请求全失败
      return { ok: true, status: 200, json: async () => (url.endsWith('vocab.json') ? [] : {}) }
    }))
    const { fetchContentBundle } = await import('./loader')
    await expect(fetchContentBundle()).rejects.toThrow('题库加载失败')
    await expect(fetchContentBundle()).resolves.toBeDefined() // 重试成功
    expect(urls.length).toBe(6) // 确实重新 fetch 了 3 个文件
  })

  it('vocab.json 返回旧单对象结构（HTTP 陈旧缓存）按加载失败拒绝并可重试', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls += 1
      // 第一轮 vocab.json 返回旧结构；重试后返回正确数组
      const stale = calls <= 3 && url.endsWith('vocab.json')
      return { ok: true, status: 200, json: async () => (url.endsWith('vocab.json') ? (stale ? { book: 'g7a', units: [] } : []) : {}) }
    }))
    const { fetchContentBundle } = await import('./loader')
    await expect(fetchContentBundle()).rejects.toThrow('题库加载失败')
    await expect(fetchContentBundle()).resolves.toBeDefined()
    expect(calls).toBe(6)
  })
})
