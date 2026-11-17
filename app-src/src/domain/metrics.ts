import type { Attempt } from '../types'

export interface CoreMetrics {
  totalAttempts: number
  firstAttempts: number
  firstCorrect: number
  /** 首次作答正确率；无首测数据时为 null（页面显示"暂无数据"） */
  firstTryCorrectRate: number | null
  retryAttempts: number
  retryCorrect: number
  wrongQuestions: number
}

export function computeCoreMetrics(attempts: Attempt[]): CoreMetrics {
  let firstAttempts = 0
  let firstCorrect = 0
  let retryAttempts = 0
  let retryCorrect = 0
  const wrong = new Set<string>()
  for (const a of attempts) {
    if (a.phase === 'first') {
      firstAttempts += 1
      if (a.isCorrect) firstCorrect += 1
    } else {
      retryAttempts += 1
      if (a.isCorrect) retryCorrect += 1
    }
    if (!a.isCorrect) wrong.add(a.questionId)
  }
  return {
    totalAttempts: attempts.length,
    firstAttempts,
    firstCorrect,
    firstTryCorrectRate: firstAttempts > 0 ? firstCorrect / firstAttempts : null,
    retryAttempts,
    retryCorrect,
    wrongQuestions: wrong.size,
  }
}

/** 本地日历日键（规格 8：按设备本地时区算"今日"） */
export function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isSameLocalDay(isoUtc: string, key: string): boolean {
  return localDayKey(new Date(isoUtc)) === key
}
