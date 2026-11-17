import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, type TaskRow } from './schema'
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  saveAttempt,
  hasPriorAttempt,
  attemptsForQuestion,
  listAttempts,
  upsertQuestions,
  questionsByUnitPrefix,
  putContentMeta,
  getContentMeta,
  applyMasteryUpdate,
  getReviewSet,
  getOrCreatePlan,
  updateTaskStatus,
  getTask,
  clearDayTasks,
} from './repos'
import type { Attempt, Mastery, Question, Settings, VocabBook } from '../types'

const q = (id: string, unit: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit,
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: 'stem',
  options: ['a', 'b', 'c', 'd'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

const attempt = (id: string, questionId: string, isCorrect: boolean): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase: 'first',
  submittedAt: '2026-11-16T10:00:00.000Z',
})

beforeEach(async () => {
  await Promise.all([
    db.settings.clear(),
    db.questions.clear(),
    db.attempts.clear(),
    db.contentMeta.clear(),
    db.aiRequests.clear(),
    db.mastery.clear(),
    db.tasks.clear(),
  ])
})

describe('settings', () => {
  it('无记录时返回默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })
  it('保存后可读回且 updatedAt 存在', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, dailyMinutes: 25 })
    const s = await getSettings()
    expect(s.dailyMinutes).toBe(25)
    const row = await db.settings.get('app')
    expect(row?.updatedAt).toBeTruthy()
  })
  it('旧版本行缺失字段时合并默认值', async () => {
    await db.settings.put({ key: 'app', value: { grade: 7 } as unknown as Settings, updatedAt: '2026-01-01T00:00:00.000Z' })
    const s = await getSettings()
    expect(s.dailyMinutes).toBe(DEFAULT_SETTINGS.dailyMinutes)
  })
})

