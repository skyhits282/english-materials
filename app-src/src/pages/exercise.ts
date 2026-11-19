import type { PageRenderer } from '../router'
import { navigate } from '../router'
import type { Question, Settings } from '../types'
import { fetchContentBundle, deriveVocabQuestions, findVocabUnit } from '../content/loader'
import { DEFAULT_SETTINGS, getSettings, questionsByUnitPrefix } from '../db/repos'
import { getReviewSet, listAllQuestions } from '../db/repos'
import { isStorageAvailable } from '../db/availability'
import type { Submission } from '../domain/session'
import { escapeHtml } from '../ui/escape'
import { getAiUsageToday } from '../services/ai/quota'
import { runAiTask, type AiRawResult, type ExplainMistakePayload, type ExplainMistakeResult } from '../services/ai/tasks'
import { aiButtonState, aiErrorText } from '../services/ai/ui'
import { buildRecordingSession } from './session-setup'
import { markTaskCompleted, markTaskStarted } from './task-hooks'

const LETTERS = ['A', 'B', 'C', 'D']

/** AI 讲解结果渲染（模块级纯渲染函数）：三段"提示/讲解/变式练习"；{raw} 降级时整段纯文本展示。
 *  AI 返回内容一律 escapeHtml（红线：不信任外部模型输出）。 */
