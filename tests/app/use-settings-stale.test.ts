// An older settings response must not overwrite a newer language or document (stage 11 review CR-002).
// Every copy of the settings (GET, save response, live snapshot) carries the server's `rev`; the page drops
// anything older than what it applied. The composable reads Nuxt auto-imports, so the globals it needs are stubbed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ref } from 'vue'
import { acceptSettingsRev, applyUiLocale, getUiLocale, resetSettingsRev, setUiLocale } from '../../app/composables/useLocale'
import { useSettings } from '../../app/composables/useSettings'
import { dictionaries } from '../../i18n/messages'

const g = globalThis as any
const states = new Map<string, any>()
let pending: Array<(v: unknown) => void> = []
let calls: string[] = []

beforeEach(() => {
  states.clear()
  pending = []
  calls = []
  resetSettingsRev()
  g.useState = (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) }
  g.useToast = () => ({ add() {} })
  // Each request waits until the test answers it.
  g.$fetch = (_url: string, opts?: { method?: string }) => new Promise((resolve) => { calls.push(opts?.method ?? 'GET'); pending.push(resolve) })
})
afterEach(() => {
  applyUiLocale({ locale: 'zh-CN' })
  delete g.useState; delete g.useToast; delete g.$fetch
})

const docOf = (locale: 'zh-CN' | 'en', rev: number, boot = 1) => ({ rev, boot, ui: { locale } })
const tick = () => new Promise(r => setTimeout(r, 0))
/** What useLive does with a snapshot. */
const snapshot = (locale: 'zh-CN' | 'en', rev: number, boot = 1) => { if (acceptSettingsRev(rev, boot)) setUiLocale(locale) }

test('an old GET that lands after a save and the new snapshot is dropped and read again', async () => {
  const { load, save, doc } = useSettings()
  const loading = load() // GET #1, will answer in the old language
  const saving = save('ui', { ui: { locale: 'en' } })
  pending[1]!(docOf('en', 2)) // POST answers
  expect(await saving).toBe(true)
  snapshot('en', 2)
  pending[0]!(docOf('zh-CN', 1)) // the old GET finally lands
  await tick()
  expect(getUiLocale()).toBe('en')
  expect(doc.value?.ui.locale).toBe('en')
  pending[2]!(docOf('en', 2)) // the re-read
  await loading
  expect(calls).toEqual(['GET', 'POST', 'GET'])
  expect(getUiLocale()).toBe('en')
  expect(doc.value?.ui.locale).toBe('en')
})

test('a load nobody overtook is applied as before', async () => {
  const { load, doc, loadError } = useSettings()
  const loading = load()
  pending[0]!(docOf('en', 5))
  await loading
  expect(getUiLocale()).toBe('en')
  expect(doc.value?.ui.locale).toBe('en')
  expect(loadError.value).toBe('')
})

test('a save answer that lands after another window saved does not roll back the document or language', async () => {
  const { save, doc } = useSettings()
  const saving = save('ui', { ui: { locale: 'zh-CN' } }) // this window's save, answer is slow
  snapshot('en', 7) // another window saved later; its snapshot already arrived
  expect(getUiLocale()).toBe('en')
  pending[0]!(docOf('zh-CN', 6)) // the old answer lands
  expect(await saving).toBe(true) // the save itself did succeed
  await tick()
  expect(getUiLocale()).toBe('en')
  expect(doc.value).toBeNull() // not overwritten with the old copy
  expect(calls).toEqual(['POST', 'GET']) // the current document is fetched instead
  pending[1]!(docOf('en', 7))
  await tick()
  expect(doc.value?.ui.locale).toBe('en')
  expect(getUiLocale()).toBe('en')
})

test('a snapshot built before this window saved does not switch the language back', async () => {
  const { save } = useSettings()
  const saving = save('ui', { ui: { locale: 'en' } })
  pending[0]!(docOf('en', 4))
  await saving
  snapshot('zh-CN', 3) // older snapshot, on its way before the save
  expect(getUiLocale()).toBe('en')
  snapshot('en', 4)
  expect(getUiLocale()).toBe('en')
})

test('a load whose every answer is stale ends with a visible error', async () => {
  acceptSettingsRev(10, 1) // the page already applied a newer copy
  const { load, doc, loadError } = useSettings()
  const loading = load()
  for (let i = 0; i < 3; i++) {
    await tick()
    pending[i]!(docOf('zh-CN', 9))
  }
  await loading
  expect(calls).toEqual(['GET', 'GET', 'GET'])
  expect(doc.value).toBeNull()
  expect(loadError.value).toBe(dictionaries['zh-CN'].settings.loadStale)
})

test('a restarted server (higher boot) is accepted even when its rev is lower', async () => {
  expect(acceptSettingsRev(1000, 3)).toBe(true)
  const { load, doc, loadError } = useSettings()
  const loading = load()
  pending[0]!(docOf('en', 1, 4))
  await loading
  expect(doc.value?.ui.locale).toBe('en')
  expect(loadError.value).toBe('')
  expect(acceptSettingsRev(2, 4)).toBe(true) // a snapshot of the new process
  expect(acceptSettingsRev(1, 4)).toBe(false) // same process, older rev: dropped
  expect(acceptSettingsRev(5000, 3)).toBe(false) // the old process answering late
})

test('a new-boot snapshot first and an unseen older-boot GET later: the old one is dropped, the new one keeps working', async () => {
  const { load, doc, loadError } = useSettings()
  const loading = load() // GET sent to the old server
  snapshot('en', 1, 8) // the restarted server's snapshot arrives first
  expect(getUiLocale()).toBe('en')
  pending[0]!(docOf('zh-CN', 100, 7)) // the old server's answer lands late
  await tick()
  expect(getUiLocale()).toBe('en')
  expect(doc.value).toBeNull()
  pending[1]!(docOf('en', 1, 8)) // the re-read hits the new server
  await loading
  expect(doc.value?.ui.locale).toBe('en')
  expect(loadError.value).toBe('')
  snapshot('zh-CN', 2, 8) // and its next change still applies
  expect(getUiLocale()).toBe('zh-CN')
})

test('a copy without a boot is applied but does not move the remembered version', () => {
  expect(acceptSettingsRev(1, 8)).toBe(true)
  expect(acceptSettingsRev(100)).toBe(true) // old server: no boot
  expect(acceptSettingsRev(2, 8)).toBe(true) // the real one is not locked out
  expect(acceptSettingsRev(undefined, 8)).toBe(true)
})
