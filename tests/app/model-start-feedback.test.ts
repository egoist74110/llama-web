import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { computed, effectScope, ref, watch } from 'vue'
import t from '../../i18n/zh-CN'
import { readStartGuard } from '../../app/utils/memory-check'
import { LiveHub } from '../../server/core/live'
import { LaunchConfigError } from '../../server/core/launch'
import type { ActivityEvent, StateDoc } from '../../server/core/live'

function harness() {
  const scope = effectScope()
  const states = new Map<string, ReturnType<typeof ref>>()
  const live = { state: ref<StateDoc | null>(null), events: ref<ActivityEvent[]>([]) }
  const toasts: unknown[] = []
  const guards: unknown[] = []
  const requests: Array<{ url: string, resolve: (v?: unknown) => void, reject: (e: unknown) => void }> = []
  const useState = (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  }
  function load(file: string, name: string, deps: Record<string, unknown>) {
    const source = readFileSync(new URL(`../../app/composables/${file}.ts`, import.meta.url), 'utf8')
      .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
    return new Function(...Object.keys(deps), `${code}\nreturn ${name}()`)(...Object.values(deps))
  }
  const common = { computed, watch, useState, useLive: () => live, t, useStartGuard: () => ({ open: (g: unknown) => guards.push(g) }) }
  const feedback = load('useModelStartFeedback', 'useModelStartFeedback', common) as ReturnType<typeof import('../../app/composables/useModelStartFeedback').useModelStartFeedback>
  scope.run(() => feedback.follow())
  const actions = load('useModelActions', 'useModelActions', {
    ...common, useModelStartFeedback: () => feedback, useToast: () => ({ add: (v: unknown) => toasts.push(v) }),
    fmt: (s: string) => s, readStartGuard, useStartGuard: () => ({ open: (g: unknown) => guards.push(g) }),
    $fetch: (url: string) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  }) as ReturnType<typeof import('../../app/composables/useModelActions').useModelActions>
  live.state.value = {
    now: 1000,
    models: [{ id: 'm1', name: 'Model One', activeProfile: 'default', profiles: ['default', 'other'], hasMmproj: false, needsSetup: true, files: { model: 'main/model.gguf', mmproj: null, draft: null }, missing: [], instances: [] }],
    queue: [], llamacpp: { current: '', runtime: { state: 'idle' }, versions: [], rollback: null },
    tunnel: null, cloudflare: null, cloudflareRev: null, firstRun: false,
  } as unknown as StateDoc
  let id = 0
  function event(to: 'loading' | 'stopped' | 'failed' | 'ready', error: string | null = null, modelId = 'm1', profile = 'default') {
    live.events.value = [{ kind: 'state', id: ++id, at: 1000 + id, modelId, profile, from: 'loading', to, error }, ...live.events.value]
  }
  return { actions, feedback, live, requests, toasts, guards, event, close: () => scope.stop() }
}

