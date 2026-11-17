import { db, type AiRequestRow, type ContentMetaRow, type SettingsRow, type TaskRow, type WeeklyReportRow } from '../../db/schema'
import type { Attempt, Mastery, Question } from '../../types'
import { PIN_PATTERN } from '../../domain/pin'

/** 当前备份 schema 版本；v1 文件仍可导入（兼容规则见 parseAndValidateBackup） */
export const BACKUP_SCHEMA_VERSION = 2

/** 仍受支持的最低版本（v1：无 tasks/aiRequests 表、无 v2 行校验） */
const V1_SCHEMA_VERSION = 1

export class BackupError extends Error {}

export interface BackupCounts {
  settings: number
  contentMeta: number
  questions: number
  tasks: number
  attempts: number
  mastery: number
  weeklyReports: number
  aiRequests: number
}

export interface BackupData {
  settings: SettingsRow[]
  contentMeta: ContentMetaRow[]
  questions: Question[]
  tasks: TaskRow[]
  attempts: Attempt[]
  mastery: Mastery[]
  weeklyReports: WeeklyReportRow[]
  aiRequests: AiRequestRow[]
}

export interface BackupFile {
  schemaVersion: number
  app: 'english-coach'
  exportedAt: string
  counts: BackupCounts
  data: BackupData
}

/** 备份中全部表名（counts 校验/导入清库遍历用） */
const TABLE_KEYS = ['settings', 'contentMeta', 'questions', 'tasks', 'attempts', 'mastery', 'weeklyReports', 'aiRequests'] as const

/** settings 值导出前剔除凭证字段（红线：不导出 aiApiKey 与 parentPin）。
 *  浅拷贝后 delete，不改动库内原行；先剔除再计数（校验和按剔除后数据算）。 */
function redactSettingsRow(row: SettingsRow): SettingsRow {
  const value = { ...row.value }
  delete value.aiApiKey
  delete value.parentPin
  return { ...row, value }
}

