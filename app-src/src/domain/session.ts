import { gradeAnswer } from './grader'
import { uuid } from '../utils/uuid'
import type { Attempt, AttemptPhase, Question } from '../types'

export interface SessionDeps {
  hasPriorAttempt: (questionId: string) => Promise<boolean>
  recordAttempt: (attempt: Attempt) => Promise<void>
}

export interface Submission {
  question: Question
  answer: string
  isCorrect: boolean
  phase: AttemptPhase
  correctAnswer: string
  isLast: boolean
}

/** attempt id：统一走 utils/uuid（原生 randomUUID 或非安全上下文的 v4 回退） */
export function newAttemptId(): string {
  return uuid()
}

/** 一次练习会话：顺序出题、提交即判分并落一条 attempt */
export class PracticeSession {
  private index = 0
  private submitting = false
  readonly total: number

  constructor(private questions: Question[], private deps: SessionDeps) {
    if (questions.length === 0) throw new Error('PracticeSession 需要至少一道题')
    this.total = questions.length
  }

  get current(): Question {
    if (this.isFinished) throw new Error('练习已结束')
    return this.questions[this.index]!
  }

  get done(): number {
    return this.index
  }

  get isFinished(): boolean {
    return this.index >= this.total
  }

  async submit(answer: string, opts: { gaveUp?: boolean } = {}): Promise<Submission> {
    if (this.isFinished) throw new Error('练习已结束')
    if (this.submitting) throw new Error('正在处理上一次提交')
    this.submitting = true
    try {
      const question = this.current
      const graded = gradeAnswer(question, answer)
      const isCorrect = opts.gaveUp ? false : graded.isCorrect
      const phase: AttemptPhase = (await this.deps.hasPriorAttempt(question.id)) ? 'retry' : 'first'
      const attempt: Attempt = {
        id: newAttemptId(),
        questionId: question.id,
        answer,
        isCorrect,
        phase,
        ...(opts.gaveUp ? { selfReportedReason: 'gave_up' as const } : {}),
        submittedAt: new Date().toISOString(),
      }
      await this.deps.recordAttempt(attempt)
      this.index += 1
      return {
        question,
        answer,
        isCorrect,
        phase,
        correctAnswer: graded.correctAnswer,
        isLast: this.index >= this.total,
      }
    } finally {
      this.submitting = false
    }
  }
}
