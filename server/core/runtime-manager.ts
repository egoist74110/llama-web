// Listing and deleting llama.cpp builds (decision 35), on top of runtimes.ts (references,
// registry) and runtime-add.ts (adding). Pure module: settings, models and "which executables
// run right now" come in as callbacks. Deleting is synchronous from the checks to the last
// state change, so a version switch or a launch cannot slip in between.
import { renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentTagFor, type ModelsDoc, type Settings } from './config'
import { installedDir } from './llamacpp'
import type { RuntimeTarget } from './platform'
import {
  channelsFor, customDir, entryRunsHere, installedOfficial, officialRef, parseRuntimeRef, refOfExe,
  type RuntimeAccel, type RuntimeEntry, type RuntimeEnv, type RuntimeRegistry,
} from './runtimes'

export type DeleteErrorCode = 'bad-ref' | 'not-found' | 'latest-official' | 'in-use' | 'needs-confirm' | 'locked' | 'failed'

export class DeleteError extends Error {
  constructor(public code: DeleteErrorCode, message: string, public detail?: unknown) {
    super(message)
    this.name = 'DeleteError'
  }
}

export interface RuntimeRow {
  ref: string
  kind: 'official' | 'custom'
  accel: RuntimeAccel
  /** `b11146`; empty for a hand-added build whose number is unknown. */
  tag: string
  label: string
  /** The current version of its channel (each official channel has one). */
  current: boolean
  /** A running / starting llama-server uses it. */
  inUse: boolean
  /** Newest installed official build of its channel: cannot be deleted. */
  latestOfficial: boolean
  deletable: boolean
  addedAt?: string
  source?: RuntimeEntry['source']
}

/** GET /api/llamacpp `runtimes`: only builds of this host (others stay on disk, hidden). */
export interface RuntimeListing {
  rows: RuntimeRow[]
  /** Registered builds of another os / architecture, hidden from every list and choice. */
  hiddenOtherPlatform: number
}

export interface AffectedUse {
  modelId: string
  /** null = the model's own choice, else the profile that chose it. */
  profile: string | null
}

export interface DeletePlan {
  ref: string
  /** Why it cannot be deleted (never `needs-confirm`), or null. */
  blocked: null | 'latest-official' | 'in-use'
  affected: AffectedUse[]
  /** The global current version is this one: the channel's newest official build becomes current. */
  isCurrent: boolean
  becomesCurrent: string | null
  needsConfirm: boolean
}

export interface ManagerOptions {
  dataDir: string
  target: RuntimeTarget
  registry: RuntimeRegistry
  getSettings(): Settings
  getModels(): ModelsDoc
  /** Executable paths of running / starting llama-server processes. */
  usedExes(): string[]
  /** Make `tag` the current version of the channel `accel` (the GPU channel's `current` or the CPU channel's `currentCpu`). */
  setCurrent(tag: string, accel: RuntimeAccel): void
  /** Clear runtime references in models.json (one write). */
  updateModels(fn: (draft: ModelsDoc) => void): void
  /** Called after any change of the build list (refresh caches, notify pages). */
  onChanged?(): void
  /** Directory removal; tests inject failures. */
  rename?: typeof renameSync
}

export function useOfRef(models: ModelsDoc, ref: string): AffectedUse[] {
  const out: AffectedUse[] = []
  for (const m of models.models) {
    if (m.runtime === ref) out.push({ modelId: m.id, profile: null })
    for (const [name, p] of Object.entries(m.profiles)) if (p.runtime === ref) out.push({ modelId: m.id, profile: name })
  }
  return out
}

export class RuntimeManager {
  constructor(private readonly o: ManagerOptions) {}

  env(): RuntimeEnv {
    return { dataDir: this.o.dataDir, target: this.o.target, entries: this.o.registry.list() }
  }

  private usedRefs(): Set<string> {
    const used = new Set<string>()
    for (const exe of this.o.usedExes()) {
      const r = refOfExe(this.o.dataDir, exe)
      if (r) used.add(r)
    }
    return used
  }

  /** Reference of each channel's current version. */
  private currentRefs(): Set<string> {
    const refs = new Set<string>()
    for (const accel of channelsFor(this.o.target)) {
      const cur = currentTagFor(this.o.getSettings(), this.o.target, accel)
      if (cur) refs.add(officialRef(accel, cur))
    }
    return refs
  }

  list(): RuntimeListing {
    const env = this.env()
    const used = this.usedRefs()
    const current = this.currentRefs()
    const rows: RuntimeRow[] = []
    for (const accel of channelsFor(this.o.target)) {
      const tags = installedOfficial(env, accel)
      tags.forEach((tag, i) => {
        const ref = officialRef(accel, tag)
        const inUse = used.has(ref)
        const latestOfficial = i === 0
        rows.push({ ref, kind: 'official', accel, tag, label: tag, current: current.has(ref), inUse, latestOfficial, deletable: !latestOfficial && !inUse })
      })
    }
    let hidden = 0
    for (const e of env.entries) {
      if (!entryRunsHere(e, this.o.target)) { hidden++; continue }
      const ref = `custom:${e.id}`
      const inUse = used.has(ref)
      rows.push({
        ref, kind: 'custom', accel: e.accel, tag: e.tag, label: e.label, current: false, inUse, latestOfficial: false,
        deletable: !inUse, addedAt: e.addedAt, source: e.source,
      })
    }
    return { rows, hiddenOtherPlatform: hidden }
  }

