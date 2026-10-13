// useMemoryChecks: a forced check that arrives while the same key is on its way is not swallowed (CR-014): the old answer
// is not published as current, and the check is asked again once more.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { effectScope, nextTick, ref, watch } from 'vue'
import { ONLINE_STATES, onlineSignature } from '../../app/utils/memory-check'

function harness() {
  const states = new Map<string, ReturnType<typeof ref>>()
  const useState = (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  }
  const state = ref<unknown>({ models: [{ id: 'a', instances: [{ profile: 'p', state: 'ready' }] }] })
  const calls: Array<{ resolve: (v: unknown) => void, body: unknown }> = []
  const $fetch = (_url: string, opts?: { body?: unknown }) => new Promise(resolve => calls.push({ resolve, body: opts?.body }))
  const source = readFileSync(new URL('../../app/composables/useMemoryChecks.ts', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const deps = { watch, useState, useLive: () => ({ state }), $fetch, ONLINE_STATES, onlineSignature }
  const checks = new Function(...Object.keys(deps), `${code}\nreturn useMemoryChecks()`)(...Object.values(deps)) as ReturnType<typeof import('../../app/composables/useMemoryChecks').useMemoryChecks>
  return { checks, state, calls }
}

test('the online set changes while a check is on its way: the stale answer is dropped and the check is asked again', async () => {
  const h = harness()
  const scope = effectScope()
  scope.run(() => h.checks.followModel(() => 'a', () => 'p'))
  await nextTick()
  expect(h.calls).toHaveLength(1)
  h.state.value = { models: [{ id: 'a', instances: [{ profile: 'p', state: 'ready' }] }, { id: 'b', instances: [{ profile: 'p', state: 'ready' }] }] }
  await nextTick()
  expect(h.calls).toHaveLength(1) // still the first one: nothing new is started while it is on its way
  h.calls[0]!.resolve({ tier: 'ok' })
  await new Promise(r => setTimeout(r, 10))
  expect(h.checks.get('a', 'p')).toBeNull() // the old `ok` is not published
  expect(h.calls).toHaveLength(2)
  h.calls[1]!.resolve({ tier: 'risky' })
  await new Promise(r => setTimeout(r, 10))
  expect(h.checks.get('a', 'p')).toMatchObject({ tier: 'risky' })
  scope.stop()
})

test('without a change in between, the answer is published as before', async () => {
  const h = harness()
  const scope = effectScope()
  scope.run(() => h.checks.followModel(() => 'a', () => 'p'))
  await nextTick()
  h.calls[0]!.resolve({ tier: 'ok' })
  await new Promise(r => setTimeout(r, 10))
  expect(h.checks.get('a', 'p')).toMatchObject({ tier: 'ok' })
  expect(h.calls).toHaveLength(1)
  scope.stop()
})

test('a forced check asks the server for fresh device readings, a plain one does not (CR-023)', async () => {
  const h = harness()
  h.checks.request('a', 'p')
  h.checks.request('b', 'p', true)
  await new Promise(r => setTimeout(r, 10))
  expect(h.calls[0]!.body).toEqual({ profile: 'p' })
  h.calls[0]!.resolve({ tier: 'ok' })
  await new Promise(r => setTimeout(r, 10))
  expect(h.calls[1]!.body).toEqual({ profile: 'p', fresh: true })
})

test('the save button reads the memory fresh before it decides whether to ask (CR-023)', () => {
  const source = readFileSync(new URL('../../app/components/ProfileForm.vue', import.meta.url), 'utf8')
  const save = source.slice(source.indexOf('async function trySave'), source.indexOf('function confirmSave'))
  expect(save).toContain('await refreshCheck(true)')
  // and the form's own request carries the flag to the server
  expect(source).toMatch(/\.\.\.\(fresh \? \{ fresh: true \} : \{\}\)/)
})
