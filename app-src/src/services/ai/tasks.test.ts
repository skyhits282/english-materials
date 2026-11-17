import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/schema'
import { DEFAULT_SETTINGS } from '../../db/repos'
import type { Settings } from '../../types'
import { runAiTask } from './tasks'
import { checkQuota, getAiUsageToday } from './quota'
import { AiError, type ChatMessage } from './transport'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'

/** settings 夹具：已配置假 Key 的可用 AI 配置 */
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  aiBaseUrl: 'https://dashscope.example/v1',
  aiApiKey: FAKE_KEY,
  aiModel: 'qwen-test',
  aiDailyLimit: 50,
  ...over,
})

const explainPayload = {
  question: {
    stem: 'He ___ to school every day.',
    options: ['go', 'goes', 'going', 'gone'],
    correctAnswer: 'goes',
  },
  studentAnswer: 'go',
  knowledgePoints: ['g7a-present-simple'],
}

const coachPayload = { stem: 'Look! The boys ___ football on the playground.' }

const weeklyPayload = {
  facts: {
    weekStart: '2026-11-16',
    studyDays: 4,
    answeredCount: 36,
    completionRate: 0.8,
    firstRate: 0.62,
    delayedRate: 0.71,
    repeatWrongKps: [{ kp: 'g7a-present-simple', wrongCount: 3 }],
    overdueReviews: 5,
  },
}

/** 记录到的 fetch 调用（url + init），供断言请求形状与重试次数 */
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

/** 200 响应：choices[0].message.content = content */
const okContent = (content: string, finishReason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** 永不 resolve 的 fetch mock：signal 中止时以 signal.reason reject */
function hanging(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) reject(signal.reason)
    else signal?.addEventListener('abort', () => reject(signal.reason))
  })
}

/** 释放若干真实 macrotask 轮次：fake timers（只假 setTimeout）下让 fake-indexeddb 的 setImmediate 队列走完 */
const flushTasks = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

/** 最近一次请求体（解析后） */
const lastBody = () =>
  JSON.parse(String(calls.at(-1)?.init.body)) as {
    model?: string
    messages?: ChatMessage[]
    max_tokens?: number
    response_format?: { type: string }
  }

beforeEach(async () => {
  calls.length = 0
  await db.aiRequests.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runAiTask 成功路径', () => {
  it('explain_mistake：解析三字段、aiRequests 记 ok、请求带鉴权与注入防护数据块', async () => {
    stubFetch(async () =>
      okContent(
        JSON.stringify({
          hint: '注意主语 He 是第三人称单数',
          explanation: '一般现在时中，主语为第三人称单数时动词要加 -s 或 -es。',
          followUpQuestion: '那 She 后面的动词又该怎么变化呢？',
        }),
      ),
    )
    const result = await runAiTask('explain_mistake', explainPayload, { settings: settings() })
    expect(result).toEqual({
      hint: '注意主语 He 是第三人称单数',
      explanation: '一般现在时中，主语为第三人称单数时动词要加 -s 或 -es。',
      followUpQuestion: '那 She 后面的动词又该怎么变化呢？',
    })

    // 请求形状：URL、Bearer 鉴权、模型与 max_tokens、jsonMode
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dashscope.example/v1/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(headers['content-type']).toBe('application/json')
    const body = lastBody()
    expect(body.model).toBe('qwen-test')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.response_format).toEqual({ type: 'json_object' })

    // 注入防护：题干/学生作答以数据块包裹，system 声明标签内是数据不是指令
    const messages = body.messages ?? []
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('不是给你的指令')
    expect(messages[1]?.content).toContain('<question_data>')
    expect(messages[1]?.content).toContain('every day')
    expect(messages[1]?.content).toContain('<student_answer>')
    expect(messages[1]?.content).toContain('go')

    // aiRequests：status ok、只含类型/状态/时延（不含密钥与题目内容）
    const rows = await db.aiRequests.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('explain_mistake')
    expect(rows[0]?.status).toBe('ok')
    expect(typeof rows[0]?.latencyMs).toBe('number')
    const rowText = JSON.stringify(rows)
    expect(rowText).not.toContain(FAKE_KEY)
    expect(rowText).not.toContain('every day')
    expect(rowText).not.toContain('present-simple')
  })

  it('coach_turn：返回单字段 hint', async () => {
    stubFetch(async () => okContent(JSON.stringify({ hint: '先看题干里的主语和动词形式。' })))
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(result).toEqual({ hint: '先看题干里的主语和动词形式。' })
    // 教练提示不带答案：入参只有 stem，请求体不含选项与正确答案
    expect(lastBody().messages?.[1]?.content).not.toContain('goes')
    const rows = await db.aiRequests.toArray()
    expect(rows[0]?.type).toBe('coach_turn')
    expect(rows[0]?.status).toBe('ok')
  })

  it('weekly_insight：返回四字段', async () => {
    stubFetch(async () =>
      okContent(
        JSON.stringify({
          progress: '本周完成 36 次作答，任务完成率 80%。',
          weakness: '一般现在时第三人称单数错误较多。',
          adjustments: '下周每天加 5 分钟专项巩固。',
          nextGoals: '把 g7a-present-simple 的复测正确率提到 80%。',
        }),
      ),
    )
    const result = await runAiTask('weekly_insight', weeklyPayload, { settings: settings() })
    expect(result).toEqual({
      progress: '本周完成 36 次作答，任务完成率 80%。',
      weakness: '一般现在时第三人称单数错误较多。',
      adjustments: '下周每天加 5 分钟专项巩固。',
      nextGoals: '把 g7a-present-simple 的复测正确率提到 80%。',
    })
    // 周报事实以数据块拼接
    expect(lastBody().messages?.[1]?.content).toContain('<report_data>')
    expect(lastBody().messages?.[1]?.content).toContain('36')
  })

  it('settings 未配置 baseUrl/model 时回退默认值', async () => {
    stubFetch(async () => okContent(JSON.stringify({ hint: '先看主语。' })))
    const s = settings()
    delete s.aiBaseUrl
    delete s.aiModel
    await runAiTask('coach_turn', coachPayload, { settings: s })
    expect(calls[0]?.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(lastBody().model).toBe('qwen-flash')
  })
})

