import type { VocabBook } from '../types'
import { vocabQuestionId } from './loader'

/** 词汇默写题解析结果：供错题本/报告等展示真实题干与答案（词题不在 questions 表中） */
export interface VocabResolved {
  /** 题干，形如「默写：吉他（n.）」（含中文释义与"默写"字样） */
  stem: string
  /** 英文单词（acceptedAnswers[0] 语义） */
  answer: string
  /** 同义变体拼写（如 centre/center），无则空串 */
  variant: string
}

/** 构建词汇默写题解析器：questionId（`<book>-vocab-<短单元名>-<4 位词序号>`）→ 题干与答案。
 *  题目 ID 与词序复用派生逻辑的同一拼法（vocabQuestionId），保证与 deriveVocabQuestions 严格一致；
 *  纯函数、不依赖 DB；vocab 为空（bundle 加载失败/为空）时全部返回 undefined。 */
export function buildVocabResolver(vocab: VocabBook[]) {
  const byId = new Map<string, VocabResolved>()
  for (const book of vocab) {
    for (const unit of book.units) {
      for (const w of unit.words) {
        byId.set(vocabQuestionId(book.book, unit.id, w.no), {
          stem: `默写：${w.meaning}（${w.pos}）`,
          answer: w.word,
          variant: w.variant,
        })
      }
    }
  }
  return {
    resolve(questionId: string): VocabResolved | undefined {
      return byId.get(questionId)
    },
  }
}
