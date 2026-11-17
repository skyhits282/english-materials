import type { PageRenderer } from '../router'
import { listAttempts, listAllQuestions } from '../db/repos'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from '../domain/metrics'

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
  try {
    [attempts, questions] = await Promise.all([listAttempts(), listAllQuestions()])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>学习报告</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const m = computeCoreMetrics(attempts)
  const qMap = new Map(questions.map((q) => [q.id, q]))
  // 词汇题为运行时由 vocab.json 派生，不在 questions 表中，按作答的题目 ID 前缀分类
  const vocabAttempts = attempts.filter((a) => a.questionId.startsWith('g7a-vocab-'))
  const grammarAttempts = attempts.filter((a) => !a.questionId.startsWith('g7a-vocab-'))
  const todayCount = attempts.filter((a) => isSameLocalDay(a.submittedAt, localDayKey())).length
  const vocabWrong = [...new Set(vocabAttempts.filter((a) => !a.isCorrect).map((a) => a.questionId))]

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
      ${vocabWrong.length > 0 ? `<p class="muted">易错词：${vocabWrong.map((id) => qMap.get(id)?.answerSpec.acceptedAnswers?.[0] ?? id).slice(0, 12).join('、')}${vocabWrong.length > 12 ? '…' : ''}</p>` : ''}
    </div>
    <p class="muted">七天趋势与薄弱点排行将在后续版本提供。</p>`
  window.removeEventListener('hashchange', onHashChange)
}
