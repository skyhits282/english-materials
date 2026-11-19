import { describe, expect, it } from 'vitest'
import {
  CARRY_LOOKBACK_DAYS,
  carryWindowStart,
  generatePlan,
  isStudyDay,
  pickCarrySource,
  PLAN_RATIO,
  SPECIAL_QUESTION_MAX,
  UNIT_QUESTION_MAX,
  type PlanContext,
} from './plan'
import type { Question, Settings, VocabBook } from '../types'
import type { TaskRow } from '../db/schema'

/** 2026-11-16（周一）～2026-11-22（周日）：isStudyDay 断言的取值日 */
const MONDAY = '2026-11-16'
const TUESDAY = '2026-11-17'
const SATURDAY = '2026-11-21'
const SUNDAY = '2026-11-22'

const settings = (over: Partial<Settings> = {}): Settings => ({
  grade: 7,
  book: 'g7a',
  currentUnit: 'v1-u1',
  dailyMinutes: 35,
  studyDaysPerWeek: 6,
  aiEnabled: false,
  studentLabel: '学生1',
  ...over,
})

/** 单册词汇 fixture：unitId（v1-u1 / v2-u3）前缀决定册别 */
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

/** 专项选择题 fixture（unit 形如 g7a-present-l1） */
const specialQ = (id: string, unit: string, kps: string[], estimatedSeconds = 45): Question => ({
  id,
  contentVersion: 'test-v1',
  grade: 7,
  term: 'A',
  unit,
  sourceUrl: 's',
  knowledgePointIds: kps,
  type: 'single_choice',
  stem: 'stem',
  options: ['a', 'b', 'c', 'd'],
  answerSpec: { correctOptionIndex: 0 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds,
})

/** 某专项 n 道题（id 顺序稳定），估计用时可调 */
const specialQuestions = (specialId: string, n: number, estimatedSeconds = 45): Question[] =>
  Array.from({ length: n }, (_, i) =>
    specialQ(`${specialId}-l1-${String(i + 1).padStart(4, '0')}`, `${specialId}-l1`, [`kp.${specialId}`], estimatedSeconds),
  )

/** 默认 PlanContext：学习日 / 35 分钟 / 无到期无错题 / 词汇 30 词 / 两专项 12 题 */
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  day: TUESDAY,
  settings: settings(),
  isStudyDay: true,
  reviewQuestions: [],
  wrongByKp: new Map(),
  yesterdayUnfinished: [],
  specialSets: ['g7a-present', 'g7a-nouns'],
  vocab: [vocabBook('v1-u1', 30)],
  specialQuestions: new Map([
    ['g7a-present', specialQuestions('g7a-present', 12)],
    ['g7a-nouns', specialQuestions('g7a-nouns', 12)],
  ]),
  ...over,
})

const byType = (tasks: TaskRow[], type: string): TaskRow | undefined => tasks.find((t) => t.type === type)

describe('isStudyDay（周一起始的纯日期数学）', () => {
  it('默认 6 天：周一…周六学习', () => {
    expect(isStudyDay(MONDAY, 6)).toBe(true)
    expect(isStudyDay(SATURDAY, 6)).toBe(true)
  })
  it('默认 6 天：周日休息', () => {
    expect(isStudyDay(SUNDAY, 6)).toBe(false)
  })
  it('5 天：周一…周五学习、周六休息', () => {
    expect(isStudyDay('2026-11-20', 5)).toBe(true) // 周五
    expect(isStudyDay(SATURDAY, 5)).toBe(false)
  })
  it('7 天：每天都是学习日', () => {
    expect(isStudyDay(SUNDAY, 7)).toBe(true)
  })
})

describe('generatePlan：非学习日', () => {
  it('返回 []（今日页显示"今日休息"）', () => {
    expect(generatePlan(ctx({ isStudyDay: false }))).toEqual([])
  })
})

describe('generatePlan：时长分配（PLAN_RATIO 30/40/20/10）', () => {
  it('比例常量导出', () => {
    expect(PLAN_RATIO).toEqual({ review: 30, unit: 40, special: 20, summary: 10 })
  })

  it('总分钟 35 → review 10 / unit 14 / special 7 / summary 4', () => {
    const tasks = generatePlan(ctx({ reviewQuestions: ['due-1'] }))
    expect(byType(tasks, 'review')?.minutesPlanned).toBe(10)
    expect(byType(tasks, 'unit')?.minutesPlanned).toBe(14)
    expect(byType(tasks, 'special')?.minutesPlanned).toBe(7)
    expect(byType(tasks, 'summary')?.minutesPlanned).toBe(4)
  })

  it('各任务 minutesPlanned 之和恒等于 dailyMinutes（尾差归尾段）', () => {
    const tasks = generatePlan(ctx({ reviewQuestions: ['due-1'] }))
    expect(tasks.reduce((sum, t) => sum + t.minutesPlanned, 0)).toBe(35)
    // 无到期复习（份额并入 unit）时同样守恒
    const noReview = generatePlan(ctx())
    expect(noReview.reduce((sum, t) => sum + t.minutesPlanned, 0)).toBe(35)
  })
})

