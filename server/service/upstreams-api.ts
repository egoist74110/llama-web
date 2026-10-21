// Shared by the /api/upstreams routes: the list the page shows, the edit context and error mapping.
import { basename, join } from 'node:path'
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { LaunchError } from '../core/upstream-launcher'
import { forceStopPort, ForceStopError, inspectPort, isLocalHost, localPortOf, type PortOwnerDeps } from '../core/port-owner'
import { PidRegistry } from '../core/runner'
import type { SecretsDoc } from '../core/keys'
import { saveUpstreamsAndKeys as saveBoth, selfPortsOf, UpstreamError, viewUpstreams, type ConnectionView, type EditContext, type UpstreamsDoc } from '../core/upstreams'
import { getContext } from './context'

export function describeUpstreams(): { upstreams: ConnectionView[], exclusiveHolder: string | null } {
  const ctx = getContext()
  const upstreams = viewUpstreams(ctx.getUpstreams(), ctx.getSecrets().upstreamKeys).map(u => ({
    ...u, up: ctx.health.isUp(u.id), checkedAt: ctx.health.state(u.id)?.checkedAt ?? null, launch: ctx.launcher.state(u.id), canStop: ctx.launcher.canStop(u.id),
  })).map(u => ({ ...u, canForceStop: u.up && !u.canStop && isLocalHost(u.baseUrl) }))
  return { upstreams, exclusiveHolder: ctx.health.holder() }
}

/** Local model names (a prefix must not shadow them) and the ports llama-web itself listens on (no forwarding loops; the public port only while the public entry is really listening (not merely switched on: its port may be taken by another engine, like :8080), since 8080 is also where other engines like to live). */
export function editContext(): EditContext {
  const ctx = getContext()
  const s = ctx.getSettings()
  const pub = ctx.publicEntry.status()
  return { localNames: ctx.getModels().models.map(m => m.name), selfPorts: selfPortsOf(s.server.port, ctx.bootPort, pub), kbIds: ctx.getKnowledge().bases.map(b => b.id) }
}

/** `saveUpstreamsAndKeys` on the running context's files. */
export function saveUpstreamsAndKeys(changeUpstreams: (draft: UpstreamsDoc) => UpstreamsDoc | void, changeKeys: (draft: SecretsDoc) => SecretsDoc | void): void {
  saveBoth(getContext(), changeUpstreams, changeKeys)
}

/** An API key from a form: undefined = keep, '' = remove, otherwise the new one. */
export function cleanKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw.trim()) || raw.length > 2000) throw new UpstreamError('bad-key')
  return raw.trim()
}

/** Turn an upstream / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function upstreamsError(e: unknown): never {
  if (e instanceof UpstreamError) {
    const errors = t.upstreams.errors as Record<string, string>
    const status = e.code === 'not-found' ? 404 : e.code === 'name-taken' ? 409 : e.code === 'rollback-failed' ? 500 : 400
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail: e.detail }) })
  }
  // upstreams.json / secrets.json is broken (hand edit): never overwrite it with the cached copy.
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.upstreams.errors['store'], { detail: e.message }) })
  throw e
}

/** Turn a start failure into an HTTP error with a Chinese message; other errors pass through. */
export function launchError(e: unknown): never {
  if (e instanceof LaunchError) {
    const errors = t.upstreams.launch.errors as Record<string, string>
    const status = e.code === 'not-found' ? 404 : e.code === 'already-up' || e.code === 'already-starting' ? 409 : 400
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail: e.detail }) })
  }
  return upstreamsError(e)
}

/** Turn a force-stop refusal into an HTTP error with a Chinese message; other errors pass through. */
export function forceStopError(e: unknown): never {
  if (e instanceof ForceStopError) {
    const errors = t.upstreams.forceStop.errors as Record<string, string>
    const status = e.code === 'not-found' ? 404 : e.code === 'not-local' || e.code === 'bad-body' ? 400 : 409
    throw createError({ statusCode: status, message: errors[e.code] ?? e.code, data: { code: e.code } })
  }
  throw e
}

/** The port of a local upstream; throws `not-found` / `not-local` otherwise. */
function localPort(id: string | undefined): number {
  const u = getContext().getUpstreams().upstreams.find(x => x.id === id)
  if (!u) throw new ForceStopError('not-found')
  const port = localPortOf(u.baseUrl)
  if (port === null) throw new ForceStopError('not-local')
  return port
}

function portDeps(): PortOwnerDeps {
  const dataDir = getContext().dataDir
  return {
    managedPids: () => new PidRegistry(join(dataDir, 'run', 'pids.json')).list().map(r => r.pid),
    runtimeDir: join(dataDir, 'runtime'),
  }
}

export interface ForceStopInfo { pid: number, name: string, exe: string, birth: string, listenerPid: number, children: number, port: number }

/** What a force stop of this upstream would end (the page shows it before asking). */
export async function inspectForceStop(id: string | undefined): Promise<ForceStopInfo> {
  const port = localPort(id)
  const r = await inspectPort(port, portDeps())
  if (!r.ok) throw new ForceStopError(r.code)
  return { pid: r.target.pid, name: r.target.name, exe: r.target.exe, birth: r.target.birth, listenerPid: r.listener.pid, children: r.children, port }
}

/** End the process the user saw, if it is still the same one; then forget it and probe again. */
export async function forceStop(id: string | undefined, body: unknown): Promise<ReturnType<typeof describeUpstreams>> {
  const { pid, birth } = (body ?? {}) as { pid?: unknown, birth?: unknown }
  if (!Number.isInteger(pid) || typeof birth !== 'string' || !birth) throw new ForceStopError('bad-body')
  const port = localPort(id)
  const ctx = getContext()
  const u = ctx.getUpstreams().upstreams.find(x => x.id === id)!
  const target = await forceStopPort(port, { pid: pid as number, birth }, portDeps())
  ctx.launcher.forget(u.id)
  console.info('[llama-web]', `upstream ${u.name}: force-stopped pid ${target.pid} (${basename(target.exe)})`)
  ctx.health.tick().catch(() => {})
  return describeUpstreams()
}
