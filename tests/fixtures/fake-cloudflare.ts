// In-memory fake of the parts of the Cloudflare v4 API the one-click tunnel setup uses.
// `fetch` is a FetchFn; state is plain data the tests set up and inspect.
import type { FetchFn } from '../../server/core/cloudflare'

export type Perm = 'tunnel' | 'dns' | 'zone'

export interface FakeTunnel {
  id: string
  name: string
  config_src: 'cloudflare' | 'local'
  connections: unknown[]
  deleted_at: string | null
  ingress: Record<string, unknown>[] | null
  token: string
}

export interface FakeRecord { id: string, type: string, name: string, content: string, proxied: boolean }

export interface FakeZone { id: string, name: string, status: string, accountId: string }

export const ACCOUNT = 'acc-example-1'
export const GOOD = 'good-api-token-0123456789-abcdefghij'
export const ACCOUNT_TOKEN = 'account-owned-token-0123456789-abcdef'

let seq = 0
const uuid = () => {
  seq++
  const n = String(seq).padStart(12, '0')
  return `aaaaaaaa-bbbb-cccc-dddd-${n}`
}

export class FakeCloudflare {
  perms = new Set<Perm>(['tunnel', 'dns', 'zone'])
  /** Token that is accepted only through the account verify endpoint. */
  accountTokens = new Set<string>([ACCOUNT_TOKEN])
  zones: FakeZone[] = [
    { id: 'zone-a', name: 'example.com', status: 'active', accountId: ACCOUNT },
    { id: 'zone-p', name: 'pending.example', status: 'pending', accountId: ACCOUNT },
  ]
  tunnels: FakeTunnel[] = []
  records: (FakeRecord & { zoneId: string })[] = []
  /** `METHOD path-regex` → status code to fail with (once per entry unless `sticky`). */
  failures: { method: string, path: RegExp, status: number, code?: number, sticky?: boolean }[] = []
  calls: { method: string, path: string, auth: string, body: unknown }[] = []
  /** Return the token in the create-tunnel response (Cloudflare does; tests can turn it off). */
  tokenInCreate = true

  addTunnel(t: Partial<FakeTunnel> & { name: string }): FakeTunnel {
    const id = t.id ?? uuid()
    const tunnel: FakeTunnel = {
      id, config_src: 'cloudflare', connections: [], deleted_at: null, ingress: null, token: `eyJ-tunnel-token-${id}`, ...t,
    }
    this.tunnels.push(tunnel)
    return tunnel
  }

  addRecord(r: Omit<FakeRecord, 'id'> & { zoneId?: string }): FakeRecord {
    const rec = { id: `rec-${++seq}`, zoneId: 'zone-a', ...r }
    this.records.push(rec)
    return rec
  }

