// Memory estimate for one llama-server launch (decisions 43–45). Pure module: every input is passed in
// (GGUF facts, launch parameters, the devices and the system memory), nothing is read from the machine here.
//
// The formulas were checked against llama-server b11146 on Apple silicon (docs/research/memory-estimate.md): the
// per-buffer sizes it logs at load time (`-v`: `KV buffer`, `compute buffer`, `RS buffer`, `model buffer`) and the
// device total the OS reports. Parts that could not be measured on that machine are listed in `notes`
// (`unverified-*`) and are on the safe (larger) side. The result never contains a GPU wording: a Mac or a CPU-only
// run is the same structure with fewer pools.
import type { GgufArch, GgufLayout, GgufMeta } from './gguf'

export const MIB = 1024 * 1024

export type Tier = 'ok' | 'risky' | 'nofit' | 'unknown'
/** Share of the budget up to which a launch is `ok` (decision 42); above 1.0 it does not fit. */
export const RISKY_FROM = 0.85

/** Bytes per element of the KV cache types llama.cpp accepts (`--cache-type-k/v`). */
export const CACHE_BYTES: Readonly<Record<string, number>> = {
  f32: 4, f16: 2, bf16: 2, q8_0: 34 / 32, q4_0: 18 / 32, q4_1: 20 / 32, iq4_nl: 18 / 32, q5_0: 22 / 32, q5_1: 24 / 32,
}

/** What the estimate needs to know about one model (all shards together). */
export interface ModelFacts {
  meta: GgufMeta
  /** Per-layer tensor bytes of ALL shards together; null = unknown (a uniform split of the file size is used). */
  layout: GgufLayout | null
  /** Sum of the file sizes of all shards. */
  totalBytes: number
  /** `layout` covers only some of the shards: the per-layer numbers cannot be trusted, so they are not used. */
  sharded?: boolean
}

export interface EstimateParams {
  /** Null = the model's own context length (`--ctx-size 0`). */
  ctxSize?: number | null
  cacheTypeK?: string | null
  cacheTypeV?: string | null
  /** `on` | `off` | `auto` (auto counts as on: every runtime this app ships supports it). */
  flashAttn?: string | null
  /** Null / negative = every layer. */
  gpuLayers?: number | null
  batchSize?: number | null
  ubatchSize?: number | null
  /** Null / 0 / negative = llama-server's automatic 4 slots with one shared (unified) KV cache. */
  parallel?: number | null
  /** `--swa-full` */
  swaFull?: boolean
  /** `--no-kv-offload` */
  kvOnHost?: boolean
  /** The weights are locked in RAM (`--load-mode mlock` / `--mlock`). */
  mlock?: boolean
  /** `--no-mmproj-offload`: the vision projector runs on the CPU, so it takes system memory, not the device's. */
  mmprojOnHost?: boolean
}

export interface DraftInput {
  facts: ModelFacts
  params?: Pick<EstimateParams, 'ctxSize' | 'cacheTypeK' | 'cacheTypeV' | 'gpuLayers'>
}

export interface DeviceInput {
  id: string
  name: string
  /** `separate` = its own memory (CUDA / Vulkan / ROCm card); `shared` = the system's RAM (Metal). */
  memory: 'separate' | 'shared'
  /** What it can still give to this model right now (already without other models / programs); null = unknown. */
  freeMiB: number | null
  /** Upper limit of a `shared` device (the OS working-set cap), null = none known. */
  capMiB?: number | null
  /** The device's raw share of the layers when several are used, as `--tensor-split` gives it (default: an equal split). */
  share?: number
  /** Context / runtime memory the device takes besides the model (default by kind, see `FIXED_OVERHEAD_MIB`). */
  fixedMiB?: number
}

export interface SystemMemory {
  totalMiB: number | null
  /** Memory a new process can take without evicting running ones (see `memory-sample.ts`); null = unknown. */
  availableMiB: number | null
}

export interface EstimateInput {
  model: ModelFacts
  params?: EstimateParams
  /** The size of the mmproj file, 0 / absent = none. */
  mmprojBytes?: number
  draft?: DraftInput | null
  /** The devices that run the model; empty = CPU only. */
  devices?: DeviceInput[]
  system?: SystemMemory
}

