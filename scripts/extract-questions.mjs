#!/usr/bin/env node
/* 题库转换（可重复、幂等）：七上/七下各四专项 data.js + 两册词汇
   g7a-{present,nouns,numbers,articles} + g7b-{adjadv,nouns,pronouns-modals,tenses}/data.js
   + typing/data/v1.js（七上）/ v2.js（七下）
   → app-src/public/content/g7a/{questions,vocab,content}.json
   （输出目录名沿用 g7a 不改，避免 fetch 路径与部署入口变化） */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'app-src/public/content/g7a')
export const CONTENT_VERSION = '2026-11-19.1'

/** 目录映射：book → 专项目录与词汇数据文件（词汇 unit id 前缀沿用源数据的 v1- 与 v2-） */
const BOOKS = [
  {
    book: 'g7a',
    term: 'A',
    specials: [
      { dir: 'g7a-present', key: 'G7A_PRESENT', id: 'g7a-present', kpPrefix: 'grammar.present_simple' },
      { dir: 'g7a-nouns', key: 'G7A_NOUNS', id: 'g7a-nouns', kpPrefix: 'grammar.noun' },
      { dir: 'g7a-numbers', key: 'G7A_NUMBERS', id: 'g7a-numbers', kpPrefix: 'grammar.number_prep' },
      { dir: 'g7a-articles', key: 'G7A_ARTICLES', id: 'g7a-articles', kpPrefix: 'grammar.article_pronoun' },
    ],
    vocabFile: 'typing/data/v1.js',
  },
  {
    book: 'g7b',
    term: 'B',
    specials: [
      { dir: 'g7b-adjadv', key: 'G7B_ADJADV', id: 'g7b-adjadv', kpPrefix: 'grammar.adj_adv' },
      { dir: 'g7b-nouns', key: 'G7B_NOUNS', id: 'g7b-nouns', kpPrefix: 'grammar.noun' },
      { dir: 'g7b-pronouns-modals', key: 'G7B_PRONOUNS', id: 'g7b-pronouns-modals', kpPrefix: 'grammar.pronoun_modals' },
      { dir: 'g7b-tenses', key: 'G7B_TENSES', id: 'g7b-tenses', kpPrefix: 'grammar.tense' },
    ],
    vocabFile: 'typing/data/v2.js',
  },
]

/** 专项内级别（1–6）→ 知识点短名；slug 命名保持稳定可复现 */
const LEVEL_SLUGS = {
  'g7a-present': ['meaning', 'be', 'third-person', 'negation-question', 'statement', 'mixed'],
  'g7a-nouns': ['categories', 'countability', 'possessive-form', 'possessive-sound', 'word-class', 'mixed'],
  'g7a-numbers': ['cardinal', 'ordinal', 'time-prep', 'place-prep', 'collocation', 'mixed'],
  'g7a-articles': ['the', 'a-an', 'zero-article', 'personal-pronoun', 'possessive-demo', 'mixed'],
  'g7b-adjadv': ['attributive', 'predicative-complement', 'adverb-use', 'frequency-order', 'frequency-position', 'mixed'],
  'g7b-nouns': ['countability', 'plural-rules', 'plural-sound', 'plural-irregular', 'dual-purpose', 'mixed'],
  'g7b-pronouns-modals': ['possessive-form', 'possessive-contrast', 'can-could', 'may', 'must-have-to', 'mixed'],
  'g7b-tenses': ['progressive-form', 'ing-change', 'progressive-use', 'past-form', 'past-negation', 'mixed'],
}

/** 确定性伪随机（mulberry32）：种子来自题目 ID 的 sha256，保证提取幂等 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 选项顺序洗牌：源题库把正确选项固定排在首位（88% answer=0，学生易学会"选 A"）。
 *  以题目 ID 为种子做确定性 Fisher-Yates 并同步映射 correctOptionIndex；
 *  语义不变（正确选项文本与选项集合不变），输出稳定（幂等），题库增改自动生效。 */
