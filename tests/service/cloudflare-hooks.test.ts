import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CfClient, CloudflareSetup, planSetup, type SetupInput } from '../../server/core/cloudflare'
import { defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION, type Settings } from '../../server/core/config'
import { defaultSecrets, normalizeSecrets, SECRETS_MIGRATIONS, SECRETS_VERSION, type SecretsDoc } from '../../server/core/keys'
import { JsonStore } from '../../server/core/store'
import { Hold } from '../../server/core/write-pair'
import { cloudflareHooks } from '../../server/service/cloudflare-hooks'
import { openStore } from '../../server/service/context'
import { FakeCloudflare, GOOD } from '../fixtures/fake-cloudflare'

// The production wiring of the one-click setup (the same function context.ts uses) against real
// settings.json / secrets.json stores in a temporary data directory.
const BASE = 'https://cf.test/client/v4'
const client = (cf: FakeCloudflare) => new CfClient(GOOD, cf.fetch, BASE)
const input = (o: Partial<SetupInput> = {}): SetupInput => ({ zoneId: 'zone-a', subdomain: 'llm', tunnelName: 'llama-web', port: 8080, ...o })

let dir = ''
let stores: Array<JsonStore<Settings> | JsonStore<SecretsDoc>> = []
let applied = 0

function wire() {
  const settingsStore = new JsonStore<Settings>({
    dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS,
  })
  const secretsStore = new JsonStore<SecretsDoc>({
    dataDir: dir, name: 'secrets.json', version: SECRETS_VERSION, defaults: defaultSecrets, validate: normalizeSecrets, migrations: SECRETS_MIGRATIONS,
  })
  stores = [settingsStore, secretsStore]
  // As in context.ts: store reactions are muted while the pair of writes is in flight.
  const hold = new Hold()
  const settingsRef = openStore(settingsStore, defaultSettings, () => { if (!hold.held) applied++ })
  const secretsRef = openStore(secretsStore, defaultSecrets, () => { if (!hold.held) applied++ })
  return { settingsStore, secretsStore, settingsRef, secretsRef, hold }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-cf-hooks-'))
  applied = 0
})
afterEach(() => {
  for (const s of stores) s.close()
  stores = []
  rmSync(dir, { recursive: true, force: true })
})

describe('cloudflareHooks (context wiring) with real stores', () => {
  test('a port edit on disk that the watcher has not delivered yet stops the run; the edit is kept', async () => {
    const w = wire()
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web', ingress: [{ service: 'http_status:404' }] })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    const s = new CloudflareSetup(cloudflareHooks({ ...w, applyPublic: () => { applied++ } }))
    cf.failures.push({ method: 'PUT', path: /configurations$/, status: 500 })
    expect((await s.apply(client(cf), inp, p.fingerprint)).state).toBe('failed')
    // Hand edit; the retry starts before the file watcher (debounced) has read it.
    const onDisk = JSON.parse(readFileSync(w.settingsStore.file, 'utf8')) as Settings
    writeFileSync(w.settingsStore.file, JSON.stringify({ ...onDisk, public: { ...onDisk.public, port: 8081 } }))
    const again = await s.retry(client(cf))
    expect(again.steps[1]!.error).toEqual({ code: 'changed', detail: 'port-changed' })
    expect(t.ingress!.length).toBe(1) // the tunnel was not pointed at the old port
    expect(w.secretsRef.get().tunnelToken).toBe('')
    expect(w.settingsRef.get().public.port).toBe(8081)
  })

  test('success saves the token and switches hosting on, then reconciles once with both files written', async () => {
    const w = wire()
    // Was using the quick tunnel: the one-click setup switches back to the own tunnel.
    w.settingsRef.update((d) => { d.public.tunnelMode = 'quick' })
    const cf = new FakeCloudflare()
    const inp = input()
    const p = await planSetup(client(cf), inp)
    const seen: Array<{ token: boolean, hosting: boolean }> = []
    // The reconciliation runs once, after both files were written (the stores' own reactions are muted meanwhile).
    const applyPublic = () => { seen.push({ token: w.secretsRef.get().tunnelToken !== '', hosting: w.settingsRef.get().public.tunnelEnabled }) }
    const s = new CloudflareSetup(cloudflareHooks({ ...w, applyPublic }))
    expect((await s.apply(client(cf), inp, p.fingerprint)).state).toBe('done')
    expect(w.secretsRef.get().tunnelToken).not.toBe('')
    expect(w.settingsRef.get().public).toMatchObject({ enabled: true, tunnelEnabled: true, tunnelMode: 'token', domain: 'llm.example.com', port: 8080 })
    // Both files really written.
    expect((JSON.parse(readFileSync(w.secretsStore.file, 'utf8')) as SecretsDoc).tunnelToken).toBe(w.secretsRef.get().tunnelToken)
    expect(seen).toEqual([{ token: true, hosting: true }])
  })

  test('when the settings write fails the token is put back and the state is still reconciled', async () => {
    const w = wire()
    const cf = new FakeCloudflare()
    const inp = input()
    const p = await planSetup(client(cf), inp)
    let reconciled = 0
    const settingsRef = { ...w.settingsRef, update: () => { throw new Error('disk full') } }
    const s = new CloudflareSetup(cloudflareHooks({ ...w, settingsRef, applyPublic: () => { reconciled++ } }))
    const job = await s.apply(client(cf), inp, p.fingerprint)
    expect(job.state).toBe('failed')
    expect(job.steps.find(x => x.state === 'failed')!.id).toBe('save')
    expect(w.secretsRef.get().tunnelToken).toBe('')
    expect((JSON.parse(readFileSync(w.secretsStore.file, 'utf8')) as SecretsDoc).tunnelToken).toBe('')
    expect(reconciled).toBe(1)
  })
})
