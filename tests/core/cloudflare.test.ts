import { describe, expect, test } from 'bun:test'
import {
  CfClient, CfError, cleanApiToken, cleanSubdomain, CloudflareSetup, inspect, maskApiToken, mergeIngress, planSetup,
  type SetupInput, type SetupJob,
} from '../../server/core/cloudflare'
import { ACCOUNT, ACCOUNT_TOKEN, FakeCloudflare, GOOD } from '../fixtures/fake-cloudflare'

const BASE = 'https://cf.test/client/v4'
const client = (cf: FakeCloudflare, token = GOOD) => new CfClient(token, cf.fetch, BASE)
const input = (o: Partial<SetupInput> = {}): SetupInput => ({ zoneId: 'zone-a', subdomain: 'llm', tunnelName: 'llama-web', port: 8080, ...o })

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return e instanceof CfError ? e.code : `other:${(e as Error).message}` }
  return 'none'
}

function setup(cf: FakeCloudflare) {
  const saved: { tunnelToken: string, hostname: string }[] = []
  const s = new CloudflareSetup({ onSaved: (r) => { saved.push(r) } })
  return { s, saved }
}

const stepStates = (j: SetupJob) => j.steps.map(s => `${s.id}:${s.state}`).join(' ')

describe('token and helpers', () => {
  test('API token is trimmed, "Bearer " removed, junk refused; mask hides the middle', () => {
    expect(cleanApiToken(`  Bearer ${GOOD}\n`)).toBe(GOOD)
    for (const bad of ['', 'short', 'has space in it but is long enough 1234', 42, null]) expect(() => cleanApiToken(bad)).toThrow(CfError)
    expect(maskApiToken(GOOD)).toBe(`${GOOD.slice(0, 4)}…${GOOD.slice(-4)}`)
  })

  test('subdomain: lower-cased labels, multi-level allowed, bad ones refused', () => {
    expect(cleanSubdomain(' LLM ')).toBe('llm')
    expect(cleanSubdomain('a.b-c')).toBe('a.b-c')
    for (const bad of ['', '-x', 'x-', 'a..b', 'a_b', 'https://x', 'x'.repeat(64)]) expect(() => cleanSubdomain(bad)).toThrow(CfError)
  })

  test('ingress merge replaces our rule, keeps others and the catch-all last', () => {
    const m = mergeIngress([
      { hostname: 'other.example.com', service: 'http://127.0.0.1:3000' },
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:18090', originRequest: { noTLSVerify: true } },
      { service: 'http_status:404' },
    ], 'llm.example.com', 'http://127.0.0.1:8080')
    // The rule is replaced where it is.
    expect(m.rules).toEqual([
      { hostname: 'other.example.com', service: 'http://127.0.0.1:3000' },
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:8080', originRequest: { noTLSVerify: true } },
      { service: 'http_status:404' },
    ])
    expect(m.change).toEqual({ hostname: 'llm.example.com', from: 'http://127.0.0.1:18090', to: 'http://127.0.0.1:8080' })
    expect(m.others).toEqual(['other.example.com'])
    expect(mergeIngress(null, 'a.example.com', 's').rules).toEqual([{ hostname: 'a.example.com', service: 's' }, { service: 'http_status:404' }])
  })

  test('a new rule never shadows a rule that matched before (path rules, wildcards, catch-all)', () => {
    const host = 'llm.example.com'
    // The hostname's own path rule keeps priority; the new rule comes right after it.
    const withPath = mergeIngress([
      { hostname: host, path: '/admin/.*', service: 'http://127.0.0.1:3000' },
      { service: 'http_status:404' },
    ], host, 's')
    expect(withPath.rules.map(r => `${r.hostname ?? '*'}${r.path ?? ''}`)).toEqual([`${host}/admin/.*`, host, '*'])
    expect(withPath.others).toEqual([`${host}/admin/.*`])
    // A wildcard that already catches the hostname stays behind the new, more specific rule...
    const wild = mergeIngress([
      { hostname: 'x.example.com', service: 'a' },
      { hostname: '*.example.com', service: 'b' },
      { service: 'http_status:404' },
    ], host, 's')
    expect(wild.rules.map(r => r.hostname ?? '*')).toEqual(['x.example.com', host, '*.example.com', '*'])
    // ...but this hostname's path rule sitting behind that wildcard is not shadowed by the new rule.
    const late = mergeIngress([
      { hostname: '*.example.com', service: 'b' },
      { hostname: host, path: '/p', service: 'c' },
      { service: 'http_status:404' },
    ], host, 's')
    expect(late.rules.map(r => `${r.hostname ?? '*'}${r.path ?? ''}`)).toEqual(['*.example.com', `${host}/p`, host, '*'])
    // A different wildcard does not matter; the new rule goes in front of the catch-all.
    const other = mergeIngress([{ hostname: '*.other.example', service: 'b' }, { service: 'http_status:404' }], host, 's')
    expect(other.rules.map(r => r.hostname ?? '*')).toEqual(['*.other.example', host, '*'])
  })
})

