# 专项练习限量 24 题实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 专项练习（`#/exercise?set=` 任务卡入口与 `special=` 自由入口共用路径）一次出题从全量 48 题收敛为纯随机 24 题。

**Architecture:** 抽题逻辑抽为 `domain/practice.ts` 纯函数（`pickSpecialPractice` + `SPECIAL_PRACTICE_MAX = 24`，Fisher-Yates `shuffle` 随迁导出复用），`pages/exercise.ts` 两条加载路径（IndexedDB 与 bundle 降级）改调该函数并让标题带上实际题数。

**Tech Stack:** Vite + TypeScript（无框架）、Vitest、Playwright MCP 文本断言（禁止截图）。

**规格：** `docs/superpowers/specs/2026-11-20-special-practice-cap-design.md`

**约定（硬性）：**
- 提交信息中文 + conventional 前缀，末尾必须是 `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- 功能提交不更新 `app/` 构建产物；构建验证后必须 `git checkout -- app/ && git clean -f app/assets` 恢复
- 浏览器验证一律禁止 take_screenshot 等截图工具，只允许 browser_snapshot / browser_find / browser_evaluate 文本断言
- 任何 API Key 真实值不得写入任何文件
- 工作直接在 main 上（仓库既定惯例），不 push

**测试基线：** `npm run test:app` 23 文件 / 380 用例全绿；`npm run test:extract` 9/9。

---

### Task 1: `domain/practice.ts` 抽题纯函数（TDD）

**Files:**
- Create: `app-src/src/domain/practice.ts`
- Test: `app-src/src/domain/practice.test.ts`

- [x] **Step 1: 写失败测试**

创建 `app-src/src/domain/practice.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { pickSpecialPractice, shuffle, SPECIAL_PRACTICE_MAX } from './practice'
import type { Question } from '../types'

/** 最小 Question fixture：抽题只关心集合成员与顺序，其余字段占位（口径同 plan.test.ts 的 specialQ） */
const q = (i: number): Question => ({
  id: `g7a-present-l1-${String(i + 1).padStart(4, '0')}`,
  contentVersion: 'test-v1',
  grade: 7,
  term: 'A',
  unit: 'g7a-present-l1',
  sourceUrl: 's',
  knowledgePointIds: ['kp.test'],
  type: 'single_choice',
  stem: 'stem',
  options: ['a', 'b', 'c', 'd'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

describe('shuffle（Fisher-Yates，拷贝洗牌）', () => {
  it('空数组与单元素数组不崩溃且元素不变', () => {
    expect(shuffle([])).toEqual([])
    expect(shuffle([q(0)]).map((x) => x.id)).toEqual([q(0).id])
  })
  it('不修改入参数组', () => {
    const input = [q(0), q(1), q(2)]
    const before = input.map((x) => x.id)
    shuffle(input)
    expect(input.map((x) => x.id)).toEqual(before)
  })
})

describe('pickSpecialPractice（规格 §0：纯随机抽 24）', () => {
  it('48 题抽恰 24 题，且结果为输入子集', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const picked = pickSpecialPractice(input)
    expect(picked).toHaveLength(SPECIAL_PRACTICE_MAX)
    const ids = new Set(input.map((x) => x.id))
    for (const x of picked) expect(ids.has(x.id)).toBe(true)
  })
  it('输入不足 24（5 题）时全部返回', () => {
    const input = Array.from({ length: 5 }, (_, i) => q(i))
    const picked = pickSpecialPractice(input)
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((x) => x.id))).toEqual(new Set(input.map((x) => x.id)))
  })
  it('随机性生效：20 次调用首题不全相同（48 题全同首题概率 ≈ 48⁻¹⁹，实际为零）', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const firsts = new Set(Array.from({ length: 20 }, () => pickSpecialPractice(input)[0]!.id))
    expect(firsts.size).toBeGreaterThan(1)
  })
  it('不修改入参数组（抽题在拷贝上洗牌）', () => {
    const input = Array.from({ length: 48 }, (_, i) => q(i))
    const before = input.map((x) => x.id)
    pickSpecialPractice(input)
    expect(input.map((x) => x.id)).toEqual(before)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd app-src && npx vitest run src/domain/practice.test.ts`
Expected: FAIL（`Failed to resolve import './practice'`，模块不存在）

- [x] **Step 3: 写最小实现**

创建 `app-src/src/domain/practice.ts`：

```ts
import type { Question } from '../types'

/** 专项自由练习抽题上限（规格 §0）：48 题专项一次随机抽 24，控制单次负担 */
export const SPECIAL_PRACTICE_MAX = 24

/** Fisher-Yates 洗牌：拷贝入参后洗牌，不改原数组（自 pages/exercise.ts 迁移，供练习页复用） */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i]!, arr[j]!] = [arr[j]!, arr[i]!]
  }
  return arr
}

/** 专项自由练习抽题（规格 §0）：纯随机抽取 min(SPECIAL_PRACTICE_MAX, 总数) 题，每次进入组合不同；
 *  不按错题优先、不按级别（与每日计划 SPECIAL_QUESTION_MAX 的预算口径相互独立） */
