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
  // 行形状校验（规格 §2.6：先校验 schemaVersion 与字段类型，再入库）
  d.settings.forEach((row, i) => validateSettingsRow(row, i + 1))
  d.questions.forEach((row, i) => validateQuestionRow(row, i + 1))
  d.mastery.forEach((row, i) => validateMasteryRow(row, i + 1))
  const primaryKeys: Array<[keyof BackupFile['data'], string]> = [
    ['settings', 'key'],
    ['contentMeta', 'contentId'],
    ['questions', 'id'],
    ['attempts', 'id'],
    ['mastery', 'knowledgePointId'],
    ['weeklyReports', 'weekStart'],
  ]
  for (const [table, key] of primaryKeys) {
    const seen = new Set<unknown>()
    for (const row of d[table] as unknown as Array<Record<string, unknown>>) {
      const id = row[key]
      if (seen.has(id)) throw new BackupError(`备份 ${table} 表存在重复主键：${String(id)}`)
      seen.add(id)
    }
  }
  d.attempts.forEach((a, i) => {
    if (!a.id || !a.questionId || typeof a.isCorrect !== 'boolean' || (a.phase !== 'first' && a.phase !== 'retry')) {
      throw new BackupError(`备份 attempts 表第 ${i + 1} 行记录非法：${JSON.stringify(a).slice(0, 120)}`)
    }
  })
  return { ...(file as BackupFile), data: d }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** settings 行：{ key: string, value: Settings, updatedAt: string }，字段宽松校验（可缺省，出现即需类型正确） */
function validateSettingsRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 settings 表第 ${line} 行不是对象`)
  if (typeof row.key !== 'string' || row.key === '') {
    throw new BackupError(`备份 settings 表第 ${line} 行缺少合法 key`)
  }
  if (typeof row.updatedAt !== 'string') {
    throw new BackupError(`备份 settings 表第 ${line} 行 updatedAt 不是字符串`)
  }
  if (!isPlainObject(row.value)) throw new BackupError(`备份 settings 表第 ${line} 行 value 不是对象`)
  const value = row.value
  const stringFields = ['currentUnit', 'studentLabel'] as const
  for (const f of stringFields) {
    if (value[f] !== undefined && typeof value[f] !== 'string') {
      throw new BackupError(`备份 settings 表第 ${line} 行 value.${f} 不是字符串`)
    }
  }
  const numberFields = ['grade', 'dailyMinutes', 'studyDaysPerWeek'] as const
  for (const f of numberFields) {
    if (value[f] !== undefined && typeof value[f] !== 'number') {
      throw new BackupError(`备份 settings 表第 ${line} 行 value.${f} 不是数字`)
    }
  }
  if (value.aiEnabled !== undefined && typeof value.aiEnabled !== 'boolean') {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.aiEnabled 不是布尔值`)
  }
  if (value.book !== undefined && value.book !== 'g7a' && value.book !== 'g7b') {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.book 只能是 g7a 或 g7b`)
  }
}

/** questions 行：对齐 Question 接口，必填形状缺失或类型错误即拒绝 */
function validateQuestionRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 questions 表第 ${line} 行不是对象`)
  if (typeof row.id !== 'string' || row.id === '') {
    throw new BackupError(`备份 questions 表第 ${line} 行缺少合法 id`)
  }
  if (row.type !== 'single_choice' && row.type !== 'fill_in') {
    throw new BackupError(`备份 questions 表第 ${line} 行 type 非法：${String(row.type)}`)
  }
  if (typeof row.stem !== 'string' || typeof row.explanation !== 'string') {
    throw new BackupError(`备份 questions 表第 ${line} 行 stem/explanation 不是字符串`)
  }
  if (!Array.isArray(row.knowledgePointIds)) {
    throw new BackupError(`备份 questions 表第 ${line} 行 knowledgePointIds 不是数组`)
  }
  if (row.options !== undefined && !Array.isArray(row.options)) {
    throw new BackupError(`备份 questions 表第 ${line} 行 options 不是数组`)
  }
  if (!isPlainObject(row.answerSpec)) {
    throw new BackupError(`备份 questions 表第 ${line} 行 answerSpec 不是对象`)
  }
}

/** mastery 行：对齐 Mastery 接口 */
function validateMasteryRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 mastery 表第 ${line} 行不是对象`)
  if (typeof row.knowledgePointId !== 'string' || row.knowledgePointId === '') {
    throw new BackupError(`备份 mastery 表第 ${line} 行缺少合法 knowledgePointId`)
  }
  const stages = ['new', 'weak', 'consolidating', 'mastered']
  if (!stages.includes(row.stage as string)) {
    throw new BackupError(`备份 mastery 表第 ${line} 行 stage 非法：${String(row.stage)}`)
  }
  if (row.metrics !== undefined) {
    if (!isPlainObject(row.metrics)) {
      throw new BackupError(`备份 mastery 表第 ${line} 行 metrics 不是对象`)
    }
    if (typeof row.metrics.testedCount !== 'number' || typeof row.metrics.firstTryCorrect !== 'number') {
      throw new BackupError(`备份 mastery 表第 ${line} 行 metrics 字段类型非法`)
    }
  }
}

export interface ImportSummary {
  attemptsAdded: number
  attemptsSkipped: number
}

export async function importBackup(file: BackupFile, mode: 'merge' | 'overwrite'): Promise<ImportSummary> {
  if (mode === 'overwrite') {
    return db.transaction(
      'rw',
      [db.settings, db.contentMeta, db.questions, db.attempts, db.mastery, db.weeklyReports],
      async () => {
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
      },
    )
  }
  // 合并：题目/元数据 upsert；attempts 只补缺失，绝不改写历史；settings 跳过已有键
  return db.transaction(
    'rw',
    [db.settings, db.contentMeta, db.questions, db.attempts, db.mastery, db.weeklyReports],
    async () => {
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
    },
  )
}

export function backupFileName(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `english-learning-backup-${y}${m}${d}.json`
}
