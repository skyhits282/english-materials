import type { ContentBundle, Question, VocabBook, VocabWord } from '../types'

const CONTENT_BASE = './content/g7a'

let bundlePromise: Promise<ContentBundle> | undefined

/** 拉取并缓存题库（相对当前文档路径，dev 与子路径部署均正确） */
export function fetchContentBundle(): Promise<ContentBundle> {
  bundlePromise ??= (async () => {
    const [questions, vocab, meta] = await Promise.all([
      fetchJson<Question[]>(`${CONTENT_BASE}/questions.json`),
      fetchJson<VocabBook[]>(`${CONTENT_BASE}/vocab.json`),
      fetchJson<ContentBundle['meta']>(`${CONTENT_BASE}/content.json`),
    ])
    // HTTP 陈旧缓存可能返回旧版单对象结构；按加载失败处理，走既有拒绝缓存与重试路径
    if (!Array.isArray(vocab)) {
      throw new Error('题库加载失败：vocab.json 应为两册词汇数组（请清除缓存后重试）')
    }
    return { questions, vocab, meta }
  })()
  return bundlePromise.catch((err) => {
    bundlePromise = undefined
    throw err
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`题库加载失败：${url}（HTTP ${res.status}）`)
  return res.json() as Promise<T>
}

/** 词汇单元 id（v1-u4 / v2-u3）→ 短名（u4 / u3），用于生成稳定题目 ID 与知识点 ID */
function unitShortName(unitId: string): string {
  return unitId.replace(/^v[12]-/, '')
}

/** contentVersion 统一用书级版本；词 ID 的可追溯性已体现在 Question.id 中 */
function toVocabQuestion(book: VocabBook, unitId: string, w: VocabWord): Question {
  const accepted = [w.word, ...(w.variant ? [w.variant] : [])]
  return {
    // 七上沿用 M1 的 `g7a-vocab-u*-*` 格式，保证历史作答记录仍可关联
    id: `${book.book}-vocab-${unitShortName(unitId)}-${String(w.no).padStart(4, '0')}`,
    contentVersion: book.contentVersion,
    grade: 7,
    term: book.book === 'g7b' ? 'B' : 'A',
    unit: unitId,
    sourceUrl: 'typing/',
    knowledgePointIds: [`vocab.${book.book}.${unitShortName(unitId)}`],
    type: 'fill_in',
    stem: `${w.meaning}（${w.pos}）`,
    answerSpec: { acceptedAnswers: accepted },
    explanation: `${w.word} ${w.ipa} ${w.pos} ${w.meaning}`,
    difficulty: 1,
    estimatedSeconds: 20,
  }
}

/** 由词汇派生中→英默写题；unit id 前缀（v1-/v2-）定位所属册与单元，词序取自源数据，保证 ID 跨会话稳定 */
export function deriveVocabQuestions(vocab: VocabBook[], unitId: string): Question[] {
  const unit = findVocabUnit(vocab, unitId)
  if (!unit) return []
  const book = vocab.find((b) => b.units.some((u) => u.id === unitId))
  if (!book) return []
  return unit.words.map((w) => toVocabQuestion(book, unitId, w))
}

/** 跨两册按 unit id 查找词汇单元 */
export function findVocabUnit(vocab: VocabBook[], unitId: string) {
  for (const b of vocab) {
    const unit = b.units.find((u) => u.id === unitId)
    if (unit) return unit
  }
  return undefined
}

/** 取指定册的词汇单元列表（供设置页下拉与今日页词汇卡使用） */
export function vocabUnitsForBook(vocab: VocabBook[], book: string) {
  return vocab.find((b) => b.book === book)?.units ?? []
}
