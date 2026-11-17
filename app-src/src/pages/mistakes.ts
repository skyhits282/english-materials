import type { PageRenderer } from '../router'
import type { VocabBook } from '../types'
import { listAttempts, listAllQuestions } from '../db/repos'
import { fetchContentBundle } from '../content/loader'
import { buildVocabResolver, type VocabResolved } from '../content/vocab-resolve'
import { escapeHtml } from '../ui/escape'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

export const renderMistakes: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>错题本</h1><p class="muted">加载中…</p>'
  let attempts: Awaited<ReturnType<typeof listAttempts>> = []
  let questions: Awaited<ReturnType<typeof listAllQuestions>> = []
  let vocab: VocabBook[] = []
  try {
    // 词题为运行时派生、不在 questions 表中：bundle 失败时降级为空数组，解析器全部未命中，沿用旧显示
    [attempts, questions, vocab] = await Promise.all([
      listAttempts(),
      listAllQuestions(),
      fetchContentBundle().then((b) => b.vocab).catch(() => {
        console.warn('题库加载失败，词汇题暂按原始 ID 显示')
        return [] as VocabBook[]
      }),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>错题本</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const qMap = new Map(questions.map((q) => [q.id, q]))
  const resolver = buildVocabResolver(vocab)
  const wrong = attempts.filter((a) => !a.isCorrect)
  if (wrong.length === 0) {
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>错题本</h1><div class="card"><p>还没有错题记录。先去今日学习做几道题吧。</p></div>'
    return
  }
  const items = wrong.map((a) => {
    const q = qMap.get(a.questionId)
    const vocabHit: VocabResolved | undefined = resolver.resolve(a.questionId)
    return {
      attempt: a,
      question: q,
      vocabHit,
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
      <h3>${escapeHtml(it.question?.stem ?? it.vocabHit?.stem ?? it.attempt.questionId)}</h3>
      ${it.question?.type === 'single_choice' && it.attempt.answer !== '' ? `<p class="muted">你的答案：${escapeHtml(it.question.options?.[Number(it.attempt.answer)] ?? it.attempt.answer)}</p>` : `<p class="muted">你的答案：${escapeHtml(it.attempt.answer || '（未作答）')}</p>`}
      <p>正确答案：<strong>${escapeHtml(it.question?.options?.[it.question?.answerSpec.correctOptionIndex ?? 0] ?? it.question?.answerSpec.acceptedAnswers?.[0] ?? it.vocabHit?.answer ?? '—')}</strong></p>
      <p>${escapeHtml(it.question?.explanation ?? '')}</p>
    </div>`,
      )
      .join('')}`
  window.removeEventListener('hashchange', onHashChange)
}
