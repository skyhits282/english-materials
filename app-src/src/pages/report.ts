import type { PageRenderer } from '../router'
import type { Settings, VocabBook } from '../types'
import { getSettings, listAllMastery, listAllTasks, listAttempts, listAllQuestions, saveWeeklyReport, listRecentWeeklyReports } from '../db/repos'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from '../domain/metrics'
import {
  knowledgePointCoverage,
  reviewOnTimeRate,
  sevenDayTrend,
  weakPoints,
  weeklyFacts,
  type WeeklyFacts,
} from '../domain/trends'
import { renderTrendChart } from '../ui/chart'
import { fetchContentBundle } from '../content/loader'
import { buildVocabResolver } from '../content/vocab-resolve'
import { escapeHtml } from '../ui/escape'
import { getAiUsageToday } from '../services/ai/quota'
import { runAiTask } from '../services/ai/tasks'
import { aiButtonState, aiErrorText } from '../services/ai/ui'
import type { TaskRow, WeeklyReportRow } from '../db/schema'

function pct(rate: number | null): string {
  return rate === null ? '暂无数据' : `${Math.round(rate * 100)}%`
}

/** 知识点 ID → 可读名：词题（vocab.<book>.<uN>）显示"词汇 · Unit N"（N 取短单元名序号，
 *  与 Task 2 解析器/单元表的 v1-uN/v2-uN 同源）；选择题截取末段（如
 *  grammar.present_simple.meaning → meaning）。 */
function kpLabel(kp: string): string {
  const m = /^vocab\.[a-z0-9]+\.u(\d+)$/.exec(kp)
  if (m) return `词汇 · Unit ${Number(m[1])}`
  const segs = kp.split('.')
  return segs[segs.length - 1] ?? kp
}

/** 周报 AI 建议渲染（新结果与历史存档共用）：存档为 JSON 字符串——四字段渲染四段，
 *  {raw} 降级或非 JSON 文本按单段纯文本展示。AI 返回内容一律 escapeHtml（不信任外部模型输出）。 */
function suggestionsHtml(aiSuggestions: string | undefined): string {
  if (aiSuggestions === undefined || aiSuggestions.trim() === '') return ''
  try {
    const parsed = JSON.parse(aiSuggestions) as Record<string, unknown>
    if (
      typeof parsed.progress === 'string' &&
      typeof parsed.weakness === 'string' &&
      typeof parsed.adjustments === 'string' &&
      typeof parsed.nextGoals === 'string'
    ) {
      return `<div class="ai-panel">
        <h4>本周进步</h4><p>${escapeHtml(parsed.progress)}</p>
        <h4>重点短板</h4><p>${escapeHtml(parsed.weakness)}</p>
        <h4>任务调整建议</h4><p>${escapeHtml(parsed.adjustments)}</p>
        <h4>下周目标</h4><p>${escapeHtml(parsed.nextGoals)}</p>
      </div>`
    }
    if (typeof parsed.raw === 'string') {
      return `<div class="ai-panel"><h4>AI 建议</h4><p>${escapeHtml(parsed.raw)}</p></div>`
    }
  } catch {
    // 非 JSON（历史版本或降级存档）：按纯文本展示
  }
  return `<div class="ai-panel"><h4>AI 建议</h4><p>${escapeHtml(aiSuggestions)}</p></div>`
}

