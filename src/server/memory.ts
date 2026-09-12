/**
 * memory.ts — 运行时无关的记忆写入/撤回核心逻辑。
 *
 * 从 index.ts 抽出,供多运行时适配层共用:
 *  - dsh 适配层(src/server/index.ts)用它注册 okf_remember / okf_forget
 *  - pi 适配层(src/pi/index.ts)用它注册同名工具
 * 本模块零 dsh / 零 pi 依赖,只有 node:fs 与包内核模块。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  writeConcept, readConcept, refreshIndex, appendLog, filePathOf, withLock, type WriteResult,
} from './store.js'
import { findSimilarByTitle } from './dedupe.js'
import { loadMeta, saveMeta } from './learning.js'
import { normalizeType, mergeConceptBodies, type ConceptMeta } from './concept.js'

export interface RememberArgs {
  title: string
  type: string
  tags?: string[]
  related?: string[]
}

export interface RememberOpts {
  force?: boolean
  description?: string
  source?: string
}

export interface RememberResult {
  status: string
  conceptId: string | null
  filePath?: string
  reason?: string
  similarTo?: string
}

/**
 * remember 核心(服务与工具共用):类型校验 → 去重 → 小节级合并/新建 → 反馈。
 * 全程持写锁,保证"判断→写入"原子,避免并发下同标题概念被重复创建。
 */
export async function rememberCore(root: string, meta: RememberArgs, body: string, opts: RememberOpts = {}): Promise<RememberResult> {
  return withLock(async () => {
    const { title, type, tags, related } = meta
    if (!title || !body) throw new Error('title/content 必填')
    // P0-4:类型归一化 + 词表校验(非法类型不得新建污染目录)
    const normType = normalizeType(type)

    // 去重
    const similar = await findSimilarByTitle(root, title, normType)
    if (similar.length > 0) {
      const top = similar[0]
      if (top.similarity >= 1) {
        // 标题完全相同 → 更新(小节级合并)或跳过
        const existing = await readConcept(root, top.conceptId)
        const existingLen = String(existing.body || '').trim().length
        const newLen = String(body || '').trim().length
        if (newLen > existingLen * 0.7 && opts.force !== false) {
          // P0-5:按 # 小节合并:同小节覆盖、新小节追加,不再无限 "## 补充(日期)"
          const mergedBody = mergeConceptBodies(existing.body || '', body)
          const res = await writeConcept(root, {
            ...existing.meta, title, type: normType, tags: tags || existing.meta?.tags, timestamp: new Date().toISOString(),
          } as ConceptMeta, mergedBody)
          return { status: 'updated', conceptId: res.conceptId, filePath: res.filePath, reason: '标题相同,按小节合并更新' }
        }
        return { status: 'skipped', conceptId: top.conceptId, reason: `标题相同的概念已存在(${existingLen}字),新内容(${newLen}字)未显著增加` }
      }
      // 相近 → 建议互补
      return {
        status: 'linked',
        conceptId: top.conceptId,
        reason: `存在相近概念[${top.title}](${top.conceptId}),已返回其 ID;建议新建后与该概念互建交叉链接,而非复制内容`,
        similarTo: top.conceptId,
      }
    }

    // 新建
    const res = await writeConcept(root, {
      type: normType,
      title,
      description: opts.description || String(body).split('\n').find((l) => l.trim().startsWith('>'))?.replace(/^>\s*/, '').trim() || firstLine(body),
      tags: tags || [],
      timestamp: new Date().toISOString(),
      source: opts.source || 'session',
    }, body)
    // 互建交叉链接(related)
    if (Array.isArray(related) && related.length > 0) {
      for (const rid of related) {
        try {
          const r = await readConcept(root, String(rid).replace(/\.md$/, ''))
          const linkLine = `\n\n## 相关\n\n- [${title}](/${res.conceptId}.md)`
          if (!(r.body || '').includes(res.conceptId)) {
            await writeConcept(root, { ...r.meta, timestamp: new Date().toISOString() } as ConceptMeta, `${r.body?.trim() || ''}${linkLine}`)
          }
        } catch { /* 相关概念不存在则忽略 */ }
      }
    }
    return { status: 'created', conceptId: res.conceptId, filePath: res.filePath, reason: '新建' }
  })
}

export interface ForgetResult {
  status: string
  conceptId: string
  reason?: string
}

/**
 * forget 核心:概念不存在返回 not_found;默认移到 .meta/forgotten/(保留目录结构防同名冲突),
 * delete_file=true 时直接删除文件。全程持写锁。
 */
export async function forgetCore(root: string, id: string, deleteFile: boolean): Promise<ForgetResult> {
  return withLock(async () => {
    const filePath = filePathOf(root, id)
    let exists = true
    try {
      await fs.access(filePath)
    } catch {
      exists = false
    }
    if (!exists) {
      return { status: 'not_found', conceptId: id, reason: '概念不存在(可能已撤回)' }
    }
    if (deleteFile) {
      await fs.rm(filePath, { force: true })
    } else {
      // 保留相对目录结构,避免同 slug 概念在 forgotten 里撞文件
      const forgottenDir = path.join(root, '.meta', 'forgotten')
      const dest = path.join(forgottenDir, path.relative(root, filePath))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(filePath, dest)
    }
    await refreshIndex(root)
    await appendLog(root, {
      action: deleteFile ? 'forgotten(deleted)' : 'forgotten',
      conceptId: id,
      type: '—',
      title: deleteFile ? '已删除文件' : '已移至 .meta/forgotten/',
    })
    // 学习元数据:标记 inactive(可复活)
    const meta = await loadMeta(root)
    if (meta.entries[id]) {
      meta.entries[id].state = 'inactive'
      await saveMeta(root, meta)
    }
    return { status: 'forgotten', conceptId: id, reason: deleteFile ? '已删除文件' : '已移至 .meta/forgotten/' }
  })
}

/** 取正文首个非标题行,作为缺省 description */
export function firstLine(s: string): string {
  const line = String(s || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  return line ? line.slice(0, 120) : ''
}

export type { WriteResult }