export interface Breakdown {
  weightsMiB: number
  /** Attention KV cache (full and sliding-window layers). */
  kvMiB: number
  /** Recurrent state of Mamba / linear-attention layers. */
  stateMiB: number
  computeMiB: number
  mmprojMiB: number
  draftMiB: number
  fixedMiB: number
  totalMiB: number
}

/**
 * A place memory comes from: a device with its own memory, the system RAM, or (`shared`) the one pool a Mac / an
 * integrated device and the system share.
 */
export interface Pool extends Breakdown {
  id: string
  name: string
  kind: 'separate' | 'host' | 'shared'
  budgetMiB: number | null
  /** total / budget, null when the budget is unknown. */
  ratio: number | null
  tier: Tier
}

export interface MemoryEstimate {
  pools: Pool[]
  /** The worst pool (`unknown` only when no pool is worse). */
  tier: Tier
  /** Weights locked in RAM when `mlock` is on (decision 44), 0 otherwise. */
  mlockMiB: number
  /** The same numbers split by what takes them, summed over the pools. */
  total: Breakdown
  kv: { fullCells: number, swaCells: number, slots: number, unified: boolean, ctx: number }
  /** Codes of things the estimate could not model or measure; the interface turns them into text. */
  notes: EstimateNote[]
}

export type EstimateNote =
  | 'ctx-from-model' | 'layout-unknown' | 'arch-incomplete' | 'unverified-separate-memory' | 'unverified-multi-device'
  | 'unverified-moe-compute' | 'unverified-mla' | 'window-pattern-guessed' | 'budget-unknown' | 'unverified-draft-compute'
  | 'mmproj-compute-single-sample' | 'split-mode-unmodelled'

/** Per-device context memory besides the model; CUDA numbers are a safe guess, not measured (no such machine here). */
export const FIXED_OVERHEAD_MIB = { separate: 512, shared: 0 }

/** Headroom the system keeps for itself: the larger of 15% of RAM and 2 GiB (decision 44). */
export function systemReserveMiB(totalMiB: number): number {
  return Math.max(0.15 * totalMiB, 2048)
}

const pad256 = (n: number) => Math.ceil(n / 256) * 256
const mib = (bytes: number) => bytes / MIB

type LayerKind = 'full' | 'swa' | 'recurrent'

// Architectures whose sliding-window pattern is fixed in llama.cpp, not stored in the file (every Nth layer is full).
const BUILTIN_WINDOW_PATTERN: Record<string, number> = { gemma2: 2, gemma3: 6, gemma3n: 5, 'gpt-oss': 2, cohere2: 4 }

/** What every layer is: full attention, sliding window or recurrent. `null` when the file does not say enough. */
export function layerKinds(a: GgufArch, architecture: string | null): { kinds: LayerKind[], guessedWindow: boolean } | null {
  const L = a.blockCount
  if (!L || L <= 0) return null
  const kinds: LayerKind[] = []
  const hasSsm = a.ssm !== null
  const kvList = Array.isArray(a.headCountKv) ? a.headCountKv : null
  let guessedWindow = false
  let pattern = a.slidingWindowPattern
  if (a.slidingWindow && pattern === null && architecture) {
    const builtin = BUILTIN_WINDOW_PATTERN[architecture]
    if (builtin) pattern = builtin
    else guessedWindow = true // a window without a known pattern: treated as full attention (the larger number)
  }
  for (let il = 0; il < L; il++) {
    let kind: LayerKind = 'full'
    if (a.fullAttentionInterval) kind = (il + 1) % a.fullAttentionInterval === 0 ? 'full' : 'recurrent'
    else if (kvList) kind = (kvList[il] ?? 0) > 0 ? 'full' : (hasSsm ? 'recurrent' : 'full')
    else if (hasSsm && (!a.headCount || !a.headCountKv)) kind = 'recurrent'
    if (kind === 'full' && a.slidingWindow) {
      if (Array.isArray(pattern)) { if (pattern[il]) kind = 'swa' }
      else if (pattern && pattern > 1 && il % pattern < pattern - 1) kind = 'swa'
    }
    kinds.push(kind)
  }
  return { kinds, guessedWindow }
}

