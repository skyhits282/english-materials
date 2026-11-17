# M2+M3 学习闭环与 AI · 设计规格

**日期：** 2026-11-17
**上游文档：** `初中英语AI学习助手_设计文档_V1.0.md` §7（业务规则）、§8（数据库）、§9（Qwen 接口）
**前序实现：** M0+M1 本地核心（见 `2026-11-16-m0-m1-local-core-design.md` 及其验收记录）
**本轮范围：** M2 学习闭环（全量）+ M3 AI 接入（本地直连阿里百炼）

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| M2 范围 | 全量：计划调度、错题间隔复测、报告增强、家长 PIN、试卷成绩录入、题库扩七下 |
| M3 密钥方式 | **前端本地直连阿里百炼**（OpenAI-compatible），Base URL + API Key + 模型名存 IndexedDB；不做服务端代理（用户知情选择；`AiTransport` 接口预留代理升级位） |
| CORS | 已实测 `dashscope.aliyuncs.com/compatible-mode/v1` 预检通过（`access-control-allow-origin: *`，允许 POST + authorization 头） |
| Key 实测 | 百炼 API Key 与 `qwen-flash` 已实测连通（2026-11-17，用户提供的家用 Key；密钥本身不进入任何代码/文档/备份，仅在验收实测时经设置页录入浏览器） |
| 已排除方案 | 用户另有一个 Anthropic 协议网关（`token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`）：鉴权有效但整域 CORS 关闭（预检即 401 且无 CORS 头）、模型名未公开，浏览器不可直连——已放弃 |
| AI 任务类型 | `explain_mistake`（错题讲解）、`coach_turn`（启发提示）、`weekly_insight`（周报建议）；`review_essay` 作文批改留后续迭代 |
| 复测间隔默认值 | 按总纲 §7.4：1 天 → 3 天 → 7 天 → 14 天，失败回退 |
| 不做 | SW 离线（M4）、作文批改、语音、系统推送 |
| 技术债 | 顺带清偿 M1 已登记五项：词汇题解析、播种失败重试、导入前自动备份、randomUUID 降级、mastery 写入（本轮核心） |

## 1. 错题间隔复测（mastery 状态机）

### 1.1 mastery 表启用（现为空表）

每次提交 attempt 后同步更新对应知识点的 mastery 行（按 `knowledgePointId` 逐个更新）：

- `stage`：`weak`（薄弱）→ `consolidating`（巩固中）→ `mastered`（暂定掌握）
- 转移规则（首版默认值）：

| 事件 | stage | nextReviewAt |
|---|---|---|
| 首测错误 | weak | 次日 |
| 复测（到期练习）错误 | weak（不变） | 次日 |
| 复测正确（stage=weak） | consolidating | 3 天后 |
| 复测正确（stage=consolidating，3 天档） | consolidating | 7 天后 |
| 复测正确（7 天档） | mastered | 14 天后 |
| mastered 后到期复测错误 | weak | 次日（回退） |

- `metrics` 字段：`testedCount`、`firstTryCorrect`、`delayedReviewCorrect`、`lastPracticedAt`（由 attempts 聚合更新）；另存 `intervalDays`（当前所处间隔档：0/1/3/7/14，用于决定下次间隔，消除"3 天档 vs 7 天档"的判定歧义）
- 同一题当场改对（练习内即时重试）**不推进**状态机——只有隔日及以后的到期复测才计入"复测"事件（与 §7.5 延迟复测口径一致）
- 时间存 UTC ISO 8601；"次日/3 天后"按**本地日历日**推算（today+1、+3、+7、+14 的本地日零点对应 UTC 存储）；到期判定 `nextReviewAt <= 本地今日` 即到期

### 1.2 到期复习入口