describe('manual model start feedback', () => {
  test('an accepted start with no runtime opens a modal even though the scheduler removes the instance', async () => {
    const h = harness()
    try {
      const work = h.actions.start('m1')
      h.requests[0]!.resolve({ ok: true })
      await work
      // Use the real server error-to-SSE boundary, including the stopped precondition state.
      const hub = new LiveHub({ coalesceMs: 1, snapshot: () => ({ ...h.live.state.value!, scheduler: { models: [], queue: [] } }) })
      // Await the coalesced snapshot too, so this test leaves no deferred callback behind.
      let unsubscribe = () => {}
      const pushed = new Promise<void>(resolve => {
        unsubscribe = hub.subscribe(m => {
          if (m.type === 'activity') h.live.events.value = [m.event, ...h.live.events.value]
          if (m.type === 'snapshot') resolve()
        })
      })
      hub.onSchedulerEvent({ type: 'state', target: { modelId: 'm1', profile: 'default' }, from: 'loading', to: 'stopped', error: new LaunchConfigError('no-runtime', 'no current build') })
      // LiveHub unrefs its timer; keep one referenced timer while awaiting it under Bun's runner.
      await Promise.all([pushed, new Promise(resolve => setTimeout(resolve, 10))])
      unsubscribe()
      expect(h.feedback.notice.value).toMatchObject({ modelId: 'm1', profile: 'default', kind: 'no-runtime' })
      expect(h.live.state.value!.models[0]!.instances).toHaveLength(0)
      expect(h.toasts).toHaveLength(0)
    } finally { h.close() }
  })

  test('a load failure arriving before the HTTP acknowledgement is not lost or duplicated', async () => {
    const h = harness()
    try {
      const work = h.actions.retry('m1', 'other')
      h.event('failed', 'device-missing', 'm1', 'other')
      expect(h.feedback.notice.value?.kind).toBe('device-missing')
      h.requests[0]!.resolve({ ok: true })
      await work
      h.feedback.dismiss()
      h.live.events.value = [...h.live.events.value]
      expect(h.feedback.notice.value).toBeNull()
    } finally { h.close() }
  })

  test('an immediate HTTP rejection opens a modal with its concrete message and clears busy', async () => {
    const h = harness()
    try {
      const work = h.actions.start('m1')
      h.requests[0]!.reject({ data: { message: t.models.errors.profileNotFound } })
      expect(await work).toBeNull()
      expect(h.feedback.notice.value).toMatchObject({ kind: 'profile-missing', message: t.models.errors.profileNotFound })
      expect(h.actions.busy.value).toEqual({})
      expect(h.toasts).toHaveLength(0)
    } finally { h.close() }
  })

  test('old failures, other profiles and other clients do not open a modal', async () => {
    const h = harness()
    try {
      h.event('failed', 'timeout')
      const work = h.actions.start('m1')
      h.event('failed', 'oom', 'm2')
      h.event('failed', 'device-missing', 'm1', 'other')
      h.live.events.value = [...h.live.events.value]
      expect(h.feedback.notice.value).toBeNull()
      h.event('ready')
      h.requests[0]!.resolve({ ok: true })
      await work
      h.event('failed', 'timeout')
      expect(h.feedback.notice.value).toBeNull()
    } finally { h.close() }
  })

  test('a manual stop cancels pending feedback and retains normal stop error toasts', async () => {
    const h = harness()
    try {
      const start = h.actions.start('m1')
      h.requests[0]!.resolve({ ok: true })
      await start
      const stop = h.actions.stop('m1')
      h.event('failed', 'timeout')
      h.requests[1]!.reject({ message: 'stop error' })
      await stop
      expect(h.feedback.notice.value).toBeNull()
      expect(h.toasts).toHaveLength(1)
    } finally { h.close() }
  })

  test('first-setup feedback survives the model losing needsSetup', () => {
    const h = harness()
    try {
      const attempt = h.feedback.begin('m1')
      h.live.state.value = { ...h.live.state.value!, models: [{ ...h.live.state.value!.models[0]!, needsSetup: false }] }
      h.feedback.accepted(attempt)
      h.event('stopped', 'no-runtime')
      expect(h.feedback.notice.value?.kind).toBe('no-runtime')
    } finally { h.close() }
  })

  test('reconnect history is consumed once, and simultaneous failures are shown in order', () => {
    const h = harness()
    try {
      h.feedback.begin('m1')
      h.feedback.begin('m2', 'default')
      h.event('failed', 'oom')
      h.event('stopped', 'no-runtime', 'm2')
      expect(h.feedback.notice.value?.kind).toBe('oom')
      h.live.events.value = [...h.live.events.value]
      h.feedback.dismiss()
      expect(h.feedback.notice.value?.kind).toBe('no-runtime')
      h.feedback.dismiss()
      expect(h.feedback.notice.value).toBeNull()
    } finally { h.close() }
  })

  test('a retry ignores the old failed snapshot but catches a fresh failure after losing its event', async () => {
    const h = harness()
    try {
      const failure = { profile: 'default', state: 'failed' as const, since: 1000, error: 'timeout', failure: null, inflight: 0, progress: null }
      h.live.state.value!.models[0]!.instances = [failure]
      const work = h.actions.retry('m1')
      h.requests[0]!.resolve({ ok: true })
      await work
      expect(h.feedback.notice.value).toBeNull()
      h.live.state.value = { ...h.live.state.value!, models: [{ ...h.live.state.value!.models[0]!, instances: [{ ...failure, since: 2000, error: 'oom' }] }] }
      expect(h.feedback.notice.value?.kind).toBe('oom')
    } finally { h.close() }
  })

  test('an already-ready start finishes tracking and an enable HTTP failure uses the modal', async () => {
    const h = harness()
    try {
      h.live.state.value!.models[0]!.instances = [{ profile: 'default', state: 'ready', since: 1000, error: null, failure: null, inflight: 0, progress: null }]
      const work = h.actions.start('m1')
      h.requests[0]!.resolve({ ok: true })
      await work
      h.event('failed', 'timeout')
      expect(h.feedback.notice.value).toBeNull()
      const enable = h.actions.enable({ dirId: 'fixture', rel: 'missing.gguf' })
      h.requests[1]!.reject({ data: { message: 'File disappeared during scan' } })
      await enable
      expect(h.feedback.notice.value).toMatchObject({ name: 'missing.gguf', message: 'File disappeared during scan' })
      expect(h.toasts).toHaveLength(0)
    } finally { h.close() }
  })

  test('a superseded attempt cannot replace the newer outcome, and the busy guard coalesces duplicate starts', async () => {
    const h = harness()
    try {
      const old = h.feedback.begin('m1')
      const current = h.feedback.begin('m1', 'other')
      h.feedback.httpFailure({ message: 'old response' }, old)
      expect(h.feedback.notice.value).toBeNull()
      h.feedback.httpFailure({ message: 'current response' }, current)
      expect(h.feedback.notice.value?.message).toBe('current response')
      h.feedback.dismiss()
      const work = h.actions.start('m1')
      await h.actions.start('m1')
      expect(h.requests).toHaveLength(1)
      h.requests[0]!.resolve({ ok: true })
      await work
    } finally { h.close() }
  })

  test('a refused start (409 with a reason) opens the guard instead of a failure modal, and a confirmed one goes out with confirm', async () => {
    const h = harness()
    try {
      const work = h.actions.start('m1', 'other')
      h.requests[0]!.reject({ statusCode: 409, data: { statusCode: 409, message: 'x', data: { reason: 'risky', estimateMiB: 9000, availableMiB: 9500, pool: 'CUDA0' } } })
      await work
      expect(h.guards).toHaveLength(1)
      expect(h.guards[0]).toMatchObject({ modelId: 'm1', profile: 'other', name: 'Model One', action: 'start', guard: { reason: 'risky', estimateMiB: 9000 } })
      expect(h.feedback.notice.value).toBeNull()
      expect(h.toasts).toHaveLength(0)
      expect(h.actions.busy.value['start:m1']).toBeUndefined()
      // The user chose "start anyway": same call with the confirm mark.
      const again = h.actions.start('m1', 'other', true)
      expect(h.requests).toHaveLength(2)
      h.requests[1]!.resolve({ ok: true })
      await again
      expect(h.guards).toHaveLength(1)
    } finally { h.close() }
  })

  test('an ordinary HTTP error of a start still opens the failure modal', async () => {
    const h = harness()
    try {
      const work = h.actions.start('m1')
      h.requests[0]!.reject({ statusCode: 500, data: { statusCode: 500, message: 'boom' } })
      await work
      expect(h.guards).toHaveLength(0)
      expect(h.feedback.notice.value).toMatchObject({ modelId: 'm1', kind: 'unknown' })
    } finally { h.close() }
  })
})

