import type { Question } from '../types'

const FULLWIDTH_PUNCT: Record<string, string> = {
  '，': ',', '。': '.', '；': ';', '：': ':', '？': '?', '！': '!',
  '（': '(', '）': ')', '“': '"', '”': '"', '‘': "'", '’': "'",
}

/** 填空答案规范化：空白/大小写/全半角标点/包裹引号（规格 7.3） */
export function normalizeBlank(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/[，。；：？！（）“‘’”]/g, (ch) => FULLWIDTH_PUNCT[ch] ?? ch)
  s = s.replace(/\s+/g, ' ')
  if (s.length >= 2) {
    const first = s[0]!
    const last = s[s.length - 1]!
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim()
    }
  }
  return s
}

export interface GradeResult {
  isCorrect: boolean
  /** 展示给学生的标准答案文本 */
  correctAnswer: string
}

export function gradeAnswer(question: Question, answer: string): GradeResult {
  if (question.type === 'single_choice') {
    const idx = Number(answer)
    const correct = question.answerSpec.correctOptionIndex
    const isCorrect = answer.trim() !== '' && correct !== undefined && Number.isInteger(idx) && idx === correct
    return { isCorrect, correctAnswer: correct !== undefined ? question.options?.[correct] ?? '' : '' }
  }
  const accepted = question.answerSpec.acceptedAnswers ?? []
  const normalized = normalizeBlank(answer)
  const isCorrect = accepted.some((a) => normalizeBlank(a) === normalized)
  return { isCorrect, correctAnswer: accepted[0] ?? '' }
}
