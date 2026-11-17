/** 家长 PIN 门禁纯函数（规格 §4）：PIN 明文存 settings，定位仅防误操作，不参与任何加密 */

/** PIN 长度（页面输入 maxlength/pattern 与此同源；纯函数 verifyPin 不做形态校验） */
export const PIN_LENGTH = 4

/** 页面层 PIN 形态校验：恰好 4 位数字 */
export const PIN_PATTERN = /^\d{4}$/

/** 受门禁管控的操作：写操作三项 + 只读的报告页（恒不受限） */
export type PinProtectedAction = 'save-settings' | 'clear-data' | 'import-backup' | 'view-report'

/** 该操作是否需要先验 PIN：save-settings/clear-data/import-backup 在已设置 PIN 时受门禁；
 *  view-report 只读恒 false（报告页不弹 PIN）。 */
export function isPinProtectedAction(action: PinProtectedAction, hasPin: boolean): boolean {
  if (action === 'view-report') return false
  return hasPin
}

/** 校验输入与存储的 PIN 是否全等；未设置 PIN（undefined）时恒 true（无门禁）。
 *  纯函数不做输入清洗：非 4 位数字、含非数字字符的输入因与合法存储值（4 位数字）不全等而自然 false。 */
export function verifyPin(input: string, pin: string | undefined): boolean {
  if (pin === undefined) return true
  return input === pin
}