  writes(): string[] {
    return this.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)
  }

  fetch: FetchFn = async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.pathname.replace(/^\/client\/v4/, '')
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.calls.push({ method, path, auth, body })
    const token = auth.replace(/^Bearer /, '')
    const ok = (result: unknown, info?: unknown) => Response.json({ success: true, errors: [], result, result_info: info })
    const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status })
    const forbidden = () => err(403, 10000, 'Authentication error')

    const f = this.failures.find(x => x.method === method && x.path.test(path))
    if (f) {
      if (!f.sticky) this.failures.splice(this.failures.indexOf(f), 1)
      if (f.status === 0) throw new TypeError('fetch failed')
      return err(f.status, f.code ?? 1, 'injected failure')
    }

    const isUser = token === GOOD
    const isAccount = this.accountTokens.has(token)
    if (path === '/user/tokens/verify') {
      return isUser ? ok({ id: 't1', status: 'active' }) : err(401, 1000, 'Invalid API Token')
    }
    if (!isUser && !isAccount) return err(400, 6003, 'Invalid request headers')
    if (path === '/accounts') return ok([{ id: ACCOUNT, name: 'Example account' }], { page: 1, total_pages: 1 })
    if (path === `/accounts/${ACCOUNT}/tokens/verify`) return isAccount ? ok({ id: 't2', status: 'active' }) : err(401, 1000, 'Invalid API Token')

    const page = (list: unknown[]) => ok(list, { page: 1, total_pages: 1 })
    const zoneView = (z: FakeZone) => ({ id: z.id, name: z.name, status: z.status, account: { id: z.accountId, name: 'Example account' } })
    if (path === '/zones') return this.perms.has('zone') ? page(this.zones.map(zoneView)) : forbidden()
    let m = /^\/zones\/([^/]+)$/.exec(path)
    if (m) {
      if (!this.perms.has('zone')) return forbidden()
      const z = this.zones.find(z => z.id === m![1])
      return z ? ok(zoneView(z)) : err(404, 1001, 'Invalid zone identifier')
    }
    m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path)
    if (m) {
      if (!this.perms.has('dns')) return forbidden()
      const [, zoneId, rid] = m
      const view = (r: FakeRecord) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied })
      if (method === 'GET') {
        const name = u.searchParams.get('name')
        return page(this.records.filter(r => r.zoneId === zoneId && (!name || r.name === name)).map(view))
      }
      if (method === 'POST') {
        if (this.records.some(r => r.zoneId === zoneId && r.name === body.name)) return err(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.')
        return ok(view(this.addRecord({ zoneId, type: body.type, name: body.name, content: body.content, proxied: !!body.proxied })))
      }
      const rec = this.records.find(r => r.id === rid)
      if (!rec) return err(404, 81044, 'Record does not exist.')
      if (method === 'PATCH') {
        Object.assign(rec, body)
        return ok(view(rec))
      }
      if (method === 'DELETE') {
        this.records.splice(this.records.indexOf(rec), 1)
        return ok({ id: rec.id })
      }
    }
    m = /^\/accounts\/([^/]+)\/cfd_tunnel(?:\/([^/]+))?(?:\/(configurations|token))?$/.exec(path)
    if (m) {
      if (!this.perms.has('tunnel')) return forbidden()
      const [, acc, tid, sub] = m
      if (acc !== ACCOUNT) return err(404, 1003, 'not found')
      const view = (t: FakeTunnel) => ({ id: t.id, name: t.name, config_src: t.config_src, remote_config: t.config_src === 'cloudflare', connections: t.connections, deleted_at: t.deleted_at })
      if (!tid) {
        if (method === 'GET') {
          const name = u.searchParams.get('name')
          const live = u.searchParams.get('is_deleted') === 'false'
          return page(this.tunnels.filter(t => (!name || t.name === name) && (!live || !t.deleted_at)).map(view))
        }
        if (method === 'POST') {
          if (this.tunnels.some(t => t.name === body.name && !t.deleted_at)) return err(409, 1013, 'You already have a tunnel with this name')
          const t = this.addTunnel({ name: body.name })
          return ok({ ...view(t), ...(this.tokenInCreate ? { token: t.token } : {}) })
        }
      }
      const t = this.tunnels.find(t => t.id === tid)
      if (!t) return err(404, 1003, 'Tunnel not found')
      if (!sub) {
        if (method === 'GET') return ok(view(t))
        if (method === 'DELETE') {
          if (t.connections.length) return err(400, 1022, 'Cannot delete a tunnel with active connections')
          t.deleted_at = new Date().toISOString()
          return ok(view(t))
        }
      }
      if (sub === 'configurations') {
        if (method === 'GET') return ok({ tunnel_id: t.id, config: t.ingress ? { ingress: t.ingress } : null })
        if (method === 'PUT') {
          t.ingress = body.config.ingress
          t.config_src = 'cloudflare'
          return ok({ tunnel_id: t.id, config: body.config })
        }
      }
      if (sub === 'token' && method === 'GET') return ok(t.token)
    }
    return err(404, 7003, `No route for ${method} ${path}`)
  }
}
