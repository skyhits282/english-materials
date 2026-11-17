/** AI 每日配额（M3 规格 §7.1）：调用前本地计数，超限不发起网络请求。 */
import { db } from '../../db/schema'
import { AI_DEFAULT_DAILY_LIMIT } from '../../domain/ai-config'
import { localDayKey } from '../../domain/metrics'
import type { Settings } from '../../types'
import { AiError } from './transport'

/** 今日（本地日）AI 调用次数：aiRequests 全表扫描后按本地日过滤。
 *  家用级数据量（每日 ≤500 次、年级量十万行以内）单次全表扫描足够；量级增长再补"本地日"二级索引。 */
export async function getAiUsageToday(now: Date = new Date()): Promise<number> {
  const todayKey = localDayKey(now)
  let usage = 0
  await db.aiRequests.each((row) => {
    if (localDayKey(new Date(row.createdAt)) === todayKey) usage += 1
  })
  return usage
}

/** 配额检查（纯函数）：usage ≥ 上限抛 AiError；kind 沿用 'quota-server' 以统一 UI 错误分类 */
export function checkQuota(settings: Settings, usage: number): void {
  const limit = settings.aiDailyLimit ?? AI_DEFAULT_DAILY_LIMIT
  if (usage >= limit) throw new AiError('quota-server', `今日 AI 次数已用完（上限 ${limit} 次），请明天再试`)
}
