/** 设置页「测试连接」探活（M3 规格 §7.1）：发一条最小 chat 请求（max_tokens=1）验证连通与密钥。
 *  失败形态与 runAiTask 一致：抛 AiError，由 UI 接 aiErrorText 分类提示。
 *  探活是家长侧诊断行为而非学生用 AI：不写 aiRequests、不查不记配额（探活不计配额）。 */
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL } from '../../domain/ai-config'
import type { Settings } from '../../types'
import { createDashscopeTransport } from './dashscope'
import { AiError } from './transport'

/** 探活默认超时 10s：只需确认连通与密钥有效，不必等讲解类请求的 20s 上限 */
export const AI_TEST_TIMEOUT_MS = 10_000

export interface TestConnectionDeps {
  /** 注入 fetch（测试）；缺省用全局 fetch */
  fetchImpl?: typeof fetch
  /** 注入超时毫秒数（测试用；缺省 10s） */
  timeoutMs?: number
}

export interface TestConnectionResult {
  /** 探活成功时实际使用的模型名（成功文案「连通 ✓ 模型 <name>」用） */
  model: string
}

/** 探活：成功返回实际使用的模型；失败抛 AiError（network/timeout/auth/rate-limit/invalid-response/http） */
export async function testConnection(
  settings: Settings,
  deps: TestConnectionDeps = {},
): Promise<TestConnectionResult> {
  const apiKey = settings.aiApiKey?.trim()
  // 家长总开关与未配置密钥：口径同 runAiTask（先于一切判定，不发请求、不计数）
  if (settings.aiEnabled === false) throw new AiError('auth', 'AI 已在设置页关闭，请到设置页开启后重试')
  if (apiKey === undefined || apiKey === '') throw new AiError('auth', '未配置 AI：请填写 API Key')
  const model = settings.aiModel?.trim() || AI_DEFAULT_MODEL
  const transport = createDashscopeTransport({
    baseUrl: settings.aiBaseUrl?.trim() || AI_DEFAULT_BASE_URL,
    apiKey,
    model,
    // 探活不必等 20s：较短超时让"密钥/网络不通"的反馈更快到达
    timeoutMs: deps.timeoutMs ?? AI_TEST_TIMEOUT_MS,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  })
  // 最小请求：单条 user 'ping'、max_tokens=1、无 jsonMode；不落 aiRequests（探活不计配额）
  await transport.complete({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 })
  return { model }
}
