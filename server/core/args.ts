// llama-server argument building: layered parameter merge, shell-style splitting of
// extra args, duplicate detection and command preview.
//
// Merge order (later wins): global defaults <- model overrides <- profile overrides <- extra args.
// Extra args are concatenated in the same order (global, model, profile) and appended after
// the form-managed flags, so the last occurrence of a flag is the effective one.
import type { GpuGroup } from './gpu-group'

export type ParamValue = string | number | null

/** Form-managed launch parameters. */
export interface LaunchParams {
  ctxSize: ParamValue
  cacheTypeK: ParamValue
  cacheTypeV: ParamValue
  flashAttn: ParamValue
  gpuLayers: ParamValue
  batchSize: ParamValue
  ubatchSize: ParamValue
  parallel: ParamValue
  reasoning: ParamValue
  reasoningFormat: ParamValue
  reasoningBudget: ParamValue
  /** CPU tuning (decision 39): thread count, NUMA strategy, affinity mask. Null = do not pass. */
  threads: ParamValue
  numa: ParamValue
  cpuMask: ParamValue
}

export type ParamKey = keyof LaunchParams

/** Global defaults: every form field plus the raw extra-args text. */
export interface LaunchDefaults extends LaunchParams {
  extraArgs: string
  /** Global device choice (see `normalizeDevice`); missing / empty = automatic. */
  device?: string
  /** Global GPU group and its split settings (decision 45); see gpu-group.ts. Missing / empty = no group. */
  devices?: string[]
  splitMode?: string
  tensorSplit?: string
  mainGpu?: string
}

/**
 * Per-layer overrides. A missing key (or `undefined`) means "inherit";
 * `null` or `''` means "custom: do not pass this flag".
 */
export type ParamOverrides = Partial<LaunchParams>

export const PARAM_DEFS: ReadonlyArray<{ key: ParamKey, flag: string, aliases: string[] }> = [
  { key: 'ctxSize', flag: '--ctx-size', aliases: ['-c'] },
  { key: 'cacheTypeK', flag: '--cache-type-k', aliases: ['-ctk'] },
  { key: 'cacheTypeV', flag: '--cache-type-v', aliases: ['-ctv'] },
  { key: 'flashAttn', flag: '--flash-attn', aliases: ['-fa'] },
  { key: 'gpuLayers', flag: '--n-gpu-layers', aliases: ['-ngl', '--gpu-layers'] },
  { key: 'batchSize', flag: '--batch-size', aliases: ['-b'] },
  { key: 'ubatchSize', flag: '--ubatch-size', aliases: ['-ub'] },
  { key: 'parallel', flag: '--parallel', aliases: ['-np'] },
  { key: 'reasoning', flag: '--reasoning', aliases: [] },
  { key: 'reasoningFormat', flag: '--reasoning-format', aliases: [] },
  { key: 'reasoningBudget', flag: '--reasoning-budget', aliases: [] },
  { key: 'threads', flag: '--threads', aliases: ['-t'] },
  { key: 'numa', flag: '--numa', aliases: [] },
  { key: 'cpuMask', flag: '--cpu-mask', aliases: ['-C'] },
]

export const NUMA_MODES = ['distribute', 'isolate', 'numactl']

/**
 * Value check for the CPU tuning parameters (the other parameters are validated by llama-server at
 * load time). A wrong value here would only surface as a failed load, so it is refused at save.
 */
export function paramValueOk(key: ParamKey, v: ParamValue): boolean {
  if (v === null) return true
  if (key === 'threads') return typeof v === 'number' ? Number.isInteger(v) && v >= -1 && v <= 4096 : /^-?\d{1,4}$/.test(v) && Number(v) >= -1
  if (key === 'numa') return typeof v === 'string' && NUMA_MODES.includes(v)
  if (key === 'cpuMask') return typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,1024}$/.test(v)
  return true
}