describe('inspect', () => {
  test('lists zones; only active zones with DNS + tunnel access are usable', async () => {
    const cf = new FakeCloudflare()
    const r = await inspect(client(cf))
    expect(r.missing).toEqual([])
    expect(r.zones.map(z => [z.name, z.usable, z.reason])).toEqual([['example.com', true, null], ['pending.example', false, 'inactive']])
    expect(r.zones[0]!.accountId).toBe(ACCOUNT)
    expect(cf.writes()).toEqual([])
  })

  test('account-owned tokens are verified through the account endpoint', async () => {
    const cf = new FakeCloudflare()
    const r = await inspect(client(cf, ACCOUNT_TOKEN))
    expect(r.zones.some(z => z.usable)).toBe(true)
  })

  test('a bad token is bad-token; the token never shows up in the error', async () => {
    const cf = new FakeCloudflare()
    const tok = 'not-a-real-token-0123456789-abcdefgh'
    try {
      await inspect(client(cf, tok))
      throw new Error('should fail')
    } catch (e) {
      expect((e as CfError).code).toBe('bad-token')
      expect(String(e)).not.toContain(tok)
    }
  })

  test('missing permissions are named', async () => {
    for (const [perm, expected] of [['zone', ['zone']], ['dns', ['dns']], ['tunnel', ['tunnel']]] as const) {
      const cf = new FakeCloudflare()
      cf.perms.delete(perm)
      const r = await inspect(client(cf))
      expect(r.missing).toEqual([...expected])
      if (perm !== 'zone') expect(r.zones.find(z => z.name === 'example.com')!.reason).toBe(perm === 'dns' ? 'no-dns' : 'no-tunnel')
    }
  })

  test('network failure is network', async () => {
    const cf = new FakeCloudflare()
    cf.failures.push({ method: 'GET', path: /^\/user\/tokens\/verify$/, status: 0 })
    expect(await codeOf(inspect(client(cf)))).toBe('network')
  })
})

