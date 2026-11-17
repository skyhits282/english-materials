export type QuestionType = 'single_choice' | 'fill_in'

export interface AnswerSpec {
  correctOptionIndex?: number
  acceptedAnswers?: string[]
}

export interface Question {
  id: string
  contentVersion: string
  grade: number
  term: 'A' | 'B'
  /** 练习集合 ID：专项级别（g7a-present-l1）或词汇单元（v1-u4） */
  unit: string
  sourceUrl: string
  knowledgePointIds: string[]
  type: QuestionType
  stem: string
  options?: string[]
  answerSpec: AnswerSpec
  explanation: string
  difficulty: number
  estimatedSeconds: number
}

export interface VocabWord {
  id: string
  no: number
  word: string
  variant: string
  pos: string
  ipa: string
  meaning: string
}

export interface VocabUnit {
  id: string
  order: number
  label: string
  words: VocabWord[]
}

export interface VocabBook {
  book: string
  contentVersion: string
  units: VocabUnit[]
}

export interface ContentFileInfo {
  name: string
  sha256: string
  count: number
}

export interface ContentMeta {
  contentId: string
  version: string
  questionCount: number
  vocabWordCount: number
  files: ContentFileInfo[]
}

export type AttemptPhase = 'first' | 'retry'

export interface Attempt {
  id: string
  taskId?: string
  questionId: string
  /** 选择题存选项下标字符串，填空题存原文 */
  answer: string
  isCorrect: boolean
  phase: AttemptPhase
  selfReportedReason?: 'gave_up'
  /** ISO 8601 UTC */
  submittedAt: string
}

export type MasteryStage = 'new' | 'weak' | 'consolidating' | 'mastered'

export interface Mastery {
  knowledgePointId: string
  stage: MasteryStage
  nextReviewAt?: string
  lastAttemptAt?: string
  metrics: { testedCount: number; firstTryCorrect: number }
}

export interface Settings {
  grade: number
  /** 词汇默写当前单元，取 vocab unit id（如 v1-u4） */
  currentUnit: string
  dailyMinutes: number
  studyDaysPerWeek: number
  aiEnabled: boolean
  studentLabel: string
}

export interface ContentBundle {
  questions: Question[]
  vocab: VocabBook
  meta: ContentMeta
}