export const DEFAULT_LAUNCH_DEFAULTS: LaunchDefaults = {
  ctxSize: 262144,
  cacheTypeK: 'q4_0',
  cacheTypeV: 'q4_0',
  flashAttn: 'on',
  gpuLayers: 999,
  batchSize: 2048,
  ubatchSize: 1024,
  parallel: 1,
  reasoning: 'on',
  reasoningFormat: 'auto',
  reasoningBudget: -1,
  threads: null,
  numa: null,
  cpuMask: null,
  extraArgs: '--no-prefill-assistant --load-mode mlock',
}

// Flags llama-web manages itself from file references.
const FILE_FLAGS = {
  model: { flag: '--model', aliases: ['-m'] },
  mmproj: { flag: '--mmproj', aliases: ['-mm'] },
  draft: { flag: '--model-draft', aliases: ['-md'] },
  chatTemplate: { flag: '--chat-template-file', aliases: [] },
} as const

const RESERVED = ['--host', '--port']

// Flags that may legitimately appear more than once.
const REPEATABLE = new Set([
  '--lora', '--lora-scaled', '--override-kv', '--override-tensor',
  '--control-vector', '--control-vector-scaled',
])

// Extra alias groups used only to recognise duplicates (canonical = first entry).
const OTHER_ALIASES: string[][] = [
  ['--threads-batch', '-tb'], ['--tensor-split', '-ts'], ['--device', '-dev'],
  ['--split-mode', '-sm'], ['--main-gpu', '-mg'], ['--override-tensor', '-ot'],
  ['--cont-batching', '-cb'], ['--no-cont-batching', '-nocb'],
]

const CANON = new Map<string, string>()
function registerAliases(canonical: string, aliases: readonly string[]) {
  CANON.set(canonical, canonical)
  for (const a of aliases) CANON.set(a, canonical)
}
for (const d of PARAM_DEFS) registerAliases(d.flag, d.aliases)
for (const f of Object.values(FILE_FLAGS)) registerAliases(f.flag, f.aliases)
for (const [c, ...rest] of OTHER_ALIASES) registerAliases(c!, rest)

export function canonicalFlag(flag: string): string {
  return CANON.get(flag) ?? flag
}

export class ArgsSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgsSyntaxError'
  }
}

/**
 * Split an argument string the way a shell would: whitespace separates, single quotes are
 * literal, double quotes group and allow `\"`. Other backslashes are kept literally so
 * Windows paths survive. Throws ArgsSyntaxError on an unterminated quote.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && input[i + 1] === '"') { cur += '"'; i++ }
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && input[i + 1] === '"') {
      cur += '"'; has = true; i++
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''; has = false
    } else {
      cur += c; has = true
    }
  }
  if (quote) throw new ArgsSyntaxError(`Unterminated ${quote} quote`)
  if (has || cur) out.push(cur)
  return out
}

/** A flag with its value tokens, or leading positional tokens (flag = null). */
export interface ArgGroup {
  flag: string | null
  canon: string | null
  tokens: string[]
}

const NUMERIC = /^-\d+(\.\d+)?$/

function isFlagToken(t: string) {
  return t.length > 1 && t.startsWith('-') && !NUMERIC.test(t)
}

export function groupArgs(tokens: string[]): ArgGroup[] {
  const groups: ArgGroup[] = []
  for (const t of tokens) {
    if (isFlagToken(t)) {
      const flag = t.startsWith('--') && t.includes('=') ? t.slice(0, t.indexOf('=')) : t
      groups.push({ flag, canon: canonicalFlag(flag), tokens: [t] })
    } else if (groups.length > 0) {
      groups[groups.length - 1]!.tokens.push(t)
    } else {
      groups.push({ flag: null, canon: null, tokens: [t] })
    }
  }
  return groups
}