describe('attempts（只追加）', () => {
  it('同一 ID 重复保存不覆盖（add 语义）', async () => {
    await saveAttempt(attempt('a1', 'q1', false))
    await expect(saveAttempt(attempt('a1', 'q1', true))).rejects.toThrow()
    const rows = await attemptsForQuestion('q1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.isCorrect).toBe(false)
  })
  it('hasPriorAttempt 反映历史存在性', async () => {
    expect(await hasPriorAttempt('q1')).toBe(false)
    await saveAttempt(attempt('a1', 'q1', false))
    expect(await hasPriorAttempt('q1')).toBe(true)
  })
  it('listAttempts 按 submittedAt 升序', async () => {
    await saveAttempt({ ...attempt('a2', 'q9', true), submittedAt: '2026-11-16T12:00:00.000Z' })
    await saveAttempt({ ...attempt('a1', 'q9', false), submittedAt: '2026-11-16T11:00:00.000Z' })
    const rows = await listAttempts()
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2'])
  })
})

describe('questions', () => {
  it('按 unit 前缀查询专项全部题', async () => {
    await upsertQuestions([q('g7a-present-l1-0001', 'g7a-present-l1'), q('g7a-present-l6-0048', 'g7a-present-l6'), q('g7a-nouns-l1-0001', 'g7a-nouns-l1')])
    expect(await questionsByUnitPrefix('g7a-present')).toHaveLength(2)
  })
})

describe('contentMeta', () => {
  it('写入后可按 contentId 读回', async () => {
    await putContentMeta({
      contentId: 'g7a',
      version: '2026-11-16',
      questionCount: 192,
      vocabWordCount: 184,
      books: [],
      files: [],
    })
    expect((await getContentMeta('g7a'))?.version).toBe('2026-11-16')
  })
})

describe('aiRequests', () => {
  it('aiRequests 同 createdAt 不同 id 不冲突', async () => {
    const row = (id: string) => ({ id, type: 'explain', status: 'done', createdAt: '2026-11-16T10:00:00.000Z' })
    await db.aiRequests.add(row('r1'))
    await db.aiRequests.add(row('r2'))
    expect(await db.aiRequests.count()).toBe(2)
  })
})

describe('applyMasteryUpdate（mastery 提交挂钩）', () => {
  /** 本地固定时刻，保证本地日断言与运行时区无关 */
  const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)

  const sub = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry', when: Date): Attempt => ({
    id,
    questionId,
    answer: 'x',
    isCorrect,
    phase,
    submittedAt: when.toISOString(),
  })

  it('首错：保存 attempt 并创建 weak/1 天 mastery 行（同事务）', async () => {
    const now = at(2026, 11, 17)
    const q1 = { ...q('g7a-vocab-u1-0001', 'v1-u1'), knowledgePointIds: ['vocab.g7a.u1'] }
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', now), q1, now)
    expect(await db.attempts.count()).toBe(1)
    const row = await db.mastery.get('vocab.g7a.u1')
    expect(row?.stage).toBe('weak')
    expect(row?.intervalDays).toBe(1)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 18).toISOString())
    expect(row?.metrics).toEqual({ testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 })
  })

  it('同日再错不推进（stage/interval/nextReviewAt 不变，仅 testedCount 累加）', async () => {
    const day1 = at(2026, 11, 17, 9)
    const q1 = { ...q('q1', 'v1-u1'), knowledgePointIds: ['k'] }
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', day1), q1, day1)
    const day1Later = at(2026, 11, 17, 15)
    await applyMasteryUpdate(sub('a2', q1.id, false, 'retry', day1Later), q1, day1Later)
    const row = await db.mastery.get('k')
    expect(row?.stage).toBe('weak')
    expect(row?.intervalDays).toBe(1)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 18).toISOString())
    expect(row?.metrics.testedCount).toBe(2)
  })

  it('隔日复测正确：推进 consolidating/3 天，并按历史 attempt 判定隔日', async () => {
    const q1 = { ...q('q1', 'v1-u1'), knowledgePointIds: ['k'] }
    const day1 = at(2026, 11, 16)
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', day1), q1, day1)
    const day2 = at(2026, 11, 17)
    await applyMasteryUpdate(sub('a2', q1.id, true, 'retry', day2), q1, day2)
    const row = await db.mastery.get('k')
    expect(row?.stage).toBe('consolidating')
    expect(row?.intervalDays).toBe(3)
    expect(row?.nextReviewAt).toBe(new Date(2026, 10, 20).toISOString())
    expect(row?.metrics).toEqual({ testedCount: 2, firstTryCorrect: 0, delayedReviewCorrect: 1 })
  })

  it('多知识点逐个更新（词题与选择题共用 question.knowledgePointIds）', async () => {
    const q1 = { ...q('q1', 'g7a-present-l1'), knowledgePointIds: ['grammar.present.basic', 'grammar.present.usage'] }
    const now = at(2026, 11, 17)
    await applyMasteryUpdate(sub('a1', q1.id, false, 'first', now), q1, now)
    expect(await db.mastery.count()).toBe(2)
    expect((await db.mastery.get('grammar.present.basic'))?.stage).toBe('weak')
    expect((await db.mastery.get('grammar.present.usage'))?.stage).toBe('weak')
  })
})

