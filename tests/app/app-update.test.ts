import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'

// Execute the real composable with local Nuxt dependencies, without process-wide module mocks.
function harness() {
  const states = new Map<string, ReturnType<typeof ref>>()
  const requests: Array<{ url: string, body: unknown, resolve: () => void }> = []
  const source = readFileSync(new URL('../../app/composables/useAppUpdate.ts', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const create = new Function('computed', 'useState', 'useLive', 'useToast', '$fetch', 't', `${code}\nreturn useAppUpdate()`)
  const actions = create(computed, (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  }, () => ({ state: ref(null) }), () => ({ add() {} }),
  (url: string, opts: { body?: unknown }) => new Promise<void>(resolve => { requests.push({ url, body: opts.body, resolve }) }),
  { appUpdate: {} }) as ReturnType<typeof import('../../app/composables/useAppUpdate').useAppUpdate>
  return { actions, requests }
}

test('a pending manual app check allows disabling automatic installation and cancelling its download', async () => {
  const { actions, requests } = harness()
  const check = actions.check()
  expect(actions.busy.value).toBe('check')
  const prefs = actions.setAutoUpdate(false)
  expect(requests[1]).toMatchObject({ url: '/api/app-update/prefs', body: { autoUpdate: false } })
  requests[1]!.resolve()
  await prefs
  expect(actions.busy.value).toBe('check')
  const cancel = actions.cancel()
  expect(requests[2]!.url).toBe('/api/app-update/cancel')
  requests[2]!.resolve()
  await cancel
  requests[0]!.resolve()
  await check
  expect(actions.busy.value).toBeNull()
})

test('concurrent update checks and duplicate preference writes are still coalesced', async () => {
  const { actions, requests } = harness()
  const check = actions.check()
  await actions.check()
  await actions.download()
  expect(requests).toHaveLength(1)
  const prefs = actions.setAutoUpdate(false)
  await actions.setAutoUpdate(false)
  expect(requests).toHaveLength(2)
  requests[1]!.resolve()
  await prefs
  requests[0]!.resolve()
  await check
  expect(actions.busy.value).toBeNull()
})
