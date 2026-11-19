# 单词默写 · 手写拍照识别 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单词默写支持纸上手写整页后拍照上传，经百炼多模态模型识别，直接判分并按现有口径记录 attempts/mastery/任务状态。

**Architecture:** 方案 A——`#/exercise?vocab=u1` 入口加模式选择卡；新模块 `pages/vocab-photo.ts` 承载「卷面 / 识别 / 结果」三屏；识别任务 `services/ai/vision.ts` 复用 tasks 层闸门/记录纪律与宽松 JSON 解析；`TransportRequest` 消息类型放宽为多模态（text + image_url）；判分与记录复用 `PracticeSession`（经新抽取的 `pages/session-setup.ts` 与键盘流共用）。

**Tech Stack:** Vite + TypeScript 原生（无框架）、Vitest + fake-indexeddb、Dexie、阿里云百炼 OpenAI 兼容模式（qwen-vl-ocr）。

**上游规格：** `docs/superpowers/specs/2026-11-19-vocab-photo-dictation-design.md`

**安全红线（每个任务都必须遵守）：**
- 任何 API Key 真实值绝不能写入任何文件、代码、测试、文档或提交。测试一律用假 Key 字符串 `'sk-test-fake-key-0000'`。
- 照片仅进识别请求体：不落 IndexedDB、不进 aiRequests（该表只存 type/status/latencyMs）、不进备份、不写日志。
- aiRequests 表结构与 Dexie schema version(1) 不动（新任务类型只是 type 字段的新字符串值）。

**常用命令（仓库根执行）：**
- 全量测试：`npm run test:app`（= `npm --prefix app-src run test`，vitest run）
- 单文件测试：`npm --prefix app-src run test -- src/services/ai/vision.test.ts`
- 类型检查 + 构建：`npm --prefix app-src run build`（`tsc --noEmit && vite build`；产物仅 `app/`）

---

### Task 1: Settings 增加 aiVisionModel（类型 + 校验 + 设置页表单）

**Files:**
- Modify: `app-src/src/types.ts`（Settings 接口）
- Modify: `app-src/src/domain/ai-config.ts`（默认常量 + 表单校验）
- Modify: `app-src/src/domain/ai-config.test.ts`（新用例 + 现有夹具补字段）
- Modify: `app-src/src/pages/settings.ts`（AI 配置卡表单）

- [x] **Step 1: 写失败测试（现有夹具补 `visionModel` 字段 + 新用例）**

在 `app-src/src/domain/ai-config.test.ts` 中，所有传给 `parseAiConfigForm` 的原始表单对象字面量统一补上 `visionModel: ''`（TS 会先报错——`RawAiConfigForm` 还没有该字段，这正是失败信号）。然后追加：

```ts
describe('aiVisionModel（手写识别模型，可选）', () => {
  const base = { baseUrl: 'https://dashscope.example/v1', apiKey: '', model: 'qwen-test', dailyLimit: '50' }

  it('留空 → 不写入 aiVisionModel（用默认 qwen-vl-ocr）', () => {
    const parsed = parseAiConfigForm({ ...base, visionModel: '' }, undefined)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.aiVisionModel).toBeUndefined()
  })

  it('非空 → 裁剪后保存', () => {
    const parsed = parseAiConfigForm({ ...base, visionModel: '  qwen-vl-plus  ' }, undefined)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.aiVisionModel).toBe('qwen-vl-plus')
  })

  it('默认视觉模型常量为 qwen-vl-ocr', () => {
    expect(AI_DEFAULT_VISION_MODEL).toBe('qwen-vl-ocr')
  })
})
```

测试文件顶部 import 补充 `AI_DEFAULT_VISION_MODEL`。

- [x] **Step 2: 跑测试确认失败**

Run: `npm --prefix app-src run test -- src/domain/ai-config.test.ts`
Expected: FAIL（`visionModel` 不在 `RawAiConfigForm` 类型上 / `AI_DEFAULT_VISION_MODEL` 未导出）

- [x] **Step 3: 实现**

`app-src/src/types.ts` Settings 接口，在 `aiModel?: string` 之后加：

```ts
  /** 手写拍照识别用多模态模型（qwen-vl-ocr 等）：缺省用 AI_DEFAULT_VISION_MODEL。
   *  非凭证字段，备份导出不剔除（与 aiModel 同待遇）。 */
  aiVisionModel?: string
```

`app-src/src/domain/ai-config.ts`：

```ts
/** 默认视觉识别模型（百炼多模态；手写拍照默写用） */
export const AI_DEFAULT_VISION_MODEL = 'qwen-vl-ocr'
```

`RawAiConfigForm` 增加字段：

```ts
export interface RawAiConfigForm {
  baseUrl: string
  apiKey: string
  model: string
  /** 手写识别模型：留空 = 用默认（不写入 settings） */
  visionModel: string
  dailyLimit: string
}
```

`AiConfigValue` 增加可选字段：

```ts
export interface AiConfigValue {
  aiBaseUrl: string
  aiApiKey?: string
  aiModel: string
  /** 留空时缺省（undefined → 用 AI_DEFAULT_VISION_MODEL） */
  aiVisionModel?: string
  aiDailyLimit: number
}
```

