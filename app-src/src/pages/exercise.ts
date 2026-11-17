import type { PageRenderer } from '../router'
import { navigate } from '../router'
import type { Question } from '../types'
import { fetchContentBundle, deriveVocabQuestions, findVocabUnit } from '../content/loader'
import { questionsByUnitPrefix } from '../db/repos'
import { saveAttempt, hasPriorAttempt, applyMasteryUpdate, getReviewSet, listAllQuestions } from '../db/repos'
import { isStorageAvailable } from '../db/availability'
import { PracticeSession, type Submission } from '../domain/session'
import { escapeHtml } from '../ui/escape'

const LETTERS = ['A', 'B', 'C', 'D']

function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

/** 复测模式（#/exercise?set=review）：getReviewSet 产出到期题 ID，这里解析为 Question 对象。
 *  选择题以 questions 表为准，词题不在表中、由 bundle 词汇派生（与词汇模式同一派生路径，题干格式自然一致）；
 *  保留 picker 的轮转均衡顺序，不再 shuffle（打散会破坏知识点均衡）。 */
async function loadReviewQuestions(): Promise<{ title: string; questions: Question[]; emptyMessage?: string }> {
  const storageOk = await isStorageAvailable()
  if (!storageOk) {
    // 复测数据全在 IndexedDB：存储不可用时按无到期数据展示空态（而非错误面板）
    return { title: '到期复习', questions: [], emptyMessage: '浏览器存储不可用，无法读取到期复习数据。' }
  }
  const review = await getReviewSet()
  if (review.questionIds.length === 0) {
    return { title: '到期复习', questions: [], emptyMessage: '今日没有到期复习。' }
  }
  const [bundle, dbQuestions] = await Promise.all([fetchContentBundle(), listAllQuestions()])
  const byId = new Map<string, Question>()
  for (const q of dbQuestions) byId.set(q.id, q)
  for (const book of bundle.vocab) {
    for (const unit of book.units) {
      for (const q of deriveVocabQuestions(bundle.vocab, unit.id)) byId.set(q.id, q)
    }
  }
  const questions: Question[] = []
  for (const id of review.questionIds) {
    const q = byId.get(id)
    if (q) questions.push(q)
    else console.warn('复测题无法解析（内容缺失），已跳过：', id)
  }
  if (questions.length === 0) {
    return { title: '到期复习', questions: [], emptyMessage: '今日没有到期复习。' }
  }
  return { title: `到期复习 · ${questions.length} 题`, questions }
}

async function loadQuestions(
  params: URLSearchParams,
): Promise<{ title: string; questions: Question[]; emptyMessage?: string }> {
  if (params.get('set') === 'review') {
    return loadReviewQuestions()
  }
  const vocabUnit = params.get('vocab')
  if (vocabUnit) {
    const bundle = await fetchContentBundle()
    const unit = findVocabUnit(bundle.vocab, vocabUnit)
    return { title: `单词默写 · ${unit?.label ?? vocabUnit}`, questions: shuffle(deriveVocabQuestions(bundle.vocab, vocabUnit)) }
  }
  const special = params.get('special')
  if (special) {
    const storageOk = await isStorageAvailable()
    if (storageOk) {
      const questions = await questionsByUnitPrefix(special)
      return { title: '专项练习', questions: shuffle(questions) }
    }
    const bundle = await fetchContentBundle()
    const questions = bundle.questions.filter((q) => q.unit.startsWith(special))
    return { title: '专项练习', questions: shuffle(questions) }
  }
  return { title: '练习', questions: [] }
}

export const renderExercise: PageRenderer = ({ container, params }) => {
  const start = async (): Promise<void> => {
    let stale = false
    const onHashChange = () => { stale = true }
    window.addEventListener('hashchange', onHashChange, { once: true })
    container.innerHTML = '<h1>学习练习</h1><p class="muted">加载中…</p>'
    let data: { title: string; questions: Question[]; emptyMessage?: string }
    let storageOk = false
    try {
      storageOk = await isStorageAvailable()
      data = await loadQuestions(params)
    } catch (err) {
      window.removeEventListener('hashchange', onHashChange)
      if (stale) return
      container.innerHTML = `<h1>学习练习</h1><div class="error-panel">题库加载失败：${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry">重试</button></div></div>`
      container.querySelector('#retry')?.addEventListener('click', () => void start())
      return
    }
    if (stale) return
    if (data.questions.length === 0) {
      window.removeEventListener('hashchange', onHashChange)
      container.innerHTML = `<h1>学习练习</h1><div class="card"><h3>${escapeHtml(data.title)}</h3><p>${escapeHtml(data.emptyMessage ?? '该内容暂无题目。')}</p><div class="action-row"><button class="btn btn-secondary" id="back">返回今日学习</button></div></div>`
      container.querySelector('#back')?.addEventListener('click', () => navigate('today'))
      return
    }

    // 提交挂钩：attempt 追加与 mastery 更新走同一事务（applyMasteryUpdate）；
    // 挂钩失败仅 console.warn 并回退为单独保存 attempt，不影响判分主链路（沿用 M1 降级哲学）
    const questionsById = new Map(data.questions.map((item) => [item.id, item] as const))
    const session = new PracticeSession(data.questions, {
      hasPriorAttempt: storageOk ? hasPriorAttempt : async () => false,
      recordAttempt: storageOk
        ? async (a) => {
            const question = questionsById.get(a.questionId)
            if (!question) {
              console.warn('mastery 挂钩跳过：会话内未找到题目', a.questionId)
              await saveAttempt(a)
              return
            }
            try {
              await applyMasteryUpdate(a, question)
            } catch (err) {
              console.warn('mastery 更新失败，回退为仅保存 attempt：', err)
              await saveAttempt(a)
            }
          }
        : async (a) => console.warn('存储不可用，跳过记录：', a.questionId),
    })
    const stats = { correct: 0, total: session.total }

    const renderQuestion = () => {
      const q = session.current
      const progress = Math.round((session.done / session.total) * 100)
      container.innerHTML = `
        <h1>${escapeHtml(data.title)}</h1>
        <div class="progress-bar"><div style="width:${progress}%"></div></div>
        <p class="muted">第 ${session.done + 1} / ${session.total} 题</p>
        ${storageOk ? '' : '<p class="muted">存储不可用，本次练习不会保存记录。</p>'}
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
            if (container.querySelector('.feedback')) return
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
          if (e.isComposing) return
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
        if (stale) return
        container.innerHTML = `<h1>${escapeHtml(data.title)}</h1><div class="error-panel">提交失败，学习记录未能保存。${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry-submit">重试本题</button></div></div>`
        container.querySelector('#retry-submit')?.addEventListener('click', () => renderQuestion())
        return
      }
      if (stale) return
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
      window.removeEventListener('hashchange', onHashChange)
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
  return start()
}
