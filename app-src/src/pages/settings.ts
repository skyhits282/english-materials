import type { PageRenderer } from '../router'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../db/repos'
import { fetchContentBundle, vocabUnitsForBook } from '../content/loader'
import type { Settings } from '../types'
import {
  exportBackup,
  parseAndValidateBackup,
  importBackup,
  backupFileName,
  downloadBackupFile,
  BackupError,
} from '../services/backup/index'
import { escapeHtml } from '../ui/escape'
import { PIN_LENGTH, PIN_PATTERN, isPinProtectedAction, verifyPin, type PinProtectedAction } from '../domain/pin'
import { EXAM_MAX_ROWS, parseExamRows } from '../domain/exam-scores'
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_DAILY_LIMIT, AI_DEFAULT_MODEL, AI_DEFAULT_VISION_MODEL, maskApiKey, parseAiConfigForm } from '../domain/ai-config'
import { testConnection } from '../services/ai/connection'
import { aiErrorText } from '../services/ai/ui'

/** 卡片模块共享依赖：页内 settings 快照与持久化入口（导入备份后快照整体替换） */
interface CardDeps {
  container: HTMLElement
  /** 读取页内 settings（各卡保存成功后由 persist 同步更新） */
  current: () => Settings
  /** 持久化：写库成功后同步页内变量并返回 true；失败返回 false，提示由调用卡自行展示 */
  persist: (next: Settings) => Promise<boolean>
}

/** PIN 输入行模板：maxlength/pattern 与 domain/pin 常量同源（含门禁与设/改/关表单） */
const pinInputHtml = (id: string, label: string) => `
  <div class="form-row">
    <label for="${id}">${label}</label>
    <input id="${id}" type="password" inputmode="numeric" maxlength="${PIN_LENGTH}" pattern="${PIN_PATTERN.source}" autocomplete="off" placeholder="${PIN_LENGTH} 位数字">
  </div>`

/** 行内 PIN 门禁（非模态）：受保护操作先在此验 PIN，验对继续原操作、验错提示不继续。
 *  输入不 trim（pattern 已限 4 位数字，带空格的输入因不全等自然验错）。 */
function runPinGate(deps: CardDeps, action: PinProtectedAction, run: () => void | Promise<void>): void {
  if (!isPinProtectedAction(action, deps.current().parentPin !== undefined)) {
    void run()
    return
  }
  const gate = deps.container.querySelector('#pin-gate')
  if (!gate) {
    void run()
    return
  }
  gate.innerHTML = `
    <div class="card">
      <p>该操作受家长保护，请输入 PIN 后继续。</p>
      ${pinInputHtml('gate-pin', '家长 PIN')}
      <div class="action-row">
        <button class="btn" id="gate-confirm">确认</button>
        <button class="btn btn-secondary" id="gate-cancel">取消</button>
      </div>
      <p id="gate-msg" class="muted"></p>
    </div>`
  gate.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const gateInput = gate.querySelector<HTMLInputElement>('#gate-pin')
  const gateMsg = gate.querySelector('#gate-msg')
  const confirm = () => {
    if (!verifyPin(gateInput?.value ?? '', deps.current().parentPin)) {
      if (gateMsg) gateMsg.textContent = 'PIN 不正确。'
      gateInput?.focus()
      return
    }
    gate.innerHTML = ''
    void run()
  }
  gateInput?.focus()
  gate.querySelector('#gate-cancel')?.addEventListener('click', () => {
    gate.innerHTML = ''
  })
  gate.querySelector('#gate-confirm')?.addEventListener('click', confirm)
  gateInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm()
  })
}

/** 家长保护卡：未设置→设 PIN（两次一致）；已设置→修改 PIN / 关闭保护（均先验旧 PIN）。
 *  PIN 明文存 settings，仅防误操作（规格 §4），不参与任何加密。 */
