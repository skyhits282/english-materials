import type { PageRenderer } from '../router'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../db/repos'
import { fetchContentBundle, vocabUnitsForBook } from '../content/loader'
import type { ExamScoreRow, Settings } from '../types'
import { exportBackup, parseAndValidateBackup, importBackup, backupFileName, BackupError } from '../services/backup/index'
import { escapeHtml } from '../ui/escape'
import { isPinProtectedAction, verifyPin, type PinProtectedAction } from '../domain/pin'

/** 试卷分项成绩行数上限（最近两次试卷合计，规格 §4） */
const EXAM_MAX_ROWS = 8
/** 合法 PIN 形态：恰好 4 位数字（页面层校验；verifyPin 纯函数只做全等比较） */
const PIN_PATTERN = /^\d{4}$/

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
    <div id="pin-gate"></div>
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
      <h3>家长保护</h3>
      <p>设置 4 位数字 PIN 后，保存设置、导入备份需先输入 PIN。PIN 明文存储于本机，仅防误操作，不参与任何加密。</p>
      <p id="pin-status" class="muted"></p>
      <div id="pin-manage"></div>
      <p id="pin-msg"></p>
    </div>
    <div class="card">
      <h3>试卷成绩</h3>
      <p>手工录入最近两次试卷的题型分项成绩（如"语法 12/15"），最多 ${EXAM_MAX_ROWS} 行。仅作报告页诊断参考，不参与自动判分与指标。</p>
      <div id="exam-rows"></div>
      <div class="action-row">
        <button class="btn btn-secondary" id="exam-add">加一行</button>
        <button class="btn" id="exam-save">保存成绩</button>
        <button class="btn btn-secondary" id="exam-clear">清除成绩</button>
      </div>
      <p id="exam-msg"></p>
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

  // ============ 家长 PIN：门禁与卡片管理 ============

  /** 行内 PIN 门禁（非模态）：受保护操作先在此验 PIN，验对继续原操作、验错提示不继续 */
  const pinGate = container.querySelector('#pin-gate')
  const closePinGate = () => {
    if (pinGate) pinGate.innerHTML = ''
  }
  const runProtected = (action: PinProtectedAction, run: () => void | Promise<void>) => {
    if (!isPinProtectedAction(action, settings.parentPin !== undefined)) {
      void run()
      return
    }
    if (!pinGate) {
      void run()
      return
    }
    pinGate.innerHTML = `
      <div class="card">
        <p>该操作受家长保护，请输入 PIN 后继续。</p>
        <div class="form-row">
          <label for="gate-pin">家长 PIN</label>
          <input id="gate-pin" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" autocomplete="off" placeholder="4 位数字">
        </div>
        <div class="action-row">
          <button class="btn" id="gate-confirm">确认</button>
          <button class="btn btn-secondary" id="gate-cancel">取消</button>
        </div>
        <p id="gate-msg" class="muted"></p>
      </div>`
    pinGate.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const gateInput = pinGate.querySelector<HTMLInputElement>('#gate-pin')
    const gateMsg = pinGate.querySelector('#gate-msg')
    const confirm = () => {
      if (!verifyPin(gateInput?.value ?? '', settings.parentPin)) {
        if (gateMsg) gateMsg.textContent = 'PIN 不正确。'
        gateInput?.focus()
        return
      }
      closePinGate()
      void run()
    }
    gateInput?.focus()
    pinGate.querySelector('#gate-cancel')?.addEventListener('click', closePinGate)
    pinGate.querySelector('#gate-confirm')?.addEventListener('click', confirm)
    gateInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm()
    })
  }

  const pinStatus = container.querySelector('#pin-status')
  const pinManage = container.querySelector('#pin-manage')
  const pinMsg = container.querySelector('#pin-msg')
  const pinInputHtml = (id: string, label: string) => `
    <div class="form-row">
      <label for="${id}">${label}</label>
      <input id="${id}" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" autocomplete="off" placeholder="4 位数字">
    </div>`

  /** 持久化 settings（写库成功后同步页内变量，避免后续保存以旧值展开覆盖他卡字段；
   *  错误提示由各调用卡自行展示） */
  const persistSettings = async (next: Settings): Promise<boolean> => {
    try {
      await saveSettings(next)
    } catch {
      return false
    }
    settings = next
    return true
  }

  /** 家长保护卡内容：未设置→设 PIN 表单；已设置→修改/关闭入口，点击后展开对应行内表单 */
  const renderPinManage = () => {
    if (!pinManage || !pinStatus) return
    if (settings.parentPin === undefined) {
      pinStatus.textContent = '当前状态：未设置 PIN。'
      pinManage.innerHTML = `
        ${pinInputHtml('pin-new', '新 PIN')}
        ${pinInputHtml('pin-confirm', '确认新 PIN')}
        <div class="action-row"><button class="btn" id="pin-set">设置 PIN</button></div>`
      pinManage.querySelector('#pin-set')?.addEventListener('click', async () => {
        if (pinMsg) pinMsg.textContent = ''
        const newPin = (pinManage.querySelector<HTMLInputElement>('#pin-new')?.value ?? '').trim()
        const confirmPin = (pinManage.querySelector<HTMLInputElement>('#pin-confirm')?.value ?? '').trim()
        if (!PIN_PATTERN.test(newPin)) {
          if (pinMsg) pinMsg.textContent = 'PIN 须为 4 位数字。'
          return
        }
        if (newPin !== confirmPin) {
          if (pinMsg) pinMsg.textContent = '两次输入不一致。'
          return
        }
        if (await persistSettings({ ...settings, parentPin: newPin })) {
          if (pinMsg) pinMsg.textContent = '家长保护已开启。'
          renderPinManage()
        } else if (pinMsg) {
          pinMsg.textContent = '保存失败，存储不可用。'
        }
      })
      return
    }
    pinStatus.textContent = '当前状态：已开启。保存设置、导入备份需先输入 PIN。'
    pinManage.innerHTML = `
      <div class="action-row">
        <button class="btn btn-secondary" id="pin-edit">修改 PIN</button>
        <button class="btn btn-secondary" id="pin-off">关闭保护</button>
      </div>`
    pinManage.querySelector('#pin-edit')?.addEventListener('click', () => {
      if (pinMsg) pinMsg.textContent = ''
      pinManage.innerHTML = `
        ${pinInputHtml('pin-old', '当前 PIN')}
        ${pinInputHtml('pin-new', '新 PIN')}
        ${pinInputHtml('pin-confirm', '确认新 PIN')}
        <div class="action-row">
          <button class="btn" id="pin-edit-save">保存新 PIN</button>
          <button class="btn btn-secondary" id="pin-edit-cancel">取消</button>
        </div>`
      pinManage.querySelector('#pin-edit-cancel')?.addEventListener('click', renderPinManage)
      pinManage.querySelector('#pin-edit-save')?.addEventListener('click', async () => {
        if (pinMsg) pinMsg.textContent = ''
        const oldPin = (pinManage.querySelector<HTMLInputElement>('#pin-old')?.value ?? '').trim()
        const newPin = (pinManage.querySelector<HTMLInputElement>('#pin-new')?.value ?? '').trim()
        const confirmPin = (pinManage.querySelector<HTMLInputElement>('#pin-confirm')?.value ?? '').trim()
        if (!verifyPin(oldPin, settings.parentPin)) {
          if (pinMsg) pinMsg.textContent = 'PIN 不正确。'
          return
        }
        if (!PIN_PATTERN.test(newPin)) {
          if (pinMsg) pinMsg.textContent = '新 PIN 须为 4 位数字。'
          return
        }
        if (newPin !== confirmPin) {
          if (pinMsg) pinMsg.textContent = '两次输入不一致。'
          return
        }
        if (await persistSettings({ ...settings, parentPin: newPin })) {
          if (pinMsg) pinMsg.textContent = 'PIN 已修改。'
          renderPinManage()
        } else if (pinMsg) {
          pinMsg.textContent = '保存失败，存储不可用。'
        }
      })
    })
    pinManage.querySelector('#pin-off')?.addEventListener('click', () => {
      if (pinMsg) pinMsg.textContent = ''
      pinManage.innerHTML = `
        ${pinInputHtml('pin-old', '当前 PIN')}
        <div class="action-row">
          <button class="btn" id="pin-off-confirm">确认关闭</button>
          <button class="btn btn-secondary" id="pin-off-cancel">取消</button>
        </div>
        <p class="muted">关闭后受保护操作不再需要 PIN。</p>`
      pinManage.querySelector('#pin-off-cancel')?.addEventListener('click', renderPinManage)
      pinManage.querySelector('#pin-off-confirm')?.addEventListener('click', async () => {
        const oldPin = (pinManage.querySelector<HTMLInputElement>('#pin-old')?.value ?? '').trim()
        if (!verifyPin(oldPin, settings.parentPin)) {
          if (pinMsg) pinMsg.textContent = 'PIN 不正确。'
          return
        }
        if (await persistSettings({ ...settings, parentPin: undefined })) {
          if (pinMsg) pinMsg.textContent = '家长保护已关闭。'
          renderPinManage()
        } else if (pinMsg) {
          pinMsg.textContent = '保存失败，存储不可用。'
        }
      })
    })
  }
  renderPinManage()

  // ============ 试卷成绩录入（最近两次试卷、上限 8 行） ============

  const examRows = container.querySelector('#exam-rows')
  const examAdd = container.querySelector<HTMLButtonElement>('#exam-add')
  const examMsg = container.querySelector('#exam-msg')
  const setExamMsg = (text: string) => {
    if (examMsg) examMsg.textContent = text
  }
  /** 行 DOM 常驻为唯一事实来源（加行不整卡重渲，避免丢失未保存输入） */
  const examRowHtml = (r: { label: string; got: string; total: string }) => `
    <div class="exam-row">
      <input class="exam-label" type="text" maxlength="20" placeholder="题型（如 语法）" value="${escapeHtml(r.label)}">
      <input class="exam-got" type="number" min="0" placeholder="得分" value="${escapeHtml(r.got)}">
      <input class="exam-total" type="number" min="1" placeholder="满分" value="${escapeHtml(r.total)}">
    </div>`
  const examRowCount = () => (examRows ? examRows.querySelectorAll('.exam-row').length : 0)
  const updateExamAdd = () => {
    if (examAdd) examAdd.disabled = examRowCount() >= EXAM_MAX_ROWS
  }
  const appendExamRow = (r: { label: string; got: string; total: string }) => {
    examRows?.insertAdjacentHTML('beforeend', examRowHtml(r))
    updateExamAdd()
  }
  // 初值：已存成绩逐行回填；无则给一行空白
  for (const r of settings.examScores ?? []) {
    appendExamRow({ label: r.label, got: String(r.got), total: String(r.total) })
  }
  if (examRowCount() === 0) appendExamRow({ label: '', got: '', total: '' })

  examAdd?.addEventListener('click', () => {
    if (examRowCount() >= EXAM_MAX_ROWS) {
      setExamMsg(`最多 ${EXAM_MAX_ROWS} 行（最近两次试卷）。`)
      return
    }
    setExamMsg('')
    appendExamRow({ label: '', got: '', total: '' })
  })

  container.querySelector('#exam-save')?.addEventListener('click', async () => {
    if (!examRows) return
    setExamMsg('')
    const rows = [...examRows.querySelectorAll('.exam-row')].map((row) => ({
      label: (row.querySelector<HTMLInputElement>('.exam-label')?.value ?? '').trim(),
      got: (row.querySelector<HTMLInputElement>('.exam-got')?.value ?? '').trim(),
      total: (row.querySelector<HTMLInputElement>('.exam-total')?.value ?? '').trim(),
    }))
    // 全空行视为留白跳过；其余行须完整且 0 ≤ 得分 ≤ 满分
    const filled = rows.filter((r) => r.label !== '' || r.got !== '' || r.total !== '')
    const scores: ExamScoreRow[] = []
    for (const r of filled) {
      if (r.label === '') {
        setExamMsg('已填行请补全题型名称。')
        return
      }
      const got = Number(r.got)
      const total = Number(r.total)
      if (!Number.isFinite(got) || !Number.isFinite(total) || total <= 0 || got < 0 || got > total) {
        setExamMsg('每行须满足 0 ≤ 得分 ≤ 满分 且 满分 > 0。')
        return
      }
      scores.push({ label: r.label, got, total })
    }
    if (scores.length === 0) {
      setExamMsg('没有可保存的成绩行。')
      return
    }
    // UI 已限行数，此处截断作双保险（旧库超限数据回填后再保存时收敛到上限）
    scores.length = Math.min(scores.length, EXAM_MAX_ROWS)
    if (await persistSettings({ ...settings, examScores: scores })) {
      setExamMsg('已保存试卷成绩。')
    } else if (examMsg) {
      examMsg.textContent = '保存失败，存储不可用。'
    }
  })

  container.querySelector('#exam-clear')?.addEventListener('click', async () => {
    setExamMsg('')
    if (await persistSettings({ ...settings, examScores: undefined })) {
      if (examRows) examRows.innerHTML = ''
      appendExamRow({ label: '', got: '', total: '' })
      setExamMsg('已清除试卷成绩。')
    } else if (examMsg) {
      examMsg.textContent = '清除失败，存储不可用。'
    }
  })

  // ============ 既有操作（挂门禁） ============

  // 初次填充当前册的单元；currentUnit 属于另一册时不预选（浏览器默认选第一项），保存时生效
  fillUnitOptions(settings.book, settings.currentUnit)
  container.querySelector<HTMLSelectElement>('#set-book')?.addEventListener('change', (e) => {
    const book = (e.target as HTMLSelectElement).value || settings.book
    fillUnitOptions(book, '') // 切册后不预选，落到该册第一个单元
  })

  const saveSettingsFromForm = async () => {
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
      settings = next
      message.textContent = '已保存。'
    } catch {
      if (stale) return
      message.textContent = '保存失败，存储不可用。'
    }
  }

  container.querySelector('#save')?.addEventListener('click', () => {
    runProtected('save-settings', saveSettingsFromForm)
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

  const handleImportFile = async (file: File) => {
    const preview = container.querySelector('#backup-preview')
    if (!preview) return
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
        preview.innerHTML = '<div class="error-panel">导入失败，存储不可用。</div>'
      }
    }
    preview.querySelector('#backup-merge')?.addEventListener('click', () => void run('merge'))
    preview.querySelector('#backup-overwrite')?.addEventListener('click', () => void run('overwrite'))
  }

  container.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    // 先清空 file input：用户在门禁处取消后重选同一文件仍能触发 change
    input.value = ''
    runProtected('import-backup', () => handleImportFile(file))
  })
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