export type ArgWarningCode =
  | 'extra-syntax-error' // extra args text has an unterminated quote (severity: error)
  | 'invalid-port' // port is not 1..65535 (severity: error)
  | 'extra-overrides-form' // an extra arg replaces a form-managed flag
  | 'extra-overrides-device' // an extra arg replaces a flag of the chosen device (--device / --split-mode)
  | 'extra-multi-device' // extra args spread the model over several devices (--tensor-split / --device a,b)
  | 'split-mode-unsupported' // the build does not list the chosen split mode (severity: error; only when the build's help said so)
  | 'split-mode-unconfirmed' // row / tensor on a build + devices + mode never confirmed (decision 45)
  | 'split-mode-failed-before' // the same combination failed to load before (detail: what the failure was)
  | 'duplicate-in-layer' // same flag twice inside one extra-args text; the last one wins
  | 'reserved-flag-removed' // --host / --port in extra args were dropped
  | 'preview-program-percent' // preview only: program path cmd.exe may expand (%NAME% with spaces)

export interface ArgWarning {
  code: ArgWarningCode
  severity: 'warning' | 'error'
  flag?: string
  /** Which extra-args text the problem is in. */
  layer?: 'global' | 'model' | 'profile'
  detail?: string
}

/** Device ids come from `llama-server --list-devices` (`CUDA0`, `Vulkan1`): a letter, then letters, digits and `_ . -`. */
const DEVICE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/

/**
 * A device choice as stored: '' = inherit from the next layer, 'auto' = leave it to llama.cpp,
 * 'cpu', or exactly one device id. Returns null for anything else (several devices, `none`,
 * flags, spaces): llama-web only runs a model on one device (decision 39).
 */
export function normalizeDevice(raw: unknown): string | null {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (v === '') return ''
  const lower = v.toLowerCase()
  if (lower === 'auto' || lower === 'cpu') return lower
  return lower !== 'none' && DEVICE_ID.test(v) ? v : null
}

/** First choice that is not empty, layers ordered profile, model, global; `auto` when none is set. */
export function resolveDevice(...layers: Array<string | null | undefined>): string {
  for (const l of layers) {
    const v = normalizeDevice(l)
    if (v) return v
  }
  return 'auto'
}

/**
 * The launch arguments one device choice adds (empty for `auto`). A GPU group (decision 45) is two or more
 * devices: `--device a,b --split-mode <mode>`, plus `--tensor-split` / `--main-gpu` only when set.
 */
export function deviceArgs(device: string, group: GpuGroup | null = null): Array<[flag: string, value: string]> {
  if (group) {
    const out: Array<[string, string]> = [['--device', group.devices.join(',')], ['--split-mode', group.splitMode]]
    if (group.tensorSplit) out.push(['--tensor-split', group.tensorSplit])
    if (group.mainGpu) out.push(['--main-gpu', group.mainGpu])
    return out
  }
  if (device === 'cpu') return [['--device', 'none']]
  if (device === 'auto' || !normalizeDevice(device)) return []
  return [['--device', device], ['--split-mode', 'none']]
}

export interface BuildInput {
  /** Absolute paths of resolved files. */
  paths: { model: string, mmproj?: string | null, draft?: string | null, chatTemplate?: string | null }
  defaults: LaunchDefaults
  /** Model-level overrides and extra args (optional layer between defaults and profile). */
  model?: { overrides?: ParamOverrides, extraArgs?: string }
  profile?: { overrides?: ParamOverrides, extraArgs?: string }
  host: string
  port: number
  /** Resolved device choice (`auto`, `cpu` or one id). Left out on a host without device selection (Mac). */
  device?: string
  /** A GPU group: then `device` is its ids joined by `,` and the group's flags are passed. */
  group?: GpuGroup | null
}

