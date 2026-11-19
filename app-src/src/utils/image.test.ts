import { describe, expect, it } from 'vitest'
import { computeTargetSize, dataUrlByteSize, IMAGE_MAX_BYTES, IMAGE_TARGET_LONG_EDGE } from './image'

describe('computeTargetSize（目标尺寸，纯函数）', () => {
  it('长边超限 → 等比缩放到长边上限', () => {
    expect(computeTargetSize(4000, 3000)).toEqual({ width: 1280, height: 960 })
    expect(computeTargetSize(3000, 4000)).toEqual({ width: 960, height: 1280 })
  })
  it('长边等于上限 → 不缩放（null）', () => {
    expect(computeTargetSize(1280, 720)).toBeNull()
  })
  it('小图 → 不放大（null）', () => {
    expect(computeTargetSize(800, 600)).toBeNull()
    expect(computeTargetSize(1281, 1)).toEqual({ width: 1280, height: 1 })
  })
})

describe('dataUrlByteSize（体积近似）', () => {
  it('base64 长度 × 3/4 近似原始字节（含前缀）', () => {
    const url = 'data:image/jpeg;base64,' + 'QUJD'.repeat(10) // 40 个 base64 字符 → 30 字节
    expect(dataUrlByteSize(url)).toBe(30)
  })
  it('上限常量为 3MB', () => {
    expect(IMAGE_MAX_BYTES).toBe(3 * 1024 * 1024)
  })
  it('长边上限常量为 1280', () => {
    expect(IMAGE_TARGET_LONG_EDGE).toBe(1280)
  })
})
