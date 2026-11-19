# 结转丢题修复（carryover fix）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两处同族结转丢题——① `getOrCreatePlan` 结转只回看恰好"昨天"一日；② `studyDaysPerWeek` 中途调小致当日已生成任务被休息页遮蔽且永不结转。

**Architecture:** 纯函数 `pickCarrySource`/`carryWindowStart`（`domain/plan.ts`，14 天护栏窗口内取最近有任务日的 deferred）→ `getOrCreatePlan`（`db/repos.ts`）一次范围索引查询接入 → 今日页（`pages/today.ts`）改为"数据优先"（当日有任务行则显示任务卡，休息判定只决定无任务时是否生成新计划）。

**Tech Stack:** Vite + TypeScript（无框架）、Vitest + fake-indexeddb、Dexie（IndexedDB，库名 `EnglishCoachDB`）。

**规格：** `docs/superpowers/specs/2026-11-19-carryover-fix-design.md`

**红线（全程有效）：**
- 任何 API Key 真实值绝不写入任何文件、代码、测试、文档或提交；测试一律用假 Key `'sk-test-fake-key-0000'`（本计划不涉及 AI 层，预计无新 Key 引用）。
- 浏览器验证**禁止 take_screenshot**（本会话模型 text-only，screenshot 会 400 杀死会话）；只允许 `browser_snapshot` / `browser_find` / `browser_evaluate` 文本断言。
- `app/` 构建产物按任务提交时**不更新**，部署时重建（既有口径）；构建验证后必须恢复 `app/` 工作区。
- 提交信息中文、conventional-commit 前缀，结尾必须有：
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`

**测试命令：**
- 单文件：`cd app-src && npx vitest run src/domain/plan.test.ts`（repos 同理）
- 全量：`npm run test:app`（仓库根）
- 题库提取回归（不应受影响）：`npm run test:extract`

**日期事实（测试用，均已核实）：** 2026-11-14 周六、11-15 周日、11-16 周一、11-17 周二、11-18 周三、11-19 周四、11-21 周六、11-22 周日、11-23 周一。`localDayKey`（`domain/metrics.ts`）输出零填充 `YYYY-MM-DD`，字典序即时间序——day 索引范围查询与字符串比较均安全。

---

### Task 1: `pickCarrySource` / `carryWindowStart` 纯函数（`domain/plan.ts`）

**Files:**
- Modify: `app-src/src/domain/plan.ts`（新增导出，`generatePlan` 不动）
- Test: `app-src/src/domain/plan.test.ts`

- [x] **Step 1: 写失败测试**

在 `app-src/src/domain/plan.test.ts` 顶部 import 中加入三个新导出（`generatePlan` 等保持不变）：

```ts
import {
  CARRY_LOOKBACK_DAYS,
  carryWindowStart,
  generatePlan,
  isStudyDay,
  pickCarrySource,
  PLAN_RATIO,
  SPECIAL_QUESTION_MAX,
  UNIT_QUESTION_MAX,
  type PlanContext,
} from './plan'
```

在文件末尾（`generatePlan：任务行形状` describe 之后）追加：

```ts
/** 任务行 fixture：id/day/type/questionIds/status 一次成型 */
const taskRow = (day: string, type: TaskRow['type'], status: TaskRow['status'], ids: string[]): TaskRow => ({
  id: `task-${day}-${type}`,
  day,
  type,
  questionIds: ids,
  status,
  minutesPlanned: 10,
})

describe('carryWindowStart（回溯窗口起点，含当日 14 天前）', () => {
  it('常量 14 天；起点 = todayKey - 14（跨月正确）', () => {
    expect(CARRY_LOOKBACK_DAYS).toBe(14)
    expect(carryWindowStart('2026-11-17')).toBe('2026-11-03')
    expect(carryWindowStart('2026-03-05')).toBe('2026-02-19') // 2 月 28 天，跨月
  })
})

