// GPU groups and split modes (decision 45). One layer of the configuration (profile, model, global
// defaults) stores a device choice as five optional fields:
//
//   device      '' inherit | 'auto' | 'cpu' | one id           (the single choice of decision 39)
//   devices     two or more ids = a GPU group, in the order `--device` and `--tensor-split` use
//   splitMode   layer | row | tensor                           (group only; empty = layer)
//   tensorSplit `3,1` proportions, one per device               (group only; empty = llama.cpp splits by free memory)
//   mainGpu     index passed to `--main-gpu`                    (group only; empty = not passed)
//
// A layer holds either a single choice or a group, never both, and its split fields always belong to
// its own devices: the first layer with any choice wins as a whole. One id in `devices` is the same as
// a single choice, so a group always has at least two devices ("at least one GPU" is kept by the form;
// the server never stores an empty group, it stores nothing = inherit).
//
// Pure module: no I/O. Checked on b11146 (RTX 5090): `-sm` takes none / layer / row / tensor.
import { normalizeDevice } from './args'
import type { DeviceList, GpuDevice } from './devices'

export const SPLIT_MODES = ['layer', 'row', 'tensor'] as const
export type SplitMode = typeof SPLIT_MODES[number]
/** Modes that need a first-use confirmation and are remembered when they fail (decision 45). */
export const EXPERIMENTAL_MODES: readonly SplitMode[] = ['row', 'tensor']
export const DEFAULT_SPLIT_MODE: SplitMode = 'layer'
export const MAX_GROUP = 16

/** The five stored fields of one layer. Missing / empty = not set. */
export interface GpuChoice {
  device?: string | null
  devices?: string[] | null
  splitMode?: string | null
  tensorSplit?: string | null
  mainGpu?: string | null
}

export const GPU_KEYS = ['device', 'devices', 'splitMode', 'tensorSplit', 'mainGpu'] as const

/** A resolved group: two or more devices and how the model is spread over them. */
export interface GpuGroup {
  devices: string[]
  splitMode: SplitMode
  /** Proportions as stored (`3,1`), or null = not passed. */
  tensorSplit: string | null
  /** Index for `--main-gpu`, or null = not passed. */
  mainGpu: string | null
}

const TENSOR_SPLIT = /^\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)*$/
const MAIN_GPU = /^\d{1,2}$/

export const isSplitMode = (v: unknown): v is SplitMode => typeof v === 'string' && (SPLIT_MODES as readonly string[]).includes(v)
export const isExperimentalMode = (m: string) => (EXPERIMENTAL_MODES as readonly string[]).includes(m)

/** Number of entries of a stored `tensorSplit`. */
export const tensorSplitParts = (s: string) => s.split(',').length

/**
 * Validate one choice from a client or a hand-edited file. Returns the cleaned choice (empty strings /
 * `[]` for what is not set) or null when it is invalid: an unknown mode, a malformed ratio or index, a
 * ratio whose count differs from the devices, `auto` / `cpu` inside a group.
 */
