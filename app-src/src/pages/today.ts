import type { PageRenderer } from '../router'
import { navigate, parseHash } from '../router'
import { SPECIALS } from '../content/sets'
import { fetchContentBundle, findVocabUnit } from '../content/loader'
import { seedContent } from '../content/seed'
import { isStorageAvailable } from '../db/availability'
import { clearDayTasks, completeTask, getOrCreatePlan, getSettings, isPlanIncomplete, listAttempts } from '../db/repos'
import { isStudyDay } from '../domain/plan'
import { computeCoreMetrics, isSameLocalDay, localDayKey } from '../domain/metrics'
import { escapeHtml } from '../ui/escape'
import type { TaskRow } from '../db/schema'
import type { VocabBook } from '../types'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 任务状态 → 卡片角标；planned 无角标。completed/deferred/skipped 为终态（状态机不可回转），
 *  主操作相应禁用；in_progress 高亮并可"继续"。 */
const STATUS_BADGE: Record<TaskRow['status'], string | undefined> = {
  planned: undefined,
  in_progress: '进行中',
  completed: '✓ 已完成',
  deferred: '已延期',
  skipped: '已跳过',
}

/** 异步回写/重试后重渲染前守卫：期间用户可能已导航离开今日页 */
function stillOnToday(): boolean {
  return parseHash(location.hash).name === 'today'
}

const rerender = (container: HTMLElement) => {
  if (stillOnToday()) void renderPage(container).catch((err) => console.error('今日页重渲染失败：', err))
}

/** 学习小结勾选完成：状态机转移下沉在 completeTask（planned 先补 in_progress 瞬态再 completed）；
 *  回写失败或被拒（终态）时回滚勾选框 */
async function completeSummary(cb: HTMLInputElement, taskId: string | undefined, container: HTMLElement): Promise<void> {
  if (!taskId) return
  let ok = false
  try {
    ok = await completeTask(taskId)
  } catch (err) {
    console.warn('学习小结完成回写失败：', err)
  }
  if (!ok) {
    cb.checked = false
    return
  }
  rerender(container)
}

/** 播种重试（技术债清偿）：重新拉取 bundle（fetch 失败后缓存已自清）并播种。
 *  仅当当日计划本身残缺（isPlanIncomplete：缺专项段）才清除当日任务重建——残缺模式下练习入口
 *  基本不可用，重建造成的任务状态重置可接受（真实作答记录在 attempts 表，不受影响）；
 *  瞬时 bundle 失败但计划完整时不清任务，已完成状态保留（只刷新题目内容）。 */
async function retrySeed(btn: HTMLButtonElement, opts: { container: HTMLElement; today: string; rebuild: boolean }): Promise<void> {
  btn.disabled = true
  btn.textContent = '重试中…'
  try {
    const bundle = await fetchContentBundle()
    if (await isStorageAvailable()) await seedContent(bundle)
    if (opts.rebuild) await clearDayTasks(opts.today)
  } catch {
    // 仍失败：重渲染恢复重试入口（bundle 失败时缓存自清，下次重试会真正重新拉取）
  }
  rerender(opts.container)
}

