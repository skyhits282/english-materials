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

/** 分册统计（content.json 的 books 字段） */
export interface ContentBookSummary {
  book: string
  questionCount: number
  vocabUnits: number
  vocabWordCount: number
}

export interface ContentMeta {
  contentId: string
  version: string
  questionCount: number
  vocabWordCount: number
  books: ContentBookSummary[]
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
  /** 当前间隔档（天）：0=未排期 1/3/7/14（规格 §1.1，消除"3 天档 vs 7 天档"判定歧义） */
  intervalDays: number
  metrics: { testedCount: number; firstTryCorrect: number; delayedReviewCorrect: number }
}

export interface Settings {
  grade: number
  /** 教材册别（七上 g7a / 七下 g7b），决定词汇单元列表与单词默写来源（v1-* ↔ g7a、v2-* ↔ g7b） */
  book: 'g7a' | 'g7b'
  /** 词汇默写当前单元，取 vocab unit id（如 v1-u4 / v2-u3） */
  currentUnit: string
  dailyMinutes: number
  /** 每周学习日（周一=0 … 周日=6 的星期序号数组，支持非连续组合）；
   *  默认周一至周四 + 周六周日（仅周五休息）。旧字段 studyDaysPerWeek 已废弃，仅备份导入时映射 */
  studyDays: number[]
  aiEnabled: boolean
  studentLabel: string
  /** 家长保护 PIN：4 位数字，明文存储（仅防误操作，不参与任何加密）；undefined=未设置。
   *  备份导出剔除该字段（Task 9 统一处理）。 */
  parentPin?: string
  /** 最近两次试卷的题型分项成绩（如"语法 12/15"），手工录入、上限 8 行，
   *  仅作报告页诊断参考，不参与自动判分与指标。 */
  examScores?: ExamScoreRow[]
  /** AI 直连配置（规格 §7.1，均可选：未配置密钥=AI 功能灰态）。
   *  红线：aiApiKey 仅存本机浏览器，备份导出时剔除；aiModel/aiBaseUrl 缺省时 UI 展示默认值。 */
  aiBaseUrl?: string
  aiApiKey?: string
  aiModel?: string
  /** 手写拍照识别用多模态模型（qwen-vl-ocr 等）：缺省用 AI_DEFAULT_VISION_MODEL。
   *  非凭证字段，备份导出不剔除（与 aiModel 同待遇）。 */
  aiVisionModel?: string
  aiDailyLimit?: number
}

/** 试卷分项成绩一行：题型标签 + 得分/满分 */
export interface ExamScoreRow {
  label: string
  got: number
  total: number
}

export interface ContentBundle {
  questions: Question[]
  /** 两册词汇（g7a 在前、g7b 在后） */
  vocab: VocabBook[]
  meta: ContentMeta
}
