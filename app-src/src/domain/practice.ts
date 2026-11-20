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