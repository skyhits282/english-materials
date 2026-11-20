import { describe, expect, it } from 'vitest'
import { pickSpecialPractice, shuffle, SPECIAL_PRACTICE_MAX } from './practice'
import type { Question } from '../types'

/** 最小 Question fixture：抽题只关心集合成员与顺序，其余字段占位（口径同 plan.test.ts 的 specialQ） */
const q = (i: number): Question => ({
  id: `g7a-present-l1-${String(i + 1).padStart(4, '0')}`,
  contentVersion: 'test-v1',
  grade: 7,
  term: 'A',
  unit: 'g7a-present-l1',
  sourceUrl: 's',
  knowledgePointIds: ['kp.test'],
  type: 'single_choice',
  stem: 'stem',
  options: ['a', 'b', 'c', 'd'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

describe('shuffle（Fisher-Yates，拷贝洗牌）', () => {
  it('空数组与单元素数组不崩溃且元素不变', () => {
    expect(shuffle([])).toEqual([])
    expect(shuffle([q(0)]).map((x) => x.id)).toEqual([q(0).id])
  })
  it('不修改入参数组', () => {
    const input = [q(0), q(1), q(2)]
    const before = input.map((x) => x.id)
    shuffle(input)
    expect(input.map((x) => x.id)).toEqual(before)
  })
})

describe('pickSpecialPractice（规格 §0：纯随机抽 24）', () => {
  it('上限常量锚定为 24（规格唯一数字契约，防自引用断言）', () => {
    expect(SPECIAL_PRACTICE_MAX).toBe(24)
  })
  it('48 题抽恰 24 题，且结果为输入子集', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const picked = pickSpecialPractice(input)
    expect(picked).toHaveLength(SPECIAL_PRACTICE_MAX)
    const ids = new Set(input.map((x) => x.id))
    for (const x of picked) expect(ids.has(x.id)).toBe(true)
    expect(new Set(picked.map((x) => x.id)).size).toBe(SPECIAL_PRACTICE_MAX)
  })
  it('输入不足 24（5 题）时全部返回', () => {
    const input = Array.from({ length: 5 }, (_, i) => q(i))
    const picked = pickSpecialPractice(input)
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((x) => x.id))).toEqual(new Set(input.map((x) => x.id)))
  })
  it('随机性生效：20 次调用首题不全相同（48 题全同首题概率 ≈ 48⁻¹⁹，实际为零）', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const firsts = new Set(Array.from({ length: 20 }, () => pickSpecialPractice(input)[0]!.id))
    expect(firsts.size).toBeGreaterThan(1)
  })
  it('不修改入参数组（抽题在拷贝上洗牌）', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const before = input.map((x) => x.id)
    pickSpecialPractice(input)
    expect(input.map((x) => x.id)).toEqual(before)
  })
})
