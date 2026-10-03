// Turn a scheduler target into a concrete llama-server launch: executable, resolved file
// paths and the argument builder. Configuration problems throw LaunchConfigError so the
// scheduler records them as a load failure.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildLaunchArgs, cmdProgramMayExpand, formatCmdCommand, formatPosixCommand, type ArgWarning, type BuildInput, type LaunchDefaults, type LaunchParams, type ParamOverrides } from './args'
import { deviceMissing, type DeviceList } from './devices'
import { autoPick, comboKey, requiredDevices, resolveGpuSelection, type GpuChoice, type GpuGroup, type GpuSelection } from './gpu-group'
import { comboWarnings, type ComboRecord } from './split-stats'
import { installedDir } from './llamacpp'
import type { RuntimeTarget } from './platform'
import { currentTagFor, defaultsFor, hasDeviceSelection, type ModelConfig, type ModelsDoc, type Settings } from './config'
import type { Target } from './scheduler'
import { resolveFileRef } from './scanner'
import { parseRuntimeRef, resolveRuntimeRef, RuntimeResolveError, type FallbackReason, type RuntimeAccel, type RuntimeEnv } from './runtimes'

export type LaunchConfigErrorCode = 'model-missing' | 'profile-missing' | 'file-missing' | 'no-runtime' | 'bad-args' | 'device-missing' | 'split-mode-unsupported'

export class LaunchConfigError extends Error {
  constructor(public code: LaunchConfigErrorCode, message: string, public warnings: ArgWarning[] = []) {
    super(message)
    this.name = 'LaunchConfigError'
  }
}

/** The llama.cpp build a launch uses and, when the requested one was unusable, what was asked and why it was replaced. */
export interface RuntimeUse {
  /** The reference that runs (null = the global current version). */
  ref: string | null
  label: string
  /** Type of the build that runs; picks the global defaults (decision 36). */
  accel: RuntimeAccel
  fallback: null | { from: string, reason: FallbackReason, to: string }
}

/** What the build reports about itself: its device list and the split modes its `--help` lists (null = unknown). */
export interface DeviceInfo {
  devices: DeviceList
  splitModes: readonly string[] | null
}

export interface LaunchPlan {
  exe: string
  runtime: RuntimeUse
  /** Device the model runs on: `auto`, `cpu`, one id or the ids of a GPU group joined by `,` (always `auto` on a Mac). */
  device: string
  /** Device ids that must be on the build's device list (empty for `auto` / `cpu`). */
  devices: string[]
  /** The GPU group (two or more devices) this launch spreads the model over. */
  group: GpuGroup | null
  /** Key of the group's build + devices + mode in `data/split-modes.json`; null without a group. */
  combo: string | null
  /** The GPU `auto` was replaced by (decision 45: the one with the most memory when there are several), else null. */
  autoPicked: string | null
  /**
   * Check the plan against what the build reports and settle `auto`: a device not on the list throws `device-missing`,
   * a split mode the build does not list throws `split-mode-unsupported`. Returns the plan to run (this one is not changed).
   */
  resolve(info: DeviceInfo, record?: ComboRecord): LaunchPlan
  /** Argument array (without the executable) for an allocated port. */
  args: (port: number) => string[]
  tag: string
  loadTimeoutMs: number
  warnings: ArgWarning[]
  /** Absolute paths of the weight files (model, mmproj, draft) the load reads. */
  weightFiles: string[]
}

export interface PlanInput {
  dataDir: string
  settings: Settings
  models: ModelsDoc
  host: string
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
  target?: RuntimeTarget
  /** Registered builds and installed official versions, needed to follow a `runtime` reference of a model / profile. */
  runtimeEnv?: RuntimeEnv
}

/** Build part of a split-mode record key: a group can behave differently on another build or build type. */
export const runtimeKeyOf = (r: Pick<RuntimeUse, 'accel' | 'label'>) => `${r.accel}:${r.label}`

