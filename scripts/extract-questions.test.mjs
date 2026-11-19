import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractAll, toQuestionId, CONTENT_VERSION } from './extract-questions.mjs'

const SPECIAL_COUNTS = {
  'g7a-present': 48,
  'g7a-nouns': 48,
  'g7a-numbers': 48,
  'g7a-articles': 48,
  'g7b-adjadv': 48,
  'g7b-nouns': 48,
  'g7b-pronouns-modals': 48,
  'g7b-tenses': 48,
}

test('七上/七下各四专项共 384 道选择题，字段齐全', () => {
  const { questions } = extractAll()
  assert.equal(questions.length, 384)
  const bySpecial = {}
  for (const q of questions) {
    assert.equal(q.type, 'single_choice')
    assert.ok(q.id && q.contentVersion === CONTENT_VERSION)
    assert.equal(q.grade, 7)
    assert.ok(['A', 'B'].includes(q.term))
    assert.ok(q.unit && q.sourceUrl)
    assert.ok(Array.isArray(q.knowledgePointIds) && q.knowledgePointIds.length === 1)
    assert.ok(q.stem && Array.isArray(q.options) && q.options.length === 4)
    assert.equal(typeof q.answerSpec.correctOptionIndex, 'number')
    assert.ok(q.answerSpec.correctOptionIndex >= 0 && q.answerSpec.correctOptionIndex < 4)
    assert.ok(q.explanation)
    assert.ok(q.difficulty >= 1 && q.difficulty <= 6)
    assert.equal(q.estimatedSeconds, 45)
    const special = q.unit.replace(/-l\d$/, '')
    bySpecial[special] = (bySpecial[special] ?? 0) + 1
    // term 与专项前缀一致（g7a-* → A，g7b-* → B）
    assert.equal(q.term, special.startsWith('g7a-') ? 'A' : 'B')
  }
  assert.deepEqual(bySpecial, SPECIAL_COUNTS)
})

test('题目 ID 稳定且唯一', () => {
  const { questions } = extractAll()
  const ids = new Set(questions.map((q) => q.id))
  assert.equal(ids.size, 384)
  assert.equal(toQuestionId('g7a-present', 'P1-1'), 'g7a-present-l1-0001')
  assert.equal(toQuestionId('g7a-articles', 'A6-8'), 'g7a-articles-l6-0008')
  assert.equal(toQuestionId('g7b-adjadv', 'R1-1'), 'g7b-adjadv-l1-0001')
  assert.equal(toQuestionId('g7b-tenses', 'T6-48'), 'g7b-tenses-l6-0048')
  assert.throws(() => toQuestionId('g7a-present', 'P0-1'))
  assert.throws(() => toQuestionId('g7a-present', 'P7-1'))
  assert.throws(() => toQuestionId('g7a-present', 'p1-1'))
  assert.throws(() => toQuestionId('g7a-present', ''))
})

test('知识点 ID：跨册冲突加 .g7b 后缀，未冲突保持原名', () => {
  const { questions } = extractAll()
  const byId = new Map(questions.map((q) => [q.id, q]))
  // 两册名词专项共享 countability 与 mixed 两个知识点 → 七下侧加 .g7b 消歧
  assert.deepEqual(byId.get('g7b-nouns-l1-0001').knowledgePointIds, ['grammar.noun.countability.g7b'])
  assert.deepEqual(byId.get('g7b-nouns-l6-0001').knowledgePointIds, ['grammar.noun.mixed.g7b'])
  // 未冲突的七下知识点保持原名；七上知识点与 M1 产物一致
  assert.deepEqual(byId.get('g7b-nouns-l2-0001').knowledgePointIds, ['grammar.noun.plural-rules'])
  assert.deepEqual(byId.get('g7a-nouns-l1-0001').knowledgePointIds, ['grammar.noun.categories'])
  // 全量知识点无重复登记异常且消歧幂等（见下方幂等测试）
  const kps = questions.flatMap((q) => q.knowledgePointIds)
  assert.ok(kps.every((k) => k.endsWith('.g7b') || !k.endsWith('.g7a')))
})

test('两册词汇：七上 10 单元 184 词、七下 8 单元 286 词', () => {
  const { vocab } = extractAll()
  assert.equal(vocab.length, 2)
  const [g7a, g7b] = vocab
  assert.equal(g7a.book, 'g7a')
  assert.equal(g7a.units.length, 10)
  assert.equal(g7a.units.reduce((n, u) => n + u.words.length, 0), 184)
  assert.ok(g7a.units.every((u) => u.id.startsWith('v1-')))
  assert.equal(g7b.book, 'g7b')
  assert.equal(g7b.units.length, 8)
  assert.equal(g7b.units.reduce((n, u) => n + u.words.length, 0), 286)
  assert.ok(g7b.units.every((u) => u.id.startsWith('v2-')))
  for (const book of vocab) {
    assert.equal(book.contentVersion, CONTENT_VERSION)
    for (const u of book.units) {
      for (const w of u.words) {
        assert.ok(w.id && w.word && w.meaning && w.pos)
        assert.equal(typeof w.variant, 'string')
      }
    }
  }
})

