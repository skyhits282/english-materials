import type { Question } from '../types'

/** 词汇教材单元 id 解析结果：v1-uN（七上，N=1..10）→ book 1；v2-uN（七下）→ book 2 */
export interface VocabUnitId {
  book: 1 | 2
  index: number
}

/** 解析词汇单元 id（如 v1-u4 / v2-u8）；格式不符返回 undefined（词题 unit 也会走到这里，调用方据此 fail-open） */
export function parseVocabUnitId(unitId: string): VocabUnitId | undefined {
  const m = /^v([12])-u(\d+)$/.exec(unitId)
  if (!m) return undefined
  return { book: Number(m[1]) as 1 | 2, index: Number(m[2]) }
}

/** 单元全序值：册内按序号递增、七下（book 2）整体晚于七上（book 1）——跨册比较的语义基础
 *  （学到七下任意单元即解锁全部七上专项，可复习七上语法） */
function vocabUnitRank(unitId: string): number | undefined {
  const parsed = parseVocabUnitId(unitId)
  return parsed ? parsed.book * 1000 + parsed.index : undefined
}

/** 专项级别 unit（如 g7b-pronouns-modals-l3）解析结果 */
export interface SpecialUnitId {
  /** 专项 id（贪婪前缀，天然兼容含连字符的 g7b-pronouns-modals 等） */
  specialId: string
  /** 级别 1–6 */
  level: number
}

/** 解析专项级别 unit；非"专项-lN"形态（词汇单元 v1-u4、无级别后缀等）返回 undefined */
export function parseSpecialUnit(unit: string): SpecialUnitId | undefined {
  const m = /^(.+)-l([1-6])$/.exec(unit)
  if (!m) return undefined
  return { specialId: m[1]!, level: Number(m[2]) }
}

/** 专项各级别的解锁单元（学到该教材单元后，此级别可进入出题池）。
 *  值为 6 元组，下标 = 级别 - 1；允许非单调（按教材实际顺序填，解锁集不必是级别前缀）
 *  与跨册值（如 g7b-pronouns-modals 的 can/may 解锁于七上 v1-u8）。
 *  依据 2024 人教版语法编排的初稿，属纯内容数据：家长校对后直接改本表，不影响过滤逻辑；
 *  未收录的专项 fail-open（全解锁，回退现状）。 */
export const SPECIAL_LEVEL_UNLOCKS: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
  'g7a-present': ['v1-u1', 'v1-u4', 'v1-u9', 'v1-u9', 'v1-u10', 'v1-u10'],
  'g7a-nouns': ['v1-u2', 'v1-u5', 'v1-u5', 'v1-u6', 'v1-u8', 'v1-u10'],
  'g7a-numbers': ['v1-u3', 'v1-u10', 'v1-u9', 'v1-u6', 'v1-u7', 'v1-u10'],
  'g7a-articles': ['v1-u4', 'v1-u4', 'v1-u5', 'v1-u1', 'v1-u5', 'v1-u10'],
  'g7b-adjadv': ['v2-u1', 'v2-u1', 'v2-u3', 'v2-u3', 'v2-u3', 'v2-u8'],
  'g7b-nouns': ['v2-u1', 'v2-u1', 'v2-u2', 'v2-u4', 'v2-u6', 'v2-u8'],
  'g7b-pronouns-modals': ['v2-u1', 'v2-u1', 'v1-u8', 'v1-u8', 'v2-u2', 'v2-u8'],
  'g7b-tenses': ['v2-u5', 'v2-u5', 'v2-u5', 'v2-u6', 'v2-u6', 'v2-u8'],
}

/** 按学习进度过滤专项题：只保留「当前单元全序值 ≥ 该级别解锁单元全序值」的题（专项练习与每日计划共用）。
 *  fail-open（红线取舍：宁可漏出超纲题，不可让既有用户专项练习全空）：
 *  - currentUnit 解析失败 → 全部保留（warn 留痕）；
 *  - 题目 unit 解析失败（词题混入）或专项不在 SPECIAL_LEVEL_UNLOCKS → 保留该题（未映射 = 回退现状全解锁）。 */
export function filterByUnlockedLevels(questions: readonly Question[], currentUnit: string): Question[] {
  const currentRank = vocabUnitRank(currentUnit)
  if (currentRank === undefined) {
    console.warn('当前单元无法解析，专项出题范围不过滤：', currentUnit)
    return [...questions]
  }
  return questions.filter((question) => {
    const parsed = parseSpecialUnit(question.unit)
    if (!parsed) return true
    const unlockUnit = SPECIAL_LEVEL_UNLOCKS[parsed.specialId]?.[parsed.level - 1]
    if (unlockUnit === undefined) return true
    const unlockRank = vocabUnitRank(unlockUnit)
    if (unlockRank === undefined) return true
    return currentRank >= unlockRank
  })
}

/** 题集中是否存在已解锁的专项题（今日页 planIncomplete 守卫用：进度 0 解锁时专项任务合法缺席） */
export function hasUnlockedSpecialQuestions(questions: readonly Question[], currentUnit: string): boolean {
  return filterByUnlockedLevels(questions, currentUnit).some((q) => parseSpecialUnit(q.unit) !== undefined)
}