export function sanitizeGpuChoice(raw: unknown): { device: string, devices: string[], splitMode: string, tensorSplit: string, mainGpu: string } | null {
  if (raw === undefined || raw === null) return { device: '', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  let device = normalizeDevice(r.device)
  if (device === null) return null

  let devices: string[] = []
  if (r.devices !== undefined && r.devices !== null) {
    if (!Array.isArray(r.devices) || r.devices.length > MAX_GROUP) return null
    for (const x of r.devices) {
      const id = typeof x === 'string' ? normalizeDevice(x) : null
      if (!id || id === 'auto' || id === 'cpu' || devices.includes(id)) return null
      devices.push(id)
    }
  }
  const splitMode = typeof r.splitMode === 'string' ? r.splitMode.trim().toLowerCase() : r.splitMode ?? ''
  const tensorSplit = typeof r.tensorSplit === 'string' ? r.tensorSplit.replace(/\s+/g, '') : r.tensorSplit ?? ''
  const mainGpu = typeof r.mainGpu === 'string' ? r.mainGpu.trim() : r.mainGpu ?? ''
  if (typeof splitMode !== 'string' || typeof tensorSplit !== 'string' || typeof mainGpu !== 'string') return null
  if (splitMode !== '' && !isSplitMode(splitMode)) return null
  if (tensorSplit !== '' && (tensorSplit.length > 200 || !TENSOR_SPLIT.test(tensorSplit) || !tensorSplit.split(',').some(p => Number(p) > 0))) return null
  if (mainGpu !== '' && !MAIN_GPU.test(mainGpu)) return null

  if (devices.length === 1) {
    // One device is the single choice; the group fields mean nothing for it.
    device = devices[0]!
    devices = []
  }
  if (devices.length === 0) return { device, devices, splitMode: '', tensorSplit: '', mainGpu: '' }
  if (tensorSplit !== '' && tensorSplitParts(tensorSplit) !== devices.length) return null
  if (mainGpu !== '' && Number(mainGpu) >= devices.length) return null
  return { device: '', devices, splitMode, tensorSplit, mainGpu }
}

/** Write a cleaned choice onto a profile / model / defaults object: set fields are stored, empty ones removed. */
export function applyGpuChoice(target: GpuChoice, c: { device: string, devices: string[], splitMode: string, tensorSplit: string, mainGpu: string }): void {
  const t = target as Record<string, unknown>
  for (const k of GPU_KEYS) {
    const v = c[k]
    if (Array.isArray(v) ? v.length : v) t[k] = v
    else delete t[k]
  }
}

/** The five fields of an object as a choice (what the form shows). */
export function readGpuChoice(o: GpuChoice | null | undefined): { device: string, devices: string[], splitMode: string, tensorSplit: string, mainGpu: string } {
  return {
    device: o?.device ?? '', devices: Array.isArray(o?.devices) ? [...o.devices] : [],
    splitMode: o?.splitMode ?? '', tensorSplit: o?.tensorSplit ?? '', mainGpu: o?.mainGpu ?? '',
  }
}

/** True when a client body carries any of the five fields (then it replaces the whole choice). */
export const hasGpuFields = (raw: unknown): boolean =>
  !!raw && typeof raw === 'object' && GPU_KEYS.some(k => (raw as Record<string, unknown>)[k] !== undefined)

/** Clean a stored object after loading: a choice that is not valid as a whole is dropped (= inherit). */
export function cleanStoredChoice(o: GpuChoice): void {
  if (!GPU_KEYS.some(k => (o as Record<string, unknown>)[k] !== undefined)) return
  const c = sanitizeGpuChoice(readGpuChoice(o))
  const empty = { device: '', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' }
  applyGpuChoice(o, c ?? empty)
}

export interface GpuSelection {
  /** `auto`, `cpu`, one id, or the ids of a group joined by `,`. */
  device: string
  group: GpuGroup | null
}

/** First layer with a choice wins as a whole (profile, model, global defaults); `auto` when none has one. */
export function resolveGpuSelection(...layers: Array<GpuChoice | null | undefined>): GpuSelection {
  for (const l of layers) {
    if (!l) continue
    const c = sanitizeGpuChoice(readGpuChoice(l))
    if (!c) continue
    if (c.devices.length >= 2) {
      const mode = isSplitMode(c.splitMode) ? c.splitMode : DEFAULT_SPLIT_MODE
      return {
        device: c.devices.join(','),
        group: { devices: c.devices, splitMode: mode, tensorSplit: c.tensorSplit || null, mainGpu: c.mainGpu || null },
      }
    }
    if (c.device) return { device: c.device, group: null }
  }
  return { device: 'auto', group: null }
}

/** Ids a launch needs from the device list: the group, or the single device; none for `auto` / `cpu`. */
export function requiredDevices(sel: GpuSelection): string[] {
  if (sel.group) return sel.group.devices
  return sel.device === 'auto' || sel.device === 'cpu' ? [] : [sel.device]
}

/**
 * Decision 45 ①: with nothing chosen and several GPUs on the list, the model runs on the one with the most
 * memory (the first of equals). One GPU or an unreadable list leaves `auto` alone: llama.cpp does the same
 * thing there, so the command stays what it was before this feature.
 */
export function autoPick(list: DeviceList): GpuDevice | null {
  if (list.source !== 'list-devices' || list.gpus.length < 2) return null
  return list.gpus.reduce((best, g) => (g.totalMiB > best.totalMiB ? g : best))
}

/** Key of a combination that can fail as a whole: build + ordered devices + mode (decision 45 ②). */
export const comboKey = (runtimeKey: string, devices: readonly string[], mode: string) => `${runtimeKey}|${devices.join(',')}|${mode}`