`parseAiConfigForm` 返回值中（`aiModel` 行之后）增加条件展开：

```ts
      aiModel: model,
      ...(visionModel !== '' ? { aiVisionModel: visionModel } : {}),
      aiDailyLimit: dailyLimit,
```

并在函数体内 `const model = raw.model.trim()` 之后加：

```ts
  const visionModel = raw.visionModel.trim()
```

`app-src/src/pages/settings.ts`：
1. import 行补 `AI_DEFAULT_VISION_MODEL`（来自 `../domain/ai-config`）。
2. AI 配置卡 HTML 中「模型名」form-row 之后加：

```html
      <div class="form-row">
        <label for="ai-vision-model">手写识别模型（留空用默认 ${AI_DEFAULT_VISION_MODEL}）</label>
        <input id="ai-vision-model" type="text" value="${escapeHtml(settings.aiVisionModel ?? '')}" placeholder="${AI_DEFAULT_VISION_MODEL}">
      </div>
```

3. `readForm()` 返回对象补：

```ts
    visionModel: container.querySelector<HTMLInputElement>('#ai-vision-model')?.value ?? '',
```

4. `setupAiConfigCard` 的 `refresh()` 中补：

```ts
      const visionModel = container.querySelector<HTMLInputElement>('#ai-vision-model')
      if (visionModel) visionModel.value = current().aiVisionModel ?? ''
```

- [x] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npm --prefix app-src run test -- src/domain/ai-config.test.ts` → PASS
Run: `npm run test:app` → 全绿（settings.ts 改动由 tsc 覆盖）
Run: `npm --prefix app-src run build` → tsc 无错

- [x] **Step 5: Commit**

```bash
git add app-src/src/types.ts app-src/src/domain/ai-config.ts app-src/src/domain/ai-config.test.ts app-src/src/pages/settings.ts
git commit -m "feat(app): 设置增加可选手写识别模型 aiVisionModel（默认 qwen-vl-ocr）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 抽取共享解析助手 `services/ai/parse.ts`（纯重构）

tasks.ts 私有的 `isGarbledText` / `tryParseJson` / `truncate` 三个纯函数是通用响应解析助手，vision.ts（Task 3）要复用。先无行为抽取，测试保持全绿。

**Files:**
- Create: `app-src/src/services/ai/parse.ts`
- Modify: `app-src/src/services/ai/tasks.ts`

- [x] **Step 1: 创建 `parse.ts`（函数体从 tasks.ts 原样搬移，连同各自注释）**

```ts
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
```

- [x] **Step 2: tasks.ts 删除这三个函数定义，顶部加 import**

```ts
import { isGarbledText, tryParseJson, truncate } from './parse'
```

搬移后 tasks.ts 其余代码零改动（函数签名与行为不变）。先确认无其他文件引用这些名字：

Run: `grep -rn "isGarbledText\|tryParseJson\|truncate" app-src/src --include='*.ts' | grep -v "tasks.ts\|parse.ts"`
Expected: 无输出（仅 tasks.ts 内部使用）

- [x] **Step 3: 全量测试确认零行为漂移**

Run: `npm run test:app` → 全绿
Run: `npm --prefix app-src run build` → tsc 无错

- [x] **Step 4: Commit**

```bash
git add app-src/src/services/ai/parse.ts app-src/src/services/ai/tasks.ts
git commit -m "refactor(app): 抽取 AI 响应解析纯函数到 parse.ts（tasks/vision 共用）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: transport 多模态类型 + `services/ai/vision.ts` 识别任务

**Files:**
- Modify: `app-src/src/services/ai/transport.ts`（ChatMessage.content 放宽）
- Create: `app-src/src/services/ai/vision.ts`
- Create: `app-src/src/services/ai/vision.test.ts`

- [x] **Step 1: 写失败测试 `vision.test.ts`**

```ts
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
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm --prefix app-src run test -- src/services/ai/vision.test.ts`
Expected: FAIL（`./vision` 模块不存在）

- [x] **Step 3: 实现 transport 类型放宽 + vision.ts**

`app-src/src/services/ai/transport.ts`：`ChatMessage` 定义改为（`ChatMessage` 接口上方加 ContentPart）：

```ts
/** 多模态消息分段：纯文本或图片（dataURL）；content 为 string 时等价于单个 text part */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 聊天消息：system 一段 + user 一段（提示词由 tasks 层组装） */
export interface ChatMessage {
  role: 'system' | 'user'
  content: string | ContentPart[]
}
```

dashscope.ts 的 `buildInit` 不需要改（messages 原样进请求体）。

`app-src/src/services/ai/vision.ts` 全文：

```ts
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
```

（「index 越界丢弃…」用例的期望 `[{ index: 1, text: 'apple2' }]`：index 2 两个候选 text 均空被丢弃、index 3 的 text 非字符串被丢弃、index 1 重复取后者。）

- [x] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npm --prefix app-src run test -- src/services/ai/vision.test.ts` → PASS
Run: `npm run test:app` → 全绿
Run: `npm --prefix app-src run build` → tsc 无错

- [x] **Step 5: Commit**