/** The reference a launch asks for: the profile's own choice, else the model's, else none (= global version). */
export const requestedRuntime = (model: Pick<ModelConfig, 'runtime'>, profileRuntime: string | null | undefined): string =>
  (profileRuntime || model.runtime || '').trim()

/**
 * The device choice a launch asks for: the profile's own, else the model's, else the global default of the
 * defaults set in use; the first layer that has one wins as a whole, with its own split fields (decision 45).
 * A Mac has no device choice, so a stored value is ignored.
 */
export function chosenGpu(profile: GpuChoice | null | undefined, model: GpuChoice, defaults: GpuChoice, os: NodeJS.Platform): GpuSelection {
  return hasDeviceSelection({ os }) ? resolveGpuSelection(profile, model, defaults) : { device: 'auto', group: null }
}

/** Single-value form of `chosenGpu` (a group shows as its ids joined by `,`). */
export function chosenDevice(profileDevice: string | null | undefined, model: GpuChoice, defaults: GpuChoice, os: NodeJS.Platform): string {
  return chosenGpu({ device: profileDevice }, model, defaults, os).device
}

/**
 * Executable for a launch: follows the profile / model reference when there is one (falling back to
 * the newest official build of the same channel when it cannot be used), else the global version.
 */
export function chooseExe(
  ref: string, input: { dataDir: string, settings: Settings, platform?: NodeJS.Platform, target?: RuntimeTarget, runtimeEnv?: RuntimeEnv, exists?: (p: string) => boolean },
): { exe: string | null, runtime: RuntimeUse } {
  if (ref && input.runtimeEnv) {
    const env = { ...input.runtimeEnv, exists: input.runtimeEnv.exists ?? input.exists }
    const r = resolveRuntimeRef(ref, env)
    const p = parseRuntimeRef(r.ref)
    const accel = p?.kind === 'official' ? p.accel : env.entries.find(e => p?.kind === 'custom' && e.id === p.id)?.accel ?? env.target.acceleration
    return { exe: r.exe, runtime: { ref: r.ref, label: r.label, accel, fallback: r.fallback } }
  }
  const accel = input.target?.acceleration ?? 'cuda'
  const cur = currentTagFor(input.settings, { os: input.target?.os ?? input.platform ?? process.platform }, accel)
  return { exe: llamaServerExe(input.dataDir, input.settings, input.platform, input.target), runtime: { ref: null, label: cur, accel, fallback: null } }
}

/** `data/runtime/llama.cpp/<current>/llama-server(.exe)`, or null when no version is set. */
export function llamaServerExe(dataDir: string, settings: Settings, platform = process.platform, target?: RuntimeTarget): string | null {
  const cur = currentTagFor(settings, { os: target?.os ?? platform }, target?.acceleration ?? 'cuda')
  if (!cur || /[\\/]|\.\./.test(cur)) return null
  return join(installedDir(dataDir, cur, target), platform === 'win32' ? 'llama-server.exe' : 'llama-server')
}

export interface PreviewInput {
  dataDir: string
  settings: Settings
  model: ModelConfig
  /** Form values to preview (may be unsaved). The device fields act as the profile's own choice. */
  form: { overrides: ParamOverrides, extraArgs: string, chatTemplate: string | null, runtime?: string | null } & GpuChoice
  host: string
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
  target?: RuntimeTarget
  runtimeEnv?: RuntimeEnv
  /** What the build reports: lets `auto` show the GPU it will pick and split modes be checked. Left out = not checked. */
  deviceInfo?: DeviceInfo
  /** Confirmed / failed record of a group combination (see `ComboRecord`). */
  comboRecord?: (key: string) => ComboRecord | undefined
}

