import type { PageRenderer } from '../router'
import { listAttempts, listAllQuestions } from '../db/repos'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

export const renderMistakes: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>错题本</h1><p class="muted">加载中…</p>'
  const [attempts, questions] = await Promise.all([listAttempts(), listAllQuestions()])
  if (stale) return
  const qMap = new Map(questions.map((q) => [q.id, q]))
  const wrong = attempts.filter((a) => !a.isCorrect)
  if (wrong.length === 0) {
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>错题本</h1><div class="card"><p>还没有错题记录。先去今日学习做几道题吧。</p></div>'
    return
  }
  const items = wrong.map((a) => {
    const q = qMap.get(a.questionId)
    return {
      attempt: a,
      question: q,
      kp: q?.knowledgePointIds[0] ?? '未知知识点',
      time: a.submittedAt,
    }
  })
  items.sort((x, y) => (x.time < y.time ? 1 : -1))
  container.innerHTML = `
    <h1>错题本</h1>
    <p class="muted">共 ${wrong.length} 条错误作答。复测排期将在后续版本提供。</p>
    ${items
      .map(
        (it) => `
    <div class="card">
      <p><span class="badge">${escapeHtml(it.kp)}</span><span class="muted">${formatTime(it.time)}${it.attempt.phase === 'retry' ? ' · 复测' : ' · 首测'}</span></p>
      <h3>${escapeHtml(it.question?.stem ?? it.attempt.questionId)}</h3>
      ${it.question?.type === 'single_choice' && it.attempt.answer !== '' ? `<p class="muted">你的答案：${escapeHtml(it.question.options?.[Number(it.attempt.answer)] ?? it.attempt.answer)}</p>` : `<p class="muted">你的答案：${escapeHtml(it.attempt.answer || '（未作答）')}</p>`}
      <p>正确答案：<strong>${escapeHtml(it.question?.options?.[it.question?.answerSpec.correctOptionIndex ?? 0] ?? it.question?.answerSpec.acceptedAnswers?.[0] ?? '—')}</strong></p>
      <p>${escapeHtml(it.question?.explanation ?? '')}</p>
    </div>`,
      )
      .join('')}`
  window.removeEventListener('hashchange', onHashChange)
}