/** 存档 facts 快照渲染（schema 中 facts 为 unknown，备份可注入任意形状）：字段缺失/类型异常按"暂无"降级 */
function storedFactsHtml(facts: unknown): string {
  const f = (facts ?? {}) as Partial<WeeklyFacts>
  const rate = (v: number | null | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '暂无'
  const wrongList: unknown[] = Array.isArray(f.repeatWrongKps) ? f.repeatWrongKps : []
  const wrong =
    wrongList.length > 0
      ? wrongList
          .map((k) => {
            const w = (k ?? {}) as { kp?: unknown; wrongCount?: unknown }
            return `${escapeHtml(typeof w.kp === 'string' ? kpLabel(w.kp) : '知识点')}（错 ${Number(w.wrongCount ?? 0)} 次）`
          })
          .join('、')
      : '无'
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '0')
  return `<ul class="list">
    <li>学习天数：${num(f.studyDays)} 天 · 作答 ${num(f.answeredCount)} 题</li>
    <li>任务完成率：${f.completionRate === null || f.completionRate === undefined ? '暂无任务' : rate(f.completionRate)}</li>
    <li>首测正确率：${rate(f.firstRate)}</li>
    <li>复测正确率：${rate(f.delayedRate)}</li>
    <li>反复错题知识点：${wrong}</li>
    <li>到期未完成复测：${num(f.overdueReviews)} 项</li>
  </ul>`
}

