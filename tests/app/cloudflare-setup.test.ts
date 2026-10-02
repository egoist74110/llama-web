import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { SetupJob } from '../../server/core/cloudflare'

// The composable relies on Nuxt auto-imports; give it the few it uses.
const live = { state: shallowRef<{ cloudflare?: SetupJob | null } | null>(null) }
const states = new Map<string, ReturnType<typeof ref>>()
let fetches: Array<{ url: string, resolve: (v: unknown) => void }> = []
const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
const stub: Record<string, unknown> = {
  useToast: () => ({ add() {} }),
  useLive: () => live,
  useState: (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) },
  computed, watch,
  $fetch: (url: string) => new Promise((resolve) => { fetches.push({ url, resolve }) }),
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

describe('useCloudflareSetup follows the live stream', () => {
  test('a slow GET that was answered "running" does not turn a newer live "done" back', async () => {
    states.clear(); fetches = []; live.state.value = null
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    // The page reloaded while the run was going; the stream then delivers its end.
    live.state.value = { cloudflare: job('done') }
    await nextTick()
    expect(cf.job.value?.state).toBe('done')
    // Only now the old request comes back, with what the server said before.
    fetches[0]!.resolve({ hasToken: true, maskedToken: 'abcd…wxyz', job: job('running') })
    await loading
    expect(cf.job.value?.state).toBe('done')
  })

  test('live also clears the job (dismiss / cleanup in another tab) and follows a new run', async () => {
    states.clear(); fetches = []
    live.state.value = { cloudflare: job('failed') }
    const cf = useCloudflareSetup()
    expect(cf.job.value?.state).toBe('failed')
    live.state.value = { cloudflare: null }
    await nextTick()
    expect(cf.job.value).toBeNull()
    live.state.value = { cloudflare: job('running') }
    await nextTick()
    expect(cf.job.value?.state).toBe('running')
  })

  test('before any snapshot the responses are the only source', async () => {
    states.clear(); fetches = []; live.state.value = null
    const cf = useCloudflareSetup()
    const loading = cf.loadInfo()
    fetches[0]!.resolve({ hasToken: false, maskedToken: null, job: job('running') })
    await loading
    expect(cf.job.value?.state).toBe('running')
  })
})