function kvHeads(a: GgufArch, il: number): number | null {
  if (Array.isArray(a.headCountKv)) return a.headCountKv[il] ?? null
  return a.headCountKv
}

/** Bytes of recurrent state of one layer for one sequence (f32 conv state + f32 SSM state). */
export function recurrentStateBytes(a: GgufArch): number {
  const s = a.ssm
  if (!s || !s.stateSize || !s.innerSize) return 0
  const conv = Math.max(0, (s.convKernel ?? 1) - 1) * (s.innerSize + 2 * (s.groupCount ?? 0) * s.stateSize)
  return (conv + s.stateSize * s.innerSize) * 4
}

/** Cache cells: the full-attention layers' and the sliding-window layers' (all slots together). */
export function kvCells(ctx: number, window: number | null, slots: number, unified: boolean, ubatch: number, swaFull: boolean): { full: number, swa: number } {
  if (unified) {
    const full = pad256(ctx)
    return { full, swa: swaFull || !window ? full : Math.min(full, pad256(window * slots + ubatch)) }
  }
  const stream = pad256(Math.floor(ctx / slots))
  return { full: stream * slots, swa: (swaFull || !window ? stream : Math.min(stream, pad256(window + ubatch))) * slots }
}

interface LayerWeights {
  perLayer: number[]
  embed: number
  output: number
  tiedOutput: boolean
  other: number
  total: number
}

function weightsOf(f: ModelFacts, layers: number): { w: LayerWeights, guessed: boolean } {
  const lay = f.layout
  // A layout that covers only some shards says nothing about the layers in the others: not used (a guess, flagged).
  if (lay && lay.tensorBytes > 0 && !f.sharded) {
    const perLayer = Array.from({ length: layers }, (_, i) => lay.layerBytes[i] ?? 0)
    return { w: { perLayer, embed: lay.embedBytes, output: lay.outputBytes, tiedOutput: lay.tiedOutput, other: lay.otherBytes, total: lay.tensorBytes }, guessed: false }
  }
  // No tensor infos: 3% of the file for embedding + output, the rest evenly over the layers.
  const body = f.totalBytes * 0.94
  return {
    w: { perLayer: Array.from({ length: layers }, () => body / Math.max(1, layers)), embed: f.totalBytes * 0.03, output: f.totalBytes * 0.03, tiedOutput: false, other: 0, total: f.totalBytes },
    guessed: true,
  }
}

const zero = (): Breakdown => ({ weightsMiB: 0, kvMiB: 0, stateMiB: 0, computeMiB: 0, mmprojMiB: 0, draftMiB: 0, fixedMiB: 0, totalMiB: 0 })

/**
 * llama.cpp's layer split (`llama_model::load_tensors`): with `ngl` layers offloaded, the last `act = min(ngl, n + 1)`
 * of the n repeating layers plus the output layer (counted as layer n) are spread over the devices; the device of
 * offloaded layer `il` is the first one whose cumulative, normalised share is above `(il - start) / act`.
 */
function splitDevice(il: number, start: number, act: number, shares: number[]): number {
  // llama.cpp does this in float32: raw shares are accumulated, divided by the total, and compared with a float position;
  // the strict `>` (upper_bound) makes the exact boundaries depend on those roundings, so they are repeated here.
  const f = Math.fround
  const cum: number[] = []
  let acc = 0
  for (const sh of shares) { acc = f(acc + f(sh)); cum.push(acc) }
  const total = cum[cum.length - 1] || 1
  const x = f(f(il - start) / f(act))
  for (let d = 0; d < cum.length; d++) if (f(cum[d]! / total) > x) return d
  return shares.length - 1
}

function offloadWindow(layers: number, gpuLayers: number | null | undefined): { start: number, act: number } {
  const ngl = gpuLayers === null || gpuLayers === undefined || gpuLayers < 0 ? layers + 1 : gpuLayers
  return { start: Math.max(layers + 1 - ngl, 0), act: Math.min(ngl, layers + 1) }
}

