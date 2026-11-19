/** AI 配置纯函数（规格 §7.1）：设置页"AI 配置"卡的保存前校验与密钥掩码。
 *  红线：aiApiKey 仅存本机浏览器，备份导出剔除（services/backup），本模块不做任何 IO。 */

/** 默认接口地址（阿里云百炼 OpenAI 兼容模式；未配置时输入框默认展示） */
export const AI_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** 默认模型（百炼 qwen-flash；未配置时输入框默认展示） */
export const AI_DEFAULT_MODEL = 'qwen-flash'

/** 默认视觉识别模型（百炼多模态；手写拍照默写用） */
export const AI_DEFAULT_VISION_MODEL = 'qwen-vl-ocr'

/** 默认每日调用上限 */
export const AI_DEFAULT_DAILY_LIMIT = 50

/** 密钥回显掩码：sk-**** + 末 4 位；过短 Key（≤4 字符）不回显任何明文片段 */
export function maskApiKey(key: string): string {
  return key.length > 4 ? `sk-****${key.slice(-4)}` : 'sk-****'
}

/** AI 配置表单原始值：四个字段均为未清洗的字符串（密钥输入未渲染/未更换时为空串） */
export interface RawAiConfigForm {
  baseUrl: string
  apiKey: string
  model: string
  /** 手写识别模型：留空 = 用默认（不写入 settings） */
  visionModel: string
  dailyLimit: string
}

export interface AiConfigValue {
  aiBaseUrl: string
  /** 新密钥；空输入且本地已有密钥时保留原值（掩码模式不回填明文），均无则 undefined */
  aiApiKey?: string
  aiModel: string
  /** 留空时缺省（undefined → 用 AI_DEFAULT_VISION_MODEL） */
  aiVisionModel?: string
  aiDailyLimit: number
}

export type ParsedAiConfig =
  | { ok: true; value: AiConfigValue }
  | { ok: false; message: string }

/** 保存前校验（纯函数）：URL 须 https、每日上限 1–500 整数、模型名非空；
 *  密钥留空视为"不更换"（保留 existingKey），非空则裁剪后作为新值。 */
export function parseAiConfigForm(raw: RawAiConfigForm, existingKey: string | undefined): ParsedAiConfig {
  const baseUrl = raw.baseUrl.trim()
  if (baseUrl === '') return { ok: false, message: '请填写接口地址。' }
  if (!baseUrl.startsWith('https://')) return { ok: false, message: '接口地址须以 https:// 开头。' }
  const model = raw.model.trim()
  if (model === '') return { ok: false, message: '请填写模型名。' }
  const visionModel = raw.visionModel.trim()
  // 只接受纯十进制数字字面量：前置 /^\d+$/ 收紧，拒绝 '0x32'/'1e2'/'-3'/'+5' 等可被 Number() 解析的写法
  const limitRaw = raw.dailyLimit.trim()
  if (!/^\d+$/.test(limitRaw)) {
    return { ok: false, message: '每日调用上限须为 1–500 的整数。' }
  }
  const dailyLimit = Number(limitRaw)
  if (dailyLimit < 1 || dailyLimit > 500) {
    return { ok: false, message: '每日调用上限须为 1–500 的整数。' }
  }
  const apiKey = raw.apiKey.trim()
  return {
    ok: true,
    value: {
      aiBaseUrl: baseUrl,
      ...(apiKey !== '' || existingKey !== undefined ? { aiApiKey: apiKey === '' ? existingKey : apiKey } : {}),
      aiModel: model,
      ...(visionModel !== '' ? { aiVisionModel: visionModel } : {}),
      aiDailyLimit: dailyLimit,
    },
  }
}
