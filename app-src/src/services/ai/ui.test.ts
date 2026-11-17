import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../db/repos'
import type { Settings } from '../../types'
import { AiError } from './transport'
import { aiButtonState, aiErrorText, hasAiKey } from './ui'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  aiApiKey: FAKE_KEY,
  aiDailyLimit: 5,
  aiEnabled: true,
  ...over,
})

describe('hasAiKey', () => {
  it('未配置/空白视同未配置；配置后为 true', () => {
    expect(hasAiKey({ ...DEFAULT_SETTINGS })).toBe(false)
    expect(hasAiKey(settings({ aiApiKey: '   ' }))).toBe(false)
    expect(hasAiKey(settings())).toBe(true)
  })
})

describe('aiButtonState：AI 按钮状态推导', () => {
  it('aiEnabled=false（家长在设置页关闭）→ 灰态，title 提示"已在设置页关闭 AI"（优先于 Key/配额判定）', () => {
    const state = aiButtonState(settings({ aiEnabled: false }), 0)
    expect(state.disabled).toBe(true)
    expect(state.title).toBe('已在设置页关闭 AI')
    // 即使配额也满，提示仍以关闭开关为准（对家长更诚实）
    expect(aiButtonState(settings({ aiEnabled: false }), 5).title).toBe('已在设置页关闭 AI')
  })

  it('aiEnabled=true 且已配置 Key → 可用（开关不再形同虚设）', () => {
    expect(aiButtonState(settings(), 0).disabled).toBe(false)
  })

  it('未配置 Key → 灰态，title 引导去设置页', () => {
    const s = settings()
    delete s.aiApiKey
    const state = aiButtonState(s, 0)
    expect(state.disabled).toBe(true)
    expect(state.title).toBe('未配置 AI（设置页）')
  })

  it('Key 为空白串 → 同未配置（与调用层 auth 前置检查同口径）', () => {
    const state = aiButtonState(settings({ aiApiKey: '  ' }), 0)
    expect(state.disabled).toBe(true)
    expect(state.title).toBe('未配置 AI（设置页）')
  })

  it('本地配额满 → 灰态，title 注明"本地上限 N 次"（勿让学生误以为服务端问题）', () => {
    const state = aiButtonState(settings({ aiDailyLimit: 5 }), 5)
    expect(state.disabled).toBe(true)
    expect(state.title).toContain('今日 AI 次数已用完')
    expect(state.title).toContain('本地上限 5 次')
  })

  it('配额将满未满（limit-1）→ 仍可用', () => {
    const state = aiButtonState(settings({ aiDailyLimit: 5 }), 4)
    expect(state.disabled).toBe(false)
  })

  it('未配置上限 → 按默认 50 判定', () => {
    const s = settings()
    delete s.aiDailyLimit
    expect(aiButtonState(s, 49).disabled).toBe(false)
    expect(aiButtonState(s, 50).disabled).toBe(true)
    expect(aiButtonState(s, 50).title).toContain('本地上限 50 次')
  })

  it('可用态 title 附带今日用量', () => {
    const state = aiButtonState(settings({ aiDailyLimit: 5 }), 2)
    expect(state.disabled).toBe(false)
    expect(state.title).toBe('AI 联网调用（今日 2/5 次）')
  })
})

describe('aiErrorText：错误分类文案', () => {
  it('quota-local 用调用层消息（含"本地上限"字样）', () => {
    const text = aiErrorText(new AiError('quota-local', '今日 AI 次数已用完（本地上限 5 次），请明天再试'))
    expect(text).toContain('本地上限 5 次')
  })

  it('各 kind 均映射为学生可读文案', () => {
    expect(aiErrorText(new AiError('network', 'x'))).toContain('网络')
    expect(aiErrorText(new AiError('timeout', 'x'))).toContain('超时')
    expect(aiErrorText(new AiError('auth', 'x'))).toContain('设置页')
    expect(aiErrorText(new AiError('rate-limit', 'x'))).toContain('频繁')
    expect(aiErrorText(new AiError('invalid-response', 'x'))).toContain('异常')
    expect(aiErrorText(new AiError('http', 'x'))).toContain('服务出错')
  })

  it('非 AiError（未知异常/AbortError）→ 通用文案，不抛错', () => {
    expect(aiErrorText(new Error('boom'))).toContain('AI 调用失败')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(aiErrorText(abort)).toContain('AI 调用失败')
    expect(aiErrorText(undefined)).toContain('AI 调用失败')
  })
})
