/** AI UI 辅助（纯函数，无 IO）：练习/报告页 AI 按钮状态推导与错误分类文案。
 *  按钮状态（未配置 Key / 本地配额满）与调用层前置检查同口径（quota.ts effectiveDailyLimit），
 *  保证"UI 灰态"与"点击后调用层拒绝"两者判定一致。 */
import { effectiveDailyLimit } from './quota'
import { AiError } from './transport'
import type { Settings } from '../../types'

/** AI 按钮渲染状态：disabled 时按钮灰态，title 说明原因（鼠标悬停/长按可见） */
export interface AiButtonState {
  disabled: boolean
  title: string
}

/** 是否已配置 AI 密钥（与 runAiTask 的 auth 前置检查同一判定：空白视同未配置） */
export function hasAiKey(settings: Settings): boolean {
  return (settings.aiApiKey ?? '').trim() !== ''
}

/** 按钮状态推导：未配置 Key → 灰态（提示去设置页）；本地配额满 → 灰态（注明"本地上限"）；
 *  否则可用，title 顺带展示今日用量便于家长掌握额度。 */
export function aiButtonState(settings: Settings, usageToday: number): AiButtonState {
  if (!hasAiKey(settings)) return { disabled: true, title: '未配置 AI（设置页）' }
  const limit = effectiveDailyLimit(settings)
  if (usageToday >= limit) {
    return { disabled: true, title: `今日 AI 次数已用完（本地上限 ${limit} 次），请明天再试` }
  }
  return { disabled: false, title: `AI 联网调用（今日 ${usageToday}/${limit} 次）` }
}

/** AI 调用失败 → 学生可读文案（按 AiError kind 分类）。
 *  'quota-local' 直接用调用层消息（已含"本地上限 N 次"字样，明确是本机每日上限而非服务端故障）。 */
export function aiErrorText(err: unknown): string {
  if (err instanceof AiError) {
    if (err.kind === 'quota-local') return err.message
    switch (err.kind) {
      case 'network':
        return '网络不可用，请检查网络后重试。'
      case 'timeout':
        return 'AI 响应超时，请重试。'
      case 'auth':
        return 'AI 密钥无效或未配置，请到设置页检查。'
      case 'rate-limit':
        return 'AI 服务繁忙（请求过于频繁），请稍后再试。'
      case 'invalid-response':
        return 'AI 返回内容异常，请重试。'
      case 'http':
        return 'AI 服务出错，请稍后再试。'
    }
  }
  return 'AI 调用失败，请稍后重试。'
}
