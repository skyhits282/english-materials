import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SPECIAL_LEVEL_UNLOCKS,
  filterByUnlockedLevels,
  hasUnlockedSpecialQuestions,
  parseSpecialUnit,
  parseVocabUnitId,
} from './special-units'
import { SPECIALS } from './sets'
import type { Question } from '../types'

/** 最小选择题构造器：只有 unit 参与过滤逻辑，其余字段填合法占位值 */
const q = (unit: string): Question => ({
  id: `${unit}-q`,
  contentVersion: 't',
  grade: 7,
  term: 'A',
  unit,
  sourceUrl: '',
  knowledgePointIds: [],
  type: 'single_choice',
  stem: 's',
  options: ['a', 'b'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

/** 一个专项全部 6 级各一题 */
const specialQuestions = (specialId: string): Question[] =>
  [1, 2, 3, 4, 5, 6].map((level) => q(`${specialId}-l${level}`))

describe('parseVocabUnitId', () => {
  it('解析合法单元 id 为册别与序号', () => {
    expect(parseVocabUnitId('v1-u1')).toEqual({ book: 1, index: 1 })
    expect(parseVocabUnitId('v1-u10')).toEqual({ book: 1, index: 10 })
    expect(parseVocabUnitId('v2-u8')).toEqual({ book: 2, index: 8 })
  })

  it('拒绝非法单元 id', () => {
    expect(parseVocabUnitId('u4')).toBeUndefined()
    expect(parseVocabUnitId('v3-u1')).toBeUndefined()
    expect(parseVocabUnitId('v1-u')).toBeUndefined()
    expect(parseVocabUnitId('')).toBeUndefined()
  })
})

describe('parseSpecialUnit', () => {
  it('解析专项级别 unit 为专项 id 与级别', () => {
    expect(parseSpecialUnit('g7a-present-l1')).toEqual({ specialId: 'g7a-present', level: 1 })
    expect(parseSpecialUnit('g7a-present-l6')).toEqual({ specialId: 'g7a-present', level: 6 })
  })

  it('贪婪前缀兼容含连字符的专项 id', () => {
    expect(parseSpecialUnit('g7b-pronouns-modals-l3')).toEqual({ specialId: 'g7b-pronouns-modals', level: 3 })
  })

  it('拒绝非专项级别 unit（词汇单元等）', () => {
    expect(parseSpecialUnit('v1-u4')).toBeUndefined()
    expect(parseSpecialUnit('g7a-present')).toBeUndefined()
    expect(parseSpecialUnit('g7a-present-l7')).toBeUndefined()
    expect(parseSpecialUnit('')).toBeUndefined()
  })
})

describe('filterByUnlockedLevels', () => {
  it('只保留解锁单元序号不大于当前单元的级别（g7a-present：l1=v1-u1、l2=v1-u4，其余 v1-u9+）', () => {
    const kept = filterByUnlockedLevels(specialQuestions('g7a-present'), 'v1-u4')
    expect(kept.map((x) => x.unit)).toEqual(['g7a-present-l1', 'g7a-present-l2'])
  })

  it('Starter 阶段（v1-u1）对 g7a-present 只解锁 l1', () => {
    const kept = filterByUnlockedLevels(specialQuestions('g7a-present'), 'v1-u1')
    expect(kept.map((x) => x.unit)).toEqual(['g7a-present-l1'])
  })

  it('全序跨册比较：七下任意单元解锁全部七上级别', () => {
    // v1-u10 是七上末单元：v2-u1 必须不小于它（跨册语义的回归锚点）
    const kept = filterByUnlockedLevels([...specialQuestions('g7a-present'), ...specialQuestions('g7a-numbers')], 'v2-u1')
    expect(kept).toHaveLength(12)
  })

  it('跨册映射值按各自册别比较（g7b-pronouns-modals l3/l4 解锁于 v1-u8）', () => {
    const kept = filterByUnlockedLevels(specialQuestions('g7b-pronouns-modals'), 'v1-u8')
    expect(kept.map((x) => x.unit)).toEqual(['g7b-pronouns-modals-l3', 'g7b-pronouns-modals-l4'])
  })

  it('七上学生对七下专项大多未解锁（g7b-tenses 解锁于 v2-u5+，v1-u10 全锁）', () => {
    const kept = filterByUnlockedLevels(specialQuestions('g7b-tenses'), 'v1-u10')
    expect(kept).toEqual([])
    expect(hasUnlockedSpecialQuestions(specialQuestions('g7b-tenses'), 'v1-u10')).toBe(false)
  })

  it('七下中段按册内序号解锁（g7b-tenses 在 v2-u6 解锁 l1–l5、锁 l6）', () => {
    const kept = filterByUnlockedLevels(specialQuestions('g7b-tenses'), 'v2-u6')
    expect(kept.map((x) => x.unit)).toEqual([
      'g7b-tenses-l1',
      'g7b-tenses-l2',
      'g7b-tenses-l3',
      'g7b-tenses-l4',
      'g7b-tenses-l5',
    ])
  })

  it('fail-open：currentUnit 非法时全部保留', () => {
    const questions = specialQuestions('g7b-tenses')
    expect(filterByUnlockedLevels(questions, 'bad-unit')).toEqual(questions)
  })

  it('fail-open：题目 unit 解析失败（词题混入）时保留该题', () => {
    const questions = [q('v1-u4'), ...specialQuestions('g7b-tenses')]
    const kept = filterByUnlockedLevels(questions, 'v1-u1')
    expect(kept.map((x) => x.unit)).toEqual(['v1-u4'])
  })

  it('fail-open：专项不在映射表时保留（未映射 = 回退现状全解锁）', () => {
    const questions = specialQuestions('g99-xxx')
    expect(filterByUnlockedLevels(questions, 'v1-u1')).toEqual(questions)
    expect(hasUnlockedSpecialQuestions(questions, 'v1-u1')).toBe(true)
  })

  it('混合题集过滤与判空（hasUnlockedSpecialQuestions）', () => {
    const mixed = [...specialQuestions('g7a-present'), ...specialQuestions('g7b-tenses')]
    expect(hasUnlockedSpecialQuestions(mixed, 'v1-u4')).toBe(true)
    expect(hasUnlockedSpecialQuestions(mixed, 'v1-u1')).toBe(true) // g7a-present l1=v1-u1
    expect(hasUnlockedSpecialQuestions(specialQuestions('g7b-adjadv'), 'v1-u10')).toBe(false)
  })
})

describe('SPECIAL_LEVEL_UNLOCKS 结构不变量', () => {
  it('SPECIALS 每个专项都有映射，且无多余 key', () => {
    expect(Object.keys(SPECIAL_LEVEL_UNLOCKS).sort()).toEqual(SPECIALS.map((s) => s.id).sort())
  })

  it('每个专项恰 6 个级别映射，值均为合法词汇单元 id', () => {
    for (const [specialId, units] of Object.entries(SPECIAL_LEVEL_UNLOCKS)) {
      expect(units, specialId).toHaveLength(6)
      for (const unitId of units) {
        expect(parseVocabUnitId(unitId), `${specialId} ${unitId}`).toBeDefined()
      }
    }
  })

  it('真实题库 questions.json 的每个 unit 都能解析且专项都在映射中（防内容演进漂移）', () => {
    const questions: Question[] = JSON.parse(
      readFileSync(new URL('../../public/content/g7a/questions.json', import.meta.url), 'utf-8'),
    )
    expect(questions.length).toBeGreaterThan(0)
    for (const question of questions) {
      const parsed = parseSpecialUnit(question.unit)
      expect(parsed, question.unit).toBeDefined()
      expect(SPECIAL_LEVEL_UNLOCKS[parsed!.specialId], question.unit).toBeDefined()
      // 映射表对真实数据的整链路冒烟：全部解锁（v2-u8 之后无更高单元）应保留全部题
      const kept = filterByUnlockedLevels(questions, 'v2-u8')
      expect(kept).toHaveLength(questions.length)
    }
  })
})