export interface BuildResult {
  /** False when there is an error-severity warning; do not launch. */
  ok: boolean
  /** Arguments for spawn(), excluding the executable. */
  args: string[]
  warnings: ArgWarning[]
  /** Merged form values (before extra-args replacement). */
  effective: LaunchParams
  /**
   * The device the final command asks for in launch-plan terms (`auto`, `cpu` or one id): the form's choice,
   * unless the extra args carry their own `--device` / `-dev` (then that value; several devices count as `auto`).
   */
  device: string
}

/** Value of a flag group: `--flag=value` or the token after the flag. */
function groupValue(g: ArgGroup): string {
  const first = g.tokens[0] ?? ''
  return (first.includes('=') && first.startsWith('--') ? first.slice(first.indexOf('=') + 1) : (g.tokens[1] ?? '')).trim()
}

/** Device choice of the last `--device` / `-dev` in the extra args (`--device X`, `-dev X`, `--device=X`), or null when absent. */
export function extraDevice(extra: ArgGroup[]): string | null {
  const g = [...extra].reverse().find(x => x.canon === '--device')
  if (!g) return null
  const raw = groupValue(g)
  const v = raw.trim().toLowerCase() === 'none' ? 'cpu' : normalizeDevice(raw)
  return v || 'auto'
}

/** Merge form values: defaults <- each override layer (undefined inherits, null/'' clears). */
export function mergeParams(defaults: LaunchParams, ...layers: Array<ParamOverrides | undefined>): LaunchParams {
  const out = {} as LaunchParams
  for (const d of PARAM_DEFS) out[d.key] = defaults[d.key] ?? null
  for (const layer of layers) {
    if (!layer) continue
    for (const d of PARAM_DEFS) {
      const v = layer[d.key]
      if (v !== undefined) out[d.key] = v === '' ? null : v
    }
  }
  return out
}

export function buildLaunchArgs(input: BuildInput): BuildResult {
  const warnings: ArgWarning[] = []
  const effective = mergeParams(input.defaults, input.model?.overrides, input.profile?.overrides)
  const device = input.device ?? 'auto'
  // A CPU run keeps every layer on the CPU whatever the form says.
  if (device === 'cpu') effective.gpuLayers = 0

  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    warnings.push({ code: 'invalid-port', severity: 'error', detail: String(input.port) })
  }

  // Extra args: layers concatenated in order; a later occurrence replaces an earlier one.
  const layers: Array<['global' | 'model' | 'profile', string | undefined]> = [
    ['global', input.defaults.extraArgs],
    ['model', input.model?.extraArgs],
    ['profile', input.profile?.extraArgs],
  ]
  let extra: ArgGroup[] = []
  for (const [layer, text] of layers) {
    if (!text?.trim()) continue
    let groups: ArgGroup[]
    try {
      groups = groupArgs(splitArgs(text))
    } catch (e) {
      warnings.push({ code: 'extra-syntax-error', severity: 'error', layer, detail: (e as Error).message })
      continue
    }
    const seen = new Set<string>()
    const reported = new Set<string>()
    for (const g of groups) {
      if (!g.canon) { extra.push(g); continue }
      if (RESERVED.includes(g.canon)) {
        warnings.push({ code: 'reserved-flag-removed', severity: 'warning', flag: g.canon, layer })
        continue
      }
      if (!REPEATABLE.has(g.canon)) {
        if (seen.has(g.canon) && !reported.has(g.canon)) {
          warnings.push({ code: 'duplicate-in-layer', severity: 'warning', flag: g.canon, layer })
          reported.add(g.canon)
        }
        seen.add(g.canon)
        extra = extra.filter(x => x.canon !== g.canon)
      }
      extra.push(g)
    }
  }
  const extraCanon = new Set(extra.map(g => g.canon).filter((c): c is string => c !== null))

  const args: string[] = []
  const paths: Array<[keyof typeof FILE_FLAGS, string | null | undefined]> = [
    ['model', input.paths.model],
    ['mmproj', input.paths.mmproj],
    ['draft', input.paths.draft],
    ['chatTemplate', input.paths.chatTemplate],
  ]
  for (const [key, path] of paths) {
    if (!path) continue
    const flag = FILE_FLAGS[key].flag
    if (extraCanon.has(flag)) {
      warnings.push({ code: 'extra-overrides-form', severity: 'warning', flag })
      continue
    }
    args.push(flag, path)
  }
  for (const d of PARAM_DEFS) {
    const v = effective[d.key]
    if (v === null) continue
    if (extraCanon.has(d.flag)) {
      warnings.push({ code: 'extra-overrides-form', severity: 'warning', flag: d.flag })
      continue
    }
    args.push(d.flag, String(v))
  }
  for (const [flag, value] of deviceArgs(device, input.group ?? null)) {
    if (extraCanon.has(flag)) {
      warnings.push({ code: 'extra-overrides-device', severity: 'warning', flag })
      continue
    }
    args.push(flag, value)
  }
  for (const g of extra) {
    const splitsModel = g.canon === '--split-mode' && groupValue(g).toLowerCase() !== 'none'
    if (g.canon === '--tensor-split' || g.canon === '--main-gpu' || splitsModel || (g.canon === '--device' && g.tokens.some(t => t.includes(',')))) {
      warnings.push({ code: 'extra-multi-device', severity: 'warning', flag: g.canon ?? undefined })
    }
    args.push(...g.tokens)
  }
  args.push('--host', input.host, '--port', String(input.port))

  return { ok: !warnings.some(w => w.severity === 'error'), args, warnings, effective, device: extraDevice(extra) ?? device }
}

