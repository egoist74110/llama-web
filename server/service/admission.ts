// Glue of the memory check before a load (decisions 41-44): what the scheduler asks before it starts a model, the
// answer of a manual start, and the live reading of free memory shared by the load measurement and the watchdog.
// The estimate itself is `checkProfile` (the same one the save-time check uses); the rules are in core/admission.ts.
import { fmt, t } from '../core/i18n'
import { admissionFrom, type AdmissionData } from '../core/admission'
import { noRoomText } from '../core/proxy'
import { effectiveMaxLoaded } from '../core/config'
import { parseNvidiaSmi, runNvidiaSmi } from '../core/gpu'
import { sampleSystemMemory } from '../core/memory-sample'
import type { Admission, Target } from '../core/scheduler'
import type { PoolReading } from '../core/watchdog'
import { getContext } from './context'
import { checkProfile, currentLaunchKey } from './model-check'

/** Free memory right now: every NVIDIA card (`CUDA<n>`, not on a Mac) and the system (`system`); null when nothing could be read. */
export async function samplePools(os: NodeJS.Platform = process.platform): Promise<PoolReading[] | null> {
  const out: PoolReading[] = []
  if (os !== 'darwin') {
    try {
      for (const g of parseNvidiaSmi(await runNvidiaSmi())) out.push({ id: `CUDA${g.index}`, totalMiB: g.totalMiB, freeMiB: g.totalMiB - g.usedMiB })
    } catch { /* no nvidia-smi: the cards are not watched */ }
  }
  try {
    const s = await sampleSystemMemory()
    if (s.totalMiB !== null && s.availableMiB !== null) out.push({ id: 'system', totalMiB: s.totalMiB, freeMiB: s.availableMiB })
  } catch { /* unreadable */ }
  return out.length ? out : null
}

/** Memory used per pool id (null where the reading has no such pool), for the before / after of a load. */
export async function usedOf(ids: readonly string[], os?: NodeJS.Platform): Promise<Array<number | null>> {
  const readings = await samplePools(os)
  return ids.map((id) => {
    const r = readings?.find(x => x.id === id)
    return r ? r.totalMiB - r.freeMiB : null
  })
}

/** The scheduler's question before a load: does the launch of this target fit next to the online models? */
export async function admitTarget(target: Target, _online: Target[]): Promise<Admission> {
  const ctx = getContext()
  // The start-up cleanup is awaited here, before the check, so that nothing between the check and the launch waits for it.
  await ctx.cleanupDone
  const model = ctx.getModels().models.find(m => m.id === target.modelId)
  if (!model?.profiles[target.profile]) return admissionFrom(null)
  // Free memory is read again for every answer: what the models online take is in the reading already.
  const check = await checkProfile(model, target.profile, undefined, { fresh: true })
  return admissionFrom(check.estimate, { statsKey: check.statsKey, dropMlock: check.mlockDropped, basis: check.basis })
}

/**
 * Is the answer still about the launch that would start now? Compares the key it was made for (arguments, files, runtime
 * build) with the one of the saved profile. A save during the memory reads makes it stale; the scheduler asks again.
 */
export async function admissionIsCurrent(target: Target, admission: Admission): Promise<boolean> {
  const ctx = getContext()
  await ctx.cleanupDone // already done once an admission was made (admitTarget waits for it); keeps the key read after the wait
  const was = (admission.data as AdmissionData | undefined)?.statsKey
  if (!was) return true
  // The configuration the key is read from must not change while it is computed (the launch reads it right after).
  const settings = ctx.getSettings()
  const models = ctx.getModels()
  const model = models.models.find(m => m.id === target.modelId)
  if (!model?.profiles[target.profile]) return true // the launch fails by itself
  let now: string
  try { now = await currentLaunchKey(model, target.profile) } catch { return true }
  const same = now === was && ctx.getSettings() === settings && ctx.getModels() === models
  if (same) verified.set(admission, { settings, models })
  return same
}

/** The configuration documents an admission was last proven current against. */
const verified = new WeakMap<Admission, { settings: unknown, models: unknown }>()

/**
 * Synchronous last look for the launcher: false when the configuration was saved after the answer was proven current, so the
 * plan it is about to make would not be the one that was checked. An answer that was never verified binds nothing.
 */
export function admissionStillBound(admission: Admission): boolean {
  const v = verified.get(admission)
  if (!v) return true
  const ctx = getContext()
  return ctx.getSettings() === v.settings && ctx.getModels() === v.models
}

/** A manual start the check does not allow (HTTP 409): `reason` is `limit`, `nofit`, `risky`, `unknown` or `exclusive` (an external upstream holds the machine). */
export class StartRefused extends Error {
  constructor(public reason: 'limit' | 'nofit' | 'risky' | 'unknown' | 'exclusive', message: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'StartRefused'
  }
}

/** The same check for the HTTP routes: a refusal becomes a 409 whose `data.reason` tells the interface what to ask. */
export async function checkedStart(target: Target, confirm: boolean): Promise<void> {
  try {
    await precheckStart(target, confirm)
  } catch (e) {
    if (e instanceof StartRefused) throw createError({ statusCode: 409, message: e.message, data: { reason: e.reason, ...e.data } })
    throw e
  }
}

const gib = (miB: number | null) => (miB === null ? '?' : `${(miB / 1024).toFixed(1)} GB`)

/**
 * Answer of a manual start (start / retry) while several models may be online. Throws StartRefused (409 through `checkedStart`) with `reason`:
 * `limit` (stop one first), `nofit` (stop others first; there is no forced start), `risky` / `unknown` (needs `confirm`).
 * Does nothing with multi-load off or when the target is already online. The scheduler asks again when the load begins.
 */
export async function precheckStart(target: Target, confirm: boolean): Promise<void> {
  const ctx = getContext()
  const settings = ctx.getSettings()
  const holder = ctx.health.holder()
  if (holder) {
    const name = ctx.getModels().models.find(m => m.id === target.modelId)?.name ?? target.modelId
    throw new StartRefused('exclusive', noRoomText({ reason: 'exclusive', estimateMiB: null, availableMiB: null, pool: null, holder }, name), { holder })
  }
  if (!settings.scheduler.multiLoad) return
  const key = (x: Target) => `${x.modelId}\u0000${x.profile}`
  const online = ctx.scheduler.snapshot().models.filter(m => ['loading', 'ready', 'draining', 'unloading'].includes(m.state))
  if (online.some(m => key(m) === key(target) && (m.state === 'ready' || m.state === 'loading'))) return
  const model = ctx.getModels().models.find(m => m.id === target.modelId)
  const name = model?.name ?? target.modelId
  const fail = (reason: StartRefused['reason'], text: string, extra: Record<string, unknown> = {}): never => {
    throw new StartRefused(reason, text, extra)
  }
  const limit = effectiveMaxLoaded(settings)
  if (online.filter(m => key(m) !== key(target)).length >= limit) fail('limit', fmt(t.models.start.limit, { model: name, limit }), { limit })
  const a = await admitTarget(target, [])
  const vars = { model: name, estimate: gib(a.detail.estimateMiB), available: gib(a.detail.availableMiB) }
  const extra = { tier: a.tier, ...a.detail }
  if (a.tier === 'nofit') fail('nofit', fmt(t.models.start.nofit, vars), extra)
  if (!confirm && a.tier === 'risky') fail('risky', fmt(t.models.start.risky, vars), extra)
  if (!confirm && a.tier === 'unknown') fail('unknown', fmt(process.platform === 'darwin' ? t.platform.mac.startUnknown : t.models.start.unknown, vars), extra)
}
