# 单词默写 · 手写拍照识别（vocab photo dictation）设计规格

**日期：** 2026-11-19
**上游：** M2+M3 已完成（`2026-11-17-m2-m3-learning-loop-ai-design.md`），本规格为独立增量功能
**范围：** 单词默写支持纸上手写 → 拍照上传 → AI 识别 → 直接判分

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| 拍照粒度 | **整页一张照片**：学生按屏幕卷面序号在纸上默写整单元，写完拍一张 |
| 识别引擎 | **百炼多模态模型**（复用现有 compatible-mode 直连、Key、配额、超时/降级链）；默认 `qwen-vl-ocr` |
| 判分时机 | **识别后直接判分**，无学生确认环节；缺失序号按未作答处理；整页零识别不判分 |
| 架构 | **方案 A**：入口模式选择卡 + 独立照片流程模块，复用 `PracticeSession`/`grader.ts`/任务回写，`TransportRequest` 消息类型扩展多模态 |
| 隐私红线 | 照片仅出现在一次识别请求中：不落 IndexedDB、不进 aiRequests、不进备份、不写日志 |

## 1. 交互流程与页面结构

### 1.1 入口（`exercise.ts` 最小改动）

进入 `#/exercise?vocab=u1` 后先渲染「模式选择卡」：单元名 + 词数 + 两个入口按钮：

- **键盘默写**：现有流程原样（shuffle + 逐题输入 + AI 提示/讲解），逻辑一行不改。
- **手写拍照**：进入 `pages/vocab-photo.ts` 新流程。按钮三态灰化复用 `aiButtonState`（开关关闭 / 未配 Key / 今日额度已满 → 置灰并带 title 原因）——整页识别消耗一次 AI 请求。
- 带 `task=<id>` 进入：选定模式即 `markTaskStarted`；判分完成节点 `markTaskCompleted`（沿用现有回写规则：仅今日任务、状态机转移在 `completeTask`）。

### 1.2 手写拍照三屏（`pages/vocab-photo.ts`）

1. **默写卷面屏**：按固定顺序（不 shuffle，`deriveVocabQuestions` 原序）列出带序号的中文提示（`1. 早上好 → ______`），提示「按序号在纸上默写，写完拍照」。底部「拍照上传」（`<input type="file" accept="image/*" capture="environment">`）与「返回」。
2. **识别中屏**：选图后立即压缩并调 AI 识别；显示加载态与照片缩略预览；失败显示错误类别（`aiErrorText`）+「重新拍照」。
3. **结果屏**：识别成功即直接判分，逐行展示「序号 / 中文提示 / 识别出的单词 / ✓或✗ / 正确答案」，底部汇总（共 N 词、对 M）+「返回今日学习 / 查看错题本」。

### 1.3 对齐规则

- 卷面序号 = 题目固定顺序（1..N）。
- 识别返回按题号标注的单词；某序号缺失或无法辨认 → 该题按「未作答」处理（等同「我不会」，记错误 attempt）。
- **整页零识别**（words 为空数组）→ 不判分、不写任何记录，提示重拍。

## 2. AI 视觉层与数据流

### 2.1 传输层扩展（`transport.ts`，纯类型放宽）

```ts
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } } // dataURL

interface ChatMessage {
  role: 'system' | 'user'
  content: string | ContentPart[]
}
```

`dashscope.ts` 的 `buildInit` 原样序列化 messages（OpenAI 兼容格式天然支持多模态混排）；现有纯文本调用零影响。

### 2.2 识别任务 `services/ai/vision.ts`

`recognizeHandwrittenWords({ imageDataUrl, expectedCount }, deps, signal)` → `{ words: { index: number; text: string }[] }`

- **前置闸门**（与 `runAiTask` 同款）：`aiEnabled` 三级检查（开关 / Key 缺失 / 本地上限）；配额消耗 1 次；`aiRequests` 记一条 `type: 'dictation_ocr'`（只存 status/latencyMs，不存图片与识别文本）。
- **提示词**：system 说明「识别图片中按序号手写的英文单词，忽略印刷的中文提示与序号数字，只输出手写英文单词」；user 消息 = 图片（`image_url` part）+ 文字指令（含题目总数 N），要求返回 `{"words":[{"index":1,"text":"apple"},…]}`，无法辨认的序号不要输出。
- **响应校验**：复用现有宽松 JSON 解析（裸 / fenced / 花括号子串）+ 字段校验：
  - `words` 必须为数组（非数组 → `invalid-response`）；
  - 每项 `index` 为 1..N 整数、`text` 为非空字符串（截断至 100 字符）；
  - 同题号重复取后出现者；
  - 越界 index 的项丢弃。
  - 解析失败 → `AiError('invalid-response')`，**不走 `{raw}` 降级**（自由文本无法对齐题号）。
- **超时**：`AI_VISION_TIMEOUT_MS = 45_000`（视觉推理比文本慢，不用 20s 默认值）。
- **maxTokens**：1024。

### 2.3 图片客户端预处理（`utils/image.ts`）

FileReader → `Image` → canvas 压缩到长边 ≤1280px、JPEG 质量 0.85 → dataURL。压缩后仍 >3MB → 报「图片过大，请重新拍摄」。目标尺寸计算为纯函数（可单测）；canvas 编码部分在浏览器终验。

### 2.4 设置项

