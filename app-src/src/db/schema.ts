import Dexie, { type Table } from 'dexie'
import type { Attempt, ContentMeta, Mastery, Question, Settings } from '../types'

export interface SettingsRow {
  key: string
  value: Settings
  updatedAt: string
}

export interface ContentMetaRow extends ContentMeta {
  contentId: string
}

export interface WeeklyReportRow {
  weekStart: string
  facts: unknown
  aiSuggestions?: string
  generatedAt: string
}

export interface AiRequestRow {
  id: string
  type: string
  status: string
  localCostEstimate?: number
  createdAt: string
}

/** 每日计划任务类型（规格 §2.1：到期复习 / 单元词汇 / 专项巩固 / 学习小结） */
export type TaskType = 'review' | 'unit' | 'special' | 'summary'

export interface TaskRow {
  id: string
  day: string
  type: TaskType
  questionIds: string[]
  status: 'planned' | 'in_progress' | 'completed' | 'skipped' | 'deferred'
  minutesPlanned: number
}

export class EnglishCoachDB extends Dexie {
  settings!: Table<SettingsRow, string>
  contentMeta!: Table<ContentMetaRow, string>
  questions!: Table<Question, string>
  tasks!: Table<TaskRow, string>
  attempts!: Table<Attempt, string>
  mastery!: Table<Mastery, string>
  weeklyReports!: Table<WeeklyReportRow, string>
  aiRequests!: Table<AiRequestRow, string>

  constructor() {
    super('EnglishCoachDB')
    this.version(1).stores({
      settings: 'key',
      contentMeta: 'contentId',
      questions: 'id, unit, *knowledgePointIds, contentVersion',
      tasks: 'id, day, status',
      attempts: 'id, questionId, submittedAt, phase',
      mastery: 'knowledgePointId, nextReviewAt',
      weeklyReports: 'weekStart',
      aiRequests: 'id, createdAt',
    })
  }
}

export const db = new EnglishCoachDB()
