// Check of one launch configuration before it is saved (decisions 43, 44): the memory estimate in three tiers plus
// the parameter sanity rules. Pure module: the final launch arguments, the device list, the GGUF facts and the
// system memory all come in as values, nothing is read from the machine here, and nothing is written.
//
// Only what was seen to make llama-server exit is an `error` (the save is refused for it):
//   - `v-cache-needs-fa`: a quantised V cache with flash attention off ("quantized V cache requires flash_attn to be
//     enabled", exit 1; run on b11146 with a real model, docs/research/memory-estimate.md).
//   - `device-missing`: `--device` names something the build's own list does not have ("invalid device", exit 1,
//     seen on a real RTX 5090; see devices.ts), only judged on the build's own answer.
//   - `split-mode-unsupported`: the build's help does not list the chosen split mode (from the launch warnings).
// Everything else (context above the training length, a micro-batch above the batch, ...) was run and starts, so it
// is a `warning` only. A memory tier never refuses a save: the free memory changes, the decision is the user's.
import { canonicalFlag, groupArgs, groupValue, type ArgGroup, type ArgWarning, type ParamValue } from './args'
import { deviceMissing, type DeviceList, type GpuDevice } from './devices'
import {
  estimateMemory, type DeviceInput, type DraftInput, type EstimateParams, type MemoryEstimate, type ModelFacts, type SystemMemory, type Tier,
} from './memory-estimate'

export type CheckCode =
  | 'v-cache-needs-fa' | 'device-missing' | 'split-mode-unsupported'
  | 'ctx-over-train' | 'ubatch-over-batch' | 'cpu-gpu-layers' | 'mmproj-on-cpu' | 'mlock-exceeds-memory' | 'slot-ctx-small'
  | 'file-missing' | 'no-estimate'

export interface CheckIssue {
  code: CheckCode
  severity: 'warning' | 'error'
  /** Numbers and names the interface puts into the message. */
  detail?: Record<string, string | number>
}