function setupParentPinCard(deps: CardDeps): { refresh: () => void } {
  const { container, current, persist } = deps
  const pinStatus = container.querySelector('#pin-status')
  const pinManage = container.querySelector('#pin-manage')
  const pinMsg = container.querySelector('#pin-msg')
  const msg = (text: string) => {
    if (pinMsg) pinMsg.textContent = text
  }
  const save = async (next: Settings, okText: string) => {
    if (await persist(next)) {
      msg(okText)
      renderPinManage()
    } else {
      msg('保存失败，存储不可用。')
    }
  }

  const renderPinManage = () => {
    if (!pinManage || !pinStatus) return
    if (current().parentPin === undefined) {
      pinStatus.textContent = '当前状态：未设置 PIN。'
      pinManage.innerHTML = `
        ${pinInputHtml('pin-new', '新 PIN')}
        ${pinInputHtml('pin-confirm', '确认新 PIN')}
        <div class="action-row"><button class="btn" id="pin-set">设置 PIN</button></div>`
      pinManage.querySelector('#pin-set')?.addEventListener('click', async () => {
        msg('')
        const newPin = pinManage.querySelector<HTMLInputElement>('#pin-new')?.value ?? ''
        const confirmPin = pinManage.querySelector<HTMLInputElement>('#pin-confirm')?.value ?? ''
        if (!PIN_PATTERN.test(newPin)) {
          msg('PIN 须为 4 位数字。')
          return
        }
        if (newPin !== confirmPin) {
          msg('两次输入不一致。')
          return
        }
        await save({ ...current(), parentPin: newPin }, '家长保护已开启。')
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
      msg('')
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
        msg('')
        const oldPin = pinManage.querySelector<HTMLInputElement>('#pin-old')?.value ?? ''
        const newPin = pinManage.querySelector<HTMLInputElement>('#pin-new')?.value ?? ''
        const confirmPin = pinManage.querySelector<HTMLInputElement>('#pin-confirm')?.value ?? ''
        if (!verifyPin(oldPin, current().parentPin)) {
          msg('PIN 不正确。')
          return
        }
        if (!PIN_PATTERN.test(newPin)) {
          msg('新 PIN 须为 4 位数字。')
          return
        }
        if (newPin !== confirmPin) {
          msg('两次输入不一致。')
          return
        }
        await save({ ...current(), parentPin: newPin }, 'PIN 已修改。')
      })
    })
    pinManage.querySelector('#pin-off')?.addEventListener('click', () => {
      msg('')
      pinManage.innerHTML = `
        ${pinInputHtml('pin-old', '当前 PIN')}
        <div class="action-row">
          <button class="btn" id="pin-off-confirm">确认关闭</button>
          <button class="btn btn-secondary" id="pin-off-cancel">取消</button>
        </div>
        <p class="muted">关闭后受保护操作不再需要 PIN。</p>`
      pinManage.querySelector('#pin-off-cancel')?.addEventListener('click', renderPinManage)
      pinManage.querySelector('#pin-off-confirm')?.addEventListener('click', async () => {
        const oldPin = pinManage.querySelector<HTMLInputElement>('#pin-old')?.value ?? ''
        if (!verifyPin(oldPin, current().parentPin)) {
          msg('PIN 不正确。')
          return
        }
        await save({ ...current(), parentPin: undefined }, '家长保护已关闭。')
      })
    })
  }
  renderPinManage()
  return { refresh: renderPinManage }
}

/** 试卷成绩卡：label/got/total 多行录入，存 settings.examScores。
 *  有意不挂 PIN 门禁——规格 §4 受保护项不含试卷成绩录入（非破坏性诊断数据）。 */
