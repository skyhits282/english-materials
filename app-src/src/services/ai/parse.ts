/** AI 响应宽松解析与文本工具（tasks.ts / vision.ts 共用）：纯函数，无 IO。 */

/** 乱码启发式（无法完美定义"乱码"）：统计不可读字符占比，超过 10% 视为乱码。
 *  不可读 = 控制字符 U+0000–U+001F（除 \t\n\r）、C1 控制区 U+007F–U+009F、Unicode 替换符 U+FFFD。
 *  取保守阈值：普通带标点中文/英文/代码围栏文本不受影响；少量替换符（如编码丢字）仍按可读降级。 */
export function isGarbledText(text: string): boolean {
  if (text.length === 0) return false
  let unreadable = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isControl = (code >= 0x00 && code <= 0x1f && ch !== '\t' && ch !== '\n' && ch !== '\r') || (code >= 0x7f && code <= 0x9f)
    if (isControl || code === 0xfffd) unreadable += 1
  }
  return unreadable / text.length > 0.1
}

/** 宽松 JSON 提取：原文、去代码块围栏、首个 { 到最后一个 } 的子串，依次尝试解析 */
export function tryParseJson(text: string): unknown {
  const candidates: string[] = []
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())
  if (fenced?.[1] !== undefined) candidates.push(fenced[1])
  candidates.push(text)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}

/** 按码点截断（避免从代理对中间切断出乱码） */
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}
