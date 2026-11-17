import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuid } from './uuid'

/** 真实 crypto（供"无 randomUUID"用例构造残缺替身）；stub 一律 unstubAllGlobals 还原 */
const realCrypto = globalThis.crypto

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uuid：randomUUID 统一入口', () => {
  it('原生可用时直接走 crypto.randomUUID（同一返回值）', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555')
    expect(uuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('非安全上下文（http 非 localhost）无 randomUUID → v4 回退仍为合法格式', () => {
    // 模拟非安全上下文的 crypto：有 getRandomValues、无 randomUUID
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    for (let i = 0; i < 100; i++) {
      expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it('crypto 完全不可用 → 回退仍为合法格式', () => {
    vi.stubGlobal('crypto', undefined)
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('回退分支可产生不同值（随机性基本可用）', () => {
    vi.stubGlobal('crypto', {})
    const seen = new Set(Array.from({ length: 50 }, () => uuid()))
    expect(seen.size).toBeGreaterThan(40)
  })
})