function setupExamScoresCard(deps: CardDeps): { refresh: () => void } {
  const { container, current, persist } = deps
  const examRows = container.querySelector('#exam-rows')
  const examAdd = container.querySelector<HTMLButtonElement>('#exam-add')
  const examMsg = container.querySelector('#exam-msg')
  const setMsg = (text: string) => {
    if (examMsg) examMsg.textContent = text
  }
  /** 行 DOM 常驻为唯一事实来源（加行不整卡重渲，避免丢失未保存输入） */
  const examRowHtml = (r: { label: string; got: string; total: string }) => `
    <div class="exam-row">
      <input class="exam-label" type="text" maxlength="20" placeholder="题型（如 语法）" value="${escapeHtml(r.label)}">
      <input class="exam-got" type="number" min="0" placeholder="得分" value="${escapeHtml(r.got)}">
      <input class="exam-total" type="number" min="1" placeholder="满分" value="${escapeHtml(r.total)}">
    </div>`
  const rowCount = () => (examRows ? examRows.querySelectorAll('.exam-row').length : 0)
  const updateAdd = () => {
    if (examAdd) examAdd.disabled = rowCount() >= EXAM_MAX_ROWS
  }
  const appendRow = (r: { label: string; got: string; total: string }) => {
    examRows?.insertAdjacentHTML('beforeend', examRowHtml(r))
    updateAdd()
  }
  /** 从页内 settings 重建行（初次渲染与导入备份后刷新共用；超限旧库截断到 EXAM_MAX_ROWS 行） */
  const renderRows = () => {
    if (!examRows) return
    examRows.innerHTML = ''
    for (const r of (current().examScores ?? []).slice(0, EXAM_MAX_ROWS)) {
      appendRow({ label: r.label, got: String(r.got), total: String(r.total) })
    }
    if (rowCount() === 0) appendRow({ label: '', got: '', total: '' })
  }

  examAdd?.addEventListener('click', () => {
    if (rowCount() >= EXAM_MAX_ROWS) {
      setMsg(`最多 ${EXAM_MAX_ROWS} 行（最近两次试卷）。`)
      return
    }
    setMsg('')
    appendRow({ label: '', got: '', total: '' })
  })

  container.querySelector('#exam-save')?.addEventListener('click', async () => {
    if (!examRows) return
    setMsg('')
    const raw = [...examRows.querySelectorAll('.exam-row')].map((row) => ({
      label: row.querySelector<HTMLInputElement>('.exam-label')?.value ?? '',
      got: row.querySelector<HTMLInputElement>('.exam-got')?.value ?? '',
      total: row.querySelector<HTMLInputElement>('.exam-total')?.value ?? '',
    }))
    // 校验/截断全部下沉纯函数 parseExamRows（含 8 行上限兜底）
    const parsed = parseExamRows(raw)
    if (!parsed.ok) {
      setMsg(parsed.message)
      return
    }
    if (await persist({ ...current(), examScores: parsed.rows })) {
      setMsg('已保存试卷成绩。')
    } else {
      setMsg('保存失败，存储不可用。')
    }
  })

  container.querySelector('#exam-clear')?.addEventListener('click', async () => {
    setMsg('')
    if (await persist({ ...current(), examScores: undefined })) {
      renderRows()
      setMsg('已清除试卷成绩。')
    } else {
      setMsg('清除失败，存储不可用。')
    }
  })

  renderRows()
  return { refresh: renderRows }
}

/** AI 配置卡（规格 §7.1）：五字段 + 密钥掩码管理。已存密钥只回显掩码（sk-****+后4位），
 *  「更换」切换为密码输入、「清除」移除密钥，任何路径不回填明文。
 *  保存前经纯函数 parseAiConfigForm 校验（URL 须 https、每日上限 1–500 整数）；
 *  「测试连接」经 testConnection 发最小探活请求（含未保存的表单值），不落 aiRequests 不计配额。
 *  红线：密钥仅存本机浏览器（IndexedDB settings），备份导出剔除（services/backup）。 */
