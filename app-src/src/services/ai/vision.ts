/** 手写拍照识别任务（2026-11-19 规格 §2.2）：整页手写照片 → 按题号对齐的手写英文单词。
 *  与 tasks.ts 的 runAiTask 同款闸门/记录纪律：aiEnabled 三级检查（开关→Key→配额）、
 *  aiRequests 只记 type/status/latencyMs；照片仅进请求体，不落任何存储（红线）。
 *  与 runAiTask 的差异：不走 {raw} 降级（自由文本无法对齐题号，校验失败即 invalid-response）；
 *  默认模型为视觉模型（qwen-vl-ocr）；超时 45s。 */
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_VISION_MODEL } from '../../domain/ai-config'
import { recordAiRequest } from '../../db/repos'
import type { Settings } from '../../types'
import { createDashscopeTransport } from './dashscope'
import { checkQuota, getAiUsageToday } from './quota'
import { isGarbledText, tryParseJson, truncate } from './parse'
import { AiError, type ChatMessage, type ContentPart } from './transport'

/** 视觉识别超时（毫秒）：视觉推理显著慢于文本，不用 dashscope 默认的 20s */
export const AI_VISION_TIMEOUT_MS = 45_000
const OCR_MAX_TOKENS = 1024
/** 单词识别文本的码点截断上限（防异常超长输出污染 attempt.answer） */
const WORD_MAX_CHARS = 100
/** aiRequests 记录的请求类型（schema 不变，只是 type 字段新值） */
export const DICTATION_OCR_REQUEST_TYPE = 'dictation_ocr'

export interface RecognizedWord {
  /** 题号（1 起，与卷面序号一致） */
  index: number
  /** 识别出的手写英文单词（已裁剪空白） */
  text: string
}

export interface RecognizeDeps {
  settings: Settings
  /** 注入 fetch（测试）；缺省用全局 fetch */
  fetchImpl?: typeof fetch
  /** 注入请求超时毫秒数（测试用；缺省 AI_VISION_TIMEOUT_MS） */
  timeoutMs?: number
  /** 注入"今日"基准时刻（测试与跨日边界用） */
  now?: Date
}

export async function recognizeHandwrittenWords(
  input: { imageDataUrl: string; expectedCount: number },
  deps: RecognizeDeps,
  signal?: AbortSignal,
): Promise<RecognizedWord[]> {
  const apiKey = deps.settings.aiApiKey?.trim()
  if (deps.settings.aiEnabled === false) throw new AiError('auth', 'AI 已在设置页关闭，请到设置页开启后重试')
  if (apiKey === undefined || apiKey === '') throw new AiError('auth', '未配置 AI：请在设置页填写 API Key')
  const now = deps.now ?? new Date()
  checkQuota(deps.settings, await getAiUsageToday(now))

  const transport = createDashscopeTransport({
    baseUrl: deps.settings.aiBaseUrl?.trim() || AI_DEFAULT_BASE_URL,
    apiKey,
    model: deps.settings.aiVisionModel?.trim() || AI_DEFAULT_VISION_MODEL,
    timeoutMs: deps.timeoutMs ?? AI_VISION_TIMEOUT_MS,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  })
  const startedAt = Date.now()
  try {
    const resp = await transport.complete(
      { messages: buildMessages(input), maxTokens: OCR_MAX_TOKENS, jsonMode: true },
      signal,
    )
    const words = validateWords(resp.text, input.expectedCount)
    await recordQuietly('ok', startedAt)
    return words
  } catch (err) {
    const status = err instanceof AiError ? err.kind : signal?.aborted ? 'aborted' : 'error'
    await recordQuietly(status, startedAt)
    throw err
  }
}

/** 组装提示词：system 一段（角色+输出格式）+ user 一段（图片 + 文字指令） */
function buildMessages(input: { imageDataUrl: string; expectedCount: number }): ChatMessage[] {
  const userParts: ContentPart[] = [
    { type: 'image_url', image_url: { url: input.imageDataUrl } },
    {
      type: 'text',
      text: `照片是一页按序号手写的英语单词默写，共 ${input.expectedCount} 题（序号 1–${input.expectedCount}）。请识别每题手写的英文单词。忽略印刷体内容、中文提示与序号数字本身。无法辨认的题号不要输出对应项，不要编造未手写的内容。`,
    },
  ]
  return [
    {
      role: 'system',
      content: '你是手写英文单词识别器。只识别图片中手写的英文单词并按题号输出。只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记，格式为 {"words":[{"index":<题号>,"text":"<手写英文单词>"}]}。',
    },
    { role: 'user', content: userParts },
  ]
}

/** 响应校验：宽松 JSON 解析 → words 数组逐项过滤（index 1..N 整数、text 非空字符串、
 *  同题号重复取后出现者）；解析/结构失败一律 invalid-response（不走 raw 降级：无法对齐题号）。 */
function validateWords(text: string, expectedCount: number): RecognizedWord[] {
  if (text.trim() === '') throw new AiError('invalid-response', 'AI 返回了空内容')
  if (isGarbledText(text)) throw new AiError('invalid-response', 'AI 返回内容乱码，无法解析')
  const parsed = tryParseJson(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError('invalid-response', 'AI 未返回可解析的识别结果')
  }
  const words = (parsed as { words?: unknown }).words
  if (!Array.isArray(words)) throw new AiError('invalid-response', 'AI 识别结果缺少 words 数组')
  const byIndex = new Map<number, string>()
  for (const item of words) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const { index, text: w } = item as { index?: unknown; text?: unknown }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > expectedCount) continue
    if (typeof w !== 'string' || w.trim() === '') continue
    byIndex.set(index, truncate(w.trim(), WORD_MAX_CHARS))
  }
  return [...byIndex.entries()].map(([index, w]) => ({ index, text: w }))
}

/** 记录 aiRequests：写库失败仅告警不阻断（与 tasks.ts 同哲学） */
async function recordQuietly(status: string, startedAt: number): Promise<void> {
  try {
    await recordAiRequest(DICTATION_OCR_REQUEST_TYPE, status, Date.now() - startedAt)
  } catch (err) {
    console.warn('AI 调用记录写入失败（不阻断调用结果）：', err)
  }
}