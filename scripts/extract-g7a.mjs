#!/usr/bin/env node
/* 七上题库转换（可重复、幂等）：
   g7a-{present,nouns,numbers,articles}/data.js + typing/data/v1.js
   → app-src/public/content/g7a/{questions,vocab,content}.json */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'app-src/public/content/g7a')
export const CONTENT_VERSION = '2026-11-16'

const SPECIALS = [
  { dir: 'g7a-present', key: 'G7A_PRESENT', id: 'g7a-present', title: '一般现在时与句子种类', kpPrefix: 'grammar.present_simple' },
  { dir: 'g7a-nouns', key: 'G7A_NOUNS', id: 'g7a-nouns', title: '名词与所有格', kpPrefix: 'grammar.noun' },
  { dir: 'g7a-numbers', key: 'G7A_NUMBERS', id: 'g7a-numbers', title: '数词与介词', kpPrefix: 'grammar.number_prep' },
  { dir: 'g7a-articles', key: 'G7A_ARTICLES', id: 'g7a-articles', title: '冠词与代词', kpPrefix: 'grammar.article_pronoun' },
]

const LEVEL_SLUGS = {
  'g7a-present': ['meaning', 'be', 'third-person', 'negation-question', 'statement', 'mixed'],
  'g7a-nouns': ['categories', 'countability', 'possessive-form', 'possessive-sound', 'word-class', 'mixed'],
  'g7a-numbers': ['cardinal', 'ordinal', 'time-prep', 'place-prep', 'collocation', 'mixed'],
  'g7a-articles': ['the', 'a-an', 'zero-article', 'personal-pronoun', 'possessive-demo', 'mixed'],
}

/** "P1-1"（字母+级别-序号）→ g7a-present-l1-0001；级别取自原始 ID 内的数字 */
export function toQuestionId(specialId, rawId) {
  const m = /^([A-Z])(\d+)-(\d+)$/.exec(String(rawId))
  if (!m) throw new Error(`非法题目原始 ID：${rawId}`)
  const level = Number(m[2])
  const seq = Number(m[3])
  if (level < 1 || level > 6 || seq < 1) throw new Error(`非法题目原始 ID：${rawId}`)
  return `${specialId}-l${level}-${String(seq).padStart(4, '0')}`
}

/** 以模块方式求值原站 data.js，返回挂到 window 上的数据对象 */
function loadSpecialData(relPath, key) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const sandbox = {}
  new Function('window', src)(sandbox)
  if (!sandbox[key]) throw new Error(`${relPath} 未见 window.${key}`)
  return sandbox[key]
}

function toQuestion(sp, raw) {
  const level = raw.level
  const slug = LEVEL_SLUGS[sp.id][level - 1]
  if (!slug) throw new Error(`${sp.id} 缺少级别 ${level} 的知识点映射`)
  return {
    id: toQuestionId(sp.id, raw.id),
    contentVersion: CONTENT_VERSION,
    grade: 7,
    term: 'A',
    unit: `${sp.id}-l${level}`,
    sourceUrl: `${sp.dir}/`,
    knowledgePointIds: [`${sp.kpPrefix}.${slug}`],
    type: 'single_choice',
    stem: raw.stem,
    options: raw.options,
    answerSpec: { correctOptionIndex: raw.answer },
    explanation: raw.explain,
    difficulty: level,
    estimatedSeconds: 45,
  }
}

function extractQuestions() {
  const questions = []
  for (const sp of SPECIALS) {
    const data = loadSpecialData(path.join(sp.dir, 'data.js'), sp.key)
    for (const raw of data.questions) questions.push(toQuestion(sp, raw))
  }
  return questions
}

function extractVocab() {
  const vol = loadSpecialData('typing/data/v1.js', 'TYPING_VOL')
  return {
    book: 'g7a',
    contentVersion: CONTENT_VERSION,
    units: vol.units.map((u) => ({
      id: u.id,
      order: u.order,
      label: u.label,
      words: u.words.map((w) => ({
        id: w.id,
        no: w.no,
        word: w.word,
        variant: w.variant || '',
        pos: w.pos,
        ipa: w.ipa,
        meaning: w.meaning,
      })),
    })),
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 全量提取（纯函数，不写文件）；键序固定保证输出稳定 */
export function extractAll() {
  const questions = extractQuestions()
  const vocab = extractVocab()
  const questionsJson = JSON.stringify(questions, null, 2) + '\n'
  const vocabJson = JSON.stringify(vocab, null, 2) + '\n'
  const content = {
    contentId: 'g7a',
    version: CONTENT_VERSION,
    questionCount: questions.length,
    vocabWordCount: vocab.units.reduce((n, u) => n + u.words.length, 0),
    files: [
      { name: 'questions.json', sha256: sha256(questionsJson), count: questions.length },
      { name: 'vocab.json', sha256: sha256(vocabJson), count: vocab.units.length },
    ],
  }
  return { questions, questionsJson, vocab, vocabJson, content }
}

function main() {
  const { questionsJson, vocabJson, content } = extractAll()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'questions.json'), questionsJson)
  fs.writeFileSync(path.join(OUT_DIR, 'vocab.json'), vocabJson)
  fs.writeFileSync(path.join(OUT_DIR, 'content.json'), JSON.stringify(content, null, 2) + '\n')
  console.log(`已生成 ${content.questionCount} 道选择题、${content.vocabWordCount} 个单词 → ${path.relative(ROOT, OUT_DIR)}/`)
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) main()