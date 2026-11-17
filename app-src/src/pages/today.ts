import type { PageRenderer } from '../router'
import { navigate } from '../router'
import { SPECIALS } from '../content/sets'
import { fetchContentBundle, findVocabUnit } from '../content/loader'
import { getSettings, listAttempts } from '../db/repos'
import { computeCoreMetrics, isSameLocalDay, localDayKey } from '../domain/metrics'

export const renderToday: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>今日学习</h1><p class="muted">加载中…</p>'
  let settings: Awaited<ReturnType<typeof getSettings>>
  let attempts: Awaited<ReturnType<typeof listAttempts>>
  let bundle: Awaited<ReturnType<typeof fetchContentBundle>> | undefined
  try {
    [settings, attempts, bundle] = await Promise.all([
      getSettings(),
      listAttempts(),
      fetchContentBundle().catch(() => undefined),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>今日学习</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
  if (stale) return
  const today = localDayKey()
  const todayAttempts = attempts.filter((a) => isSameLocalDay(a.submittedAt, today))
  const m = computeCoreMetrics(todayAttempts)

  const vocabUnit = findVocabUnit(bundle?.vocab ?? { units: [], book: '', contentVersion: '' }, settings.currentUnit)
  const cards = [
    ...SPECIALS.map((s) => {
      const count = bundle?.questions.filter((q) => q.unit.startsWith(s.id)).length ?? 0
      return {
        title: s.title,
        desc: `${count} 题`,
        action: () => navigate('exercise', { special: s.id }),
      }
    }),
    {
      title: `单词默写 · ${vocabUnit?.label ?? settings.currentUnit}`,
      desc: `${vocabUnit?.words.length ?? 0} 个单词 · 中→英`,
      action: () => navigate('exercise', { vocab: settings.currentUnit }),
    },
  ]

  container.innerHTML = `
    <h1>今日学习</h1>
    <div class="card">
      <h3>今天已练 ${todayAttempts.length} 题</h3>
      <p>${m.firstTryCorrectRate === null ? '暂无首测数据' : `首测正确率 ${Math.round(m.firstTryCorrectRate * 100)}%`}</p>
    </div>
    ${cards
      .map(
        (c, i) => `
    <div class="card">
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="action-row"><button class="btn" data-card="${i}">开始练习</button></div>
    </div>`,
      )
      .join('')}
    <p class="muted">学习计划自动生成与到期复习将在后续版本提供。</p>`
  for (const btn of container.querySelectorAll<HTMLButtonElement>('button[data-card]')) {
    btn.addEventListener('click', () => cards[Number(btn.dataset.card)]?.action())
  }
  window.removeEventListener('hashchange', onHashChange)
}
