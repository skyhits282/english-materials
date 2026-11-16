# M0+M1 本地核心 · 设计规格

**日期：** 2026-11-16
**上游文档：** `初中英语AI学习助手_设计文档_V1.0.md`（位于 `/data/svn/learn/`，总纲）
**本轮范围：** M0（内容审计与题库转换）+ M1（本地核心：外壳、IndexedDB、设置、题目引擎、答题日志、备份）

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| 本轮范围 | M0 + M1，本地核心；不含 SW 离线、计划调度、错题复测排期、AI |
| 前端技术 | Vite + TypeScript 原生（无框架） |
| 首批题库 | 七上四专项（present/nouns/numbers/articles）+ 七上词汇默写 |
| 路由 | hash 路由（`#/today` 等） |
| 构建边界 | Vite 只产出 `app/`，原站文件零改动（`index.html` 仅加入口链接） |

## 1. M0：内容审计结论与题库转换

### 1.1 审计结论（2026-11-16 实查）

- 仓库 25 个专项目录含同构 `data.js` 题库，格式 `{id, level, stem, options, answer, explain}`，其中七上相关 4 个：
  `g7a-present`（48 题/6 级）、`g7a-nouns`、`g7a-numbers`、`g7a-articles`，合计约 190 题。
- `typing/data/v1.js` 含七上全部词汇（`window.TYPING_VOL`，按单元组织，含 word/ipa/pos/meaning/mnemonic）。
- 全站页面引用 `/sw-register.js` 与 `/icons/…`，但二者不存在于仓库；manifest 图标路径同样指向不存在的 `/icons/`（与总纲第 2 节疑虑一致，修复留给 M4）。
- 原站根 `package.json` 仅有 `htmlvalidate` / `lighthouse` 两个 CI 脚本，无构建链。

### 1.2 转换脚本 `scripts/extract-g7a.mjs`

- **输入**：上述 4 个 `data.js` + `typing/data/v1.js`（离线读取源文件，Node 运行，不联网）。
- **输出**至 `app-src/public/content/g7a/`：
  - `questions.json` — 标准化选择题（按总纲 6.2 节题目模型）
  - `vocab.json` — 七上词汇（含单元结构）
  - `content.json` — 内容版本与文件 hash 元数据（供 contentMeta 表比对）
- **ID 映射**（稳定、可复现）：专项内部 ID `P1-1` → `g7a-present-l1-0001`；知识点 `专项.级别` → 规范 ID，如 `grammar.present_simple.meaning`、`grammar.noun.plural`。
- **词汇默写题**：不从脚本生成静态文件，由应用内加载器按单元派生中→英填空题，`questionId` = `g7a-vocab-u1-0001`（词序固定，保证跨会话稳定可复测）。`answerSpec.acceptedAnswers` 含单词原形与 `variant` 字段变体。
- **校验输出**：脚本打印统计（题数、知识点数、缺失字段数）；抽取样例供人工核对。脚本必须可重复运行且幂等（相同输入产出相同 JSON，含稳定键序）。
- 禁止粗暴正则抽题；`data.js` 是结构化 JS，直接以模块方式求值解析。

## 2. M1：应用骨架

### 2.1 工程结构

```text
app-src/
├── index.html
├── vite.config.ts          # base: '/english-materials/app/'，dev 用 '/'
├── tsconfig.json
├── package.json         # 独立依赖（vite/vitest/dexie 等），与根 CI 依赖隔离
├── public/content/g7a/     # 转换脚本输出
└── src/
    ├── main.ts             # 入口：路由装配
    ├── router.ts           # hash 路由
    ├── pages/              # today / exercise / mistakes / report / settings
    ├── components/         # question-card 等
    ├── domain/
    │   ├── grader.ts       # 客观题判分（纯函数）
    │   └── metrics.ts      # 首测正确率等基础口径
    ├── db/                 # Dexie schema + repositories
    ├── content/            # 题库加载、默写题派生
    └── services/backup/    # 导出/校验/导入
```

根 `package.json` 新增代理脚本（`npm --prefix app-src run …`）：`dev:app`、`build:app`、`test:app`、`extract:g7a`（保留现有 CI 脚本不动）。`app-src/` 拥有独立 `package.json` 与 `node_modules`，与根目录 CI 依赖互不污染；转换脚本 `scripts/extract-g7a.mjs` 放仓库根 `scripts/`，由根脚本以 Node 直接运行。

