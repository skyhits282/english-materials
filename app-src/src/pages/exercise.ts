import type { PageRenderer } from '../router'
import { navigate } from '../router'
import type { Question } from '../types'
import { fetchContentBundle, deriveVocabQuestions } from '../content/loader'
import { questionsByUnitPrefix } from '../db/repos'
import { saveAttempt, hasPriorAttempt } from '../db/repos'
import { PracticeSession, type Submission } from '../domain/session'

const LETTERS = ['A', 'B', 'C', 'D']

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

async function loadQuestions(params: URLSearchParams): Promise<{ title: string; questions: Question[] }> {
  const vocabUnit = params.get('vocab')
  if (vocabUnit) {
    const bundle = await fetchContentBundle()
    const unit = bundle.vocab.units.find((u) => u.id === vocabUnit)
    return { title: `单词默写 · ${unit?.label ?? vocabUnit}`, questions: shuffle(deriveVocabQuestions(bundle.vocab, vocabUnit)) }
  }
  const special = params.get('special')
  if (special) {
    const questions = await questionsByUnitPrefix(special)
    return { title: '专项练习', questions: shuffle(questions) }
  }
  return { title: '练习', questions: [] }
}

export const renderExercise: PageRenderer = async ({ container, params }) => {
  container.innerHTML = '<h1>学习练习</h1><p class="muted">加载中…</p>'
  let data: { title: string; questions: Question[] }
  try {
    data = await loadQuestions(params)
  } catch (err) {
    container.innerHTML = `<h1>学习练习</h1><div class="error-panel">题库加载失败：${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry">重试</button></div></div>`
    container.querySelector('#retry')?.addEventListener('click', () => navigate('exercise', Object.fromEntries(params)))
    return
  }
  if (data.questions.length === 0) {
    container.innerHTML = `<h1>学习练习</h1><div class="card"><h3>${escapeHtml(data.title)}</h3><p>该内容暂无题目。</p><div class="action-row"><button class="btn btn-secondary" id="back">返回今日学习</button></div></div>`
    container.querySelector('#back')?.addEventListener('click', () => navigate('today'))
    return
  }

  const session = new PracticeSession(data.questions, {
    hasPriorAttempt,
    recordAttempt: saveAttempt,
  })
  const stats = { correct: 0, total: session.total }

  const renderQuestion = () => {
    const q = session.current
    const progress = Math.round((session.done / session.total) * 100)
    container.innerHTML = `
      <h1>${escapeHtml(data.title)}</h1>
      <div class="progress-bar"><div style="width:${progress}%"></div></div>
      <p class="muted">第 ${session.done + 1} / ${session.total} 题</p>
      <div class="card">
        <h3 style="font-size:1.25rem">${escapeHtml(q.stem)}</h3>
        ${q.type === 'single_choice' ? renderOptions(q) : renderFill()}
        <div class="action-row">
          ${q.type === 'fill_in' ? '<button class="btn" id="submit">提交答案</button>' : ''}
          <button class="btn btn-secondary" id="giveup">我不会</button>
        </div>
      </div>`
    if (q.type === 'single_choice') {
      for (const btn of container.querySelectorAll<HTMLButtonElement>('.option-btn')) {
        btn.addEventListener('click', () => {
          for (const b of container.querySelectorAll('.option-btn')) b.classList.remove('selected')
          btn.classList.add('selected')
          void submit(btn.dataset.index ?? '')
        })
      }
    } else {
      container.querySelector('#submit')?.addEventListener('click', () => {
        const input = container.querySelector<HTMLInputElement>('#fill-input')
        void submit(input?.value ?? '')
      })
      container.querySelector<HTMLInputElement>('#fill-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') container.querySelector<HTMLButtonElement>('#submit')?.click()
      })
    }
    container.querySelector('#giveup')?.addEventListener('click', () => void submit('', { gaveUp: true }))
  }

  const renderFill = () => '<input class="fill-input" id="fill-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文单词" inputmode="text">'

  const renderOptions = (q: Question) => `<div class="options">${(q.options ?? []).map((opt, i) => `
    <button class="option-btn" data-index="${i}"><strong>${LETTERS[i] ?? ''}.</strong> ${escapeHtml(opt)}</button>`).join('')}</div>`

  const submit = async (answer: string, opts: { gaveUp?: boolean } = {}) => {
    if (container.querySelector('.feedback')) return
    let sub: Submission
    try {
      sub = await session.submit(answer, opts)
    } catch (err) {
      if (err instanceof Error && err.message === '正在处理上一次提交') return
      container.innerHTML = `<h1>${escapeHtml(data.title)}</h1><div class="error-panel">提交失败，学习记录未能保存。${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry-submit">重试本题</button></div></div>`
      container.querySelector('#retry-submit')?.addEventListener('click', () => renderQuestion())
      return
    }
    if (sub.isCorrect) stats.correct += 1
    const panel = document.createElement('div')
    panel.className = `feedback ${sub.isCorrect ? 'ok' : 'bad'}`
    panel.innerHTML = `
      <p class="verdict">${sub.isCorrect ? '✓ 答对了' : '✗ 答错了'}</p>
      ${sub.isCorrect ? '' : `<p>正确答案：<strong>${escapeHtml(sub.correctAnswer)}</strong></p>`}
      <p>${escapeHtml(sub.question.explanation)}</p>
      <div class="action-row"><button class="btn" id="next">${sub.isLast ? '查看总结' : '下一题'}</button></div>`
    container.querySelector('.card')?.appendChild(panel)
    container.querySelector('#giveup')?.setAttribute('disabled', 'true')
    container.querySelector('#submit')?.setAttribute('disabled', 'true')
    panel.querySelector('#next')?.addEventListener('click', () => {
      if (session.isFinished) renderSummary()
      else renderQuestion()
    })
  }

  const renderSummary = () => {
    container.innerHTML = `
      <h1>${escapeHtml(data.title)}</h1>
      <div class="card">
        <h3>练习完成</h3>
        <p>共 ${stats.total} 题，答对 ${stats.correct} 题（${Math.round((stats.correct / stats.total) * 100)}%）。</p>
        <div class="action-row">
          <button class="btn" id="back-today">返回今日学习</button>
          <button class="btn btn-secondary" id="to-mistakes">查看错题本</button>
        </div>
      </div>`
    container.querySelector('#back-today')?.addEventListener('click', () => navigate('today'))
    container.querySelector('#to-mistakes')?.addEventListener('click', () => navigate('mistakes'))
  }

  renderQuestion()
}
