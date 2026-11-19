import { describe, expect, it } from 'vitest'
import { alignRecognizedWords } from './dictation-align'

describe('alignRecognizedWords（识别词表 → 逐题对齐）', () => {
  it('全部命中：按题号填入文本', () => {
    const aligned = alignRecognizedWords(3, [
      { index: 1, text: 'apple' },
      { index: 2, text: 'bag' },
      { index: 3, text: 'cat' },
    ])
    expect(aligned).toEqual([
      { index: 1, text: 'apple' },
      { index: 2, text: 'bag' },
      { index: 3, text: 'cat' },
    ])
  })

  it('缺失序号 → null（未作答语义）', () => {
    const aligned = alignRecognizedWords(3, [{ index: 2, text: 'bag' }])
    expect(aligned).toEqual([
      { index: 1, text: null },
      { index: 2, text: 'bag' },
      { index: 3, text: null },
    ])
  })

  it('空词表 → 全部 null（页面据 words.length===0 先行不判分，此为兜底）', () => {
    expect(alignRecognizedWords(2, [])).toEqual([
      { index: 1, text: null },
      { index: 2, text: null },
    ])
  })

  it('越界与重复序号：越界忽略、重复取后（vision 已校验，此处兜底）', () => {
    const aligned = alignRecognizedWords(2, [
      { index: 0, text: 'x' },
      { index: 3, text: 'y' },
      { index: 1, text: 'a' },
      { index: 1, text: 'b' },
    ])
    expect(aligned).toEqual([
      { index: 1, text: 'b' },
      { index: 2, text: null },
    ])
  })

  it('expectedCount 为 0 → 空数组（防御：PracticeSession 构造会拒绝空题集，页面先行拦截）', () => {
    expect(alignRecognizedWords(0, [{ index: 1, text: 'a' }])).toEqual([])
  })
})