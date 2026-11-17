# M0+M1 本地核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有静态英语资料站增量开发学习助手 PWA 的本地核心：可重复的七上题库转换脚本 + Vite/TypeScript 应用（做题、判分、答题日志、错题列表、报告、设置、备份），数据存 IndexedDB。

**Architecture:** 转换脚本（根 `scripts/`，Node 原生）产出标准题库 JSON → `app-src/public/content/g7a/`；Vite + TypeScript 原生（无框架）应用构建到仓库根 `app/`（GitHub Pages 从 main 分支发布，产物需提交）；Dexie.js 管理 IndexedDB；判分/会话/指标/备份均为纯逻辑模块 + Vitest 单测。

**Tech Stack:** Node 22（`node:test`）、Vite 5、TypeScript 5.6（strict）、Dexie 4、Vitest 2、fake-indexeddb。

**规格：** `docs/superpowers/specs/2026-11-16-m0-m1-local-core-design.md`。除特别说明，所有命令在仓库根 `/data/svn/learn/english-materials` 执行。

**已核实的事实（写代码时直接依赖）：**

- 四个专项 `data.js`（`g7a-present/nouns/numbers/articles`）格式一致：IIFE 求值出 `window.<KEY>`，含 `levels`（6 个）与 `questions`（48 个：`{id:"P1-1", level, stem, options[4], answer, explain}`），共 192 题。
- `typing/data/v1.js` 求值出 `window.TYPING_VOL`：`{units:[{id:"v1-u1", order, label:"Starter Unit 1", words:[{id,no,word,variant,ipa,pos,meaning,...}]}]}`，10 单元 184 词，`variant` 可为空串（如 `centre`/`center`）。
- GitHub Pages 从 main 分支仓库根发布（无 gh-pages 分支），故 `app/` 构建产物需提交入库。
- CI（`.github/workflows/ci.yml`）用 find 扫描全仓 HTML，只排除 `./node_modules`、`./.git`、`./artifacts`；`scripts/check_site.py` 的 `SKIP_DIRS` 按目录名跳过（任意深度的 `node_modules` 都跳过）。
- 根 `.gitignore` 的 `node_modules/` 匹配任意深度；`app/` 未被忽略（正确，需入库）。

---

### Task 1: 题库转换脚本（M0 / DEV-01、DEV-04 的内容部分）

**Files:**
- Create: `scripts/extract-g7a.mjs`
- Create: `scripts/extract-g7a.test.mjs`
- Generate: `app-src/public/content/g7a/questions.json`、`vocab.json`、`content.json`
- Modify: `package.json`（scripts）

- [ ] **Step 1: 写失败测试**

创建 `scripts/extract-g7a.test.mjs`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/`
Expected: FAIL，报错 `Cannot find module .../extract-g7a.mjs`

- [ ] **Step 3: 实现转换脚本**

创建 `scripts/extract-g7a.mjs`：

```js
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
```

继续 `scripts/extract-g7a.mjs`（接在 `toQuestionId` 之后）：

```js
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
  console.log(`已生成 ${questions.length} 道选择题、${content.vocabWordCount} 个单词 → ${path.relative(ROOT, OUT_DIR)}/`)
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) main()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test scripts/`
Expected: 5 个测试全 PASS（`# pass 5`）

- [ ] **Step 5: 生成内容文件并验证幂等**

Run: `node scripts/extract-g7a.mjs && sha256sum app-src/public/content/g7a/*.json && node scripts/extract-g7a.mjs && sha256sum app-src/public/content/g7a/*.json`
Expected: 两次 sha256 完全一致；questions.json 192 题、vocab.json 184 词
再抽查: `node -e "const q=require('./app-src/public/content/g7a/questions.json');console.log(q[0])"` 输出含 `"id": "g7a-present-l1-0001"`、`"correctOptionIndex": 3`（P1-1 答案是 3）

- [ ] **Step 6: 根 package.json 增加脚本**

`package.json` 的 `scripts` 增加（保留原有两项）：

```json
{
  "scripts": {
    "htmlvalidate": "html-validate \"**/*.html\"",
    "lighthouse": "lhci autorun",
    "extract:g7a": "node scripts/extract-g7a.mjs",
    "test:extract": "node --test scripts/"
  }
}
```

- [ ] **Step 7: 提交**

```bash
git add scripts/extract-g7a.mjs scripts/extract-g7a.test.mjs app-src/public/content/g7a package.json
git commit -m "feat(app): 七上题库转换脚本，产出 192 道选择题与 184 词词汇 JSON

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: app-src 脚手架（DEV-02）

**Files:**
- Create: `app-src/package.json`、`app-src/tsconfig.json`、`app-src/vite.config.ts`、`app-src/index.html`、`app-src/src/style.css`、`app-src/src/main.ts`、`app-src/src/router.ts`、`app-src/src/pages/{today,exercise,mistakes,report,settings}.ts`
- Modify: `package.json`（代理脚本）

- [ ] **Step 1: 创建 `app-src/package.json` 并安装依赖**

```json
{
  "name": "english-coach-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "preview": "vite preview"
  },
  "devDependencies": {
    "dexie": "^4.0.8",
    "fake-indexeddb": "^6.0.0",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

Run: `npm --prefix app-src install`
Expected: 依赖安装成功（warnings 可忽略）

- [ ] **Step 2: 创建 `app-src/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: 创建 `app-src/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/english-materials/app/',
  build: { outDir: '../app', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 4: 创建 `app-src/index.html`**

check_site.py 要求 lang/title/description/viewport/h1，全部满足：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>英语学习助手</title>
  <meta name="description" content="初中英语学习助手：今日练习、判分解析、错题本与学习报告，本地保存学习记录。">
  <meta name="theme-color" content="#1a56a0">
  <link rel="stylesheet" href="./src/style.css">
</head>
<body>
  <main id="app">
    <h1>英语学习助手</h1>
    <p>加载中…</p>
  </main>
  <nav id="tabbar" aria-label="主导航">
    <a href="#/today">今日</a>
    <a href="#/mistakes">错题</a>
    <a href="#/report">报告</a>
    <a href="#/settings">设置</a>
  </nav>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 5: 创建 `app-src/src/style.css`（一次写全，后续页面共用）**

```css
:root {
  --bg: #f4f6fa;
  --card: #ffffff;
  --ink: #1f2933;
  --muted: #6b7280;
  --brand: #1a56a0;
  --ok: #177245;
  --ok-bg: #e6f4ea;
  --bad: #b3261e;
  --bad-bg: #fce8e6;
  --line: #d8dee9;
  --radius: 14px;
}
* { box-sizing: border-box; }
html { font-size: 18px; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.6;
}
#app { max-width: 720px; margin: 0 auto; padding: 16px 16px 84px; }
#tabbar {
  position: fixed; left: 0; right: 0; bottom: 0;
  display: flex; background: var(--card); border-top: 1px solid var(--line);
  max-width: 720px; margin: 0 auto;
}
#tabbar a {
  flex: 1; text-align: center; padding: 12px 0 16px;
  min-height: 44px; text-decoration: none; color: var(--muted); font-size: 1rem;
}
#tabbar a[aria-current="page"] { color: var(--brand); font-weight: 700; }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.2rem; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 16px; margin: 12px 0;
}
.card h3 { margin: 0 0 6px; font-size: 1.1rem; }
.card p { margin: 4px 0; color: var(--muted); font-size: 0.92rem; }
.btn {
  display: inline-block; min-height: 48px; padding: 10px 22px;
  border-radius: 12px; border: none; background: var(--brand); color: #fff;
  font-size: 1.05rem; cursor: pointer;
}
.btn-secondary { background: #e5eaf2; color: var(--ink); }
.btn-block { display: block; width: 100%; }
.progress-bar {
  height: 10px; border-radius: 6px; background: #e5eaf2; overflow: hidden; margin: 8px 0;
}
.progress-bar > div { height: 100%; background: var(--brand); }
.options { display: grid; gap: 10px; margin: 16px 0; }
.option-btn {
  min-height: 56px; text-align: left; padding: 12px 16px; font-size: 1.05rem;
  background: var(--card); border: 2px solid var(--line); border-radius: 12px;
  cursor: pointer; color: var(--ink);
}
.option-btn.selected { border-color: var(--brand); background: #e8f0fb; }
.fill-input {
  width: 100%; min-height: 56px; font-size: 1.15rem; padding: 10px 14px;
  border: 2px solid var(--line); border-radius: 12px;
}
.feedback { border-radius: var(--radius); padding: 14px 16px; margin: 12px 0; }
.feedback.ok { background: var(--ok-bg); }
.feedback.bad { background: var(--bad-bg); }
.feedback .verdict { font-weight: 700; font-size: 1.1rem; }
.list { list-style: none; padding: 0; margin: 0; }
.list li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.badge {
  display: inline-block; padding: 2px 10px; border-radius: 999px;
  background: #e5eaf2; font-size: 0.85rem; margin-right: 6px;
}
.form-row { margin: 14px 0; }
.form-row label { display: block; font-weight: 600; margin-bottom: 4px; }
.form-row input, .form-row select {
  min-height: 48px; font-size: 1rem; padding: 8px 12px;
  border: 2px solid var(--line); border-radius: 10px; width: 100%;
}
.error-panel { background: var(--bad-bg); padding: 14px; border-radius: var(--radius); }
.muted { color: var(--muted); font-size: 0.9rem; }
.action-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
```

- [ ] **Step 6: 创建 `app-src/src/router.ts`**

```ts
export interface PageContext {
  container: HTMLElement
  params: URLSearchParams
}

export type PageRenderer = (ctx: PageContext) => void | Promise<void>

export interface RouteInfo {
  name: string
  params: URLSearchParams
}

export function parseHash(hash: string): RouteInfo {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query = ''] = raw.split('?')
  return { name: path || 'today', params: new URLSearchParams(query) }
}

export function navigate(name: string, params: Record<string, string> = {}): void {
  const query = new URLSearchParams(params).toString()
  location.hash = `#/${name}${query ? '?' + query : ''}`
}

export function startRouter(pages: Record<string, PageRenderer>, container: HTMLElement): void {
  const tabbar = document.querySelectorAll<HTMLAnchorElement>('#tabbar a')
  const render = () => {
    const { name, params } = parseHash(location.hash)
    const page = pages[name] ?? pages['today']
    if (!page) throw new Error('缺少 today 页面')
    for (const a of tabbar) {
      const target = a.getAttribute('href')?.replace('#/', '') ?? ''
      if (target === name) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
    container.innerHTML = ''
    void page({ container, params })
  }
  addEventListener('hashchange', render)
  render()
}
```

- [ ] **Step 7: 创建 5 个占位页面 + `main.ts`**

每个页面文件（`app-src/src/pages/<name>.ts`）先写成同构占位（以 today 为例，其余 4 个文件把名字换掉）：

```ts
import type { PageRenderer } from '../router'

export const renderToday: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>今日学习</h1><p class="muted">建设中</p>'
}
```

`app-src/src/main.ts`：

```ts
import { startRouter } from './router'
import { renderToday } from './pages/today'
import { renderExercise } from './pages/exercise'
import { renderMistakes } from './pages/mistakes'
import { renderReport } from './pages/report'
import { renderSettings } from './pages/settings'

const container = document.querySelector<HTMLElement>('#app')
if (container) {
  startRouter(
    {
      today: renderToday,
      exercise: renderExercise,
      mistakes: renderMistakes,
      report: renderReport,
      settings: renderSettings,
    },
    container,
  )
}
```

- [ ] **Step 8: 验证 dev 与构建**

Run: `npm --prefix app-src run build`
Expected: `tsc --noEmit` 无错误；vite 构建输出到 `app/`（`app/index.html`、`app/assets/` 存在）
Run（后台）: `npm --prefix app-src run dev` 然后浏览器打开 `http://localhost:5173/#/today`
Expected: 显示"今日学习 · 建设中"，底部 4 个 tab 可切换、当前 tab 高亮

- [ ] **Step 9: 根 package.json 增加代理脚本**

`package.json` scripts 增加：

```json
"dev:app": "npm --prefix app-src run dev",
"build:app": "npm --prefix app-src run build",
"test:app": "npm --prefix app-src run test"
```

- [ ] **Step 10: 提交**

```bash
git add app-src package.json app
git commit -m "feat(app): Vite+TS 应用骨架，hash 路由与五页面占位，构建产物到 app/

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 领域类型 + 题库加载与默写题派生（DEV-04 数据侧）

**Files:**
- Create: `app-src/src/types.ts`
- Create: `app-src/src/content/loader.ts`
- Create: `app-src/src/content/sets.ts`
- Test: `app-src/src/content/loader.test.ts`

- [ ] **Step 1: 创建 `app-src/src/types.ts`**

```ts
export type QuestionType = 'single_choice' | 'fill_in'

export interface AnswerSpec {
  correctOptionIndex?: number
  acceptedAnswers?: string[]
}

export interface Question {
  id: string
  contentVersion: string
  grade: number
  term: 'A' | 'B'
  /** 练习集合 ID：专项级别（g7a-present-l1）或词汇单元（v1-u4） */
  unit: string
  sourceUrl: string
  knowledgePointIds: string[]
  type: QuestionType
  stem: string
  options?: string[]
  answerSpec: AnswerSpec
  explanation: string
  difficulty: number
  estimatedSeconds: number
}

export interface VocabWord {
  id: string
  no: number
  word: string
  variant: string
  pos: string
  ipa: string
  meaning: string
}

export interface VocabUnit {
  id: string
  order: number
  label: string
  words: VocabWord[]
}

export interface VocabBook {
  book: string
  contentVersion: string
  units: VocabUnit[]
}

export interface ContentFileInfo {
  name: string
  sha256: string
  count: number
}

export interface ContentMeta {
  contentId: string
  version: string
  questionCount: number
  vocabWordCount: number
  files: ContentFileInfo[]
}

export type AttemptPhase = 'first' | 'retry'

export interface Attempt {
  id: string
  taskId?: string
  questionId: string
  /** 选择题存选项下标字符串，填空题存原文 */
  answer: string
  isCorrect: boolean
  phase: AttemptPhase
  selfReportedReason?: 'gave_up'
  /** ISO 8601 UTC */
  submittedAt: string
}

export type MasteryStage = 'new' | 'weak' | 'consolidating' | 'mastered'

export interface Mastery {
  knowledgePointId: string
  stage: MasteryStage
  nextReviewAt?: string
  lastAttemptAt?: string
  metrics: { testedCount: number; firstTryCorrect: number }
}

export interface Settings {
  grade: number
  /** 词汇默写当前单元，取 vocab unit id（如 v1-u4） */
  currentUnit: string
  dailyMinutes: number
  studyDaysPerWeek: number
  aiEnabled: boolean
  studentLabel: string
}

export interface ContentBundle {
  questions: Question[]
  vocab: VocabBook
  meta: ContentMeta
}
```

- [ ] **Step 2: 写失败测试 `app-src/src/content/loader.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveVocabQuestions } from './loader'
import type { VocabBook } from '../types'

