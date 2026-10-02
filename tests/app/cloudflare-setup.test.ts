import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { JobRev, SetupJob } from '../../server/core/cloudflare'

// The composable relies on Nuxt auto-imports; give it the few it uses.
const live = { state: shallowRef<{ cloudflare?: SetupJob | null, cloudflareRev?: JobRev | null } | null>(null), connected: ref(true) }
const states = new Map<string, ReturnType<typeof ref>>()
let fetches: Array<{ url: string, resolve: (v: unknown) => void, reject: (e: unknown) => void }> = []
const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
const stub: Record<string, unknown> = {
  useToast: () => ({ add() {} }),
  useLive: () => live,
  useState: (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) },
  computed, watch,
  $fetch: (url: string) => new Promise((resolve, reject) => { fetches.push({ url, resolve, reject }) }),
}

// Nuxt's `~~` alias is not known to bun; the texts are not under test.
mock.module('~~/i18n/zh-CN', () => ({ default: { cloudflare: {} } }))

let useCloudflareSetup: typeof import('../../app/composables/useCloudflareSetup').useCloudflareSetup
beforeAll(async () => {
  for (const [k, v] of Object.entries(stub)) { saved[k] = g[k]; g[k] = v }
  useCloudflareSetup = (await import('../../app/composables/useCloudflareSetup')).useCloudflareSetup
})
afterAll(() => { for (const k of Object.keys(stub)) g[k] = saved[k] })

const job = (state: SetupJob['state']): SetupJob => ({
  state, hostname: 'llm.example.com', zoneName: 'example.com', steps: [], created: { tunnel: null, dnsRecordId: null, dnsRestore: null },
  tunnelId: null, startedAt: 1, finishedAt: null,
})

// Versions as the server hands them out (see CloudflareSetup.view): one per distinct job, per process.
const BOOT = 1000
const rev = (seq: number, boot = BOOT): JobRev => ({ boot, seq })
const snapshot = (j: SetupJob | null, r: JobRev) => { live.state.value = { cloudflare: j, cloudflareRev: r } }
const fresh = () => { states.clear(); fetches = []; live.state.value = null; live.connected.value = true }

describe('useCloudflareSetup keeps the newest job from the live stream and the responses', () => {
  test('a slow GET that was answered "running" does not turn a newer live "done" back', async () => {
    fresh()
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    // The page reloaded while the run was going; the stream then delivers its end.
    snapshot(job('done'), rev(3))
    await nextTick()
    expect(cf.job.value?.state).toBe('done')
    // Only now the old request comes back, with what the server said before.
    fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running'), rev: rev(2) })
    await loading
    expect(cf.job.value?.state).toBe('done')
  })

  test('live also clears the job (dismiss / cleanup in another tab) and follows a new run', async () => {
    fresh()
    snapshot(job('failed'), rev(1))
    const cf = useCloudflareSetup()
    expect(cf.job.value?.state).toBe('failed')
    snapshot(null, rev(2))
    await nextTick()
    expect(cf.job.value).toBeNull()
    snapshot(job('running'), rev(3))
    await nextTick()
    expect(cf.job.value?.state).toBe('running')
  })

  test('before any snapshot the responses are the only source', async () => {
    fresh()
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    fetches[0]!.resolve({ hasToken: false, maskedToken: null, job: job('running'), rev: rev(1) })
    await loading
    expect(cf.job.value?.state).toBe('running')
  })

  for (const [name, latest] of [['done', job('done')], ['cleared', null]] as const) {
    test(`snapshot "${name}", then the stream drops, then an older response arrives: the snapshot stays`, async () => {
      fresh()
      const cf = useCloudflareSetup()
      const loading = cf.loadInfo() // asked while the run was going
      snapshot(latest, rev(5))
      await nextTick()
      live.connected.value = false
      fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running'), rev: rev(4) })
      await loading
      expect(cf.job.value).toEqual(latest)
    })
  }

  test('reconnect, newer snapshot, drop again, then the old response: still the newest', async () => {
    fresh()
    snapshot(job('running'), rev(1))
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    live.connected.value = false
    live.connected.value = true
    snapshot(job('failed'), rev(3))
    await nextTick()
    live.connected.value = false
    fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running'), rev: rev(2) })
    await loading
    expect(cf.job.value?.state).toBe('failed')
  })

  test('while the stream is down the results of apply / retry / cleanup / dismiss are shown; the reconnect snapshot wins again', async () => {
    fresh()
    snapshot(null, rev(1))
    const cf = useCloudflareSetup()
    live.connected.value = false // the stream broke, ordinary requests still work
    const applying = cf.apply()
    fetches[0]!.resolve({ job: job('failed'), rev: rev(4) })
    await applying
    expect(cf.job.value?.state).toBe('failed')
    const retrying = cf.jobAction('retry')
    fetches[1]!.resolve({ job: job('failed'), rev: rev(6) })
    await retrying
    expect(cf.job.value?.state).toBe('failed')
    const cleaning = cf.jobAction('cleanup')
    fetches[2]!.resolve({ job: null, rev: rev(7) })
    await cleaning
    expect(cf.job.value).toBeNull()
    // Reconnected: a newer snapshot shows a run another tab started; the GET in flight from before is older.
    const slow = cf.loadInfo()
    live.connected.value = true
    snapshot(job('running'), rev(8))
    await nextTick()
    fetches[3]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: null, rev: rev(7) })
    await slow
    expect(cf.job.value?.state).toBe('running')
  })

  test('a failed action changes nothing', async () => {
    fresh()
    snapshot(job('failed'), rev(2))
    const cf = useCloudflareSetup()
    live.connected.value = false
    const retrying = cf.jobAction('retry')
    fetches[0]!.reject(new Error('busy'))
    await retrying
    expect(cf.job.value?.state).toBe('failed')
  })

  test('a restarted server (new process, counting from 1 again) replaces the old job; a late answer of the old process does not', async () => {
    fresh()
    snapshot(job('running'), rev(9))
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    snapshot(null, rev(1, BOOT + 5000)) // the job lived in the old process only
    await nextTick()
    expect(cf.job.value).toBeNull()
    fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running'), rev: rev(10) })
    await loading
    expect(cf.job.value).toBeNull()
  })

  test('a restarted server whose clock went back is still followed through the stream', async () => {
    fresh()
    snapshot(job('done'), rev(9))
    const cf = useCloudflareSetup()
    snapshot(null, rev(1, BOOT - 60_000))
    await nextTick()
    expect(cf.job.value).toBeNull()
    const loading = cf.loadInfo() // and its responses are ordered within that process again
    fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running'), rev: rev(2, BOOT - 60_000) })
    await loading
    expect(cf.job.value?.state).toBe('running')
  })
})
