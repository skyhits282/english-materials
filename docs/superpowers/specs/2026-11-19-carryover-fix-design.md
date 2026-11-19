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
- `pages/today.ts` 组件级测试：当日有任务 + `studyDaysPerWeek` 调小 → 显示任务卡不显示休息页；当日无任务 + 非学习日 → 休息页原样。
