import { describe, expect, it } from 'vitest'
import { PracticeSession, newAttemptId } from './session'
import type { Attempt, Question } from '../types'

const choice = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: '1 + 1 = ___',
  options: ['1', '2', '3', '4'],
  answerSpec: { correctOptionIndex: 1 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

describe('PracticeSession', () => {
  it('空题集抛错', () => {
    expect(() => new PracticeSession([], { hasPriorAttempt: async () => false, recordAttempt: async () => {} })).toThrow()
  })

  it('提交记录 attempt 并推进；首题 phase=first', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1'), choice('q2')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const sub = await s.submit('1')
    expect(sub.isCorrect).toBe(true)
    expect(sub.phase).toBe('first')
    expect(sub.isLast).toBe(false)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.questionId).toBe('q1')
    expect(attempts[0]!.isCorrect).toBe(true)
    expect(s.done).toBe(1)
    expect(s.current.id).toBe('q2')
  })

  it('已有历史时 phase=retry（做错后改对不覆盖首测，T02）', async () => {
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => true,
      recordAttempt: async () => {},
    })
    expect((await s.submit('2')).phase).toBe('retry')
  })

  it('我不会：记错误并带 gave_up 标记', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const sub = await s.submit('', { gaveUp: true })
    expect(sub.isCorrect).toBe(false)
    expect(sub.correctAnswer).toBe('2')
    expect(attempts[0]!.selfReportedReason).toBe('gave_up')
    expect(attempts[0]!.isCorrect).toBe(false)
  })

  it('最后一题后 isFinished，再提交抛错', async () => {
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async () => {},
    })
    await s.submit('2')
    expect(s.isFinished).toBe(true)
    await expect(s.submit('2')).rejects.toThrow('练习已结束')
  })

  it('attempt id 为合法 UUID', () => {
    expect(newAttemptId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