- 今日页顶部"到期复习"任务卡：显示到期知识点数与题目数；点击进入复测练习
- 复测题集：从 mastery 到期知识点中取"历史曾答错"的题（含词汇默写题，见 §6 技术债），按知识点均衡抽取，上限 10 题/次
- 复测提交 `phase='retry'`，attempt 照常只追加；提交后走 §1.1 状态机
- 题量不足时显示"该知识点已无新题"，不重复刷同题虚高正确率

## 2. 每日计划（tasks 表启用）

### 2.1 生成规则（本地确定性）

打开应用进入今日页时，若当日（本地日 key）无任务则生成，**同一天重复打开不重建**（按 `day` 查重）：

- 总时长 = settings.dailyMinutes（默认 35，20–45）；每周学习日外（非学习日）不生成，显示"今日休息"
- 比例（初始化默认，家长可在设置页微调 ±10%）：到期复习 30% / 当前单元词汇 40% / 专项巩固 20% / 学习小结 10%
- 任务行：`{id, day, type: 'review'|'unit'|'special'|'summary', questionIds, status, minutesPlanned}`，questionIds 为快照（去重、不当新题重复出）
- 到期复习任务与 §1.2 联动：有到期项才生成 review 任务；时长上限 min(30% 总时长, 到期题量)
- unit 任务按 settings.currentUnit 派生词汇默写题；special 任务从四/八专项按薄弱程度（知识点首测错误率）选一个
- summary 任务为软任务（无题目），完成后手动勾选

### 2.2 状态与结转

- `planned → in_progress → completed`；允许 `skipped`（注明原因：太难/太多/其他）与 `deferred`（次日结转，加入次日计划的复习份额）
- 完成判定基于真实作答：练习内全部题目提交完（或显式放弃）才算 completed，"打开页面"不计
- 次日生成计划时读取昨日未完成任务并结转（deferred 优先编入复习段）

## 3. 报告增强

- **七日趋势**：内联 SVG 柱状图（零依赖），最近 7 个本地日每日完成题数（柱）与首测正确率（折线百分比）；无数据日显示 0
- **三个优先薄弱点**：知识点粒度，按首测错误率降序，仅取首测作答 ≥3 次的知识点；不足 3 个就显示实际个数
- **补齐 §7.5 指标**：任务完成率、复测按时率（到期数为 0 显示"不适用"）、知识点覆盖率
- **周报区**：报告页底部"本周周报"卡——本地生成 WeeklyFacts（学习天数/完成率、首测与复测表现、反复错题知识点、到期未完成复测数、实际题量），显示事实摘要；AI 配置后可点"生成 AI 建议"（见 §7.3），结果存 weeklyReports 表可回看
- 词汇题解析（技术债清偿后）：错题本与报告的薄弱点/易错词正确显示题干与单词，不再显示原始 questionId

## 4. 家长 PIN 与试卷成绩录入

- **PIN**：设置页首次可设置 4 位数字 PIN（明文存 settings，定位仅防误操作）；设置后，修改"每日时长/每周天数/当前单元/年级/清空数据/备份导入"需先输 PIN；PIN 不参与任何加密
- **试卷成绩**：设置页表单录入最近两次试卷的题型分项成绩（如"语法 12/15、词汇 8/10"），存 settings 一个 key；报告页作诊断参考展示（标注"手工录入"），不参与自动判分与指标

## 5. 题库扩展七下

- 转换脚本泛化：`scripts/extract-questions.mjs`（保留 `extract:g7a` 兼容别名），输入 g7a/g7b 各四专项 `data.js` + `typing/data/v1.js`（七上词汇）与 `v2.js`（七下词汇；实施时先核对 v2 单元标签确认册别）
- 输出 bundle 结构升级：`content.json` 增 books 概念；`questions.json` 含 `g7b-adjadv/g7b-nouns/g7b-pronouns-modals/g7b-tenses` 四专项（各约 48 题）；`vocab.json` 分 `g7a`/`g7b` 两册
- contentVersion 递增；播种逻辑按版本重建（现有机制不变）
- 练习选择：8 个专项 + 两册词汇默写；设置页"年级/册别"生效（决定今日页默认推荐与词汇册别）
- ID 映射沿用现有规范（`g7b-adjadv-l1-0001` 等），幂等可复现，防漂移测试同 M1