`Settings` 增加 `aiVisionModel?: string`，默认 `'qwen-vl-ocr'`；设置页 AI 配置卡增加一个可选输入框（留空用默认）。非凭证字段，备份导出不脱敏（与 `aiModel` 同级待遇，`redactSettingsRow` 不动）。

### 2.5 隐私红线（与既有红线一致）

照片仅出现在识别请求体中随请求发送；不落 IndexedDB、不进 aiRequests、不进备份、不写日志；`aiApiKey` 生命周期规则不变（只进请求头）。

## 3. 判分、记录与错误边界

### 3.1 判分与记录（复用 `PracticeSession`）

识别成功后按固定顺序逐题 `session.submit()`：

- 识别出的词 → `submit(识别文本)`，经 `gradeAnswer` → `normalizeBlank` 比对 `acceptedAnswers`（大小写/空格/全半角标点规范化天然吸收 OCR 噪声）。
- 缺失序号 → `submit('', { gaveUp: true })`。
- `hasPriorAttempt` 决定 `phase: first | retry`；mastery 更新、任务回写全走现有链路，**零新判分逻辑**。
- 识别文本原样存入 `attempt.answer`（attempts 本就只存文本）。
- 结果屏数据来自每次 `submit` 返回值收集，不二次判分。

### 3.2 错误处理矩阵

| 场景 | 行为 | 是否已写记录 |
|---|---|---|
| 选的文件不是图片/读取失败 | 错误面板 + 重选 | 否 |
| 压缩后仍超 3MB | 提示图片过大，重拍 | 否 |
| AI 未配置/关闭/额度满 | 卷面屏「拍照上传」置灰 + 原因 title | 否 |
| 识别请求失败（网络/超时/auth/invalid-response） | 识别屏错误面板（`aiErrorText`）+ 重新拍照（可多次） | 否（判分发生在识别成功后，失败重试无污染） |
| 整页零识别 | 不判分不记录，提示重拍 | 否 |
| 部分序号缺失 | 缺失题记「未作答」（=错） | 是（有意为之） |
| 存储不可用 | attempt/mastery/任务回写跳过并提示（沿用键盘模式降级），识别本身不受影响 | — |
| 中途离开页面 | `hashchange` AbortController 中止在途识别（沿用现有省计费模式） | 识别中离开则未写 |

### 3.3 配额语义

一次整页识别 = 1 次 AI 请求（记入每日上限）；重拍重试各计 1 次——与现有「失败也计额度」口径一致。

## 4. 测试策略与文件清单

### 4.1 测试（Vitest，沿用现有单测风格）

| 对象 | 覆盖点 |
|---|---|
| `transport.ts` 多模态 | 纯文本消息序列化不变；`image_url` part 进请求体；string 与 parts 混用正常 |
| `vision.ts` | 闸门三态；成功路径解析（裸/fenced/噪声）；字段校验（index 越界、text 空/超长、重复序号取后、words 非数组）；零 words 返回空数组（页面侧不判分）；`invalid-response` 不走 raw 降级；aiRequests 只记 type/status/latency；45s 超时映射；abort 上抛；fetchImpl 注入假 fetch |
| `utils/image.ts` | 纯函数：目标尺寸计算（超长边缩放、短边等比、小图不放大）；3MB 上限判定 |
| `domain/dictation-align.ts` | 识别词表 → 逐题答案数组对齐：序号命中 / 缺失→未作答标记 / 零词→空（触发不判分） |
| `exercise.ts` 模式选择 | 轻量纯逻辑断言（不强行引入 jsdom DOM 测试） |
| 回归 | 现有 329 测试全绿；`tsc` 与构建零漂移照跑 |

### 4.2 文件清单

```
修改  app-src/src/services/ai/transport.ts          # ChatMessage content 多模态放宽（纯类型）
新建  app-src/src/services/ai/vision.ts             # 识别任务（闸门/提示词/校验/aiRequests）
新建  app-src/src/services/ai/vision.test.ts
新建  app-src/src/utils/image.ts (+image.test.ts)   # 压缩与上限
新建  app-src/src/domain/dictation-align.ts (+test) # 识别词表→逐题对齐（纯函数）
新建  app-src/src/pages/vocab-photo.ts              # 三屏流程（卷面/识别/结果）
修改  app-src/src/pages/exercise.ts                 # vocab 入口改模式选择卡
修改  app-src/src/types.ts、pages/settings.ts       # aiVisionModel 可选项
回归  app-src/src/services/backup/index.ts          # 无改动，仅回归确认脱敏不受影响
```

### 4.3 浏览器终验（实现后）

真实走一遍：选模式 → 看卷面 → 用一张手写样例图 → 识别 → 判分 → 错题本/今日任务回写核对；AI 关闭/未配 Key 时按钮灰态核对；中途离开页面在途请求中止核对。

## 5. 验收标准

1. `npm run test:app` 全绿（新增用例 + 现有 329 全部通过）；`tsc` 无错；构建产物仅 `app/`。
2. 浏览器终验：`#/exercise?vocab=u1` → 手写拍照 → 整页照片 → 识别 → 直接判分 → 结果屏逐行对错与汇总正确；缺失序号记未作答；attempts/任务回写与键盘模式口径一致。
3. AI 关闭/未配 Key/额度满时手写拍照入口置灰并显示原因；识别失败可重拍且不写任何记录。
4. 照片不落任何存储（IndexedDB/aiRequests/备份），代码与测试中无任何真实 Key（红线复检）。