/** The owner per repeating layer (-1 = host): the first layers stay on the host, the rest follow the split. */
export function assignLayers(layers: number, gpuLayers: number | null | undefined, shares: number[]): number[] {
  const out = new Array<number>(layers).fill(-1)
  if (!shares.length) return out
  const { start, act } = offloadWindow(layers, gpuLayers)
  if (act <= 0) return out
  for (let il = start; il < layers; il++) out[il] = splitDevice(il, start, act, shares)
  return out
}

/** The device that holds the output layer (-1 = host): it takes part in the same split as layer n. */
export function assignOutput(layers: number, gpuLayers: number | null | undefined, shares: number[]): number {
  if (!shares.length) return -1
  const { start, act } = offloadWindow(layers, gpuLayers)
  return act <= 0 ? -1 : splitDevice(layers, start, act, shares)
}

interface ModelParts {
  dev: Breakdown[]
  host: Breakdown
  cells: { full: number, swa: number }
  slots: number
  unified: boolean
  ctx: number
  notes: Set<EstimateNote>
  outputOnDevice: boolean
}

/** Memory of one model over the devices; also used for the draft model (its KV counts as `draftMiB`). */
function modelParts(f: ModelFacts, p: EstimateParams, devices: DeviceInput[], shares: number[], asDraft: boolean): ModelParts {
  const a = f.meta.arch
  const notes = new Set<EstimateNote>()
  const dev = devices.map(zero)
  const host = zero()
  const into = (b: Breakdown, key: 'weightsMiB' | 'kvMiB' | 'stateMiB' | 'computeMiB', value: number) => { b[key] += value }

  const kinds = layerKinds(a, f.meta.architecture)
  const L = a.blockCount ?? f.layout?.layerBytes.length ?? 0
  const { w, guessed } = weightsOf(f, L)
  if (guessed) notes.add('layout-unknown')

  const ctx = p.ctxSize && p.ctxSize > 0 ? p.ctxSize : (notes.add('ctx-from-model'), f.meta.contextLength ?? 4096)
  const batch = p.batchSize && p.batchSize > 0 ? p.batchSize : 2048
  const ubatch = Math.min(batch, p.ubatchSize && p.ubatchSize > 0 ? p.ubatchSize : 512)
  const auto = !p.parallel || p.parallel <= 0
  const slots = auto ? 4 : p.parallel!
  const unified = auto
  const keyBytes = CACHE_BYTES[p.cacheTypeK ?? 'f16'] ?? 2
  const valBytes = CACHE_BYTES[p.cacheTypeV ?? 'f16'] ?? 2
  const owner = assignLayers(L, p.gpuLayers, shares)
  const outDev = assignOutput(L, p.gpuLayers, shares)
  // One memory for everything: a Mac / integrated device, or no device at all (CPU only).
  const sharedPool = devices.every(d => d.memory === 'shared')

  // Weights.
  const bucket = (d: number) => (d < 0 ? host : dev[d]!)
  for (let il = 0; il < L; il++) into(bucket(owner[il]!), 'weightsMiB', mib(w.perLayer[il]!))
  if (sharedPool) {
    // One memory: each tensor counted once (the tied output projection aliases the embedding).
    into(host, 'weightsMiB', mib(w.embed + w.output + w.other))
  } else {
    into(host, 'weightsMiB', mib(w.embed + w.other)) // the input embedding is always read on the CPU
    const outBytes = w.output + (w.tiedOutput ? w.embed : 0)
    into(bucket(outDev), 'weightsMiB', mib(outBytes))
  }

  // KV / recurrent state, per layer on the device that owns the layer.
  let cells = { full: 0, swa: 0 }
  const needsHeads = !kinds || kinds.kinds.some(k => k !== 'recurrent')
  if (!kinds || !a.embeddingLength || (needsHeads && !a.headCount)) {
    notes.add('arch-incomplete')
  } else {
    cells = kvCells(ctx, a.slidingWindow, slots, unified, ubatch, !!p.swaFull)
    const keyLen = a.keyLength ?? Math.floor(a.embeddingLength / (a.headCount || 1))
    const valLen = a.valueLength ?? keyLen
    if (kinds.guessedWindow) notes.add('window-pattern-guessed')
    if ((f.meta.architecture ?? '').startsWith('deepseek')) notes.add('unverified-mla')
    const state = recurrentStateBytes(a)
    for (let il = 0; il < L; il++) {
      const where = p.kvOnHost ? host : bucket(owner[il]!)
      const kind = kinds.kinds[il]!
      if (kind === 'recurrent') { into(where, 'stateMiB', mib(state * slots)); continue }
      const heads = kvHeads(a, il) ?? a.headCount ?? 0
      const perCell = heads * (keyLen * keyBytes + valLen * valBytes)
      into(where, 'kvMiB', mib(perCell * (kind === 'swa' ? cells.swa : cells.full)))
    }
  }

  // Compute buffers: one per backend that runs layers. Measured: ~20 bytes per micro-batch token per (ffn + embedding)
  // width plus 12 MiB, and (flash attention off) an attention-score buffer of micro-batch x cells x heads x 4 bytes.
  if (a.embeddingLength && a.feedForwardLength) {
    const fa = (p.flashAttn ?? 'auto') !== 'off'
    const width = a.feedForwardLength + a.embeddingLength
    const maxCells = Math.max(cells.full, cells.swa)
    const compute = mib(ubatch * width * 20) + 12 + (fa ? 0 : mib(ubatch * maxCells * (a.headCount ?? 0) * 4))
    if (a.expertCount) notes.add('unverified-moe-compute')
    const usedDev = new Set(owner.filter(o => o >= 0))
    for (const d of usedDev) into(dev[d]!, 'computeMiB', compute)
    if (owner.some(o => o < 0) || usedDev.size === 0) into(host, 'computeMiB', compute)
    else into(host, 'computeMiB', ubatch * 0.032)
    if (usedDev.size > 1) notes.add('unverified-multi-device')
  } else notes.add('arch-incomplete')

  // Output buffer (logits of every slot, f32) always sits in RAM.
  if (a.vocabSize) into(host, 'computeMiB', mib(a.vocabSize * 4 * slots))

  if (asDraft) {
    for (const b of [...dev, host]) { b.draftMiB = b.weightsMiB + b.kvMiB + b.stateMiB + b.computeMiB; b.weightsMiB = b.kvMiB = b.stateMiB = b.computeMiB = 0 }
    notes.add('unverified-draft-compute')
  }
  return { dev, host, cells, slots, unified, ctx, notes, outputOnDevice: outDev >= 0 }
}