## 6. M1 技术债清偿（并入相关任务）

| 债 | 清偿方式 |
|---|---|
| 词汇题在错题本/报告显示原始 ID | 内容层提供词汇题统一解析器（questionId → 题干/答案），两页接入 |
| 播种失败静默、专项空题无重试 | 专项页空结果也走错误面板+重试；播种失败在今日页提示 |
| 导入前自动安全备份（§8.1"默认先备份"） | 导入确认前自动把当前数据导出为下载文件 |
| randomUUID 非安全上下文死循环 | UUID 生成加 crypto.randomUUID 可用性检测与 Math.random 回退 |
| mastery 未写入 | §1.1 核心 |

## 7. M3：AI 本地直连

### 7.1 配置（设置页"AI 配置"卡）

- `aiBaseUrl`（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）、`aiApiKey`、`aiModel`（默认 `qwen-flash`）、`aiDailyLimit`（默认 50 次/日）
- Key 输入框掩码显示（`sk-****`），提供"清除密钥"；**备份导出剔除 `aiApiKey` 与 PIN 字段**（§8.1 红线：不导出凭证）
- 未配置 Key：AI 按钮灰态显示"未配置"，周报事实部分本地照常生成

### 7.2 调用层 `services/ai/`

- `AiTransport` 接口（`complete(request): Promise<response>`）——直连实现 `dashscope.ts`：`POST {base}/chat/completions`，Bearer Key，system+user 消息，`response_format: {type: 'json_object'}`（失败时不带该参数重试一次）
- 三个任务封装（提示词按总纲 §9.2 精神设计，面向初一学生、先提示后解释）：
  - `explain_mistake`：传当前题 stem/options/正确答案/学生答案/知识点，返回 `{hint, explanation, followUpQuestion}`——练习页答错反馈区加"AI 讲解"按钮
  - `coach_turn`：提交前"AI 提示"按钮，传题干（不含答案），返回 `{hint}`，每题一次
  - `weekly_insight`：传 WeeklyFacts 摘要，返回 `{progress, weakness, adjustments, nextGoals}`（各限 200 字）——报告页周报区按钮
- 响应严格校验（schemaVersion/字段/长度）；解析失败降级为普通文本显示（若可读）或提示重试；20 秒超时，AbortController 可取消，允许手动重试一次
- **输入最小化**：只传当前题目与必要摘要，禁止传全量历史；文本转义防注入（题目内容视为数据）

### 7.3 记录与配额

- `aiRequests` 表：`{id, type, status, latencyMs, createdAt}`——**不存题目内容、回答与学生信息**
- 单日配额：按本地日统计 aiRequests 计数，超限当日拒绝并提示
- weeklyReports 表：`{weekStart, facts, aiSuggestions, generatedAt}`；同一周重复生成覆盖 aiSuggestions（facts 可重算）

### 7.4 降级链

未配置 → 灰态；网络失败/超时/4xx5xx → 明确提示 + 重试一次；配额超限 → 当日禁用；响应畸形 → 纯文本降级。**任何 AI 失败不影响做题、记录、备份主链路。**

## 8. 数据库与备份变更

- Dexie stores 沿用 M1 八表；如索引需调整（tasks 按-day/status 查询、aiRequests 按本地日计数）走 `version(2).stores(...)` 升级，旧库数据保留
- 备份 `BACKUP_SCHEMA_VERSION` 升为 2：新增 tasks/weeklyReports/aiRequests 内容校验（沿用行校验框架）；**settings 行导出前剔除 `aiApiKey`、PIN**；v1 备份文件仍可导入（向后兼容）
- attempts 语义不变：只追加，导入合并不覆盖

