import { getContentMeta, putContentMeta, upsertQuestions } from '../db/repos'
import { db } from '../db/schema'
import type { ContentBundle } from '../types'

export interface SeedResult {
  inserted: number
  skipped: boolean
}

/** 版本未变则跳过；变化则整表重建题目索引（bulkPut 幂等） */
export async function seedContent(bundle: ContentBundle): Promise<SeedResult> {
  const meta = bundle.meta
  const existing = await getContentMeta(meta.contentId)
  if (existing && existing.version === meta.version) {
    return { inserted: 0, skipped: true }
  }
  await upsertQuestions(bundle.questions)
  const stale = await db.questions.toArray()
  const knownIds = new Set(bundle.questions.map((q) => q.id))
  const obsolete = stale.filter((q) => !knownIds.has(q.id)).map((q) => q.id)
  if (obsolete.length > 0) await db.questions.bulkDelete(obsolete)
  await putContentMeta(meta)
  return { inserted: bundle.questions.length, skipped: false }
}
