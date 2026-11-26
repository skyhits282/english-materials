# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库构成

两部分并存，改动时先分清对象：

1. **静态内容站**：根目录大量 HTML 材料目录（`g7a-present/`、`vocab-forms-g7a/`、`essays/` 等），源 LaTeX 在 `source/`，内容抽取脚本在 `scripts/`（`node --test "scripts/*.test.mjs"`）。
2. **SPA 学习应用**：源码在 `app-src/`（TypeScript + Vite + Vitest，无框架、手写 hash 路由），构建产物部署在 `app/`。

## 常用命令（都在仓库根目录跑）

```bash
npm run dev:app      # 启动 SPA 开发服务器（http://localhost:5173/english-materials/app/）
npm run test:app     # 全量测试（vitest）
npm run build:app    # tsc --noEmit + vite build（同时做类型检查）
npm run htmlvalidate # 静态 HTML 校验
python scripts/check_site.py  # 站点结构/链接/标签平衡自检（CI 同款）
```

跑单个测试文件**必须 cd app-src**（在根目录跑 vitest 会误抓 `scripts/*.test.mjs`）：

```bash
cd app-src && npx vitest run src/content/special-units.test.ts
```

测试与源码同目录（`*.test.ts`）；DB 层测试用 fake-indexeddb。

## 部署（重要约定）

GitHub Pages 从 **main 分支根目录**直接提供静态站点。`app/` 构建产物**会提交**，但只在独立的 `build(app):` 提交里更新——**功能提交不更新 app/ 产物**，部署时再 `npm run build:app` 重建并单独提交。改完功能跑构建验证后要 `git checkout -- app/ && git clean -fdq app/` 恢复工作区。

推送目标：`origin`（github.com/skyhits282/english-materials，用户自己的仓库，Pages 由它服务）；`upstream` 是原始仓库，一般不推。Pages 缓存 `max-age=600`。

## SPA 架构要点（读多个文件才能拼出的全貌）

- **持久化是 IndexedDB（Dexie），不是 localStorage**。settings 表单键 'app'，`getSettings()` 合并 DEFAULT_SETTINGS 兜底。新增 Settings 字段时须同步改 `services/backup/index.ts` 的 `validateSettingsRow`（宽松校验：可缺省，出现即须类型正确）。
- **两套"单元"模型，靠映射表桥接**：词汇教材单元 `v1-uN`（g7a，前 3 个是 Starter）/ `v2-uN`（g7b）与专项级别 `g7a-present-lN`（8 专项 × 6 级 × 8 题）。`app-src/src/content/special-units.ts` 的 `SPECIAL_LEVEL_UNLOCKS` 定义每个级别的解锁单元，`filterByUnlockedLevels` 按全序比较（v2 恒晚于 v1，学到七下自动解锁全部七上专项）；fail-open：解析失败/未映射 → 保留题目（回退全随机）。
- **专项出题范围过滤只在三处挂点**：`pages/exercise.ts`（DB 与 bundle 降级两条路径）、`db/repos.ts` 的 `getOrCreatePlan`（构建 specialQuestions）。到期复习/错题重练**不过滤**（只含做过的题）。`generatePlan`（`domain/plan.ts`）是纯函数，过滤一律在调用方做。
- **每日计划是当日快照**：`getOrCreatePlan` 按 day 查重不重建，当日改设置次日生效；今日页"数据优先"——已生成的任务不被休息页遮蔽。`isPlanIncomplete(tasks, specialExpected)` 判残缺时注意进度 0 解锁会让专项任务合法缺席。
- **`domain/` 全是纯函数**（计划、间隔复习、判卷、指标），IO 在 `db/repos.ts`；页面（`pages/`）是粘合层，仓库惯例靠测试 + 构建验证，无 DOM 测试。
- **每周学习日**是 `Settings.studyDays: number[]`（周一=0…周日=6，支持非连续组合），默认周一至周四 + 周六周日（`DEFAULT_STUDY_DAYS`）。旧字段 `studyDaysPerWeek` 已废弃，仅备份导入时在 `migrateSettingsRows` 按旧语义（周一起连续 N 天）映射。
- **红线**：AI 输出一律 escapeHtml 后再入 DOM；备份导出剔除 `aiApiKey` 与 `parentPin`（密钥只存本机）。设置页保存/导入备份有 PIN 门（`domain/pin.ts`）。

## 提交与流程约定

- Conventional Commits，type/scope 英文、subject 中文（如 `feat(app): …`、`build(app): …`、`test(app): …`、`docs: …`）。
- 功能开发走 TDD：先写失败测试（vitest）再实现；提交前 `npm run test:app` + `npm run build:app` 全绿。
- 功能规格与实施计划放在 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`，历史功能都有对应文档可参考口径。
- 映射表 `SPECIAL_LEVEL_UNLOCKS` 属内容数据（家长按教材校对后直改该表，逻辑不动）；改后需重建 app/ 产物再提交。