/** What the final argument array asks for (the last occurrence of a flag wins, extra arguments included). */
export interface FinalParams {
  ctx: number | null
  cacheTypeK: string | null
  cacheTypeV: string | null
  flashAttn: string | null
  gpuLayers: number | null
  batch: number | null
  ubatch: number | null
  parallel: number | null
  mlock: boolean
  swaFull: boolean
  kvOnHost: boolean
  /** Any RoPE / YaRN scaling option is set. */
  ropeScaling: boolean
  tensorSplit: string | null
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const FA_OFF = new Set(['off', '0', 'false', 'no', 'disabled'])
const isFaOff = (v: string | null) => v !== null && FA_OFF.has(v.toLowerCase())
const QUANTISED = (t: string | null) => !!t && !['f16', 'bf16', 'f32'].includes(t.toLowerCase())

/** Read the parameters out of the argument array llama-server would get. */
export function finalParams(args: string[]): FinalParams {
  const last = new Map<string, ArgGroup>()
  let kvOnHost = false
  let swaFull = false
  let ropeScaling = false
  for (const g of groupArgs(args)) {
    const flag = g.flag
    if (!flag) continue
    if (flag === '-nkvo' || flag === '--no-kv-offload') kvOnHost = true
    else if (flag === '-kvo' || flag === '--kv-offload') kvOnHost = false
    else if (flag === '--swa-full') swaFull = true
    else if (flag === '--rope-scale' || flag === '--rope-freq-scale' || flag === '--yarn-orig-ctx') ropeScaling = true
    else if (flag === '--rope-scaling') ropeScaling = groupValue(g).toLowerCase() !== 'none'
    last.set(g.canon ?? flag, g)
  }
  const val = (flag: string): string | undefined => {
    const g = last.get(flag)
    return g ? groupValue(g) : undefined
  }
  const text = (flag: string): string | null => { const v = val(flag); return v === undefined || v === '' ? null : v }
  // `-fa` without a value means on.
  const fa = last.has('--flash-attn') ? (text('--flash-attn') ?? 'on') : null
  const gl = num(val('--n-gpu-layers'))
  const mode = (text('--load-mode') ?? '').toLowerCase()
  return {
    ctx: num(val('--ctx-size')),
    cacheTypeK: text('--cache-type-k'),
    cacheTypeV: text('--cache-type-v'),
    flashAttn: fa,
    gpuLayers: gl === null || gl < 0 ? null : gl,
    batch: num(val('--batch-size')),
    ubatch: num(val('--ubatch-size')),
    parallel: num(val('--parallel')),
    mlock: last.has(canonicalFlag('--mlock')) || mode === 'mlock' || mode === 'mmap+mlock',
    swaFull, kvOnHost, ropeScaling,
    tensorSplit: text('--tensor-split'),
  }
}

export const toEstimateParams = (p: FinalParams): EstimateParams => ({
  ctxSize: p.ctx, cacheTypeK: p.cacheTypeK, cacheTypeV: p.cacheTypeV, flashAttn: p.flashAttn, gpuLayers: p.gpuLayers,
  batchSize: p.batch, ubatchSize: p.ubatch, parallel: p.parallel, swaFull: p.swaFull, kvOnHost: p.kvOnHost, mlock: p.mlock,
})

export interface CheckInput {
  /** The final argument array (without the program) of the launch preview. */
  args: string[]
  /** Device the launch asks for after `auto` was settled: `auto`, `cpu`, an id, or the ids of a group joined by `,`. */
  device: string
  /** `--n-gpu-layers` as the form asked for it, before a CPU device forced 0 (`LaunchPreview.requestedGpuLayers`). */
  requestedGpuLayers?: ParamValue
  /** Warnings of the launch preview (`extra-overrides-form`, `split-mode-unsupported`). */
  warnings?: ArgWarning[]
  os: NodeJS.Platform
  /** The build that runs is a CPU-only one. */
  cpuBuild?: boolean
  /** Null = the file could not be read: no estimate. */
  model: ModelFacts | null
  mmprojBytes?: number
  hasMmproj?: boolean
  draft?: DraftInput | null
  /** What the build reports about its devices; null / `unavailable` = not known. */
  list?: DeviceList | null
  /** Devices from another source (nvidia-smi) used when the build's own list is not available. */
  fallbackGpus?: GpuDevice[]
  system: SystemMemory
  /** Configured files that are not there (from the launch preview). */
  missing?: string[]
}

export interface ModelCheck {
  /** The estimate's worst pool; `unknown` when nothing could be estimated or a budget could not be read. */
  tier: Tier
  estimate: MemoryEstimate | null
  /** What the final arguments ask for, so the interface can show the numbers it judges. */
  params: FinalParams
  issues: CheckIssue[]
  /** True when an error-severity issue means the launch cannot start: the save is refused. */
  blocked: boolean
}

const biggest = (gpus: GpuDevice[]) => [...gpus].filter(g => g.totalMiB > 0).sort((a, b) => b.totalMiB - a.totalMiB)[0]

/** Share of the layers per device when several run one model: the split ratio asked for, else by free memory, else equal. */
function sharesOf(devices: DeviceInput[], tensorSplit: string | null): number[] {
  if (devices.length < 2) return [1]
  const parts = tensorSplit ? tensorSplit.split(/[,/]/).map(s => Number(s.trim())) : []
  if (parts.length === devices.length && parts.every(n => Number.isFinite(n) && n >= 0) && parts.some(n => n > 0)) return parts
  const free = devices.map(d => d.freeMiB)
  if (free.every((f): f is number => f !== null && f > 0)) return free
  return devices.map(() => 1)
}

/** The memory pools this launch draws on: nothing (CPU only), one shared memory (Mac), or the cards it uses. */
export function deviceInputs(i: Pick<CheckInput, 'os' | 'device' | 'cpuBuild' | 'list' | 'fallbackGpus'> & { tensorSplit?: string | null }): DeviceInput[] {
  const gpus = i.list?.source === 'list-devices' ? i.list.gpus : (i.fallbackGpus ?? [])
  if (i.os === 'darwin') {
    const g = biggest(gpus)
    return [{ id: g?.id ?? 'default', name: g?.name ?? '', memory: 'shared', freeMiB: g?.freeMiB ?? null, capMiB: g?.totalMiB ?? null }]
  }
  if (i.cpuBuild || i.device === 'cpu') return []
  let ids = i.device === 'auto' || i.device === '' ? [] : i.device.split(',').filter(Boolean)
  if (!ids.length) {
    const g = biggest(gpus)
    ids = g ? [g.id] : ['auto']
  }
  const out: DeviceInput[] = ids.map((id) => {
    const g = gpus.find(x => x.id === id)
    return { id, name: g?.name ?? id, memory: 'separate', freeMiB: g?.freeMiB ?? null }
  })
  const shares = sharesOf(out, i.tensorSplit ?? null)
  const sum = shares.reduce((a, b) => a + b, 0)
  return out.map((d, n) => ({ ...d, share: shares[n]! / sum }))
}

export function checkLaunch(input: CheckInput): ModelCheck {
  const params = finalParams(input.args)
  const issues: CheckIssue[] = []
  const warn = (code: CheckCode, detail?: CheckIssue['detail']) => issues.push({ code, severity: 'warning', ...(detail ? { detail } : {}) })
  const fail = (code: CheckCode, detail?: CheckIssue['detail']) => issues.push({ code, severity: 'error', ...(detail ? { detail } : {}) })

  for (const w of input.warnings ?? []) {
    if (w.severity !== 'error') continue
    if (w.code === 'split-mode-unsupported') fail('split-mode-unsupported', { mode: w.detail ?? '' })
  }
  for (const kind of input.missing ?? []) warn('file-missing', { kind })

  // A quantised V cache needs flash attention (verified: the process exits 1 without it).
  if (QUANTISED(params.cacheTypeV) && isFaOff(params.flashAttn)) fail('v-cache-needs-fa', { type: params.cacheTypeV! })

  // A chosen device the build does not list (only the build's own list counts).
  if (input.list && input.os !== 'darwin') {
    for (const id of input.device.split(',').filter(Boolean)) if (deviceMissing(id, input.list)) fail('device-missing', { device: id })
  }

  const cpuOnly = input.device === 'cpu' || !!input.cpuBuild
  const train = input.model?.meta.contextLength ?? null
  const ctx = params.ctx !== null && params.ctx > 0 ? params.ctx : train

  // Warnings: these start and run, but are very likely not what was meant.
  if (params.ctx !== null && params.ctx > 0 && train && params.ctx > train && !params.ropeScaling) warn('ctx-over-train', { ctx: params.ctx, train })
  if (params.batch !== null && params.ubatch !== null && params.ubatch > params.batch) warn('ubatch-over-batch', { ubatch: params.ubatch, batch: params.batch })
  if (cpuOnly) {
    // The form's layer count is forced to 0 for a CPU device; an `-ngl` of the extra arguments is judged as passed.
    const byExtra = (input.warnings ?? []).some(w => w.code === 'extra-overrides-form' && w.flag === '--n-gpu-layers')
    const requested = typeof input.requestedGpuLayers === 'number' ? input.requestedGpuLayers : num(String(input.requestedGpuLayers ?? ''))
    const asked = byExtra ? params.gpuLayers : (requested ?? params.gpuLayers)
    if (asked !== null && asked > 0) warn('cpu-gpu-layers', { layers: asked })
    if (input.hasMmproj) warn('mmproj-on-cpu')
  }
  if (params.parallel !== null && params.parallel > 1 && ctx && ctx / params.parallel < 1024) {
    warn('slot-ctx-small', { parallel: params.parallel, perSlot: Math.floor(ctx / params.parallel) })
  }

  let estimate: MemoryEstimate | null = null
  if (input.model) {
    estimate = estimateMemory({
      model: input.model, params: toEstimateParams(params), mmprojBytes: input.mmprojBytes,
      // The draft model runs with the main model's context and cache types unless the caller says otherwise.
      draft: input.draft ? { ...input.draft, params: input.draft.params ?? { ctxSize: params.ctx, cacheTypeK: params.cacheTypeK, cacheTypeV: params.cacheTypeV, gpuLayers: params.gpuLayers } } : null,
      devices: deviceInputs({ ...input, tensorSplit: params.tensorSplit }), system: input.system,
    })
    if (estimate.mlockMiB > 0 && input.system.availableMiB !== null && estimate.mlockMiB > input.system.availableMiB) {
      warn('mlock-exceeds-memory', { mlockMiB: Math.round(estimate.mlockMiB), availableMiB: Math.round(input.system.availableMiB) })
    }
  } else warn('no-estimate')

  return { tier: estimate?.tier ?? 'unknown', estimate, params, issues, blocked: issues.some(x => x.severity === 'error') }
}
