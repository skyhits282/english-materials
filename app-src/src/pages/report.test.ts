import { describe, expect, it } from 'vitest'
import { suggestionsHtml } from './report'

/** 周报 AI 建议渲染（suggestionsHtml）：历史存档内容一律视为不可信（备份可注入任意形状），判型后渲染并转义 */
describe('suggestionsHtml', () => {
  it('四字段 JSON → 四段面板', () => {
    const html = suggestionsHtml(JSON.stringify({ progress: 'p', weakness: 'w', adjustments: 'a', nextGoals: 'n' }))
    expect(html).toContain('本周进步')
    expect(html).toContain('重点短板')
    expect(html).toContain('任务调整建议')
    expect(html).toContain('下周目标')
    expect(html).toContain('<p>p</p>')
  })

  it('{raw} 降级 → 单段纯文本', () => {
    const html = suggestionsHtml('{"raw":"建议文本"}')
    expect(html).toContain('AI 建议')
    expect(html).toContain('建议文本')
    expect(html).not.toContain('本周进步')
  })

  it('非 JSON 纯文本 → 单段展示', () => {
    const html = suggestionsHtml('历史版本存档的纯文本建议')
    expect(html).toContain('历史版本存档的纯文本建议')
  })

  it('字段内容含 HTML → escapeHtml 转义（不信任模型输出）', () => {
    const html = suggestionsHtml(JSON.stringify({ raw: '<img src=x onerror=alert(1)>' }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('undefined / 空白字符串 → 空串', () => {
    expect(suggestionsHtml(undefined)).toBe('')
    expect(suggestionsHtml('')).toBe('')
    expect(suggestionsHtml('   ')).toBe('')
  })

  it('备份注入的非字符串（数字/对象/null）→ 空串不抛 TypeError（历史周报区不卡死）', () => {
    expect(() => suggestionsHtml(123)).not.toThrow()
    expect(suggestionsHtml(123)).toBe('')
    expect(suggestionsHtml({ progress: 'p' })).toBe('')
    expect(suggestionsHtml(null)).toBe('')
    expect(suggestionsHtml(['x'])).toBe('')
  })
})
