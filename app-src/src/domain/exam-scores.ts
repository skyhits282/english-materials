import type { ExamScoreRow } from '../types'

/** 试卷分项成绩行数上限（最近两次试卷合计，规格 §4） */
export const EXAM_MAX_ROWS = 8

/** 表单原始行：三个字段均为未清洗的字符串 */
export interface RawExamRow {
  label: string
  got: string
  total: string
}

export type ParsedExamRows =
  | { ok: true; rows: ExamScoreRow[] }
  | { ok: false; message: string }

/** 试卷成绩表单行解析（纯函数）：全空行视为留白跳过；其余行须题型非空且
 *  0 ≤ 得分 ≤ 满分、满分 > 0。通过后最多保留前 EXAM_MAX_ROWS 行——UI 已限制加行，
 *  此处截断兜底"旧库超限数据回填后再保存"的场景。 */
export function parseExamRows(raw: RawExamRow[]): ParsedExamRows {
  const filled = raw.filter((r) => r.label.trim() !== '' || r.got.trim() !== '' || r.total.trim() !== '')
  const rows: ExamScoreRow[] = []
  for (const r of filled) {
    const label = r.label.trim()
    if (label === '') return { ok: false, message: '已填行请补全题型名称。' }
    const got = Number(r.got)
    const total = Number(r.total)
    if (!Number.isFinite(got) || !Number.isFinite(total) || total <= 0 || got < 0 || got > total) {
      return { ok: false, message: '每行须满足 0 ≤ 得分 ≤ 满分 且 满分 > 0。' }
    }
    rows.push({ label, got, total })
  }
  if (rows.length === 0) return { ok: false, message: '没有可保存的成绩行。' }
  rows.length = Math.min(rows.length, EXAM_MAX_ROWS)
  return { ok: true, rows }
}
