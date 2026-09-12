/**
 * pi 真实模型端到端测试 —— 真的调模型、真的跑工具、真的落盘。
 *
 * 为什么必须有这一层:
 *   - pi-integration.js / pi-rpc-commands.js 都是 mock 或直接调用,绕开了「模型会不会用这个工具」
 *   - mock 不会自己决定传什么参数 —— 本项目就因此漏过一个真 bug:模型从不知道要传 `related`,
 *     导致真实使用下图谱永远是零边的孤岛(机制单测却是通过的)
 *
 * 覆盖:写入 → 交叉链接成边 → 跨会话召回 → 检索不到不编造
 * 代价:每次 ask() 是一次真实模型调用。
 *
 * 用法:node scripts/pi-e2e-model.js [记忆库根]
 * 环境变量:OKF_MODEL(默认 deepseek/deepseek-flash)
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')
const extPath = path.join(projectRoot, 'src', 'pi', 'index.ts')
const lib = path.join(projectRoot, 'lib')
const MODEL = process.env.OKF_MODEL || 'deepseek/deepseek-flash'
const root = process.argv[2] || path.join(os.tmpdir(), `okf-e2e-${Date.now()}`)

let pass = 0
let fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

/** 起一个真实的 pi 非交互会话(只加载本扩展,隔离记忆库) */
function ask(prompt, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const p = spawn('pi', ['-ne', '-nc', '--no-session', '-p', prompt, '--model', MODEL, '-e', extPath], {
      cwd: projectRoot,
      env: { ...process.env, OKF_MEMORY_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    const timer = setTimeout(() => {
      p.kill('SIGKILL')
      resolve({ code: -1, timedOut: true, ms: Date.now() - started, out, err: err + `\n[超时 ${timeoutMs}ms]` })
    }, timeoutMs)
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false, ms: Date.now() - started, out, err }) })
  })
}

const conceptsOf = async () => {
  const { scanBundle } = await import(pathToFileURL(path.join(lib, 'store.js')).href)
  return scanBundle(root)
}
const graphOf = async () => {
  const { buildGraph } = await import(pathToFileURL(path.join(lib, 'graph.js')).href)
  return buildGraph(root)
}

console.log(`模型:${MODEL}\n记忆库:${root}\n`)

// 真实模型调用耗时受供应商影响较大(实测同一提示 9s~50s),走一次超时上限 300s。
// 曾观察到一次瞬时超时(当时刚连跑两遍含真实 pi 进程的 pnpm test),
// 故把超时与真错误分开报告,便于一眼定位。
const report = (label, r) => console.log(`  (${label} 耗时 ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' — 超时看门狗触发,大概率供应商拖慢或限流,重跑即可' : ''})`)

// ──────────────────────────────────────────────────────────
console.log('【1】写入:两条天然相关的独立事实')
const r1 = await ask('记住两件事:第一,我的三家门店是韶山/湘乡/塘厦,共用局域网共享文件夹;第二,查询经营数据一律走鼎赞 SaaS 的 MySQL,不要翻本地文件')
report('写入', r1)
assert('pi 会话正常结束(非超时)', r1.code === 0, `exit=${r1.code}${r1.timedOut ? ' [超时]' : ''} ${r1.err.slice(0, 300)}`)
const concepts = await conceptsOf()
assert('概念真的落盘(≥2)', concepts.length >= 2, `实际 ${concepts.length}`)
const g1 = await graphOf()
assert('交叉链接生成了图谱边(≥1)', g1.edges.length >= 1, `edges=${g1.edges.length} — 模型未传 related 时会退化为 0`)
assert('node/edge 数与文件一致', g1.nodes.length === concepts.length, `${g1.nodes.length} vs ${concepts.length}`)

// ──────────────────────────────────────────────────
console.log('\n【2】跨会话召回:新会话问一个必须靠记忆才能答对的问题')
const r2 = await ask('查询经营数据应该走哪里?只给结论')
report('召回', r2)
assert('召回会话正常结束', r2.code === 0, `exit=${r2.code}${r2.timedOut ? ' [超时]' : ''}`)
assert('答案源自记忆(提到 鼎赞 或 MySQL)', /鼎赞|MySQL/i.test(r2.out), r2.out.slice(-300))
const weightsFile = path.join(root, '.meta', 'weights.json')
const w2 = await fs.readFile(weightsFile, 'utf8').then(JSON.parse).catch(() => ({ entries: {} }))
assert('召回触发了权重反馈(okf_read)', Object.values(w2.entries).some((e) => e.accessCount >= 1), JSON.stringify(w2.entries).slice(0, 300))

// ──────────────────────────────────────────────────
console.log('\n【3】检索不到时不得编造')
const r3 = await ask('我上次提到的那个德国供应商叫什么名字?就是做精密轴承那家')
report('拒答', r3)
assert('拒答会话正常结束', r3.code === 0, `exit=${r3.code}${r3.timedOut ? ' [超时]' : ''}`)
assert('明确表示记忆库没有', /没有|无记录|没记录|未记录|不知道|查不到|不存在/.test(r3.out), r3.out.slice(-300))

console.log(`\n结果:${pass} 通过,${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('保留记忆库供人工检查:', root)
