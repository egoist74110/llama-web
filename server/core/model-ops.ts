// Management actions on a model (start / stop / retry / restart / switch profile), kept
// consistent across the gap between "stop, wait for drain" and "start again". Every action
// bumps the model's generation; a restart that is still waiting for the old process to go
// only starts its profile if nothing newer has been asked for since (latest action wins).
import type { ModelState, Scheduler, Target } from './scheduler'

export type OpsScheduler = Pick<Scheduler, 'snapshot' | 'start' | 'stop' | 'retry' | 'cancelManual'>

/** Has a process that is (or will be) serving: stays up unless someone stops it. */
const LIVE: ReadonlySet<ModelState> = new Set(['loading', 'ready'])
/** Has a process at all, including one on its way out. */
const UP: ReadonlySet<ModelState> = new Set(['loading', 'ready', 'draining', 'unloading'])

export class ModelOps {
  private readonly gens = new Map<string, number>()
  /** Restarts waiting for the old process to stop, by model. */
  private readonly pending = new Map<string, { gen: number, profile: string }>()

  constructor(private readonly sched: OpsScheduler) {}

  private bump(modelId: string): number {
    const gen = (this.gens.get(modelId) ?? 0) + 1
    this.gens.set(modelId, gen)
    this.pending.delete(modelId)
    return gen
  }

  private instances(modelId: string) {
    return this.sched.snapshot().models.filter(s => s.modelId === modelId)
  }

  start(target: Target): Promise<void> {
    this.bump(target.modelId)
    return this.sched.start(target)
  }

  retry(target: Target): Promise<void> {
    this.bump(target.modelId)
    return this.sched.retry(target)
  }

  stop(modelId: string, opts: { force?: boolean } = {}): Promise<void> {
    this.bump(modelId)
    return this.sched.stop(modelId, opts)
  }

  /** Stop every profile of the model, then start `profile`, unless a later action supersedes it. */
  async restart(modelId: string, profile: string): Promise<void> {
    const gen = this.bump(modelId)
    this.pending.set(modelId, { gen, profile })
    try {
      await this.sched.stop(modelId)
      if (this.gens.get(modelId) !== gen) return
      this.pending.delete(modelId)
      await this.sched.start({ modelId, profile })
    } finally {
      if (this.pending.get(modelId)?.gen === gen) this.pending.delete(modelId)
    }
  }

  /** Profiles with a process, including ones winding down (for display). */
  upProfiles(modelId: string): string[] {
    return this.instances(modelId).filter(s => UP.has(s.state)).map(s => s.profile)
  }

  /**
   * Profiles that must not be renamed or deleted: they have a process, a queued or running
   * load (a request may be waiting for it), or a restart waiting to start them.
   */
  inUseProfiles(modelId: string): string[] {
    const names = new Set(this.upProfiles(modelId))
    for (const q of this.sched.snapshot().queue) if (q.modelId === modelId) names.add(q.profile)
    const p = this.pending.get(modelId)
    if (p) names.add(p.profile)
    return [...names]
  }

  /**
   * After the model's current profile was changed to `profile`: restart onto it when the model
   * is up (or already restarting) on anything else; leave it alone when it is already serving
   * exactly this profile; otherwise only clear failed / crashed marks. The returned promise is
   * the background work (null when there is none).
   */
  switchTo(modelId: string, profile: string): { restarted: boolean, work: Promise<void> | null } {
    // A manual start / retry of another profile that is still queued (e.g. waiting for another
    // model to drain) is an older intent: withdraw it and start the new profile instead.
    // Queued client requests keep the profile they asked for.
    const withdrawn = this.sched.cancelManual(modelId, p => p !== profile)
    const mine = this.instances(modelId)
    const up = mine.filter(s => UP.has(s.state))
    const pending = this.pending.get(modelId)
    const settled = !pending && up.length > 0 && up.every(s => LIVE.has(s.state) && s.profile === profile)
    if (settled) return { restarted: false, work: null }
    if (up.length || pending) return { restarted: true, work: this.restart(modelId, profile) }
    if (withdrawn) return { restarted: true, work: this.start({ modelId, profile }) }
    return { restarted: false, work: mine.length ? this.stop(modelId) : null }
  }

  /**
   * After an edit that applies on the next load: restart the model on the profile it is serving
   * (or about to start), when `only` is unset or names that profile. Null when nothing is up.
   */
  restartIfUp(modelId: string, only?: string): Promise<void> | null {
    const pending = this.pending.get(modelId)?.profile
    const live = this.instances(modelId).filter(s => LIVE.has(s.state)).map(s => s.profile)
    const profile = [...(pending ? [pending] : []), ...live].find(p => only === undefined || p === only)
    return profile === undefined ? null : this.restart(modelId, profile)
  }
}