```bash
git add app-src/src/services/ai/transport.ts app-src/src/services/ai/vision.ts app-src/src/services/ai/vision.test.ts
git commit -m "feat(app): AI 传输层支持多模态消息；新增手写照片识别任务 vision.ts

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `utils/image.ts` 手写照片客户端压缩

**Files:**
- Create: `app-src/src/utils/image.ts`
- Create: `app-src/src/utils/image.test.ts`

- [x] **Step 1: 写失败测试 `image.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { computeTargetSize, dataUrlByteSize, IMAGE_MAX_BYTES, IMAGE_TARGET_LONG_EDGE } from './image'

describe('computeTargetSize（目标尺寸，纯函数）', () => {
  it('长边超限 → 等比缩放到长边上限', () => {
    expect(computeTargetSize(4000, 3000)).toEqual({ width: 1280, height: 960 })
    expect(computeTargetSize(3000, 4000)).toEqual({ width: 960, height: 1280 })
  })
  it('长边等于上限 → 不缩放（null）', () => {
    expect(computeTargetSize(1280, 720)).toBeNull()
  })
  it('小图 → 不放大（null）', () => {
    expect(computeTargetSize(800, 600)).toBeNull()
    expect(computeTargetSize(1281, 1)).toEqual({ width: 1280, height: 1 })
  })
})