describe('getReviewSet（复测选题 repo 封装）', () => {
  /** 本地固定时刻，保证本地日断言与运行时区无关 */
  const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)
  const NOW = at(2026, 11, 17)

  const masteryRow = (kp: string, nextReviewAt?: string): Mastery => ({
    knowledgePointId: kp,
    stage: nextReviewAt ? 'weak' : 'new',
    intervalDays: nextReviewAt ? 1 : 0,
    metrics: { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 },
    ...(nextReviewAt ? { nextReviewAt } : {}),
  })

  const sub = (id: string, questionId: string, isCorrect: boolean, when: Date, phase: 'first' | 'retry' = 'first'): Attempt => ({
    id,
    questionId,
    answer: 'x',
    isCorrect,
    phase,
    submittedAt: when.toISOString(),
  })

  it('到期知识点 × 曾答错题：选择题查 questions 表、词题按 ID 原样保留，轮转均衡输出', async () => {
    await upsertQuestions([{ ...q('g7a-present-l1-0001', 'g7a-present-l1'), knowledgePointIds: ['grammar.present'] }])
    // 词题知识点逾期更早（索引序在前），轮转第 1 轮先取词题
    await db.mastery.bulkPut([masteryRow('grammar.present', new Date(2026, 10, 17).toISOString()), masteryRow('vocab.g7a.u1', new Date(2026, 10, 16).toISOString())])
    await db.attempts.bulkAdd([
      sub('a1', 'g7a-vocab-u1-0001', false, at(2026, 11, 16)),
      sub('a2', 'g7a-present-l1-0001', false, at(2026, 11, 16)),
    ])
    const r = await getReviewSet(NOW)
    expect(r.questionIds).toEqual(['g7a-vocab-u1-0001', 'g7a-present-l1-0001'])
    expect(r.dueKpCount).toBe(2)
    expect(r.availableCount).toBe(2)
  })

  it('未到期/未排期与无错题知识点不产出题目；曾答对的历史不算错题', async () => {
    await upsertQuestions([{ ...q('q1', 'g7a-present-l1'), knowledgePointIds: ['k.due'] }])
    await db.mastery.bulkPut([
      masteryRow('k.future', new Date(2026, 10, 18).toISOString()), // 明日才到期
      masteryRow('k.nosched'), // 未排期
      masteryRow('k.due', new Date(2026, 10, 17).toISOString()),
      masteryRow('k.nowrong', new Date(2026, 10, 17).toISOString()), // 到期但历史全对
    ])
    await db.attempts.bulkAdd([
      sub('a1', 'q2', false, at(2026, 11, 16)), // 属于未到期知识点之外的题
      sub('a2', 'q1', true, at(2026, 11, 16)), // q1 历史只有答对记录
      sub('a3', 'q3', true, at(2026, 11, 16)),
    ])
    const r = await getReviewSet(NOW)
    expect(r.questionIds).toEqual([])
    expect(r.dueKpCount).toBe(2) // k.due 与 k.nowrong
    expect(r.availableCount).toBe(0)
  })

  it('当日已答（含当日复测答对）的题剔除，避免立即重复', async () => {
    await upsertQuestions([{ ...q('q1', 'g7a-present-l1'), knowledgePointIds: ['k'] }])
    await db.mastery.put(masteryRow('k', new Date(2026, 10, 17).toISOString()))
    await db.attempts.bulkAdd([
      sub('a1', 'q1', false, at(2026, 11, 16)), // 昨日首测错误 → 曾答错
      sub('a2', 'q1', true, at(2026, 11, 17), 'retry'), // 今日复测已答
    ])
    const r = await getReviewSet(NOW)
    expect(r.questionIds).toEqual([])
    expect(r.availableCount).toBe(0)
  })
})

/** 词汇册 fixture（与 domain/plan.test.ts 同构：词题 ID 派生自 no 序号） */
const vocabBook = (unitId: string, wordCount: number): VocabBook => ({
  book: unitId.startsWith('v1') ? 'g7a' : 'g7b',
  contentVersion: 'test-v1',
  units: [
    {
      id: unitId,
      order: 1,
      label: 'U1',
      words: Array.from({ length: wordCount }, (_, i) => ({
        id: `${unitId}-w${i + 1}`,
        no: i + 1,
        word: `word${i + 1}`,
        variant: '',
        pos: 'n.',
        ipa: '/w/',
        meaning: `测试词${i + 1}`,
      })),
    },
  ],
})

