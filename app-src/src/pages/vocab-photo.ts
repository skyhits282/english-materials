/** 手写拍照默写流程（2026-11-19 规格 §1.2）：三屏——默写卷面 / 识别中 / 结果。
 *  识别成功即直接判分（已确认决策）：缺失序号按未作答（gaveUp）记错误 attempt；
 *  整页零识别不判分不记录，提示重拍；识别失败可重拍（每次消耗一次 AI 额度）。
 *  红线：照片仅进识别请求体，不落 IndexedDB/aiRequests/备份（attempts 只存识别文本）。
 *  中途离开页面：hashchange 置 stale 并中止在途识别（省服务端计费）。 */
import type { Question, Settings } from '../types'
import { getAiUsageToday } from '../services/ai/quota'
import { recognizeHandwrittenWords } from '../services/ai/vision'
import { aiButtonState, aiErrorText } from '../services/ai/ui'
import { alignRecognizedWords } from '../domain/dictation-align'
import { compressImageFile } from '../utils/image'
import { escapeHtml } from '../ui/escape'
import { navigate } from '../router'
import { buildRecordingSession } from './session-setup'
import { markTaskCompleted } from './task-hooks'

export interface VocabPhotoFlowOptions {
  container: HTMLElement
  /** 页面标题（如「单词默写 · Unit 1」） */
  title: string
  /** 固定顺序的词汇题（不 shuffle：卷面序号 = 纸面序号 = 对齐序号） */
  questions: Question[]
  settings: Settings
  storageOk: boolean
  /** 任务驱动练习的任务 id（自由练习无） */
  taskId?: string
}

interface ResultRow {
  question: Question
  text: string | null
  isCorrect: boolean
  correctAnswer: string
}

