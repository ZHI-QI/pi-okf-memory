/**
 * pi 集成测试:mock pi ExtensionAPI,验证适配层注册的工具/命令/提示注入,
 * 并直接调用工具 execute 走全链路(pi 的 execute 签名是 (toolCallId, params, signal, onUpdate, ctx))。
 *
 * 用 jiti 加载 TS 适配层 —— 与 pi 自身的扩展加载方式一致(pi 内部用 jiti)。
 * 用法:node scripts/pi-integration.js [临时记忆库根]
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { Value } from 'typebox/value'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')
const root = process.argv[2] || path.join(os.tmpdir(), `okf-pi-${Date.now()}`)
process.env.OKF_MEMORY_ROOT = root

let pass = 0
let fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// ── mock pi ExtensionAPI ──
const tools = new Map()
const commands = new Map()
const handlers = new Map()
const uiLog = []
const pi = {
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
  },
  registerTool(def) { tools.set(def.name, def) },
  registerCommand(name, opts) { commands.set(name, opts) },
  async exec() { /* 测试中不真的打开浏览器 */ },
}
const ctx = {
  ui: {
    notify(msg, level) { uiLog.push({ msg, level }) },
  },
  cwd: process.cwd(),
}

// ── 加载适配层(jiti,同 pi 的加载方式) ──
const jiti = createJiti(import.meta.url)
const factory = await jiti.import(path.join(src, 'pi', 'index.ts'), { default: true })
assert('适配层导出工厂函数', typeof factory === 'function')

try {
  factory(pi)
} catch (e) {
  console.log('  ✗ 工厂执行抛错:', e.message)
  process.exit(1)
}

// ── 注册面 ──
assert('注册 6 个工具', tools.size === 6, `实际 ${tools.size}: ${[...tools.keys()].join(',')}`)
for (const n of ['okf_remember', 'okf_search', 'okf_read', 'okf_forget', 'okf_graph', 'okf_feedback']) {
  assert(`${n} 已注册`, tools.has(n))
}

const remember = tools.get('okf_remember')
const searchTool = tools.get('okf_search')
const readTool = tools.get('okf_read')
const forgetTool = tools.get('okf_forget')
const graphTool = tools.get('okf_graph')
const feedbackTool = tools.get('okf_feedback')

// 每个工具必须有 label / description / parameters(pi 的 ToolDefinition 必填项)
for (const [name, t] of tools) {
  assert(`${name} 有 label`, typeof t.label === 'string' && t.label.length > 0)
  assert(`${name} 有 description`, typeof t.description === 'string' && t.description.length > 20)
  assert(`${name} parameters 是 object schema`, t.parameters && t.parameters.type === 'object')
  assert(`${name} parameters 显式 additionalProperties`, 'additionalProperties' in (t.parameters || {}))
  assert(`${name} 有 execute`, typeof t.execute === 'function')
}

// 提示注入:pi 用 promptSnippet(工具简述)与 promptGuidelines(准则)
assert('工具带 promptSnippet', [...tools.values()].every((t) => typeof t.promptSnippet === 'string'))
assert('remember 有 promptGuidelines', Array.isArray(remember.promptGuidelines) && remember.promptGuidelines.length > 0)

// TypeBox schema 真的会拦住非法参数(pi 在调用前做校验)
assert('schema 接受合法参数', Value.Check(remember.parameters, { title: 't', type: 'Fact', content: 'c' }))
assert('schema 拒绝缺必填', !Value.Check(remember.parameters, { title: 't', type: 'Fact' }))
assert('schema 拒绝多余字段', !Value.Check(remember.parameters, { title: 't', type: 'Fact', content: 'c', bogus: 1 }))
assert('schema 接受可选字段', Value.Check(remember.parameters, { title: 't', type: 'Fact', content: 'c', tags: ['a'], related: ['b/c'] }))
assert('search schema 接受可选类型过滤', Value.Check(searchTool.parameters, { query: 'q', type: 'TechChoice', limit: 5 }))
assert('feedback schema 拒绝缺必填', !Value.Check(feedbackTool.parameters, { concept_id: 'x' }))

// 命令
assert('注册 /memory', commands.has('memory'))
assert('注册 /memory-search', commands.has('memory-search'))
assert('注册 /memory-graph', commands.has('memory-graph'))
assert('注册 /memory-consolidate', commands.has('memory-consolidate'))

// 事件订阅
assert('订阅 before_agent_start', (handlers.get('before_agent_start') || []).length === 1)
assert('订阅 session_start', (handlers.get('session_start') || []).length === 1)