test('转换幂等：两次提取结果完全一致', () => {
  assert.deepEqual(extractAll(), extractAll())
})

test('content.json 元数据与题数一致（含分册统计）', () => {
  const { content } = extractAll()
  assert.equal(content.contentId, 'g7a')
  assert.equal(content.version, CONTENT_VERSION)
  assert.equal(content.questionCount, 384)
  assert.equal(content.vocabWordCount, 470)
  assert.deepEqual(content.books, [
    { book: 'g7a', questionCount: 192, vocabUnits: 10, vocabWordCount: 184 },
    { book: 'g7b', questionCount: 192, vocabUnits: 8, vocabWordCount: 286 },
  ])
  for (const f of content.files) {
    assert.ok(f.name && f.sha256.length === 64 && f.count > 0)
  }
})

/** 源 data.js 原始题目（对照洗牌语义用）：与 extract-questions.mjs 的 BOOKS 专项一致 */
const RAW_SPECIALS = [
  { dir: 'g7a-present', key: 'G7A_PRESENT', id: 'g7a-present' },
  { dir: 'g7a-nouns', key: 'G7A_NOUNS', id: 'g7a-nouns' },
  { dir: 'g7a-numbers', key: 'G7A_NUMBERS', id: 'g7a-numbers' },
  { dir: 'g7a-articles', key: 'G7A_ARTICLES', id: 'g7a-articles' },
  { dir: 'g7b-adjadv', key: 'G7B_ADJADV', id: 'g7b-adjadv' },
  { dir: 'g7b-nouns', key: 'G7B_NOUNS', id: 'g7b-nouns' },
  { dir: 'g7b-pronouns-modals', key: 'G7B_PRONOUNS', id: 'g7b-pronouns-modals' },
  { dir: 'g7b-tenses', key: 'G7B_TENSES', id: 'g7b-tenses' },
]

function loadRawQuestions() {
  const raws = []
  for (const sp of RAW_SPECIALS) {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', sp.dir, 'data.js'), 'utf8')
    const sandbox = {}
    new Function('window', src)(sandbox)
    for (const raw of sandbox[sp.key].questions) raws.push({ special: sp.id, raw })
  }
  return raws
}

test('选项洗牌语义保持：选项集合不变，正确选项文本不变', () => {
  const { questions } = extractAll()
  const byId = new Map(questions.map((q) => [q.id, q]))
  for (const { special, raw } of loadRawQuestions()) {
    const q = byId.get(toQuestionId(special, raw.id))
    assert.ok(q, `缺少题目 ${raw.id}`)
    assert.deepEqual([...q.options].sort(), [...raw.options].sort())
    assert.equal(q.options[q.answerSpec.correctOptionIndex], raw.options[raw.answer])
  }
})

test('选项洗牌分布：正确答案不再扎堆 A（每个索引都出现且单索引 < 40%）', () => {
  const { questions } = extractAll()
  const dist = [0, 0, 0, 0]
  for (const q of questions) dist[q.answerSpec.correctOptionIndex] += 1
  assert.ok(dist.every((n) => n > 20), `正确选项分布过偏：${dist.join('/')}`)
  assert.ok(Math.max(...dist) < 154, `单索引占比超过 40%：${dist.join('/')}`)
})

test('已提交产物与提取结果逐字节一致（防漂移）', () => {
  const { questionsJson, vocabJson, content } = extractAll()
  const outDir = path.resolve(import.meta.dirname, '../app-src/public/content/g7a')
  const committed = {
    'questions.json': fs.readFileSync(path.join(outDir, 'questions.json'), 'utf8'),
    'vocab.json': fs.readFileSync(path.join(outDir, 'vocab.json'), 'utf8'),
    'content.json': fs.readFileSync(path.join(outDir, 'content.json'), 'utf8'),
  }
  assert.equal(committed['questions.json'], questionsJson)
  assert.equal(committed['vocab.json'], vocabJson)
  assert.equal(committed['content.json'], JSON.stringify(content, null, 2) + '\n')
  for (const f of content.files) {
    const actual = createHash('sha256').update(committed[f.name]).digest('hex')
    assert.equal(f.sha256, actual)
  }
})