/** Quote one argument for display (Windows / POSIX-ish double quotes). */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"']/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/** Full command line in the project's own syntax; parses back to the same args with splitArgs. */
export function formatCommand(exe: string, args: string[]): string {
  return [exe, ...args].map(quoteArg).join(' ')
}
/** POSIX shells: prevent substitutions, globbing and operators even in simple-looking args. */
export function formatPosixCommand(exe: string, args: string[]): string {
  return [exe, ...args].map(a => `'${a.replace(/'/g, `'"'"'`)}'`).join(' ')
}

/**
 * Quote one argument for pasting into cmd.exe (Windows 命令提示符). First the quoting the
 * program's C runtime undoes (CommandLineToArgvW rules: quotes around whitespace / quotes / empty,
 * backslashes doubled only before a quote), then, if the argument holds a cmd metacharacter or a
 * quote, every metacharacter (quotes included) is escaped with ^ so cmd passes it through as is.
 * Parentheses alone pass through a plain command line, but are escaped too so the line also
 * survives inside a ( … ) block.
 */
export function quoteCmdArg(arg: string): string {
  let q = arg
  if (arg === '' || /[\s"]/.test(arg)) {
    q = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  }
  if (/[()&|<>^%!"]/.test(arg)) q = q.replace(/[()%!^"<>&|]/g, '^$&')
  return q
}

/**
 * The program path for cmd.exe. cmd finds the program name by its own rules: ^-escaped quotes do
 * not group it and ; , = split it. Without whitespace every special character (% included) gets
 * a ^; with whitespace the path goes in plain quotes (a Windows path cannot contain a quote),
 * where % cannot be escaped: see cmdProgramMayExpand.
 */
export function quoteCmdProgram(exe: string): string {
  if (exe === '') return '""'
  if (!/\s/.test(exe)) return exe.replace(/[()%!^&|<>;,=]/g, '^$&')
  return `"${exe}"`
}

/** True when cmd.exe could expand part of the quoted program path as a %variable%. */
export function cmdProgramMayExpand(exe: string): boolean {
  return /\s/.test(exe) && /%[^%]+%/.test(exe)
}

/** Command line for the UI preview, ready to paste into cmd.exe. */
export function formatCmdCommand(exe: string, args: string[]): string {
  return [quoteCmdProgram(exe), ...args.map(quoteCmdArg)].join(' ')
}