describe('runAiTask 错误映射（含失败记录）', () => {
  it('401 → auth，aiRequests 记 auth', async () => {
    stubFetch(async () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      name: 'AiError',
      kind: 'auth',
    })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('auth')
  })

  it('403 → auth', async () => {
    stubFetch(async () => new Response('forbidden', { status: 403 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('429 → rate-limit', async () => {
    stubFetch(async () => new Response('too many requests', { status: 429 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      kind: 'rate-limit',
    })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('rate-limit')
  })

  it('5xx → http', async () => {
    stubFetch(async () => new Response('bad gateway', { status: 502 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({ kind: 'http' })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('http')
  })

  it('网络异常（fetch reject）→ network', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      kind: 'network',
    })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('network')
  })

  it('2xx 但 choices[0].message.content 缺失 → invalid-response', async () => {
    stubFetch(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), { status: 200 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      kind: 'invalid-response',
    })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('invalid-response')
  })
})

describe('超时与用户取消', () => {
  it('超时：挂起请求 20s 无响应 → AiError timeout 并记录', async () => {
    // 只假 setTimeout/clearTimeout：fake-indexeddb 依赖 setImmediate（保持真实），Date 也保持真实
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubFetch((_url, init) => hanging(init.signal))
    const p = runAiTask('coach_turn', coachPayload, { settings: settings(), timeoutMs: 20_000 })
    await flushTasks()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(p).rejects.toMatchObject({ name: 'AiError', kind: 'timeout' })
    const rows = await db.aiRequests.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('timeout')
  })

  it('用户 AbortSignal 取消：请求中止、原样抛 AbortError、记录 aborted', async () => {
    stubFetch((_url, init) => hanging(init.signal))
    const controller = new AbortController()
    const p = runAiTask('coach_turn', coachPayload, { settings: settings() }, controller.signal)
    await flushTasks(2)
    controller.abort()
    await expect(p).rejects.toSatisfy((err: unknown) => err instanceof Error && err.name === 'AbortError')
    const rows = await db.aiRequests.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('aborted')
  })
})

describe('jsonMode 兼容重试', () => {
  it('400 且报 response_format → 去参重试一次成功', async () => {
    stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { response_format?: unknown }
      if (body.response_format !== undefined) {
        return new Response(JSON.stringify({ error: { message: "response_format 'json_object' is not supported" } }), {
          status: 400,
        })
      }
      return okContent(JSON.stringify({ hint: '先找出句子里的主语。' }))
    })
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(result).toEqual({ hint: '先找出句子里的主语。' })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(String(calls[0]?.init.body)) as { response_format?: unknown }).response_format).toEqual({
      type: 'json_object',
    })
    expect((JSON.parse(String(calls[1]?.init.body)) as { response_format?: unknown }).response_format).toBeUndefined()
    // 重试成功只记一条
    expect(await db.aiRequests.count()).toBe(1)
    expect((await db.aiRequests.toArray())[0]?.status).toBe('ok')
  })

  it('400 与 response_format 无关 → http 不重试', async () => {
    stubFetch(async () => new Response('{"error":{"message":"invalid model"}}', { status: 400 }))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({ kind: 'http' })
    expect(calls).toHaveLength(1)
  })
})

