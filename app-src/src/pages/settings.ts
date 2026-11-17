import type { PageRenderer } from '../router'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../db/repos'
import { fetchContentBundle } from '../content/loader'
import type { Settings } from '../types'

export const renderSettings: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>家长设置</h1><p class="muted">加载中…</p>'
  const bundlePromise = fetchContentBundle().catch(() => undefined)
  let settings: Settings
  let storageError = false
  try {
    settings = await getSettings()
  } catch {
    storageError = true
    settings = DEFAULT_SETTINGS
  }
  const bundle = await bundlePromise
  if (stale) return
  const units = bundle?.vocab.units ?? []
  const message = document.createElement('p')

  container.innerHTML = `
    <h1>家长设置</h1>
    ${storageError ? '<div class="error-panel" role="alert">无法读取设置（浏览器存储不可用）。</div>' : ''}
    <div class="card">
      <div class="form-row">
        <label for="set-unit">单词默写当前单元</label>
        <select id="set-unit">
          ${units.map((u) => `<option value="${u.id}" ${u.id === settings.currentUnit ? 'selected' : ''}>${u.label}（${u.words.length} 词）</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label for="set-minutes">每日学习时长（分钟，20–45）</label>
        <input id="set-minutes" type="number" min="20" max="45" step="5" value="${settings.dailyMinutes}">
      </div>
      <div class="form-row">
        <label for="set-days">每周学习天数（1–7）</label>
        <input id="set-days" type="number" min="1" max="7" value="${settings.studyDaysPerWeek}">
      </div>
      <div class="form-row">
        <label for="set-ai">AI 讲解（联网调用外部 AI 服务，当前版本仅保存配置）</label>
        <input id="set-ai" type="checkbox" ${settings.aiEnabled ? 'checked' : ''}>
      </div>
      <div class="action-row"><button class="btn" id="save">保存设置</button></div>
    </div>
    <div id="backup-slot"></div>
  `
  container.appendChild(message)

  container.querySelector('#save')?.addEventListener('click', async () => {
    const next: Settings = {
      ...settings,
      currentUnit: (container.querySelector<HTMLSelectElement>('#set-unit')?.value || settings.currentUnit),
      dailyMinutes: clamp(Number(container.querySelector<HTMLInputElement>('#set-minutes')?.value), 20, 45),
      studyDaysPerWeek: clamp(Number(container.querySelector<HTMLInputElement>('#set-days')?.value), 1, 7),
      aiEnabled: container.querySelector<HTMLInputElement>('#set-ai')?.checked ?? false,
    }
    try {
      await saveSettings(next)
      if (stale) return
      message.textContent = '已保存。'
    } catch {
      if (stale) return
      message.textContent = '保存失败，存储不可用。'
    }
  })
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