const vocab: VocabBook = {
  book: 'g7a',
  contentVersion: '2026-11-16',
  units: [
    {
      id: 'v1-u1',
      order: 1,
      label: 'Starter Unit 1',
      words: [
        { id: 'v1-u1-1', no: 1, word: 'unit', variant: '', pos: 'n.', ipa: '/ˈjuːnɪt/', meaning: '单元' },
        { id: 'v1-u1-2', no: 2, word: 'centre', variant: 'center', pos: 'n.', ipa: '', meaning: '中心；中央' },
      ],
    },
  ],
}

describe('deriveVocabQuestions', () => {
  it('中→英默写题：ID 稳定、含 variant 同义答案', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({
      id: 'g7a-vocab-u1-0001',
      type: 'fill_in',
      unit: 'v1-u1',
      answerSpec: { acceptedAnswers: ['unit'] },
    })
    expect(qs[1]).toMatchObject({
      id: 'g7a-vocab-u1-0002',
      answerSpec: { acceptedAnswers: ['centre', 'center'] },
    })
  })

  it('同输入两次派生结果一致（题序与 ID 不变）', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u1')).toEqual(deriveVocabQuestions(vocab, 'v1-u1'))
  })

  it('未知单元返回空数组', () => {
    expect(deriveVocabQuestions(vocab, 'v1-u99')).toEqual([])
  })

  it('每题带知识点 ID 与释义解析', () => {
    const qs = deriveVocabQuestions(vocab, 'v1-u1')
    expect(qs[0]!.knowledgePointIds).toEqual(['vocab.g7a.u1'])
    expect(qs[0]!.explanation).toContain('unit')
    expect(qs[0]!.explanation).toContain('单元')
  })
})