describe('generatePlan：review 任务', () => {
  it('questionIds = reviewQuestions（原样、不截断）', () => {
    const tasks = generatePlan(ctx({ reviewQuestions: ['due-1', 'due-2'] }))
    const review = byType(tasks, 'review')
    expect(review?.questionIds).toEqual(['due-1', 'due-2'])
  })

  it('reviewQuestions 为空 → 不生成 review 任务，份额并入 unit', () => {
    const tasks = generatePlan(ctx())
    expect(byType(tasks, 'review')).toBeUndefined()
    expect(byType(tasks, 'unit')?.minutesPlanned).toBe(24) // 14 + 10
    expect(byType(tasks, 'summary')?.minutesPlanned).toBe(4)
  })
})

describe('generatePlan：unit 任务（词汇默写）', () => {
  it('从当前 book/currentUnit 派生（deriveVocabQuestions 的稳定词题 ID）', () => {
    const tasks = generatePlan(ctx({ vocab: [vocabBook('v1-u1', 3)] }))
    expect(byType(tasks, 'unit')?.questionIds).toEqual(['g7a-vocab-u1-0001', 'g7a-vocab-u1-0002', 'g7a-vocab-u1-0003'])
  })

  it('题数按分钟预算 / 估计用时估取，上限 20（常量 UNIT_QUESTION_MAX）', () => {
    expect(UNIT_QUESTION_MAX).toBe(20)
    // 30 词 × 20s = 600s 预算可容纳 30 题以上 → 截到 20
    const tasks = generatePlan(ctx({ vocab: [vocabBook('v1-u1', 30)] }))
    expect(byType(tasks, 'unit')?.questionIds).toHaveLength(20)
    expect(byType(tasks, 'unit')?.questionIds[0]).toBe('g7a-vocab-u1-0001')
  })

  it('review 已占用的词题不再出现在 unit（去重）', () => {
    const tasks = generatePlan(ctx({
      reviewQuestions: ['g7a-vocab-u1-0001'],
      vocab: [vocabBook('v1-u1', 3)],
    }))
    expect(byType(tasks, 'unit')?.questionIds).toEqual(['g7a-vocab-u1-0002', 'g7a-vocab-u1-0003'])
  })

  it('currentUnit 无对应词汇 → 不生成 unit 任务，份额归尾段', () => {
    const tasks = generatePlan(ctx({ vocab: [], reviewQuestions: ['due-1'] }))
    expect(byType(tasks, 'unit')).toBeUndefined()
    expect(byType(tasks, 'review')?.minutesPlanned).toBe(10)
    expect(byType(tasks, 'special')?.minutesPlanned).toBe(7)
    expect(byType(tasks, 'summary')?.minutesPlanned).toBe(18) // 10% 尾余 + unit 40%
    expect(tasks.reduce((sum, t) => sum + t.minutesPlanned, 0)).toBe(35)
  })
})