export const renderReport: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>学习报告</h1><p class="muted">加载中…</p>'
  let attempts: Awaited<ReturnType<typeof listAttempts>> = []
  let questions: Awaited<ReturnType<typeof listAllQuestions>> = []
  let vocab: VocabBook[] = []
  let tasks: TaskRow[] = []
  let mastery: Awaited<ReturnType<typeof listAllMastery>> = []
  let settings: Settings
  try {
    // 词题不在 questions 表中：bundle 失败时降级为空数组，易错词沿用原始 ID 显示（不比 M1 差）；
    // 词题知识点派生不依赖 bundle（按 questionId 约定），薄弱点/周报不受此降级影响
    ;[attempts, questions, vocab, tasks, mastery, settings] = await Promise.all([
      listAttempts(),
      listAllQuestions(),
      fetchContentBundle().then((b) => b.vocab).catch(() => {
        console.warn('题库加载失败，易错词暂按原始 ID 显示')
        return [] as VocabBook[]
      }),
      listAllTasks(),
      listAllMastery(),
      getSettings(),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>学习报告</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const now = new Date()
  const m = computeCoreMetrics(attempts)
  const trend = sevenDayTrend(attempts, now)
  const weak = weakPoints(attempts, questions, now)
  const onTimeRate = reviewOnTimeRate(mastery, attempts, questions, now)
  const facts = weeklyFacts(attempts, tasks, mastery, questions, now)
  const coverage = knowledgePointCoverage(attempts, tasks, questions, now)
  // AI 用量读取失败按 0 处理（按钮可点；调用层配额检查仍会兜底拒绝）
  let aiUsage = 0
  try {
    aiUsage = await getAiUsageToday()
  } catch (err) {
    console.warn('AI 用量读取失败，按 0 处理：', err)
  }
  if (stale) return
  const aiState = aiButtonState(settings, aiUsage)
  const qMap = new Map(questions.map((q) => [q.id, q]))
  // 词汇题为运行时由 vocab.json 派生，不在 questions 表中，按作答的题目 ID 前缀分类（两册各自 `g7?-vocab-`）
  const isVocabId = (id: string) => /^g7[ab]-vocab-/.test(id)
  const vocabAttempts = attempts.filter((a) => isVocabId(a.questionId))
  const grammarAttempts = attempts.filter((a) => !isVocabId(a.questionId))
  const todayCount = attempts.filter((a) => isSameLocalDay(a.submittedAt, localDayKey(now))).length
  const todayTasks = tasks.filter((t) => t.day === localDayKey(now))
  const todayCompleted = todayTasks.filter((t) => t.status === 'completed').length
  const vocabWrong = [...new Set(vocabAttempts.filter((a) => !a.isCorrect).map((a) => a.questionId))]
  // 词题不在 questions 表中，qMap 必 miss：先走词汇解析器得到英文单词，仍无才回退原始 ID
  const vocabResolver = buildVocabResolver(vocab)

  container.innerHTML = `
    <h1>学习报告</h1>
    <div class="card">
      <h3>七日趋势</h3>
      ${renderTrendChart(trend.days)}
      <p class="muted">${trend.totalAnswered > 0 ? `近 7 天共 ${trend.totalAnswered} 题 · 首测正确率 ${pct(trend.firstRate)}` : '近 7 天暂无作答'}</p>
    </div>
    <div class="card">
      <h3>总体</h3>
      <ul class="list">
        <li>累计作答：${m.totalAttempts} 次（今日 ${todayCount} 次）</li>
        <li>首测正确率：${pct(m.firstTryCorrectRate)}（${m.firstCorrect}/${m.firstAttempts}）</li>
        <li>复测正确率：${pct(m.retryAttempts > 0 ? m.retryCorrect / m.retryAttempts : null)}（${m.retryCorrect}/${m.retryAttempts}）</li>
        <li>曾做错题目：${m.wrongQuestions} 道</li>
        <li>今日任务完成率：${todayTasks.length > 0 ? `${todayCompleted}/${todayTasks.length}` : '今日暂无任务'}</li>
        <li>复测按时率：${onTimeRate === null ? '不适用' : pct(onTimeRate)}</li>
        <li>知识点覆盖率（本周）：${coverage.rate === null ? '暂无数据' : `${pct(coverage.rate)}（${coverage.covered}/${coverage.target}）`}</li>
      </ul>
    </div>
    <div class="card">
      <h3>优先薄弱点</h3>
      ${weak.length > 0
        ? `<ul class="list">${weak
            .map(
              (w) =>
                `<li>${escapeHtml(kpLabel(w.kp))} · 首测 ${w.firstCorrect}/${w.firstAnswered}（错误率 ${Math.round(w.wrongRate * 100)}%）</li>`,
            )
            .join('')}</ul>`
        : '<p>暂无足够数据：各知识点首测满 3 次后参与统计。</p>'}
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
    ${settings.examScores && settings.examScores.length > 0 ? `
    <div class="card">
      <h3>试卷成绩（手工录入）</h3>
      <ul class="list">
        ${settings.examScores.map((r) => `<li>${escapeHtml(r.label)} ${r.got}/${r.total}</li>`).join('')}
      </ul>
      <p class="muted">手工录入，仅供参考；不参与自动判分与指标。</p>
    </div>` : ''}
    <div class="card">
      <h3>本周周报（${facts.weekStart} 起）</h3>
      <ul class="list">
        <li>学习天数：${facts.studyDays} 天 · 作答 ${facts.answeredCount} 题</li>
        <li>任务完成率：${facts.completionRate === null ? '暂无任务' : pct(facts.completionRate)}</li>
        <li>首测正确率：${pct(facts.firstRate)}</li>
        <li>复测正确率：${pct(facts.delayedRate)}</li>
        <li>反复错题知识点：${facts.repeatWrongKps.length > 0 ? facts.repeatWrongKps.map((k) => `${escapeHtml(kpLabel(k.kp))}（${k.wrongCount} 次）`).join('、') : '无'}</li>
        <li>到期未完成复测：${facts.overdueReviews} 项</li>
      </ul>
      <div class="action-row"><button class="btn" id="weekly-ai"${aiState.disabled ? ' disabled' : ''} title="${escapeHtml(aiState.title)}">生成 AI 建议</button></div>
      <div id="weekly-ai-out"></div>
    </div>
    <div class="card">
      <h3>历史周报</h3>
      <div id="weekly-history"><p class="muted">加载中…</p></div>
    </div>`
  window.removeEventListener('hashchange', onHashChange)

  /** 历史周报区：最近 4 个有记录的周（weekStart 降序），<details> 可展开看 facts 摘要与 AI 建议 */
  const historyEl = () => container.querySelector('#weekly-history')
  const renderHistory = async (): Promise<void> => {
    const el = historyEl()
    if (!el) return
    let rows: WeeklyReportRow[] = []
    try {
      rows = await listRecentWeeklyReports(4)
    } catch (err) {
      console.warn('历史周报读取失败：', err)
      el.innerHTML = '<p class="muted">历史周报暂不可用（浏览器存储不可读）。</p>'
      return
    }
    if (rows.length === 0) {
      el.innerHTML = '<p class="muted">还没有历史周报：生成 AI 建议后会保存当周记录。</p>'
      return
    }
    el.innerHTML = rows
      .map(
        (row) => `
      <details>
        <summary>${escapeHtml(row.weekStart)} 起 · 生成于 ${escapeHtml(new Date(row.generatedAt).toLocaleDateString('zh-CN'))}</summary>
        <p class="muted">本周事实</p>
        ${storedFactsHtml(row.facts)}
        ${row.aiSuggestions ? '<p class="muted">AI 建议</p>' : ''}${suggestionsHtml(row.aiSuggestions)}
      </details>`,
      )
      .join('')
  }
  void renderHistory()

  /** 今日用量安全重读（失败沿用上次值）：失败也计额度，重试按钮可能需转灰态 */
  const safeUsage = async (): Promise<number> => {
    try {
      aiUsage = await getAiUsageToday()
    } catch {
      // 读取失败：沿用页内旧值（调用层配额检查兜底）
    }
    return aiUsage
  }

  /** 「生成 AI 建议」：调 weekly_insight；成功后四段展示并连同 facts 快照覆盖同周存档。
   *  失败显示错误类别并「重试」一次（第二次失败仅保留错误提示）。facts 部分不受影响，始终可见。 */
  let weeklyAttempts = 0
  const runWeekly = async (): Promise<void> => {
    const btn = container.querySelector<HTMLButtonElement>('#weekly-ai')
    const out = container.querySelector('#weekly-ai-out')
    if (!btn || !out || btn.disabled) return
    weeklyAttempts += 1
    btn.disabled = true
    btn.classList.add('is-loading')
    // 本次调用的取消源：hashchange 离页时中止在途请求（省配额；页面已卸载无需 UI 副作用）
    const controller = new AbortController()
    const onLeave = () => controller.abort()
    window.addEventListener('hashchange', onLeave, { once: true })
    try {
      const result = await runAiTask('weekly_insight', { facts }, { settings }, controller.signal)
      if (!out.isConnected) return
      weeklyAttempts = 0 // 成功后重置：下一次"重新生成"仍享有失败重试一次
      btn.classList.remove('is-loading')
      btn.textContent = '重新生成'
      const state = aiButtonState(settings, await safeUsage())
      btn.disabled = state.disabled
      btn.title = state.title
      out.innerHTML = suggestionsHtml(JSON.stringify(result))
      // 存档（weekStart 为主键 put：同周重复生成整体覆盖 aiSuggestions 与 generatedAt）；
      // 写库失败仅告警——学生已等到的建议展示不因存档失败被吞掉
      try {
        await saveWeeklyReport({
          weekStart: facts.weekStart,
          facts,
          aiSuggestions: JSON.stringify(result),
          generatedAt: new Date().toISOString(),
        })
        await renderHistory()
      } catch (err) {
        console.warn('周报 AI 建议存档失败（不影响展示）：', err)
      }
    } catch (err) {
      if (out.isConnected) {
        btn.classList.remove('is-loading')
        out.innerHTML = `<div class="ai-panel ai-error"><p>生成失败：${escapeHtml(aiErrorText(err))}</p></div>`
        if (weeklyAttempts >= 2) {
          btn.remove()
        } else {
          const state = aiButtonState(settings, await safeUsage())
          btn.disabled = state.disabled
          btn.title = state.title
          if (!btn.disabled) btn.textContent = '重试'
        }
      }
    } finally {
      window.removeEventListener('hashchange', onLeave)
    }
  }
  container.querySelector('#weekly-ai')?.addEventListener('click', () => void runWeekly())
}
