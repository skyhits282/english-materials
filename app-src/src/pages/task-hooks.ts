/** 任务回写辅助（exercise 键盘流使用，后续拍照默写流程 vocab-photo 复用）：回写失败仅告警，
 *  不阻塞练习主链路（沿用 M1 降级哲学）。独立成模块以避免 exercise 与 vocab-photo 之间形成循环 import。 */
import { completeTask, getTask, updateTaskStatus } from '../db/repos'
import { localDayKey } from '../domain/metrics'
import type { TaskRow } from '../db/schema'

/** 任务存在且属于今日（跨日打开的旧链接任务不回写——隔日练习不应改写昨日任务状态） */
async function todaysTask(taskId: string): Promise<TaskRow | undefined> {
  const task = await getTask(taskId)
  return task && task.day === localDayKey() ? task : undefined
}

export async function markTaskStarted(taskId: string): Promise<void> {
  try {
    const task = await todaysTask(taskId)
    // 仅 planned 起转（重复进入已 in_progress 的任务不可再转，状态机无自环转移）
    if (!task || task.status !== 'planned') return
    await updateTaskStatus(taskId, 'in_progress')
  } catch (err) {
    console.warn('任务置 in_progress 失败：', err)
  }
}

export async function markTaskCompleted(taskId: string): Promise<void> {
  try {
    if (!(await todaysTask(taskId))) return
    // 状态机转移（planned 两步/in_progress 直转/终态拒绝返回 false）下沉在 completeTask
    await completeTask(taskId)
  } catch (err) {
    console.warn('任务完成回写失败：', err)
  }
}