## 9. 测试（Vitest + fake-indexeddb）

| 对象 | 覆盖 |
|---|---|
| mastery 状态机 | 全部转移边、回退、本地日推算、当场重试不推进 |
| 计划生成 | 幂等（同日不重建）、比例预算、结转、非学习日休息 |
| 复测选题 | 到期判定、知识点均衡、题量上限、无题提示 |
| 报告指标 | 复测按时率（含"不适用"）、薄弱点排序门槛、七日趋势数据聚合 |
| AI 层 | mock fetch：成功/超时/畸形响应降级/配额/未配置灰态；Key 不入导出 |
| 备份 v2 | 新表 round-trip、凭证剔除、v1 文件兼容导入 |
| 脚本泛化 | 七下题数/词数、幂等、防漂移 |
| PIN | 门禁路径、跳过路径（报告等只读页不受限） |

## 10. 验收（完成定义）

1. 连续 7 天模拟数据（测试注入或手动改日期）能生成可追溯的下周计划与复测排期（总纲 M2 完成定义）
2. 错题首错次日出现在到期复习，复测正确 3 天后再现，间隔 1/3/7/14 天递进可复现
3. 报告页出现七日趋势图、三个薄弱点、复测按时率；词汇题显示正常题干
4. 家长 PIN 门禁生效；试卷成绩录入后报告页可见
5. 七下四专项与两册词汇可选可练；转换脚本幂等零漂移
6. 配置百炼 Key 后：练习页 AI 讲解/提示、周报 AI 建议真实可用（此条由用户拿 Key 后实测，开发期以 mock 验证链路）；未配置/断网/超时全链路不崩
7. 备份导出不含 Key/PIN；v1 旧备份可导入
8. `test:app` 全绿；构建零漂移；原站 CI 不受影响

## 验收记录（2026-11-17，M2+M3 实施完成）

**验收基线：** 提交 `468f99b`（实施全部完成后的 HEAD）；验收过程中未改动任何源码（工作区始终 clean）。
**验收方法：** Playwright 真实浏览器（Vite dev server）+ raw IndexedDB 直写注入"隔日/多日"数据（改 attempts/mastery/tasks 行的日期字段，不改系统时钟）；练习、报告、设置、备份均走真实 UI 操作路径。第 6 条以 `window.fetch` 覆盖 mock 百炼响应验证降级链（开发期约定方式），真实 Key 实测留待用户。

### 逐条结果（对照 §10）

