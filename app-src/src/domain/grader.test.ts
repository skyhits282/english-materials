import { describe, expect, it } from 'vitest'
import { gradeAnswer, normalizeBlank } from './grader'
import type { Question } from '../types'

const choice: Question = {
  id: 'q1',
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: 'She ___ to school every day.',
  options: ['go', 'goes', 'going', 'gone'],
  answerSpec: { correctOptionIndex: 1 },
  explanation: '三单用 goes',
  difficulty: 1,
  estimatedSeconds: 45,
}

const fill: Question = {
  id: 'q2',
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'fill_in',
  stem: '单元（n.）',
  answerSpec: { acceptedAnswers: ['unit'] },
  explanation: 'unit n. 单元',
  difficulty: 1,
  estimatedSeconds: 20,
}

const fillVariant: Question = {
  ...fill,
  id: 'q3',
  answerSpec: { acceptedAnswers: ['centre', 'center'] },
}

describe('normalizeBlank', () => {
  it('去首尾空白、折叠内部空白、统一小写', () => {
    expect(normalizeBlank('  Unit  ')).toBe('unit')
    expect(normalizeBlank('New   York ')).toBe('new york')
    expect(normalizeBlank('UNIT')).toBe('unit')
  })
  it('全角标点转半角、去包裹引号', () => {
    expect(normalizeBlank('，')).toBe(',')
    expect(normalizeBlank('。')).toBe('.')
    expect(normalizeBlank('twelve。')).toBe('twelve.')
    expect(normalizeBlank('"unit"')).toBe('unit')
    expect(normalizeBlank('“unit”')).toBe('unit')
  })
})

describe('gradeAnswer', () => {
  it('选择题：比对选项下标', () => {
    expect(gradeAnswer(choice, '1').isCorrect).toBe(true)
    expect(gradeAnswer(choice, '0').isCorrect).toBe(false)
    expect(gradeAnswer(choice, '1').correctAnswer).toBe('goes')
  })
  it('选择题：非数字答案判错不抛异常', () => {
    expect(gradeAnswer(choice, 'x').isCorrect).toBe(false)
  })
  it('填空：大小写与空白不敏感', () => {
    expect(gradeAnswer(fill, '  UNIT ').isCorrect).toBe(true)
    expect(gradeAnswer(fill, 'united').isCorrect).toBe(false)
  })
  it('填空：接受同义变体', () => {
    expect(gradeAnswer(fillVariant, 'Center').isCorrect).toBe(true)
    expect(gradeAnswer(fillVariant, 'centre').isCorrect).toBe(true)
  })
  it('填空：正确答案取首选（展示用）', () => {
    expect(gradeAnswer(fillVariant, 'x').correctAnswer).toBe('centre')
  })
})
