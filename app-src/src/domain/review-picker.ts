import type { Mastery } from '../types'
import { localDayKey } from './metrics'

/** 每次复测的题目上限（规格 §1.2） */
export const REVIEW_LIMIT_DEFAULT = 10

export interface ReviewPickInput {
  now: Date
  /** 全部 mastery 行（引擎内部过滤到期，调用方无需预筛） */
  masteryRows: Mastery[]
  /** 知识点 → 历史曾答错题 ID（含词题；由 repo 层反查 attempts 汇总） */
  wrongQuestionIdsByKp: Map<string, string[]>
  /** 已答过的（当日已复测过的题避免立即重复） */
  alreadyDoneToday?: Set<string>
  /** 上限，默认 10 */
  limit?: number
}

export interface ReviewPickResult {
  /** 选中的题目 ID（按轮转均衡顺序；词题 ID 原样保留，由练习页解析器显示） */
  questionIds: string[]
  /** 到期知识点数（含无曾答错题可出的知识点，供今日页卡片展示） */
  dueKpCount: number
  /** 去重并剔除当日已答后的可复测题目总数（不含 limit 截断） */
  availableCount: number
}

/** 纯函数：到期复测选题（规格 §1.2）。
 *  到期判定按本地日历日口径：nextReviewAt 的本地日 <= 今日才入选（未来/未排期不选）；
 *  各知识点轮转（round-robin）取题，题多的知识点不垄断；同一题挂多个知识点时只选一次。 */
export function pickReviewQuestions(input: ReviewPickInput): ReviewPickResult {
  const limit = input.limit ?? REVIEW_LIMIT_DEFAULT
  const todayKey = localDayKey(input.now)

  const due = input.masteryRows.filter(
    (row) => row.nextReviewAt !== undefined && localDayKey(new Date(row.nextReviewAt)) <= todayKey,
  )

  // 每个到期知识点一个候选队列：题 ID 去重、剔除当日已答
  const queues = due.map((row) => {
    const seen = new Set<string>()
    const queue: string[] = []
    for (const id of input.wrongQuestionIdsByKp.get(row.knowledgePointId) ?? []) {
      if (seen.has(id) || input.alreadyDoneToday?.has(id)) continue
      seen.add(id)
      queue.push(id)
    }
    return queue
  })
  const available = new Set<string>()
  for (const queue of queues) {
    for (const id of queue) available.add(id)
  }

  // 轮转：每轮按知识点顺序各取一题，直到达到 limit 或全部取尽
  const questionIds: string[] = []
  const picked = new Set<string>()
  let progressed = true
  while (questionIds.length < limit && progressed) {
    progressed = false
    for (const queue of queues) {
      if (questionIds.length >= limit) break
      // 队头若是跨知识点重复题则让位，取该知识点的下一道
      while (queue.length > 0) {
        const id = queue.shift()!
        if (picked.has(id)) continue
        picked.add(id)
        questionIds.push(id)
        progressed = true
        break
      }
    }
  }

  return { questionIds, dueKpCount: due.length, availableCount: available.size }
}