const sumBreakdown = (...bs: Breakdown[]): Breakdown => {
  const t = zero()
  for (const b of bs) for (const k of Object.keys(t) as Array<keyof Breakdown>) t[k] += b[k]
  return t
}
const finish = (b: Breakdown): Breakdown => ({ ...b, totalMiB: b.weightsMiB + b.kvMiB + b.stateMiB + b.computeMiB + b.mmprojMiB + b.draftMiB + b.fixedMiB })

export function tierOf(totalMiB: number, budgetMiB: number | null): { ratio: number | null, tier: Tier } {
  if (budgetMiB === null || !Number.isFinite(budgetMiB)) return { ratio: null, tier: 'unknown' }
  if (budgetMiB <= 0) return { ratio: Infinity, tier: 'nofit' }
  const ratio = totalMiB / budgetMiB
  return { ratio, tier: ratio <= RISKY_FROM ? 'ok' : ratio <= 1 ? 'risky' : 'nofit' }
}

// `unknown` outranks `risky`: a pool that cannot be read must not be hidden by another pool's known risk.
const WORSE: Tier[] = ['ok', 'risky', 'unknown', 'nofit']
export const worstTier = (tiers: Tier[]): Tier => tiers.reduce<Tier>((w, t) => (WORSE.indexOf(t) > WORSE.indexOf(w) ? t : w), 'ok')