describe('plan', () => {
  test('clean account: create tunnel + create CNAME, ready, nothing written', async () => {
    const cf = new FakeCloudflare()
    const p = await planSetup(client(cf), input())
    expect(p.hostname).toBe('llm.example.com')
    expect(p.tunnel).toEqual({ kind: 'create', name: 'llama-web' })
    expect(p.dns).toEqual({ kind: 'create' })
    expect(p.ingress!.change).toEqual({ hostname: 'llm.example.com', from: null, to: 'http://127.0.0.1:8080' })
    expect(p.ready).toBe(true)
    expect(cf.writes()).toEqual([])
  })

  test('same-name tunnel: must choose reuse; create is not offered', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web' })
    const p = await planSetup(client(cf), input())
    expect(p.tunnelChoices.map(c => c.value)).toEqual([`reuse:${t.id}`])
    expect(p.needs).toEqual(['tunnel'])
    expect(p.ready).toBe(false)
    const p2 = await planSetup(client(cf), input({ tunnel: `reuse:${t.id}` }))
    expect(p2.ready).toBe(true)
    expect(await codeOf(planSetup(client(cf), input({ tunnel: 'create' })))).toBe('bad-choice')
  })

  test('DNS points at another tunnel: offered as reuse, or create + re-point (needs confirmation)', async () => {
    const cf = new FakeCloudflare()
    const other = cf.addTunnel({ name: 'old', ingress: [{ hostname: 'llm.example.com', service: 'http://127.0.0.1:18090' }, { hostname: 'nas.example.com', service: 'http://127.0.0.1:5000' }, { service: 'http_status:404' }], connections: [{}] })
    cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${other.id}.cfargotunnel.com`, proxied: true })
    const p = await planSetup(client(cf), input())
    expect(p.tunnelChoices.map(c => c.value)).toEqual(['create', `reuse:${other.id}`])
    expect(p.needs).toEqual(['tunnel'])

    const reuse = await planSetup(client(cf), input({ tunnel: `reuse:${other.id}` }))
    expect(reuse.dns!.kind).toBe('keep')
    expect(reuse.ingress).toEqual({ change: { hostname: 'llm.example.com', from: 'http://127.0.0.1:18090', to: 'http://127.0.0.1:8080' }, others: ['nas.example.com'] })
    expect(reuse.warnings).toEqual(['tunnel-busy', 'other-hosts'])
    expect(reuse.ready).toBe(true)

    const create = await planSetup(client(cf), input({ tunnel: 'create' }))
    expect(create.dns).toMatchObject({ kind: 'update', fromTunnel: 'old' })
    expect(create.needs).toEqual(['dns'])
    expect((await planSetup(client(cf), input({ tunnel: 'create', dns: 'repoint' }))).ready).toBe(true)
  })

  test('A / AAAA records (or several records) on the hostname block the setup', async () => {
    const cf = new FakeCloudflare()
    cf.addRecord({ type: 'A', name: 'llm.example.com', content: '192.0.2.1', proxied: false })
    const p = await planSetup(client(cf), input())
    expect(p.dns!.kind).toBe('blocked')
    expect(p.ready).toBe(false)
  })

  test('inactive zone and unknown zone are refused', async () => {
    const cf = new FakeCloudflare()
    expect(await codeOf(planSetup(client(cf), input({ zoneId: 'zone-p' })))).toBe('zone-inactive')
    expect(await codeOf(planSetup(client(cf), input({ zoneId: 'nope' })))).toBe('no-zone')
    expect(await codeOf(planSetup(client(cf), input({ subdomain: 'a b' })))).toBe('bad-subdomain')
    expect(await codeOf(planSetup(client(cf), input({ tunnelName: '' })))).toBe('bad-tunnel-name')
  })
})

describe('apply', () => {
  test('success: tunnel, ingress, CNAME (proxied), token saved', async () => {
    const cf = new FakeCloudflare()
    const { s, saved } = setup(cf)
    const p = await planSetup(client(cf), input())
    const job = await s.apply(client(cf), input(), p.fingerprint)
    expect(job.state).toBe('done')
    expect(stepStates(job)).toBe('tunnel:done ingress:done dns:done token:done save:done')
    const t = cf.tunnels.find(t => t.name === 'llama-web')!
    expect(t.ingress).toEqual([{ hostname: 'llm.example.com', service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }])
    expect(cf.records).toMatchObject([{ type: 'CNAME', name: 'llm.example.com', content: `${t.id}.cfargotunnel.com`, proxied: true }])
    expect(saved).toEqual([{ tunnelToken: t.token, hostname: 'llm.example.com' }])
    // No secret in the job the page sees.
    expect(JSON.stringify(s.status())).not.toContain(t.token)
    expect(JSON.stringify(s.status())).not.toContain(GOOD)
    // The API token only travels in the Authorization header.
    expect(cf.calls.every(c => c.auth === `Bearer ${GOOD}` && !JSON.stringify(c.body ?? '').includes(GOOD) && !c.path.includes(GOOD))).toBe(true)
  })

  test('token not in the create response: fetched from the token endpoint', async () => {
    const cf = new FakeCloudflare()
    cf.tokenInCreate = false
    const { s, saved } = setup(cf)
    const p = await planSetup(client(cf), input())
    await s.apply(client(cf), input(), p.fingerprint)
    expect(saved[0]!.tunnelToken).toBe(cf.tunnels[0]!.token)
    expect(cf.calls.some(c => c.path.endsWith('/token'))).toBe(true)
  })

  test('reuse + keep: only the ingress is written, other hostnames stay', async () => {
    const cf = new FakeCloudflare()
    const other = cf.addTunnel({ name: 'old', ingress: [{ hostname: 'llm.example.com', service: 'http://127.0.0.1:18090' }, { hostname: 'nas.example.com', service: 'http://127.0.0.1:5000' }, { service: 'http_status:404' }] })
    cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${other.id}.cfargotunnel.com`, proxied: true })
    const { s, saved } = setup(cf)
    const inp = input({ tunnel: `reuse:${other.id}` })
    const p = await planSetup(client(cf), inp)
    const job = await s.apply(client(cf), inp, p.fingerprint)
    expect(stepStates(job)).toBe('tunnel:skipped ingress:done dns:skipped token:done save:done')
    expect(cf.writes()).toEqual([`PUT /accounts/${ACCOUNT}/cfd_tunnel/${other.id}/configurations`])
    expect(other.ingress).toEqual([
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'nas.example.com', service: 'http://127.0.0.1:5000' },
      { service: 'http_status:404' },
    ])
    expect(saved[0]!.tunnelToken).toBe(other.token)
  })

  test('create + re-point: the existing CNAME is updated, not deleted', async () => {
    const cf = new FakeCloudflare()
    const other = cf.addTunnel({ name: 'old' })
    const rec = cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${other.id}.cfargotunnel.com`, proxied: true })
    const { s } = setup(cf)
    const inp = input({ tunnel: 'create', dns: 'repoint' })
    const p = await planSetup(client(cf), inp)
    await s.apply(client(cf), inp, p.fingerprint)
    const t = cf.tunnels.find(t => t.name === 'llama-web')!
    expect(cf.records).toHaveLength(1)
    expect(cf.records[0]!.id).toBe(rec.id)
    expect(cf.records[0]!.content).toBe(`${t.id}.cfargotunnel.com`)
    expect(other.deleted_at).toBeNull()
  })

  test('refused when undecided, blocked, or the account changed after the preview', async () => {
    const cf = new FakeCloudflare()
    const { s } = setup(cf)
    const p = await planSetup(client(cf), input())
    cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: 'elsewhere.example.net', proxied: true })
    expect(await codeOf(s.apply(client(cf), input(), p.fingerprint))).toBe('changed')
    const p2 = await planSetup(client(cf), input())
    expect(await codeOf(s.apply(client(cf), input(), p2.fingerprint))).toBe('need-choice')
    expect(cf.writes()).toEqual([])
    expect(s.status()).toBeNull()
  })

  test('a connector count change alone does not invalidate the preview', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web' })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    t.connections.push({}, {})
    const { s } = setup(cf)
    expect((await s.apply(client(cf), inp, p.fingerprint)).state).toBe('done')
  })

  test('mid-way failure stops, retry continues from the failed step without creating twice', async () => {
    const cf = new FakeCloudflare()
    const { s, saved } = setup(cf)
    const p = await planSetup(client(cf), input())
    cf.failures.push({ method: 'POST', path: /dns_records$/, status: 500 })
    const job = await s.apply(client(cf), input(), p.fingerprint)
    expect(job.state).toBe('failed')
    expect(stepStates(job)).toBe('tunnel:done ingress:done dns:failed token:pending save:pending')
    expect(job.steps[2]!.error!.code).toBe('api')
    expect(job.created.tunnel!.name).toBe('llama-web')
    expect(saved).toEqual([])
    // A new apply is refused while a failed run is open.
    expect(await codeOf(s.apply(client(cf), input(), p.fingerprint))).toBe('busy')

    const again = await s.retry(client(cf))
    expect(again.state).toBe('done')
    expect(cf.tunnels.filter(t => t.name === 'llama-web')).toHaveLength(1)
    expect(cf.records).toHaveLength(1)
    expect(saved).toHaveLength(1)
  })

  test('missing write permission is reported as forbidden with the permission', async () => {
    const cf = new FakeCloudflare()
    const { s } = setup(cf)
    const p = await planSetup(client(cf), input())
    cf.failures.push({ method: 'PUT', path: /configurations$/, status: 403, code: 10000 })
    const job = await s.apply(client(cf), input(), p.fingerprint)
    expect(job.steps[1]!.error).toEqual({ code: 'forbidden', detail: 'tunnel' })
  })

  test('cleanup deletes exactly what the failed run created', async () => {
    const cf = new FakeCloudflare()
    const keep = cf.addTunnel({ name: 'someone-else' })
    const { s, saved } = setup(cf)
    const p = await planSetup(client(cf), input())
    cf.failures.push({ method: 'GET', path: /\/token$/, status: 500, sticky: true })
    cf.tokenInCreate = false
    const job = await s.apply(client(cf), input(), p.fingerprint)
    expect(stepStates(job)).toBe('tunnel:done ingress:done dns:done token:failed save:pending')
    const created = cf.tunnels.find(t => t.name === 'llama-web')!
    expect(await s.cleanup(client(cf))).toBeNull()
    expect(created.deleted_at).not.toBeNull()
    expect(cf.records).toHaveLength(0)
    expect(keep.deleted_at).toBeNull()
    expect(saved).toEqual([])
    expect(s.status()).toBeNull()
  })

  test('cleanup after a reuse run leaves the reused tunnel and record alone', async () => {
    const cf = new FakeCloudflare()
    const other = cf.addTunnel({ name: 'old' })
    cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${other.id}.cfargotunnel.com`, proxied: true })
    const { s } = setup(cf)
    const inp = input({ tunnel: `reuse:${other.id}` })
    const p = await planSetup(client(cf), inp)
    cf.failures.push({ method: 'GET', path: /\/token$/, status: 500, sticky: true })
    await s.apply(client(cf), inp, p.fingerprint)
    await s.cleanup(client(cf))
    expect(other.deleted_at).toBeNull()
    expect(cf.records).toHaveLength(1)
    expect(cf.writes().filter(w => w.startsWith('DELETE'))).toEqual([])
  })

  test('cleanup puts a re-pointed existing record back before deleting the new tunnel', async () => {
    const cf = new FakeCloudflare()
    const old = cf.addTunnel({ name: 'old' })
    const rec = cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${old.id}.cfargotunnel.com`, proxied: false })
    const { s } = setup(cf)
    const inp = input({ tunnel: 'create', dns: 'repoint' })
    const p = await planSetup(client(cf), inp)
    cf.failures.push({ method: 'GET', path: /\/token$/, status: 500, sticky: true })
    cf.tokenInCreate = false
    const job = await s.apply(client(cf), inp, p.fingerprint)
    expect(stepStates(job)).toBe('tunnel:done ingress:done dns:done token:failed save:pending')
    expect(job.created.dnsRestore).toEqual({ id: rec.id, content: `${old.id}.cfargotunnel.com`, proxied: false })
    expect(await s.cleanup(client(cf))).toBeNull()
    expect(cf.tunnels.find(t => t.name === 'llama-web')!.deleted_at).not.toBeNull()
    expect(cf.records).toHaveLength(1)
    expect(cf.records[0]).toMatchObject({ id: rec.id, content: `${old.id}.cfargotunnel.com`, proxied: false })
    expect(old.deleted_at).toBeNull()
  })

  test('cleanup does not revert a record somebody else changed after the run', async () => {
    const cf = new FakeCloudflare()
    const old = cf.addTunnel({ name: 'old' })
    const rec = cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${old.id}.cfargotunnel.com`, proxied: true })
    const { s } = setup(cf)
    const inp = input({ tunnel: 'create', dns: 'repoint' })
    const p = await planSetup(client(cf), inp)
    cf.failures.push({ method: 'GET', path: /\/token$/, status: 500, sticky: true })
    cf.tokenInCreate = false
    await s.apply(client(cf), inp, p.fingerprint)
    rec.content = 'elsewhere.example.net'
    await s.cleanup(client(cf))
    expect(cf.records[0]!.content).toBe('elsewhere.example.net')
  })

  test('reusing a tunnel sends back the whole remote configuration, not just the ingress', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({
      name: 'llama-web',
      ingress: [{ hostname: 'other.example.com', service: 'http://127.0.0.1:3000' }, { service: 'http_status:404' }],
      extraConfig: { originRequest: { noTLSVerify: true, connectTimeout: 5 }, 'warp-routing': { enabled: false } },
    })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    const { s } = setup(cf)
    expect((await s.apply(client(cf), inp, p.fingerprint)).state).toBe('done')
    expect(t.extraConfig).toEqual({ originRequest: { noTLSVerify: true, connectTimeout: 5 }, 'warp-routing': { enabled: false } })
    expect(t.ingress!.map(r => r.hostname ?? '*')).toEqual(['other.example.com', 'llm.example.com', '*'])
  })

  test('a change of the tunnel-wide configuration after the preview is refused', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web', ingress: [{ service: 'http_status:404' }], extraConfig: { originRequest: { connectTimeout: 5 } } })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    t.extraConfig = { originRequest: { connectTimeout: 60 } }
    const { s } = setup(cf)
    expect(await codeOf(s.apply(client(cf), inp, p.fingerprint))).toBe('changed')
    expect(cf.writes()).toEqual([])
  })

  test('retry of the ingress step does not overwrite what changed after the preview', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web', ingress: [{ hostname: 'llm.example.com', service: 'http://127.0.0.1:18090' }, { service: 'http_status:404' }] })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    cf.failures.push({ method: 'PUT', path: /configurations$/, status: 500 })
    const { s, saved } = setup(cf)
    const job = await s.apply(client(cf), inp, p.fingerprint)
    expect(stepStates(job)).toBe('tunnel:skipped ingress:failed dns:pending token:pending save:pending')
    // Somebody edits the same hostname in the dashboard before the user presses retry.
    t.ingress = [{ hostname: 'llm.example.com', service: 'http://127.0.0.1:9090' }, { service: 'http_status:404' }]
    const again = await s.retry(client(cf))
    expect(again.state).toBe('failed')
    expect(again.steps[1]!.error).toEqual({ code: 'changed', detail: 'ingress-changed' })
    expect(t.ingress[0]!.service).toBe('http://127.0.0.1:9090')
    expect(saved).toEqual([])
  })

  test('retry after a write whose answer was lost recognises its own result', async () => {
    const cf = new FakeCloudflare()
    const t = cf.addTunnel({ name: 'llama-web', ingress: [{ service: 'http_status:404' }] })
    const inp = input({ tunnel: `reuse:${t.id}` })
    const p = await planSetup(client(cf), inp)
    const lost: typeof cf.fetch = async (url, init) => {
      const res = await cf.fetch(url, init)
      if ((init?.method ?? 'GET') === 'PUT' && cf.failures.length === 0 && !lostOnce.done) { lostOnce.done = true; throw new TypeError('fetch failed') }
      return res
    }
    const lostOnce = { done: false }
    const { s } = setup(cf)
    const job = await s.apply(new CfClient(GOOD, lost, BASE), inp, p.fingerprint)
    expect(job.steps[1]!.state).toBe('failed')
    expect(job.steps[1]!.error!.code).toBe('network')
    const again = await s.retry(client(cf))
    expect(again.state).toBe('done')
    expect(again.steps[1]!.state).toBe('skipped')
  })

  test('dismiss / retry / cleanup without a failed run', async () => {
    const cf = new FakeCloudflare()
    const { s } = setup(cf)
    expect(await codeOf(s.retry(client(cf)))).toBe('no-job')
    expect(await codeOf(s.cleanup(client(cf)))).toBe('no-job')
    s.dismiss()
    const p = await planSetup(client(cf), input())
    await s.apply(client(cf), input(), p.fingerprint)
    s.dismiss()
    expect(s.status()).toBeNull()
  })
})

