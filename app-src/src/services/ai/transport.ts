/** AI 调用传输层接口（M3 规格 §7.2）：tasks 层只依赖本接口，不绑定具体服务商实现。
 *  本模块为纯类型与错误定义，不做任何 IO。 */

export type AiErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  /** 本地每日调用上限（checkQuota）：UI 文案须明确"本地上限"语义，避免学生误以为是服务端问题。
   *  服务端限流/配额类错误（HTTP 429）归 'rate-limit'，两者不共用 kind。 */
  | 'quota-local'
  | 'rate-limit'
  | 'invalid-response'
  | 'http'

/** 聊天消息：system 一段 + user 一段（提示词由 tasks 层组装） */
export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface TransportRequest {
  messages: ChatMessage[]
  maxTokens: number
  /** 要求模型只输出 JSON（OpenAI 兼容 response_format=json_object） */
  jsonMode?: boolean
}

export interface TransportResponse {
  text: string
  finishReason: string
}

export interface AiTransport {
  complete(req: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>
}

/** AI 层统一错误：kind 供 UI 分类提示与 aiRequests 状态记录 */
export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/** 是否用户主动取消（AbortError）：区别于超时——超时在 transport 层已被映射为 kind 'timeout' */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