1. **连续多日数据 → 通过。** 注入 6 个本地日（11-11～11-16）15 条 attempts、4 行 mastery、19 行往日 tasks；打开今日页（11-17，学习日）生成计划：review（4 题 = 昨日 deferred 结转 `g7a-articles-l1-0003/0004` + 到期复测 `0001/0002`）+ unit（当前单元词汇）+ special（薄弱聚合选中"名词与所有格"）+ summary；同日重复打开任务 id 逐行一致（按 `day` 查重幂等）。
2. **间隔复测状态机 → 通过。** 首错 → `weak`/intervalDays 1/次日本地零点（UTC ISO 存储）；次日今日页出现"到期复习 1 题"卡；复测正确依次 1→3→7→14 天递进（3 档 `consolidating`，7→14 档 `mastered`，nextReviewAt `2026-11-30T16:00:00Z` 即 12-01 本地零点）；`mastered` 后到期复测错 → 回退 `weak`/1 天/次日；同日当场重试不推进（attempts phase `first`/`retry` 佐证）。
3. **报告页增强 → 通过。** 七日趋势内联 SVG（7 柱 + 折线）；三个薄弱点（the / possessive-form / 词汇·Unit 1，各 67% 首测错误率，首测 ≥3 次门槛生效）；复测按时率 75%（有数据）与"不适用"（干净上下文、到期数 0）两态均验证；易错词与错题本显示解析后题干（如"默写：招呼；问候（v.）"）与单词 greet/unit，不再出现原始 questionId。
4. **PIN 与试卷成绩 → 通过。** 设置 PIN 后修改每日时长（35→40）触发 PIN 门禁行内卡；错 PIN 提示"PIN 不正确。"拒绝；对 PIN 通过且 DB `dailyMinutes=40` 落库；录入试卷"语法 12/15、词汇 8/10"后报告页出现"试卷成绩（手工录入）"卡，标注手工录入、不参与自动指标。
5. **七下四专项 + 两册词汇 → 通过（含保留项）。** 8 个专项（g7a-present/nouns/numbers/articles、g7b-adjadv/nouns/pronouns-modals/tenses）经 `#/exercise?set=<id>` 各进入并提交 1 题，判分反馈与 attempts 落库（题 id 与专项前缀一致，如 `g7b-tenses-l1-0008`）；`#/exercise?vocab=v1-u1`、`?vocab=v2-u1` 各完成 1 题默写（标题"单词默写 · Starter Unit 1"/"单词默写 · Unit 1"）；设置页册别切换 g7a→v1-u1…u10、g7b→v2-u1…u8 正确联动。脚本幂等零漂移由 Vitest 播种/防漂移测试与构建零漂移佐证。**保留项：** 今日页经 Task 6 改版为任务清单后不再有八专项自由练习入口卡（M1 版曾有），自由选择专项目前仅经 URL 参数 `?set=` 或计划生成的专项卡进入——功能可用但入口隐蔽，登记为后续 UX 待办，非功能缺陷。
6. **AI 接入 → 自动化部分通过，真实 Key 待用户实测。** 开发期以 mock fetch + 假 Key `sk-test-fake-key-0000`（掩码 `sk-****0000`）验证全链路：网络失败 → "网络不可用，请检查网络后重试。"+ 重试按钮，重试成功后 AI 提示渲染且每题一次（按钮移除）；HTTP 500 → "AI 服务出错，请稍后再试。"；挂起 20.5s → "AI 响应超时，请重试。"（aiRequests latencyMs 20501）；周报 AI 建议失败重试成功后四段渲染、`weeklyReports` 存档（weekStart 2026-11-16）且历史周报可回看；`aiEnabled` 关闭/未配置 Key 时按钮灰态（title"已在设置页关闭 AI"/"未配置 AI（设置页）"）；一切 AI 失败不影响做题、判分、attempts/mastery 落库与备份（降级链 §7.4）；`aiRequests` 仅记 type/status/latencyMs。配额与提示词转义由 Vitest 单测覆盖。**真实百炼 Key + qwen-flash 实测：待用户本人经设置页录入后验证练习页 AI 讲解/提示与周报 AI 建议。**
7. **备份红线 → 通过。** 导出 v2 JSON 全文（UI 与磁盘文件双检）无 `aiApiKey`/`parentPin`/Key 字符串/PIN 值；各表 counts 与 DB 实际行数一致；v1 备份（schemaVersion 1 夹具）经 UI 导入走 PIN 门禁 → 预览 → 合并导入（"新增作答 1 条"，本地已有记录保留不覆盖）；导入确认前自动触发安全备份下载。
8. **测试与构建 → 通过。** `npx vitest run`：19 个测试文件 320 个用例全绿；`npm run build` 成功（40 模块）且构建后 `git status` 零漂移；全程未触碰原站 content/ 与 CI 相关文件。

### 密钥红线核对

真实 API Key 在整个实施与验收过程中未进入任何代码、文档、命令或备份文件；验收仅使用假 Key `sk-test-fake-key-0000`，真实 Key 实测由用户在浏览器设置页自行录入。

### 结论

§10 八项中 1–5、7、8 共 7 条通过（第 5 条含"今日页八专项自由入口"保留项）；第 6 条降级链与灰态经 mock 全链路验证通过，真实 Key 联通性待用户实测。