export async function exportBackup(): Promise<BackupFile> {
  const [settings, contentMeta, questions, tasks, attempts, mastery, weeklyReports, aiRequests] = await Promise.all([
    db.settings.toArray(),
    db.contentMeta.toArray(),
    db.questions.toArray(),
    db.tasks.toArray(),
    db.attempts.toArray(),
    db.mastery.toArray(),
    db.weeklyReports.toArray(),
    db.aiRequests.toArray(),
  ])
  const redactedSettings = settings.map(redactSettingsRow)
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'english-coach',
    exportedAt: new Date().toISOString(),
    counts: {
      settings: redactedSettings.length,
      contentMeta: contentMeta.length,
      questions: questions.length,
      tasks: tasks.length,
      attempts: attempts.length,
      mastery: mastery.length,
      weeklyReports: weeklyReports.length,
      aiRequests: aiRequests.length,
    },
    data: { settings: redactedSettings, contentMeta, questions, tasks, attempts, mastery, weeklyReports, aiRequests },
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
  const isV1 = file.schemaVersion === V1_SCHEMA_VERSION
  if (!isV1 && file.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupError(`备份版本不支持（${String(file.schemaVersion)}，本应用支持 ${BACKUP_SCHEMA_VERSION} 与 ${V1_SCHEMA_VERSION}）`)
  }
  // 文件级字段：app 标识（至少非空字符串）与导出时间（须可解析日期；v1/v2 真实导出均为 ISO 时间）
  const app = (file as { app?: unknown }).app
  if (typeof app !== 'string' || app === '') {
    throw new BackupError('备份文件 app 字段缺失或不是非空字符串')
  }
  if (typeof file.exportedAt !== 'string' || Number.isNaN(Date.parse(file.exportedAt))) {
    throw new BackupError('备份文件 exportedAt 缺失或不是合法日期（应为导出时刻的 ISO 时间）')
  }
  if (!file.data || typeof file.data !== 'object') throw new BackupError('备份缺少 data 字段')
  const d = file.data as unknown as Record<string, unknown[]>
  // v1/v2 共有表：数组必须存在且为数组
  for (const key of ['settings', 'contentMeta', 'questions', 'attempts', 'mastery', 'weeklyReports'] as const) {
    if (!Array.isArray(d[key])) throw new BackupError(`备份缺少 ${key} 数据`)
  }
  // v2 新表：v2 文件缺数组按空处理；存在则须为数组；v1 文件一律视为空（跳过 v2 新表校验）
  for (const key of ['tasks', 'aiRequests'] as const) {
    if (isV1 || d[key] === undefined) d[key] = []
    else if (!Array.isArray(d[key])) throw new BackupError(`备份 ${key} 不是数组`)
  }
  if (!file.counts || typeof file.counts !== 'object') throw new BackupError('备份缺少 counts 字段')
  for (const [key, value] of Object.entries(file.counts)) {
    const actual = d[key]?.length ?? 0
    if (value !== actual) throw new BackupError(`counts.${key}（${value}）与实际数据（${actual}）不一致`)
  }
  // 行形状校验（规格 §2.6：先校验 schemaVersion 与字段类型，再入库）。
  // weeklyReports 行校验对 v1/v2 均生效（v1 导出的行本就满足形状，属加固而非破坏兼容）。
  const data: BackupData = {
    settings: d.settings as unknown as SettingsRow[],
    contentMeta: d.contentMeta as unknown as ContentMetaRow[],
    questions: d.questions as unknown as Question[],
    tasks: d.tasks as unknown as TaskRow[],
    attempts: d.attempts as unknown as Attempt[],
    mastery: d.mastery as unknown as Mastery[],
    weeklyReports: d.weeklyReports as unknown as WeeklyReportRow[],
    aiRequests: d.aiRequests as unknown as AiRequestRow[],
  }
  data.settings.forEach((row, i) => validateSettingsRow(row, i + 1))
  data.questions.forEach((row, i) => validateQuestionRow(row, i + 1))
  data.mastery.forEach((row, i) => validateMasteryRow(row, i + 1))
  data.weeklyReports.forEach((row, i) => validateWeeklyReportRow(row, i + 1))
  data.tasks.forEach((row, i) => validateTaskRow(row, i + 1))
  data.aiRequests.forEach((row, i) => validateAiRequestRow(row, i + 1))
  data.attempts.forEach((row, i) => validateAttemptRow(row, i + 1))
  const primaryKeys: Array<[keyof BackupData, string]> = [
    ['settings', 'key'],
    ['contentMeta', 'contentId'],
    ['questions', 'id'],
    ['tasks', 'id'],
    ['attempts', 'id'],
    ['mastery', 'knowledgePointId'],
    ['weeklyReports', 'weekStart'],
    ['aiRequests', 'id'],
  ]
  for (const [table, key] of primaryKeys) {
    const seen = new Set<unknown>()
    for (const row of data[table] as unknown as Array<Record<string, unknown>>) {
      // 兜底（M1 遗留 TypeError 修复）：contentMeta 等无行校验器的表，null 行在此拒绝而非抛 TypeError
      if (!isPlainObject(row)) throw new BackupError(`备份 ${table} 表存在非对象行`)
      const id = row[key]
      if (seen.has(id)) throw new BackupError(`备份 ${table} 表存在重复主键：${String(id)}`)
      seen.add(id)
    }
  }
  // counts 归一化为实际数据长度（M1 遗留：counts 缺 key 时预览不再显示 undefined）
  const counts = Object.fromEntries(TABLE_KEYS.map((key) => [key, data[key].length])) as unknown as BackupCounts
  return { ...(file as BackupFile), counts, data }
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
  const stringFields = ['currentUnit', 'studentLabel', 'aiBaseUrl', 'aiApiKey', 'aiModel'] as const
  for (const f of stringFields) {
    if (value[f] !== undefined && typeof value[f] !== 'string') {
      throw new BackupError(`备份 settings 表第 ${line} 行 value.${f} 不是字符串`)
    }
  }
  const numberFields = ['grade', 'dailyMinutes', 'studyDaysPerWeek', 'aiDailyLimit'] as const
  for (const f of numberFields) {
    if (value[f] !== undefined && typeof value[f] !== 'number') {
      throw new BackupError(`备份 settings 表第 ${line} 行 value.${f} 不是数字`)
    }
  }
  // aiDailyLimit 语义范围（与设置页表单校验对称：1–500 整数）
  const limit = value.aiDailyLimit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)) {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.aiDailyLimit 须为 1–500 的整数`)
  }
  if (value.aiEnabled !== undefined && typeof value.aiEnabled !== 'boolean') {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.aiEnabled 不是布尔值`)
  }
  if (value.book !== undefined && value.book !== 'g7a' && value.book !== 'g7b') {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.book 只能是 g7a 或 g7b`)
  }
  if (value.parentPin !== undefined && (typeof value.parentPin !== 'string' || !PIN_PATTERN.test(value.parentPin))) {
    throw new BackupError(`备份 settings 表第 ${line} 行 value.parentPin 须为 4 位数字`)
  }
  if (value.examScores !== undefined) {
    if (!Array.isArray(value.examScores)) {
      throw new BackupError(`备份 settings 表第 ${line} 行 value.examScores 不是数组`)
    }
    value.examScores.forEach((r, i) => {
      if (!isPlainObject(r) || typeof r.label !== 'string' || typeof r.got !== 'number' || typeof r.total !== 'number'
        || !Number.isFinite(r.got) || !Number.isFinite(r.total) || r.got < 0 || r.total < 0 || r.got > r.total) {
        throw new BackupError(`备份 settings 表第 ${line} 行 value.examScores 第 ${i + 1} 行非法（label 须字符串、got/total 须有限非负数且 got ≤ total）`)
      }
    })
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

/** weeklyReports 行：weekStart/generatedAt 须为字符串；aiSuggestions 可缺省，出现即须为字符串
 *  （否则报告页 suggestionsHtml 的 trim() 抛 TypeError 卡死历史周报区）；facts 透传不校验形状（展示层判型降级） */
function validateWeeklyReportRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 weeklyReports 表第 ${line} 行不是对象`)
  if (typeof row.weekStart !== 'string' || row.weekStart === '') {
    throw new BackupError(`备份 weeklyReports 表第 ${line} 行缺少合法 weekStart`)
  }
  if (typeof row.generatedAt !== 'string') {
    throw new BackupError(`备份 weeklyReports 表第 ${line} 行 generatedAt 不是字符串`)
  }
  if (row.aiSuggestions !== undefined && typeof row.aiSuggestions !== 'string') {
    throw new BackupError(`备份 weeklyReports 表第 ${line} 行 aiSuggestions 不是字符串`)
  }
}

