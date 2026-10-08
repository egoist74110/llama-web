// State of the one-click tunnel setup (Cloudflare API), shared by the guide's steps: saved API
// token (masked), what the token can see, the preview and the run. Calls the 4-5 endpoints only.
import { t } from './useLocale'
import type { Inspection, JobRev, JobView, SetupJob, SetupPlan } from '~~/server/core/cloudflare'

export function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

/**
 * Is `next` at least as new as `cur`? Within one server process by `seq`. From another process (a
 * restart): a snapshot always is (the stream is one ordered connection to the running server), a
 * response when its process started later.
 */
export function revAtLeast(next: JobRev, cur: JobRev | null, fromStream = false): boolean {
  if (!cur) return true
  if (next.boot !== cur.boot) return fromStream || next.boot > cur.boot
  return next.seq >= cur.seq
}

export function useCloudflareSetup() {
  const toast = useToast()
  const live = useLive()
  const info = useState('cf-info', () => ({ hasToken: false, maskedToken: null as string | null, loaded: false }))
  const job = useState<SetupJob | null>('cf-job', () => null)
  // Version of `job` (see JobRev): null until the first snapshot / response.
  const rev = useState<JobRev | null>('cf-job-rev', () => null)
  const inspection = useState<Inspection | null>('cf-inspection', () => null)
  const plan = useState<SetupPlan | null>('cf-plan', () => null)
  const busy = useState('cf-busy', () => '')
  const f = useState('cf-form', () => ({ zoneId: '', subdomain: '', tunnelName: 'llama-web', tunnel: '', dns: '' }))

  /**
   * The job comes from two places in any order: live snapshots and the HTTP responses (which still
   * work while the stream is down). Each carries the server's version of the job; the newest wins, so
   * a response that arrives late (a slow GET from before a reload, after a newer snapshot, before or
   * after the stream dropped) never turns a newer state back, and a result the stream missed is shown.
   */
  const takeJob = (v: JobView, fromStream = false) => {
    if (!revAtLeast(v.rev, rev.value, fromStream)) return
    rev.value = v.rev
    job.value = v.job
  }

  // The run is followed through the live stream: a page opened (or reloaded) while it runs, or another
  // tab, sees every step and the final result, not only the page that pressed the button.
  watch(() => live.state.value, (s) => {
    if (s?.cloudflareRev) takeJob({ job: s.cloudflare ?? null, rev: s.cloudflareRev }, true)
  }, { immediate: true })

  const usable = computed(() => inspection.value?.zones.filter(z => z.usable) ?? [])
  const unusable = computed(() => inspection.value?.zones.filter(z => !z.usable) ?? [])

  const fail = (e: unknown) => toast.add({ title: t.cloudflare.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

  async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return
    busy.value = name
    try {
      return await fn()
    } catch (e) {
      fail(e)
    } finally {
      busy.value = ''
    }
  }

  async function loadInfo() {
    await run('info', async () => {
      const r = await $fetch<{ hasToken: boolean, maskedToken: string | null } & JobView>('/api/cloudflare')
      info.value = { hasToken: r.hasToken, maskedToken: r.maskedToken, loaded: true }
      takeJob(r)
    })
  }

  /** Re-read what the saved token can see. Returns whether it worked. */
  async function loadZones(): Promise<boolean> {
    const r = await run('zones', async () => {
      inspection.value = (await $fetch<{ inspection: Inspection }>('/api/cloudflare/zones')).inspection
      return true
    })
    return !!r
  }

  /** Verify and save a token ('' clears it). Returns whether it was saved. */
  async function saveToken(value: string): Promise<boolean> {
    const r = await run('token', async () => {
      const res = await $fetch<{ hasToken: boolean, maskedToken: string | null, inspection: Inspection | null }>('/api/cloudflare/token', { method: 'POST', body: { token: value } })
      info.value = { hasToken: res.hasToken, maskedToken: res.maskedToken, loaded: true }
      inspection.value = res.inspection
      plan.value = null
      toast.add({ title: value ? t.cloudflare.saved : t.cloudflare.cleared, color: 'success', icon: 'i-lucide-check' })
      return true
    })
    return !!r
  }

  const body = () => ({ ...f.value, tunnel: f.value.tunnel || undefined, dns: f.value.dns || undefined })

  async function preview(): Promise<boolean> {
    const r = await run('preview', async () => {
      plan.value = await $fetch<SetupPlan>('/api/cloudflare/preview', { method: 'POST', body: body() })
      return true
    })
    return !!r
  }

  function startPreview() {
    f.value.tunnel = ''
    f.value.dns = ''
    return preview()
  }

  function choose(kind: 'tunnel' | 'dns', value: string) {
    f.value[kind] = value
    if (kind === 'tunnel') f.value.dns = ''
    return preview()
  }

  async function apply() {
    await run('apply', async () => {
      takeJob(await $fetch<JobView>('/api/cloudflare/apply', { method: 'POST', body: { ...body(), fingerprint: plan.value?.fingerprint } }))
      plan.value = null
    })
  }

  async function jobAction(name: 'retry' | 'cleanup' | 'dismiss') {
    await run(name, async () => {
      takeJob(await $fetch<JobView>(`/api/cloudflare/${name}`, { method: 'POST' }))
    })
  }

  return { info, job, inspection, plan, busy, f, usable, unusable, loadInfo, loadZones, saveToken, preview, startPreview, choose, apply, jobAction }
}
