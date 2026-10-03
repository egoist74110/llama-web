// What is known about row / tensor splits of one combination (build + ordered devices + mode), decision 45 ②:
// the user confirmed it once, or a load with it failed. Kept in `data/split-modes.json` (v1, atomic writes with
// backups through JsonStore). Only ids, version labels and numbers are stored: no paths, no model names.
//
// A failed combination is warned about before the next start but never changed automatically; a load that
// works afterwards clears the mark (it is proof the combination runs, at least for that model).
import { renameSync } from 'node:fs'
import type { ArgWarning } from './args'
import { isExperimentalMode, type GpuGroup } from './gpu-group'
import { JsonStore } from './store'

export interface ComboRecord {
  /** The user accepted the experimental mode for this combination (ms since epoch). */
  confirmedAt?: number
  /** The last failed load: when, and the diagnosed kind (`crashed`, `exited`, `cuda-error`, ...). */
  failed?: { at: number, kind: string }
}

interface Doc { version: number, combos: Record<string, ComboRecord> }

const MAX_COMBOS = 200
const KIND = /^[a-z][a-z0-9-]{0,40}$/

function cleanDoc(d: Doc): Doc {
  const combos: Record<string, ComboRecord> = {}
  if (!d.combos || typeof d.combos !== 'object' || Array.isArray(d.combos)) return { version: 1, combos }
  for (const [key, r] of Object.entries(d.combos)) {
    if (!r || typeof r !== 'object' || key.length > 300) continue
    const out: ComboRecord = {}
    if (Number.isFinite(r.confirmedAt) && r.confirmedAt! >= 0) out.confirmedAt = r.confirmedAt
    if (r.failed && Number.isFinite(r.failed.at) && typeof r.failed.kind === 'string' && KIND.test(r.failed.kind)) out.failed = { at: r.failed.at, kind: r.failed.kind }
    if (out.confirmedAt !== undefined || out.failed) combos[key] = out
  }
  // Oldest activity first out, so a long-lived install cannot grow the file without bound.
  const stamp = (r: ComboRecord) => Math.max(r.confirmedAt ?? 0, r.failed?.at ?? 0)
  const keys = Object.keys(combos)
  if (keys.length > MAX_COMBOS) {
    keys.sort((a, b) => stamp(combos[b]!) - stamp(combos[a]!))
    for (const k of keys.slice(MAX_COMBOS)) delete combos[k]
  }
  return { version: 1, combos }
}

export class SplitStats {
  private readonly store: JsonStore<Doc>
  private value: Doc

  constructor(dataDir: string, private now: () => number = Date.now) {
    this.store = new JsonStore<Doc>({ dataDir, name: 'split-modes.json', version: 1, keepBackups: 3, defaults: () => ({ version: 1, combos: {} }), validate: cleanDoc })
    // An unreadable file means "nothing known yet": it is kept aside (not deleted) and a fresh one takes its place.
    try { this.value = this.store.load() }
    catch {
      try { renameSync(this.store.file, `${this.store.file}.broken`) } catch { /* nothing to move */ }
      try { this.value = this.store.load() }
      catch { this.value = { version: 1, combos: {} } }
    }
  }

  get(key: string): ComboRecord | undefined {
    return Object.hasOwn(this.value.combos, key) ? this.value.combos[key] : undefined
  }

  confirm(key: string): void {
    this.value = this.store.update((d) => { (d.combos[key] ??= {}).confirmedAt = this.now() })
  }

  fail(key: string, kind: string): void {
    this.value = this.store.update((d) => { (d.combos[key] ??= {}).failed = { at: this.now(), kind } })
  }

  /** A load with this combination worked: drop the failed mark. No write when there is none. */
  succeed(key: string): void {
    if (!this.get(key)?.failed) return
    this.value = this.store.update((d) => {
      const r = d.combos[key]
      if (!r) return
      delete r.failed
      if (r.confirmedAt === undefined) delete d.combos[key]
    })
  }
}

/**
 * What to tell the user about a group before it starts: a mode the build does not list (an error: the load would
 * be refused), and for row / tensor, a previous failure or no confirmation yet (warnings; the load still runs).
 * `supported` null = the build's help could not be read: nothing is blocked.
 */
export function comboWarnings(group: GpuGroup | null, record: ComboRecord | undefined, supported: readonly string[] | null): ArgWarning[] {
  if (!group) return []
  const out: ArgWarning[] = []
  if (supported && !supported.includes(group.splitMode)) out.push({ code: 'split-mode-unsupported', severity: 'error', detail: group.splitMode })
  if (isExperimentalMode(group.splitMode)) {
    if (record?.failed) out.push({ code: 'split-mode-failed-before', severity: 'warning', detail: record.failed.kind })
    else if (record?.confirmedAt === undefined) out.push({ code: 'split-mode-unconfirmed', severity: 'warning', detail: group.splitMode })
  }
  return out
}

/** A failed load of a row / tensor group, wrapped so the diagnosis can name the split mode (`split-mode-failed`). */
export class SplitModeLoadError extends Error {
  constructor(public inner: unknown, public mode: string) {
    super(inner instanceof Error ? inner.message : String(inner))
    this.name = 'SplitModeLoadError'
  }
}

/** Failure kinds that say nothing about the split mode itself (capacity, slow disks, files, arguments, ports): not remembered. */
const NOT_THE_MODE = new Set(['oom', 'timeout', 'port-in-use', 'device-missing', 'unknown-arg', 'mmproj-mismatch', 'unsupported-arch', 'file-missing', 'bad-model', 'dll-missing',
  'no-port', 'spawn-failed', 'register-failed', 'aborted', 'model-missing', 'profile-missing', 'no-runtime', 'bad-args'])

/** True when a diagnosed load failure of a row / tensor group should be put on the failed list. */
export const blamesSplitMode = (kind: string): boolean => !NOT_THE_MODE.has(kind)
