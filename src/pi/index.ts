/**
 * pi 适配层 — okf-memory 的 pi 扩展入口(src/pi/index.ts)。
 *
 * 与 src/server/index.ts(dsh 适配层)平级:两者共用 src/server/* 的运行时无关核心,
 * 本文件只做「pi API ↔ 核心逻辑」的翻译。
 *
 * 映射关系:
 *   dsh ctx.tools.register(defineTool({parameters})) → pi.registerTool({parameters: Type.Object})
 *   dsh ctx.systemPrompt.section({name,order})        → pi.on("before_agent_start") 返回 systemPrompt
 *   dsh ctx.provide('okfMemory')                      → 删除(工具即 API)
 *   dsh ctx.inject(['webServer']) + /okf-graph 路由   → /memory-graph 命令导出静态 HTML
 *
 * 记忆库默认 ~/.pi/agent/okf-memory/(OKF_MEMORY_ROOT 可覆盖)。
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

// ── 运行时无关核心(零改动复用) ──
import { ensureRoot, scanBundle } from '../server/store.js'
import { search } from '../server/dedupe.js'
import { preload, recall } from '../server/recall.js'
import { loadMeta, recordSelect, recordSkip, consolidate, rank, startConsolidation } from '../server/learning.js'
import { MEMORY_DISCIPLINE, RECALL_GUIDE } from '../server/capture.js'
import { TYPE_VOCAB } from '../server/concept.js'
import { buildGraph } from '../server/graph.js'
import { rememberCore, forgetCore, type RememberResult, type ForgetResult } from '../server/memory.js'
import { renderGraphHtml } from './graph-html.js'

const EXT = 'okf-memory'

/** 记忆库根:OKF_MEMORY_ROOT > ~/.pi/agent/okf-memory/ */
function resolveRoot(): string {
  const env = process.env.OKF_MEMORY_ROOT
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.pi', 'agent', 'okf-memory')
}

/** 工具返回值的统一包装(pi 用 content 数组 + details 结构化数据) */
function text(s: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text: s }], details }
}

/** 把根 index.md 整理成提示片段(模型每轮可见"库里有啥") */
async function buildIndexPrompt(root: string): Promise<string> {
  try {
    const idx = await fs.readFile(path.join(root, 'index.md'), 'utf8')
    const concepts = await scanBundle(root)
    return `记忆库共有 ${concepts.length} 个概念(路径即概念 ID)。库目录:\n${idx.slice(0, 3000)}`
  } catch {
    return 'OKF 记忆库为空或不可读。'
  }
}