describe('fetchContentBundle 失败后可重试', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('非 2xx 拒绝后，再次调用会重新 fetch', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (urls.length <= 3) return { ok: false, status: 404 } // 第一轮三个请求全失败
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    const { fetchContentBundle } = await import('./loader')
    await expect(fetchContentBundle()).rejects.toThrow('题库加载失败')
    await expect(fetchContentBundle()).resolves.toBeDefined() // 重试成功
    expect(urls.length).toBe(6) // 确实重新 fetch 了 3 个文件
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm --prefix app-src run test`
Expected: FAIL，`Failed to resolve import "./loader"`

- [ ] **Step 4: 实现 `app-src/src/content/loader.ts`**

```ts
import type { ContentBundle, Question, VocabBook, VocabWord } from '../types'

const CONTENT_BASE = './content/g7a'

let bundlePromise: Promise<ContentBundle> | undefined

/** 拉取并缓存题库（相对当前文档路径，dev 与子路径部署均正确） */
export function fetchContentBundle(): Promise<ContentBundle> {
  bundlePromise ??= (async () => {
    const [questions, vocab, meta] = await Promise.all([
      fetchJson<Question[]>(`${CONTENT_BASE}/questions.json`),
      fetchJson<VocabBook>(`${CONTENT_BASE}/vocab.json`),
      fetchJson<ContentBundle['meta']>(`${CONTENT_BASE}/content.json`),
    ])
    return { questions, vocab, meta }
  })()
  return bundlePromise.catch((err) => {
    bundlePromise = undefined
    throw err
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`题库加载失败：${url}（HTTP ${res.status}）`)
  return res.json() as Promise<T>
}

/** 词汇单元 id（v1-u4）→ 短名（u4），用于生成稳定题目 ID */
function unitShortName(unitId: string): string {
  return unitId.replace(/^v1-/, '')
}

/** contentVersion 统一用书级版本；词 ID 的可追溯性已体现在 Question.id 中 */
function toVocabQuestion(contentVersion: string, unitId: string, w: VocabWord): Question {
  const accepted = [w.word, ...(w.variant ? [w.variant] : [])]
  return {
    id: `g7a-vocab-${unitShortName(unitId)}-${String(w.no).padStart(4, '0')}`,
    contentVersion,
    grade: 7,
    term: 'A',
    unit: unitId,
    sourceUrl: 'typing/',
    knowledgePointIds: [`vocab.g7a.${unitShortName(unitId)}`],
    type: 'fill_in',
    stem: `${w.meaning}（${w.pos}）`,
    answerSpec: { acceptedAnswers: accepted },
    explanation: `${w.word} ${w.ipa} ${w.pos} ${w.meaning}`,
    difficulty: 1,
    estimatedSeconds: 20,
  }
}

/** 由词汇派生中→英默写题；词序取自源数据，保证 ID 跨会话稳定 */
export function deriveVocabQuestions(vocab: VocabBook, unitId: string): Question[] {
  const unit = vocab.units.find((u) => u.id === unitId)
  if (!unit) return []
  return unit.words.map((w) => toVocabQuestion(vocab.contentVersion, unitId, w))
}

export function findVocabUnit(vocab: VocabBook, unitId: string) {
  return vocab.units.find((u) => u.id === unitId)
}
```

注意：默写题的 `contentVersion` 统一用书级版本；词 ID 的可追溯性已体现在 `Question.id` 的生成中。

- [ ] **Step 5: 创建 `app-src/src/content/sets.ts`（专项元信息）**

```ts
export interface SpecialInfo {
  id: string
  title: string
  sourceUrl: string
}

export const SPECIALS: SpecialInfo[] = [
  { id: 'g7a-present', title: '一般现在时与句子种类', sourceUrl: 'g7a-present/' },
  { id: 'g7a-nouns', title: '名词与所有格', sourceUrl: 'g7a-nouns/' },
  { id: 'g7a-numbers', title: '数词与介词', sourceUrl: 'g7a-numbers/' },
  { id: 'g7a-articles', title: '冠词与代词', sourceUrl: 'g7a-articles/' },
]
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm --prefix app-src run test`
Expected: 5 个测试 PASS（4 个派生用例 + 1 个失败重试用例）

- [ ] **Step 7: 提交**

```bash
git add app-src/src/types.ts app-src/src/content
git commit -m "feat(app): 领域类型与题库加载，词汇派生中译英默写题

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 判分引擎（DEV-04 判分侧）

**Files:**
- Create: `app-src/src/domain/grader.ts`
- Test: `app-src/src/domain/grader.test.ts`

- [ ] **Step 1: 写失败测试 `app-src/src/domain/grader.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { gradeAnswer, normalizeBlank } from './grader'
import type { Question } from '../types'

const choice: Question = {
  id: 'q1',
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: 'She ___ to school every day.',
  options: ['go', 'goes', 'going', 'gone'],
  answerSpec: { correctOptionIndex: 1 },
  explanation: '三单用 goes',
  difficulty: 1,
  estimatedSeconds: 45,
}

const fill: Question = {
  id: 'q2',
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'fill_in',
  stem: '单元（n.）',
  answerSpec: { acceptedAnswers: ['unit'] },
  explanation: 'unit n. 单元',
  difficulty: 1,
  estimatedSeconds: 20,
}

const fillVariant: Question = {
  ...fill,
  id: 'q3',
  answerSpec: { acceptedAnswers: ['centre', 'center'] },
}

describe('normalizeBlank', () => {
  it('去首尾空白、折叠内部空白、统一小写', () => {
    expect(normalizeBlank('  Unit  ')).toBe('unit')
    expect(normalizeBlank('New   York ')).toBe('new york')
    expect(normalizeBlank('UNIT')).toBe('unit')
  })
  it('全角标点转半角、去包裹引号', () => {
    expect(normalizeBlank('，')).toBe(',')
    expect(normalizeBlank('。')).toBe('.')
    expect(normalizeBlank('twelve。')).toBe('twelve.')
    expect(normalizeBlank('"unit"')).toBe('unit')
    expect(normalizeBlank('“unit”')).toBe('unit')
    expect(normalizeBlank('" unit "')).toBe('unit')
    expect(normalizeBlank(' "  unit  " ')).toBe('unit')
  })
})

describe('gradeAnswer', () => {
  it('选择题：比对选项下标', () => {
    expect(gradeAnswer(choice, '1').isCorrect).toBe(true)
    expect(gradeAnswer(choice, '0').isCorrect).toBe(false)
    expect(gradeAnswer(choice, '1').correctAnswer).toBe('goes')
  })
  it('选择题：非数字答案判错不抛异常', () => {
    expect(gradeAnswer(choice, 'x').isCorrect).toBe(false)
  })
  it('填空：大小写与空白不敏感', () => {
    expect(gradeAnswer(fill, '  UNIT ').isCorrect).toBe(true)
    expect(gradeAnswer(fill, 'united').isCorrect).toBe(false)
  })
  it('填空：接受同义变体', () => {
    expect(gradeAnswer(fillVariant, 'Center').isCorrect).toBe(true)
    expect(gradeAnswer(fillVariant, 'centre').isCorrect).toBe(true)
  })
  it('填空：正确答案取首选（展示用）', () => {
    expect(gradeAnswer(fillVariant, 'x').correctAnswer).toBe('centre')
  })
  it('空串答案判错（含填空）', () => {
    expect(gradeAnswer({ ...fill, answerSpec: { correctOptionIndex: 0 }, type: 'single_choice', options: ['a', 'b'] }, '').isCorrect).toBe(false)
    expect(gradeAnswer(fill, '').isCorrect).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix app-src run test -- grader`
Expected: FAIL，`Cannot find module './grader'`

- [ ] **Step 3: 实现 `app-src/src/domain/grader.ts`**

```ts
import type { Question } from '../types'

const FULLWIDTH_PUNCT: Record<string, string> = {
  '，': ',', '。': '.', '；': ';', '：': ':', '？': '?', '！': '!',
  '（': '(', '）': ')', '“': '"', '”': '"', '‘': "'", '’': "'",
}

/** 填空答案规范化：空白/大小写/全半角标点/包裹引号（规格 7.3） */
export function normalizeBlank(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/[，。；：？！（）“‘’”]/g, (ch) => FULLWIDTH_PUNCT[ch] ?? ch)
  s = s.replace(/\s+/g, ' ')
  if (s.length >= 2) {
    const first = s[0]!
    const last = s[s.length - 1]!
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim()
    }
  }
  return s
}

export interface GradeResult {
  isCorrect: boolean
  /** 展示给学生的标准答案文本 */
  correctAnswer: string
}

export function gradeAnswer(question: Question, answer: string): GradeResult {
  if (question.type === 'single_choice') {
    const idx = Number(answer)
    const correct = question.answerSpec.correctOptionIndex
    const isCorrect = answer.trim() !== '' && correct !== undefined && Number.isInteger(idx) && idx === correct
    return { isCorrect, correctAnswer: correct !== undefined ? question.options?.[correct] ?? '' : '' }
  }
  const accepted = question.answerSpec.acceptedAnswers ?? []
  const normalized = normalizeBlank(answer)
  const isCorrect = accepted.some((a) => normalizeBlank(a) === normalized)
  return { isCorrect, correctAnswer: accepted[0] ?? '' }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix app-src run test -- grader`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add app-src/src/domain
git commit -m "feat(app): 客观题判分引擎（选择题+填空规范化）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Dexie schema 与 repositories（DEV-03）

**Files:**
- Create: `app-src/src/db/schema.ts`
- Create: `app-src/src/db/repos.ts`
- Test: `app-src/src/db/repos.test.ts`

- [ ] **Step 1: 创建 `app-src/src/db/schema.ts`**

```ts
import Dexie, { type Table } from 'dexie'
import type { Attempt, ContentMeta, Mastery, Question, Settings } from '../types'

export interface SettingsRow {
  key: string
  value: Settings
  updatedAt: string
}

export interface ContentMetaRow extends ContentMeta {
  contentId: string
}

export interface WeeklyReportRow {
  weekStart: string
  facts: unknown
  aiSuggestions?: string
  generatedAt: string
}

export interface AiRequestRow {
  id: string
  type: string
  status: string
  localCostEstimate?: number
  createdAt: string
}

export interface TaskRow {
  id: string
  day: string
  type: string
  questionIds: string[]
  status: 'planned' | 'in_progress' | 'completed' | 'skipped' | 'deferred'
  minutesPlanned: number
}

export class EnglishCoachDB extends Dexie {
  settings!: Table<SettingsRow, string>
  contentMeta!: Table<ContentMetaRow, string>
  questions!: Table<Question, string>
  tasks!: Table<TaskRow, string>
  attempts!: Table<Attempt, string>
  mastery!: Table<Mastery, string>
  weeklyReports!: Table<WeeklyReportRow, string>
  aiRequests!: Table<AiRequestRow, string>

  constructor() {
    super('EnglishCoachDB')
    this.version(1).stores({
      settings: 'key',
      contentMeta: 'contentId',
      questions: 'id, unit, *knowledgePointIds, contentVersion',
      tasks: 'id, day, status',
      attempts: 'id, questionId, submittedAt, phase',
      mastery: 'knowledgePointId, nextReviewAt',
      weeklyReports: 'weekStart',
      aiRequests: 'id, createdAt',
    })
  }
}

export const db = new EnglishCoachDB()
```

- [ ] **Step 2: 写失败测试 `app-src/src/db/repos.test.ts`**

```ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
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
} from './repos'
import type { Attempt, Question, Settings } from '../types'

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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm --prefix app-src run test -- repos`
Expected: FAIL，`Cannot find module './repos'`

- [ ] **Step 4: 实现 `app-src/src/db/repos.ts`**

```ts
import { db, type ContentMetaRow } from './schema'
import type { Attempt, Question, Settings } from '../types'

export const DEFAULT_SETTINGS: Settings = {
  grade: 7,
  currentUnit: 'v1-u4',
  dailyMinutes: 35,
  studyDaysPerWeek: 6,
  aiEnabled: false,
  studentLabel: '学生1',
}

const SETTINGS_KEY = 'app'

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_KEY)
  return row ? { ...DEFAULT_SETTINGS, ...row.value } : { ...DEFAULT_SETTINGS }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await db.settings.put({ key: SETTINGS_KEY, value: settings, updatedAt: new Date().toISOString() })
}

/** 只追加：ID 冲突直接抛错，保证历史不可改写（T02） */
export async function saveAttempt(attempt: Attempt): Promise<void> {
  await db.attempts.add(attempt)
}

export async function listAttempts(): Promise<Attempt[]> {
  return db.attempts.orderBy('submittedAt').toArray()
}

export async function attemptsForQuestion(questionId: string): Promise<Attempt[]> {
  return db.attempts.where('questionId').equals(questionId).toArray()
}

export async function hasPriorAttempt(questionId: string): Promise<boolean> {
  return (await db.attempts.where('questionId').equals(questionId).count()) > 0
}

export async function upsertQuestions(questions: Question[]): Promise<void> {
  await db.questions.bulkPut(questions)
}

/** 前缀匹配专项 unit（如 'g7a-present' 命中 'g7a-present-l1'…）；调用方应传完整 special id，词汇单元（v1-u*）不写入 questions 表、不适用本查询 */
export async function questionsByUnitPrefix(prefix: string): Promise<Question[]> {
  return db.questions.where('unit').startsWith(prefix).toArray()
}

export async function listAllQuestions(): Promise<Question[]> {
  return db.questions.toArray()
}

export async function putContentMeta(meta: ContentMetaRow): Promise<void> {
  await db.contentMeta.put(meta)
}

export async function getContentMeta(contentId: string): Promise<ContentMetaRow | undefined> {
  return db.contentMeta.get(contentId)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm --prefix app-src run test -- repos`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add app-src/src/db
git commit -m "feat(app): Dexie schema 与 repositories，attempts 只追加

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 内容播种（启动时把题库写入 IndexedDB）

**Files:**
- Create: `app-src/src/content/seed.ts`
- Test: `app-src/src/content/seed.test.ts`

- [ ] **Step 1: 写失败测试 `app-src/src/content/seed.test.ts`**

```ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/schema'
import { seedContent } from './seed'
import type { ContentBundle, Question } from '../types'

const q = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'g7a-present-l1',
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

const bundle = (): ContentBundle => ({
  questions: [q('q1'), q('q2')],
  vocab: { book: 'g7a', contentVersion: 'v', units: [] },
  meta: { contentId: 'g7a', version: 'v1', questionCount: 2, vocabWordCount: 0, files: [] },
})

beforeEach(async () => {
  await Promise.all([db.questions.clear(), db.contentMeta.clear()])
})

describe('seedContent', () => {
  it('首次播种：写入题目与 contentMeta', async () => {
    const result = await seedContent(bundle())
    expect(result).toEqual({ inserted: 2, skipped: false })
    expect(await db.questions.count()).toBe(2)
    expect((await db.contentMeta.get('g7a'))?.version).toBe('v1')
  })
  it('版本未变时跳过，不重复写入', async () => {
    await seedContent(bundle())
    const result = await seedContent(bundle())
    expect(result).toEqual({ inserted: 0, skipped: true })
    expect(await db.questions.count()).toBe(2)
  })
  it('版本升级时重新播种并更新 contentMeta', async () => {
    await seedContent(bundle())
    const upgraded = bundle()
    upgraded.meta = { ...upgraded.meta, version: 'v2' }
    const result = await seedContent(upgraded)
    expect(result).toEqual({ inserted: 2, skipped: false })
    expect((await db.contentMeta.get('g7a'))?.version).toBe('v2')
    expect(await db.questions.count()).toBe(2)
  })
  it('版本升级时删除 bundle 外的陈旧题', async () => {
    const v1 = bundle()
    v1.questions = [q('q1'), q('q2'), q('q3')]
    await seedContent(v1)
    expect(await db.questions.count()).toBe(3)
    const v2 = bundle()
    v2.meta = { ...v2.meta, version: 'v2' } // 只含 q1/q2
    const result = await seedContent(v2)
    expect(result).toEqual({ inserted: 2, skipped: false })
    expect(await db.questions.count()).toBe(2)
    expect(await db.questions.get('q3')).toBeUndefined()
    expect((await db.contentMeta.get('g7a'))?.version).toBe('v2')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix app-src run test -- seed`
Expected: FAIL，`Cannot find module './seed'`

- [ ] **Step 3: 实现 `app-src/src/content/seed.ts`**

```ts
import { getContentMeta, putContentMeta, upsertQuestions } from '../db/repos'
import { db } from '../db/schema'
import type { ContentBundle } from '../types'

export interface SeedResult {
  /** 写入/覆盖的题目数（幂等重播，非新增数） */
  inserted: number
  skipped: boolean
}

/** 版本未变则跳过；变化则整表重建题目索引（bulkPut 幂等）。
 * 当前 questions 表仅存单一 g7a bundle；若未来多 contentId 共存，需改为按 contentId/前缀过滤 stale，否则会互相清除。 */
export async function seedContent(bundle: ContentBundle): Promise<SeedResult> {
  const meta = bundle.meta
  const existing = await getContentMeta(meta.contentId)
  if (existing && existing.version === meta.version) {
    return { inserted: 0, skipped: true }
  }
  await upsertQuestions(bundle.questions)
  const stale = await db.questions.toArray()
  const knownIds = new Set(bundle.questions.map((q) => q.id))
  const obsolete = stale.filter((q) => !knownIds.has(q.id)).map((q) => q.id)
  if (obsolete.length > 0) await db.questions.bulkDelete(obsolete)
  await putContentMeta(meta)
  return { inserted: bundle.questions.length, skipped: false }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix app-src run test -- seed`
Expected: 4 个测试 PASS（全量测试 26 tests passed）

- [ ] **Step 5: 提交**

```bash
git add app-src/src/content/seed.ts app-src/src/content/seed.test.ts
git commit -m "feat(app): 启动播种题库到 IndexedDB，按内容版本跳过或重建

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 练习会话 PracticeSession（首测/复测区分）

**Files:**
- Create: `app-src/src/domain/session.ts`
- Test: `app-src/src/domain/session.test.ts`

- [ ] **Step 1: 写失败测试 `app-src/src/domain/session.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { PracticeSession, newAttemptId } from './session'
import type { Attempt, Question } from '../types'

const choice = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
  sourceUrl: 's',
  knowledgePointIds: ['k'],
  type: 'single_choice',
  stem: '1 + 1 = ___',
  options: ['1', '2', '3', '4'],
  answerSpec: { correctOptionIndex: 1 },
  explanation: 'e',
  difficulty: 1,
  estimatedSeconds: 45,
})

describe('PracticeSession', () => {
  it('空题集抛错', () => {
    expect(() => new PracticeSession([], { hasPriorAttempt: async () => false, recordAttempt: async () => {} })).toThrow()
  })

  it('提交记录 attempt 并推进；首题 phase=first', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1'), choice('q2')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const sub = await s.submit('1')
    expect(sub.isCorrect).toBe(true)
    expect(sub.phase).toBe('first')
    expect(sub.isLast).toBe(false)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.questionId).toBe('q1')
    expect(attempts[0]!.isCorrect).toBe(true)
    expect(s.done).toBe(1)
    expect(s.current.id).toBe('q2')
  })

  it('已有历史时 phase=retry（做错后改对不覆盖首测，T02）', async () => {
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => true,
      recordAttempt: async () => {},
    })
    expect((await s.submit('2')).phase).toBe('retry')
  })

  it('我不会：记错误并带 gave_up 标记', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const sub = await s.submit('', { gaveUp: true })
    expect(sub.isCorrect).toBe(false)
    expect(sub.correctAnswer).toBe('2')
    expect(attempts[0]!.selfReportedReason).toBe('gave_up')
    expect(attempts[0]!.isCorrect).toBe(false)
  })

  it('最后一题后 isFinished，再提交抛错', async () => {
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async () => {},
    })
    await s.submit('2')
    expect(s.isFinished).toBe(true)
    await expect(s.submit('2')).rejects.toThrow('练习已结束')
  })

  it('attempt id 为合法 UUID', () => {
    expect(newAttemptId()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('并发重入被守卫拦截：只落一条 attempt、index 只 +1', async () => {
    const attempts: Attempt[] = []
    const s = new PracticeSession([choice('q1'), choice('q2')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => { attempts.push(a) },
    })
    const first = s.submit('1')
    await expect(s.submit('1')).rejects.toThrow('正在处理上一次提交')
    await first
    expect(attempts).toHaveLength(1)
    expect(s.done).toBe(1)
  })

  it('recordAttempt 失败不推进，重试成功只落一条', async () => {
    const attempts: Attempt[] = []
    let fail = true
    const s = new PracticeSession([choice('q1')], {
      hasPriorAttempt: async () => false,
      recordAttempt: async (a) => {
        if (fail) throw new Error('写失败')
        attempts.push(a)
      },
    })
    await expect(s.submit('1')).rejects.toThrow('写失败')
    expect(s.done).toBe(0)
    fail = false
    const sub = await s.submit('1')
    expect(sub.isCorrect).toBe(true)
    expect(sub.isLast).toBe(true)
    expect(attempts).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix app-src run test -- session`
Expected: FAIL，`Cannot find module './session'`

- [ ] **Step 3: 实现 `app-src/src/domain/session.ts`**

```ts
import { gradeAnswer } from './grader'
import type { Attempt, AttemptPhase, Question } from '../types'

export interface SessionDeps {
  hasPriorAttempt: (questionId: string) => Promise<boolean>
  recordAttempt: (attempt: Attempt) => Promise<void>
}

export interface Submission {
  question: Question
  answer: string
  isCorrect: boolean
  phase: AttemptPhase
  correctAnswer: string
  isLast: boolean
}

/** crypto.randomUUID 需 secure context（https/localhost）与 Node ≥19；非安全上下文部署需 fallback */
export function newAttemptId(): string {
  return globalThis.crypto.randomUUID()
}

/** 一次练习会话：顺序出题、提交即判分并落一条 attempt */
export class PracticeSession {
  private index = 0
  private submitting = false
  readonly total: number

  constructor(private questions: Question[], private deps: SessionDeps) {
    if (questions.length === 0) throw new Error('PracticeSession 需要至少一道题')
    this.total = questions.length
  }

  get current(): Question {
    if (this.isFinished) throw new Error('练习已结束')
    return this.questions[this.index]!
  }

  get done(): number {
    return this.index
  }

  get isFinished(): boolean {
    return this.index >= this.total
  }

  async submit(answer: string, opts: { gaveUp?: boolean } = {}): Promise<Submission> {
    if (this.isFinished) throw new Error('练习已结束')
    if (this.submitting) throw new Error('正在处理上一次提交')
    this.submitting = true
    try {
      const question = this.current
      const graded = gradeAnswer(question, answer)
      const isCorrect = opts.gaveUp ? false : graded.isCorrect
      const phase: AttemptPhase = (await this.deps.hasPriorAttempt(question.id)) ? 'retry' : 'first'
      const attempt: Attempt = {
        id: newAttemptId(),
        questionId: question.id,
        answer,
        isCorrect,
        phase,
        ...(opts.gaveUp ? { selfReportedReason: 'gave_up' as const } : {}),
        submittedAt: new Date().toISOString(),
      }
      await this.deps.recordAttempt(attempt)
      this.index += 1
      return {
        question,
        answer,
        isCorrect,
        phase,
        correctAnswer: graded.correctAnswer,
        isLast: this.index >= this.total,
      }
    } finally {
      this.submitting = false
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix app-src run test -- session`
Expected: 8 个测试 PASS（全量 34）

- [ ] **Step 5: 提交**

```bash
git add app-src/src/domain/session.ts app-src/src/domain/session.test.ts
git commit -m "feat(app): 练习会话状态机，首测/复测区分与我不会记录

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 练习页 UI

**Files:**
- Modify: `app-src/src/pages/exercise.ts`（替换占位实现）

练习页纯 UI 无单测（逻辑已在 session/grader/repos 覆盖），以浏览器验证。

- [ ] **Step 1: 实现 `app-src/src/pages/exercise.ts`**

```ts
import type { PageRenderer } from '../router'
import { navigate } from '../router'
import type { Question } from '../types'
import { fetchContentBundle, deriveVocabQuestions } from '../content/loader'
import { questionsByUnitPrefix } from '../db/repos'
import { saveAttempt, hasPriorAttempt } from '../db/repos'
import { PracticeSession, type Submission } from '../domain/session'

const LETTERS = ['A', 'B', 'C', 'D']

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

async function loadQuestions(params: URLSearchParams): Promise<{ title: string; questions: Question[] }> {
  const vocabUnit = params.get('vocab')
  if (vocabUnit) {
    const bundle = await fetchContentBundle()
    const unit = bundle.vocab.units.find((u) => u.id === vocabUnit)
    return { title: `单词默写 · ${unit?.label ?? vocabUnit}`, questions: shuffle(deriveVocabQuestions(bundle.vocab, vocabUnit)) }
  }
  const special = params.get('special')
  if (special) {
    const questions = await questionsByUnitPrefix(special)
    return { title: '专项练习', questions: shuffle(questions) }
  }
  return { title: '练习', questions: [] }
}

export const renderExercise: PageRenderer = ({ container, params }) => {
  const start = async (): Promise<void> => {
    let stale = false
    const onHashChange = () => { stale = true }
    window.addEventListener('hashchange', onHashChange, { once: true })
    container.innerHTML = '<h1>学习练习</h1><p class="muted">加载中…</p>'
    let data: { title: string; questions: Question[] }
    try {
      data = await loadQuestions(params)
    } catch (err) {
      window.removeEventListener('hashchange', onHashChange)
      if (stale) return
      container.innerHTML = `<h1>学习练习</h1><div class="error-panel">题库加载失败：${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry">重试</button></div></div>`
      container.querySelector('#retry')?.addEventListener('click', () => void start())
      return
    }
    if (stale) return
    if (data.questions.length === 0) {
      window.removeEventListener('hashchange', onHashChange)
      container.innerHTML = `<h1>学习练习</h1><div class="card"><h3>${escapeHtml(data.title)}</h3><p>该内容暂无题目。</p><div class="action-row"><button class="btn btn-secondary" id="back">返回今日学习</button></div></div>`
      container.querySelector('#back')?.addEventListener('click', () => navigate('today'))
      return
    }

    const session = new PracticeSession(data.questions, {
      hasPriorAttempt,
      recordAttempt: saveAttempt,
    })
    const stats = { correct: 0, total: session.total }

    const renderQuestion = () => {
      const q = session.current
      const progress = Math.round((session.done / session.total) * 100)
      container.innerHTML = `
        <h1>${escapeHtml(data.title)}</h1>
        <div class="progress-bar"><div style="width:${progress}%"></div></div>
        <p class="muted">第 ${session.done + 1} / ${session.total} 题</p>
        <div class="card">
          <h3 style="font-size:1.25rem">${escapeHtml(q.stem)}</h3>
          ${q.type === 'single_choice' ? renderOptions(q) : renderFill()}
          <div class="action-row">
            ${q.type === 'fill_in' ? '<button class="btn" id="submit">提交答案</button>' : ''}
            <button class="btn btn-secondary" id="giveup">我不会</button>
          </div>
        </div>`
      if (q.type === 'single_choice') {
        for (const btn of container.querySelectorAll<HTMLButtonElement>('.option-btn')) {
          btn.addEventListener('click', () => {
            if (container.querySelector('.feedback')) return
            for (const b of container.querySelectorAll('.option-btn')) b.classList.remove('selected')
            btn.classList.add('selected')
            void submit(btn.dataset.index ?? '')
          })
        }
      } else {
        container.querySelector('#submit')?.addEventListener('click', () => {
          const input = container.querySelector<HTMLInputElement>('#fill-input')
          void submit(input?.value ?? '')
        })
        container.querySelector<HTMLInputElement>('#fill-input')?.addEventListener('keydown', (e) => {
          if (e.isComposing) return
          if (e.key === 'Enter') container.querySelector<HTMLButtonElement>('#submit')?.click()
        })
      }
      container.querySelector('#giveup')?.addEventListener('click', () => void submit('', { gaveUp: true }))
    }

    const renderFill = () => '<input class="fill-input" id="fill-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文单词" inputmode="text">'

    const renderOptions = (q: Question) => `<div class="options">${(q.options ?? []).map((opt, i) => `
      <button class="option-btn" data-index="${i}"><strong>${LETTERS[i] ?? ''}.</strong> ${escapeHtml(opt)}</button>`).join('')}</div>`

    const submit = async (answer: string, opts: { gaveUp?: boolean } = {}) => {
      if (container.querySelector('.feedback')) return
      let sub: Submission
      try {
        sub = await session.submit(answer, opts)
      } catch (err) {
        if (err instanceof Error && err.message === '正在处理上一次提交') return
        if (stale) return
        container.innerHTML = `<h1>${escapeHtml(data.title)}</h1><div class="error-panel">提交失败，学习记录未能保存。${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry-submit">重试本题</button></div></div>`
        container.querySelector('#retry-submit')?.addEventListener('click', () => renderQuestion())
        return
      }
      if (stale) return
      if (sub.isCorrect) stats.correct += 1
      const panel = document.createElement('div')
      panel.className = `feedback ${sub.isCorrect ? 'ok' : 'bad'}`
      panel.innerHTML = `
        <p class="verdict">${sub.isCorrect ? '✓ 答对了' : '✗ 答错了'}</p>
        ${sub.isCorrect ? '' : `<p>正确答案：<strong>${escapeHtml(sub.correctAnswer)}</strong></p>`}
        <p>${escapeHtml(sub.question.explanation)}</p>
        <div class="action-row"><button class="btn" id="next">${sub.isLast ? '查看总结' : '下一题'}</button></div>`
      container.querySelector('.card')?.appendChild(panel)
      container.querySelector('#giveup')?.setAttribute('disabled', 'true')
      container.querySelector('#submit')?.setAttribute('disabled', 'true')
      panel.querySelector('#next')?.addEventListener('click', () => {
        if (session.isFinished) renderSummary()
        else renderQuestion()
      })
    }

    const renderSummary = () => {
      window.removeEventListener('hashchange', onHashChange)
      container.innerHTML = `
        <h1>${escapeHtml(data.title)}</h1>
        <div class="card">
          <h3>练习完成</h3>
          <p>共 ${stats.total} 题，答对 ${stats.correct} 题（${Math.round((stats.correct / stats.total) * 100)}%）。</p>
          <div class="action-row">
            <button class="btn" id="back-today">返回今日学习</button>
            <button class="btn btn-secondary" id="to-mistakes">查看错题本</button>
          </div>
        </div>`
      container.querySelector('#back-today')?.addEventListener('click', () => navigate('today'))
      container.querySelector('#to-mistakes')?.addEventListener('click', () => navigate('mistakes'))
    }

    renderQuestion()
  }
  return start()
}
```

注意选择题点选即提交（单击选项=提交，无二次确认）；填空题输入后点“提交答案”或回车。

- [ ] **Step 2: 类型检查与构建**

Run: `npm --prefix app-src run build`
Expected: tsc 无错误，构建成功

- [ ] **Step 3: 浏览器验证**

后台运行 `npm --prefix app-src run dev`，浏览器打开 `http://localhost:5173/#/exercise?special=g7a-present`：
1. 显示"专项练习"与第 1/48 题、进度条
2. 点一个选项 → 出现绿/红反馈面板（含 ✓/✗ 文字、正确答案、解析）与"下一题"
3. 点"我不会" → 记为答错
4. 填空题验证：`http://localhost:5173/#/exercise?vocab=v1-u1`，输入正确单词（大小写混用）判对，输错判错并显示解析
5. 刷新页面后重做同一题 → DevTools Application → IndexedDB → EnglishCoachDB → attempts 里该题出现两条（first + retry）

- [ ] **Step 4: 提交**

```bash
git add app-src/src/pages/exercise.ts
git commit -m "feat(app): 练习页——选择/填空作答、判分反馈、我不会与练习总结

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 指标口径 metrics（DEV-07 基础）

**Files:**
- Create: `app-src/src/domain/metrics.ts`
- Test: `app-src/src/domain/metrics.test.ts`

- [ ] **Step 1: 写失败测试 `app-src/src/domain/metrics.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from './metrics'
import type { Attempt } from '../types'

const a = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry', submittedAt: string): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase,
  submittedAt,
})

describe('computeCoreMetrics（口径见规格 7.5）', () => {
  it('首测正确率只算 phase=first，不含重答', () => {
    const attempts = [
      a('1', 'q1', true, 'first', '2026-11-16T02:00:00.000Z'),
      a('2', 'q2', false, 'first', '2026-11-16T02:01:00.000Z'),
      a('3', 'q2', true, 'retry', '2026-11-16T02:02:00.000Z'),
    ]
    const m = computeCoreMetrics(attempts)
    expect(m.totalAttempts).toBe(3)
    expect(m.firstAttempts).toBe(2)
    expect(m.firstCorrect).toBe(1)
    expect(m.firstTryCorrectRate).toBe(0.5)
    expect(m.retryAttempts).toBe(1)
    expect(m.retryCorrect).toBe(1)
    expect(m.wrongQuestions).toBe(1)
  })
  it('无首测时正确率为 null（不是 0）', () => {
    const m = computeCoreMetrics([a('1', 'q1', true, 'retry', '2026-11-16T02:00:00.000Z')])
    expect(m.firstTryCorrectRate).toBeNull()
  })
  it('空数据', () => {
    const m = computeCoreMetrics([])
    expect(m.totalAttempts).toBe(0)
    expect(m.firstTryCorrectRate).toBeNull()
  })
})

describe('本地日历日', () => {
  it('localDayKey 生成 YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 10, 16, 23, 30))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('isSameLocalDay 按本地时区比较', () => {
    // 本地 2026-11-16 07:00 == UTC 2026-11-15 23:00（东八区）
    const localKey = localDayKey(new Date(2026, 10, 16, 7, 0))
    expect(isSameLocalDay('2026-11-15T23:00:00.000Z', localKey)).toBe(true)
    expect(isSameLocalDay('2026-11-16T23:00:00.000Z', localKey)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix app-src run test -- metrics`
Expected: FAIL，`Cannot find module './metrics'`

- [ ] **Step 3: 实现 `app-src/src/domain/metrics.ts`**

```ts
import type { Attempt } from '../types'

export interface CoreMetrics {
  totalAttempts: number
  firstAttempts: number
  firstCorrect: number
  /** 首次作答正确率；无首测数据时为 null（页面显示“暂无数据”） */
  firstTryCorrectRate: number | null
  retryAttempts: number
  retryCorrect: number
  wrongQuestions: number
}

export function computeCoreMetrics(attempts: Attempt[]): CoreMetrics {
  let firstAttempts = 0
  let firstCorrect = 0
  let retryAttempts = 0
  let retryCorrect = 0
  const wrong = new Set<string>()
  for (const a of attempts) {
    if (a.phase === 'first') {
      firstAttempts += 1
      if (a.isCorrect) firstCorrect += 1
    } else {
      retryAttempts += 1
      if (a.isCorrect) retryCorrect += 1
    }
    if (!a.isCorrect) wrong.add(a.questionId)
  }
  return {
    totalAttempts: attempts.length,
    firstAttempts,
    firstCorrect,
    firstTryCorrectRate: firstAttempts > 0 ? firstCorrect / firstAttempts : null,
    retryAttempts,
    retryCorrect,
    wrongQuestions: wrong.size,
  }
}

/** 本地日历日键（规格 8：按设备本地时区算“今日”） */
export function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isSameLocalDay(isoUtc: string, key: string): boolean {
  return localDayKey(new Date(isoUtc)) === key
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix app-src run test -- metrics`
Expected: 5 个测试 PASS（isSameLocalDay 第二条断言依赖本地时区为东八区；若在其他时区执行 CI 失败，把两条断言改为按本地时区动态计算期望值，见下）

时区无关写法（若需要替换上面 isSameLocalDay 断言）：

```ts
it('isSameLocalDay 按本地时区比较', () => {
  const d = new Date(2026, 10, 16, 7, 0)
  const key = localDayKey(d)
  const sameLocal = new Date(d.getTime()) // 与 d 同一本地日
  const otherLocal = new Date(2026, 10, 17, 7, 0)
  expect(isSameLocalDay(sameLocal.toISOString(), key)).toBe(true)
  expect(isSameLocalDay(otherLocal.toISOString(), key)).toBe(false)
})
```

- [ ] **Step 5: 提交**

```bash
git add app-src/src/domain/metrics.ts app-src/src/domain/metrics.test.ts
git commit -m "feat(app): 学习指标口径——首测正确率、本地日历日

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: 今日 / 错题 / 报告 / 设置 页面

**Files:**
- Modify: `app-src/src/pages/today.ts`、`app-src/src/pages/mistakes.ts`、`app-src/src/pages/report.ts`、`app-src/src/pages/settings.ts`
- Modify: `app-src/src/main.ts`（启动时播种题库）

- [ ] **Step 1: 实现 `app-src/src/pages/today.ts`**

```ts
import type { PageRenderer } from '../router'
import { navigate } from '../router'
import { SPECIALS } from '../content/sets'
import { fetchContentBundle, findVocabUnit } from '../content/loader'
import { getSettings, listAttempts } from '../db/repos'
import { computeCoreMetrics, isSameLocalDay, localDayKey } from '../domain/metrics'

export const renderToday: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>今日学习</h1><p class="muted">加载中…</p>'
  const [settings, attempts, bundle] = await Promise.all([
    getSettings(),
    listAttempts(),
    fetchContentBundle().catch(() => undefined),
  ])
  if (stale) return
  const today = localDayKey()
  const todayAttempts = attempts.filter((a) => isSameLocalDay(a.submittedAt, today))
  const m = computeCoreMetrics(todayAttempts)

  const vocabUnit = findVocabUnit(bundle?.vocab ?? { units: [], book: '', contentVersion: '' }, settings.currentUnit)
  const cards = [
    ...SPECIALS.map((s) => {
      const count = bundle?.questions.filter((q) => q.unit.startsWith(s.id)).length ?? 0
      return {
        title: s.title,
        desc: `${count} 题`,
        action: () => navigate('exercise', { special: s.id }),
      }
    }),
    {
      title: `单词默写 · ${vocabUnit?.label ?? settings.currentUnit}`,
      desc: `${vocabUnit?.words.length ?? 0} 个单词 · 中→英`,
      action: () => navigate('exercise', { vocab: settings.currentUnit }),
    },
  ]

  container.innerHTML = `
    <h1>今日学习</h1>
    <div class="card">
      <h3>今天已练 ${todayAttempts.length} 题</h3>
      <p>${m.firstTryCorrectRate === null ? '暂无首测数据' : `首测正确率 ${Math.round(m.firstTryCorrectRate * 100)}%`}</p>
    </div>
    ${cards
      .map(
        (c, i) => `
    <div class="card">
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="action-row"><button class="btn" data-card="${i}">开始练习</button></div>
    </div>`,
      )
      .join('')}
    <p class="muted">学习计划自动生成与到期复习将在后续版本提供。</p>`
  for (const btn of container.querySelectorAll<HTMLButtonElement>('button[data-card]')) {
    btn.addEventListener('click', () => cards[Number(btn.dataset.card)]?.action())
  }
  window.removeEventListener('hashchange', onHashChange)
}
```

> 注：专项题数按 `Question.unit` 前缀实算（`g7a-present` 命中 `g7a-present-l1`…，与 `questionsByUnitPrefix` 同语义）；题库加载失败时降级为 0 题。卡片描述只报题数，不再硬编码级别数。四页均在 await 后以 `stale` 守卫失效渲染（切路由期间旧渲染不覆盖新页面）。

- [ ] **Step 2: 实现 `app-src/src/pages/mistakes.ts`**

```ts
import type { PageRenderer } from '../router'
import { listAttempts, listAllQuestions } from '../db/repos'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

export const renderMistakes: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>错题本</h1><p class="muted">加载中…</p>'
  const [attempts, questions] = await Promise.all([listAttempts(), listAllQuestions()])
  if (stale) return
  const qMap = new Map(questions.map((q) => [q.id, q]))
  const wrong = attempts.filter((a) => !a.isCorrect)
  if (wrong.length === 0) {
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>错题本</h1><div class="card"><p>还没有错题记录。先去今日学习做几道题吧。</p></div>'
    return
  }
  const items = wrong.map((a) => {
    const q = qMap.get(a.questionId)
    return {
      attempt: a,
      question: q,
      kp: q?.knowledgePointIds[0] ?? '未知知识点',
      time: a.submittedAt,
    }
  })
  items.sort((x, y) => (x.time < y.time ? 1 : -1))
  container.innerHTML = `
    <h1>错题本</h1>
    <p class="muted">共 ${wrong.length} 条错误作答。复测排期将在后续版本提供。</p>
    ${items
      .map(
        (it) => `
    <div class="card">
      <p><span class="badge">${escapeHtml(it.kp)}</span><span class="muted">${formatTime(it.time)}${it.attempt.phase === 'retry' ? ' · 复测' : ' · 首测'}</span></p>
      <h3>${escapeHtml(it.question?.stem ?? it.attempt.questionId)}</h3>
      ${it.question?.type === 'single_choice' && it.attempt.answer !== '' ? `<p class="muted">你的答案：${escapeHtml(it.question.options?.[Number(it.attempt.answer)] ?? it.attempt.answer)}</p>` : `<p class="muted">你的答案：${escapeHtml(it.attempt.answer || '（未作答）')}</p>`}
      <p>正确答案：<strong>${escapeHtml(it.question?.options?.[it.question?.answerSpec.correctOptionIndex ?? 0] ?? it.question?.answerSpec.acceptedAnswers?.[0] ?? '—')}</strong></p>
      <p>${escapeHtml(it.question?.explanation ?? '')}</p>
    </div>`,
      )
      .join('')}`
  window.removeEventListener('hashchange', onHashChange)
}
```

- [ ] **Step 3: 实现 `app-src/src/pages/report.ts`**

```ts
import type { PageRenderer } from '../router'
import { listAttempts, listAllQuestions } from '../db/repos'
import { computeCoreMetrics, localDayKey, isSameLocalDay } from '../domain/metrics'

function pct(rate: number | null): string {
  return rate === null ? '暂无数据' : `${Math.round(rate * 100)}%`
}

export const renderReport: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>学习报告</h1><p class="muted">加载中…</p>'
  const [attempts, questions] = await Promise.all([listAttempts(), listAllQuestions()])
  if (stale) return
  const m = computeCoreMetrics(attempts)
  const qMap = new Map(questions.map((q) => [q.id, q]))
  // 词汇题为运行时由 vocab.json 派生，不在 questions 表中，按作答的题目 ID 前缀分类
  const vocabAttempts = attempts.filter((a) => a.questionId.startsWith('g7a-vocab-'))
  const grammarAttempts = attempts.filter((a) => !a.questionId.startsWith('g7a-vocab-'))
  const todayCount = attempts.filter((a) => isSameLocalDay(a.submittedAt, localDayKey())).length
  const vocabWrong = [...new Set(vocabAttempts.filter((a) => !a.isCorrect).map((a) => a.questionId))]

  container.innerHTML = `
    <h1>学习报告</h1>
    <div class="card">
      <h3>总体</h3>
      <ul class="list">
        <li>累计作答：${m.totalAttempts} 次（今日 ${todayCount} 次）</li>
        <li>首测正确率：${pct(m.firstTryCorrectRate)}（${m.firstCorrect}/${m.firstAttempts}）</li>
        <li>复测正确率：${pct(m.retryAttempts > 0 ? m.retryCorrect / m.retryAttempts : null)}（${m.retryCorrect}/${m.retryAttempts}）</li>
        <li>曾做错题目：${m.wrongQuestions} 道</li>
      </ul>
    </div>
    <div class="card">
      <h3>语法专项</h3>
      <ul class="list">
        <li>作答 ${grammarAttempts.length} 次</li>
        <li>首测正确率：${pct(computeCoreMetrics(grammarAttempts).firstTryCorrectRate)}</li>
      </ul>
    </div>
    <div class="card">
      <h3>单词默写</h3>
      <ul class="list">
        <li>作答 ${vocabAttempts.length} 次</li>
        <li>首测正确率：${pct(computeCoreMetrics(vocabAttempts).firstTryCorrectRate)}</li>
      </ul>
      ${vocabWrong.length > 0 ? `<p class="muted">易错词：${vocabWrong.map((id) => qMap.get(id)?.answerSpec.acceptedAnswers?.[0] ?? id).slice(0, 12).join('、')}${vocabWrong.length > 12 ? '…' : ''}</p>` : ''}
    </div>
    <p class="muted">七天趋势与薄弱点排行将在后续版本提供。</p>`
  window.removeEventListener('hashchange', onHashChange)
}
```

- [ ] **Step 4: 实现设置页基础（备份按钮 Task 11 接入）`app-src/src/pages/settings.ts`**

```ts
import type { PageRenderer } from '../router'
import { getSettings, saveSettings } from '../db/repos'
import { fetchContentBundle } from '../content/loader'
import type { Settings } from '../types'

export const renderSettings: PageRenderer = async ({ container }) => {
  let stale = false
  const onHashChange = () => { stale = true }
  window.addEventListener('hashchange', onHashChange, { once: true })
  container.innerHTML = '<h1>家长设置</h1><p class="muted">加载中…</p>'
  const [settings, bundle] = await Promise.all([
    getSettings(),
    fetchContentBundle().catch(() => undefined),
  ])
  if (stale) return
  const units = bundle?.vocab.units ?? []
  const message = document.createElement('p')

  container.innerHTML = `
    <h1>家长设置</h1>
    <div class="card">
      <div class="form-row">
        <label for="set-unit">单词默写当前单元</label>
        <select id="set-unit">
          ${units.map((u) => `<option value="${u.id}" ${u.id === settings.currentUnit ? 'selected' : ''}>${u.label}（${u.words.length} 词）</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label for="set-minutes">每日学习时长（分钟，20–45）</label>
        <input id="set-minutes" type="number" min="20" max="45" step="5" value="${settings.dailyMinutes}">
      </div>
      <div class="form-row">
        <label for="set-days">每周学习天数（1–7）</label>
        <input id="set-days" type="number" min="1" max="7" value="${settings.studyDaysPerWeek}">
      </div>
      <div class="form-row">
        <label for="set-ai">AI 讲解（联网调用外部 AI 服务，当前版本仅保存配置）</label>
        <input id="set-ai" type="checkbox" ${settings.aiEnabled ? 'checked' : ''}>
      </div>
      <div class="action-row"><button class="btn" id="save">保存设置</button></div>
    </div>
    <div id="backup-slot"></div>
  `
  container.appendChild(message)

  container.querySelector('#save')?.addEventListener('click', async () => {
    const next: Settings = {
      ...settings,
      currentUnit: (container.querySelector<HTMLSelectElement>('#set-unit')?.value || settings.currentUnit),
      dailyMinutes: clamp(Number(container.querySelector<HTMLInputElement>('#set-minutes')?.value), 20, 45),
      studyDaysPerWeek: clamp(Number(container.querySelector<HTMLInputElement>('#set-days')?.value), 1, 7),
      aiEnabled: container.querySelector<HTMLInputElement>('#set-ai')?.checked ?? false,
    }
    await saveSettings(next)
    if (stale) return
    message.textContent = '已保存。'
  })
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
```

- [ ] **Step 5: `main.ts` 启动播种 + 加载失败兜底**

替换 `app-src/src/main.ts`：

```ts
import { startRouter } from './router'
import { fetchContentBundle } from './content/loader'
import { seedContent } from './content/seed'
import { renderToday } from './pages/today'
import { renderExercise } from './pages/exercise'
import { renderMistakes } from './pages/mistakes'
import { renderReport } from './pages/report'
import { renderSettings } from './pages/settings'

const container = document.querySelector<HTMLElement>('#app')
if (!container) throw new Error('缺少 #app 容器')
startRouter(
  {
    today: renderToday,
    exercise: renderExercise,
    mistakes: renderMistakes,
    report: renderReport,
    settings: renderSettings,
  },
  container,
)
// 路由先行渲染，播种在后台完成；失败不阻塞做题以外页面
void fetchContentBundle()
  .then((bundle) => seedContent(bundle))
  .catch((err) => console.error('题库播种失败：', err))
```

（Task 11 Step 2 会把该播种改为按存储可用性 gating，Task 12 保持不变。）

- [ ] **Step 6: 类型检查、测试、构建**

Run: `npm --prefix app-src run build && npm --prefix app-src run test`
Expected: tsc 无错误、全部测试 PASS、构建成功

- [ ] **Step 7: 浏览器验证**

dev server 下逐页检查：
1. `#/today`：显示今日统计 + 5 张练习卡片（4 专项 + 当前单元默写）
2. 做错 2 题后 `#/mistakes`：错题卡片显示题干、你的答案、正确答案、解析、首测/复测标记
3. `#/report`：总体/语法/默写三卡片数据与实际作答一致
4. `#/settings`：改单元与时长 → 保存 → 刷新后值保留；今日学习默写卡片跟随新单元

- [ ] **Step 8: 提交**

```bash
git add app-src/src
git commit -m "feat(app): 今日学习/错题本/报告/设置页面，启动播种题库

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**已知局限（M2 处理）：**
- 词汇默写题运行时派生、不入 questions 表：错题本对词汇题显示 questionId 作题干、正确答案"—"，报告"易错词"显示原始 ID。修复方向：两页从 bundle 派生词汇题建补充 qMap，或播种时写入词汇题。
- ~~today/report/settings 页对内容 JSON 来源字符串（u.label、acceptedAnswers、currentUnit）未做 HTML 转义~~：已在 Task 12 审查修复中补齐（escapeHtml 抽取为 `ui/escape.ts` 共享模块，导入可达字段全部转义），此条关闭。

---

### Task 11: 存储不可用降级（规格 §3）

隐私模式等场景下 IndexedDB 打不开：应用不崩溃，做题仍可用（记录不保存，页面明确提示）。纯降级路径无单测，以代码结构与浏览器验证为准。

除记录写入降级外，专项练习的题源（IndexedDB）与 settings 页的读取同样需要兜底，否则存储不可用时专项页显示"暂无题目"、settings 卡在"加载中…"，与规格 §3 冲突。

**Files:**
- Create: `app-src/src/db/availability.ts`
- Modify: `app-src/src/main.ts`、`app-src/src/pages/exercise.ts`、`app-src/src/pages/today.ts`、`app-src/src/pages/mistakes.ts`、`app-src/src/pages/report.ts`、`app-src/src/pages/settings.ts`

- [ ] **Step 1: 创建 `app-src/src/db/availability.ts`**

```ts
import { db } from './schema'

let probed: Promise<boolean> | undefined

/** 探测 IndexedDB 可用性（结果缓存，全程只探测一次） */
export function isStorageAvailable(): Promise<boolean> {
  probed ??= (async () => {
    try {
      await db.open()
      return db.isOpen()
    } catch {
      return false
    }
  })()
  return probed
}
```

- [ ] **Step 2: `main.ts` 顶部横幅**

import 置顶，在 `startRouter(...)` 之前插入：

```ts
import { isStorageAvailable } from './db/availability'

// ...
void isStorageAvailable().then((ok) => {
  if (!ok) {
    const banner = document.createElement('div')
    banner.className = 'error-panel'
    banner.setAttribute('role', 'status')
    banner.textContent = '无法保存学习记录（浏览器存储不可用）。可以继续练习，但刷新后记录不会保留。'
    container.prepend(banner)
    // 页面渲染会整体替换 container.innerHTML，横幅需在每次渲染后重新置顶
    const observer = new MutationObserver(() => {
      if (!banner.isConnected) container.prepend(banner)
    })
    observer.observe(container, { childList: true })
  }
})
```

同时把启动播种改为按存储可用性 gating（隐私模式不白跑 seedContent）：

```ts
void isStorageAvailable()
  .then((ok) => (ok ? fetchContentBundle().then(seedContent) : undefined))
  .catch((err) => console.error('题库播种失败：', err))
```

- [ ] **Step 3: `exercise.ts` 降级注入与专项题源回退**

专项练习题来自 `questionsByUnitPrefix`（IndexedDB）。存储不可用时改为从内容 bundle 前缀过滤，保证专项练习仍可做题：

```ts
import { isStorageAvailable } from '../db/availability'

async function loadQuestions(params: URLSearchParams): Promise<{ title: string; questions: Question[] }> {
  const vocabUnit = params.get('vocab')
  if (vocabUnit) {
    const bundle = await fetchContentBundle()
    const unit = bundle.vocab.units.find((u) => u.id === vocabUnit)
    return { title: `单词默写 · ${unit?.label ?? vocabUnit}`, questions: shuffle(deriveVocabQuestions(bundle.vocab, vocabUnit)) }
  }
  const special = params.get('special')
  if (special) {
    const storageOk = await isStorageAvailable()
    if (storageOk) {
      const questions = await questionsByUnitPrefix(special)
      return { title: '专项练习', questions: shuffle(questions) }
    }
    const bundle = await fetchContentBundle()
    const questions = bundle.questions.filter((q) => q.unit.startsWith(special))
    return { title: '专项练习', questions: shuffle(questions) }
  }
  return { title: '练习', questions: [] }
}
```

`start()` 的数据加载阶段探测存储（与 stale 守卫协调），并按探测结果替换 session 依赖：

```ts
    let data: { title: string; questions: Question[] }
    let storageOk = false
    try {
      storageOk = await isStorageAvailable()
      data = await loadQuestions(params)
    } catch (err) {
      window.removeEventListener('hashchange', onHashChange)
      if (stale) return
      container.innerHTML = `<h1>学习练习</h1><div class="error-panel">题库加载失败：${escapeHtml(String(err))}<div class="action-row"><button class="btn" id="retry">重试</button></div></div>`
      container.querySelector('#retry')?.addEventListener('click', () => void start())
      return
    }
    if (stale) return
    if (data.questions.length === 0) {
      window.removeEventListener('hashchange', onHashChange)
      container.innerHTML = `<h1>学习练习</h1><div class="card"><h3>${escapeHtml(data.title)}</h3><p>该内容暂无题目。</p><div class="action-row"><button class="btn btn-secondary" id="back">返回今日学习</button></div></div>`
      container.querySelector('#back')?.addEventListener('click', () => navigate('today'))
      return
    }

    const session = new PracticeSession(data.questions, {
      hasPriorAttempt: storageOk ? hasPriorAttempt : async () => false,
      recordAttempt: storageOk
        ? saveAttempt
        : async (a) => console.warn('存储不可用，跳过记录：', a.questionId),
    })
```

并在 `renderQuestion` 模板的 `<p class="muted">第 … 题</p>` 后追加：`${storageOk ? '' : '<p class="muted">存储不可用，本次练习不会保存记录。</p>'}`

- [ ] **Step 4: today / mistakes / report 页 DB 读取兜底**

三页把现有的数据读取段包进 try/catch（保留 bundle fetch 自身的 catch；catch 内同样先做 stale 守卫并移除哈希监听）：

today 页：

```ts
  let settings: Awaited<ReturnType<typeof getSettings>>
  let attempts: Awaited<ReturnType<typeof listAttempts>>
  let bundle: Awaited<ReturnType<typeof fetchContentBundle>> | undefined
  try {
    [settings, attempts, bundle] = await Promise.all([
      getSettings(),
      listAttempts(),
      fetchContentBundle().catch(() => undefined),
    ])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>今日学习</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
```

mistakes 页（report 同构，替换标题与错误文案）：

```ts
  let attempts: Awaited<ReturnType<typeof listAttempts>> = []
  let questions: Awaited<ReturnType<typeof listAllQuestions>> = []
  try {
    [attempts, questions] = await Promise.all([listAttempts(), listAllQuestions()])
  } catch {
    if (stale) return
    window.removeEventListener('hashchange', onHashChange)
    container.innerHTML = '<h1>错题本</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>'
    return
  }
```

report 页：同上，错误文案 `<h1>学习报告</h1><div class="error-panel" role="alert">无法读取学习记录（浏览器存储不可用）。</div>`。

- [ ] **Step 5: `settings.ts` 读取与保存兜底**

`getSettings()` 失败时使用 `DEFAULT_SETTINGS` 并显示提示，避免隐私模式下卡在"加载中…"：

```ts
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../db/repos'

// ...
  const bundlePromise = fetchContentBundle().catch(() => undefined)
  let settings: Settings
  let storageError = false
  try {
    settings = await getSettings()
  } catch {
    storageError = true
    settings = DEFAULT_SETTINGS
  }
  const bundle = await bundlePromise
  if (stale) return
```

模板在 `<h1>家长设置</h1>` 后插入提示行：

```ts
    ${storageError ? '<div class="error-panel" role="alert">无法读取设置（浏览器存储不可用）。</div>' : ''}
```

保存处理器包 try/catch，失败时替换成功提示、不静默吞错：

```ts
  container.querySelector('#save')?.addEventListener('click', async () => {
    const next: Settings = {
      ...settings,
      currentUnit: (container.querySelector<HTMLSelectElement>('#set-unit')?.value || settings.currentUnit),
      dailyMinutes: clamp(Number(container.querySelector<HTMLInputElement>('#set-minutes')?.value), 20, 45),
      studyDaysPerWeek: clamp(Number(container.querySelector<HTMLInputElement>('#set-days')?.value), 1, 7),
      aiEnabled: container.querySelector<HTMLInputElement>('#set-ai')?.checked ?? false,
    }
    try {
      await saveSettings(next)
      if (stale) return
      message.textContent = '已保存。'
    } catch {
      if (stale) return
      message.textContent = '保存失败，存储不可用。'
    }
  })
```

- [ ] **Step 6: 构建、测试、提交**

Run: `npm --prefix app-src run build && npm --prefix app-src run test`
Expected: 通过（降级路径不影响既有测试）

```bash
git add app-src/src docs/superpowers/plans/2026-11-16-m0-m1-local-core.md app
git commit -m "feat(app): 存储不可用时降级——可做题不保存，页面明确提示

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: 备份导出/导入（DEV-09）

**Files:**
- Create: `app-src/src/services/backup/index.ts`
- Test: `app-src/src/services/backup/index.test.ts`
- Modify: `app-src/src/pages/settings.ts`（接入导出/导入 UI）

- [ ] **Step 1: 写失败测试 `app-src/src/services/backup/index.test.ts`**

```ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/schema'
import { exportBackup, parseAndValidateBackup, importBackup, BackupError, type BackupFile } from './index'
import { saveAttempt, saveSettings, upsertQuestions, DEFAULT_SETTINGS } from '../../db/repos'
import { computeCoreMetrics } from '../../domain/metrics'
import type { Attempt, Question } from '../../types'

const q = (id: string): Question => ({
  id,
  contentVersion: 'v',
  grade: 7,
  term: 'A',
  unit: 'u',
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

const attempt = (id: string, questionId: string, isCorrect: boolean, phase: 'first' | 'retry'): Attempt => ({
  id,
  questionId,
  answer: '0',
  isCorrect,
  phase,
  submittedAt: '2026-11-16T10:00:00.000Z',
})

beforeEach(async () => {
  await Promise.all([
    db.settings.clear(),
    db.questions.clear(),
    db.attempts.clear(),
    db.mastery.clear(),
    db.weeklyReports.clear(),
    db.contentMeta.clear(),
  ])
})

describe('parseAndValidateBackup', () => {
  it('非 JSON 拒绝', () => {
    expect(() => parseAndValidateBackup('not json')).toThrow()
  })
  it('schemaVersion 不符拒绝', () => {
    const file = JSON.stringify({ schemaVersion: 99, data: {} })
    expect(() => parseAndValidateBackup(file)).toThrow(/版本/)
  })
  it('counts 与数据不一致拒绝', () => {
    const file = JSON.stringify({ schemaVersion: 1, app: 'english-coach', exportedAt: 'x', counts: { attempts: 5 }, data: { attempts: [] } })
    expect(() => parseAndValidateBackup(file)).toThrow()
  })
  it('表内重复主键拒绝', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 2, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: { settings: [], contentMeta: [], questions: [q('x1'), q('x1')], attempts: [], mastery: [], weeklyReports: [] },
    })
    expect(() => parseAndValidateBackup(file)).toThrow(/重复主键/)
  })
  it('注入载荷原样保留在错误消息中（由 UI 转义）', () => {
    const file = JSON.stringify({ schemaVersion: '<img src=x onerror=alert(1)>', data: {} })
    let caught: unknown
    try {
      parseAndValidateBackup(file)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BackupError)
    expect((caught as Error).message).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('导出→清空→导入（T08）', () => {
  it('记录数与指标一致', async () => {
    await upsertQuestions([q('q1'), q('q2')])
    await saveSettings({ ...DEFAULT_SETTINGS, dailyMinutes: 25 })
    await saveAttempt(attempt('a1', 'q1', true, 'first'))
    await saveAttempt(attempt('a2', 'q2', false, 'first'))

    const backup = await exportBackup()
    expect(backup.counts.attempts).toBe(2)

    // 清空（模拟新设备）
    await Promise.all([db.attempts.clear(), db.questions.clear(), db.settings.clear()])

    const text = JSON.stringify(backup)
    const parsed = parseAndValidateBackup(text)
    const result = await importBackup(parsed, 'overwrite')
    expect(result.attemptsAdded).toBe(2)

    const attempts = await db.attempts.toArray()
    expect(computeCoreMetrics(attempts)).toEqual(computeCoreMetrics([attempt('a1', 'q1', true, 'first'), attempt('a2', 'q2', false, 'first')]))
    expect(await db.questions.count()).toBe(2)
    expect((await db.settings.get('app'))?.value.dailyMinutes).toBe(25)
  })

  it('合并模式不覆盖已有 attempt 历史', async () => {
    await saveAttempt(attempt('a1', 'q1', false, 'first'))
    const backup = await exportBackup()
    await saveAttempt(attempt('a2', 'q2', true, 'first'))

    const result = await importBackup(backup, 'merge')
    expect(result.attemptsAdded).toBe(0)
    expect(result.attemptsSkipped).toBe(1)
    // 本地 a2 仍在
    expect(await db.attempts.count()).toBe(2)
  })
})

describe('覆盖导入事务性', () => {
  it('中途失败回滚，不清空本地数据', async () => {
    await upsertQuestions([q('local-q')])
    await saveAttempt(attempt('local-a1', 'local-q', true, 'first'))

    const file: BackupFile = {
      schemaVersion: 1,
      app: 'english-coach',
      exportedAt: 'x',
      counts: { settings: 0, contentMeta: 0, questions: 2, attempts: 0, mastery: 0, weeklyReports: 0 },
      data: {
        settings: [],
        contentMeta: [],
        questions: [q('x1'), q('x1')],
        attempts: [],
        mastery: [],
        weeklyReports: [],
      },
    }

    await expect(importBackup(file, 'overwrite')).rejects.toThrow()
    expect(await db.attempts.count()).toBe(1)
    expect(await db.attempts.get('local-a1')).toBeDefined()
    expect(await db.questions.get('local-q')).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix app-src run test -- backup`
Expected: FAIL，`Cannot find module './index'`（目录不存在）

- [ ] **Step 3: 实现 `app-src/src/services/backup/index.ts`**

```ts
import { db, type ContentMetaRow, type SettingsRow, type WeeklyReportRow } from '../../db/schema'
import type { Attempt, Mastery, Question } from '../../types'

export const BACKUP_SCHEMA_VERSION = 1

export class BackupError extends Error {}

export interface BackupCounts {
  settings: number
  contentMeta: number
  questions: number
  attempts: number
  mastery: number
  weeklyReports: number
}

export interface BackupFile {
  schemaVersion: number
  app: 'english-coach'
  exportedAt: string
  counts: BackupCounts
  data: {
    settings: SettingsRow[]
    contentMeta: ContentMetaRow[]
    questions: Question[]
    attempts: Attempt[]
    mastery: Mastery[]
    weeklyReports: WeeklyReportRow[]
  }
}

export async function exportBackup(): Promise<BackupFile> {
  const [settings, contentMeta, questions, attempts, mastery, weeklyReports] = await Promise.all([
    db.settings.toArray(),
    db.contentMeta.toArray(),
    db.questions.toArray(),
    db.attempts.toArray(),
    db.mastery.toArray(),
    db.weeklyReports.toArray(),
  ])
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'english-coach',
    exportedAt: new Date().toISOString(),
    counts: {
      settings: settings.length,
      contentMeta: contentMeta.length,
      questions: questions.length,
      attempts: attempts.length,
      mastery: mastery.length,
      weeklyReports: weeklyReports.length,
    },
    data: { settings, contentMeta, questions, attempts, mastery, weeklyReports },
  }
}

export function parseAndValidateBackup(text: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupError('不是有效的 JSON 文件')
  }
  const file = parsed as Partial<BackupFile>
  if (file.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupError(`备份版本不支持（${String(file.schemaVersion)}，本应用支持 ${BACKUP_SCHEMA_VERSION}）`)
  }
  if (!file.data || typeof file.data !== 'object') throw new BackupError('备份缺少 data 字段')
  const d = file.data
  for (const key of ['settings', 'contentMeta', 'questions', 'attempts', 'mastery', 'weeklyReports'] as const) {
    if (!Array.isArray(d[key])) throw new BackupError(`备份缺少 ${key} 数据`)
  }
  if (!file.counts || typeof file.counts !== 'object') throw new BackupError('备份缺少 counts 字段')
  for (const [key, value] of Object.entries(file.counts)) {
    const actual = (d as Record<string, unknown[]>)[key]?.length ?? 0
    if (value !== actual) throw new BackupError(`counts.${key}（${value}）与实际数据（${actual}）不一致`)
  }
  const primaryKeys: Array<[keyof BackupFile['data'], string]> = [
    ['settings', 'key'],
    ['contentMeta', 'contentId'],
    ['questions', 'id'],
    ['attempts', 'id'],
    ['mastery', 'knowledgePointId'],
    ['weeklyReports', 'weekStart'],
  ]
  for (const [table, key] of primaryKeys) {
    const seen = new Set<unknown>()
    for (const row of d[table] as unknown as Array<Record<string, unknown>>) {
      const id = row[key]
      if (seen.has(id)) throw new BackupError(`备份 ${table} 表存在重复主键：${String(id)}`)
      seen.add(id)
    }
  }
  for (const a of d.attempts ?? []) {
    if (!a.id || !a.questionId || typeof a.isCorrect !== 'boolean' || (a.phase !== 'first' && a.phase !== 'retry')) {
      throw new BackupError(`存在非法 attempt 记录：${JSON.stringify(a).slice(0, 120)}`)
    }
  }
  return { ...(file as BackupFile), data: d }
}

export interface ImportSummary {
  attemptsAdded: number
  attemptsSkipped: number
}

export async function importBackup(file: BackupFile, mode: 'merge' | 'overwrite'): Promise<ImportSummary> {
  if (mode === 'overwrite') {
    return db.transaction(
      'rw',
      [db.settings, db.contentMeta, db.questions, db.attempts, db.mastery, db.weeklyReports],
      async () => {
        await Promise.all([
          db.settings.clear(),
          db.contentMeta.clear(),
          db.questions.clear(),
          db.attempts.clear(),
          db.mastery.clear(),
          db.weeklyReports.clear(),
        ])
        await db.settings.bulkAdd(file.data.settings)
        await db.contentMeta.bulkAdd(file.data.contentMeta)
        await db.questions.bulkAdd(file.data.questions)
        await db.mastery.bulkAdd(file.data.mastery)
        await db.weeklyReports.bulkAdd(file.data.weeklyReports)
        await db.attempts.bulkAdd(file.data.attempts)
        return { attemptsAdded: file.data.attempts.length, attemptsSkipped: 0 }
      },
    )
  }
  // 合并：题目/元数据 upsert；attempts 只补缺失，绝不改写历史；settings 跳过已有键
  await db.contentMeta.bulkPut(file.data.contentMeta)
  await db.questions.bulkPut(file.data.questions)
  await db.mastery.bulkPut(file.data.mastery)
  await db.weeklyReports.bulkPut(file.data.weeklyReports)
  const existingKeys = await db.settings.bulkGet(file.data.settings.map((r) => r.key))
  const newSettings = file.data.settings.filter((_, i) => existingKeys[i] === undefined)
  if (newSettings.length > 0) await db.settings.bulkAdd(newSettings)
  const existingAttempts = await db.attempts.bulkGet(file.data.attempts.map((a) => a.id))
  const missing = file.data.attempts.filter((_, i) => existingAttempts[i] === undefined)
  if (missing.length > 0) await db.attempts.bulkAdd(missing)
  return { attemptsAdded: missing.length, attemptsSkipped: file.data.attempts.length - missing.length }
}

export function backupFileName(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `english-learning-backup-${y}${m}${d}.json`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix app-src run test -- backup`
Expected: 8 个测试 PASS

- [ ] **Step 5: 设置页接入备份 UI**

在 `app-src/src/pages/settings.ts` 的 `container.innerHTML` 模板中 `</div>`（设置卡片结束）与 `<div id="backup-slot">` 之间加入备份卡片：

```ts
  import { exportBackup, parseAndValidateBackup, importBackup, backupFileName, BackupError } from '../services/backup/index'

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  }
```

模板中追加（放在 `<div id="backup-slot"></div>` 位置，替换之）：

```html
    <div class="card">
      <h3>备份与恢复</h3>
      <p>导出全部学习记录为 JSON 文件；恢复时先校验再写入，合并模式不会改写已有历史。</p>
      <div class="action-row">
        <button class="btn" id="backup-export">导出备份</button>
        <label class="btn btn-secondary" style="display:inline-flex;align-items:center">导入备份
          <input type="file" id="backup-import" accept="application/json,.json" style="display:none">
        </label>
      </div>
      <div id="backup-preview"></div>
    </div>
```

事件绑定（放在保存设置监听之后）：

```ts
  container.querySelector('#backup-export')?.addEventListener('click', async () => {
    const preview = container.querySelector('#backup-preview')
    if (!preview) return
    try {
      const file = await exportBackup()
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backupFileName()
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      preview.innerHTML = '<div class="error-panel">导出失败，存储不可用。</div>'
    }
  })

  container.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement
    const preview = container.querySelector('#backup-preview')
    if (!preview) return
    const file = input.files?.[0]
    if (!file) return
    input.value = ''
    let parsed
    try {
      parsed = parseAndValidateBackup(await file.text())
    } catch (err) {
      preview.innerHTML = `<div class="error-panel">导入失败：${escapeHtml(err instanceof BackupError ? err.message : '文件无法解析')}</div>`
      return
    }
    preview.innerHTML = `
      <p>该备份包含 ${parsed.counts.attempts} 条作答、${parsed.counts.questions} 道题、${parsed.counts.settings} 条设置（导出于 ${new Date(parsed.exportedAt).toLocaleString('zh-CN')}）。</p>
      <div class="action-row">
        <button class="btn" id="backup-merge">合并导入（保留本地已有记录）</button>
        <button class="btn btn-secondary" id="backup-overwrite">覆盖导入（清空后恢复）</button>
      </div>`
    const run = async (mode: 'merge' | 'overwrite') => {
      try {
        const result = await importBackup(parsed, mode)
        preview.innerHTML = `<p>导入完成：新增作答 ${result.attemptsAdded} 条${result.attemptsSkipped > 0 ? `，跳过已存在 ${result.attemptsSkipped} 条` : ''}。</p>`
      } catch {
        preview.innerHTML = '<div class="error-panel">导入失败：存储不可用。</div>'
      }
    }
    preview.querySelector('#backup-merge')?.addEventListener('click', () => void run('merge'))
    preview.querySelector('#backup-overwrite')?.addEventListener('click', () => void run('overwrite'))
  })
```

- [ ] **Step 6: 测试、构建、浏览器验证**

Run: `npm --prefix app-src run test && npm --prefix app-src run build`
浏览器：`#/settings` → 导出备份（下载 JSON）→ DevTools 清空 EnglishCoachDB 各表 → 导入刚下载的文件 → 覆盖导入 → `#/report` 数据恢复一致。

- [ ] **Step 7: 提交**

```bash
git add app-src/src
git commit -m "feat(app): 备份导出/校验/导入（合并与覆盖），attempts 历史不可改写

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**审查修复记录（2026-11-17，整体审查 Important×2）：**

1. **转义 sink**：备份导入可把任意 settings/questions/attempts 行写入本地，此前 report.ts（易错词兜底 `id` 与 `acceptedAnswers`）、today.ts（`currentUnit` 兜底）、settings.ts（`u.id`/`u.label`、`dailyMinutes`/`studyDaysPerWeek` 的 value 属性注入）三处插值未转义，构成存储型 XSS。修复：escapeHtml 从 mistakes/exercise/settings 三页抽取为共享模块 `app-src/src/ui/escape.ts`（原使用处改为 import），三页所有可达自导入数据的插值补转义。
2. **导入行校验**：`parseAndValidateBackup` 原先只校验 attempts 行，settings/questions/mastery 行原样入库。补齐三表行形状与字段类型校验（对齐 schema/接口：settings 需 `key`/`updatedAt`/`value` 及宽松字段类型，questions 需 `id`/`type`/`stem`/`explanation`/`knowledgePointIds`/`answerSpec`，mastery 需 `knowledgePointId`/`stage`/`metrics`），非法行抛 BackupError 并带表名与行号（从 1 计）。
3. **合并事务**：`importBackup` 合并路径的 bulkPut/bulkAdd 顺序写入无事务，中途失败会留下部分写入。已参照覆盖路径用 `db.transaction('rw', [...六表], ...)` 把全部合并写入包进同一事务（回调内仅 Dexie 表操作）。

新增测试 6 例：settings 缺 key / value 非对象、questions 缺 id、mastery stage 非法、含 `<img onerror>` questionId 的合法 attempt 可导入（转义在展示层）、合并导入中途失败回滚。

---

### Task 13: 原站入口、CI 适配、构建发布与验收

**Files:**
- Modify: `index.html`（导航加入口）
- Modify: `.github/workflows/ci.yml`（HTML 扫描排除）
- Modify: `package.json`（htmlvalidate 脚本本地版对齐 CI 排除）
- Generate: `app/`（最终构建产物）

- [ ] **Step 1: 原站首页加学习助手入口**

查看 `index.html` 的 `<nav class="site-nav …">`，在"背单词"或"搜索"链接旁加：

```html
      <a href="app/">学习助手</a>
```

（注意与既有链接风格、顺序保持一致；check_site.py 会校验 `app/index.html` 存在。）

- [ ] **Step 2: CI HTML 扫描排除新目录**

`.github/workflows/ci.yml` 的 find 命令改为（新增两行排除）：

```yaml
          find . -name "*.html" \
            -not -path "./node_modules/*" \
            -not -path "./.git/*" \
            -not -path "./artifacts/*" \
            -not -path "./app-src/node_modules/*" \
            -not -path "./app/*" | sort > /tmp/hv-files.txt
```

`package.json` 的 `htmlvalidate` 脚本对齐同一排除（避免本地误扫 app-src 依赖里的 HTML）：

```json
"htmlvalidate": "html-validate $(find . -name '*.html' -not -path './node_modules/*' -not -path './.git/*' -not -path './artifacts/*' -not -path './app-src/node_modules/*' -not -path './app/*' | sort)"
```

- [ ] **Step 3: 全量本地检查**

依次运行（根目录）：

```bash
npm install --no-audit --no-fund        # 仅根 CI 依赖（如已装可跳过）
npm run htmlvalidate
python3 scripts/check_site.py
npm run test:extract
npm run test:app
npm run build:app
```

Expected:
- htmlvalidate 无 error
- check_site.py 退出码 0；若 `app/` 或 `app-src/` 触发问题（如绝对路径 /english-materials/app/... 的链接映射），据实修复：属应用自身问题的改应用文件；属扫描器应跳过的目录，在 `scripts/check_site.py` 的 `SKIP_DIRS` 增加 `"app-src"` 与 `"app"` 并在 commit message 说明原因
- 两个测试套件全绿
- 构建产物更新到 `app/`

- [ ] **Step 4: 浏览器终验（对照规格 §4 验收清单）**

后台 `npm run dev:app`，浏览器逐项验证：

1. `#/today` → 点"一般现在时与句子种类"开始 → 完成 48 题中的前几题（含做错、我不会）
2. 刷新页面（F5）→ `#/today` 今日统计仍在、`#/mistakes` 错题仍在（数据不丢）
3. 同一题再练一次 → attempts 中出现 phase=retry 新记录，首测记录未变（DevTools 查看）
4. `#/settings` 修改每日时长 → 保存 → 刷新 → 保留
5. 导出备份 → DevTools 清空 EnglishCoachDB 全部表 → 导入（覆盖）→ `#/report` 与清空前一致
6. `vite preview`（`npm --prefix app-src run preview`）验证构建产物在 `/english-materials/app/` base 下资源加载正常（JS/CSS/题库 JSON 均 200）

- [ ] **Step 5: 提交（含构建产物与 CI 适配）**

```bash
git add index.html .github/workflows/ci.yml package.json app scripts/check_site.py
git commit -m "feat(app): 原站加入口、CI 排除新目录，发布 M1 构建产物

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 6: 收尾：验收记录**

在 `docs/superpowers/specs/2026-11-16-m0-m1-local-core-design.md` 末尾追加"验收记录"小节，逐条记录规格 §4 五项验收的实际结果（通过/不通过与证据），提交：

```bash
git add docs/superpowers/specs/2026-11-16-m0-m1-local-core-design.md
git commit -m "docs: M0+M1 验收记录

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 任务依赖与顺序

Task 1 → 2 → 3 → 4 → 5（4、5 可并行）→ 6 → 7 → 8 → 9（可与 8 并行）→ 10 → 11 → 12 → 13。
所有任务在 `main` 分支按序提交；如需隔离开发，执行时用 superpowers:using-git-worktrees。

## 完成定义（对照规格 §4）

1. `npm run extract:g7a` 产出 192 题 + 184 词，重复运行输出一致 —— Task 1
2. 本地可做题、判分、解析 —— Task 4/7/8
3. 刷新不丢、首测不被覆盖 —— Task 5/7（T02）
4. 设置持久、备份 round-trip —— Task 5/10/12（T08）
5. 测试全绿、构建不破坏原站 CI —— Task 2/13
6. 存储不可用降级 —— Task 11

---

## M2 待办汇总（M0+M1 各轮审查登记，最终整体审查 2026-11-17 复核后归拢）

**页面与数据口径：**
- 词汇默写题运行时派生、不入 questions 表：错题本对词汇题显示 questionId 作题干、正确答案"—"，报告"易错词"显示原始 ID（Task 10 已知局限）。修复方向：两页从 bundle 派生词汇题建补充 qMap，或播种时写入词汇题。
- mastery 表除备份导出/导入外无任何写入，指标全部由 attempts 现算（最终审查 Minor 4；规格 §2.4 的 M1 读写表措辞与实现不符，M2 补写入或改规格措辞）。

**错误处理与降级：**
- 播种失败仅 console.error；或首次启动用户早于 bulkPut 完成点入练习——专项页空结果不抛错、无重试按钮，与规格 §3"明确错误与重试"不符（最终审查 Minor 3）。
- today 页 bundle 拉取失败静默降级为"0 题"卡片，点入练习后才见错误（最终审查 Minor 6）。
- `crypto.randomUUID` 在非安全上下文（http 非 localhost 部署）无 fallback，每次提交进"提交失败"循环（最终审查 Minor 7；GitHub Pages/localhost 不受影响）。

**备份：**
- 规格 §2.6"导入前自动先导出当前数据做安全备份"未实现（最终审查 Minor 5，plan 中无对应任务）。
- counts 校验缺 key 时预览显示 undefined、行含 null 元素的 TypeError（Task 12 质量审查 Minor）。

**代码结构：**
- 五页面 stale-guard/渲染样板重复，可抽共享渲染辅助（Task 10/12 质量审查）。

**CI 与工程：**
- check_site.py SKIP_DIRS 为 basename 匹配，会剪枝任意深度的同名目录（Task 13 质量审查 Minor）。
- htmlvalidate 排除列表在 package.json / ci.yml / check_site.py 三处重复维护（Task 13 质量审查 Minor）。
- `.playwright-mcp/` 未加入 .gitignore（Task 13 规格审查观察；未入库，仅防误提交）。
- 专项清单三处平行描述（extract-questions.mjs BOOKS、app-src/src/content/sets.ts SPECIALS、测试 SPECIAL_COUNTS）无自动交叉校验，拼错会静默 0 题（M2+M3 Task 1 质量审查 Minor）。建议应用侧断言 SPECIALS id ⊆ questions unit 前缀集合。
- 转换脚本分册统计按 term 字母归册、main() 按位置索引取 books——第三册复用 term 字母会错位（M2+M3 Task 1 质量审查 Minor，两册无虞的 latent 假设）。
- repos.applyMasteryUpdate 内联重写了 attemptsForQuestion 查询、`ADVANCE[intervalDays]!` 非空断言依赖隐式不变量、STAGE_DEFAULT_INTERVAL 兜底与"有历史无 mastery 行"防御分支零测试覆盖（M2+M3 Task 3 质量审查 Minor 1/3/6，Approved 不阻塞，Task 9 backup 校验同批顺手处理）。
- getReviewSet 预筛兜底过滤的注释依据不成立（当前存储约定下与索引预筛严格等价，实为死防御）、`db.questions.toArray()` 建全表 map 可改 bulkGet、复测题内容全缺失分支复用"今日没有到期复习"空态文案语义不符、vocabKpFromQuestionId 短单元名不含连字符约定未注释（M2+M3 Task 4 质量审查 Minor 1-4，Approved 不阻塞，一行级改动，Task 9 同批顺手处理）。
- 每日计划 review 任务 minutesPlanned 恒为 30% 份额，规格 §2.1"时长上限 min(30% 总时长, 到期题量)"未实现（规格-计划不一致，计划断言明确"不截断"，按计划执行）；薄弱度口径为曾错率而非规格字面"首测错误率"；非默认 dailyMinutes(20/45) 与 isStudyDay 跨月/跨年边界测试覆盖度；结转只回看恰好昨日（周六 deferred 周日休息 → 周一丢结转，已注释）；getOrCreatePlan 查重-生成非原子（单用户可接受）；plan/repos 测试 fixture 跨文件重复、专项查询顺序 await（M2+M3 Task 5 规格审查 6 条 + 质量审查未修 Minor，均不阻塞）。
- Task 6 集成要求（Task 5 质量审查提醒）：exercise 页进入任务时必须先置任务 in_progress 再在完成时置 completed（planned→completed 视为非法转移会抛错）。（已由 Task 6 completeTask 落实，本条归档）
- 任务卡题数标注与实际练习题集口径不一致（unit 卡"N 词"按预算快照但入口给整单元、special 同理、review 快照 vs 实时选题）——上游计划设计的集合维度链接所致，完成判定以实际下发题集为准；复习任务快照与实时选题的死胡同边缘场景已在 today.ts 注释登记（M2+M3 Task 6 规格审查 + 质量审查 M7）。
- isPlanIncomplete 按计划形状推断残缺（缺 special 段）有理论误报（合法无 special 的计划会被误判 → 重试 clear 重置状态，概率极低）；治本方向是生成时落显式 degraded 标记。seedContent 幂等以 contentMeta.version 为键不看表状态，极端情况（questions 表空而 meta 保留，仅手动改库可达）重试无法自愈。today 页 rerender 离开又回来的双渲染竞态、renderToday 转发层、任务卡平行数组/summary 死字段、completeTask 未复用 TASK_TRANSITIONS 表（状态机双处编码）——均不阻塞（M2+M3 Task 6 质量审查 M4-M6 + 复审 nit/留办）。
- KP 解析逻辑三处约定重复（trends.ts buildKpIndex、repos.ts kpsByQuestionId+resolveQuestionKps、report.ts kpLabel 正则）无共享实现，仅靠注释维系——建议收敛到 content/loader.ts 纯函数；reviewOnTimeRate 单循环四职缺分段锚点、ReviewEvent 构造与 repos 写入路径平行重复；report.ts 装配渲染混杂与易错词超长表达式、Awaited<ReturnType> 绕弯写法、易错词回退死分支与注释矛盾；chart.ts 坐标先拼字符串再拆回；乱序 attempts 重放稳健性未被回归测试锁住；+1 天窗口上边界测试小缺口；weeklyFacts 等未过滤未来作答（时钟偏斜）——均不阻塞（M2+M3 Task 7 规格审查 2 条 + 质量审查 7 条 Minor，Approved）。
- Task 8 遗留（均指向 Task 9 validateSettingsRow 一并收敛）：恶意备份可写入非法 examScores 行（got/total 字符串直达 report DOM，label 已转义、got/total 未强转）、试卷回填无 8 行上限（>8 行旧库渲染超限、保存静默截断）、validateSettingsRow 未校验 parentPin 形态；门禁提示不指明目标操作且最后点击者覆盖待执行目标；merge 导入后 refill 会丢弃主表单未保存编辑（偏向正确性的取舍）。
- Task 9 收尾登记（提交 3756c30，规格+质量双 Approved）：9 项同批小修 8 项落地，**未修 1 项**：loader.ts vocabKpFromQuestionId 短单元名不含连字符的约定注释（44-46 行仍只写"短单元名"）。质量审查 6 Minor 留办：parseAndValidateBackup 不校验 app/exportedAt（非法时预览 Invalid Date）、ai-config dailyLimit Number() 接受 '0x32'/'1e2' 字面量（UI number 输入不可达）、aiDailyLimit 导入无 1–500 语义校验（Task 10 消费侧需兜底）、AI 卡 PIN 门禁接线无 DOM 级测试、AI 卡 refresh() 覆盖未保存编辑（与 refillMainForm 同口径）、exportBackup 并行读未包事务（单用户风险极低）。前三项并入 Task 10 同批顺手处理。
- Task 10 收尾登记（提交 1f2de01 + 修复 5abd012/4fad0bd/b4185e2，规格+质量双 Approved，经历两轮修复循环：乱码判定弱化、fetch 丢 AbortSignal 回归——后者三轮才闭合，教训：guard 化重构时必须保 signal 传递链）：AI 调用层五文件（transport/dashscope/tasks/quota/repos.recordAiRequest）+ 3 项 Task 9 顺手修复全部落地；测试 246→286。质量审查 4 Minor 留办：tasks.ts 数据块拼接未对 payload 字面 `</question_data>` 转义（指令级软防护仍在，本地内容源风险低）、isGarbledText 分子码点/分母 UTF-16 length 且孤立代理项未计入（偏保守）、checkQuota 复用 kind 'quota-server' 命名语义失真（Task 11 定文案时评估）、jsonMode 重试每轮各 20s 最坏 40s（Task 11 进度提示）。Task 11 顺手处理候选：数据块转义 + quota kind 文案。
- Task 11 收尾登记（提交 16ef0f5，测试 286→304）：练习页 AI 提示/讲解、报告页周报 AI 建议与历史周报（最近 4 周）落地；Task 10 顺手两项均闭合：payload 数据块闭合标签字面转义（'/'→'∕' U+2215，大小写不敏感，含测试）、quota kind 拆分为 quota-local（dashscope 429 本就归 rate-limit，无其他调用方，改动最小化；UI 文案"本地上限 N 次"）。新增 services/ai/ui.ts 纯函数（按钮状态推导 + 错误分类文案）配 Vitest；按钮交互（重试一次状态机）无 DOM 级测试，走 Playwright 文本快照验证（清单四项全过：未配置灰态/mock 成功含 escapeHtml 的 img 注入不执行/mock 20s 超时重试且判分不阻塞/配额满灰态，另验周报同周覆盖与历史展开、周报失败重试一次后移除按钮）。留办 Minor：weeklyReports.aiSuggestions 以 JSON 字符串存（schema 字段 string，读取侧宽松解析）；exercise/report 页 AI 闭包内联（无 DOM 测试框架，纯函数已抽出）；Task 10 遗留的 isGarbledText 分母口径与 jsonMode 重试最坏 40s 未处理（属 tasks 层，待 Task 12/13）。
- Task 11 收尾登记（提交 16ef0f5 + docs 90efa44，规格+质量双 Approved，规格含浏览器独立复验 4 项全过）：AI UI 三入口（练习页提示/讲解、周报建议与历史周报）、闭合标签转义、quota-local 拆分全部落地；测试 286→304。质量审查 2 Important 归入 Task 12 批次必处理：① report.ts:39 aiSuggestions.trim() 对备份注入非字符串会 TypeError（validateWeeklyReportRow 未校验该字段、renderHistory try 只包 DB 读取）→ 备份校验补 aiSuggestions 类型判或 suggestionsHtml 入参收 unknown 判型；② settings.ts:452 aiEnabled 成死开关且"当前版本仅保存配置"文案过时（AI 实际仅由 aiApiKey 门控）→ 纳入门控或改文案。9 Minor 留办：三处 30 行重试样板同构（第四处出现前抽共享）、wrongCount 非数字渲染 NaN/num() 畸形显示 0 而非"暂无"、在途翻页成功结果丢弃但配额已计、二次失败后不 syncAiButtons、读失败 return 致重试按钮停留 disabled、"省配额"注释不准确（aborted 仍计数）、orderBy 优化、#weekly-history 唯一 ID 选择器、页面接线无测试（与既有模式一致）。
