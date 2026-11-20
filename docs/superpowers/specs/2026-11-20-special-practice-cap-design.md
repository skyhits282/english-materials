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

（待实现后填写）
