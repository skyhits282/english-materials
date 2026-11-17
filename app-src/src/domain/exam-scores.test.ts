import { describe, expect, it } from 'vitest'
import { EXAM_MAX_ROWS, parseExamRows } from './exam-scores'

const raw = (label: string, got: string, total: string) => ({ label, got, total })

describe('parseExamRows（试卷成绩表单行解析，纯函数）', () => {
  it('正常两行通过并去除首尾空白', () => {
    const r = parseExamRows([raw(' 语法 ', '12', '15'), raw('词汇', '8', '10')])
    expect(r).toEqual({ ok: true, rows: [{ label: '语法', got: 12, total: 15 }, { label: '词汇', got: 8, total: 10 }] })
  })
  it('label 留空但填了分数 → 拒绝并提示补全', () => {
    const r = parseExamRows([raw('', '12', '15')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('题型')
  })
  it('只填 label 没填分数 → 拒绝（满分缺失视为非法）', () => {
    const r = parseExamRows([raw('语法', '', '')])
    expect(r.ok).toBe(false)
  })
  it('得分 > 满分 → 拒绝', () => {
    const r = parseExamRows([raw('语法', '16', '15')])
    expect(r.ok).toBe(false)
  })
  it('总分为 0 → 拒绝', () => {
    const r = parseExamRows([raw('语法', '0', '0')])
    expect(r.ok).toBe(false)
  })
  it('全空行整体跳过；全部为空 → 没有可保存的成绩行', () => {
    const r = parseExamRows([raw('', '', ''), raw('  ', '', '')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('没有')
  })
  it('超过上限截断至 EXAM_MAX_ROWS 行', () => {
    const input = Array.from({ length: 10 }, (_, i) => raw(`题${i}`, '1', '2'))
    const r = parseExamRows(input)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rows.length).toBe(EXAM_MAX_ROWS)
      expect(r.rows.map((x) => x.label)).toEqual(Array.from({ length: EXAM_MAX_ROWS }, (_, i) => `题${i}`))
    }
  })
  it('非数字得分 → 拒绝', () => {
    const r = parseExamRows([raw('语法', 'abc', '15')])
    expect(r.ok).toBe(false)
  })
  it('得分 0 与 得分=满分 为合法边界', () => {
    const r = parseExamRows([raw('听力', '0', '10'), raw('写作', '10', '10')])
    expect(r.ok).toBe(true)
  })
})