function explainResultHtml(result: ExplainMistakeResult | AiRawResult): string {
  if ('raw' in result) {
    return `<div class="ai-panel"><h4>AI 讲解</h4><p>${escapeHtml(result.raw)}</p></div>`
  }
  return `<div class="ai-panel">
    <h4>提示</h4><p>${escapeHtml(result.hint)}</p>
    <h4>讲解</h4><p>${escapeHtml(result.explanation)}</p>
    <h4>变式练习</h4><p>${escapeHtml(result.followUpQuestion)}</p>
  </div>`
}

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
  let missing = 0
  for (const id of review.questionIds) {
    const q = byId.get(id)
    if (q) questions.push(q)
    else {
      missing += 1
      console.warn('复测题无法解析（内容缺失），已跳过：', id)
    }
  }
  if (questions.length === 0) {
    // 有到期题但内容全缺失（题库未播种/被清）：与"无到期题"区分，引导刷新题库
    return {
      title: '到期复习',
      questions: [],
      emptyMessage: missing > 0 ? '到期复习题内容缺失，请刷新题库。' : '今日没有到期复习。',
    }
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
  // set=<专项 id>（今日页任务卡入口）与 special=<专项 id>（既有入口）共用同一加载路径
  const special = params.get('set') || params.get('special')
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
  // 任务驱动练习（今日页卡片带 task=<id>）：进入即置 in_progress，renderSummary 完成节点回写 completed；
  // 无 task 参数为自由练，不回写。中途退出（hashchange 离开）保持 in_progress。
  const taskId = params.get('task') || undefined
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

    // 任务驱动练习：题目加载成功（非空）即视为"进入练习"，把任务置 in_progress；
    // 加载失败或空态（无题可练）时不转移，任务保持 planned
    if (taskId) await markTaskStarted(taskId)
    if (stale) return

    // AI 按钮状态底座：配置快照 + 今日用量。读取失败按"未配置"降级（按钮灰态），不阻塞练习主链路
    let settings: Settings = DEFAULT_SETTINGS
    let aiUsage = 0
    try {
      ;[settings, aiUsage] = await Promise.all([getSettings(), getAiUsageToday()])
    } catch (err) {
      console.warn('AI 配置/用量读取失败，AI 按钮按未配置处理：', err)
    }
    if (stale) return
    // 会话内 AI 请求统一取消源：hashchange 离开页面时中止在途请求（中止在途请求省服务端计费；UI 已随页面卸载）
    const aiAbort = new AbortController()
    window.addEventListener('hashchange', () => aiAbort.abort(), { once: true })
    // "AI 提示"每题限一次的会话内记录（页面内存，不落库）
    const coachUsed = new Set<string>()

    /** 一次 AI 调用结束后刷新今日用量并同步页面现存 AI 按钮灰态（一次调用可能把当日额度用完） */
    const syncAiButtons = async (): Promise<void> => {
      try {
        aiUsage = await getAiUsageToday()
      } catch {
        return // 用量读取失败：保持现状（灰态略滞后可接受，调用层仍会兜底拒绝）
      }
      const state = aiButtonState(settings, aiUsage)
      for (const id of ['ai-coach', 'ai-explain']) {
        const btn = container.querySelector<HTMLButtonElement>(`#${id}`)
        if (btn && !btn.classList.contains('is-loading')) {
          btn.disabled = state.disabled
          btn.title = state.title
        }
      }
    }

    const session = buildRecordingSession(data.questions, storageOk)
    const stats = { correct: 0, total: session.total }

    const renderQuestion = () => {
      const q = session.current
      const progress = Math.round((session.done / session.total) * 100)
      const aiState = aiButtonState(settings, aiUsage)
      // 每题限一次（会话内记录）：已用过 AI 提示的题不再渲染按钮（提示内容随该题 DOM 卸载）
      const coachBtn = coachUsed.has(q.id)
        ? ''
        : `<button class="btn btn-secondary" id="ai-coach"${aiState.disabled ? ' disabled' : ''} title="${escapeHtml(aiState.title)}">AI 提示</button>`
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
            ${coachBtn}
            <button class="btn btn-secondary" id="giveup">我不会</button>
          </div>
          <div id="ai-coach-out"></div>
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

      /** AI 提示（提交前，教练式不代答）：只传题干不传答案；成功后本题不再提供；
       *  失败显示错误类别并允许「重试」一次（第二次失败仅保留错误提示，按钮移除）。
       *  coachAttempts 为本题内计数（renderQuestion 每次重建，天然按题重置）。 */
      let coachAttempts = 0
      const runCoach = async (): Promise<void> => {
        const btn = container.querySelector<HTMLButtonElement>('#ai-coach')
        const out = container.querySelector('#ai-coach-out')
        if (!btn || !out || btn.disabled) return
        coachAttempts += 1
        btn.disabled = true
        btn.classList.add('is-loading')
        try {
          const result = await runAiTask('coach_turn', { stem: q.stem }, { settings }, aiAbort.signal)
          if (stale || !btn.isConnected) return // 已翻页/离页：结果丢弃，不回写已卸载的 DOM
          coachUsed.add(q.id)
          btn.remove()
          const hint = 'raw' in result ? result.raw : result.hint
          out.innerHTML = `<div class="ai-panel"><h4>AI 提示</h4><p>${escapeHtml(hint)}</p></div>`
          await syncAiButtons()
        } catch (err) {
          if (stale || !btn.isConnected) return
          btn.classList.remove('is-loading')
          out.innerHTML = `<div class="ai-panel ai-error"><p>AI 提示失败：${escapeHtml(aiErrorText(err))}</p></div>`
          if (coachAttempts >= 2) {
            btn.remove()
          } else {
            await syncAiButtons() // 失败也计一次额度：可能需要转为灰态
            if (btn.isConnected && !btn.disabled) btn.textContent = '重试'
          }
        }
      }
      container.querySelector('#ai-coach')?.addEventListener('click', () => void runCoach())
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
      const aiState = aiButtonState(settings, aiUsage)
      panel.innerHTML = `
        <p class="verdict">${sub.isCorrect ? '✓ 答对了' : '✗ 答错了'}</p>
        ${sub.isCorrect ? '' : `<p>正确答案：<strong>${escapeHtml(sub.correctAnswer)}</strong></p>`}
        <p>${escapeHtml(sub.question.explanation)}</p>
        ${sub.isCorrect
          ? ''
          : `<div class="action-row"><button class="btn btn-secondary" id="ai-explain"${aiState.disabled ? ' disabled' : ''} title="${escapeHtml(aiState.title)}">AI 讲解</button></div>
        <div id="ai-explain-out"></div>`}
        <div class="action-row"><button class="btn" id="next">${sub.isLast ? '查看总结' : '下一题'}</button></div>`
      container.querySelector('.card')?.appendChild(panel)
      container.querySelector('#giveup')?.setAttribute('disabled', 'true')
      container.querySelector('#submit')?.setAttribute('disabled', 'true')
      // 已判分反馈出现后"AI 提示"（提交前功能）一并停用，避免答完再索取提示式引导
      container.querySelector('#ai-coach')?.setAttribute('disabled', 'true')
      panel.querySelector('#next')?.addEventListener('click', () => {
        if (session.isFinished) renderSummary()
        else renderQuestion()
      })

      /** AI 讲解（仅答错时渲染）：explain_mistake 三段展示；失败显示错误类别并「重试」一次。
       *  独立于判分/记录主链路：仅按钮点击触发，异常全部在本闭包内消化。 */
      if (!sub.isCorrect) {
        let explainAttempts = 0
        const runExplain = async (): Promise<void> => {
          const btn = panel.querySelector<HTMLButtonElement>('#ai-explain')
          const out = panel.querySelector('#ai-explain-out')
          if (!btn || !out || btn.disabled) return
          explainAttempts += 1
          btn.disabled = true
          btn.classList.add('is-loading')
          // 学生作答空串（"我不会"弃答）时注明未作答，避免模型把空串当异常输入
          const payload: ExplainMistakePayload = {
            question: {
              stem: sub.question.stem,
              ...(sub.question.options !== undefined && sub.question.options.length > 0
                ? { options: sub.question.options }
                : {}),
              correctAnswer: sub.correctAnswer,
            },
            studentAnswer: sub.answer === '' ? '（未作答）' : sub.answer,
            knowledgePoints: sub.question.knowledgePointIds,
          }
          try {
            const result = await runAiTask('explain_mistake', payload, { settings }, aiAbort.signal)
            if (stale || !btn.isConnected) return
            btn.remove()
            out.innerHTML = explainResultHtml(result)
            await syncAiButtons()
          } catch (err) {
            if (stale || !btn.isConnected) return
            btn.classList.remove('is-loading')
            out.innerHTML = `<div class="ai-panel ai-error"><p>AI 讲解失败：${escapeHtml(aiErrorText(err))}</p></div>`
            if (explainAttempts >= 2) {
              btn.remove()
            } else {
              await syncAiButtons()
              if (btn.isConnected && !btn.disabled) btn.textContent = '重试'
            }
          }
        }
        panel.querySelector('#ai-explain')?.addEventListener('click', () => void runExplain())
      }
    }

    const renderSummary = () => {
      window.removeEventListener('hashchange', onHashChange)
      // 完成节点（全部题目提交完 → 查看总结）：任务回写 completed（真实作答完成才计，规格 §2.2）
      if (taskId) void markTaskCompleted(taskId)
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
