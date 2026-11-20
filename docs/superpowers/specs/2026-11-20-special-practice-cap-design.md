# 专项练习限量 24 题（special practice cap）设计规格

**日期：** 2026-11-20
**上游：** 结转丢题修复已完成上线（79f4d13 / 部署 c8b091f）
**范围：** 专项练习（`#/exercise?set=<专项 id>` 与 `special=<专项 id>` 共用路径）一次出题从全量 48 题收敛为随机 24 题

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| 触发场景 | 今日页「专项巩固」任务卡（`set=` + `task=`）与自由入口（`special=`）共用加载路径，**一并限量** |
| 题量 | `SPECIAL_PRACTICE_MAX = 24`（题量不足 24 的专项防御性取全部；当前 8 个专项均为 48 题，正常不触发） |
| 挑选策略 | **纯随机**：shuffle 后截取前 24，每次进入组合不同；不按错题优先、不按级别 |
| 不动的部分 | 任务完成判定（做完即 completed）、任务行 `questionIds` 与分钟数标签、词汇/复习/拍照默写路径、每日计划的 `SPECIAL_QUESTION_MAX = 10`（预算口径独立，互不影响） |

## 1. 现状与问题

`pages/exercise.ts` 的 special 分支（`loadQuestions`，约 99-110 行）对两条路径一律 `questionsByUnitPrefix(special)` 取该专项全部 48 题并全量 shuffle：任务卡标注的分钟数按 ≤10 题预算生成，实际一口气出 48 题，题量与时长标签脱节，单次练习负担过重。

## 2. 新逻辑

- 新纯函数模块 `domain/practice.ts`（无 IO，与 `domain/plan.ts` 同层惯例）：
  ```ts
  export const SPECIAL_PRACTICE_MAX = 24
  /** 专项自由练习抽题（规格 §0）：纯随机抽取 min(24, 总数) 题，每次组合不同 */
  export function pickSpecialPractice(questions: Question[]): Question[]
  ```
  实现 = 现有 Fisher-Yates shuffle（自 `exercise.ts:31` 迁移为可复用实现）+ `slice(0, SPECIAL_PRACTICE_MAX)`；不修改入参数组（拷贝后洗牌）。
- `pages/exercise.ts` special 分支两条路径（IndexedDB `questionsByUnitPrefix` 与存储不可用的 bundle 降级）改为调用 `pickSpecialPractice`；标题从 `'专项练习'` 改为 `` `专项练习 · ${questions.length} 题` ``（与「到期复习 · N 题」格式一致）。
- `shuffle` 实现迁移至 `domain/practice.ts` 导出（`pickSpecialPractice` 内部使用），`exercise.ts` 删除本地私有实现改为导入复用（词汇键盘模式等其余调用点行为不变，避免两份 Fisher-Yates 并存）。

## 3. 测试口径（TDD）

- `domain/practice.test.ts` 纯函数单测：
  - 48 题 → 恰 24 题，且结果为输入子集（集合不变只抽样）；
  - 输入不足 24（如 5 题）→ 全部返回（顺序仍打乱）；
  - 随机性生效：多次调用首题不全相同（48 题抽 20 次全部同首题概率 ≈ 48⁻¹⁹，实际零）；
  - 不修改入参（洗牌在拷贝上进行）。
- `pages/exercise.ts` 无 DOM 级测试惯例（与结转修复 §3 替代口径一致）：页面接线（标题带题数、两条路径走限量）由浏览器验收兜底。

## 验收记录（2026-11-20）

按规格与计划 Task 3 逐项实测（Playwright MCP 文本断言 + Vitest；本会话模型不支持图片模态，全程未用截图；dev 服务器实际 base 为 `/english-materials/app/`，根路径 302 跳转至该地址）：

1. **顺手小修（空态标题）**：`pages/exercise.ts` 两处 special 分支 return 改为 `questions.length > 0 ? \`专项练习 · ${questions.length} 题\` : '专项练习'`，无题时不再出现「专项练习 · 0 题」。改后 `npx tsc --noEmit` 无错、`npx vitest run` 24 文件 / **386 用例**全绿；提交 `7af0651`。
2. **全量测试**：`npm run test:app` 全绿——24 个测试文件、**386 个用例**（基线 380 + 本规格 Task 1 的 `pickSpecialPractice` 6）；`npm run test:extract` **9/9**（「已提交产物与提取结果逐字节一致（防漂移）」通过）。
3. **自由入口限量**（真实浏览器，`http://localhost:5199/english-materials/app/#/exercise?special=g7a-present`）：h1 为「专项练习 · 24 题」，进度行「第 1 / 24 题」；经 `#/today` 中转重进共 3 次，首题 `h3` 依次为 `She ___ (study) hard.` / `She ___ (teach) English.` / `I ___ (be) 13 years old.`，3 次互不相同（随机性成立；同首题 3 连概率约 (1/48)²≈0.04%）。换 `special=g7b-tenses`：同为「专项练习 · 24 题」、进度「第 1 / 24 题」，首题 `— Are they working? — No, they ___.`。
4. **任务卡入口**（今日页真实链路）：`#/today` 显示 2026 年 11 月 20 日 · 周五，计划含专项卡「一般现在时与句子种类」（desc「9 题」）；点击「开始」后 hash 为 `#/exercise?set=g7a-present&task=task-2026-11-20-special`，加载完成后断言 h1「专项练习 · 24 题」、进度「第 1 / 24 题」，带 `task=` 的完整链路通过（`set=` 与 `special=` 共用同一加载分支）。
5. **构建验证与产物恢复**：`npm run build:app` 成功（tsc 无错，vite 49 modules，新增 `app/assets/index-dsh06Tiu.js` 188.62 kB）；按功能提交口径执行 `git checkout -- app/ && git clean -f app/assets` 恢复，`git status --porcelain` 与 `git status --porcelain app/` 均为空。dev 服务器（5199 端口）验证完成后已停止，`ss` 确认端口无监听、无残留 vite 进程。

**验证偏差备忘**：

- 计划中的浏览器地址未带 base，实际 vite base 为 `/english-materials/app/`，根路径 302 至该 base；验证统一使用 `http://localhost:5199/english-materials/app/#/...`，路由与断言结果不受影响。
- 今日页任务卡 desc「9 题」取自计划任务 `task.questionIds.length`（`today.ts:185`，本次计划为 9 题），进入练习后按规格从专项题库随机抽 24 题，两者口径不同；属既有卡片展示逻辑，非本规格引入的回归，记录备忘。
- 任务卡「开始」按钮位于底部 tabbar 遮挡区域内，Playwright 指针点击被拦截；改用 DOM `click()` 触发同一按钮，导航与断言链路不受影响。