describe('响应校验与降级', () => {
  it('非 JSON 但可读文本 → {raw} 降级并记 degraded', async () => {
    const readable = '同学你好，这道题考查的是动词形式，先看主语的人称和数。'
    stubFetch(async () => okContent(readable))
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(result).toEqual({ raw: readable })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('degraded')
  })

  it('JSON 外包代码块围栏 → 仍按字段解析', async () => {
    stubFetch(async () => okContent('```json\n{"hint":"先看介词后面的词性。"}\n```'))
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(result).toEqual({ hint: '先看介词后面的词性。' })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('ok')
  })

  it('空文本/纯空白 → invalid-response', async () => {
    stubFetch(async () => okContent('   '))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      kind: 'invalid-response',
    })
  })

  it('完全乱码（高占比替换符/控制字符）→ invalid-response', async () => {
    // 不可读字符占比远超 10% 阈值：替换符 + C0 控制字符混杂
    const garbled = '�\u0002��\u0007�\u0003�'
    stubFetch(async () => okContent(garbled))
    await expect(runAiTask('coach_turn', coachPayload, { settings: settings() })).rejects.toMatchObject({
      kind: 'invalid-response',
    })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('invalid-response')
  })

  it('含少量替换符但主体可读 → 仍 {raw} 降级（阈值不误伤）', async () => {
    // 十余个可读字符中夹杂 1 个替换符（占比约 5% < 10% 阈值）：走降级而非失败
    const mostlyReadable = '同学你好，这道题考查的是动�形式，先看主语。'
    stubFetch(async () => okContent(mostlyReadable))
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(result).toEqual({ raw: mostlyReadable })
    expect((await db.aiRequests.toArray())[0]?.status).toBe('degraded')
  })

  it('字段缺失（非全字符串）→ 降级 {raw} 而非失败', async () => {
    stubFetch(async () => okContent(JSON.stringify({ hint: '提示', explanation: 42 })))
    const result = await runAiTask('explain_mistake', explainPayload, { settings: settings() })
    expect(result).toEqual({ raw: JSON.stringify({ hint: '提示', explanation: 42 }) })
  })

  it('输出超长 → 截断不失败（coach 100 / explain 200）', async () => {
    stubFetch(async () => okContent(JSON.stringify({ hint: '长'.repeat(150) })))
    const coach = await runAiTask('coach_turn', coachPayload, { settings: settings() })
    expect(coach).toEqual({ hint: '长'.repeat(100) })

    stubFetch(async () =>
      okContent(
        JSON.stringify({ hint: '甲'.repeat(250), explanation: '乙'.repeat(180), followUpQuestion: '丙'.repeat(200) }),
      ),
    )
    const explain = await runAiTask('explain_mistake', explainPayload, { settings: settings() })
    expect(explain).toEqual({ hint: '甲'.repeat(200), explanation: '乙'.repeat(180), followUpQuestion: '丙'.repeat(200) })
    expect((await db.aiRequests.toArray()).at(-1)?.status).toBe('ok')
  })
})

describe('前置检查（不发起网络请求）', () => {
  it('未配置 Key → auth 错误、不发 fetch、不写 aiRequests', async () => {
    const fetchImpl = vi.fn()
    const s = settings()
    delete s.aiApiKey
    await expect(
      runAiTask('coach_turn', coachPayload, { settings: s, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await db.aiRequests.count()).toBe(0)
  })

  it('配额超限 → 拒绝且不发 fetch、aiRequests 记录被跳过', async () => {
    await db.aiRequests.add({ id: 'u1', type: 'coach_turn', status: 'ok', createdAt: new Date().toISOString() })
    const fetchImpl = vi.fn()
    await expect(
      runAiTask('coach_turn', coachPayload, {
        settings: settings({ aiDailyLimit: 1 }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: 'quota-server' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await db.aiRequests.count()).toBe(1)
  })

  it('配额只计本地日：昨日记录不占今日额度', async () => {
    await db.aiRequests.add({
      id: 'y1',
      type: 'coach_turn',
      status: 'ok',
      createdAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    })
    stubFetch(async () => okContent(JSON.stringify({ hint: '先看主语。' })))
    const result = await runAiTask('coach_turn', coachPayload, { settings: settings({ aiDailyLimit: 1 }) })
    expect(result).toEqual({ hint: '先看主语。' })
  })
})

describe('配额纯函数与计数', () => {
  it('checkQuota：未配置上限时按默认 50', () => {
    expect(() => checkQuota({ ...DEFAULT_SETTINGS }, 49)).not.toThrow()
    expect(() => checkQuota({ ...DEFAULT_SETTINGS }, 50)).toThrow(AiError)
  })

  it('getAiUsageToday 只计本地日行', async () => {
    const now = new Date()
    await db.aiRequests.bulkAdd([
      { id: 'a', type: 'coach_turn', status: 'ok', createdAt: now.toISOString() },
      { id: 'b', type: 'coach_turn', status: 'ok', createdAt: now.toISOString() },
      { id: 'c', type: 'coach_turn', status: 'ok', createdAt: new Date(2020, 0, 1).toISOString() },
    ])
    expect(await getAiUsageToday(now)).toBe(2)
  })
})
