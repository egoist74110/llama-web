// Removing a model: always drops its configuration; optionally moves its files (main model with
// all shards, mmproj, draft) to the system trash. Only files inside a registered model directory
// are ever touched, and files another model still uses are kept. Pure module (no Nitro).
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ModelsDoc } from './config'
import { ModelBusyError } from './model-ops'
import { sameRef, type ModelFile } from './models-admin'
import { resolveFileRef, SHARD_RE } from './scanner'
import { moveToTrash, type TrashResult } from './trash'
import type { FileRef, ModelDir } from './types'

export type RemoveErrorCode = 'model-not-found' | 'in-use' | 'outside-dir' | 'trash-failed'

export class RemoveError extends Error {
  constructor(public code: RemoveErrorCode, public detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'RemoveError'
  }
}

export interface RemoveFile {
  kind: ModelFile
  /** Directory id + path relative to it (every shard is its own entry). */
  ref: FileRef
  abs: string
  /** What will happen: moved to the trash, kept because another model uses it, or already gone. */
  action: 'trash' | 'keep-shared' | 'missing'
  /** Names of the other models using the file (for `keep-shared`). */
  usedBy: string[]
}

export interface RemovePlan {
  modelId: string
  files: RemoveFile[]
}

export interface RemoveResult {
  trashed: FileRef[]
  keptShared: Array<{ ref: FileRef, usedBy: string[] }>
  missing: FileRef[]
  /** Helper files (mmproj / draft) that could not be moved; the model itself was still removed. */
  failed: FileRef[]
}

export interface PlanFs {
  readdir: (dir: string) => string[]
  /** 'file' | 'dir' | 'link' | null (missing). */
  kind: (abs: string) => 'file' | 'dir' | 'link' | null
  realpath: (p: string) => string
}

const realFs: PlanFs = {
  readdir: dir => readdirSync(dir),
  kind: (abs) => {
    try {
      const st = lstatSync(abs)
      return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  },
  realpath: p => realpathSync(p),
}

const within = (root: string, p: string) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The file plus, for `name-00001-of-0000N.gguf`, every shard of that set found next to it. */
function expandShards(ref: FileRef, abs: string, fs: PlanFs): Array<{ ref: FileRef, abs: string }> {
  const m = SHARD_RE.exec(basename(abs))
  if (!m) return [{ ref, abs }]
  const parentAbs = dirname(abs)
  const slash = ref.rel.lastIndexOf('/')
  const parentRel = slash < 0 ? '' : ref.rel.slice(0, slash + 1)
  let names: string[]
  try { names = fs.readdir(parentAbs) } catch { return [{ ref, abs }] }
  const out = names
    .filter((n) => { const x = SHARD_RE.exec(n); return !!x && x[1] === m[1] && x[3] === m[3] })
    .sort()
    .map(n => ({ ref: { dirId: ref.dirId, rel: `${parentRel}${n}` }, abs: join(parentAbs, n) }))
  return out.length ? out : [{ ref, abs }]
}

/**
 * What removing the model with its files would do. Throws RemoveError('outside-dir') when any
 * configured file does not resolve to a regular file inside a registered model directory
 * (unknown directory, `..` escape, or a symlinked parent that leads outside); nothing is
 * planned in that case so the caller can refuse before touching anything.
 */
export function planRemove(doc: ModelsDoc, dirs: ModelDir[], modelId: string, fs: PlanFs = realFs): RemovePlan {
  const model = doc.models.find(m => m.id === modelId)
  if (!model) throw new RemoveError('model-not-found')
  const others = doc.models.filter(m => m.id !== modelId)
  const usedBy = (ref: FileRef) => others
    .filter(o => sameRef(o.file, ref) || sameRef(o.mmproj, ref) || sameRef(o.draft, ref))
    .map(o => o.name)

  const files: RemoveFile[] = []
  const seen = new Set<string>()
  for (const kind of ['model', 'mmproj', 'draft'] as const) {
    const ref = kind === 'model' ? model.file : model[kind]
    if (!ref) continue
    const abs = resolveFileRef(dirs, ref)
    if (!abs || !/\.gguf$/i.test(abs)) throw new RemoveError('outside-dir', ref.rel)
    const root = dirs.find(d => d.id === ref.dirId)!.path
    for (const part of expandShards(ref, abs, fs)) {
      const key = `${part.ref.dirId}\0${part.ref.rel}`
      if (seen.has(key)) continue
      seen.add(key)
      // The part must still be inside the registered root after symlinks are resolved.
      let parentReal: string
      let rootReal: string
      try {
        parentReal = fs.realpath(dirname(part.abs))
        rootReal = fs.realpath(resolve(root))
      } catch {
        files.push({ kind, ref: part.ref, abs: part.abs, action: 'missing', usedBy: [] })
        continue
      }
      if (!within(rootReal, parentReal)) throw new RemoveError('outside-dir', part.ref.rel)
      const type = fs.kind(part.abs)
      if (type === null) { files.push({ kind, ref: part.ref, abs: part.abs, action: 'missing', usedBy: [] }); continue }
      if (type === 'dir') throw new RemoveError('outside-dir', part.ref.rel)
      const by = usedBy(part.ref)
      files.push({ kind, ref: part.ref, abs: part.abs, action: by.length ? 'keep-shared' : 'trash', usedBy: by })
    }
  }
  return { modelId, files }
}

export interface RemoveDeps {
  ops: { forget(modelId: string): Promise<void> }
  getModels(): ModelsDoc
  updateModels(fn: (doc: ModelsDoc) => void): void
  dirs(): ModelDir[]
  trash?: (paths: string[]) => Promise<TrashResult>
  fs?: PlanFs
}

/**
 * Remove a model. Without `deleteFiles` only the configuration goes and the disk is not touched.
 * With it, the main model files must reach the trash (or already be gone) before the
 * configuration is removed; mmproj / draft failures are reported but do not block.
 * A model that is running, loading or queued is refused (RemoveError 'in-use'); it is never stopped.
 */
export async function removeModel(deps: RemoveDeps, modelId: string, deleteFiles: boolean): Promise<RemoveResult> {
  const result: RemoveResult = { trashed: [], keptShared: [], missing: [], failed: [] }
  const doc = deps.getModels()
  if (!doc.models.some(m => m.id === modelId)) throw new RemoveError('model-not-found')
  const guard = async () => {
    try { await deps.ops.forget(modelId) } catch (e) {
      if (e instanceof ModelBusyError) throw new RemoveError('in-use')
      throw e
    }
  }
  await guard()

  if (deleteFiles) {
    const plan = planRemove(doc, deps.dirs(), modelId, deps.fs)
    for (const f of plan.files) {
      if (f.action === 'missing') result.missing.push(f.ref)
      else if (f.action === 'keep-shared') result.keptShared.push({ ref: f.ref, usedBy: f.usedBy })
    }
    const todo = plan.files.filter(f => f.action === 'trash')
    // A load may have been requested while the plan was built; files must not vanish under it.
    await guard()
    const { failed } = await (deps.trash ?? moveToTrash)(todo.map(f => f.abs))
    const bad = new Set(failed)
    for (const f of todo) (bad.has(f.abs) ? result.failed : result.trashed).push(f.ref)
    const mainFailed = todo.some(f => f.kind === 'model' && bad.has(f.abs))
    if (mainFailed) throw new RemoveError('trash-failed', todo.find(f => f.kind === 'model' && bad.has(f.abs))!.ref.rel)
  }

  deps.updateModels((d) => {
    const i = d.models.findIndex(m => m.id === modelId)
    if (i >= 0) d.models.splice(i, 1)
  })
  return result
}
