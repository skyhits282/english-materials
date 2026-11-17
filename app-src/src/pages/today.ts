import type { PageRenderer } from '../router'
import { navigate } from '../router'
import { SPECIALS } from '../content/sets'
import { fetchContentBundle, findVocabUnit } from '../content/loader'
import type { VocabBook } from '../types'
import { getSettings, listAttempts, getReviewSet } from '../db/repos'
import { computeCoreMetrics, isSameLocalDay, localDayKey } from '../domain/metrics'
import { escapeHtml } from '../ui/escape'

export const renderToday: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>今日学习</h1><p class="muted">加载中…</p>'
  let settings: Awaited<ReturnType<typeof getSettings>>
  let attempts: Awaited<ReturnType<typeof listAttempts>>
  let bundle: Awaited<ReturnType<typeof fetchContentBundle>> | undefined
  let review: Awaited<ReturnType<typeof getReviewSet>> | undefined
  try {
    ;[settings, attempts, bundle, review] = await Promise.all([
      getSettings(),
      listAttempts(),
      fetchContentBundle().catch(() => undefined),
      getReviewSet().catch(() => undefined), // 复测概要读取失败不阻塞今日页（卡片不显示）
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

  const vocabUnit = findVocabUnit(bundle?.vocab ?? ([] as VocabBook[]), settings.currentUnit)
  // 专项卡按册分组（七上/七下各 4），题数由题库实时计算
  const specialGroups: { heading: string; book: 'g7a' | 'g7b' }[] = [
    { heading: '七上专项', book: 'g7a' },
    { heading: '七下专项', book: 'g7b' },
  ]
  const vocabCard = {
    heading: '词汇默写',
    title: escapeHtml(vocabUnit?.label ?? settings.currentUnit),
    desc: `${vocabUnit?.words.length ?? 0} 个单词 · 中→英`,
    action: () => navigate('exercise', { vocab: settings.currentUnit }),
  }
  interface TodayCard {
    heading?: string
    title: string
    desc: string
    button?: string
    action: () => void
  }
  const cards: TodayCard[] = []
  // 顶部到期复习卡（规格 §1.2）：显示到期知识点数与本次复测题数；无可复测题时不显示
  if (review && review.questionIds.length > 0) {
    cards.push({
      title: '到期复习',
      desc: `${review.dueKpCount} 个知识点 · ${review.questionIds.length} 题`,
      button: '开始复习',
      action: () => navigate('exercise', { set: 'review' }),
    })
  }
  cards.push(
    ...specialGroups.flatMap(({ heading, book }) =>
      SPECIALS.filter((s) => s.book === book).map((s) => {
        const count = bundle?.questions.filter((q) => q.unit.startsWith(s.id)).length ?? 0
        return {
          heading,
          title: s.title,
          desc: `${count} 题`,
          action: () => navigate('exercise', { special: s.id }),
        }
      }),
    ),
    vocabCard,
  )

  container.innerHTML = `
    <h1>今日学习</h1>
    <div class="card">
      <h3>今天已练 ${todayAttempts.length} 题</h3>
      <p>${m.firstTryCorrectRate === null ? '暂无首测数据' : `首测正确率 ${Math.round(m.firstTryCorrectRate * 100)}%`}</p>
    </div>
    ${cards
      .map(
        (c, i) => `
    ${c.heading !== cards[i - 1]?.heading ? `<h2>${c.heading}</h2>` : ''}
    <div class="card">
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="action-row"><button class="btn" data-card="${i}">${escapeHtml(c.button ?? '开始练习')}</button></div>
    </div>`,
      )
      .join('')}
    <p class="muted">学习计划自动生成将在后续版本提供。</p>`
  for (const btn of container.querySelectorAll<HTMLButtonElement>('button[data-card]')) {
    btn.addEventListener('click', () => cards[Number(btn.dataset.card)]?.action())
  }
  window.removeEventListener('hashchange', onHashChange)
}
