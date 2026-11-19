/** 识别词表 → 逐题对齐（2026-11-19 规格 §1.3，纯函数）：
 *  返回长度 expectedCount 的数组，第 i 项对应卷面题号 i+1；
 *  text 为识别文本或 null（缺失/无法辨认 → 未作答语义，页面按 gaveUp 提交）。
 *  越界序号忽略、同题号重复取后出现者（vision.ts 已校验，此处兜底防御）。 */
export interface AlignedAnswer {
  index: number
  text: string | null
}

export function alignRecognizedWords(expectedCount: number, words: { index: number; text: string }[]): AlignedAnswer[] {
  const byIndex = new Map<number, string>()
  for (const w of words) {
    if (!Number.isInteger(w.index) || w.index < 1 || w.index > expectedCount) continue
    byIndex.set(w.index, w.text)
  }
  return Array.from({ length: expectedCount }, (_, i) => ({ index: i + 1, text: byIndex.get(i + 1) ?? null }))
}