/** tasks 行：id/day/questionIds/minutesPlanned 形状 + type/status 枚举（v2 新表校验） */
function validateTaskRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 tasks 表第 ${line} 行不是对象`)
  if (typeof row.id !== 'string' || row.id === '') {
    throw new BackupError(`备份 tasks 表第 ${line} 行缺少合法 id`)
  }
  if (typeof row.day !== 'string' || row.day === '') {
    throw new BackupError(`备份 tasks 表第 ${line} 行缺少合法 day`)
  }
  const types = ['review', 'unit', 'special', 'summary']
  if (!types.includes(row.type as string)) {
    throw new BackupError(`备份 tasks 表第 ${line} 行 type 非法：${String(row.type)}`)
  }
  if (!Array.isArray(row.questionIds) || !row.questionIds.every((id) => typeof id === 'string')) {
    throw new BackupError(`备份 tasks 表第 ${line} 行 questionIds 不是字符串数组`)
  }
  const statuses = ['planned', 'in_progress', 'completed', 'skipped', 'deferred']
  if (!statuses.includes(row.status as string)) {
    throw new BackupError(`备份 tasks 表第 ${line} 行 status 非法：${String(row.status)}`)
  }
  if (typeof row.minutesPlanned !== 'number' || !Number.isFinite(row.minutesPlanned)) {
    throw new BackupError(`备份 tasks 表第 ${line} 行 minutesPlanned 不是数字`)
  }
}

/** aiRequests 行：id/type/status/createdAt 形状（v2 新表校验） */
function validateAiRequestRow(row: unknown, line: number): void {
  if (!isPlainObject(row)) throw new BackupError(`备份 aiRequests 表第 ${line} 行不是对象`)
  if (typeof row.id !== 'string' || row.id === '') {
    throw new BackupError(`备份 aiRequests 表第 ${line} 行缺少合法 id`)
  }
  if (typeof row.type !== 'string' || typeof row.status !== 'string') {
    throw new BackupError(`备份 aiRequests 表第 ${line} 行 type/status 不是字符串`)
  }
  if (typeof row.createdAt !== 'string') {
    throw new BackupError(`备份 aiRequests 表第 ${line} 行 createdAt 不是字符串`)
  }
  if (row.latencyMs !== undefined && typeof row.latencyMs !== 'number') {
    throw new BackupError(`备份 aiRequests 表第 ${line} 行 latencyMs 不是数字`)
  }
}

/** attempts 行：id/questionId/isCorrect/phase 形状（null 行也在此拒绝，M1 遗留 TypeError 修复） */
function validateAttemptRow(row: unknown, line: number): void {
  if (!isPlainObject(row) || !row.id || !row.questionId || typeof row.isCorrect !== 'boolean' || (row.phase !== 'first' && row.phase !== 'retry')) {
    throw new BackupError(`备份 attempts 表第 ${line} 行记录非法：${JSON.stringify(row).slice(0, 120)}`)
  }
}

export interface ImportSummary {
  attemptsAdded: number
  attemptsSkipped: number
}

/** 导入前自动安全备份的下载触发器（注入点：测试与无浏览器环境用） */
export type PreImportDownload = (file: BackupFile, fileName: string) => void

export interface ImportOptions {
  /** 缺省走浏览器下载（downloadBackupFile） */
  preImportDownload?: PreImportDownload
}

export async function importBackup(
  file: BackupFile,
  mode: 'merge' | 'overwrite',
  options: ImportOptions = {},
): Promise<ImportSummary> {
  await autoBackupBeforeImport(options.preImportDownload)
  const tasks = file.data.tasks ?? []
  const aiRequests = file.data.aiRequests ?? []
  if (mode === 'overwrite') {
    return db.transaction(
      'rw',
      [db.settings, db.contentMeta, db.questions, db.tasks, db.attempts, db.mastery, db.weeklyReports, db.aiRequests],
      async () => {
        await Promise.all([
          db.settings.clear(),
          db.contentMeta.clear(),
          db.questions.clear(),
          db.tasks.clear(),
          db.attempts.clear(),
          db.mastery.clear(),
          db.weeklyReports.clear(),
          db.aiRequests.clear(),
        ])
        await db.settings.bulkAdd(file.data.settings)
        await db.contentMeta.bulkAdd(file.data.contentMeta)
        await db.questions.bulkAdd(file.data.questions)
        await db.tasks.bulkAdd(tasks)
        await db.mastery.bulkAdd(file.data.mastery)
        await db.weeklyReports.bulkAdd(file.data.weeklyReports)
        await db.aiRequests.bulkAdd(aiRequests)
        await db.attempts.bulkAdd(file.data.attempts)
        return { attemptsAdded: file.data.attempts.length, attemptsSkipped: 0 }
      },
    )
  }
  // 合并：题目/元数据/任务/周报 upsert；attempts 与 aiRequests 只补缺失，绝不改写历史；settings 跳过已有键
  return db.transaction(
    'rw',
    [db.settings, db.contentMeta, db.questions, db.tasks, db.attempts, db.mastery, db.weeklyReports, db.aiRequests],
    async () => {
      await db.contentMeta.bulkPut(file.data.contentMeta)
      await db.questions.bulkPut(file.data.questions)
      await db.tasks.bulkPut(tasks)
      await db.mastery.bulkPut(file.data.mastery)
      await db.weeklyReports.bulkPut(file.data.weeklyReports)
      const existingKeys = await db.settings.bulkGet(file.data.settings.map((r) => r.key))
      const newSettings = file.data.settings.filter((_, i) => existingKeys[i] === undefined)
      if (newSettings.length > 0) await db.settings.bulkAdd(newSettings)
      const existingAttempts = await db.attempts.bulkGet(file.data.attempts.map((a) => a.id))
      const missing = file.data.attempts.filter((_, i) => existingAttempts[i] === undefined)
      if (missing.length > 0) await db.attempts.bulkAdd(missing)
      const existingAiRequests = await db.aiRequests.bulkGet(aiRequests.map((r) => r.id))
      const missingAiRequests = aiRequests.filter((_, i) => existingAiRequests[i] === undefined)
      if (missingAiRequests.length > 0) await db.aiRequests.bulkAdd(missingAiRequests)
      return { attemptsAdded: missing.length, attemptsSkipped: file.data.attempts.length - missing.length }
    },
  )
}

/** 导入前自动安全备份（技术债 §8.1"默认先备份"）：本地任一表有数据即先导出一份下载
 *  （文件名加 -pre-import 后缀）；失败（含用户取消下载、无浏览器环境）仅 console.warn，不阻断导入。 */
async function autoBackupBeforeImport(download: PreImportDownload | undefined): Promise<void> {
  try {
    const counts = await Promise.all(TABLE_KEYS.map((key) => db[key].count()))
    if (counts.every((c) => c === 0)) return
    const backup = await exportBackup()
    const fileName = backupFileName(new Date(), '-pre-import')
    if (download !== undefined) download(backup, fileName)
    else downloadBackupFile(backup, fileName)
  } catch (err) {
    console.warn('导入前自动备份失败（不阻断导入）：', err)
  }
}

/** 触发浏览器下载（Blob + createObjectURL）；非浏览器环境抛错，由调用方降级 */
export function downloadBackupFile(file: BackupFile, fileName: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  // 延迟 60s 撤销：WebKit/iPad Safari 中 a.click() 后立即 revoke 会中断尚未开始的 blob 下载，
  // 60s 覆盖正常下载时长；页面卸载时 blob URL 由浏览器回收，不担心泄漏
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 备份文件名：english-learning-backup-YYYYMMDD[suffix].json（suffix 如 "-pre-import"） */
export function backupFileName(date = new Date(), suffix = ''): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `english-learning-backup-${y}${m}${d}${suffix}.json`
}
