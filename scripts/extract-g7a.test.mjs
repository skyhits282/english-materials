import test from 'node:test'
import assert from 'node:assert/strict'
import { extractAll, toQuestionId, CONTENT_VERSION } from './extract-g7a.mjs'

test('七上四专项共 192 道选择题，字段齐全', () => {
  const { questions } = extractAll()
  assert.equal(questions.length, 192)
  for (const q of questions) {
    assert.equal(q.type, 'single_choice')
    assert.ok(q.id && q.contentVersion === CONTENT_VERSION)
    assert.equal(q.grade, 7)
    assert.equal(q.term, 'A')
    assert.ok(q.unit && q.sourceUrl)
    assert.ok(Array.isArray(q.knowledgePointIds) && q.knowledgePointIds.length === 1)
    assert.ok(q.stem && Array.isArray(q.options) && q.options.length === 4)
    assert.equal(typeof q.answerSpec.correctOptionIndex, 'number')
    assert.ok(q.answerSpec.correctOptionIndex >= 0 && q.answerSpec.correctOptionIndex < 4)
    assert.ok(q.explanation)
    assert.ok(q.difficulty >= 1 && q.difficulty <= 6)
    assert.equal(q.estimatedSeconds, 45)
  }
})

test('题目 ID 稳定且唯一', () => {
  const { questions } = extractAll()
  const ids = new Set(questions.map((q) => q.id))
  assert.equal(ids.size, 192)
  assert.equal(toQuestionId('g7a-present', 'P1-1'), 'g7a-present-l1-0001')
  assert.equal(toQuestionId('g7a-articles', 'A6-8'), 'g7a-articles-l6-0008')
})

test('七上词汇 10 单元 184 词', () => {
  const { vocab } = extractAll()
  assert.equal(vocab.units.length, 10)
  assert.equal(vocab.units.reduce((n, u) => n + u.words.length, 0), 184)
  for (const u of vocab.units) {
    for (const w of u.words) {
      assert.ok(w.id && w.word && w.meaning && w.pos)
      assert.equal(typeof w.variant, 'string')
    }
  }
})

test('转换幂等：两次提取结果完全一致', () => {
  assert.deepEqual(extractAll(), extractAll())
})

test('content.json 元数据与题数一致', () => {
  const { content } = extractAll()
  assert.equal(content.contentId, 'g7a')
  assert.equal(content.version, CONTENT_VERSION)
  assert.equal(content.questionCount, 192)
  assert.equal(content.vocabWordCount, 184)
  for (const f of content.files) {
    assert.ok(f.name && f.sha256.length === 64 && f.count > 0)
  }
})