export function pickSpecialPractice(questions: readonly Question[]): Question[] {
  return shuffle(questions).slice(0, SPECIAL_PRACTICE_MAX)
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd app-src && npx vitest run src/domain/practice.test.ts`
Expected: PASS（6 用例全绿）

- [x] **Step 5: 全量回归**

Run: `cd /data/svn/learn/english-materials && npm run test:app`
Expected: 24 文件 / **386** 用例全绿（380 基线 + 6 新增）

- [x] **Step 6: 提交**

```bash
git add app-src/src/domain/practice.ts app-src/src/domain/practice.test.ts
git commit -m "feat(app): 专项抽题纯函数 pickSpecialPractice（随机 24 题）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `pages/exercise.ts` 接线（两条路径 + 标题带题数）

**Files:**
- Modify: `app-src/src/pages/exercise.ts:31-38`（删除本地 shuffle）、`:99-110`（special 分支两条路径）、import 区

- [x] **Step 1: 改 import 并删除本地 shuffle**

在 `pages/exercise.ts` import 区（现有 `import type { Submission } from '../domain/session'` 附近）新增：

```ts
import { pickSpecialPractice, shuffle } from '../domain/practice'
```

删除本地私有实现（原 31-38 行）：

```ts
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i]!, arr[j]!] = [arr[j]!, arr[i]!]
  }
  return arr
}
```

词汇键盘模式的 `shuffle(data.questions)`（约 184 行）改为导入复用，行为不变。

- [x] **Step 2: 改 special 分支（两条路径统一限量 + 标题带题数）**

将 `loadQuestions` 内 special 分支（约 99-110 行）：

```ts
  // set=<专项 id>（今日页任务卡入口）与 special=<专项 id>（既有入口）共用同一加载路径
  const special = params.get('set') || params.get('special')
  if (special) {
    const storageOk = await isStorageAvailable()
    if (storageOk) {
      const questions = await questionsByUnitPrefix(special)
      return { title: '专项练习', questions: shuffle(questions) }
    }
    const bundle = await fetchContentBundle()
    const questions = bundle.questions.filter((q) => q.unit.startsWith(special))
    return { title: '专项练习', questions: shuffle(questions) }
  }
```

改为：

```ts
  // set=<专项 id>（今日页任务卡入口）与 special=<专项 id>（既有入口）共用同一加载路径；
  // 限量随机抽题（规格 §0）：一次 24 题而非全量 48，标题带实际题数（与「到期复习 · N 题」口径一致）
  const special = params.get('set') || params.get('special')
  if (special) {
    const storageOk = await isStorageAvailable()
    if (storageOk) {
      const questions = pickSpecialPractice(await questionsByUnitPrefix(special))
      return { title: `专项练习 · ${questions.length} 题`, questions }
    }
    const bundle = await fetchContentBundle()
    const questions = pickSpecialPractice(bundle.questions.filter((q) => q.unit.startsWith(special)))
    return { title: `专项练习 · ${questions.length} 题`, questions }
  }
```

- [x] **Step 3: 类型检查与全量回归**

Run: `cd app-src && npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0；24 文件 / 386 用例全绿（exercise 页无 DOM 级测试为仓库惯例，接线由 Task 3 浏览器验收兜底）

- [x] **Step 4: 提交**

```bash
git add app-src/src/pages/exercise.ts
git commit -m "feat(app): 专项练习一次随机 24 题，标题带实际题数

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 浏览器验收 + 构建验证 + 验收记录

**Files:**
- Modify: `docs/superpowers/specs/2026-11-20-special-practice-cap-design.md`（验收记录小节）

- [x] **Step 1: 启动 dev 服务器**

Run: `cd /data/svn/learn/english-materials/app-src && npx vite --port 5199 --strictPort`（后台）
注意：实际 base 为 `/english-materials/app/`（根路径 302 跳转），浏览器地址统一用 `http://localhost:5199/english-materials/app/#/...`

- [x] **Step 2: 自由入口限量断言**

浏览器导航 `http://localhost:5199/english-materials/app/#/exercise?special=g7a-present`，文本断言（禁止截图，只用 browser_snapshot / browser_find / browser_evaluate）：
- 页面标题含 `专项练习 · 24 题`
- 进度行含 `第 1 / 24 题`
- 再次进入（先经 `#/today` 再回该 URL，同 hash 导航不重渲染）标题仍为 24 题且首题题干与上次**可能**不同——用 browser_evaluate 读首题 `h3` 文本，连进 3 次至少一次不同（随机性生效，同首题 3 连概率 (1/48)²≈0.04%，若恰同视为通过并重试一轮）
- 换一个专项（如 `special=g7b-tenses`）同样 24 题

- [x] **Step 3: 任务卡入口断言（今日页真实链路）**

导航 `#/today`，如当日计划含「专项巩固」任务卡，点击进入：标题含 `专项练习 · 24 题`、进度 `第 1 / 24 题`（`set=` 与 `special=` 共用路径，此处验证带 `task=` 的完整链路不回归）；如当日无专项任务卡（休息日/计划无专项段），如实记录并以 Step 2 的共用路径断言为准。

- [x] **Step 4: 全量回归 + 构建验证 + 产物恢复**

Run: `cd /data/svn/learn/english-materials && npm run test:app && npm run test:extract && npm run build:app`
Expected: 386 用例全绿；extract 9/9；构建成功。随后**必须**恢复产物（功能提交不更新 `app/`）：
```bash
git checkout -- app/ && git clean -f app/assets
git status --porcelain   # 应为空
```

- [x] **Step 5: 停 dev 服务器并填写验收记录**

停掉 5199 端口进程。在规格 `docs/superpowers/specs/2026-11-20-special-practice-cap-design.md` 末尾「验收记录（2026-11-20）」小节如实填写：测试计数（386 全绿 / extract 9/9）、浏览器各断言结果（含随机性观察与偏差备忘）、构建与产物恢复情况、`git status --porcelain app/` 为空。

- [x] **Step 6: 提交**

```bash
git add docs/superpowers/specs/2026-11-20-special-practice-cap-design.md
git commit -m "docs: 专项限量 24 题验收记录

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

完成后回到调度方做最终整体审查，再按用户指令决定是否推送与重建部署产物。