### 2.2 路由

hash 路由：`#/today`（默认）、`#/exercise`、`#/mistakes`、`#/report`、`#/settings`。
理由：GitHub Pages 项目子路径无法做 History API 服务端重写（404.html hack 在 Safari PWA 冷启动不可靠）；hash 路由零服务器依赖。切独立域名时无需改路由。

### 2.3 页面（M1 形态，总纲 3.1 节的降级版）

| 页面 | M1 交付 |
|---|---|
| 今日学习 `#/today` | 选专项/单元开始练习的入口卡片；今日完成情况（题数/正确数） |
| 学习练习 `#/exercise?set=…` | 完整：大字号题干、选择题/填空交互、提交判分、显示解析、"我不会"（记错误 attempt） |
| 错题本 `#/mistakes` | 只读列表：按知识点/日期查看做错的题（从 attempts 推导） |
| 学习报告 `#/report` | 首测正确率、总练习量等基础指标（口径按总纲 7.5 节） |
| 家长设置 `#/settings` | 年级/当前单元/每日时长等，读写 settings 表；"AI 开关"仅保存配置不调用 |

M1 不做自动计划、间隔复测、家长 PIN（M2）；报告页无七日趋势图表（M2）。

### 2.4 数据库（Dexie，`EnglishCoachDB`）

按总纲第 8 节建全部 8 张表（含 M2/M3 用的 `tasks`、`weeklyReports`、`aiRequests`，字段即总纲定义），M1 实际读写：`settings`、`contentMeta`、`questions`、`attempts`、`mastery`。

- **attempts 只追加**：每次提交新增一条（`phase: first | retry`），首测错误后改对不覆盖（T02）。
- **mastery M1 简化**：仅记录 `testedCount`、`firstTryCorrect`、`lastAttemptAt`；`nextReviewAt` 与状态机留 M2。
- 时间存 UTC ISO 8601；"今日"按设备本地日历日计算。
- 题库 JSON 大文件经 fetch 读取（M4 后由 Cache Storage 承担离线），IndexedDB 的 `questions` 表存标准化题目索引与判分所需字段。

### 2.5 判分引擎 `domain/grader.ts`

- 选择题：比对 `correctOptionIndex`。
- 填空：规范化（去首尾空白、统一小写、折叠内部空白、半角标点变体）后比对 `acceptedAnswers` 列表。
- 纯函数、无 IO；Vitest 单测覆盖两题型与规范化边界。

### 2.6 备份 `services/backup/`

- 导出 `english-learning-backup-YYYYMMDD.json`：`schemaVersion`、导出时间、settings/questions/tasks/attempts/mastery/weeklyReports + 记录数校验和。
- 导入：先校验 `schemaVersion` 与字段类型 → 展示预计恢复记录数 → 选择覆盖/合并；合并按唯一 ID 去重且**不覆盖已存在记录**（attempts 历史不可改写）；导入前自动先导出当前数据做安全备份（存内存/让用户保存）。
- 不导出任何凭证（M1 无 AI，天然满足）。
- 测试：同一备份导入空白库后记录数与指标一致（T08）。

### 2.7 测试（Vitest + fake-indexeddb）

| 对象 | 覆盖点 |
|---|---|
| `grader.ts` | 选择题、填空规范化、同义答案 |
| 转换脚本 | 幂等性、题数、ID 稳定性、缺失字段告警 |
| repositories | attempts 只追加、settings 读写 |
| backup | round-trip 一致性、合并去重不覆盖 |
| metrics | 首测正确率口径（不含重答） |

## 3. 错误处理与边界

- 题库加载失败：页面显示明确错误与重试，不白屏。
- IndexedDB 不可用（隐私模式等）：提示"无法保存学习记录"，练习仍可做题（降级不崩溃）。
- 备份导入损坏文件：解析失败给出行级错误提示，不写入任何数据。

## 4. 验收（M0+M1 完成定义）

1. `npm run extract:g7a` 产出约 190 道选择题 + 七上词汇，重复运行输出一致。
2. `npm run dev:app` 本地可用：选练习→做题→提交→看到判分与解析。
3. 刷新/重开后答题记录仍在；做错后改对，首测仍记错。
4. 设置修改后持久；备份导出→清库→导入后数据与指标一致。
5. `npm run test:app` 全绿；`npm run build:app` 产物仅在 `app/`，原站 CI（htmlvalidate/lighthouse）不受影响。
