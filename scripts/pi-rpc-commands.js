/**
 * pi RPC 端到端命令测试 —— 通过 pi 真实的 `--mode rpc` 机制执行扩展命令。
 *
 * 为什么需要它:pi-integration.js 是自写 mock,只能证明「我的代码符合我对 pi API 的假设」。
 * 本脚本把命令真的交给 pi 运行时,验证:
 *   - 扩展在真实 pi 进程里加载
 *   - /memory、/memory-search、/memory-graph、/memory-consolidate 真的被 pi 识别为扩展命令
 *   - ctx.ui.notify 真的经 pi 的 extension_ui_request 子协议送出
 *   - 命令处理逻辑基于真实落盘的记忆库数据
 *
 * 用法:node scripts/pi-rpc-commands.js
 * 注:/memory-graph 会真的调用系统 open 打开浏览器(这是它的正常行为)。
 */
import { spawn, execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 预检:本套件靠真实 pi 进程验证命令注册,pi 不在 PATH 则直接失败
// (不做静默跳过 —— 静默跳过就是假绿)
try {
  execSync('pi --version', { stdio: 'ignore' })
} catch {
  console.error('✗ 需要 `pi` 在 PATH 中:本套件通过真实 pi RPC 验证扩展命令')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')
const extPath = path.join(projectRoot, 'src', 'pi', 'index.ts')
const lib = path.join(projectRoot, 'lib')

const root = process.argv[2] || path.join(os.tmpdir(), `okf-rpc-${Date.now()}`)

let pass = 0
let fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// ── 先准备一个有内容的记忆库(直接用核心模块,绕开模型) ──
const store = await import(pathToFileURL(path.join(lib, 'store.js')).href)
const memory = await import(pathToFileURL(path.join(lib, 'memory.js')).href)
const learning = await import(pathToFileURL(path.join(lib, 'learning.js')).href)
await store.ensureRoot(root)
await memory.rememberCore(root, { title: '门店布局', type: 'Fact' }, '# 核心\n\n三家门店:韶山/湘乡/塘厦,共用局域网共享文件夹。')
await memory.rememberCore(root, { title: '前端方案', type: 'TechChoice' }, '## Options\n\n| 候选 | 说明 | 配置要点 | 状态 |\n|---|---|---|---|\n| React 18 + Vite | 主力 | node22 | active |')
// 造一条权重记录,否则 /memory 的权重榜本来就该是空的(rememberCore 不入权重表)
await learning.recordSelect(root, 'fact/门店布局', 1.0)
console.log(`记忆库:${root}\n`)

// ── 启动真实 pi RPC 进程 ──
const proc = spawn('pi', ['--mode', 'rpc', '-ne', '-nc', '--no-session', '-e', extPath], {
  cwd: projectRoot,
  env: { ...process.env, OKF_MEMORY_ROOT: root },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const notifies = []
const eventTypes = new Map()
let stderrBuf = ''
let buf = ''

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    eventTypes.set(ev.type, (eventTypes.get(ev.type) || 0) + 1)
    if (ev.type === 'extension_ui_request' && ev.method === 'notify') notifies.push(ev)
  }
})
proc.stderr.on('data', (c) => { stderrBuf += c.toString() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 发送一条命令(扩展命令会被 pi 立即执行),等待其产生的 notify */
async function runCommand(cmd, timeoutMs = 25000) {
  const from = notifies.length
  proc.stdin.write(JSON.stringify({ type: 'prompt', message: cmd }) + '\n')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (notifies.length > from) {
      await sleep(250) // 收集同批次可能的后续 notify
      return notifies.slice(from)
    }
    await sleep(100)
  }
  throw new Error(`命令「${cmd}」在 ${timeoutMs}ms 内未产生 notify`)
}

try {
  // 等 pi 起来并把扩展加载完
  await sleep(4000)
  assert('pi RPC 进程存活', proc.exitCode === null, `exitCode=${proc.exitCode} ${stderrBuf.slice(0, 300)}`)

  // ── /memory ──
  let out = await runCommand('/memory')
  let msg = out.map((n) => n.message).join('\n')
  assert('/memory 产生 notify', out.length > 0)
  assert('/memory 报出记忆库根', msg.includes(root), msg.slice(0, 200))
  assert('/memory 报出概念数', msg.includes('概念数'), msg.slice(0, 200))
  assert('/memory 列出权重榜', msg.includes('权重榜'), msg.slice(0, 300))

  // ── /memory-search 有命中 ──
  out = await runCommand('/memory-search 门店')
  msg = out.map((n) => n.message).join('\n')
  assert('/memory-search 命中概念', msg.includes('fact/门店布局'), msg.slice(0, 200))

  // ── /memory-search 无参 → 用法提示 ──
  out = await runCommand('/memory-search')
  msg = out.map((n) => n.message).join('\n')
  assert('/memory-search 无参提示用法', msg.includes('用法'), msg.slice(0, 200))

  // ── /memory-search 无命中 → 明说 ──
  out = await runCommand('/memory-search zzz不存在zzz')
  msg = out.map((n) => n.message).join('\n')
  assert('/memory-search 无命中明说', msg.includes('无匹配'), msg.slice(0, 200))

  // ── /memory-consolidate ──
  out = await runCommand('/memory-consolidate')
  msg = out.map((n) => n.message).join('\n')
  assert('/memory-consolidate 报告结果', msg.includes('巩固完成'), msg.slice(0, 200))

  // ── /memory-graph → 真写 HTML 并调用系统 open ──
  out = await runCommand('/memory-graph', 30000)
  msg = out.map((n) => n.message).join('\n')
  const m = msg.match(/(\/[^\s]+\.html)/)
  assert('/memory-graph 报出 HTML 路径', !!m, msg.slice(0, 300))
  if (m) {
    const html = await fs.readFile(m[1], 'utf8')
    assert('HTML 真实落盘且自包含', html.includes('const GRAPH =') && !/https?:\/\//.test(html), `${html.length} 字节`)
    assert('HTML 含真实记忆数据', html.includes('门店布局') && html.includes('前端方案'))
    assert('HTML 边数据来自真实库', /"edges"\s*:\s*\[/.test(html))
    await fs.rm(m[1], { force: true })
  }

  // 命令执行期间不应产生 error 级 notify
  const errs = notifies.filter((n) => n.notifyType === 'error')
  assert('命令无 error 级通知', errs.length === 0, JSON.stringify(errs.map((e) => e.message)))

  console.log(`\n  (RPC 事件类型统计: ${[...eventTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', ')})`)
} catch (e) {
  fail++
  console.log(`  ✗ 测试中断: ${e.message}`)
  if (stderrBuf) console.log('  stderr:', stderrBuf.slice(0, 500))
} finally {
  proc.stdin.end()
  proc.kill('SIGTERM')
  await sleep(300)
}

console.log(`\n结果:${pass} 通过,${fail} 失败`)
if (fail > 0) process.exit(1)
