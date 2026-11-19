# 每日计划 · 结转丢题修复（carryover fix）设计规格

**日期：** 2026-11-19
**上游：** M0-M1/M2-M3 已完成；本规格修复 M2 待办汇总登记的两处同族结转缺陷
**范围：** ① 结转只回看恰好"昨天"一日丢 deferred；② `studyDaysPerWeek` 中途调小致当日已生成任务被休息页遮蔽且永不结转

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| 缺陷①回溯范围 | **逐日回溯至最近有任务日**：从今日往前 14 天护栏窗口内，取最近一个有任务行的日子的 `deferred` 任务 |
| 缺陷②处理 | **数据优先**：今日页当日已有任务行则照常显示任务卡，休息判定只决定"无任务时是否生成新计划" |
| skipped 语义 | 保持现状不结转（仅 `deferred` 结转，`generatePlan` 消费逻辑不动） |
| 防重复结转 | 只取最近有任务日的 deferred，**不再往前看**（更早的已被更近一次计划生成消费） |
| 回溯护栏 | `CARRY_LOOKBACK_DAYS = 14`：超过 14 天无任务行则视为放弃，不结转 |

## 1. 缺陷①：结转回溯（`db/repos.ts` + `domain/plan.ts`）

### 1.1 现状与问题

`getOrCreatePlan`（`db/repos.ts:245`）生成新计划前只查恰好一日之前的 `yesterdayKey`：周六 `deferred`、周日休息（无任务行）→ 周一查周日扑空，周六的 deferred 永久丢失。多日未打开 App 时同样丢失。

### 1.2 新逻辑

- **查询**：`db.tasks.where('day').between(窗口起点, dayKey, true, false)` 一次索引查询取 14 天窗口内全部任务行（每天 ≤4 行，量极小）。
- **挑选**：新纯函数 `pickCarrySource(priorTasks: TaskRow[], todayKey: string): TaskRow[]`（放 `domain/plan.ts`，无 IO 可单测）：
  1. 按 `day` 降序找第一个有任务行的日子（最近有任务日）；
  2. 返回该日 `status === 'deferred'` 的任务；该日无 deferred 则返回空（更早的日子不看）；
  3. 窗口内没有任何任务行 → 返回空。
- `generatePlan` 不动：仍只消费 deferred（`yesterdayUnfinished` 参数语义放宽为"结转来源任务"，改名 `carrySourceTasks`）。
- 删除 `repos.ts:251-253` 的「已知边界」注释（边界已修复）。

### 1.3 边界与不变量

- 窗口起点为 `todayKey - 14 天`（含当日 14 天前的行；晚于今日的行不存在，可不特判）。
- deferred 仍是终态：结转不回改旧行状态，靠"只取最近有任务日"防同一批题重复编入复习段。
- 同日二次调用 `getOrCreatePlan` 走 `existing` 短路返回，回溯只在新计划生成时执行一次（幂等现状保持）。
- 非学习日仍返回 `[]` 不生成新任务（现状保持）。

## 2. 缺陷②：今日页数据优先（`pages/today.ts`）

### 2.1 现状与问题

今日页在读取当日任务之前按 `isStudyDay(today, settings.studyDaysPerWeek)` 短路成休息页：周中把 `studyDaysPerWeek` 调小后，当日已生成的任务被遮蔽（当天不可练），且次日结转也查不到（同族丢结转）。

### 2.2 新逻辑

调整 `renderPage` 顺序：**seed → `getOrCreatePlan` → 再判定**：

- `tasks.length > 0`：照常显示任务卡（即使当日按新设置已是休息日）——已生成的计划被遵守。
- `tasks.length === 0` 且非学习日：显示休息页（明日预告、今日已练、自由练习卡等内容原样保留）。

`getOrCreatePlan` 此路径无需改动：它先查 `existing`，当日已有任务直接返回，不会因休息日重新生成。两处修复自然衔接：设置调小后当日任务照常可练；用户手动推迟的任务由新回溯逻辑结转到下一个学习日。

## 3. 测试口径（TDD）

