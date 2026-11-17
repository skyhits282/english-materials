import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/schema'
import { DEFAULT_SETTINGS } from '../../db/repos'
import type { Settings } from '../../types'
import { AI_TEST_TIMEOUT_MS, testConnection } from './connection'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'

/** settings 夹具：已配置假 Key 且开关打开的可用 AI 配置 */
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  aiBaseUrl: 'https://dashscope.example/v1',
  aiApiKey: FAKE_KEY,
  aiModel: 'qwen-test',
  aiDailyLimit: 50,
  aiEnabled: true,
  ...over,
})

/** 记录到的 fetch 调用（url + init），供断言请求形状 */
const calls: Array<{ url: string; init: RequestInit }> = []

/** mock fetch：包装成 transport 调用形状（POST url + init） */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const merged = init ?? {}
      calls.push({ url, init: merged })
      return handler(url, merged)
    }) as unknown as typeof fetch,
  )
}

/** 200 响应：choices[0].message.content = content（探活只要求可解析的 2xx） */
const okContent = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'length' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** 释放若干真实 macrotask 轮次：fake timers（只假 setTimeout）下让微任务与监听回调走完 */
const flushTasks = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

beforeEach(async () => {
  calls.length = 0
  await db.aiRequests.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('testConnection 成功路径', () => {
  it('成功：返回实际使用的模型（裁剪空白/缺省回退）；请求带鉴权、max_tokens=1、单条 ping、无 jsonMode', async () => {
    stubFetch(async () => okContent(''))
    const result = await testConnection(settings({ aiModel: '  qwen-pro  ' }))
    expect(result).toEqual({ model: 'qwen-pro' })

    // 请求形状：探活只发一条最小 chat 请求
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dashscope.example/v1/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model?: string
      messages?: Array<{ role: string; content: string }>
      max_tokens?: number
      response_format?: { type: string }
    }
    expect(body.model).toBe('qwen-pro')
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(body.max_tokens).toBe(1)
    expect(body.response_format).toBeUndefined()
  })

  it('探活不写 aiRequests（不计配额、不进统计）', async () => {
    stubFetch(async () => okContent(''))
    await testConnection(settings())
    expect(await db.aiRequests.count()).toBe(0)
  })

  it('模型名留空 → 回退默认模型 qwen-flash', async () => {
    stubFetch(async () => okContent(''))
    const result = await testConnection(settings({ aiModel: '  ' }))
    expect(result).toEqual({ model: 'qwen-flash' })
  })
})

describe('testConnection 失败分类', () => {
  it('401 → AiError auth', async () => {
    stubFetch(async () => new Response('{"error":"invalid api key"}', { status: 401 }))
    await expect(testConnection(settings())).rejects.toMatchObject({ name: 'AiError', kind: 'auth' })
  })

  it('网络失败（fetch 抛错）→ AiError network', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(testConnection(settings())).rejects.toMatchObject({ name: 'AiError', kind: 'network' })
  })

  it('超时：挂起请求到默认 10s（AI_TEST_TIMEOUT_MS）拒绝 timeout；提前 1ms 仍挂起', async () => {
    // 只假 setTimeout/clearTimeout：探活路径无 fake-indexeddb 写入，setImmediate 保持真实即可
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const p = testConnection(settings())
    await flushTasks()
    await vi.advanceTimersByTimeAsync(AI_TEST_TIMEOUT_MS - 1)
    const settledEarly = await Promise.race([p.then(() => true, () => true), Promise.resolve(false)])
    expect(settledEarly).toBe(false) // 10s 前一毫秒仍未超时
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toMatchObject({ name: 'AiError', kind: 'timeout' })
  })
})

describe('testConnection 前置拒绝（同 runAiTask 口径）', () => {
  it('aiEnabled=false → auth 拒绝且不发任何请求', async () => {
    stubFetch(async () => okContent(''))
    await expect(testConnection(settings({ aiEnabled: false }))).rejects.toMatchObject({
      name: 'AiError',
      kind: 'auth',
    })
    expect(calls).toHaveLength(0)
  })

  it('未配置密钥 → auth 拒绝且不发任何请求', async () => {
    stubFetch(async () => okContent(''))
    await expect(testConnection(settings({ aiApiKey: '   ' }))).rejects.toMatchObject({
      name: 'AiError',
      kind: 'auth',
    })
    expect(calls).toHaveLength(0)
  })
})
