import { describe, expect, it } from 'vitest'
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_DAILY_LIMIT, AI_DEFAULT_MODEL, maskApiKey, parseAiConfigForm } from './ai-config'

/** 假 Key（红线：任何真实密钥不得出现在代码/测试/提交中） */
const FAKE_KEY = 'sk-test-fake-key-0000'

describe('maskApiKey（密钥回显掩码：sk-****+后4位）', () => {
  it('常规百炼 Key → sk-****0000', () => {
    expect(maskApiKey(FAKE_KEY)).toBe('sk-****0000')
  })
  it('过短 Key（≤4 字符）不回显任何明文片段', () => {
    expect(maskApiKey('sk-1')).toBe('sk-****')
    expect(maskApiKey('abcd')).toBe('sk-****')
  })
})

describe('parseAiConfigForm（保存前校验）', () => {
  const raw = {
    baseUrl: AI_DEFAULT_BASE_URL,
    apiKey: FAKE_KEY,
    model: AI_DEFAULT_MODEL,
    dailyLimit: String(AI_DEFAULT_DAILY_LIMIT),
  }

  it('合法输入 → 归一化值（去空白、数值化）', () => {
    const parsed = parseAiConfigForm({ ...raw, baseUrl: `  ${AI_DEFAULT_BASE_URL}  `, dailyLimit: ' 30 ' }, undefined)
    expect(parsed).toEqual({
      ok: true,
      value: { aiBaseUrl: AI_DEFAULT_BASE_URL, aiApiKey: FAKE_KEY, aiModel: AI_DEFAULT_MODEL, aiDailyLimit: 30 },
    })
  })
  it('密钥留空且本地已有密钥 → 保留已有密钥（掩码模式不回填明文）', () => {
    const parsed = parseAiConfigForm({ ...raw, apiKey: '' }, FAKE_KEY)
    expect(parsed.ok && parsed.value.aiApiKey).toBe(FAKE_KEY)
  })
  it('密钥留空且本地无密钥 → undefined（未配置）', () => {
    const parsed = parseAiConfigForm({ ...raw, apiKey: '  ' }, undefined)
    expect(parsed.ok && parsed.value.aiApiKey).toBeUndefined()
  })
  it('密钥两侧空白被裁剪', () => {
    const parsed = parseAiConfigForm({ ...raw, apiKey: ` ${FAKE_KEY} ` }, undefined)
    expect(parsed.ok && parsed.value.aiApiKey).toBe(FAKE_KEY)
  })
  it('接口地址为空拒绝', () => {
    const parsed = parseAiConfigForm({ ...raw, baseUrl: '' }, undefined)
    expect(!parsed.ok && parsed.message).toContain('接口地址')
  })
  it('接口地址非 https（http 明文）拒绝', () => {
    const parsed = parseAiConfigForm({ ...raw, baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1' }, undefined)
    expect(!parsed.ok && parsed.message).toContain('https')
  })
  it('模型名为空拒绝', () => {
    const parsed = parseAiConfigForm({ ...raw, model: ' ' }, undefined)
    expect(!parsed.ok && parsed.message).toContain('模型')
  })
  it.each(['0', '501', '10.5', 'abc', ''])('每日上限 %s 拒绝（须 1–500 整数）', (limit) => {
    const parsed = parseAiConfigForm({ ...raw, dailyLimit: limit }, undefined)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('1–500')
  })
  it('每日上限边界 1 与 500 均通过', () => {
    expect(parseAiConfigForm({ ...raw, dailyLimit: '1' }, undefined).ok).toBe(true)
    expect(parseAiConfigForm({ ...raw, dailyLimit: '500' }, undefined).ok).toBe(true)
  })
})