export default function okfMemoryExtension(pi: ExtensionAPI): void {
  const root = resolveRoot()
  /** 当前库摘要,写入后失效重建(避免每轮都扫盘) */
  let digest = 'OKF 记忆库尚未初始化。'

  const refreshDigest = async (): Promise<void> => {
    digest = await buildIndexPrompt(root)
  }

  // ────────────────────────────── 工具 ──────────────────────────────

  pi.registerTool({
    name: 'okf_remember',
    label: '记忆沉淀',
    description:
      '把一条新知识按 OKF v0.1 规范写入长期记忆库(概念文档 + index/log 更新)。' +
      `type 词表:${TYPE_VOCAB.join('/')}。` +
      'Decision/Insight 正文建议用 # 数据/# 分析/# 结论 三段式;TechChoice 用 ## Options 候选表 + ## Active。' +
      '写入前自动去重:标题相同则更新/跳过,相近则返回建议。',
    promptSnippet: '沉淀一条长期记忆(自动去重 + OKF 校验)',
    promptGuidelines: [
      'Use okf_remember when the user discloses a new durable fact, states a preference, makes a decision with rationale, corrects your understanding, or picks a technology — but search first with okf_search to avoid duplicates.',
      'Always pass okf_remember a related array holding the concept IDs of concepts returned by okf_search that this new memory relates to — only related-written links become graph edges.',
      'When okf_remember returns status "linked", resubmit with the returned similarTo value inside related instead of duplicating the body.',
      'Do NOT call okf_remember for greetings, one-off tasks, or restating something already in the memory library.',
    ],
    parameters: Type.Object({
      title: Type.String({ description: '概念标题(简洁,一句话可懂)' }),
      type: Type.String({ description: `概念类型,可选:${TYPE_VOCAB.join('/')}` }),
      content: Type.String({ description: '结构化正文(Markdown,含 # 小节标题)。Decision/Insight 传三段式;TechChoice 传 Options 表与 Active' }),
      tags: Type.Optional(Type.Array(Type.String(), { description: '横切标签' })),
      related: Type.Optional(Type.Array(Type.String(), { description: '相关概念 ID 列表(将互建交叉链接)' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const r: RememberResult = await rememberCore(root, {
          title: params.title,
          type: params.type,
          tags: params.tags as string[] | undefined,
          related: params.related as string[] | undefined,
        }, params.content)
        await refreshDigest()
        const msg = r.status === 'created' ? `已沉淀记忆 ${r.conceptId}`
          : r.status === 'updated' ? `已更新记忆 ${r.conceptId}`
            : r.status === 'skipped' ? `跳过写入:${r.reason}`
              : r.status === 'linked' ? `建议互补:${r.reason}`
                : `记忆写入:${r.status}`
        return text(msg, r as unknown as Record<string, unknown>)
      } catch (e) {
        return text(`记忆写入失败:${String((e as Error).message || e)}`, { status: 'error', reason: String((e as Error).message || e) })
      }
    },
  })

  pi.registerTool({
    name: 'okf_search',
    label: '记忆召回',
    description:
      '检索 OKF 长期记忆库,按唤起评分(相关度 × 权重 × 近因)排序返回概念摘要。' +
      '命中 TechChoice 类型时附加返回完整 Options 候选表,供技术选型三档规则展示。' +
      '写入新记忆前必须先搜索去重。',
    promptSnippet: '检索长期记忆(按 相关度 × 权重 × 近因 排序)',
    promptGuidelines: [
      'Use okf_search before answering questions that may depend on the user\'s stored background, preferences, or past decisions, and always before okf_remember.',
      'If okf_search returns no match, tell the user the memory library has nothing — never invent a memory.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词' }),
      type: Type.Optional(Type.String({ description: '按类型过滤(如 TechChoice/Fact/Decision)' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: '按标签过滤' })),
      limit: Type.Optional(Type.Number({ description: '返回条数,默认 8' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const raw = await search(root, String(params.query), {
        type: params.type as string | undefined,
        tags: params.tags as string[] | undefined,
        limit: Math.min(Number(params.limit) || 8, 30),
      })
      const ranked = await rank(root, raw)
      const results: Array<Record<string, unknown>> = []
      for (const h of ranked) {
        const item: Record<string, unknown> = { ...h }
        if (h.type === 'TechChoice') {
          // 附加候选表:读全文 Options 节
          try {
            const { readConcept } = await import('../server/store.js')
            const c = await readConcept(root, h.conceptId)
            const m = /## Options[\s\S]*?(?=## |$)/.exec(c.body || '')
            item.options = m ? m[0].trim() : null
          } catch { /* 读取失败则不带候选表 */ }
        }
        results.push(item)
      }
      const msg = results.length === 0
        ? '记忆库无匹配。'
        : `检索到 ${results.length} 条记忆:\n` + results.map((r) => `- ${r.conceptId} (${r.type}, 权重 ${r.weight}) ${r.description}`).join('\n')
      return text(msg, { count: results.length, results })
    },
  })

  pi.registerTool({
    name: 'okf_read',
    label: '记忆精读',
    description:
      '读取记忆库中某个概念全文(含交叉链接),并记录一次使用反馈(权重 +0.1)。',
    promptSnippet: '读取某条记忆全文并记录一次使用反馈',
    parameters: Type.Object({
      concept_id: Type.String({ description: '概念 ID(如 fact/门店布局,可省略 .md)' }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const id = String(params.concept_id).replace(/\.md$/, '')
      const c = await recall(root, id)
      return text(`# ${c.meta?.title || id} (${c.meta?.type || ''})\n\n${c.body || ''}`, {
        conceptId: c.conceptId,
        title: c.meta?.title || id,
        type: c.meta?.type || '',
        body: c.body || '',
        links: c.links || [],
      })
    },
  })

  pi.registerTool({
    name: 'okf_forget',
    label: '记忆撤回',
    description:
      '从记忆库索引撤回一条概念(默认保留文件,可从 index/log 追溯;可选删除文件)。',
    promptSnippet: '撤回一条记错的记忆',
    parameters: Type.Object({
      concept_id: Type.String({ description: '概念 ID' }),
      delete_file: Type.Optional(Type.Boolean({ description: 'true 时同时删除文件(默认 false 仅移出索引)' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const id = String(params.concept_id).replace(/\.md$/, '')
      try {
        const r: ForgetResult = await forgetCore(root, id, params.delete_file === true)
        await refreshDigest()
        const msg = r.status === 'forgotten' ? `已撤回记忆 ${r.conceptId}${r.reason ? `(${r.reason})` : ''}`
          : r.status === 'not_found' ? `记忆 ${r.conceptId} 不存在或已撤回`
            : `撤回失败:${r.reason || r.status}`
        return text(msg, r as unknown as Record<string, unknown>)
      } catch (e) {
        return text(`撤回失败:${String((e as Error).message || e)}`, { status: 'error', reason: String((e as Error).message || e) })
      }
    },
  })

  pi.registerTool({
    name: 'okf_graph',
    label: '记忆图谱',
    description:
      '导出记忆库的图谱 JSON:nodes(概念:title/type/tags/weight/state)+edges(交叉链接)+timeline(权重快照)。',
    promptSnippet: '导出记忆图谱 JSON(nodes/edges/timeline)',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '可选:节点上限,默认全部' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const g = await buildGraph(root)
      const nodes = params.limit && Number(params.limit) > 0
        ? g.nodes.slice(0, Math.min(Number(params.limit), 500))
        : g.nodes
      return text(
        `记忆图谱:${nodes.length} 节点 · ${g.edges.length} 边 · ${g.timeline.length} 权重记录`,
        { meta: g.meta, nodes, edges: g.edges, timeline: g.timeline },
      )
    },
  })

  // ── 修复 dsh 侧的反馈回路缺口:recordSelect / recordSkip 此前无任何调用入口 ──
  pi.registerTool({
    name: 'okf_feedback',
    label: '记忆反馈',
    description:
      '对某条记忆给出显式反馈,更新其学习权重。action=select(用户选中/确认采用)权重 +1.0;' +
      'action=skip(用户跳过/否定)权重 −0.5。用于技术选型候选拍板、被否定结论等场景。',
    promptSnippet: '记录用户对某条记忆的选中(+1.0)或跳过(−0.5)反馈',
    promptGuidelines: [
      'Use okf_feedback with action "select" when the user confirms or picks a memory-backed option (for example a TechChoice candidate), and with action "skip" when the user rejects or ignores one.',
    ],
    parameters: Type.Object({
      concept_id: Type.String({ description: '概念 ID' }),
      action: Type.String({ description: 'select(选中,+1.0)或 skip(跳过,−0.5)' }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const id = String(params.concept_id).replace(/\.md$/, '')
      const action = String(params.action)
      if (action !== 'select' && action !== 'skip') {
        return text(`无效 action:「${action}」;可选 select / skip`, { status: 'error' })
      }
      try {
        const weight = action === 'select'
          ? await recordSelect(root, id)
          : await recordSkip(root, id)
        return text(`${action === 'select' ? '已记录选中' : '已记录跳过'} ${id} → 权重 ${weight.toFixed(2)}`, { status: 'ok', conceptId: id, action, weight })
      } catch (e) {
        return text(`反馈记录失败:${String((e as Error).message || e)}`, { status: 'error', reason: String((e as Error).message || e) })
      }
    },
  })

  // ──────────────────── 系统提示注入(替代 dsh 的 section API) ────────────────────

  pi.on('before_agent_start', async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${MEMORY_DISCIPLINE}\n\n# 记忆库现状\n\n${digest}\n\n${RECALL_GUIDE}`,
    }
  })

  // ────────────────────────────── 命令 ──────────────────────────────

  pi.registerCommand('memory', {
    description: '显示 OKF 记忆库状态(根目录 / 概念数 / 权重榜)',
    handler: async (_args, ctx: ExtensionContext) => {
      const concepts = await scanBundle(root)
      const meta = await loadMeta(root)
      const entries = Object.entries(meta.entries)
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, 8)
      const lines = [
        `记忆库:${root}`,
        `概念数:${concepts.length}`,
        entries.length ? `\n权重榜(前 ${entries.length}):` : '',
        ...entries.map(([id, e]) => `  ${e.weight.toFixed(2)}  ${e.state === 'inactive' ? '⏸ ' : ''}${id}  (访问 ${e.accessCount} 次)`),
      ].filter(Boolean)
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('memory-search', {
    description: '在 OKF 记忆库中检索(用法:/memory-search <关键词>)',
    handler: async (args, ctx: ExtensionContext) => {
      const q = String(args || '').trim()
      if (!q) {
        ctx.ui.notify('用法:/memory-search <关键词>', 'warning')
        return
      }
      const hits = await preload(root, q, { limit: 8 })
      if (hits.length === 0) {
        ctx.ui.notify(`记忆库无匹配:「${q}」`, 'info')
        return
      }
      ctx.ui.notify(
        hits.map((h) => `${h.weight.toFixed(2)}  ${h.conceptId} (${h.type}) — ${h.description}`).join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('memory-graph', {
    description: '导出记忆图谱为交互式 HTML 并用浏览器打开',
    handler: async (_args, ctx: ExtensionContext) => {
      const g = await buildGraph(root)
      const out = path.join(os.tmpdir(), `okf-memory-graph-${Date.now()}.html`)
      await fs.writeFile(out, renderGraphHtml(g), 'utf8')
      try {
        await pi.exec('open', [out])
        ctx.ui.notify(`已打开记忆图谱(${g.nodes.length} 节点 / ${g.edges.length} 边)\n${out}`, 'info')
      } catch (e) {
        ctx.ui.notify(`图谱已生成(自动打开失败:${String((e as Error).message || e)}):\n${out}`, 'warning')
      }
    },
  })

  pi.registerCommand('memory-consolidate', {
    description: '立即执行一次记忆巩固(权重衰减 + 归档)',
    handler: async (_args, ctx: ExtensionContext) => {
      const meta = await consolidate(root)
      const entries = Object.values(meta.entries)
      const inactive = entries.filter((e) => e.state === 'inactive').length
      ctx.ui.notify(`巩固完成:${entries.length} 条记忆,其中 ${inactive} 条已归档(inactive)`, 'info')
    },
  })

  // ─────────────────────────── 生命周期 ───────────────────────────

  pi.on('session_start', async () => {
    await ensureRoot(root)
    await refreshDigest()
    // 巩固定时器:用 globalThis 标记保证 /reload 后不会叠加多个定时器
    // (consolidate 是按天数连续衰减,重复运行会加速遗忘)
    const g = globalThis as Record<string, unknown>
    if (!g.__okfConsolidationStarted) {
      g.__okfConsolidationStarted = true
      startConsolidation(root)
    }
  })
}
