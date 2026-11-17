/** 阿里云百炼（OpenAI 兼容模式）直连 transport：浏览器本地 fetch，不经任何后端中转。
 *  红线：apiKey 只进请求头（authorization: Bearer），不得写入日志/aiRequests/备份。 */
import { AiError, type AiTransport, type TransportRequest, type TransportResponse } from './transport'

/** 默认超时 20s：讲解/洞察类请求在云端模型上的合理上限 */
export const DASHSCOPE_DEFAULT_TIMEOUT_MS = 20_000

export interface DashscopeConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 缺省 20s */
  timeoutMs?: number
  /** 注入 fetch（测试）；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch
}

/** 创建百炼直连 transport：POST {baseUrl}/chat/completions */
export function createDashscopeTransport(cfg: DashscopeConfig): AiTransport {
  const doFetch = cfg.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const timeoutMs = cfg.timeoutMs ?? DASHSCOPE_DEFAULT_TIMEOUT_MS
  // 用户配置的 baseUrl 末尾多余的斜杠不影响拼接
  const url = `${cfg.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(req: TransportRequest, signal?: AbortSignal): Promise<TransportResponse> {
      let jsonMode = req.jsonMode === true
      // 至多两次：jsonMode 下服务端不支持 response_format（部分兼容端点）→ 去参原样重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetchWithTimeout(doFetch, url, buildInit(cfg, req, jsonMode), timeoutMs, signal)
        if (res.ok) return await parseSuccessResponse(res)
        const status = res.status
        const bodyText = await readText(res)
        if (jsonMode && status === 400 && /response_format/i.test(bodyText)) {
          jsonMode = false
          continue
        }
        throw mapHttpError(status, bodyText)
      }
      // 防御：循环正常只在重试一次后返回或抛出，不会走到这里
      throw new AiError('http', 'AI 请求失败（重试后仍未成功）')
    },
  }
}

function buildInit(cfg: DashscopeConfig, req: TransportRequest, jsonMode: boolean): RequestInit {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 带超时与用户取消的 fetch：
 *  超时→AiError('timeout')；用户取消→原样抛出（调用方以 signal.aborted 识别）；其他异常→AiError('network')。 */
async function fetchWithTimeout(
  doFetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeoutController = new AbortController()
  let timedOut = false
  const onTimeoutAbort = () => {
    timedOut = true
  }
  timeoutController.signal.addEventListener('abort', onTimeoutAbort)
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  // AbortSignal.any 需较新浏览器（Chrome 116+ / Safari 17.4+）；本项目无旧浏览器目标，TS DOM lib 已含该类型
  const combined =
    signal !== undefined ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  try {
    return await doFetch(url, { ...init, signal: combined })
  } catch (err) {
    if (timedOut) throw new AiError('timeout', `AI 请求超时（${timeoutMs}ms），请稍后重试`)
    if (signal?.aborted) throw err // 用户主动取消（reason 可能是任意值，原样上抛）
    throw new AiError('network', `网络请求失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
    timeoutController.signal.removeEventListener('abort', onTimeoutAbort)
  }
}

/** 2xx 响应解析：choices[0].message.content 缺失 → invalid-response */
async function parseSuccessResponse(res: Response): Promise<TransportResponse> {
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new AiError('invalid-response', 'AI 响应不是有效 JSON')
  }
  const choices = (json as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiError('invalid-response', 'AI 响应缺少 choices')
  }
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined
  const content = first?.message?.content
  if (typeof content !== 'string') {
    throw new AiError('invalid-response', 'AI 响应缺少 message.content')
  }
  return { text: content, finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : '' }
}

/** 错误状态映射：401/403→auth；429→rate-limit；其余（含 5xx）→http（附响应体片段） */
function mapHttpError(status: number, bodyText: string): AiError {
  if (status === 401 || status === 403) return new AiError('auth', `API Key 无效或无权限（HTTP ${status}）`)
  if (status === 429) return new AiError('rate-limit', '请求过于频繁（429），请稍后再试')
  return new AiError('http', `服务端错误（HTTP ${status}）：${bodyText.slice(0, 200)}`)
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
