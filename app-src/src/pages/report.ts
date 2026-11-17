import type { PageRenderer } from '../router'
import type { VocabBook } from '../types'
import { listAttempts, listAllQuestions } from '../db/repos'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from '../domain/metrics'
import { fetchContentBundle } from '../content/loader'
import { buildVocabResolver } from '../content/vocab-resolve'
import { escapeHtml } from '../ui/escape'

function pct(rate: number | null): string {
  return rate === null ? '暂无数据' : `${Math.round(rate * 100)}%`
}

export const renderReport: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>学习报告</h1><p class="muted">加载中…</p>'
  let attempts: Awaited<ReturnType<typeof listAttempts>> = []
  let questions: Awaited<ReturnType<typeof listAllQuestions>> = []
  let vocab: VocabBook[] = []
  try {
    // 词题不在 questions 表中：bundle 失败时降级为空数组，易错词沿用原始 ID 显示（不比 M1 差）
    [attempts, questions, vocab] = await Promise.all([
      listAttempts(),
      listAllQuestions(),
      fetchContentBundle().then((b) => b.vocab).catch(() => {
        console.warn('题库加载失败，易错词暂按原始 ID 显示')
        return [] as VocabBook[]
      }),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>学习报告</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const m = computeCoreMetrics(attempts)
  const qMap = new Map(questions.map((q) => [q.id, q]))
  // 词汇题为运行时由 vocab.json 派生，不在 questions 表中，按作答的题目 ID 前缀分类（两册各自 `g7?-vocab-`）
  const isVocabId = (id: string) => /^g7[ab]-vocab-/.test(id)
  const vocabAttempts = attempts.filter((a) => isVocabId(a.questionId))
  const grammarAttempts = attempts.filter((a) => !isVocabId(a.questionId))
  const todayCount = attempts.filter((a) => isSameLocalDay(a.submittedAt, localDayKey())).length
  const vocabWrong = [...new Set(vocabAttempts.filter((a) => !a.isCorrect).map((a) => a.questionId))]
  // 词题不在 questions 表中，qMap 必 miss：先走词汇解析器得到英文单词，仍无才回退原始 ID
  const vocabResolver = buildVocabResolver(vocab)

  container.innerHTML = `
    <h1>学习报告</h1>
    <div class="card">
      <h3>总体</h3>
      <ul class="list">
        <li>累计作答：${m.totalAttempts} 次（今日 ${todayCount} 次）</li>
        <li>首测正确率：${pct(m.firstTryCorrectRate)}（${m.firstCorrect}/${m.firstAttempts}）</li>
        <li>复测正确率：${pct(m.retryAttempts > 0 ? m.retryCorrect / m.retryAttempts : null)}（${m.retryCorrect}/${m.retryAttempts}）</li>
        <li>曾做错题目：${m.wrongQuestions} 道</li>
      </ul>
    </div>
    <div class="card">
      <h3>语法专项</h3>
      <ul class="list">
        <li>作答 ${grammarAttempts.length} 次</li>
        <li>首测正确率：${pct(computeCoreMetrics(grammarAttempts).firstTryCorrectRate)}</li>
      </ul>
    </div>
    <div class="card">
      <h3>单词默写</h3>
      <ul class="list">
        <li>作答 ${vocabAttempts.length} 次</li>
        <li>首测正确率：${pct(computeCoreMetrics(vocabAttempts).firstTryCorrectRate)}</li>
      </ul>
      ${vocabWrong.length > 0 ? `<p class="muted">易错词：${vocabWrong.map((id) => escapeHtml(vocabResolver.resolve(id)?.answer ?? qMap.get(id)?.answerSpec.acceptedAnswers?.[0] ?? id)).slice(0, 12).join('、')}${vocabWrong.length > 12 ? '…' : ''}</p>` : ''}
    </div>
    <p class="muted">七天趋势与薄弱点排行将在后续版本提供。</p>`
  window.removeEventListener('hashchange', onHashChange)
}