describe('pickCarrySource（结转回溯：窗口内最近有任务日的 deferred）', () => {
  it('最近有任务日的 deferred 结转（中间隔无任务日也取得到）', () => {
    const rows = [taskRow('2026-11-14', 'unit', 'deferred', ['a']), taskRow('2026-11-16', 'special', 'deferred', ['b'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.questionIds)).toEqual([['b']])
  })

  it('最近有任务日无 deferred → 不看更早日子（其 deferred 已被更近一次计划生成消费）', () => {
    const rows = [taskRow('2026-11-14', 'unit', 'deferred', ['a']), taskRow('2026-11-16', 'special', 'skipped', ['b'])]
    expect(pickCarrySource(rows, '2026-11-17')).toEqual([])
  })

  it('同日 deferred/skipped 混合只取 deferred', () => {
    const rows = [taskRow('2026-11-16', 'special', 'skipped', ['s']), taskRow('2026-11-16', 'unit', 'deferred', ['d'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.type)).toEqual(['unit'])
  })

  it('空窗口 / 全部早于窗口起点 → 返回空', () => {
    expect(pickCarrySource([], '2026-11-17')).toEqual([])
    expect(pickCarrySource([taskRow('2026-10-01', 'unit', 'deferred', ['a'])], '2026-11-17')).toEqual([])
  })

  it('当日行不参与结转（day 严格小于 todayKey）', () => {
    expect(pickCarrySource([taskRow('2026-11-17', 'unit', 'deferred', ['today-1'])], '2026-11-17')).toEqual([])
  })

  it('窗口含恰 14 天前的行、不含 15 天前', () => {
    const rows = [taskRow('2026-11-02', 'unit', 'deferred', ['out']), taskRow('2026-11-03', 'unit', 'deferred', ['in'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.questionIds)).toEqual([['in']])
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd app-src && npx vitest run src/domain/plan.test.ts`
Expected: FAIL——导入报错（`CARRY_LOOKBACK_DAYS` 等不存在于 `./plan` 导出）。

- [x] **Step 3: 最小实现**

`app-src/src/domain/plan.ts` 顶部 import 区（`import { deriveVocabQuestions } from '../content/loader'` 之后）加：

```ts
import { localDayKey } from './metrics'
```

在 `isStudyDay` 函数之后追加：

```ts
/** 结转回溯窗口（天）：超出视为放弃，防全历史扫描（规格 §1.2） */
export const CARRY_LOOKBACK_DAYS = 14

/** 结转回溯窗口起点（含）：今日往前 CARRY_LOOKBACK_DAYS 天的本地日 key */
export function carryWindowStart(todayKey: string): string {
  const [y, m, d] = todayKey.split('-').map(Number)
  return localDayKey(new Date(y!, m! - 1, d! - CARRY_LOOKBACK_DAYS))
}

/** 结转来源挑选（规格 §1.2）：窗口行里最近一个有任务日的 deferred 任务；
 *  更早的日子不看（其 deferred 已被更近一次计划生成消费），当日行不参与。
 *  纯函数无 IO：调用方负责传入窗口内任务行。 */
export function pickCarrySource(priorTasks: TaskRow[], todayKey: string): TaskRow[] {
  const start = carryWindowStart(todayKey)
  const before = priorTasks.filter((t) => t.day >= start && t.day < todayKey)
  if (before.length === 0) return []
  const latestDay = before.reduce((max, t) => (t.day > max ? t.day : max), before[0]!.day)
  return before.filter((t) => t.day === latestDay && t.status === 'deferred')
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd app-src && npx vitest run src/domain/plan.test.ts`
Expected: PASS（原有用例 + 新增 8 条全绿）。

- [x] **Step 5: 提交**

```bash
git add app-src/src/domain/plan.ts app-src/src/domain/plan.test.ts
git commit -m "feat(app): 结转回溯纯函数 pickCarrySource（14 天窗口内最近有任务日的 deferred）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `getOrCreatePlan` 接入回溯 + `PlanContext.yesterdayUnfinished` 改名 `carrySourceTasks`

**Files:**
- Modify: `app-src/src/db/repos.ts:242-277`（`getOrCreatePlan` 结转查询重写，删除「已知边界」注释）
- Modify: `app-src/src/domain/plan.ts`（`PlanContext` 字段改名）
- Modify: `app-src/src/domain/plan.test.ts`（改名同步 + 结转 describe 更名）
- Test: `app-src/src/db/repos.test.ts`（`getOrCreatePlan` describe 内追加）

- [x] **Step 1: 写失败测试**

在 `app-src/src/db/repos.test.ts` 的 `describe('getOrCreatePlan（每日计划生成 repo 封装）', ...)` 内（`review 段与 Task 4 引擎联动` 用例之后）追加三个用例：

```ts
  it('缺陷①：周六 deferred + 周日休息（无任务行）→ 周一计划仍结转（回溯跳过无任务日）', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    // 2026-11-21 周六 deferred；11-22 周日休息无任务行；今日 11-23 周一（学习日）
    await db.tasks.put({
      id: 'task-2026-11-21-unit',
      day: '2026-11-21',
      type: 'unit',
      questionIds: ['sat-1', 'sat-2'],
      status: 'deferred',
      minutesPlanned: 14,
    })
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, at(2026, 11, 23))
    const review = tasks.find((t) => t.type === 'review')
    expect(review?.questionIds).toEqual(['sat-1', 'sat-2'])
  })

  it('回溯只取最近有任务日：更近日子全部 skipped → 不再看更早的 deferred', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    // 最近有任务日 11-18（周三，仅 skipped）；更早 11-16 deferred 不看（已消费）
    await db.tasks.bulkPut([
      { id: 'task-2026-11-18-special', day: '2026-11-18', type: 'special', questionIds: ['skip-1'], status: 'skipped', minutesPlanned: 7 },
      { id: 'task-2026-11-16-unit', day: '2026-11-16', type: 'unit', questionIds: ['older-1'], status: 'deferred', minutesPlanned: 14 },
    ])
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, at(2026, 11, 19))
    expect(tasks.find((t) => t.type === 'review')).toBeUndefined()
    for (const t of tasks) expect(t.questionIds).not.toContain('older-1')
  })

  it('回溯窗口边界：14 天前（含）结转、15 天前（不含）放弃', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    // 今日 11-17：窗口起点 11-03（含）；11-02 在窗外
    await db.tasks.bulkPut([
      { id: 'task-2026-11-03-unit', day: '2026-11-03', type: 'unit', questionIds: ['in-1'], status: 'deferred', minutesPlanned: 14 },
      { id: 'task-2026-11-02-unit', day: '2026-11-02', type: 'unit', questionIds: ['out-1'], status: 'deferred', minutesPlanned: 14 },
    ])
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, at(2026, 11, 17))
    expect(tasks.find((t) => t.type === 'review')?.questionIds).toEqual(['in-1'])
  })
```

- [x] **Step 2: 运行确认失败**

Run: `cd app-src && npx vitest run src/db/repos.test.ts`
Expected: FAIL——`缺陷①` 与 `窗口边界` 两条用例失败（现状只查恰昨日：周一查周日无行 → review undefined；11-02/11-03 都在"昨日=11-16"之外 → 同样 review undefined）。`回溯只取最近有任务日` 可能恰好通过（现状查 11-18 取到 skipped → generatePlan 无结转），属预期。

- [x] **Step 3: 实现（repos.ts + 两处改名）**

`app-src/src/db/repos.ts`：

1. 顶部 `import { generatePlan, isStudyDay, ... } from '../domain/plan'` 处（现为 `import { generatePlan, isStudyDay } from '../domain/plan'`，按实际行调整）改为：

```ts
import { carryWindowStart, generatePlan, isStudyDay, pickCarrySource } from '../domain/plan'
```

2. `getOrCreatePlan` 中删除整段（原 244-256 行附近：函数 docstring 里的"昨日 deferred/skipped 任务一并传入"句、「已知边界」注释两行、`yesterdayKey` 与 `yesterdayUnfinished` 计算），替换为：

```ts
  const settings = await getSettings()
  // 结转回溯（规格 §1.2）：14 天窗口内最近一个有任务日的 deferred（更早的已被消费）
  const windowTasks = await db.tasks
    .where('day')
    .between(carryWindowStart(dayKey), dayKey, true, false)
    .toArray()
  const carrySourceTasks = pickCarrySource(windowTasks, dayKey)
```

3. `generatePlan({...})` 调用里的 `yesterdayUnfinished,` 改为 `carrySourceTasks,`。

4. `getOrCreatePlan` 的 docstring 改为：

```ts
/** 每日计划（规格 §2.1）：当日（本地日 key）无任务才生成，同一天重复打开不重建（按 day 查重）。
 *  review 段取 Task 4 引擎（getReviewSet）产出；结转来源（回溯窗口内最近有任务日的
 *  deferred）一并传入，deferred 由 generatePlan 优先编入复习段（skipped 不结转）；now 可注入（测试与跨日边界用）。 */
```

`app-src/src/domain/plan.ts`：`PlanContext` 字段改名（注释同步放宽语义）：

```ts
  /** 结转来源任务（回溯窗口内最近有任务日的 deferred/skipped；deferred 结转、skipped 不结转） */
  carrySourceTasks: TaskRow[]
```

`generatePlan` 体内 `for (const task of ctx.yesterdayUnfinished)` 改为 `for (const task of ctx.carrySourceTasks)`；其上方注释「结转：昨日 deferred 的题优先编入复习段」改为「结转：来源 deferred 的题优先编入复习段」。

`app-src/src/domain/plan.test.ts`：`ctx` fixture 中 `yesterdayUnfinished: []` → `carrySourceTasks: []`；`describe('generatePlan：昨日结转', ...)` 三处 `yesterdayUnfinished:` 改为 `carrySourceTasks:`（describe 标题改为 `generatePlan：结转`）。

- [x] **Step 4: 运行确认通过（含全量回归）**

Run: `cd app-src && npx vitest run src/db/repos.test.ts src/domain/plan.test.ts`
Expected: PASS（含既有「昨日 deferred 结转为今日 review 任务」用例——昨日即最近有任务日，行为不变）。

Run: `npm run test:app`
Expected: PASS 全绿（361 + 新增用例）。

- [x] **Step 5: 提交**

```bash
git add app-src/src/db/repos.ts app-src/src/domain/plan.ts app-src/src/domain/plan.test.ts app-src/src/db/repos.test.ts
git commit -m "feat(app): 结转改为回溯至最近有任务日（14 天窗口），修复周六 deferred 周日休息丢结转

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 今日页数据优先（`pages/today.ts`，缺陷②）

**Files:**
- Modify: `app-src/src/pages/today.ts:98-119`（休息分支移到计划生成之后并收紧条件）

说明：本页无 DOM 级 vitest 惯例（页面行为按既有口径由 Task 4 浏览器验证覆盖），本任务以全量回归 + 浏览器验收保障。

- [x] **Step 1: 实现顺序调整**

删除 `today.ts` 中现有休息分支（`// 非学习日（规格 §2.1）：不生成任务，显示"今日休息"与明日预告` 起至其 `return` 结束，原 98-119 行整块），并在 `if (stale) return`（getOrCreatePlan 成功之后那处，原 140 行）之后、`const todayAttempts = ...` 之前插入同块内容，条件改为 `tasks.length === 0 && !isStudyDay(...)`：

```ts
  // 非学习日（规格 §2.1 数据优先）：仅当日无任务时显示"今日休息"——中途调小
  // studyDaysPerWeek 后当日已生成任务照常显示（结转丢题修复缺陷②），不遮蔽不丢失
  if (tasks.length === 0 && !isStudyDay(today, settings.studyDaysPerWeek)) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStudy = isStudyDay(localDayKey(tomorrow), settings.studyDaysPerWeek)
    const todayAttempts = attempts.filter((a) => isSameLocalDay(a.submittedAt, today))
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = `
      <h1>今日学习</h1>
      <div class="card">
        <h3>今日休息</h3>
        <p>${dateLabel}</p>
        <p>${tomorrowStudy ? `明日恢复学习，预计 ${settings.dailyMinutes} 分钟。` : '明日继续休息。'}</p>
      </div>
      ${todayAttempts.length > 0 ? `<div class="card"><h3>今日已练 ${todayAttempts.length} 题</h3><p>休息日练习不计入任务。</p></div>` : ''}
      <div class="card">
        <h3>自由练习（可选）</h3>
        <p>不计入今日任务与完成进度。</p>
        <div class="action-row"><button class="btn btn-secondary" id="free-vocab">单词默写</button></div>
      </div>`
    container.querySelector('#free-vocab')?.addEventListener('click', () => navigate('exercise', { vocab: settings.currentUnit }))
    return
  }
```

（块体内容与原休息分支逐字相同，仅外层条件与位置变化；`now/today/dateLabel/settings/attempts` 均在此前已就绪。）

行为说明（供执行者理解，不写代码）：休息日首次访问现在会先播种再返回 `[]`（原先不播种）；播种失败在休息页静默——`seedError` 面板在后续路径才渲染，此为接受的取舍。

- [x] **Step 2: 全量回归**

Run: `npm run test:app`
Expected: PASS 全绿（今日页无单测覆盖，确认无意外破坏）。

- [x] **Step 3: 提交**

```bash
git add app-src/src/pages/today.ts
git commit -m "feat(app): 今日页数据优先——当日已有任务时不再被休息页遮蔽（studyDaysPerWeek 中途调小）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + 浏览器验证 + 构建验证与验收记录

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-carryover-fix-design.md`（追加验收记录）

**红线重申：浏览器验证一律禁用 take_screenshot，只允许 browser_snapshot / browser_find / browser_evaluate 文本断言；同 hash URL 重复导航不会重渲染——切页必须先经 `#/settings` 再回 `#/today`。**

- [x] **Step 1: 全量测试**

Run: `npm run test:app && npm run test:extract`
Expected: 全绿；`test:extract` 9/9（防产物漂移用例确认未被波及）。

- [x] **Step 2: 启动 dev 服务器**

Run（后台）: `cd app-src && npx vite --port 5199 --strictPort`
Expected: 输出 `ready in` / Local: `http://localhost:5199/`。

- [x] **Step 3: 场景 A——缺陷①回溯结转（真实浏览器）**

1. `browser_navigate` → `http://localhost:5199/#/today`；`browser_find` 文本「今日学习」确认渲染（首次访问完成播种与当日计划生成）。
2. `browser_evaluate`：原始 IndexedDB 操作——删除当日全部任务行、写入两天前 deferred 任务行（返回写入结果摘要）：

```js
async () => {
  const two = new Date(); two.setDate(two.getDate() - 2)
  const key = `${two.getFullYear()}-${String(two.getMonth()+1).padStart(2,'0')}-${String(two.getDate()).padStart(2,'0')}`
  const today = new Date(); const tkey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
  const db = await new Promise((res, rej) => { const r = indexedDB.open('EnglishCoachDB'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => {
    const tx = db.transaction('tasks', 'readwrite')
    const store = tx.objectStore('tasks')
    const del = store.index('day') // day 为索引
    del.openKeyCursor(IDBKeyRange.only(tkey)).onsuccess = (e) => {
      const c = e.target.result
      if (c) { store.delete(c.primaryKey); c.continue() }
    }
    store.put({ id: `task-${key}-unit`, day: key, type: 'unit', questionIds: ['carry-demo-1', 'carry-demo-2'], status: 'deferred', minutesPlanned: 14 })
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error)
  })
  return { plantedDay: key, today: tkey }
}
```

3. `browser_navigate` → `#/settings`，再 `browser_navigate` → `#/today`（hash 切换触发重渲染）。
4. `browser_find` 文本「到期复习」→ 存在（今日计划生成时回溯结转成功）。
5. `browser_evaluate`：读回 `task-<today>-review` 行，断言 `questionIds` 含 `carry-demo-1/carry-demo-2` 且 `status === 'planned'`。
6. 复位：`browser_evaluate` 删除 `task-<today>-review` 行与 planted deferred 行（恢复干净状态，供场景 B/C）。

- [x] **Step 4: 场景 B——缺陷②数据优先**

1. `browser_evaluate`：改写 settings 行——读出 `settings` 存储 key `'app'` 的 value，置 `studyDaysPerWeek = (new Date().getDay() + 6) % 7`（今日按周一起始序恰好成休息日），put 回去；返回改写后的 studyDaysPerWeek。
2. `browser_navigate` → `#/settings` → `#/today`。
3. `browser_find` 文本「到期复习」或任务卡任意标题 → **存在**；`browser_find` 文本「今日休息」→ **不存在**（当日已有任务，休息页不遮蔽）。

- [x] **Step 5: 场景 C——休息页原样（无任务 + 非学习日）**

1. `browser_evaluate`：删除当日全部任务行（同场景 A 的 cursor 删除，仅删）。
2. `browser_navigate` → `#/settings` → `#/today`。
3. `browser_find` 文本「今日休息」→ 存在；「自由练习」→ 存在（休息页内容完整）。
4. 收尾复位：`browser_evaluate` 把 `studyDaysPerWeek` 恢复为 6，并清空当日任务行。

- [x] **Step 6: 构建验证与产物恢复**

Run: `npm run build:app`
Expected: 构建成功。

Run: `git status --porcelain app/`
Expected: 出现 `app/index.html` 修改与 `app/assets/` 下旧 hash 文件删除/新 hash 文件未跟踪（构建副产物）。

Run: `git checkout -- app/ && git clean -f app/assets`
Expected: `git status --porcelain app/` 输出为空（按「功能提交不更新 app/ 产物」口径恢复）。

- [x] **Step 7: 停 dev 服务器**

停止 Step 2 的后台任务（TaskStop / kill 端口 5199 进程）。

- [x] **Step 8: 验收记录并提交**

在 `docs/superpowers/specs/2026-11-19-carryover-fix-design.md` 末尾追加「验收记录（2026-11-19）」小节：逐项记录 Step 1 测试计数、场景 A/B/C 浏览器断言结果（含 planted 日期）、构建验证与产物恢复结果。

```bash
git add docs/superpowers/specs/2026-11-19-carryover-fix-design.md
git commit -m "docs: 结转丢题修复验收记录

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自查记录（writing-plans Self-Review）

1. **规格覆盖**：§1 回溯（Task 1/2）、§2 数据优先（Task 3）、§3 测试口径（Task 1 纯函数单测 / Task 2 集成测试 / Task 3→Task 4 浏览器验证——本仓库页面无 DOM 单测惯例，与 vocab-photo 计划口径一致）、删除「已知边界」注释（Task 2 Step 3.4）。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；所有命令含预期输出。
3. **类型一致性**：`pickCarrySource(priorTasks: TaskRow[], todayKey: string): TaskRow[]`、`carryWindowStart(todayKey: string): string`、`CARRY_LOOKBACK_DAYS = 14` 在 Task 1 定义、Task 2 引用一致；`carrySourceTasks` 改名在 plan.ts/repos.ts/plan.test.ts 三处同步；测试 fixture `taskRow` 的 `type` 参数用 `TaskRow['type']`（TaskRow 已在 plan.test.ts 导入）。