// ── 触发 session_start:初始化记忆库 + 构建库摘要 ──
await handlers.get('session_start')[0]({}, ctx)
let idx = await fs.readFile(path.join(root, 'index.md'), 'utf8')
assert('session_start 建库(index.md)', idx.includes('okf_version'))

// ── 系统提示注入 ──
const injected = await handlers.get('before_agent_start')[0]({ systemPrompt: 'BASE-PROMPT' }, ctx)
assert('before_agent_start 返回 systemPrompt', typeof injected?.systemPrompt === 'string')
assert('注入保留原 prompt', injected.systemPrompt.startsWith('BASE-PROMPT'))
assert('注入记忆纪律', injected.systemPrompt.includes('记忆纪律'))
assert('注入技术选型三档规则', injected.systemPrompt.includes('技术选型三档规则'))
assert('注入库摘要', injected.systemPrompt.includes('OKF 记忆库'))
assert('注入召回指引', injected.systemPrompt.includes('okf_read'))
assert('摘要含防编造纪律', injected.systemPrompt.includes('不要编造'))

// ── 工具 execute 全链路(pi 签名:toolCallId, params) ──
const call = (t, params) => t.execute('tc-1', params, undefined, undefined, ctx)

// 1. remember
let r = await call(remember, {
  title: '门店布局', type: 'Fact',
  content: '# 核心\n\n三家门店共用局域网共享文件夹。\n\n## 细节\n- 韶山店\n- 湘乡店\n- 塘厦店',
  tags: ['门店'],
})
assert('remember 创建 Fact', r.details.status === 'created' && r.details.conceptId === 'fact/门店布局', JSON.stringify(r.details))
assert('remember 返回 content 文本', Array.isArray(r.content) && r.content[0].type === 'text' && r.content[0].text.includes('已沉淀记忆'))

// 2. TechChoice
r = await call(remember, {
  title: '前端方案', type: 'TechChoice',
  content: '## Options\n\n| 候选 | 说明 | 配置要点 | 状态 |\n|---|---|---|---|\n| React 18 + Vite | 主力 | node22/pnpm | active |\n| Vue 3 | 遗留 | 维护中 | candidate |\n\n## Active\n\n- 当前使用:React 18 + Vite',
  tags: ['前端', '技术选型'],
})
assert('remember 创建 TechChoice', r.details.status === 'created' && r.details.conceptId === 'techchoice/前端方案', JSON.stringify(r.details))

// 3. 非法 type 拒绝
r = await call(remember, { title: '非法类型', type: 'not-a-type', content: '# x' })
assert('非法 type → error', r.details.status === 'error', JSON.stringify(r.details))
let badDirExists = true
try { await fs.access(path.join(root, 'not-a-type')); badDirExists = false } catch { /* 不应存在 */ }
assert('非法类型不建污染目录', badDirExists)

// 4. 重复标题 → skip/update
r = await call(remember, { title: '门店布局', type: 'Fact', content: '# 核心\n\n一句话。' })
assert('重复标题走 skip/update', r.details.status === 'skipped' || r.details.status === 'updated', JSON.stringify(r.details))

// 5. search
let s = await call(searchTool, { query: '门店' })
assert('search 命中', s.details.count >= 1 && s.details.results[0].conceptId.includes('门店'), JSON.stringify(s.details))

// 6. search TechChoice 带候选表(三档规则依赖此字段)
s = await call(searchTool, { query: '前端', type: 'TechChoice' })
assert('search TechChoice 返回候选表', s.details.count === 1 && !!s.details.results[0].options && s.details.results[0].options.includes('React'), JSON.stringify(s.details.results[0]))

// 7. read + 权重反馈
const rd = await call(readTool, { concept_id: 'fact/门店布局' })
assert('read 返回全文', rd.details.conceptId === 'fact/门店布局' && rd.details.body.includes('韶山'))
assert('read 提取交叉链接字段', Array.isArray(rd.details.links))

// 8. okf_feedback —— dsh 侧 recordSelect/recordSkip 从未被调用的缺口,在 pi 侧已接通
const metaBefore = JSON.parse(await fs.readFile(path.join(root, '.meta', 'weights.json'), 'utf8'))
const wBefore = metaBefore.entries['fact/门店布局'].weight
const fb = await call(feedbackTool, { concept_id: 'fact/门店布局', action: 'select' })
const metaAfterSel = JSON.parse(await fs.readFile(path.join(root, '.meta', 'weights.json'), 'utf8'))
assert('feedback select → 权重 +1.0', Math.abs(metaAfterSel.entries['fact/门店布局'].weight - (wBefore + 1.0)) < 1e-9,
  `${wBefore} → ${metaAfterSel.entries['fact/门店布局'].weight}`)
assert('feedback select 返回权重', fb.details.status === 'ok' && typeof fb.details.weight === 'number')

