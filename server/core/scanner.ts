// Model directory scanner: recursive .gguf discovery, shard merging, mmproj / draft candidates.
import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { readGgufMeta, type GgufMeta } from './gguf'
import type { FileRef, ModelDir } from './types'

export type ScanKind = 'model' | 'mmproj' | 'draft' | 'invalid'

export interface ScanEntry {
  kind: ScanKind
  /** Main file; for sharded models the first shard. */
  ref: FileRef
  /** File name of `ref` (shard suffix kept). */
  fileName: string
  /** Total size in bytes across all shards found. */
  size: number
  /** Relative paths of all shards found, in order; null for single files. */
  shards: string[] | null
  /** False when shards are missing. */
  complete: boolean
  meta: GgufMeta | null
  /** Set when the header could not be parsed. */
  error: string | null
  /** For `model` entries: same-directory helper files. Never selected automatically. */
  candidates: { mmproj: FileRef[], draft: FileRef[] }
}

export interface ScanWarning {
  code: 'dir-missing' | 'dir-unreadable'
  dirId: string
  /** Relative path of the directory that failed ('' = root). */
  rel: string
}

export interface ScanResult {
  entries: ScanEntry[]
  warnings: ScanWarning[]
}

export interface ScanOptions {
  /** Concurrent header reads (default 4). */
  concurrency?: number
}

interface Found {
  dirId: string
  rel: string
  abs: string
  size: number
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i
const SKIP_DIR = /^(\.|\$)|^system volume information$/i

/** Resolve a FileRef to an absolute path, or null if the dir is unknown or the path escapes it. */
export function resolveFileRef(dirs: ModelDir[], ref: FileRef): string | null {
  const dir = dirs.find(d => d.id === ref.dirId)
  if (!dir) return null
  const root = resolve(dir.path)
  const abs = resolve(root, ...ref.rel.split('/'))
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/** Classify a scanned file. `meta` is null when the header could not be read. */
export function classifyFile(fileName: string, meta: GgufMeta | null): ScanKind {
  if (!meta) return 'invalid'
  if (meta.architecture === 'clip' || meta.type === 'mmproj' || /(^|[-_. ])mmproj([-_. ]|$)/i.test(fileName)) return 'mmproj'
  if (/mtp/i.test(meta.architecture ?? '') || /(^|[-_. ])(mtp|draft)([-_. ]|$)/i.test(fileName)) return 'draft'
  return 'model'
}

async function walk(dir: ModelDir, out: Found[], warnings: ScanWarning[]): Promise<void> {
  const root = resolve(dir.path)

  async function visit(abs: string, rel: string, depth: number): Promise<void> {
    let items
    try {
      items = await readdir(abs, { withFileTypes: true })
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      warnings.push({ code: missing ? 'dir-missing' : 'dir-unreadable', dirId: dir.id, rel })
      return
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name
      const childAbs = join(abs, item.name)
      if (item.isDirectory()) {
        if (depth < dir.maxDepth && !SKIP_DIR.test(item.name)) await visit(childAbs, childRel, depth + 1)
      } else if (item.isFile() && /\.gguf$/i.test(item.name)) {
        try {
          out.push({ dirId: dir.id, rel: childRel, abs: childAbs, size: (await stat(childAbs)).size })
        } catch { /* vanished while scanning */ }
      }
    }
  }

  await visit(root, '', 0)
}

interface Group {
  files: Found[]
  complete: boolean
  sharded: boolean
}

function group(found: Found[]): Group[] {
  const groups: Group[] = []
  const shardGroups = new Map<string, { files: Map<number, Found>, total: number }>()
  for (const f of found) {
    const m = SHARD_RE.exec(basename(f.rel))
    if (!m) {
      groups.push({ files: [f], complete: true, sharded: false })
      continue
    }
    const parent = f.rel.slice(0, f.rel.length - basename(f.rel).length)
    const key = `${f.dirId}\0${parent}${m[1]}\0${m[3]}`
    let g = shardGroups.get(key)
    if (!g) shardGroups.set(key, g = { files: new Map(), total: Number(m[3]) })
    g.files.set(Number(m[2]), f)
  }
  for (const g of shardGroups.values()) {
    const indexes = [...g.files.keys()].sort((a, b) => a - b)
    let complete = indexes.length === g.total
    for (let i = 1; complete && i <= g.total; i++) if (!g.files.has(i)) complete = false
    groups.push({ files: indexes.map(i => g.files.get(i)!), complete, sharded: true })
  }
  return groups
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

function parentOf(rel: string) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

export async function scanModelDirs(dirs: ModelDir[], opts: ScanOptions = {}): Promise<ScanResult> {
  const found: Found[] = []
  const warnings: ScanWarning[] = []
  for (const dir of dirs) if (dir.enabled) await walk(dir, found, warnings)

  const entries = await mapLimit(group(found), opts.concurrency ?? 4, async (g): Promise<ScanEntry> => {
    const first = g.files[0]!
    let meta: GgufMeta | null = null
    let error: string | null = null
    try {
      meta = await readGgufMeta(first.abs)
      if (g.sharded && meta.parameterCountFromTensors) {
        // Tensor infos are split across shards, so sum them all.
        let total = meta.parameterCount ?? 0
        for (const other of g.files.slice(1)) {
          try {
            total += (await readGgufMeta(other.abs)).parameterCount ?? 0
          } catch { /* keep partial sum */ }
        }
        meta = { ...meta, parameterCount: total }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const fileName = basename(first.rel)
    return {
      kind: classifyFile(fileName, meta),
      ref: { dirId: first.dirId, rel: first.rel },
      fileName,
      size: g.files.reduce((n, f) => n + f.size, 0),
      shards: g.sharded ? g.files.map(f => f.rel) : null,
      complete: g.complete,
      meta,
      error,
      candidates: { mmproj: [], draft: [] },
    }
  })

  // Helper files in the same directory are offered as candidates only.
  for (const model of entries) {
    if (model.kind !== 'model') continue
    for (const other of entries) {
      if (other.ref.dirId !== model.ref.dirId || parentOf(other.ref.rel) !== parentOf(model.ref.rel)) continue
      if (other.kind === 'mmproj') model.candidates.mmproj.push(other.ref)
      else if (other.kind === 'draft') model.candidates.draft.push(other.ref)
    }
  }

  entries.sort((a, b) => a.ref.dirId.localeCompare(b.ref.dirId) || a.ref.rel.localeCompare(b.ref.rel))
  return { entries, warnings }
}