export function shuffleOptions(questionId, options, answer) {
  const seed = parseInt(createHash('sha256').update(questionId).digest('hex').slice(0, 8), 16)
  const rand = mulberry32(seed)
  const order = options.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return { options: order.map((i) => options[i]), answer: order.indexOf(answer) }
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

/** 知识点 ID 消歧（幂等）：册内多题共享同一知识点属正常（直接复用）；
   与前册已登记 ID 冲突时后一册（g7b）追加 `.g7b` 后缀（如 grammar.noun.countability.g7b），
   未冲突的 g7b 知识点保持原名。先处理的 g7a 与 M1 产物保持一致。 */
function disambiguateKp(baseKpId, book, priorKp, ownKp) {
  if (ownKp.has(baseKpId)) return baseKpId
  const suffixed = `${baseKpId}.${book}`
  if (ownKp.has(suffixed)) return suffixed
  if (priorKp.has(suffixed)) throw new Error(`知识点 ID 冲突无法消歧：${suffixed}`)
  const id = priorKp.has(baseKpId) ? suffixed : baseKpId
  ownKp.add(id)
  return id
}

function toQuestion(bk, sp, raw, priorKp, ownKp) {
  if (!raw.stem || !Array.isArray(raw.options) || !raw.explain) {
    throw new Error(`${sp.id} 题目 ${raw.id} 缺少 stem/options/explain`)
  }
  const level = raw.level
  const idMatch = /^([A-Z])(\d+)-(\d+)$/.exec(String(raw.id))
  if (!idMatch) throw new Error(`非法题目原始 ID：${raw.id}`)
  if (Number(idMatch[2]) !== level) {
    throw new Error(`${sp.id} 题目 ${raw.id} 的级别与 level=${level} 不一致`)
  }
  const slug = LEVEL_SLUGS[sp.id][level - 1]
  if (!slug) throw new Error(`${sp.id} 缺少级别 ${level} 的知识点映射`)
  const shuffled = shuffleOptions(toQuestionId(sp.id, raw.id), raw.options, raw.answer)
  return {
    id: toQuestionId(sp.id, raw.id),
    contentVersion: CONTENT_VERSION,
    grade: 7,
    term: bk.term,
    unit: `${sp.id}-l${level}`,
    sourceUrl: `${sp.dir}/`,
    knowledgePointIds: [disambiguateKp(`${sp.kpPrefix}.${slug}`, bk.book, priorKp, ownKp)],
    type: 'single_choice',
    stem: raw.stem,
    options: shuffled.options,
    answerSpec: { correctOptionIndex: shuffled.answer },
    explanation: raw.explain,
    difficulty: level,
    estimatedSeconds: 45,
  }
}

function extractQuestions() {
  const questions = []
  const usedKp = new Set()
  for (const bk of BOOKS) {
    const priorKp = new Set(usedKp) // 此前各册已登记的知识点
    const ownKp = new Set()
    for (const sp of bk.specials) {
      const data = loadSpecialData(path.join(sp.dir, 'data.js'), sp.key)
      for (const raw of data.questions) questions.push(toQuestion(bk, sp, raw, priorKp, ownKp))
    }
    for (const kp of ownKp) usedKp.add(kp)
  }
  return questions
}

function extractVocab() {
  return BOOKS.map((bk) => {
    const vol = loadSpecialData(bk.vocabFile, 'TYPING_VOL')
    return {
      book: bk.book,
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
  })
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
  const books = BOOKS.map((bk) => ({
    book: bk.book,
    questionCount: questions.filter((q) => q.term === bk.term).length,
    vocabUnits: vocab.find((b) => b.book === bk.book)?.units.length ?? 0,
    vocabWordCount:
      vocab.find((b) => b.book === bk.book)?.units.reduce((n, u) => n + u.words.length, 0) ?? 0,
  }))
  const content = {
    contentId: 'g7a',
    version: CONTENT_VERSION,
    questionCount: questions.length,
    vocabWordCount: vocab.reduce((n, b) => n + b.units.reduce((m, u) => m + u.words.length, 0), 0),
    books,
    files: [
      { name: 'questions.json', sha256: sha256(questionsJson), count: questions.length },
      { name: 'vocab.json', sha256: sha256(vocabJson), count: vocab.reduce((n, b) => n + b.units.length, 0) },
    ],
  }
  return { questions, questionsJson, vocab, vocabJson, content }
}

function main() {
  const { questions, questionsJson, vocabJson, content } = extractAll()
  const knowledgePointCount = new Set(questions.flatMap((q) => q.knowledgePointIds)).size
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'questions.json'), questionsJson)
  fs.writeFileSync(path.join(OUT_DIR, 'vocab.json'), vocabJson)
  fs.writeFileSync(path.join(OUT_DIR, 'content.json'), JSON.stringify(content, null, 2) + '\n')
  console.log(
    `已生成 ${content.questionCount} 道选择题（七上 ${content.books[0].questionCount} / 七下 ${content.books[1].questionCount}）、` +
      `${content.vocabWordCount} 个单词（两册）、${knowledgePointCount} 个知识点 → ${path.relative(ROOT, OUT_DIR)}/`,
  )
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) main()
