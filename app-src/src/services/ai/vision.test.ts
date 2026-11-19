import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/schema'
import { DEFAULT_SETTINGS } from '../../db/repos'
import type { Settings } from '../../types'
import { AI_DEFAULT_VISION_MODEL } from '../../domain/ai-config'
import { recognizeHandwrittenWords, AI_VISION_TIMEOUT_MS } from './vision'
import { AiError } from './transport'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'
/** 假图片 dataURL（仅为请求体形状断言用，非真实照片） */
const DATA_URL = 'data:image/jpeg;base64,' + 'A'.repeat(64)

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  aiBaseUrl: 'https://dashscope.example/v1',
  aiApiKey: FAKE_KEY,
  aiModel: 'qwen-test',
  aiDailyLimit: 50,
  aiEnabled: true,
  ...over,
})

const calls: Array<{ url: string; init: RequestInit }> = []

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

const okContent = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const ocrContent = (words: unknown) => okContent(JSON.stringify({ words }))

/** 释放若干真实 macrotask 轮次（fake-indexeddb 的 setImmediate 队列走完） */
const flushTasks = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

const lastBody = () =>
  JSON.parse(String(calls.at(-1)?.init.body)) as {
    model?: string
    messages?: Array<{ role: string; content: unknown }>
    max_tokens?: number
  }

beforeEach(async () => {
  calls.length = 0
  await db.aiRequests.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('recognizeHandwrittenWords 成功路径', () => {
  it('裸 JSON：返回 words、aiRequests 记 ok、请求为多模态形状', async () => {
    stubFetch(async () => ocrContent([{ index: 1, text: 'apple' }, { index: 3, text: 'banana' }]))
    const words = await recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() })
    expect(words).toEqual([
      { index: 1, text: 'apple' },
      { index: 3, text: 'banana' },
    ])

    // 请求形状：默认视觉模型、max_tokens、Bearer、user 消息为 [image_url, text] 混排
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dashscope.example/v1/chat/completions')
    const body = lastBody()
    expect(body.model).toBe(AI_DEFAULT_VISION_MODEL)
    expect(body.max_tokens).toBe(1024)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    const messages = body.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(typeof messages[0]?.content).toBe('string')
    const userContent = messages[1]?.content as Array<{ type: string; image_url?: { url: string }; text?: string }>
    expect(Array.isArray(userContent)).toBe(true)
    expect(userContent[0]).toEqual({ type: 'image_url', image_url: { url: DATA_URL } })
    expect(userContent[1]?.type).toBe('text')
    expect((userContent[1]?.text ?? '').includes('3')).toBe(true)

    // aiRequests：只记 type/status，不存图片与识别文本（红线）
    const rows = await db.aiRequests.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('dictation_ocr')
    expect(rows[0]?.status).toBe('ok')
    expect(typeof rows[0]?.latencyMs).toBe('number')
    expect(JSON.stringify(rows)).not.toContain('apple')
    expect(JSON.stringify(rows)).not.toContain(DATA_URL.slice(0, 30))
  })

  it('fenced 代码块与前后噪声都能解析', async () => {
    stubFetch(async () => okContent('识别结果：\n```json\n{"words":[{"index":2,"text":"cat"}]}\n```\n以上。'))
    const words = await recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 4 }, { settings: settings() })
    expect(words).toEqual([{ index: 2, text: 'cat' }])
  })

  it('settings.aiVisionModel 覆盖默认模型', async () => {
    stubFetch(async () => ocrContent([]))
    await recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 2 }, { settings: settings({ aiVisionModel: 'qwen-vl-plus' }) })
    expect(lastBody().model).toBe('qwen-vl-plus')
  })
})

describe('recognizeHandwrittenWords 字段校验', () => {
  it('words 非数组 → invalid-response（不走 raw 降级）', async () => {
    stubFetch(async () => okContent(JSON.stringify({ words: 'nope' })))
    await expect(
      recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() }),
    ).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('index 越界丢弃、text 空或非字符串丢弃、重复 index 取后出现者', async () => {
    stubFetch(async () =>
      ocrContent([
        { index: 0, text: 'zero' }, // 越界（<1）
        { index: 1, text: 'apple' },
        { index: 4, text: 'beyond' }, // 越界（>3）
        { index: 2, text: '' }, // 空 text 丢弃
        { index: 2, text: '   ' }, // 空白 text 丢弃
        { index: 3, text: 123 }, // 非字符串丢弃
        { index: 1, text: 'apple2' }, // 重复 index 取后者
        'not-an-object', // 非对象项丢弃
      ]),
    )
    const words = await recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() })
    expect(words).toEqual([{ index: 1, text: 'apple2' }])
  })

  it('text 超长按码点截断到 100', async () => {
    const long = 'x'.repeat(150)
    stubFetch(async () => ocrContent([{ index: 1, text: long }]))
    const words = await recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 1 }, { settings: settings() })
    expect(words[0]?.text).toHaveLength(100)
  })

  it('空内容 / 乱码 / 非 JSON 可读文本 → invalid-response', async () => {
    for (const content of ['', '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008', '抱歉我无法识别这张图片。']) {
      stubFetch(async () => okContent(content))
      await expect(
        recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() }),
      ).rejects.toBeInstanceOf(AiError)
    }
  })
})

describe('recognizeHandwrittenWords 前置闸门（不发请求不计数）', () => {
  it('aiEnabled=false → auth，无 fetch、无 aiRequests', async () => {
    stubFetch(async () => ocrContent([]))
    await expect(
      recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings({ aiEnabled: false }) }),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(0)
    expect(await db.aiRequests.toArray()).toHaveLength(0)
  })

  it('未配置 Key → auth', async () => {
    stubFetch(async () => ocrContent([]))
    await expect(
      recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings({ aiApiKey: undefined }) }),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(0)
  })

  it('今日额度已满 → quota-local，无 fetch、无 aiRequests', async () => {
    await db.aiRequests.bulkAdd(
      Array.from({ length: 50 }, (_, i) => ({
        id: `pre-${i}`,
        type: 'explain_mistake',
        status: 'ok',
        createdAt: new Date().toISOString(),
      })),
    )
    stubFetch(async () => ocrContent([]))
    await expect(
      recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() }),
    ).rejects.toMatchObject({ kind: 'quota-local' })
    expect(calls).toHaveLength(0)
    // 额度检查不新增记录（仍是预置的 50 条）
    expect(await db.aiRequests.toArray()).toHaveLength(50)
  })
})

describe('recognizeHandwrittenWords 超时与取消', () => {
  it('默认超时 45s：到时 AiError(timeout)，aiRequests 记 timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    stubFetch(() => new Promise<Response>(() => {}))
    const p = recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() })
    const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(AI_VISION_TIMEOUT_MS)
    await assertion
    const rows = await db.aiRequests.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('timeout')
  })

  it('用户中止 → 原样上抛 AbortError，aiRequests 记 aborted', async () => {
    stubFetch(() => new Promise<Response>(() => {}))
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      recognizeHandwrittenWords({ imageDataUrl: DATA_URL, expectedCount: 3 }, { settings: settings() }, ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const rows = await db.aiRequests.toArray()
    expect(rows[0]?.status).toBe('aborted')
  })
})