export interface LaunchPreview {
  /** The build the command runs, and the fallback when the chosen one is unusable. */
  runtime: RuntimeUse
  /** Device the command runs the model on (`auto`, `cpu`, one id or a group's ids joined by `,`). */
  device: string
  /**
   * Full command line as the UI shows it; the same arguments planLaunch would pass. On Windows
   * it is written for cmd.exe (quoting and ^ escapes), elsewhere in the project's own syntax.
   */
  command: string
  shell: 'cmd' | 'posix'
  ok: boolean
  warnings: ArgWarning[]
  /** Merged form values before extra-args replacement. */
  effective: LaunchParams
  /** Configured files that do not exist (the command still shows where they are expected). */
  missing: Array<'model' | 'mmproj' | 'draft' | 'chatTemplate' | 'runtime'>
  /** The port is allocated at start; this is only the first port of the range. */
  port: number
}

/**
 * Command preview for the edit form. Uses buildLaunchArgs exactly like planLaunch, but never
 * throws for missing files or runtime: those are reported in `missing` instead.
 */
export function previewLaunch(input: PreviewInput): LaunchPreview {
  const exists = input.exists ?? existsSync
  const { settings, model, form } = input
  const missing: LaunchPreview['missing'] = []
  let exe: string | null, runtime: RuntimeUse
  try {
    ;({ exe, runtime } = chooseExe(requestedRuntime(model, form.runtime), input))
  } catch (e) {
    if (!(e instanceof RuntimeResolveError)) throw e
    exe = null
    runtime = { ref: null, label: '', accel: input.target?.acceleration ?? 'cuda', fallback: null }
  }
  if (!exe || !exists(exe)) missing.push('runtime')

  const resolve = (kind: 'model' | 'mmproj' | 'draft', ref: ModelConfig['file'] | null) => {
    if (!ref) return null
    const abs = resolveFileRef(settings.modelDirs, ref)
    if (!abs || !exists(abs)) missing.push(kind)
    return abs ?? `${ref.dirId}/${ref.rel}`
  }
  const paths: BuildInput['paths'] = {
    model: resolve('model', model.file)!,
    mmproj: resolve('mmproj', model.mmproj),
    draft: resolve('draft', model.draft),
    chatTemplate: null,
  }
  if (form.chatTemplate) {
    const abs = join(input.dataDir, 'templates', form.chatTemplate)
    if (/[\\/]|\.\./.test(form.chatTemplate) || !exists(abs)) missing.push('chatTemplate')
    paths.chatTemplate = abs
  }
  const port = settings.scheduler.portRange[0]
  const win = (input.platform ?? process.platform) === 'win32'
  const os = input.target?.os ?? input.platform ?? process.platform
  const defaults = defaultsFor(settings, { os }, runtime.accel)
  let sel = chosenGpu(form, model, defaults, os)
  const make = (g: GpuSelection) => buildLaunchArgs({
    paths, defaults,
    profile: { overrides: form.overrides, extraArgs: form.extraArgs },
    host: input.host, port, device: g.device, group: g.group,
  })
  let built = make(sel)
  const extra: ArgWarning[] = []
  if (input.deviceInfo && hasDeviceSelection({ os })) {
    const g = sel.device === 'auto' && built.device === 'auto' ? autoPick(input.deviceInfo.devices) : null
    if (g) { sel = { device: g.id, group: null }; built = make(sel) }
    extra.push(...comboWarnings(sel.group, sel.group ? input.comboRecord?.(comboKey(runtimeKeyOf(runtime), sel.group.devices, sel.group.splitMode)) : undefined, input.deviceInfo.splitModes))
  }
  const program = exe ?? (win ? 'llama-server.exe' : 'llama-server')
  const warnings = [...built.warnings, ...extra]
  if (win && cmdProgramMayExpand(program)) warnings.push({ code: 'preview-program-percent', severity: 'warning' })
  return {
    command: win ? formatCmdCommand(program, built.args) : formatPosixCommand(program, built.args),
    shell: win ? 'cmd' : 'posix',
    ok: built.ok && !extra.some(w => w.severity === 'error'), warnings, effective: built.effective, missing, port, runtime, device: built.device,
  }
}

