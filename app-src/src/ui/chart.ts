import type { DailyStat } from '../domain/trends'

/** 内联 SVG 七日柱状图：柱=每日答题数，折线叠加首测正确率（0-100%）。
 *  纯字符串模板返回 <svg>，宽高自适应容器（viewBox 700x220），零依赖。
 *  输入不含自由文本：date 为 localDayKey 产物（仅数字与连字符），其余为数值，
 *  因此本函数不做 HTML 转义；若未来接受调用方文本标签，须先经 escapeHtml 再传入。 */
export function renderTrendChart(days: DailyStat[]): string {
  const W = 700
  const H = 220
  const PAD_L = 40
  const PAD_R = 8
  const BASE = H - 30 // 柱底基线 y
  const BAR_MAX = 140 // 柱与折线共用的绘图高度（顶部留白给图例与数值标签）
  const n = Math.max(days.length, 1)
  const slot = (W - PAD_L - PAD_R) / n
  const barW = Math.min(44, slot * 0.5)
  const maxAnswered = Math.max(1, ...days.map((d) => d.answered))
  const cx = (i: number) => PAD_L + slot * (i + 0.5)

  const bars: string[] = []
  const labels: string[] = []
  const points: string[] = []
  days.forEach((d, i) => {
    const x = cx(i)
    const barH = Math.round((d.answered / maxAnswered) * BAR_MAX)
    const rateText = d.firstRate === null ? '暂无' : `${Math.round(d.firstRate * 100)}%`
    // 无数据日柱高为 0（不渲染矩形）但保留悬停 title 与日期标签
    const rect =
      d.answered === 0
        ? ''
        : `<rect x="${(x - barW / 2).toFixed(1)}" y="${(BASE - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" rx="3" fill="var(--brand)"/>` +
          `<text x="${x.toFixed(1)}" y="${BASE - barH - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${d.answered}</text>`
    bars.push(`<g><title>${d.date} · ${d.answered} 题 · 首测正确率 ${rateText}</title>${rect}</g>`)
    labels.push(
      `<text x="${x.toFixed(1)}" y="${BASE + 20}" text-anchor="middle" font-size="11" fill="var(--muted)">${d.date.slice(5)}</text>`,
    )
    if (d.firstRate !== null) points.push(`${x.toFixed(1)},${(BASE - d.firstRate * BAR_MAX).toFixed(1)}`)
  })
  // 折线只在 ≥2 个有首测数据的点时绘制（首测正确率 0-100% 映射到绘图高度）
  const line =
    points.length >= 2
      ? `<polyline points="${points.join(' ')}" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linejoin="round"/>` +
        points.map((p) => { const [px, py] = p.split(','); return `<circle cx="${px}" cy="${py}" r="3" fill="var(--ok)"/>` }).join('')
      : ''
  const legend = `<g font-size="11" fill="var(--muted)"><rect x="${PAD_L}" y="6" width="10" height="10" rx="2" fill="var(--brand)"/><text x="${PAD_L + 16}" y="15">每日题数</text><line x1="${PAD_L + 86}" y1="11" x2="${PAD_L + 112}" y2="11" stroke="var(--ok)" stroke-width="2"/><text x="${PAD_L + 118}" y="15">首测正确率</text></g>`
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近七天每日答题数与首测正确率折线图" style="width:100%;height:auto;display:block">${legend}<line x1="${PAD_L}" y1="${BASE}" x2="${W - PAD_R}" y2="${BASE}" stroke="var(--line)"/>${bars.join('')}${line}${labels.join('')}</svg>`
}