describe('adding an address to the tunnel llama-web already hosts', () => {
  function withCurrent() {
    const cf = new FakeCloudflare()
    cf.zones.push({ id: 'zone-b', name: 'second.example', status: 'active', accountId: ACCOUNT })
    const cur = cf.addTunnel({ name: 'my-tunnel', ingress: [{ hostname: 'llm.example.com', service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }], connections: [{}, {}, {}, {}] })
    cf.addRecord({ type: 'CNAME', name: 'llm.example.com', content: `${cur.id}.cfargotunnel.com`, proxied: true })
    return { cf, cur }
  }

  test('default: reuse the current tunnel without asking, no warnings about its own connectors / addresses', async () => {
    const { cf, cur } = withCurrent()
    const inp = input({ zoneId: 'zone-b', currentTunnelId: cur.id })
    const p = await planSetup(client(cf), inp)
    expect(p.hostname).toBe('llm.second.example')
    expect(p.tunnel).toMatchObject({ kind: 'reuse', current: true, tunnel: { id: cur.id } })
    expect(p.autoChosen).toBe(true)
    expect(p.needs).toEqual([])
    expect(p.warnings).toEqual([])
    expect(p.ingress).toEqual({ change: { hostname: 'llm.second.example', from: null, to: 'http://127.0.0.1:8080' }, others: ['llm.example.com'] })
    expect(p.dns).toEqual({ kind: 'create' })
    expect(p.ready).toBe(true)

    const { s, saved } = setup(cf)
    const job = await s.apply(client(cf), inp, p.fingerprint)
    expect(stepStates(job)).toBe('tunnel:skipped ingress:done dns:done token:done save:done')
    expect(cur.ingress).toEqual([
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'llm.second.example', service: 'http://127.0.0.1:8080' },
      { service: 'http_status:404' },
    ])
    expect(cf.records.map(r => r.name).sort()).toEqual(['llm.example.com', 'llm.second.example'])
    expect(cf.tunnels).toHaveLength(1)
    expect(saved).toEqual([{ tunnelToken: cur.token, hostname: 'llm.second.example' }])
  })

  test('tunnel "ask" lists the choices, the current tunnel marked as such', async () => {
    const { cf, cur } = withCurrent()
    const p = await planSetup(client(cf), input({ zoneId: 'zone-b', currentTunnelId: cur.id, tunnel: 'ask' }))
    expect(p.needs).toEqual(['tunnel'])
    expect(p.autoChosen).toBe(false)
    expect(p.tunnelChoices).toMatchObject([{ value: 'create' }, { value: `reuse:${cur.id}`, why: ['current'] }])
  })

  test('same address again: DNS already points at the current tunnel, only the rule is checked', async () => {
    const { cf, cur } = withCurrent()
    const p = await planSetup(client(cf), input({ currentTunnelId: cur.id }))
    expect(p.dns!.kind).toBe('keep')
    expect(p.tunnelChoices.find(c => c.value === `reuse:${cur.id}`)).toMatchObject({ why: ['current', 'dns-target'] })
    expect(p.ready).toBe(true)
  })

  test('a current tunnel that is gone (or in another account) falls back to the normal flow', async () => {
    const cf = new FakeCloudflare()
    const p = await planSetup(client(cf), input({ currentTunnelId: 'aaaaaaaa-bbbb-cccc-dddd-999999999999' }))
    expect(p.tunnel).toEqual({ kind: 'create', name: 'llama-web' })
    expect(p.autoChosen).toBe(false)
  })
})
