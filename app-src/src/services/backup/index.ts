import { db, type ContentMetaRow, type SettingsRow, type WeeklyReportRow } from '../../db/schema'
import type { Attempt, Mastery, Question } from '../../types'

export const BACKUP_SCHEMA_VERSION = 1

export class BackupError extends Error {}

export interface BackupCounts {
  settings: number
  contentMeta: number
  questions: number
  attempts: number
  mastery: number
  weeklyReports: number
}

export interface BackupFile {
  schemaVersion: number
  app: 'english-coach'
  exportedAt: string
  counts: BackupCounts
  data: {
    settings: SettingsRow[]
    contentMeta: ContentMetaRow[]
    questions: Question[]
    attempts: Attempt[]
    mastery: Mastery[]
    weeklyReports: WeeklyReportRow[]
  }
}

export async function exportBackup(): Promise<BackupFile> {
  const [settings, contentMeta, questions, attempts, mastery, weeklyReports] = await Promise.all([
    db.settings.toArray(),
    db.contentMeta.toArray(),
    db.questions.toArray(),
    db.attempts.toArray(),
    db.mastery.toArray(),
    db.weeklyReports.toArray(),
  ])
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'english-coach',
    exportedAt: new Date().toISOString(),
    counts: {
      settings: settings.length,
      contentMeta: contentMeta.length,
      questions: questions.length,
      attempts: attempts.length,
      mastery: mastery.length,
      weeklyReports: weeklyReports.length,
    },
    data: { settings, contentMeta, questions, attempts, mastery, weeklyReports },
  }
}

export function parseAndValidateBackup(text: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupError('不是有效的 JSON 文件')
  }
  const file = parsed as Partial<BackupFile>
  if (file.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupError(`备份版本不支持（${String(file.schemaVersion)}，本应用支持 ${BACKUP_SCHEMA_VERSION}）`)
  }
  if (!file.data || typeof file.data !== 'object') throw new BackupError('备份缺少 data 字段')
  const d = file.data
  for (const key of ['settings', 'contentMeta', 'questions', 'attempts', 'mastery', 'weeklyReports'] as const) {
    if (!Array.isArray(d[key])) throw new BackupError(`备份缺少 ${key} 数据`)
  }
  if (!file.counts || typeof file.counts !== 'object') throw new BackupError('备份缺少 counts 字段')
  for (const [key, value] of Object.entries(file.counts)) {
    const actual = (d as Record<string, unknown[]>)[key]?.length ?? 0
    if (value !== actual) throw new BackupError(`counts.${key}（${value}）与实际数据（${actual}）不一致`)
  }
  for (const a of d.attempts ?? []) {
    if (!a.id || !a.questionId || typeof a.isCorrect !== 'boolean' || (a.phase !== 'first' && a.phase !== 'retry')) {
      throw new BackupError(`存在非法 attempt 记录：${JSON.stringify(a).slice(0, 120)}`)
    }
  }
  return { ...(file as BackupFile), data: d }
}

export interface ImportSummary {
  attemptsAdded: number
  attemptsSkipped: number
}

export async function importBackup(file: BackupFile, mode: 'merge' | 'overwrite'): Promise<ImportSummary> {
  if (mode === 'overwrite') {
    await Promise.all([
      db.settings.clear(),
      db.contentMeta.clear(),
      db.questions.clear(),
      db.attempts.clear(),
      db.mastery.clear(),
      db.weeklyReports.clear(),
    ])
    await db.settings.bulkAdd(file.data.settings)
    await db.contentMeta.bulkAdd(file.data.contentMeta)
    await db.questions.bulkAdd(file.data.questions)
    await db.mastery.bulkAdd(file.data.mastery)
    await db.weeklyReports.bulkAdd(file.data.weeklyReports)
    await db.attempts.bulkAdd(file.data.attempts)
    return { attemptsAdded: file.data.attempts.length, attemptsSkipped: 0 }
  }
  // 合并：题目/元数据 upsert；attempts 只补缺失，绝不改写历史；settings 跳过已有键
  await db.contentMeta.bulkPut(file.data.contentMeta)
  await db.questions.bulkPut(file.data.questions)
  await db.mastery.bulkPut(file.data.mastery)
  await db.weeklyReports.bulkPut(file.data.weeklyReports)
  const existingKeys = await db.settings.bulkGet(file.data.settings.map((r) => r.key))
  const newSettings = file.data.settings.filter((_, i) => existingKeys[i] === undefined)
  if (newSettings.length > 0) await db.settings.bulkAdd(newSettings)
  const existingAttempts = await db.attempts.bulkGet(file.data.attempts.map((a) => a.id))
  const missing = file.data.attempts.filter((_, i) => existingAttempts[i] === undefined)
  if (missing.length > 0) await db.attempts.bulkAdd(missing)
  return { attemptsAdded: missing.length, attemptsSkipped: file.data.attempts.length - missing.length }
}

export function backupFileName(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `english-learning-backup-${y}${m}${d}.json`
}
