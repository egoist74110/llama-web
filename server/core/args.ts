// llama-server argument building: layered parameter merge, shell-style splitting of
// extra args, duplicate detection and command preview.
//
// Merge order (later wins): global defaults <- model overrides <- profile overrides <- extra args.
// Extra args are concatenated in the same order (global, model, profile) and appended after
// the form-managed flags, so the last occurrence of a flag is the effective one.

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
}

export type ParamKey = keyof LaunchParams

/** Global defaults: every form field plus the raw extra-args text. */
export interface LaunchDefaults extends LaunchParams {
  extraArgs: string
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
]

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
  extraArgs: '--jinja --no-prefill-assistant --props --slots --load-mode mlock -cb',
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
  ['--threads', '-t'], ['--threads-batch', '-tb'], ['--tensor-split', '-ts'],
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
  | 'duplicate-in-layer' // same flag twice inside one extra-args text; the last one wins
  | 'reserved-flag-removed' // --host / --port in extra args were dropped

export interface ArgWarning {
  code: ArgWarningCode
  severity: 'warning' | 'error'
  flag?: string
  /** Which extra-args text the problem is in. */
  layer?: 'global' | 'model' | 'profile'
  detail?: string
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
}

export interface BuildResult {
  /** False when there is an error-severity warning; do not launch. */
  ok: boolean
  /** Arguments for spawn(), excluding the executable. */
  args: string[]
  warnings: ArgWarning[]
  /** Merged form values (before extra-args replacement). */
  effective: LaunchParams
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
  for (const g of extra) args.push(...g.tokens)
  args.push('--host', input.host, '--port', String(input.port))

  return { ok: !warnings.some(w => w.severity === 'error'), args, warnings, effective }
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

/**
 * Quote one argument for pasting into cmd.exe (Windows 命令提示符). First the quoting the
 * program's C runtime undoes (CommandLineToArgvW rules: quotes around whitespace / quotes / empty,
 * backslashes doubled only before a quote), then, if the argument holds a cmd metacharacter or a
 * quote, every metacharacter (quotes included) is escaped with ^ so cmd passes it through as is.
 */
export function quoteCmdArg(arg: string): string {
  let q = arg
  if (arg === '' || /[\s"]/.test(arg)) {
    q = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  }
  if (/[&|<>^%!"]/.test(arg)) q = q.replace(/[()%!^"<>&|]/g, '^$&')
  return q
}

/** Command line for the UI preview, ready to paste into cmd.exe. */
export function formatCmdCommand(exe: string, args: string[]): string {
  return [exe, ...args].map(quoteCmdArg).join(' ')
}