describe('dataUrlByteSize（体积近似）', () => {
  it('base64 长度 × 3/4 近似原始字节（含前缀）', () => {
    const url = 'data:image/jpeg;base64,' + 'QUJD'.repeat(10) // 40 个 base64 字符 → 30 字节
    expect(dataUrlByteSize(url)).toBe(30)
  })
  it('上限常量为 3MB', () => {
    expect(IMAGE_MAX_BYTES).toBe(3 * 1024 * 1024)
  })
  it('长边上限常量为 1280', () => {
    expect(IMAGE_TARGET_LONG_EDGE).toBe(1280)
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm --prefix app-src run test -- src/utils/image.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 `image.ts`**

```ts
/** 手写照片客户端预处理（2026-11-19 规格 §2.3）：canvas 压缩（长边上限、JPEG）→ dataURL。
 *  纯函数（computeTargetSize / dataUrlByteSize）单测覆盖；canvas 编码路径依赖浏览器，浏览器终验覆盖。 */

/** 压缩目标长边（px）：百炼视觉输入的合理分辨率上限 */
export const IMAGE_TARGET_LONG_EDGE = 1280
/** JPEG 编码质量 */
export const IMAGE_JPEG_QUALITY = 0.85
/** 压缩后体积上限（字节，原始字节近似）：超限提示重拍 */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

/** 目标尺寸：长边超限 → 等比缩小到长边上限；小图不放大；null = 无需缩放 */
export function computeTargetSize(width: number, height: number): { width: number; height: number } | null {
  const longEdge = Math.max(width, height)
  if (longEdge <= IMAGE_TARGET_LONG_EDGE) return null
  const scale = IMAGE_TARGET_LONG_EDGE / longEdge
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** dataURL 字节量近似（base64 部分长度 × 3/4）：体积上限判定用 */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((base64.length * 3) / 4)
}

/** 图片文件 → 压缩 JPEG dataURL。失败（非图片/解码失败/超限）抛中文 Error，由页面展示。 */
export async function compressImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。')
  const dataUrl = await readAsDataUrl(file)
  const img = await loadImage(dataUrl)
  const target = computeTargetSize(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = target?.width ?? img.naturalWidth
  canvas.height = target?.height ?? img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('图片处理失败，请重试。')
  // 透明 PNG 拍照场景不会出现，但兜底铺白底，避免 JPEG 把透明区编码成黑色
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const out = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY)
  if (dataUrlByteSize(out) > IMAGE_MAX_BYTES) throw new Error('图片过大，请离近一些、只拍纸面后重试。')
  return out
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败，请重选。'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，请重选。'))
    img.src = dataUrl
  })
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npm --prefix app-src run test -- src/utils/image.test.ts` → PASS
Run: `npm --prefix app-src run build` → tsc 无错（canvas 路径仅类型检查）

- [x] **Step 5: Commit**

```bash
git add app-src/src/utils/image.ts app-src/src/utils/image.test.ts
git commit -m "feat(app): 手写照片客户端压缩（长边 1280/JPEG 0.85/3MB 上限）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `domain/dictation-align.ts` 识别词表对齐（纯函数）

**Files:**
- Create: `app-src/src/domain/dictation-align.ts`
- Create: `app-src/src/domain/dictation-align.test.ts`

- [x] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { alignRecognizedWords } from './dictation-align'

describe('alignRecognizedWords（识别词表 → 逐题对齐）', () => {
  it('全部命中：按题号填入文本', () => {
    const aligned = alignRecognizedWords(3, [
      { index: 1, text: 'apple' },
      { index: 2, text: 'bag' },
      { index: 3, text: 'cat' },
    ])
    expect(aligned).toEqual([
      { index: 1, text: 'apple' },
      { index: 2, text: 'bag' },
      { index: 3, text: 'cat' },
    ])
  })

  it('缺失序号 → null（未作答语义）', () => {
    const aligned = alignRecognizedWords(3, [{ index: 2, text: 'bag' }])
    expect(aligned).toEqual([
      { index: 1, text: null },
      { index: 2, text: 'bag' },
      { index: 3, text: null },
    ])
  })

  it('空词表 → 全部 null（页面据 words.length===0 先行不判分，此为兜底）', () => {
    expect(alignRecognizedWords(2, [])).toEqual([
      { index: 1, text: null },
      { index: 2, text: null },
    ])
  })

  it('越界与重复序号：越界忽略、重复取后（vision 已校验，此处兜底）', () => {
    const aligned = alignRecognizedWords(2, [
      { index: 0, text: 'x' },
      { index: 3, text: 'y' },
      { index: 1, text: 'a' },
      { index: 1, text: 'b' },
    ])
    expect(aligned).toEqual([
      { index: 1, text: 'b' },
      { index: 2, text: null },
    ])
  })

  it('expectedCount 为 0 → 空数组（防御：PracticeSession 构造会拒绝空题集，页面先行拦截）', () => {
    expect(alignRecognizedWords(0, [{ index: 1, text: 'a' }])).toEqual([])
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm --prefix app-src run test -- src/domain/dictation-align.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现**

```ts
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
```

- [x] **Step 4: 跑测试确认通过**

Run: `npm --prefix app-src run test -- src/domain/dictation-align.test.ts` → PASS

- [x] **Step 5: Commit**

```bash
git add app-src/src/domain/dictation-align.ts app-src/src/domain/dictation-align.test.ts
git commit -m "feat(app): 识别词表到逐题的对齐纯函数 dictation-align

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 抽取 `pages/session-setup.ts` + `pages/task-hooks.ts`（纯重构）

exercise.ts 内联的 PracticeSession 装配（mastery 挂钩 + 降级链）与任务回写辅助要被 vocab-photo.ts 复用。任务回写辅助抽到独立模块（而非从 exercise.ts 导出）——vocab-photo 会 import exercise 的 `runVocabPhotoFlow` 接线在 exercise 里，反向导出会形成 exercise ↔ vocab-photo 循环 import。先原样抽取，测试保持全绿。

**Files:**
- Create: `app-src/src/pages/session-setup.ts`
- Create: `app-src/src/pages/task-hooks.ts`
- Modify: `app-src/src/pages/exercise.ts`

- [x] **Step 1: 创建 `session-setup.ts`（代码从 exercise.ts 206-225 行区域原样搬移）**

```ts
/** 组装带记录的 PracticeSession（exercise 键盘流与 vocab-photo 拍照流共用）：
 *  attempt 追加与 mastery 更新走同一事务（applyMasteryUpdate）；挂钩失败仅告警并回退为
 *  单独保存 attempt，不影响判分主链路；存储不可用跳过记录（M1 降级哲学）。 */
import type { Question } from '../types'
import { applyMasteryUpdate, hasPriorAttempt, saveAttempt } from '../db/repos'
import { PracticeSession } from '../domain/session'

export function buildRecordingSession(questions: Question[], storageOk: boolean): PracticeSession {
  const questionsById = new Map(questions.map((item) => [item.id, item] as const))
  return new PracticeSession(questions, {
    hasPriorAttempt: storageOk ? hasPriorAttempt : async () => false,
    recordAttempt: storageOk
      ? async (a) => {
          const question = questionsById.get(a.questionId)
          if (!question) {
            console.warn('mastery 挂钩跳过：会话内未找到题目', a.questionId)
            await saveAttempt(a)
            return
          }
          try {
            await applyMasteryUpdate(a, question)
          } catch (err) {
            console.warn('mastery 更新失败，回退为仅保存 attempt：', err)
            await saveAttempt(a)
          }
        }
      : async (a) => console.warn('存储不可用，跳过记录：', a.questionId),
  })
}
```

- [x] **Step 2: 创建 `task-hooks.ts`（todaysTask / markTaskStarted / markTaskCompleted 从 exercise.ts 原样搬移）**

```ts
/** 任务回写辅助（exercise 键盘流与 vocab-photo 拍照流共用）：回写失败仅告警，
 *  不阻塞练习主链路（沿用 M1 降级哲学）。独立成模块以避免 exercise ↔ vocab-photo 循环 import。 */
import { completeTask, getTask, updateTaskStatus } from '../db/repos'
import { localDayKey } from '../domain/metrics'
import type { TaskRow } from '../db/schema'

/** 任务存在且属于今日（跨日打开的旧链接任务不回写——隔日练习不应改写昨日任务状态） */
async function todaysTask(taskId: string): Promise<TaskRow | undefined> {
  const task = await getTask(taskId)
  return task && task.day === localDayKey() ? task : undefined
}

export async function markTaskStarted(taskId: string): Promise<void> {
  try {
    const task = await todaysTask(taskId)
    // 仅 planned 起转（重复进入已 in_progress 的任务不可再转，状态机无自环转移）
    if (!task || task.status !== 'planned') return
    await updateTaskStatus(taskId, 'in_progress')
  } catch (err) {
    console.warn('任务置 in_progress 失败：', err)
  }
}

export async function markTaskCompleted(taskId: string): Promise<void> {
  try {
    if (!(await todaysTask(taskId))) return
    // 状态机转移（planned 两步/in_progress 直转/终态拒绝返回 false）下沉在 completeTask
    await completeTask(taskId)
  } catch (err) {
    console.warn('任务完成回写失败：', err)
  }
}
```

- [x] **Step 3: exercise.ts 改用共用模块**

1. 顶部 import 调整：
   - 新增 `import { buildRecordingSession } from './session-setup'` 与 `import { markTaskCompleted, markTaskStarted } from './task-hooks'`；
   - 从 `../db/repos` 的 import 中删除不再直接使用的 `saveAttempt, hasPriorAttempt, applyMasteryUpdate, getTask, updateTaskStatus, completeTask`（保留仍被使用的其他符号）；
   - 若 `TaskRow` 类型与 `localDayKey` 因此不再使用，一并删除对应 import。
2. 删除 exercise.ts 内的 `todaysTask` / `markTaskStarted` / `markTaskCompleted` 定义（连同注释一起搬入 task-hooks.ts）。
3. 将 start() 内「questionsById + new PracticeSession(...)」整块（含上方「提交挂钩」注释）替换为：

```ts
    const session = buildRecordingSession(data.questions, storageOk)
```

删除因此不再使用的 `questionsById` 局部变量。

- [x] **Step 4: 全量测试 + 类型检查确认零行为漂移**

Run: `npm run test:app` → 全绿
Run: `npm --prefix app-src run build` → tsc 无错（若有未使用 import 报错，按 tsc 提示清理）

- [x] **Step 5: Commit**

```bash
git add app-src/src/pages/session-setup.ts app-src/src/pages/task-hooks.ts app-src/src/pages/exercise.ts
git commit -m "refactor(app): 抽取 buildRecordingSession 与任务回写辅助到共用模块

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: `pages/vocab-photo.ts` 三屏流程

**Files:**
- Create: `app-src/src/pages/vocab-photo.ts`
- Modify: `app-src/src/styles.css`（若需 `.dictation-sheet` 列表样式；现有样式够用则不改）

- [x] **Step 1: 实现 `vocab-photo.ts` 全文**

页面模块无 jsdom 测试（与现有 pages 一致），正确性由 tsc + 浏览器终验（Task 9）覆盖；核心对齐/判分逻辑已在 Task 3/5 的纯函数层测过。`runVocabPhotoFlow` 在本任务尚无调用方（Task 8 接线），导出符号不触发 tsc 未使用告警。

```ts
/** 手写拍照默写流程（2026-11-19 规格 §1.2）：三屏——默写卷面 / 识别中 / 结果。
 *  识别成功即直接判分（已确认决策）：缺失序号按未作答（gaveUp）记错误 attempt；
 *  整页零识别不判分不记录，提示重拍；识别失败可重拍（每次消耗一次 AI 额度）。
 *  红线：照片仅进识别请求体，不落 IndexedDB/aiRequests/备份（attempts 只存识别文本）。
 *  中途离开页面：hashchange 置 stale 并中止在途识别（省服务端计费）。 */
import type { Question, Settings } from '../types'
import { getAiUsageToday } from '../services/ai/quota'
import { recognizeHandwrittenWords } from '../services/ai/vision'
import { aiButtonState, aiErrorText } from '../services/ai/ui'
import { alignRecognizedWords } from '../domain/dictation-align'
import { compressImageFile } from '../utils/image'
import { escapeHtml } from '../ui/escape'
import { navigate } from '../router'
import { buildRecordingSession } from './session-setup'
import { markTaskCompleted } from './task-hooks'

export interface VocabPhotoFlowOptions {
  container: HTMLElement
  /** 页面标题（如「单词默写 · Unit 1」） */
  title: string
  /** 固定顺序的词汇题（不 shuffle：卷面序号 = 纸面序号 = 对齐序号） */
  questions: Question[]
  settings: Settings
  storageOk: boolean
  /** 任务驱动练习的任务 id（自由练习无） */
  taskId?: string
}

interface ResultRow {
  question: Question
  text: string | null
  isCorrect: boolean
  correctAnswer: string
}

export function runVocabPhotoFlow(opts: VocabPhotoFlowOptions): void {
  const { container, title, questions, settings, storageOk, taskId } = opts
  let stale = false
  const aiAbort = new AbortController()
  window.addEventListener('hashchange', () => {
    stale = true
    aiAbort.abort()
  }, { once: true })

  let aiUsage = 0
  const start = async (): Promise<void> => {
    // AI 按钮状态底座：读取失败按 0 用量处理（灰态推导仍由 aiButtonState 兜底口径）
    try {
      aiUsage = await getAiUsageToday()
    } catch {
      /* 保持 0，调用层仍会兜底拒绝 */
    }
    if (stale) return
    renderSheet()
  }
  void start()

  /** 屏 1：默写卷面（notice 为重拍提示等辅助信息） */
  const renderSheet = (notice = ''): void => {
    const state = aiButtonState(settings, aiUsage)
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <p class="muted">按下方序号在纸上默写，全部写完后拍照上传（整页一张）。</p>
      ${storageOk ? '' : '<p class="muted">存储不可用，本次练习不会保存记录。</p>'}
      <div class="card">
        <h3>默写卷面（共 ${questions.length} 词）</h3>
        <ol class="dictation-sheet" style="padding-left:1.5rem">
          ${questions.map((q) => `<li style="margin:0.35rem 0">${escapeHtml(q.stem)}</li>`).join('')}
        </ol>
        <div class="action-row">
          <label class="btn btn-secondary" style="display:inline-flex;align-items:center" title="${escapeHtml(state.title)}">拍照上传
            <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none"${state.disabled ? ' disabled' : ''}>
          </label>
          <button class="btn btn-secondary" id="photo-back">返回今日学习</button>
        </div>
        ${notice === '' ? '' : `<p class="muted">${escapeHtml(notice)}</p>`}
      </div>`
    container.querySelector('#photo-input')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (file === undefined) return
      input.value = '' // 允许同一文件重选也触发 change
      void handlePhoto(file)
    })
    container.querySelector('#photo-back')?.addEventListener('click', () => navigate('today'))
  }

  const handlePhoto = async (file: File): Promise<void> => {
    let dataUrl: string
    try {
      dataUrl = await compressImageFile(file)
    } catch (err) {
      if (stale) return
      renderSheet(err instanceof Error ? err.message : '图片读取失败，请重拍。')
      return
    }
    if (stale) return
    renderRecognizing(dataUrl)
    try {
      const words = await recognizeHandwrittenWords(
        { imageDataUrl: dataUrl, expectedCount: questions.length },
        { settings },
        aiAbort.signal,
      )
      if (stale) return
      if (aiAbort.signal.aborted) return
      if (words.length === 0) {
        renderSheet('未识别到手写内容，请对准纸面、光线充足后重拍。')
        return
      }
      await gradeAll(words)
    } catch (err) {
      if (stale || aiAbort.signal.aborted) return
      renderRecognizeFailed(dataUrl, err)
    }
  }

  /** 屏 2a：识别中 */
  const renderRecognizing = (dataUrl: string): void => {
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>识别中…</h3>
        <img src="${escapeHtml(dataUrl)}" alt="待识别照片" style="max-width:100%;max-height:40vh">
        <p class="muted">正在识别手写单词，最长约 45 秒，请稍候。</p>
      </div>`
  }

  /** 屏 2b：识别失败（错误分类文案 + 重拍） */
  const renderRecognizeFailed = (dataUrl: string, err: unknown): void => {
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>识别失败</h3>
        <img src="${escapeHtml(dataUrl)}" alt="照片预览" style="max-width:100%;max-height:40vh">
        <p class="muted">${escapeHtml(aiErrorText(err))}</p>
        <div class="action-row">
          <button class="btn" id="photo-retry">重新拍照</button>
          <button class="btn btn-secondary" id="photo-back">返回今日学习</button>
        </div>
      </div>`
    container.querySelector('#photo-retry')?.addEventListener('click', () => renderSheet())
    container.querySelector('#photo-back')?.addEventListener('click', () => navigate('today'))
  }

  /** 识别成功 → 直接判分（无确认环节）：逐题经 PracticeSession 提交（判分/记录/mastery 全复用） */
  const gradeAll = async (words: { index: number; text: string }[]): Promise<void> => {
    const aligned = alignRecognizedWords(questions.length, words)
    const session = buildRecordingSession(questions, storageOk)
    const rows: ResultRow[] = []
    try {
      for (const a of aligned) {
        const sub = await session.submit(a.text ?? '', a.text === null ? { gaveUp: true } : {})
        rows.push({ question: sub.question, text: a.text, isCorrect: sub.isCorrect, correctAnswer: sub.correctAnswer })
      }
    } catch (err) {
      // attempts 只追加：部分已保存的记录不可回滚，也不提供整页重试（会重复追加）；
      // 引导返回，已保存部分照常生效（与键盘流"提交失败"同一哲学）
      if (stale) return
      console.warn('拍照判分提交失败：', err)
      container.innerHTML = `
        <h1>${escapeHtml(title)}</h1>
        <div class="error-panel">部分学习记录保存失败，已保存的作答不受影响。${escapeHtml(String(err))}
          <div class="action-row"><button class="btn" id="photo-back-err">返回今日学习</button></div>
        </div>`
      container.querySelector('#photo-back-err')?.addEventListener('click', () => navigate('today'))
      return
    }
    if (stale) return
    if (taskId) void markTaskCompleted(taskId)
    renderResults(rows)
  }

  /** 屏 3：结果（逐行对错 + 汇总） */
  const renderResults = (rows: ResultRow[]): void => {
    const correct = rows.filter((r) => r.isCorrect).length
    const pct = rows.length === 0 ? 0 : Math.round((correct / rows.length) * 100)
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>批改完成</h3>
        <p>共 ${rows.length} 词，写对 ${correct} 词（${pct}%）。识别结果仅供参考，如有出入以纸面为准。</p>
        ${rows
          .map(
            (r, i) => `<div class="feedback ${r.isCorrect ? 'ok' : 'bad'}" style="margin:0.5rem 0">
          <p class="verdict">${i + 1}. ${r.isCorrect ? '✓' : '✗'} ${r.text === null ? '<span class="muted">未作答</span>' : escapeHtml(r.text)}${r.isCorrect ? '' : ` → 正确答案：<strong>${escapeHtml(r.correctAnswer)}</strong>`}</p>
          <p class="muted">${escapeHtml(r.question.stem)}</p>
        </div>`,
          )
          .join('')}
        <div class="action-row">
          <button class="btn" id="photo-back-today">返回今日学习</button>
          <button class="btn btn-secondary" id="photo-to-mistakes">查看错题本</button>
        </div>
      </div>`
    container.querySelector('#photo-back-today')?.addEventListener('click', () => navigate('today'))
    container.querySelector('#photo-to-mistakes')?.addEventListener('click', () => navigate('mistakes'))
  }
}
```

- [x] **Step 2: 类型检查**

Run: `npm --prefix app-src run build` → tsc 无错
（`runVocabPhotoFlow` 是导出符号，无调用方不触发告警；`markTaskCompleted` 来自 Task 6 的 task-hooks.ts）

- [x] **Step 3: Commit**

```bash
git add app-src/src/pages/vocab-photo.ts
git commit -m "feat(app): 手写拍照默写三屏流程（卷面/识别/结果）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: `exercise.ts` 模式选择卡接入

**Files:**
- Modify: `app-src/src/pages/exercise.ts`

- [x] **Step 1: loadQuestions 的 vocab 路径改为固定顺序 + 标记 isVocab**

`loadQuestions` 返回类型与 vocab 分支改为（不 shuffle——键盘模式在选择后再 shuffle）；**同时** start() 内 `let data: { title: string; questions: Question[]; emptyMessage?: string }` 局部声明补上 `isVocab?: boolean`，否则后续 `data.isVocab` 访问过不了 tsc：

```ts
async function loadQuestions(
  params: URLSearchParams,
): Promise<{ title: string; questions: Question[]; emptyMessage?: string; isVocab?: boolean }> {
```

```ts
  const vocabUnit = params.get('vocab')
  if (vocabUnit) {
    const bundle = await fetchContentBundle()
    const unit = findVocabUnit(bundle.vocab, vocabUnit)
    // 固定顺序：卷面序号 = 纸面序号 = 识别对齐序号；键盘模式在选择后 shuffle
    return {
      title: `单词默写 · ${unit?.label ?? vocabUnit}`,
      questions: deriveVocabQuestions(bundle.vocab, vocabUnit),
      isVocab: true,
    }
  }
```

- [x] **Step 2: start() 插入模式选择卡**

现有 start() 中 `if (taskId) await markTaskStarted(taskId)` 之前有 settings/aiUsage 读取段。把顺序调整为「settings/aiUsage 先读 → vocab 模式选择 → markTaskStarted → 后续」，即：

1. **删除**现有位置的两行：
```ts
    if (taskId) await markTaskStarted(taskId)
    if (stale) return
```
（该段原来位于「题目加载成功（非空）即视为进入练习」注释块处。）

2. settings/aiUsage 读取段（`let settings: Settings = DEFAULT_SETTINGS` 到 `if (stale) return`）保持不动，其**之后**、`aiAbort` 创建段之前插入：

```ts
    // 单词默写：先选作答方式（键盘 = 现有流程；手写拍照 = vocab-photo 三屏流）
    if (data.isVocab) {
      const mode = await chooseVocabMode()
      if (stale) return
      // 选定模式即视为"进入练习"：任务置 in_progress（拍照流由 vocab-photo 在完成节点回写 completed）
      if (taskId) await markTaskStarted(taskId)
      if (stale) return
      if (mode === 'photo') {
        runVocabPhotoFlow({ container, title: data.title, questions: data.questions, settings, storageOk, taskId })
        return
      }
      data.questions = shuffle(data.questions)
    } else if (taskId) {
      // 非词汇路径：题目加载成功即置 in_progress（原语义不变）
      await markTaskStarted(taskId)
      if (stale) return
    }
```

3. 在 `renderQuestion` 定义之前加模式选择卡函数：

```ts
    /** 模式选择卡（仅词汇默写）：键盘（现有流程）vs 手写拍照（需 AI，三级灰态同口径） */
    const chooseVocabMode = (): Promise<'keyboard' | 'photo'> =>
      new Promise((resolve) => {
        const state = aiButtonState(settings, aiUsage)
        container.innerHTML = `
          <h1>${escapeHtml(data.title)}</h1>
          <div class="card">
            <h3>单词默写 · 共 ${data.questions.length} 词</h3>
            <p class="muted">选择作答方式。</p>
            <div class="action-row">
              <button class="btn" id="mode-keyboard">键盘默写</button>
              <button class="btn btn-secondary" id="mode-photo"${state.disabled ? ' disabled' : ''} title="${escapeHtml(state.title)}">手写拍照（AI 识别）</button>
            </div>
          </div>`
        // 离开页面未选择：resolve 一个占位值，后续 stale 判定直接返回（避免悬挂 Promise）
        window.addEventListener('hashchange', () => resolve('keyboard'), { once: true })
        container.querySelector('#mode-keyboard')?.addEventListener('click', () => resolve('keyboard'))
        container.querySelector('#mode-photo')?.addEventListener('click', () => resolve('photo'))
      })
```

4. 顶部 import 增加：
```ts
import { runVocabPhotoFlow } from './vocab-photo'
```

注意：`container` 类型为 `HTMLElement`（PageRenderer 参数），与 `runVocabPhotoFlow` 的 `container: HTMLElement` 匹配。

- [x] **Step 3: 全量回归**

Run: `npm run test:app` → 全绿
Run: `npm --prefix app-src run build` → tsc 无错、构建成功

（规格 §4.1 中「exercise.ts 模式选择：轻量纯逻辑断言」——模式选择卡的全部逻辑是内联 DOM 渲染与事件绑定，无可抽的纯函数；按规格「不强行引入 jsdom」原则，本任务不新增 DOM 单测，覆盖走 Task 9 浏览器终验。）

- [x] **Step 4: Commit**

```bash
git add app-src/src/pages/exercise.ts
git commit -m "feat(app): 词汇默写入口增加键盘/手写拍照模式选择卡

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 汇总回归 + 浏览器终验 + 验收记录

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-vocab-photo-dictation-design.md`（追加验收记录）
- Modify: `docs/superpowers/plans/2026-11-16-m0-m1-local-core.md`（M2 待办汇总登记，如有 Minor）

- [x] **Step 1: 汇总回归**

Run: `npm run test:app` → 全绿（记录用例总数）
Run: `npm --prefix app-src run build` → tsc 无错；产物仅在 `app/`，且重复构建零漂移（对比两次构建产物 hash 一致）
Run: `npm run test:extract` → 6/6（防漂移守卫）
Run: `npx html-validate index.html typing/ 2>/dev/null || npm run htmlvalidate` → 原站 CI 不受影响（按仓库既有 CI 命令执行）

- [x] **Step 2: 浏览器终验（⚠️ 本会话模型不支持图片模态，绝对禁止 take_screenshot —— 会话会被 400 错误杀死；一律用文本快照 browser_snapshot / browser_find / browser_evaluate）**

用 Playwright MCP 对 `vite preview`（或 `npm run dev:app`）逐项验证，全部用文本断言：

1. `#/exercise?vocab=v1-u1` → 出现模式选择卡（两个按钮文字「键盘默写」「手写拍照」）；未配 Key 时手写按钮 disabled 且 title 含「未配置 AI」。
2. 「键盘默写」→ 进入原逐题流程（题干/输入框/提交按钮都在），行为与改动前一致。
3. 「手写拍照」→ 卷面屏出现带序号中文提示清单与「拍照上传」入口。
4. 用 `browser_evaluate` 注入一张测试图（生成 canvas → File → 触发 input change，或直接调用 `compressImageFile` 验证返回 dataURL 前缀 `data:image/jpeg`）验证压缩链路可用。
5. 识别链路（需真实 Key 的部分跳过）：以 `browser_evaluate` mock `globalThis.fetch` 返回固定 `{"words":[...]}` 响应后走完整拍照 → 判分 → 结果屏，断言：逐行 ✓/✗、缺失序号显示「未作答」、汇总数字正确；attempts 表新增行数与 phase 符合预期（`db.attempts.toArray()` 查询验证）。
6. AI 关闭（settings.aiEnabled=false）→ 模式卡手写按钮灰态。
7. 中途离开（hashchange）→ 在途识别中止（mock fetch 永不返回，断言离开后无残留渲染）。
8. 任务驱动入口（今日页词汇任务卡）→ 选模式后任务 in_progress，完成后 completed（tasks 表查询验证）。

- [x] **Step 3: 更新文档并提交**

1. 在 `docs/superpowers/specs/2026-11-19-vocab-photo-dictation-design.md` 末尾追加「## 验收记录（2026-11-…）」，按规格 §5 四条逐项登记实测结果（含测试用例总数、构建零漂移、浏览器终验各步、隐私红线复检：grep 确认无真实 Key、aiRequests 无图片内容字段）。
2. 若评审/终验发现 Minor（非阻塞），登记到 `docs/superpowers/plans/2026-11-16-m0-m1-local-core.md` 的「M2 待办汇总」。
3. 勾选本计划全部 checkbox。

```bash
git add docs/superpowers/specs/2026-11-19-vocab-photo-dictation-design.md docs/superpowers/plans/2026-11-19-vocab-photo-dictation.md docs/superpowers/plans/2026-11-16-m0-m1-local-core.md
git commit -m "docs: 手写拍照默写验收记录与本计划勾选

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 执行注意（给控制器/子代理）

1. **红线复检（每个任务的提交前）**：`git diff --staged | grep -iE 'sk-(?!test-fake-key)'` 应无输出；任何真实 Key 不得进入提交。
2. **浏览器验证的子代理一律禁止 take_screenshot**（本会话模型 text-only，screenshot 会 400 杀死代理）；只允许 browser_snapshot / browser_find / browser_evaluate 文本断言。
3. Task 6 / Task 8 是行为敏感的接线改动，实现者必须在提交前跑全量测试。
4. 词汇题的 `stem` 格式为 `${meaning}（${pos}）`，卷面屏直接展示 stem（中文提示 + 词性），学生按序号默写对应英文单词——与键盘模式看到的信息一致。