function setupAiConfigCard(
  deps: CardDeps,
  gate: (action: PinProtectedAction, run: () => void | Promise<void>) => void,
): { refresh: () => void } {
  const { container, current, persist } = deps
  const keyArea = () => container.querySelector('#ai-key-area')
  const msgEl = () => container.querySelector('#ai-msg')
  const msg = (text: string) => {
    const el = msgEl()
    if (el) el.textContent = text
  }

  /** 密钥输入行（未设置/更换两种场景共用；不回填明文） */
  const renderKeyInput = (change: boolean) => {
    const area = keyArea()
    if (!area) return
    area.innerHTML = `
      <div class="form-row">
        <label for="ai-key">API 密钥（百炼 ${change ? '新密钥' : 'sk-开头'}）</label>
        <input id="ai-key" type="password" autocomplete="off" placeholder="sk-…">
      </div>
      ${change ? '<div class="action-row"><button class="btn btn-secondary" id="ai-key-cancel">取消更换</button></div>' : ''}
      ${change ? '' : '<p class="muted">未配置密钥时 AI 功能不可用（灰态）。</p>'}`
    area.querySelector('#ai-key-cancel')?.addEventListener('click', () => {
      msg('')
      renderKeyArea()
    })
  }

  /** 已存密钥：掩码 + 更换/清除；未存：直接给输入框 */
  const renderKeyArea = () => {
    const area = keyArea()
    if (!area) return
    const key = current().aiApiKey
    if (key === undefined) {
      renderKeyInput(false)
      return
    }
    area.innerHTML = `
      <div class="form-row">
        <label>当前密钥</label>
        <p><code>${escapeHtml(maskApiKey(key))}</code></p>
      </div>
      <div class="action-row">
        <button class="btn btn-secondary" id="ai-key-change">更换密钥</button>
        <button class="btn btn-secondary" id="ai-key-clear">清除密钥</button>
      </div>`
    area.querySelector('#ai-key-change')?.addEventListener('click', () => {
      msg('')
      renderKeyInput(true)
    })
    area.querySelector('#ai-key-clear')?.addEventListener('click', () => {
      msg('')
      gate('save-settings', async () => {
        if (await persist({ ...current(), aiApiKey: undefined })) {
          renderKeyArea()
          msg('已清除密钥。')
        } else {
          msg('清除失败，存储不可用。')
        }
      })
    })
  }

  /** 从表单读取原始值（密钥输入未渲染时按空串=不更换处理） */
  const readForm = () => ({
    baseUrl: container.querySelector<HTMLInputElement>('#ai-base-url')?.value ?? '',
    apiKey: container.querySelector<HTMLInputElement>('#ai-key')?.value ?? '',
    model: container.querySelector<HTMLInputElement>('#ai-model')?.value ?? '',
    visionModel: container.querySelector<HTMLInputElement>('#ai-vision-model')?.value ?? '',
    dailyLimit: container.querySelector<HTMLInputElement>('#ai-daily-limit')?.value ?? '',
  })

  container.querySelector('#ai-save')?.addEventListener('click', () => {
    msg('')
    gate('save-settings', async () => {
      const parsed = parseAiConfigForm(readForm(), current().aiApiKey)
      if (!parsed.ok) {
        msg(parsed.message)
        return
      }
      if (await persist({ ...current(), ...parsed.value })) {
        renderKeyArea()
        msg('已保存 AI 配置。')
      } else {
        msg('保存失败，存储不可用。')
      }
    })
  })

  // 测试连接（规格 §7.1）：本地校验 → 探活（10s 超时，按钮 loading 防连点）→ 成功显示连通与模型、失败显示分类文案
  container.querySelector('#ai-test')?.addEventListener('click', () => {
    msg('')
    const parsed = parseAiConfigForm(readForm(), current().aiApiKey)
    if (!parsed.ok) {
      msg(parsed.message)
      return
    }
    if (parsed.value.aiApiKey === undefined) {
      msg('未配置密钥，无法测试连接。')
      return
    }
    // 家长总开关关闭时口径同调用层（testConnection 亦会拒绝）：提示先开启
    if (current().aiEnabled === false) {
      msg('AI 已关闭，请先在上方勾选「AI 讲解」后再测试。')
      return
    }
    const btn = container.querySelector<HTMLButtonElement>('#ai-test')
    if (!btn || btn.disabled) return
    btn.disabled = true
    const originalText = btn.textContent
    btn.textContent = '测试中…'
    msg('正在测试连接…')
    // 表单值可能尚未保存：以「当前 settings + 本次表单解析值」发起探活
    void testConnection({ ...current(), ...parsed.value })
      .then((r) => msg(`连通 ✓ 模型 ${r.model}`))
      .catch((err: unknown) => msg(`测试连接失败：${aiErrorText(err)}`))
      .finally(() => {
        btn.disabled = false
        btn.textContent = originalText ?? '测试连接'
      })
  })

  renderKeyArea()
  return {
    refresh: () => {
      const baseUrl = container.querySelector<HTMLInputElement>('#ai-base-url')
      if (baseUrl) baseUrl.value = current().aiBaseUrl ?? AI_DEFAULT_BASE_URL
      const model = container.querySelector<HTMLInputElement>('#ai-model')
      if (model) model.value = current().aiModel ?? AI_DEFAULT_MODEL
      const visionModel = container.querySelector<HTMLInputElement>('#ai-vision-model')
      if (visionModel) visionModel.value = current().aiVisionModel ?? ''
      const limit = container.querySelector<HTMLInputElement>('#ai-daily-limit')
      if (limit) limit.value = String(current().aiDailyLimit ?? AI_DEFAULT_DAILY_LIMIT)
      renderKeyArea()
    },
  }
}

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
  // 页内 settings 快照：各卡保存/导入备份后整体替换（persist 与导入刷新两处）
  const current = () => settings
  const persist = async (next: Settings): Promise<boolean> => {
    try {
      await saveSettings(next)
    } catch {
      return false
    }
    settings = next
    return true
  }
  const deps: CardDeps = { container, current, persist }
  const runProtected = (action: PinProtectedAction, run: () => void | Promise<void>) => runPinGate(deps, action, run)

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
        <label for="set-unit">当前学习单元</label>
        <select id="set-unit"></select>
        <p class="muted">同时决定单词默写范围与专项练习、每日计划的出题范围（按教材单元逐步解锁语法专项）；学到七下后自动解锁七上全部专项。</p>
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
        <label for="set-ai">AI 讲解（联网调用外部 AI 服务；关闭后练习/报告页 AI 按钮置灰）</label>
        <input id="set-ai" type="checkbox" ${settings.aiEnabled ? 'checked' : ''}>
      </div>
      <div class="action-row"><button class="btn" id="save">保存设置</button></div>
    </div>
    <div class="card">
      <h3>家长保护</h3>
      <p>设置 ${PIN_LENGTH} 位数字 PIN 后，保存设置、导入备份需先输入 PIN。PIN 明文存储于本机，仅防误操作，不参与任何加密。</p>
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
      <h3>AI 配置</h3>
      <p>联网调用外部 AI 服务（阿里云百炼 OpenAI 兼容模式）。密钥仅存本机浏览器，不会出现在备份文件中。还需在上方「AI 讲解」勾选开启后，练习/报告页才会启用 AI。</p>
      <div class="form-row">
        <label for="ai-base-url">接口地址（https）</label>
        <input id="ai-base-url" type="text" value="${escapeHtml(settings.aiBaseUrl ?? AI_DEFAULT_BASE_URL)}">
      </div>
      <div id="ai-key-area"></div>
      <div class="form-row">
        <label for="ai-model">模型名</label>
        <input id="ai-model" type="text" value="${escapeHtml(settings.aiModel ?? AI_DEFAULT_MODEL)}">
      </div>
      <div class="form-row">
        <label for="ai-vision-model">手写识别模型（留空用默认 ${AI_DEFAULT_VISION_MODEL}）</label>
        <input id="ai-vision-model" type="text" value="${escapeHtml(settings.aiVisionModel ?? '')}" placeholder="${AI_DEFAULT_VISION_MODEL}">
      </div>
      <div class="form-row">
        <label for="ai-daily-limit">每日调用上限（1–500）</label>
        <input id="ai-daily-limit" type="number" min="1" max="500" step="1" value="${escapeHtml(String(settings.aiDailyLimit ?? AI_DEFAULT_DAILY_LIMIT))}">
      </div>
      <div class="action-row">
        <button class="btn" id="ai-save">保存 AI 配置</button>
        <button class="btn btn-secondary" id="ai-test">测试连接</button>
      </div>
      <p id="ai-msg"></p>
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

  const pinCard = setupParentPinCard(deps)
  const examCard = setupExamScoresCard(deps)
  const aiCard = setupAiConfigCard(deps, runProtected)

  // 初次填充当前册的单元；currentUnit 属于另一册时不预选（浏览器默认选第一项），保存时生效
  fillUnitOptions(settings.book, settings.currentUnit)
  container.querySelector<HTMLSelectElement>('#set-book')?.addEventListener('change', (e) => {
    const book = (e.target as HTMLSelectElement).value || settings.book
    fillUnitOptions(book, '') // 切册后不预选，落到该册第一个单元
  })

  /** 主表单按页内 settings 重填（导入备份替换设置后刷新用） */
  const refillMainForm = () => {
    const bookSelect = container.querySelector<HTMLSelectElement>('#set-book')
    if (bookSelect) bookSelect.value = settings.book
    fillUnitOptions(settings.book, settings.currentUnit)
    const minutes = container.querySelector<HTMLInputElement>('#set-minutes')
    if (minutes) minutes.value = String(settings.dailyMinutes)
    const days = container.querySelector<HTMLInputElement>('#set-days')
    if (days) days.value = String(settings.studyDaysPerWeek)
    const ai = container.querySelector<HTMLInputElement>('#set-ai')
    if (ai) ai.checked = settings.aiEnabled
  }

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
    if (await persist(next)) {
      if (stale) return
      message.textContent = '已保存。'
    } else {
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
      downloadBackupFile(file, backupFileName())
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
        // 覆盖导入会整体替换 settings 行：页内 settings 快照已过期，必须重读并刷新表单，
        // 否则后续任一卡保存都会以旧快照为基底整对象写库、静默回滚刚导入的设置
        try {
          settings = await getSettings()
        } catch {
          // 存储读取失败：保留旧快照兜底展示（此状态下后续保存也大概率失败）
        }
        if (!stale) {
          refillMainForm()
          pinCard.refresh()
          examCard.refresh()
          aiCard.refresh()
        }
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