  /** What deleting `ref` would do. Throws DeleteError for a reference that is not a visible build. */
  plan(ref: string): DeletePlan {
    const p = parseRuntimeRef(ref)
    if (!p) throw new DeleteError('bad-ref', 'Invalid version reference')
    const env = this.env()
    let blocked: DeletePlan['blocked'] = null
    let isCurrent = false
    let becomes: string | null = null
    if (p.kind === 'official') {
      const tags = channelsFor(this.o.target).includes(p.accel) ? installedOfficial(env, p.accel) : []
      if (!tags.includes(p.tag)) throw new DeleteError('not-found', 'This version is not installed')
      if (tags[0] === p.tag) blocked = 'latest-official'
      isCurrent = currentTagFor(this.o.getSettings(), this.o.target, p.accel) === p.tag
      if (isCurrent) becomes = tags[0] !== p.tag ? tags[0]! : null
    } else {
      const e = env.entries.find(x => x.id === p.id)
      if (!e || !entryRunsHere(e, this.o.target)) throw new DeleteError('not-found', 'This version is not installed')
    }
    if (!blocked && this.usedRefs().has(ref)) blocked = 'in-use'
    const affected = useOfRef(this.o.getModels(), ref)
    return { ref, blocked, affected, isCurrent, becomesCurrent: becomes, needsConfirm: affected.length > 0 || isCurrent }
  }

  /**
   * Delete a build. Refuses the newest official build of a channel and builds in use; when models
   * or the global version point at it, `confirm` must be true: then those references are cleared
   * (models follow the global version again) and the global version moves to the channel's newest
   * official build. The directory is renamed first (fails while any file is open), so it is removed
   * as a whole or not at all.
   */
  remove(ref: string, opts: { confirm?: boolean } = {}): DeletePlan {
    const plan = this.plan(ref)
    if (plan.blocked) throw new DeleteError(plan.blocked, plan.blocked === 'in-use' ? 'A running model uses this version' : 'The newest official version cannot be deleted')
    if (plan.needsConfirm && opts.confirm !== true) throw new DeleteError('needs-confirm', 'Confirmation required', plan)
    const p = parseRuntimeRef(ref)!
    const rename = this.o.rename ?? renameSync
    const dir = p.kind === 'official'
      ? installedDir(this.o.dataDir, p.tag, { os: this.o.target.os, arch: this.o.target.arch, acceleration: p.accel })
      : customDir(this.o.dataDir, p.id)
    const trash = join(dirname(dir), `.del-${p.kind === 'official' ? p.tag : p.id}-${process.pid}-${Date.now()}`)
    try {
      rename(dir, trash)
    } catch (e) {
      throw new DeleteError('locked', 'The version is in use by a program and cannot be removed', (e as Error).message)
    }
    try {
      if (plan.affected.length) {
        this.o.updateModels((doc) => {
          for (const m of doc.models) {
            if (m.runtime === ref) delete m.runtime
            for (const pr of Object.values(m.profiles)) if (pr.runtime === ref) delete pr.runtime
          }
        })
      }
      if (p.kind === 'custom') this.o.registry.remove(p.id)
      if (plan.isCurrent && plan.becomesCurrent) this.o.setCurrent(plan.becomesCurrent, p.kind === 'official' ? p.accel : this.o.target.acceleration)
    } catch (e) {
      try { rename(trash, dir) } catch { /* the directory stays in the trash name; cleared at startup */ }
      throw new DeleteError('failed', 'Could not update the configuration', (e as Error).message)
    }
    try { rmSync(trash, { recursive: true, force: true }) } catch { /* cleared at the next start */ }
    this.o.onChanged?.()
    return plan
  }

  /** Make an installed official build the current version of its channel (the settings page). */
  useCurrent(accel: RuntimeAccel, tag: unknown): string {
    if (typeof tag !== 'string' || !/^b\d+$/.test(tag)) throw new DeleteError('bad-ref', 'Invalid version tag')
    if (!channelsFor(this.o.target).includes(accel) || !installedOfficial(this.env(), accel).includes(tag)) throw new DeleteError('not-found', 'This version is not installed')
    this.o.setCurrent(tag, accel)
    this.o.onChanged?.()
    return tag
  }

  /**
   * Official tags (of the channel the updater manages) that a model or profile picked: automatic
   * pruning keeps them. Hand-added builds are never pruned (they are not in the version listing).
   */
  protectedTags(accel: RuntimeAccel = this.o.target.acceleration): Set<string> {
    const tags = new Set<string>()
    for (const m of this.o.getModels().models) {
      for (const r of [m.runtime, ...Object.values(m.profiles).map(p => p.runtime)]) {
        const p = parseRuntimeRef(r)
        if (p?.kind === 'official' && p.accel === accel) tags.add(p.tag)
      }
    }
    return tags
  }
}
