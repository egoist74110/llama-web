// Read-only management glue. The formatter receives credentials solely to remove them from its result.
import { userInfo } from 'node:os'
import { buildDiagnostics, parseDiagnosticMeta } from '../core/diagnostics'
import type { DeviceList } from '../core/devices'
import { classify, diagnose } from '../core/errors'
import { describeAcceleration } from '../core/settings-admin'
import { resolveRuntimeRef } from '../core/runtimes'
import type { ModelConfig } from '../core/config'
import { getContext } from './context'

export async function modelDiagnostics(model: ModelConfig): Promise<{ text: string }> {
  const ctx = getContext()
  let log: string[] | null = null
  let meta: ReturnType<typeof parseDiagnosticMeta> = null
  const latest = ctx.logs.list().models.find(m => m.model === model.id)?.files[0]
  if (latest) {
    try {
      log = ctx.logs.read('model', latest.name, model.id, { maxLines: 60 }).lines
      const head = ctx.logs.read('model', latest.name, model.id, { maxLines: 2, maxBytes: 16 * 1024, fromStart: true }).lines
      meta = parseDiagnosticMeta(head[1] ?? '')
    } catch { /* Pruned or unreadable logs are unavailable, never a raw file-system error. */ }
  }
  let devices: DeviceList | null = null
  if (meta) {
    try {
      // A deleted build must not report devices of the fallback build.
      const used = resolveRuntimeRef(meta.runtime.ref, ctx.runtimes.env())
      if (!used.fallback) devices = (await ctx.getDeviceInfo(meta.runtime.ref))?.devices ?? null
    } catch { /* This exact build is no longer available, or its device probe failed. */ }
  }
  const errors = ctx.scheduler.snapshot().models.filter(m => m.modelId === model.id && m.error)
  const last = errors.find(e => e.profile === meta?.profile) ?? errors.at(-1)
  const runFailed = log?.some(line => line.startsWith('# llama-web: could not start:')
    || (/^# llama-web: exited code=-?(?!0\b)\d+/.test(line) && !line.includes('(stopped by llama-web)')))
  const exit = log?.map(line => /^# llama-web: exited code=(-?\d+)/.exec(line)?.[1]).findLast(code => code !== undefined)
  const inferred = runFailed && log ? classify('exited', exit === undefined ? null : Number(exit), log.filter(line => !line.startsWith('# llama-web'))) : null
  const failure = ctx.getLastModelFailure(model.id) ?? (last ? diagnose(last.error)?.kind : null) ?? inferred
  const secrets = ctx.getSecrets()
  const credentials = [...secrets.apiKeys.map(k => k.key), ...Object.values(secrets.upstreamKeys), secrets.tunnelToken, secrets.cloudflareToken]
  let username = ''
  try { username = userInfo().username } catch { /* No account information available. */ }
  return { text: buildDiagnostics({
    os: ctx.platform.os, arch: ctx.platform.arch,
    acceleration: describeAcceleration(ctx.getSettings().llamacpp.acceleration, ctx.platform, ctx.runtimeSelection),
    runtime: meta?.runtime ?? null, devices, nvidiaProbe: ctx.platform.nvidiaProbe,
    failure, log, secrets: credentials, username,
  }) }
}
