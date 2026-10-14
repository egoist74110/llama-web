// Clipboard diagnostics (decision 61): pure formatting and redaction, no I/O or uploads.
import { APP_VERSION } from './app-info'
import type { DeviceList } from './devices'
import type { FailureKind } from './errors'
import type { AccelerationView } from './settings-admin'
import type { NvidiaProbe } from './platform'
import { redactText } from './redact'
import { parseRuntimeRef, RUNTIME_ACCELS, type RuntimeEntryAccel } from './runtimes'

export interface DiagnosticRuntime { ref: string, label: string, accel: RuntimeEntryAccel, tag: string }
export interface RunDiagnosticMeta { runtime: DiagnosticRuntime, profile: string }
export const DIAGNOSTIC_META_PREFIX = '# llama-web runtime: '

/** Only validated references are accepted from log metadata; no executable paths are stored or trusted. */
export function parseDiagnosticMeta(line: string): RunDiagnosticMeta | null {
  if (!line.startsWith(DIAGNOSTIC_META_PREFIX)) return null
  try {
    const m = JSON.parse(line.slice(DIAGNOSTIC_META_PREFIX.length)) as RunDiagnosticMeta
    const r = m.runtime
    const ref = parseRuntimeRef(r.ref)
    if (!ref || !RUNTIME_ACCELS.includes(r.accel) || typeof r.label !== 'string' || r.label.length > 80
      || typeof r.tag !== 'string' || (r.tag !== '' && !/^b\d+$/.test(r.tag)) || typeof m.profile !== 'string') return null
    if (ref.kind === 'official' && (ref.accel !== r.accel || ref.tag !== r.tag)) return null
    return m
  } catch { return null }
}

export interface DiagnosticsInput {
  os: NodeJS.Platform
  arch: string
  acceleration: Pick<AccelerationView, 'saved' | 'active' | 'gpuChannel' | 'reason'>
  runtime: DiagnosticRuntime | null
  devices: DeviceList | null
  nvidiaProbe?: NvidiaProbe
  failure?: FailureKind | null
  log?: readonly string[] | null
  /** All configured credentials, passed by the management service, never printed. */
  secrets: readonly string[]
  username: string
}

/** Exact secret values first (longest first), then paths and the machine account name. */
export function redactDiagnostics(text: string, secrets: readonly string[], username: string): string {
  let out = text
  for (const key of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) out = redactText(out, key)
  const path = (value: string) => `<path>/${value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? ''}`
  out = out
    // Unquoted file paths may contain spaces; keep the final filename including its extension.
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|Volumes)\/)[^"'\r\n<>]*?\.[A-Za-z0-9]+(?:\.\d+)?(?=[\s"',;:()]|$)/gi, value => path(value))
    .replace(/(["'])([^"'\r\n]*[\\/][^"'\r\n]*\.gguf)\1/gi, (_, quote: string, value: string) => `${quote}${path(value)}${quote}`)
    // Quoted absolute paths may contain spaces (Windows drive, UNC or POSIX).
    .replace(/(["'])([A-Za-z]:[\\/][^"'\r\n]*|\\\\[^"'\r\n]*|\/[^"'\r\n]*)\1/g, (_, quote: string, value: string) => `${quote}${path(value)}${quote}`)
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+/g, value => path(value))
    .replace(/(?<![\w.:/])\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]+/g, value => path(value))
  // Relative model paths also expose only the filename, never their directory components.
  out = out.replace(/(?:[^\s"'<>\\/]+[\\/])+([^\\/\s"'<>]+\.gguf)\b/gi, '<path>/$1')
  if (username) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), '<user>')
  }
  return out
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const a = input.acceleration
  const lines = [
    `llama-web.version: ${APP_VERSION}`, `os: ${input.os}`, `arch: ${input.arch}`,
    `acceleration.saved: ${a.saved}`, `acceleration.active: ${a.active}`,
    `acceleration.gpuChannel: ${a.gpuChannel ?? 'none'}`, `acceleration.reason: ${a.reason ?? 'none'}`,
  ]
  const r = input.runtime
  if (r) lines.push(`runtime.ref: ${r.ref}`, `runtime.label: ${r.label}`, `runtime.accel: ${r.accel}`, `runtime.tag: ${r.tag || 'unknown'}`)
  else lines.push('runtime: unavailable')
  if (input.devices?.source === 'list-devices') {
    lines.push(`devices: ${input.devices.gpus.length ? '' : 'none'}`.trimEnd())
    for (const d of input.devices.gpus) lines.push(`  id: ${d.id}`, `  name: ${d.name}`, `  totalMiB: ${d.totalMiB}`, `  freeMiB: ${d.freeMiB ?? 'unknown'}`)
  } else lines.push('devices: unavailable')
  lines.push(`nvidia.probe: ${input.nvidiaProbe ?? 'not-applicable'}`, `failure.kind: ${input.failure ?? 'none'}`, 'log.tail:')
  lines.push(...(input.log?.length ? input.log.slice(-60) : ['unavailable']))
  return redactDiagnostics(lines.join('\n'), input.secrets, input.username)
}
