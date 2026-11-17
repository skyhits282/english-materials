import type { PageRenderer } from '../router'
import type { Settings, VocabBook } from '../types'
import { getSettings, listAllMastery, listAllTasks, listAttempts, listAllQuestions } from '../db/repos'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from '../domain/metrics'
import {
  knowledgePointCoverage,
  reviewOnTimeRate,
  sevenDayTrend,
  weakPoints,
  weeklyFacts,
} from '../domain/trends'
import { renderTrendChart } from '../ui/chart'
import { fetchContentBundle } from '../content/loader'
import { buildVocabResolver } from '../content/vocab-resolve'
import { escapeHtml } from '../ui/escape'
import type { TaskRow } from '../db/schema'

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
      <div class="action-row"><button class="btn" id="weekly-ai" disabled title="AI 功能即将开放">生成 AI 建议</button></div>
    </div>`
  window.removeEventListener('hashchange', onHashChange)
}