const wMid = metaAfterSel.entries['fact/门店布局'].weight
await call(feedbackTool, { concept_id: 'fact/门店布局', action: 'skip' })
const metaAfterSkip = JSON.parse(await fs.readFile(path.join(root, '.meta', 'weights.json'), 'utf8'))
assert('feedback skip → 权重 −0.5', Math.abs(metaAfterSkip.entries['fact/门店布局'].weight - (wMid - 0.5)) < 1e-9,
  `${wMid} → ${metaAfterSkip.entries['fact/门店布局'].weight}`)
const badFb = await call(feedbackTool, { concept_id: 'fact/门店布局', action: 'nope' })
assert('feedback 非法 action → error', badFb.details.status === 'error')

// 9. okf_graph
const gg = await call(graphTool, {})
assert('okf_graph 返回 nodes', Array.isArray(gg.details.nodes) && gg.details.nodes.length >= 2, JSON.stringify({ n: gg.details.nodes?.length }))
assert('okf_graph 节点含 type/weight/state', gg.details.nodes[0].type && typeof gg.details.nodes[0].weight === 'number' && !!gg.details.nodes[0].state)
assert('okf_graph 返回 edges/timeline/meta', Array.isArray(gg.details.edges) && Array.isArray(gg.details.timeline) && !!gg.details.meta)
const gl = await call(graphTool, { limit: 1 })
assert('okf_graph limit 生效', gl.details.nodes.length === 1)

// 10. forget
const fgNF = await call(forgetTool, { concept_id: 'fact/不存在' })
assert('forget 不存在 → not_found', fgNF.details.status === 'not_found', JSON.stringify(fgNF.details))
const fg = await call(forgetTool, { concept_id: 'fact/门店布局' })
assert('forget 撤回', fg.details.status === 'forgotten', JSON.stringify(fg.details))
s = await call(searchTool, { query: '门店' })
assert('forget 后检索不到', s.details.count === 0, JSON.stringify(s.details))

// 11. index/log 完整性
idx = await fs.readFile(path.join(root, 'index.md'), 'utf8')
assert('index 不含已撤回概念', !idx.includes('fact/门店布局'))
const logText = await fs.readFile(path.join(root, 'log.md'), 'utf8')
assert('log 含 forgotten 记录', logText.includes('forgotten'))

// ── 命令:/memory ──
await commands.get('memory').handler('', ctx)
assert('/memory 输出记忆库状态', uiLog.some((l) => l.msg.includes('记忆库') && l.msg.includes('概念数')))
assert('/memory 输出权重榜', uiLog.some((l) => l.msg.includes('权重榜')))

// ── 命令:/memory-search ──
await commands.get('memory-search').handler('前端', ctx)
assert('/memory-search 命中', uiLog.some((l) => l.msg.includes('techchoice/前端方案')))
await commands.get('memory-search').handler('', ctx)
assert('/memory-search 空参提示用法', uiLog.some((l) => l.msg.includes('用法')))
await commands.get('memory-search').handler('zzz-不存在的词', ctx)
assert('/memory-search 无匹配明说', uiLog.some((l) => l.msg.includes('无匹配')))

// ── 命令:/memory-graph —— 生成自包含 HTML ──
await commands.get('memory-graph').handler('', ctx)
const note = uiLog[uiLog.length - 1].msg
const htmlPath = (note.match(/(\/[^\n]+\.html)/) || [])[1]
assert('/memory-graph 报出 HTML 路径', !!htmlPath, note)
if (htmlPath) {
  const html = await fs.readFile(htmlPath, 'utf8')
  assert('HTML 自包含(无外部 http 引用)', !/src=["']https?:|href=["']https?:/.test(html))
  assert('HTML 内嵌 GRAPH 数据', html.includes('const GRAPH ='))
  assert('HTML 含力导向/交互逻辑', html.includes('activateHits') && html.includes('hitTest'))
  assert('HTML 含节点标题', html.includes('前端方案'))
  assert('HTML 含类型配色', html.includes('TYPE_COLORS'))
  assert('HTML 转义 script 闭合', !html.includes('</script>') || html.indexOf('const GRAPH') < html.lastIndexOf('</script>'))
  await fs.rm(htmlPath, { force: true })
}

// ── 命令:/memory-consolidate ──
await commands.get('memory-consolidate').handler('', ctx)
assert('/memory-consolidate 报告结果', uiLog.some((l) => l.msg.includes('巩固完成')))

console.log(`\n结果:${pass} 通过,${fail} 失败`)
if (fail > 0) process.exit(1)
console.log(`\n记忆库根:${root}`)
console.log(await fs.readFile(path.join(root, 'index.md'), 'utf8'))