describe('generatePlan：special 任务（薄弱专项巩固）', () => {
  it('从 wrongByKp 聚合各专项错误率，选最薄弱（错误率最高）的专项', () => {
    const nouns = specialQuestions('g7a-nouns', 12)
    const c = ctx({
      wrongByKp: new Map([
        ['kp.g7a-nouns', nouns.slice(0, 3).map((q) => q.id)], // 3/12 错
        ['kp.g7a-present', ['g7a-present-l1-0001']], // 1/12 错
      ]),
    })
    const tasks = generatePlan(c)
    const special = byType(tasks, 'special')
    expect(special?.questionIds.slice(0, 3)).toEqual(nouns.slice(0, 3).map((q) => q.id))
  })

  it('曾错题优先编入（巩固优先），其余按题序补足预算', () => {
    const present = specialQuestions('g7a-present', 12)
    const c = ctx({
      specialSets: ['g7a-present'], // 仅一个专项，直接被选中
      wrongByKp: new Map([['kp.g7a-present', [present[5]!.id, present[2]!.id]]]),
    })
    const special = byType(generatePlan(c), 'special')
    // 7 分钟预算 / 45s 估计用时 → 9 题；前 2 题是曾错题（保持题序），再补 7 道新题
    expect(special?.questionIds).toEqual([present[2]!.id, present[5]!.id, ...present.filter((q) => q !== present[2] && q !== present[5]).slice(0, 7).map((q) => q.id)])
    expect(special?.questionIds).toHaveLength(9)
  })

  it('题数上限 10（常量 SPECIAL_QUESTION_MAX）', () => {
    expect(SPECIAL_QUESTION_MAX).toBe(10)
    // 30s/题 × 12 题 = 360s < 420s 预算，预算不设限 → 截到上限 10
    const c = ctx({
      specialSets: ['g7a-present'],
      specialQuestions: new Map([['g7a-present', specialQuestions('g7a-present', 12, 30)]]),
    })
    expect(byType(generatePlan(c), 'special')?.questionIds).toHaveLength(10)
  })

  it('错误率并列时取 specialSets 顺序靠前的专项', () => {
    const present = specialQuestions('g7a-present', 4)
    const nouns = specialQuestions('g7a-nouns', 4)
    const c = ctx({
      wrongByKp: new Map([
        ['kp.g7a-present', [present[0]!.id]],
        ['kp.g7a-nouns', [nouns[0]!.id]],
      ]), // 两专项错误率同为 1/4
    })
    const special = byType(generatePlan(c), 'special')
    expect(special?.questionIds[0]).toBe(present[0]!.id)
  })

  it('无任何错题 → 选当前 book 第一个有题可练的专项', () => {
    // 默认 ctx（当前册 g7a）：specialSets 顺序首个 g7a 专项
    expect(byType(generatePlan(ctx()), 'special')?.questionIds[0]).toBe('g7a-present-l1-0001')
    // 当前册 g7b：specialSets 里 g7a 在前，仍应选 g7b 首个专项
    const c2 = ctx({
      settings: settings({ book: 'g7b', currentUnit: 'v2-u3' }),
      vocab: [vocabBook('v2-u3', 5)],
      specialSets: ['g7a-present', 'g7b-tenses'],
      specialQuestions: new Map([
        ['g7a-present', specialQuestions('g7a-present', 12)],
        ['g7b-tenses', specialQuestions('g7b-tenses', 12)],
      ]),
    })
    expect(byType(generatePlan(c2), 'special')?.questionIds[0]).toBe('g7b-tenses-l1-0001')
  })

  it('review 已占用的题不再进入 special（去重）', () => {
    const present = specialQuestions('g7a-present', 12)
    const c = ctx({
      specialSets: ['g7a-present'],
      reviewQuestions: [present[0]!.id, present[1]!.id],
      wrongByKp: new Map([['kp.g7a-present', [present[0]!.id, present[1]!.id]]]),
    })
    const special = byType(generatePlan(c), 'special')
    expect(special?.questionIds).not.toContain(present[0]!.id)
    expect(special?.questionIds).not.toContain(present[1]!.id)
  })

  it('无可用专项题 → 不生成 special 任务，份额归尾段', () => {
    const tasks = generatePlan(ctx({ specialSets: [], specialQuestions: new Map(), reviewQuestions: ['due-1'] }))
    expect(byType(tasks, 'special')).toBeUndefined()
    expect(byType(tasks, 'summary')?.minutesPlanned).toBe(11) // 10% 尾余 + special 20%
    expect(tasks.reduce((sum, t) => sum + t.minutesPlanned, 0)).toBe(35)
  })
})

describe('generatePlan：summary 任务', () => {
  it('questionIds 为空、minutesPlanned = 尾余', () => {
    const tasks = generatePlan(ctx({ reviewQuestions: ['due-1'] }))
    const summary = byType(tasks, 'summary')
    expect(summary?.questionIds).toEqual([])
    expect(summary?.minutesPlanned).toBe(4)
  })
})

describe('generatePlan：昨日结转', () => {
  const deferredUnit: TaskRow = {
    id: 'task-2026-11-16-unit',
    day: '2026-11-16',
    type: 'unit',
    questionIds: ['carry-1', 'carry-2'],
    status: 'deferred',
    minutesPlanned: 14,
  }
  const skippedSpecial: TaskRow = {
    id: 'task-2026-11-16-special',
    day: '2026-11-16',
    type: 'special',
    questionIds: ['skip-1'],
    status: 'skipped',
    minutesPlanned: 7,
  }

  it('deferred → 映射为今日 review 类任务（questionIds 保留、优先编入复习段）', () => {
    const tasks = generatePlan(ctx({
      reviewQuestions: ['due-1'],
      yesterdayUnfinished: [deferredUnit, skippedSpecial],
    }))
    const review = byType(tasks, 'review')
    expect(review?.questionIds).toEqual(['carry-1', 'carry-2', 'due-1'])
    expect(review?.minutesPlanned).toBe(10)
  })

  it('skipped 不结转（其题不进入今日任何任务）', () => {
    const tasks = generatePlan(ctx({ yesterdayUnfinished: [skippedSpecial, deferredUnit] }))
    for (const t of tasks) expect(t.questionIds).not.toContain('skip-1')
  })

  it('仅有结转、无到期复测 → 仍生成 review 任务承载结转题', () => {
    const tasks = generatePlan(ctx({ yesterdayUnfinished: [deferredUnit] }))
    const review = byType(tasks, 'review')
    expect(review?.questionIds).toEqual(['carry-1', 'carry-2'])
    expect(byType(tasks, 'unit')?.minutesPlanned).toBe(14)
  })
})

