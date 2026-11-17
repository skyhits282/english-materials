import type { ContentBundle, Question, VocabBook, VocabWord } from '../types'

const CONTENT_BASE = './content/g7a'

let bundlePromise: Promise<ContentBundle> | undefined

/** 拉取并缓存题库（相对当前文档路径，dev 与子路径部署均正确） */
export function fetchContentBundle(): Promise<ContentBundle> {
  bundlePromise ??= (async () => {
    const [questions, vocab, meta] = await Promise.all([
      fetchJson<Question[]>(`${CONTENT_BASE}/questions.json`),
      fetchJson<VocabBook>(`${CONTENT_BASE}/vocab.json`),
      fetchJson<ContentBundle['meta']>(`${CONTENT_BASE}/content.json`),
    ])
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

/** 词汇单元 id（v1-u4）→ 短名（u4），用于生成稳定题目 ID */
function unitShortName(unitId: string): string {
  return unitId.replace(/^v1-/, '')
}

/** contentVersion 统一用书级版本；词 ID 的可追溯性已体现在 Question.id 中 */
function toVocabQuestion(contentVersion: string, unitId: string, w: VocabWord): Question {
  const accepted = [w.word, ...(w.variant ? [w.variant] : [])]
  return {
    id: `g7a-vocab-${unitShortName(unitId)}-${String(w.no).padStart(4, '0')}`,
    contentVersion,
    grade: 7,
    term: 'A',
    unit: unitId,
    sourceUrl: 'typing/',
    knowledgePointIds: [`vocab.g7a.${unitShortName(unitId)}`],
    type: 'fill_in',
    stem: `${w.meaning}（${w.pos}）`,
    answerSpec: { acceptedAnswers: accepted },
    explanation: `${w.word} ${w.ipa} ${w.pos} ${w.meaning}`,
    difficulty: 1,
    estimatedSeconds: 20,
  }
}

/** 由词汇派生中→英默写题；词序取自源数据，保证 ID 跨会话稳定 */
export function deriveVocabQuestions(vocab: VocabBook, unitId: string): Question[] {
  const unit = vocab.units.find((u) => u.id === unitId)
  if (!unit) return []
  return unit.words.map((w) => toVocabQuestion(vocab.contentVersion, unitId, w))
}

export function findVocabUnit(vocab: VocabBook, unitId: string) {
  return vocab.units.find((u) => u.id === unitId)
}