export function planLaunch(target: Target, input: PlanInput): LaunchPlan {
  const exists = input.exists ?? existsSync
  const { settings } = input
  const model = input.models.models.find(m => m.id === target.modelId)
  if (!model) throw new LaunchConfigError('model-missing', `No model "${target.modelId}"`)
  const profile = model.profiles[target.profile]
  if (!profile) throw new LaunchConfigError('profile-missing', `No profile "${target.profile}" in "${model.id}"`)

  let exe: string | null, runtime: RuntimeUse
  try {
    ;({ exe, runtime } = chooseExe(requestedRuntime(model, profile.runtime), input))
  } catch (e) {
    if (e instanceof RuntimeResolveError) throw new LaunchConfigError('no-runtime', `No official llama.cpp build installed for the ${e.channel} channel`)
    throw e
  }
  if (!exe || !exists(exe)) throw new LaunchConfigError('no-runtime', `llama-server not found: ${exe ?? '(no current version)'}`)

  const resolve = (what: string, ref: typeof model.file | null) => {
    if (!ref) return null
    const abs = resolveFileRef(settings.modelDirs, ref)
    if (!abs || !exists(abs)) throw new LaunchConfigError('file-missing', `${what} not found: ${ref.dirId}/${ref.rel}`)
    return abs
  }
  const paths: BuildInput['paths'] = {
    model: resolve('model', model.file)!,
    mmproj: resolve('mmproj', model.mmproj),
    draft: resolve('draft', model.draft),
    chatTemplate: null,
  }
  if (profile.chatTemplate) {
    const name = profile.chatTemplate
    const abs = join(input.dataDir, 'templates', name)
    if (/[\\/]|\.\./.test(name) || !exists(abs)) throw new LaunchConfigError('file-missing', `chat template not found: ${name}`)
    paths.chatTemplate = abs
  }

  const os = input.target?.os ?? input.platform ?? process.platform
  const defaults = defaultsFor(settings, { os }, runtime.accel)
  const sel0 = chosenGpu(profile, model, defaults, os)

  const assemble = (sel: GpuSelection, autoPicked: string | null, extra: ArgWarning[]): LaunchPlan => {
    const build = (port: number) => buildLaunchArgs({
      paths,
      defaults,
      profile: { overrides: profile.overrides, extraArgs: profile.extraArgs },
      host: input.host,
      port,
      device: sel.device,
      group: sel.group,
    })
    const probe = build(settings.scheduler.portRange[0])
    if (!probe.ok) {
      throw new LaunchConfigError('bad-args', `Invalid launch arguments for ${model.id}:${target.profile}`, probe.warnings)
    }
    // Extra args with their own --device decide what must exist on the list (several devices count as auto there).
    const overridden = probe.device !== sel.device
    const devices = overridden ? requiredDevices({ device: probe.device, group: null }) : requiredDevices(sel)
    return {
      exe,
      runtime,
      device: probe.device,
      devices,
      group: overridden ? null : sel.group,
      combo: sel.group && !overridden ? comboKey(runtimeKeyOf(runtime), sel.group.devices, sel.group.splitMode) : null,
      autoPicked,
      resolve: (info, record) => {
        const gone = devices.find(d => deviceMissing(d, info.devices))
        if (gone) throw new LaunchConfigError('device-missing', `Device ${gone} is not on the device list of ${runtime.label}`)
        const g = !overridden ? sel.group : null
        const found = comboWarnings(g, record, info.splitModes)
        const bad = found.find(w => w.severity === 'error')
        if (bad) throw new LaunchConfigError('split-mode-unsupported', `${runtime.label} does not list the split mode "${bad.detail}"`, [bad])
        const pick = sel.device === 'auto' && probe.device === 'auto' ? autoPick(info.devices) : null
        return assemble(pick ? { device: pick.id, group: null } : sel, pick?.id ?? null, found)
      },
      args: port => build(port).args,
      tag: `${model.id}:${target.profile}`,
      loadTimeoutMs: settings.scheduler.loadTimeoutSec * 1000,
      warnings: [...probe.warnings, ...extra],
      weightFiles: [paths.model, paths.mmproj, paths.draft].filter((p): p is string => !!p),
    }
  }
  return assemble(sel0, null, [])
}