describe('generatePlan：任务行形状', () => {
  it('id 稳定 task-<day>-<type>、status planned、day 回填、type 齐全', () => {
    const tasks = generatePlan(ctx({ day: TUESDAY, reviewQuestions: ['due-1'] }))
    expect(tasks.map((t) => t.id)).toEqual([
      'task-2026-11-17-review',
      'task-2026-11-17-unit',
      'task-2026-11-17-special',
      'task-2026-11-17-summary',
    ])
    for (const t of tasks) {
      expect(t.day).toBe(TUESDAY)
      expect(t.status).toBe('planned')
    }
  })

  it('同一 questionId 不得出现在两个任务', () => {
    const present = specialQuestions('g7a-present', 12)
    const tasks = generatePlan(ctx({
      reviewQuestions: ['g7a-vocab-u1-0001', present[3]!.id],
      wrongByKp: new Map([['kp.g7a-present', present.slice(0, 4).map((q) => q.id)]]),
      vocab: [vocabBook('v1-u1', 30)],
    }))
    const seen = new Set<string>()
    for (const t of tasks) {
      for (const id of t.questionIds) {
        expect(seen.has(id), `题目 ${id} 重复出现在任务 ${t.id}`).toBe(false)
        seen.add(id)
      }
    }
  })
})

/** 任务行 fixture：id/day/type/questionIds/status 一次成型 */
const taskRow = (day: string, type: TaskRow['type'], status: TaskRow['status'], ids: string[]): TaskRow => ({
  id: `task-${day}-${type}`,
  day,
  type,
  questionIds: ids,
  status,
  minutesPlanned: 10,
})

describe('carryWindowStart（回溯窗口起点，含当日 14 天前）', () => {
  it('常量 14 天；起点 = todayKey - 14（跨月正确）', () => {
    expect(CARRY_LOOKBACK_DAYS).toBe(14)
    expect(carryWindowStart('2026-11-17')).toBe('2026-11-03')
    expect(carryWindowStart('2026-03-05')).toBe('2026-02-19') // 2 月 28 天，跨月
  })
})

describe('pickCarrySource（结转回溯：窗口内最近有任务日的 deferred）', () => {
  it('最近有任务日的 deferred 结转（中间隔无任务日也取得到）', () => {
    const rows = [taskRow('2026-11-14', 'unit', 'deferred', ['a']), taskRow('2026-11-16', 'special', 'deferred', ['b'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.questionIds)).toEqual([['b']])
  })

  it('最近有任务日无 deferred → 不看更早日子（其 deferred 已被更近一次计划生成消费）', () => {
    const rows = [taskRow('2026-11-14', 'unit', 'deferred', ['a']), taskRow('2026-11-16', 'special', 'skipped', ['b'])]
    expect(pickCarrySource(rows, '2026-11-17')).toEqual([])
  })

  it('同日 deferred/skipped 混合只取 deferred', () => {
    const rows = [taskRow('2026-11-16', 'special', 'skipped', ['s']), taskRow('2026-11-16', 'unit', 'deferred', ['d'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.type)).toEqual(['unit'])
  })

  it('空窗口 / 全部早于窗口起点 → 返回空', () => {
    expect(pickCarrySource([], '2026-11-17')).toEqual([])
    expect(pickCarrySource([taskRow('2026-10-01', 'unit', 'deferred', ['a'])], '2026-11-17')).toEqual([])
  })

  it('当日行不参与结转（day 严格小于 todayKey）', () => {
    expect(pickCarrySource([taskRow('2026-11-17', 'unit', 'deferred', ['today-1'])], '2026-11-17')).toEqual([])
  })

  it('窗口含恰 14 天前的行、不含 15 天前', () => {
    const rows = [taskRow('2026-11-02', 'unit', 'deferred', ['out']), taskRow('2026-11-03', 'unit', 'deferred', ['in'])]
    expect(pickCarrySource(rows, '2026-11-17').map((t) => t.questionIds)).toEqual([['in']])
  })
})