/** Estimate the memory one launch takes, per pool, with the three tiers (`ok` / `risky` / `nofit`; `unknown` without a budget). */
export function estimateMemory(input: EstimateInput): MemoryEstimate {
  const params = input.params ?? {}
  const devices = input.devices ?? []
  const system = input.system ?? { totalMiB: null, availableMiB: null }
  const rawShares = devices.map(d => d.share ?? 1 / devices.length)
  const main = modelParts(input.model, params, devices, rawShares, false)
  const notes = new Set<EstimateNote>(main.notes)

  const parts = [main]
  if (input.draft) {
    const d = modelParts(input.draft.facts, { ...input.draft.params, parallel: 1 }, devices, rawShares, true)
    d.notes.forEach(n => notes.add(n))
    parts.push(d)
  }

  // mmproj: weights plus an image compute buffer (one measured sample: 0.4 x the file size, at least 128 MiB), on the
  // first device (the device the model's compute runs on) or on the host.
  const mm = input.mmprojBytes ?? 0
  const mmTotal = mm > 0 ? mib(mm) + Math.max(128, 0.4 * mib(mm)) : 0
  if (mm > 0) notes.add('mmproj-compute-single-sample')

  const devPools: Breakdown[] = devices.map((_, i) => sumBreakdown(...parts.map(p => p.dev[i]!)))
  const hostPool = sumBreakdown(...parts.map(p => p.host))
  if (mmTotal > 0) (devices.length && !params.mmprojOnHost ? devPools[0]! : hostPool).mmprojMiB += mmTotal
  devices.forEach((d, i) => {
    const used = devPools[i]!.weightsMiB + devPools[i]!.kvMiB + devPools[i]!.stateMiB + devPools[i]!.draftMiB + devPools[i]!.mmprojMiB > 0
    if (used) devPools[i]!.fixedMiB = d.fixedMiB ?? FIXED_OVERHEAD_MIB[d.memory]
  })
  if (devices.some(d => d.memory === 'separate')) notes.add('unverified-separate-memory')

  const reserve = system.totalMiB !== null ? systemReserveMiB(system.totalMiB) : 0
  const hostBudget = system.availableMiB === null ? null : Math.max(0, system.availableMiB - reserve)

  const pools: Pool[] = []
  const shared = devices.length > 0 && devices.every(d => d.memory === 'shared')
  let unknownBudget = false
  const mk = (id: string, name: string, kind: Pool['kind'], b: Breakdown, budget: number | null): Pool => {
    const fin = finish(b)
    const t = tierOf(fin.totalMiB, budget)
    // A part of the budget that could not be read can only make it smaller: "does not fit" stands, anything else is unknown.
    return { id, name, kind, ...fin, budgetMiB: budget, ...(unknownBudget && t.tier !== 'nofit' ? { ratio: t.ratio, tier: 'unknown' as Tier } : t) }
  }
  if (shared) {
    // Device and host draw from one memory: one pool, limited by the device cap and by what the system can still give.
    const merged = sumBreakdown(hostPool, ...devPools)
    const caps = devices.map(d => (d.freeMiB !== null ? d.freeMiB : d.capMiB ?? null))
    const known = [...caps, hostBudget].filter((n): n is number => n !== null)
    unknownBudget = known.length < caps.length + 1
    const budget = known.length ? Math.min(...known) : null
    pools.push(mk(devices.map(d => d.id).join(','), devices.map(d => d.name).join(', '), 'shared', merged, budget))
  } else {
    devices.forEach((d, i) => { if (devPools[i]!.weightsMiB + devPools[i]!.kvMiB + devPools[i]!.stateMiB + devPools[i]!.draftMiB + devPools[i]!.mmprojMiB > 0) pools.push(mk(d.id, d.name, 'separate', devPools[i]!, d.freeMiB)) })
    pools.push(mk('host', '', 'host', hostPool, hostBudget))
  }
  if (unknownBudget || pools.some(p => p.budgetMiB === null)) notes.add('budget-unknown')

  const lockedInRam = !!params.mlock
  const mlockMiB = lockedInRam ? (shared ? pools[0]!.weightsMiB : hostPool.weightsMiB) : 0
  return {
    pools,
    tier: worstTier(pools.map(p => p.tier)),
    mlockMiB,
    total: finish(sumBreakdown(hostPool, ...devPools)),
    kv: { fullCells: main.cells.full, swaCells: main.cells.swa, slots: main.slots, unified: main.unified, ctx: main.ctx },
    notes: [...notes],
  }
}