describe('a start refused after it was accepted (CR-021)', () => {
  test('manual no-room / unconfirmed clears the pending attempt and opens the start dialog with the tier', async () => {
    const h = harness()
    const attempt = h.feedback.begin('m1', 'default')
    h.feedback.accepted(attempt)
    h.live.events.value = [{ kind: 'no-room', id: 50, at: Date.now(), modelId: 'm1', profile: 'default', reason: 'unconfirmed', tier: 'unknown', estimateMiB: 100, availableMiB: 90, pool: 'system', manual: true }, ...h.live.events.value] as never
    expect(h.guards).toMatchObject([{ modelId: 'm1', profile: 'default', action: 'start', guard: { reason: 'unknown', estimateMiB: 100 } }])
    expect(h.feedback.notice.value).toBeNull()
    h.close()
  })

  test('a request refusal (not manual) and old replayed events open nothing', () => {
    const h = harness()
    h.live.events.value = [
      { kind: 'no-room', id: 60, at: Date.now(), modelId: 'm1', profile: 'default', reason: 'memory', estimateMiB: 1, availableMiB: 1, pool: null, manual: false },
      { kind: 'no-room', id: 61, at: Date.now() - 120_000, modelId: 'm1', profile: 'default', reason: 'memory', estimateMiB: 1, availableMiB: 1, pool: null, manual: true },
    ] as never
    expect(h.guards).toEqual([])
    h.close()
  })
})
