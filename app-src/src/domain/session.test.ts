import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('非安全上下文无 crypto.randomUUID → attempt id 走回退仍为合法 UUID v4 格式', () => {
    // 模拟 http 非 localhost 部署：crypto 存在但无 randomUUID（uuid() 应回退到 Math.random 版本）
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    expect(newAttemptId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('原生 randomUUID 可用时 newAttemptId 直接透传（不落回退分支）', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(newAttemptId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    spy.mockRestore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('并发重入被守卫拦截：只落一条 attempt、index 只 +1', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1'), choice('q2')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const first = s.submit('1')
    await expect(s.submit('1')).rejects.toThrow('正在处理上一次提交')
    await first
    expect(attempts).toHaveLength(1)
    expect(s.done).toBe(1)
  })

  it('recordAttempt 失败不推进，重试成功只落一条', async () => {
    const attempts: Attempt[] = []
    let fail = true
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => {
        if (fail) throw new Error('写失败')
        attempts.push(a)
      },
    })
    await expect(s.submit('1')).rejects.toThrow('写失败')
    expect(s.done).toBe(0)
    fail = false
    const sub = await s.submit('1')
    expect(sub.isCorrect).toBe(true)
    expect(sub.isLast).toBe(true)
    expect(attempts).toHaveLength(1)
  })
})