describe('getOrCreatePlan（每日计划生成 repo 封装）', () => {
  /** 本地固定时刻：2026-11-17 周二（学习日）、2026-11-22 周日（休息日） */
  const at = (y: number, m: number, d: number, h = 10): Date => new Date(y, m - 1, d, h)
  const STUDY_DAY = at(2026, 11, 17)
  const REST_DAY = at(2026, 11, 22)

  /** 专项题入库（g7a-present，12 题 × 45s） */
  const seedSpecialQuestions = async (): Promise<void> => {
    await upsertQuestions(
      Array.from({ length: 12 }, (_, i) => q(`g7a-present-l1-${String(i + 1).padStart(4, '0')}`, 'g7a-present-l1')),
    )
  }

  it('学习日：生成 unit/special/summary 三任务并写入 tasks 表', async () => {
    await saveSettings(DEFAULT_SETTINGS) // currentUnit v1-u4、35 分钟、每周 6 天
    await seedSpecialQuestions()
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, STUDY_DAY)
    expect(tasks.map((t) => t.id)).toEqual([
      'task-2026-11-17-unit',
      'task-2026-11-17-special',
      'task-2026-11-17-summary',
    ])
    const unit = tasks.find((t) => t.type === 'unit')!
    expect(unit.questionIds).toEqual(['g7a-vocab-u4-0001', 'g7a-vocab-u4-0002', 'g7a-vocab-u4-0003', 'g7a-vocab-u4-0004', 'g7a-vocab-u4-0005'])
    expect(unit.minutesPlanned).toBe(24) // 无到期复习，review 份额并入 unit
    expect(tasks.find((t) => t.type === 'special')?.minutesPlanned).toBe(7)
    expect(tasks.find((t) => t.type === 'summary')).toMatchObject({ questionIds: [], minutesPlanned: 4 })
    expect(await db.tasks.count()).toBe(3)
  })

  it('同日重复调用返回顺序与首次一致（review→unit→special→summary，day 索引按主键字典序返回会打乱）', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    // 昨日 deferred 提供结转 → 今日四类任务齐全，锁定完整顺序
    await db.tasks.put({
      id: 'task-2026-11-16-unit',
      day: '2026-11-16',
      type: 'unit',
      questionIds: ['carry-1'],
      status: 'deferred',
      minutesPlanned: 14,
    })
    const inputs = { vocab: [vocabBook('v1-u4', 5)] }
    const first = await getOrCreatePlan(inputs, STUDY_DAY)
    expect(first.map((t) => t.type)).toEqual(['review', 'unit', 'special', 'summary'])
    const again = await getOrCreatePlan(inputs, STUDY_DAY)
    expect(again.map((t) => t.type)).toEqual(['review', 'unit', 'special', 'summary'])
    expect(again).toEqual(first)
  })

  it('同一天重复调用不重建（返回已有行，改动保留）', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    const inputs = { vocab: [vocabBook('v1-u4', 5)] }
    await getOrCreatePlan(inputs, STUDY_DAY)
    await updateTaskStatus('task-2026-11-17-unit', 'in_progress')
    const again = await getOrCreatePlan(inputs, STUDY_DAY)
    expect(again).toHaveLength(3)
    expect(again.find((t) => t.id === 'task-2026-11-17-unit')?.status).toBe('in_progress')
    expect(await db.tasks.count()).toBe(3)
  })

  it('非学习日：返回 [] 且不写任务（今日页显示"今日休息"）', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, REST_DAY)
    expect(tasks).toEqual([])
    expect(await db.tasks.count()).toBe(0)
  })

  it('昨日 deferred 结转为今日 review 任务；skipped 不结转', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    const yesterday: TaskRow[] = [
      { id: 'task-2026-11-16-unit', day: '2026-11-16', type: 'unit', questionIds: ['carry-1'], status: 'deferred', minutesPlanned: 14 },
      { id: 'task-2026-11-16-special', day: '2026-11-16', type: 'special', questionIds: ['skip-1'], status: 'skipped', minutesPlanned: 7 },
    ]
    await db.tasks.bulkPut(yesterday)
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, STUDY_DAY)
    const review = tasks.find((t) => t.type === 'review')
    expect(review?.questionIds).toEqual(['carry-1'])
    expect(review?.minutesPlanned).toBe(10)
    for (const t of tasks) expect(t.questionIds).not.toContain('skip-1')
    // 有结转承载的 review 任务存在时，unit 不再吸收 review 份额
    expect(tasks.find((t) => t.type === 'unit')?.minutesPlanned).toBe(14)
  })

  it('review 段与 Task 4 引擎联动：到期复测题进入今日 review 任务', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    await seedSpecialQuestions()
    const due = { ...q('g7a-present-l1-0001', 'g7a-present-l1'), knowledgePointIds: ['grammar.present'] }
    await upsertQuestions([due])
    await db.mastery.put({
      knowledgePointId: 'grammar.present',
      stage: 'weak',
      nextReviewAt: new Date(2026, 10, 16).toISOString(),
      intervalDays: 1,
      metrics: { testedCount: 1, firstTryCorrect: 0, delayedReviewCorrect: 0 },
    })
    await db.attempts.bulkAdd([
      { id: 'a1', questionId: due.id, answer: '0', isCorrect: false, phase: 'first', submittedAt: at(2026, 11, 16).toISOString() },
    ])
    const tasks = await getOrCreatePlan({ vocab: [vocabBook('v1-u4', 5)] }, STUDY_DAY)
    const review = tasks.find((t) => t.type === 'review')
    expect(review?.questionIds).toEqual([due.id])
    expect(review?.minutesPlanned).toBe(10)
    // 去重：同一题不得再出现在 unit/special 任务
    for (const t of tasks.filter((t) => t.type !== 'review')) {
      expect(t.questionIds).not.toContain(due.id)
    }
  })
})