- `domain/plan.ts` 纯函数单测（`pickCarrySource`）：多日窗口取最近有任务日；空窗口返回空；最近日无 deferred 返回空（不看更早）；deferred/skipped 混合只取 deferred；恰好 14 天边界（含/不含）；跨月日期（`YYYY-MM-DD` 字典序直接比较，跨月天然正确）。
- `db/repos.ts` 集成测试（fake-indexeddb）：周六 deferred + 周日无任务 → 周一生成计划 review 段含周六 deferred 的题；连续多日缺勤 → 取最早可见的最近有任务日；同日二次调用不重复结转；休息日仍不生成新任务。
- `pages/today.ts` 组件级测试：当日有任务 + `studyDaysPerWeek` 调小 → 显示任务卡不显示休息页；当日无任务 + 非学习日 → 休息页原样。（验收期替代口径：仓库无 DOM 级页面测试惯例，已将休息判定抽为 `shouldShowRest` 纯函数（`domain/plan.ts`）并以 `plan.test.ts` 单测固化上述两场景；浏览器手工验收见验收记录场景 B/C。）

## 验收记录（2026-11-19）

按 §3 与计划 Task 4 逐项实测（Playwright MCP 文本断言 + Vitest；本会话模型不支持图片模态，全程未用截图；dev 服务器实际 base 为 `/english-materials/app/`，根路径 302 跳转至该地址）：

1. **全量测试**：`npm run test:app` 全绿——23 个测试文件、**375 个用例**（基线 361 + 本次新增 14：plan 9 + repos 5）；`npm run test:extract` **9/9**（「已提交产物与提取结果逐字节一致（防漂移）」通过，构建产物链路未被波及）。
2. **场景 A——缺陷①回溯结转**（真实浏览器）：首次打开 `#/today` 正常渲染「今日学习」（2026 年 11 月 19 日 周四），仅 favicon 404 控制台噪声。原始 IndexedDB 操作删除当日全部任务行，并写入 `task-2026-11-17-unit`（`day=2026-11-17`，`status=deferred`，`questionIds=['carry-demo-1','carry-demo-2']`）；11-18 无任务行。经 `#/settings` → `#/today` 重渲染后：「到期复习」卡存在（3 题 · 10 分钟）；读回 `task-2026-11-19-review` 实测 `questionIds=['carry-demo-1','carry-demo-2','g7a-present-l2-0007']`、`status='planned'`——回溯跳过无任务的 11-18、命中 11-17 并把 deferred 题编入复习段，断言全部通过。随后复位删除 review 行与 planted 行。
3. **场景 B——缺陷②数据优先**：读回 settings `app` 行并临时置 `studyDaysPerWeek = (getDay()+6)%7 = 3`（周四在周一起始序为休息日；原值字段未显式存在，previous 为 undefined，其余字段与 `updatedAt` 原样保留）。经 `#/settings` → `#/today` 重渲染后：页面仍显示任务卡「单词默写」（Unit 1 · 17 词）、「一般现在时与句子种类」（9 题）、「学习小结」，页头「任务 0/3 已完成」；「今日休息」文本不存在——已生成计划不被休息判定遮蔽，断言通过（当日 review 行已在场景 A 复位删除，故以其余任务卡断言）。
4. **场景 C——休息页原样**：删除当日全部任务行（special/summary/unit 三条），经 `#/settings` → `#/today` 重渲染后：「今日休息」标题存在（2026 年 11 月 19 日 · 周四，明日继续休息），「自由练习（可选）」卡存在（不计入今日任务与完成进度，含「单词默写」按钮），休息页内容完整。收尾复位 `studyDaysPerWeek = 6` 并确认当日任务行为空（库保持干净）。
5. **构建验证与产物恢复**：`npm run build:app` 成功（tsc 无错，vite 48 modules）；构建后 `app/` 出现预期漂移——删除 `app/assets/index-C7MPOkgj.js`、修改 `app/index.html`、新增 `app/assets/index-BgtdrCTk.js`；按功能提交口径执行 `git checkout -- app/ && git clean -f app/assets` 恢复，`git status --porcelain app/` 输出为空。dev 服务器（5199 端口）验证完成后已停止，端口无监听。

**验证偏差备忘**：计划中浏览器地址写作 `http://localhost:5199/#/today`，实际 vite base 为 `/english-materials/app/`，根路径 302 至该 base；验证统一使用 `http://localhost:5199/english-materials/app/#/...`，路由行为与断言结果不受影响。
