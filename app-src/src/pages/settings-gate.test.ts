import { describe, expect, it } from 'vitest'
import { isPinProtectedAction, verifyPin } from '../domain/pin'

describe('verifyPin（纯函数：输入与存储全等；未设置恒放行）', () => {
  it('未设置 PIN（undefined）时任意输入恒 true', () => {
    expect(verifyPin('', undefined)).toBe(true)
    expect(verifyPin('999', undefined)).toBe(true)
    expect(verifyPin('abcd', undefined)).toBe(true)
  })
  it('输入与存储全等时 true', () => {
    expect(verifyPin('1234', '1234')).toBe(true)
  })
  it('空输入 false', () => {
    expect(verifyPin('', '1234')).toBe(false)
  })
  it('长度≠4 false（过短/过长）', () => {
    expect(verifyPin('123', '1234')).toBe(false)
    expect(verifyPin('12345', '1234')).toBe(false)
  })
  it('非数字字符 false（字母/小数点/空格）', () => {
    expect(verifyPin('12a4', '1234')).toBe(false)
    expect(verifyPin('12.4', '1234')).toBe(false)
    expect(verifyPin(' 234', '1234')).toBe(false)
  })
  it('同为 4 位数字但不相等 false', () => {
    expect(verifyPin('1235', '1234')).toBe(false)
  })
})

describe('isPinProtectedAction（矩阵：写操作需 PIN，view-report 只读恒不受限）', () => {
  const actions = ['save-settings', 'clear-data', 'import-backup', 'view-report'] as const
  it.each(actions)('%s × hasPin=true', (action) => {
    expect(isPinProtectedAction(action, true)).toBe(action !== 'view-report')
  })
  it.each(actions)('%s × hasPin=false', (action) => {
    expect(isPinProtectedAction(action, false)).toBe(false)
  })
})