describe('updateTaskStatus（任务状态机）', () => {
  const putTask = (status: TaskRow['status']): Promise<unknown> =>
    db.tasks.put({ id: 't1', day: '2026-11-17', type: 'unit', questionIds: ['q1'], status, minutesPlanned: 14 })

  it('合法链路：planned→in_progress→completed', async () => {
    await putTask('planned')
    await updateTaskStatus('t1', 'in_progress')
    expect((await db.tasks.get('t1'))?.status).toBe('in_progress')
    await updateTaskStatus('t1', 'completed')
    expect((await db.tasks.get('t1'))?.status).toBe('completed')
  })

  it('planned→skipped 与 in_progress→deferred 合法', async () => {
    await putTask('planned')
    await updateTaskStatus('t1', 'skipped')
    expect((await db.tasks.get('t1'))?.status).toBe('skipped')
    await putTask('in_progress')
    await updateTaskStatus('t1', 'deferred')
    expect((await db.tasks.get('t1'))?.status).toBe('deferred')
  })

  it('非法转移抛错且不落库：planned→completed（须先 in_progress）', async () => {
    await putTask('planned')
    await expect(updateTaskStatus('t1', 'completed')).rejects.toThrow('非法任务状态转移')
    expect((await db.tasks.get('t1'))?.status).toBe('planned')
  })

  it('终态不可再转移：completed→in_progress 抛错', async () => {
    await putTask('completed')
    await expect(updateTaskStatus('t1', 'in_progress')).rejects.toThrow('非法任务状态转移')
  })

  it('任务不存在抛错', async () => {
    await expect(updateTaskStatus('nope', 'in_progress')).rejects.toThrow('任务不存在')
  })
})

describe('getTask / clearDayTasks（任务查询与当日残缺计划清除）', () => {
  it('getTask 按 id 取任务行，不存在返回 undefined', async () => {
    await db.tasks.put({ id: 't1', day: '2026-11-17', type: 'summary', questionIds: [], status: 'planned', minutesPlanned: 4 })
    expect(await getTask('t1')).toMatchObject({ id: 't1', type: 'summary' })
    expect(await getTask('nope')).toBeUndefined()
  })

  it('clearDayTasks 只删当日任务行，其他日期保留（播种重试重建当日计划用）', async () => {
    await db.tasks.bulkPut([
      { id: 'task-2026-11-16-unit', day: '2026-11-16', type: 'unit', questionIds: ['q1'], status: 'deferred', minutesPlanned: 14 },
      { id: 'task-2026-11-17-summary', day: '2026-11-17', type: 'summary', questionIds: [], status: 'planned', minutesPlanned: 4 },
    ])
    await clearDayTasks('2026-11-17')
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.toArray())[0]?.id).toBe('task-2026-11-16-unit')
  })
})
