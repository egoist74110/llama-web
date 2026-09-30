// Turn a scheduler target into a concrete llama-server launch: executable, resolved file
// paths and the argument builder. Configuration problems throw LaunchConfigError so the
// scheduler records them as a load failure.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildLaunchArgs, formatCmdCommand, formatCommand, type ArgWarning, type BuildInput, type LaunchParams, type ParamOverrides } from './args'
import type { ModelConfig, ModelsDoc, Settings } from './config'
import type { Target } from './scheduler'
import { resolveFileRef } from './scanner'

export type LaunchConfigErrorCode = 'model-missing' | 'profile-missing' | 'file-missing' | 'no-runtime' | 'bad-args'

export class LaunchConfigError extends Error {
  constructor(public code: LaunchConfigErrorCode, message: string, public warnings: ArgWarning[] = []) {
    super(message)
    this.name = 'LaunchConfigError'
  }
}

export interface LaunchPlan {
  exe: string
  /** Argument array (without the executable) for an allocated port. */
  args: (port: number) => string[]
  tag: string
  loadTimeoutMs: number
  warnings: ArgWarning[]
}

export interface PlanInput {
  dataDir: string
  settings: Settings
  models: ModelsDoc
  host: string
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

/** `data/runtime/llama.cpp/<current>/llama-server(.exe)`, or null when no version is set. */
export function llamaServerExe(dataDir: string, settings: Settings, platform = process.platform): string | null {
  const cur = settings.llamacpp.current
  if (!cur || /[\\/]|\.\./.test(cur)) return null
  return join(dataDir, 'runtime', 'llama.cpp', cur, platform === 'win32' ? 'llama-server.exe' : 'llama-server')
}

export interface PreviewInput {
  dataDir: string
  settings: Settings
  model: ModelConfig
  /** Form values to preview (may be unsaved). */
  form: { overrides: ParamOverrides, extraArgs: string, chatTemplate: string | null }
  host: string
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

export interface LaunchPreview {
  /**
   * Full command line as the UI shows it; the same arguments planLaunch would pass. On Windows
   * it is written for cmd.exe (quoting and ^ escapes), elsewhere in the project's own syntax.
   */
  command: string
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
  const exe = llamaServerExe(input.dataDir, settings, input.platform)
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
  const built = buildLaunchArgs({
    paths, defaults: settings.defaults,
    profile: { overrides: form.overrides, extraArgs: form.extraArgs },
    host: input.host, port,
  })
  return {
    command: win
      ? formatCmdCommand(exe ?? 'llama-server.exe', built.args)
      : formatCommand(exe ?? 'llama-server', built.args),
    ok: built.ok, warnings: built.warnings, effective: built.effective, missing, port,
  }
}

export function planLaunch(target: Target, input: PlanInput): LaunchPlan {
  const exists = input.exists ?? existsSync
  const { settings } = input
  const model = input.models.models.find(m => m.id === target.modelId)
  if (!model) throw new LaunchConfigError('model-missing', `No model "${target.modelId}"`)
  const profile = model.profiles[target.profile]
  if (!profile) throw new LaunchConfigError('profile-missing', `No profile "${target.profile}" in "${model.id}"`)

  const exe = llamaServerExe(input.dataDir, settings, input.platform)
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

  const build = (port: number) => buildLaunchArgs({
    paths,
    defaults: settings.defaults,
    profile: { overrides: profile.overrides, extraArgs: profile.extraArgs },
    host: input.host,
    port,
  })
  const probe = build(settings.scheduler.portRange[0])
  if (!probe.ok) {
    throw new LaunchConfigError('bad-args', `Invalid launch arguments for ${model.id}:${target.profile}`, probe.warnings)
  }
  return {
    exe,
    args: port => build(port).args,
    tag: `${model.id}:${target.profile}`,
    loadTimeoutMs: settings.scheduler.loadTimeoutSec * 1000,
    warnings: probe.warnings,
  }
}
