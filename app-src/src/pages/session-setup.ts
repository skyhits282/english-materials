/** 组装带记录的 PracticeSession（exercise 键盘流与 vocab-photo 拍照流共用）：
 *  attempt 追加与 mastery 更新走同一事务（applyMasteryUpdate）；挂钩失败仅告警并回退为
 *  单独保存 attempt，不影响判分主链路；存储不可用跳过记录（M1 降级哲学）。 */
import type { Question } from '../types'
import { applyMasteryUpdate, hasPriorAttempt, saveAttempt } from '../db/repos'
import { PracticeSession } from '../domain/session'

export function buildRecordingSession(questions: Question[], storageOk: boolean): PracticeSession {
  const questionsById = new Map(questions.map((item) => [item.id, item] as const))
  return new PracticeSession(questions, {
    hasPriorAttempt: storageOk ? hasPriorAttempt : async () => false,
    recordAttempt: storageOk
      ? async (a) => {
          const question = questionsById.get(a.questionId)
          if (!question) {
            console.warn('mastery 挂钩跳过：会话内未找到题目', a.questionId)
            await saveAttempt(a)
            return
          }
          try {
            await applyMasteryUpdate(a, question)
          } catch (err) {
            console.warn('mastery 更新失败，回退为仅保存 attempt：', err)
            await saveAttempt(a)
          }
        }
      : async (a) => console.warn('存储不可用，跳过记录：', a.questionId),
  })
}