async function renderPage(container: HTMLElement): Promise<void> {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>今日学习</h1><p class="muted">加载中…</p>'
  let settings: Awaited<ReturnType<typeof getSettings>>
  let attempts: Awaited<ReturnType<typeof listAttempts>>
  let bundle: Awaited<ReturnType<typeof fetchContentBundle>> | undefined
  let seedError: unknown // bundle 拉取/播种失败原因（降级面板展示用，不再静默 0 题）
  try {
    ;[settings, attempts, bundle] = await Promise.all([
      getSettings(),
      listAttempts(),
      fetchContentBundle().catch((err: unknown) => {
        seedError = err
        return undefined
      }),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>今日学习</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const now = new Date()
  const today = localDayKey(now)
  const dateLabel = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAY_LABELS[now.getDay()]}`

  // 播种就绪等待（幂等：seedContent 按版本号跳过，与启动时的后台播种并发重放无害）：
  // 保证计划生成时 questions 表可用，避免首次访问竞态生成缺专项段的残缺计划
  if (bundle && (await isStorageAvailable())) {
    try {
      await seedContent(bundle)
    } catch (err) {
      seedError = err
    }
  }

  let tasks: TaskRow[] = []
  try {
    tasks = await getOrCreatePlan({ vocab: bundle?.vocab ?? ([] as VocabBook[]) })
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>今日学习</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return

  // 非学习日（规格 §2.1 数据优先）：仅当日无任务时显示"今日休息"——中途调小
  // studyDaysPerWeek 后当日已生成任务照常显示（结转丢题修复缺陷②），不遮蔽不丢失
  if (tasks.length === 0 && !isStudyDay(today, settings.studyDaysPerWeek)) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStudy = isStudyDay(localDayKey(tomorrow), settings.studyDaysPerWeek)
    const todayAttempts = attempts.filter((a) => isSameLocalDay(a.submittedAt, today))
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = `
      <h1>今日学习</h1>
      <div class="card">
        <h3>今日休息</h3>
        <p>${dateLabel}</p>
        <p>${tomorrowStudy ? `明日恢复学习，预计 ${settings.dailyMinutes} 分钟。` : '明日继续休息。'}</p>
      </div>
      ${todayAttempts.length > 0 ? `<div class="card"><h3>今日已练 ${todayAttempts.length} 题</h3><p>休息日练习不计入任务。</p></div>` : ''}
      <div class="card">
        <h3>自由练习（可选）</h3>
        <p>不计入今日任务与完成进度。</p>
        <div class="action-row"><button class="btn btn-secondary" id="free-vocab">单词默写</button></div>
      </div>`
    container.querySelector('#free-vocab')?.addEventListener('click', () => navigate('exercise', { vocab: settings.currentUnit }))
    return
  }

  const todayAttempts = attempts.filter((a) => isSameLocalDay(a.submittedAt, today))
  const m = computeCoreMetrics(todayAttempts)
  const vocabUnit = findVocabUnit(bundle?.vocab ?? ([] as VocabBook[]), settings.currentUnit)
  const completedCount = tasks.filter((t) => t.status === 'completed').length

  // 播种失败/计划残缺判定（M1 技术债清偿，两者都给重试入口）：
  //  - seedError：bundle fetch 失败或 seedContent 抛错——计划可能仍完整（此前已生成），但题目停留旧版本；
  //  - isPlanIncomplete：当日计划缺专项段（questions 表无题可选时 generatePlan 不会产出 special 任务）
  const planIncomplete = isPlanIncomplete(tasks)
  const seedFailed = seedError !== undefined

  interface TaskCard {
    title: string
    desc: string
    button: string
    /** 主操作（缺专项 id 等无法解析时为空 → 按钮禁用） */
    action?: () => void
  }
  const cards: TaskCard[] = tasks.map((task) => {
    switch (task.type) {
      case 'review':
        // 已知留办（规格审查 M7）：review 任务 questionIds 是生成时快照，而练习页 set=review 走
        // getReviewSet 实时选题（剔除当日已答）——极端情况下进入时已无到期题（空态），任务停留
        // planned 无法完成；暂接受该边缘场景，待后续按任务快照出题时一并处理
        return {
          title: '到期复习',
          desc: `${task.questionIds.length} 题 · ${task.minutesPlanned} 分钟`,
          button: '开始复习',
          action: () => navigate('exercise', { set: 'review', task: task.id }),
        }
      case 'unit':
        return {
          title: '单词默写',
          desc: `${escapeHtml(vocabUnit?.label ?? settings.currentUnit)} · ${task.questionIds.length} 词`,
          button: '开始',
          action: () => navigate('exercise', { vocab: settings.currentUnit, task: task.id }),
        }
      case 'special': {
        // TaskRow 未记录专项 id：从题目 id 前缀反解（形如 g7a-present-l1-0001）
        const special = SPECIALS.find((s) => task.questionIds.some((id) => id.startsWith(`${s.id}-`)))
        return {
          title: special?.title ?? '专项巩固',
          desc: `${task.questionIds.length} 题`,
          button: '开始',
          action: special ? () => navigate('exercise', { set: special.id, task: task.id }) : undefined,
        }
      }
      default:
        return { title: '学习小结', desc: `${task.minutesPlanned} 分钟 · 无题目，完成后勾选`, button: '标记完成' }
    }
  })

  const cardHtml = tasks
    .map((task, i) => {
      const c = cards[i]!
      const badge = STATUS_BADGE[task.status]
      const statusClass =
        task.status === 'completed' ? ' task-done' : task.status === 'in_progress' ? ' task-active' : ''
      const actionable = task.status === 'planned' || task.status === 'in_progress'
      const buttonLabel = task.status === 'in_progress' ? '继续' : task.status === 'completed' ? '已完成' : c.button
      const actionRow =
        task.type === 'summary'
          ? `<div class="action-row"><label class="check-row"><input type="checkbox" data-summary="${i}"${
              task.status === 'completed' ? ' checked' : ''
            }${actionable ? '' : ' disabled'}> 完成今日学习小结</label></div>`
          : `<div class="action-row"><button class="btn" data-card="${i}"${actionable && c.action ? '' : ' disabled'}>${escapeHtml(buttonLabel)}</button></div>`
      return `
    <div class="card${statusClass}">
      <h3>${c.title}${badge ? ` <span class="badge">${badge}</span>` : ''}</h3>
      <p>${c.desc}</p>
      ${actionRow}
    </div>`
    })
    .join('')

  container.innerHTML = `
    <h1>今日学习</h1>
    <div class="card">
      <h3>${dateLabel}</h3>
      <p>预计 ${settings.dailyMinutes} 分钟 · 任务 ${completedCount}/${tasks.length} 已完成 · 今日已练 ${todayAttempts.length} 题</p>
      <p>${m.firstTryCorrectRate === null ? '暂无首测数据' : `首测正确率 ${Math.round(m.firstTryCorrectRate * 100)}%`}</p>
    </div>
    ${seedFailed || planIncomplete ? `
    <div class="error-panel" role="alert">
      <p>${seedFailed
        ? `题库内容加载或播种失败${planIncomplete ? '，部分任务未能生成' : ''}。`
        : '题库播种不完整，部分任务未能生成。'}</p>
      ${seedError ? `<p>${escapeHtml(String(seedError))}</p>` : ''}
      <div class="action-row"><button class="btn" id="seed-retry">重试</button></div>
    </div>` : ''}
    ${cardHtml}`

  for (const btn of container.querySelectorAll<HTMLButtonElement>('button[data-card]')) {
    btn.addEventListener('click', () => {
      const task = tasks[Number(btn.dataset.card)]
      // 终态（completed/deferred/skipped）按钮已禁用，此为双保险
      if (task && (task.status === 'planned' || task.status === 'in_progress')) cards[Number(btn.dataset.card)]?.action?.()
    })
  }
  for (const cb of container.querySelectorAll<HTMLInputElement>('input[data-summary]')) {
    cb.addEventListener('change', () => {
      if (cb.checked) void completeSummary(cb, tasks[Number(cb.dataset.summary)]?.id, container)
    })
  }
  container.querySelector('#seed-retry')?.addEventListener('click', (e) => {
    const btn = e.currentTarget
    // 休息日只重拉/重播种，不删当日任务：休息日 getOrCreatePlan 返回 [] 不重建，
    // 误删已有任务行会造成净丢失（今日页数据优先的窄路径）
    const rebuild = planIncomplete && isStudyDay(today, settings.studyDaysPerWeek)
    if (btn instanceof HTMLButtonElement) void retrySeed(btn, { container, today, rebuild })
  })
  window.removeEventListener('hashchange', onHashChange)
}

export const renderToday: PageRenderer = async ({ container }) => {
  await renderPage(container)
}
