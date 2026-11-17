import type { PageRenderer } from '../router'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../db/repos'
import { fetchContentBundle, vocabUnitsForBook } from '../content/loader'
import type { Settings } from '../types'
import { exportBackup, parseAndValidateBackup, importBackup, backupFileName, BackupError } from '../services/backup/index'
import { escapeHtml } from '../ui/escape'

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
  // 当前册别下的词汇单元；册别切换时由下方监听器重填选项
  const unitSelect = () => container.querySelector<HTMLSelectElement>('#set-unit')
  const fillUnitOptions = (book: string, selected: string) => {
    const select = unitSelect()
    if (!select) return
    const units = vocabUnitsForBook(bundle?.vocab ?? [], book)
    select.innerHTML = units
      .map((u) => `<option value="${escapeHtml(u.id)}" ${u.id === selected ? 'selected' : ''}>${escapeHtml(u.label)}（${u.words.length} 词）</option>`)
      .join('')
  }
  const message = document.createElement('p')

  container.innerHTML = `
    <h1>家长设置</h1>
    ${storageError ? '<div class="error-panel" role="alert">无法读取设置（浏览器存储不可用）。</div>' : ''}
    <div class="card">
      <div class="form-row">
        <label for="set-book">教材册别</label>
        <select id="set-book">
          <option value="g7a" ${settings.book === 'g7a' ? 'selected' : ''}>七年级上册</option>
          <option value="g7b" ${settings.book === 'g7b' ? 'selected' : ''}>七年级下册</option>
        </select>
      </div>
      <div class="form-row">
        <label for="set-unit">单词默写当前单元</label>
        <select id="set-unit"></select>
      </div>
      <div class="form-row">
        <label for="set-minutes">每日学习时长（分钟，20–45）</label>
        <input id="set-minutes" type="number" min="20" max="45" step="5" value="${escapeHtml(String(settings.dailyMinutes))}">
      </div>
      <div class="form-row">
        <label for="set-days">每周学习天数（1–7）</label>
        <input id="set-days" type="number" min="1" max="7" value="${escapeHtml(String(settings.studyDaysPerWeek))}">
      </div>
      <div class="form-row">
        <label for="set-ai">AI 讲解（联网调用外部 AI 服务，当前版本仅保存配置）</label>
        <input id="set-ai" type="checkbox" ${settings.aiEnabled ? 'checked' : ''}>
      </div>
      <div class="action-row"><button class="btn" id="save">保存设置</button></div>
    </div>
    <div class="card">
      <h3>备份与恢复</h3>
      <p>导出全部学习记录为 JSON 文件；恢复时先校验再写入，合并模式不会改写已有历史。</p>
      <div class="action-row">
        <button class="btn" id="backup-export">导出备份</button>
        <label class="btn btn-secondary" style="display:inline-flex;align-items:center">导入备份
          <input type="file" id="backup-import" accept="application/json,.json" style="display:none">
        </label>
      </div>
      <div id="backup-preview"></div>
    </div>
  `
  container.appendChild(message)

  // 初次填充当前册的单元；currentUnit 属于另一册时不预选（浏览器默认选第一项），保存时生效
  fillUnitOptions(settings.book, settings.currentUnit)
  container.querySelector<HTMLSelectElement>('#set-book')?.addEventListener('change', (e) => {
    const book = (e.target as HTMLSelectElement).value || settings.book
    fillUnitOptions(book, '') // 切册后不预选，落到该册第一个单元
  })

  container.querySelector('#save')?.addEventListener('click', async () => {
    const book = (container.querySelector<HTMLSelectElement>('#set-book')?.value as Settings['book'] | undefined) || settings.book
    let currentUnit = container.querySelector<HTMLSelectElement>('#set-unit')?.value || settings.currentUnit
    // 册别-单元一致性（导入备份等可构造出不一致组合）：前缀 v1-↔g7a、v2-↔g7b，
    // 不一致时回退所选册第一个单元（bundle 可用时）；题库不可用时保持原值等下次修正
    if (!currentUnit.startsWith(book === 'g7b' ? 'v2-' : 'v1-')) {
      currentUnit = vocabUnitsForBook(bundle?.vocab ?? [], book)[0]?.id ?? currentUnit
    }
    const next: Settings = {
      ...settings,
      book,
      currentUnit,
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

  container.querySelector('#backup-export')?.addEventListener('click', async () => {
    const preview = container.querySelector('#backup-preview')
    if (!preview) return
    try {
      const file = await exportBackup()
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backupFileName()
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      preview.innerHTML = '<div class="error-panel">导出失败，存储不可用。</div>'
    }
  })

  container.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement
    const preview = container.querySelector('#backup-preview')
    if (!preview) return
    const file = input.files?.[0]
    if (!file) return
    input.value = ''
    let parsed
    try {
      parsed = parseAndValidateBackup(await file.text())
    } catch (err) {
      preview.innerHTML = `<div class="error-panel">导入失败：${escapeHtml(err instanceof BackupError ? err.message : '文件无法解析')}</div>`
      return
    }
    preview.innerHTML = `
      <p>该备份包含 ${parsed.counts.attempts} 条作答、${parsed.counts.questions} 道题、${parsed.counts.settings} 条设置（导出于 ${new Date(parsed.exportedAt).toLocaleString('zh-CN')}）。</p>
      <div class="action-row">
        <button class="btn" id="backup-merge">合并导入（保留本地已有记录）</button>
        <button class="btn btn-secondary" id="backup-overwrite">覆盖导入（清空后恢复）</button>
      </div>`
    const run = async (mode: 'merge' | 'overwrite') => {
      try {
        const result = await importBackup(parsed, mode)
        preview.innerHTML = `<p>导入完成：新增作答 ${result.attemptsAdded} 条${result.attemptsSkipped > 0 ? `，跳过已存在 ${result.attemptsSkipped} 条` : ''}。</p>`
      } catch {
        preview.innerHTML = '<div class="error-panel">导入失败：存储不可用。</div>'
      }
    }
    preview.querySelector('#backup-merge')?.addEventListener('click', () => void run('merge'))
    preview.querySelector('#backup-overwrite')?.addEventListener('click', () => void run('overwrite'))
  })
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