export function runVocabPhotoFlow(opts: VocabPhotoFlowOptions): void {
  const { container, title, questions, settings, storageOk, taskId } = opts
  let stale = false
  const aiAbort = new AbortController()
  window.addEventListener('hashchange', () => {
    stale = true
    aiAbort.abort()
  }, { once: true })

  let aiUsage = 0
  const start = async (): Promise<void> => {
    // AI 按钮状态底座：读取失败按 0 用量处理（灰态推导仍由 aiButtonState 兜底口径）
    try {
      aiUsage = await getAiUsageToday()
    } catch {
      /* 保持 0，调用层仍会兜底拒绝 */
    }
    if (stale) return
    renderSheet()
  }
  void start()

  /** 屏 1：默写卷面（notice 为重拍提示等辅助信息） */
  const renderSheet = (notice = ''): void => {
    const state = aiButtonState(settings, aiUsage)
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <p class="muted">按下方序号在纸上默写，全部写完后拍照上传（整页一张）。</p>
      ${storageOk ? '' : '<p class="muted">存储不可用，本次练习不会保存记录。</p>'}
      <div class="card">
        <h3>默写卷面（共 ${questions.length} 词）</h3>
        <ol class="dictation-sheet" style="padding-left:1.5rem">
          ${questions.map((q) => `<li style="margin:0.35rem 0">${escapeHtml(q.stem)}</li>`).join('')}
        </ol>
        <div class="action-row">
          <label class="btn btn-secondary" style="display:inline-flex;align-items:center" title="${escapeHtml(state.title)}">拍照上传
            <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none"${state.disabled ? ' disabled' : ''}>
          </label>
          <button class="btn btn-secondary" id="photo-back">返回今日学习</button>
        </div>
        ${notice === '' ? '' : `<p class="muted">${escapeHtml(notice)}</p>`}
      </div>`
    container.querySelector('#photo-input')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (file === undefined) return
      input.value = '' // 允许同一文件重选也触发 change
      void handlePhoto(file)
    })
    container.querySelector('#photo-back')?.addEventListener('click', () => navigate('today'))
  }

  const handlePhoto = async (file: File): Promise<void> => {
    let dataUrl: string
    try {
      dataUrl = await compressImageFile(file)
    } catch (err) {
      if (stale) return
      renderSheet(err instanceof Error ? err.message : '图片读取失败，请重拍。')
      return
    }
    if (stale) return
    renderRecognizing(dataUrl)
    try {
      const words = await recognizeHandwrittenWords(
        { imageDataUrl: dataUrl, expectedCount: questions.length },
        { settings },
        aiAbort.signal,
      )
      if (stale) return
      if (aiAbort.signal.aborted) return
      if (words.length === 0) {
        renderSheet('未识别到手写内容，请对准纸面、光线充足后重拍。')
        return
      }
      await gradeAll(words)
    } catch (err) {
      if (stale || aiAbort.signal.aborted) return
      renderRecognizeFailed(dataUrl, err)
    }
  }

  /** 屏 2a：识别中 */
  const renderRecognizing = (dataUrl: string): void => {
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>识别中…</h3>
        <img src="${escapeHtml(dataUrl)}" alt="待识别照片" style="max-width:100%;max-height:40vh">
        <p class="muted">正在识别手写单词，最长约 45 秒，请稍候。</p>
      </div>`
  }

  /** 屏 2b：识别失败（错误分类文案 + 重拍） */
  const renderRecognizeFailed = (dataUrl: string, err: unknown): void => {
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>识别失败</h3>
        <img src="${escapeHtml(dataUrl)}" alt="照片预览" style="max-width:100%;max-height:40vh">
        <p class="muted">${escapeHtml(aiErrorText(err))}</p>
        <div class="action-row">
          <button class="btn" id="photo-retry">重新拍照</button>
          <button class="btn btn-secondary" id="photo-back">返回今日学习</button>
        </div>
      </div>`
    container.querySelector('#photo-retry')?.addEventListener('click', () => renderSheet())
    container.querySelector('#photo-back')?.addEventListener('click', () => navigate('today'))
  }

  /** 识别成功 → 直接判分（无确认环节）：逐题经 PracticeSession 提交（判分/记录/mastery 全复用） */
  const gradeAll = async (words: { index: number; text: string }[]): Promise<void> => {
    const aligned = alignRecognizedWords(questions.length, words)
    const session = buildRecordingSession(questions, storageOk)
    const rows: ResultRow[] = []
    try {
      for (const a of aligned) {
        const sub = await session.submit(a.text ?? '', a.text === null ? { gaveUp: true } : {})
        rows.push({ question: sub.question, text: a.text, isCorrect: sub.isCorrect, correctAnswer: sub.correctAnswer })
      }
    } catch (err) {
      // attempts 只追加：部分已保存的记录不可回滚，也不提供整页重试（会重复追加）；
      // 引导返回，已保存部分照常生效（与键盘流"提交失败"同一哲学）
      if (stale) return
      console.warn('拍照判分提交失败：', err)
      container.innerHTML = `
        <h1>${escapeHtml(title)}</h1>
        <div class="error-panel">部分学习记录保存失败，已保存的作答不受影响。${escapeHtml(String(err))}
          <div class="action-row"><button class="btn" id="photo-back-err">返回今日学习</button></div>
        </div>`
      container.querySelector('#photo-back-err')?.addEventListener('click', () => navigate('today'))
      return
    }
    if (stale) return
    if (taskId) void markTaskCompleted(taskId)
    renderResults(rows)
  }

  /** 屏 3：结果（逐行对错 + 汇总） */
  const renderResults = (rows: ResultRow[]): void => {
    const correct = rows.filter((r) => r.isCorrect).length
    const pct = rows.length === 0 ? 0 : Math.round((correct / rows.length) * 100)
    container.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <h3>批改完成</h3>
        <p>共 ${rows.length} 词，写对 ${correct} 词（${pct}%）。识别结果仅供参考，如有出入以纸面为准。</p>
        ${rows
          .map(
            (r, i) => `<div class="feedback ${r.isCorrect ? 'ok' : 'bad'}" style="margin:0.5rem 0">
          <p class="verdict">${i + 1}. ${r.isCorrect ? '✓' : '✗'} ${r.text === null ? '<span class="muted">未作答</span>' : escapeHtml(r.text)}${r.isCorrect ? '' : ` → 正确答案：<strong>${escapeHtml(r.correctAnswer)}</strong>`}</p>
          <p class="muted">${escapeHtml(r.question.stem)}</p>
        </div>`,
          )
          .join('')}
        <div class="action-row">
          <button class="btn" id="photo-back-today">返回今日学习</button>
          <button class="btn btn-secondary" id="photo-to-mistakes">查看错题本</button>
        </div>
      </div>`
    container.querySelector('#photo-back-today')?.addEventListener('click', () => navigate('today'))
    container.querySelector('#photo-to-mistakes')?.addEventListener('click', () => navigate('mistakes'))
  }
}
