// Turn a scheduler target into a concrete llama-server launch: executable, resolved file
// paths and the argument builder. Configuration problems throw LaunchConfigError so the
// scheduler records them as a load failure.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildLaunchArgs, type ArgWarning, type BuildInput } from './args'
import type { ModelsDoc, Settings } from './config'
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
