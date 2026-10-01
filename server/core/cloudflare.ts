// One-click Cloudflare tunnel setup (plan 阶段 4, 4-5). Pure module (no Nitro), fetch injectable.
//
// With a Cloudflare API token (Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit,
// Zone · Zone · Read) llama-web creates (or reuses) a remotely managed tunnel, points the
// hostname's ingress rule at the public entry, creates / re-points the proxied DNS CNAME
// (`<tunnel id>.cfargotunnel.com`) and fetches the tunnel token.
//
// - Nothing is changed without a preview the user confirmed. Existing tunnels with the same name,
//   and DNS records on the hostname, are shown and need an explicit choice; other record types on
//   the hostname are never touched (the user removes them in the dashboard).
// - The confirmed preview carries a fingerprint of what was observed; apply re-reads the account
//   and refuses when anything changed in between.
// - Apply runs the steps in order and stops at the first failure; retry continues from there.
//   What this run created (tunnel, DNS record) is remembered so an abandoned run can be undone.
// - The API token is only ever sent in the Authorization header; it is never part of an error,
//   a step result or a log line. The tunnel token is handed to `onSaved` and nowhere else.
import { createHash } from 'node:crypto'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export const CF_API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------------------
// Errors

export type CfErrorCode =
  /** Cannot reach the API (network, timeout). */
  | 'network'
  /** The token is malformed, unknown, expired or disabled. */
  | 'bad-token'
  /** The token lacks a permission for this call (`detail` = which one, when known). */
  | 'forbidden'
  | 'not-found'
  /** Any other API failure (`detail` = Cloudflare's message). */
  | 'api'
  // Setup-level problems
  | 'bad-subdomain' | 'bad-tunnel-name' | 'no-zone' | 'zone-inactive' | 'need-choice' | 'bad-choice'
  | 'blocked' | 'changed' | 'busy' | 'no-job'

export class CfError extends Error {
  constructor(public code: CfErrorCode, public detail = '', public status = 0) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'CfError'
  }
}

/** Which permission a call needs: shown when the API says "forbidden". */
export type Permission = 'tunnel' | 'dns' | 'zone'

// ---------------------------------------------------------------------------------------
// API token

const API_TOKEN = /^[A-Za-z0-9_.-]{30,200}$/

/** The API token the user pasted (trimmed; an optional "Bearer " prefix removed). Throws `bad-token`. */
export function cleanApiToken(raw: unknown): string {
  if (typeof raw !== 'string') throw new CfError('bad-token')
  const token = raw.trim().replace(/^Bearer\s+/i, '')
  if (!API_TOKEN.test(token)) throw new CfError('bad-token')
  return token
}

/** `AbCd…wxYz`. */
export function maskApiToken(token: string): string {
  return token.length < 12 ? '…' : `${token.slice(0, 4)}…${token.slice(-4)}`
}

// ---------------------------------------------------------------------------------------
// Client

interface Envelope<T> {
  success?: boolean
  errors?: { code?: number, message?: string }[]
  result?: T
  result_info?: { page?: number, total_pages?: number }
}

/** Error codes Cloudflare uses for a token it does not accept at all. */
const BAD_TOKEN_CODES = new Set([1000, 6003, 6100, 6101, 6102, 6103, 6111, 9106, 9109])

export class CfClient {
  constructor(private token: string, private fetchFn: FetchFn = fetch, private base = CF_API) {}

  async call<T>(method: string, path: string, body?: unknown, perm?: Permission): Promise<{ result: T, info?: Envelope<T>['result_info'] }> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'llama-web',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      const name = (e as Error)?.name
      throw new CfError('network', name === 'TimeoutError' ? 'timeout' : 'unreachable')
    }
    let env: Envelope<T> | null = null
    try {
      env = await res.json() as Envelope<T>
    } catch { /* not JSON */ }
    if (res.ok && env?.success !== false) return { result: env?.result as T, info: env?.result_info }
    const codes = (env?.errors ?? []).map(e => e.code ?? 0)
    // Only Cloudflare's own short messages; they never contain the token.
    const message = (env?.errors ?? []).map(e => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ').slice(0, 300)
    if (res.status === 401 || codes.some(c => BAD_TOKEN_CODES.has(c))) throw new CfError('bad-token', message, res.status)
    if (res.status === 403 || codes.includes(10000)) throw new CfError('forbidden', perm ?? '', res.status)
    if (res.status === 404) throw new CfError('not-found', message, 404)
    throw new CfError('api', message || `HTTP ${res.status}`, res.status)
  }

  async get<T>(path: string, perm?: Permission): Promise<T> {
    return (await this.call<T>('GET', path, undefined, perm)).result
  }

  /** All pages of a list endpoint (`path` without paging parameters), at most `maxPages`. */
  async list<T>(path: string, perm?: Permission, maxPages = 20): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= maxPages; page++) {
      const { result, info } = await this.call<T[]>('GET', `${path}${sep}per_page=50&page=${page}`, undefined, perm)
      out.push(...(result ?? []))
      if (!info?.total_pages || page >= info.total_pages) break
    }
    return out
  }
}

// ---------------------------------------------------------------------------------------
// Verify + inspect

export interface ZoneView {
  id: string
  name: string
  /** Cloudflare's zone status; only `active` zones (name servers already point at Cloudflare) can be used. */
  status: string
  accountId: string
  accountName: string
  usable: boolean
  /** Why not usable: not active yet / the token cannot edit its DNS / cannot manage tunnels in its account. */
  reason: 'inactive' | 'no-dns' | 'no-tunnel' | null
}

export interface Inspection {
  zones: ZoneView[]
  /** Permissions the token clearly lacks everywhere. Edit vs read can only be told when writing. */
  missing: Permission[]
}

/** Check the token works at all (user token or account-owned token). Throws `bad-token` / `network`. */
export async function verifyToken(api: CfClient): Promise<void> {
  try {
    const r = await api.get<{ status?: string }>('/user/tokens/verify')
    if (r?.status && r.status !== 'active') throw new CfError('bad-token', r.status)
    return
  } catch (e) {
    if (!(e instanceof CfError) || e.code === 'network') throw e
    if (e.code === 'bad-token' && e.status === 0) throw e
  }
  // Account-owned tokens are not user tokens: they are verified per account.
  let accounts: { id: string }[] = []
  try {
    accounts = await api.list<{ id: string }>('/accounts', undefined, 2)
  } catch (e) {
    if (e instanceof CfError && e.code === 'network') throw e
    throw new CfError('bad-token')
  }
  for (const a of accounts) {
    try {
      const r = await api.get<{ status?: string }>(`/accounts/${a.id}/tokens/verify`)
      if (!r?.status || r.status === 'active') return
    } catch (e) {
      if (e instanceof CfError && e.code === 'network') throw e
    }
  }
  throw new CfError('bad-token')
}

const forbidden = (e: unknown) => e instanceof CfError && e.code === 'forbidden'

/** Verify the token and list the zones it can see, with whether each one can be used. */
export async function inspect(api: CfClient): Promise<Inspection> {
  await verifyToken(api)
  let raw: { id: string, name: string, status: string, account?: { id?: string, name?: string } }[]
  try {
    raw = await api.list('/zones', 'zone')
  } catch (e) {
    if (forbidden(e)) return { zones: [], missing: ['zone'] }
    throw e
  }
  const accountIds = [...new Set(raw.map(z => z.account?.id ?? '').filter(Boolean))]
  const tunnelOk = new Map<string, boolean>()
  await Promise.all(accountIds.map(async (id) => {
    try {
      await api.call('GET', `/accounts/${id}/cfd_tunnel?is_deleted=false&per_page=1`, undefined, 'tunnel')
      tunnelOk.set(id, true)
    } catch (e) {
      if (!forbidden(e)) throw e
      tunnelOk.set(id, false)
    }
  }))
  const active = raw.filter(z => z.status === 'active').slice(0, 50)
  const dnsOk = new Map<string, boolean>()
  await Promise.all(active.map(async (z) => {
    try {
      await api.call('GET', `/zones/${z.id}/dns_records?per_page=1`, undefined, 'dns')
      dnsOk.set(z.id, true)
    } catch (e) {
      if (!forbidden(e)) throw e
      dnsOk.set(z.id, false)
    }
  }))
  const zones: ZoneView[] = raw.map((z) => {
    const accountId = z.account?.id ?? ''
    const reason: ZoneView['reason'] = z.status !== 'active'
      ? 'inactive'
      : !dnsOk.get(z.id) ? 'no-dns' : !tunnelOk.get(accountId) ? 'no-tunnel' : null
    return { id: z.id, name: z.name, status: z.status, accountId, accountName: z.account?.name ?? '', usable: reason === null, reason }
  }).sort((a, b) => Number(b.usable) - Number(a.usable) || a.name.localeCompare(b.name))
  const missing: Permission[] = []
  if (accountIds.length && ![...tunnelOk.values()].some(Boolean)) missing.push('tunnel')
  if (active.length && ![...dnsOk.values()].some(Boolean)) missing.push('dns')
  return { zones, missing }
}

// ---------------------------------------------------------------------------------------
// Plan

export interface IngressRule {
  hostname?: string
  path?: string
  service: string
  originRequest?: unknown
  [k: string]: unknown
}

export interface TunnelView {
  id: string
  name: string
  /** Connector count right now (someone runs this tunnel when > 0). */
  connections: number
  /** Managed by a local config file (`config_src: local`): the dashboard / API config is not used by it. */
  localConfig: boolean
}

export interface DnsRecordView {
  id: string
  type: string
  content: string
  proxied: boolean
  /** The tunnel a `*.cfargotunnel.com` CNAME points at. */
  tunnelId: string | null
}

export interface SetupInput {
  zoneId: string
  subdomain: string
  tunnelName: string
  /** Public entry port the ingress rule points at. */
  port: number
  /**
   * `create`, `reuse:<tunnel id>`, or `ask` (list the choices even when one is the default).
   * Without it the tunnel llama-web hosts now is reused when it is in this account; otherwise
   * a choice is required whenever an existing tunnel is a candidate.
   */
  tunnel?: string
  /** Id of the tunnel llama-web hosts now (from the saved tunnel token), if any. */
  currentTunnelId?: string | null
  /** `repoint` to change an existing CNAME that points elsewhere. */
  dns?: string
}

export type ChoiceReason = 'current' | 'same-name' | 'dns-target'
export type TunnelChoice = { value: 'create' } | { value: string, reuse: TunnelView, why: ChoiceReason[] }

export type DnsAction =
  | { kind: 'create' }
  | { kind: 'keep', record: DnsRecordView }
  | { kind: 'update', record: DnsRecordView, fromTunnel: string | null }
  | { kind: 'blocked', records: DnsRecordView[] }

export interface IngressChange {
  hostname: string
  from: string | null
  to: string
}

export interface SetupPlan {
  hostname: string
  zone: { id: string, name: string }
  account: { id: string, name: string }
  service: string
  tunnelName: string
  /** Choices for the tunnel; more than one means the user must pick (`input.tunnel`). */
  tunnelChoices: TunnelChoice[]
  /** The chosen one, or null while a choice is still needed. */
  tunnel: { kind: 'create', name: string } | { kind: 'reuse', tunnel: TunnelView, current: boolean } | null
  /** The tunnel was picked by default (the one llama-web hosts now); other choices can be asked for with `tunnel: 'ask'`. */
  autoChosen: boolean
  /** Ingress of the chosen tunnel: our rule, plus the rules for other hostnames that stay. */
  ingress: { change: IngressChange, others: string[] } | null
  dnsRecords: DnsRecordView[]
  /** What happens to DNS, once the tunnel is chosen; `update` needs `input.dns = 'repoint'`. */
  dns: DnsAction | null
  needs: ('tunnel' | 'dns')[]
  warnings: ('tunnel-busy' | 'local-config' | 'other-hosts')[]
  /** True when everything is decided and nothing blocks. */
  ready: boolean
  /** Hash of the observed state and the decisions; apply refuses when it no longer matches. */
  fingerprint: string
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const TUNNEL_CNAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cfargotunnel\.com\.?$/i

export function cleanSubdomain(raw: unknown): string {
  if (typeof raw !== 'string') throw new CfError('bad-subdomain')
  const s = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!s || s.length > 200 || !s.split('.').every(l => LABEL.test(l))) throw new CfError('bad-subdomain')
  return s
}

export function cleanTunnelName(raw: unknown): string {
  if (typeof raw !== 'string' || !TUNNEL_NAME.test(raw.trim())) throw new CfError('bad-tunnel-name')
  return raw.trim()
}

export const serviceFor = (port: number) => `http://127.0.0.1:${port}`
export const cnameTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`

interface RawTunnel {
  id: string
  name: string
  deleted_at?: string | null
  connections?: unknown[]
  config_src?: string
  remote_config?: boolean
}

const viewTunnel = (t: RawTunnel): TunnelView => ({
  id: t.id,
  name: t.name,
  connections: Array.isArray(t.connections) ? t.connections.length : 0,
  localConfig: t.config_src === 'local' || t.remote_config === false,
})

/** Insert / replace the rule for `hostname` (no path), keep the others, keep or add the catch-all last. */
export function mergeIngress(rules: IngressRule[] | null | undefined, hostname: string, service: string): { rules: IngressRule[], change: IngressChange, others: string[] } {
  const list = Array.isArray(rules) ? rules : []
  const isCatchAll = (r: IngressRule) => !r.hostname && !r.path
  const ours = list.find(r => r.hostname?.toLowerCase() === hostname && !r.path)
  const rest = list.filter(r => r !== ours && !isCatchAll(r))
  const catchAll = list.find(isCatchAll) ?? { service: 'http_status:404' }
  const rule: IngressRule = { ...(ours ?? {}), hostname, service }
  return {
    rules: [rule, ...rest, catchAll],
    change: { hostname, from: ours?.service ?? null, to: service },
    others: [...new Set(rest.map(r => r.hostname ?? '*').filter(h => h !== hostname))],
  }
}

/** Everything the plan was computed from, plus the inputs. */
interface Observed {
  zone: { id: string, name: string, accountId: string, accountName: string }
  hostname: string
  records: DnsRecordView[]
  sameName: RawTunnel | null
  dnsTargets: RawTunnel[]
  /** The tunnel llama-web hosts now, when it exists in this account. */
  current: RawTunnel | null
  config: IngressRule[] | null
}

async function getTunnel(api: CfClient, accountId: string, id: string): Promise<RawTunnel | null> {
  try {
    const t = await api.get<RawTunnel>(`/accounts/${accountId}/cfd_tunnel/${id}`, 'tunnel')
    return t && !t.deleted_at ? t : null
  } catch (e) {
    if (e instanceof CfError && (e.code === 'not-found' || (e.code === 'api' && e.status === 400))) return null
    throw e
  }
}

async function getIngress(api: CfClient, accountId: string, tunnelId: string): Promise<IngressRule[] | null> {
  try {
    const r = await api.get<{ config?: { ingress?: IngressRule[] } | null }>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'tunnel')
    return r?.config?.ingress ?? null
  } catch (e) {
    if (e instanceof CfError && e.code === 'not-found') return null
    throw e
  }
}

async function observe(api: CfClient, input: SetupInput): Promise<Observed> {
  const sub = cleanSubdomain(input.subdomain)
  const name = cleanTunnelName(input.tunnelName)
  let z: { id: string, name: string, status: string, account?: { id?: string, name?: string } }
  try {
    z = await api.get(`/zones/${encodeURIComponent(input.zoneId)}`, 'zone')
  } catch (e) {
    if (e instanceof CfError && (e.code === 'not-found' || (e.code === 'api' && e.status === 400))) throw new CfError('no-zone')
    throw e
  }
  if (z.status !== 'active') throw new CfError('zone-inactive', z.name)
  const accountId = z.account?.id ?? ''
  if (!accountId) throw new CfError('api', 'zone has no account')
  const hostname = `${sub}.${z.name.toLowerCase()}`
  if (hostname.length > 253) throw new CfError('bad-subdomain')

  const rawRecords = await api.list<{ id: string, type: string, content: string, proxied?: boolean }>(
    `/zones/${z.id}/dns_records?name=${encodeURIComponent(hostname)}`, 'dns', 2)
  const records: DnsRecordView[] = rawRecords.map(r => ({
    id: r.id, type: r.type, content: r.content, proxied: r.proxied === true,
    tunnelId: r.type === 'CNAME' ? (TUNNEL_CNAME.exec(r.content)?.[1]?.toLowerCase() ?? null) : null,
  }))
  const sameNameList = await api.list<RawTunnel>(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`, 'tunnel', 2)
  const sameName = sameNameList.find(t => t.name === name && !t.deleted_at) ?? null
  const targetIds = [...new Set(records.map(r => r.tunnelId).filter((id): id is string => !!id && id !== sameName?.id))]
  const dnsTargets = (await Promise.all(targetIds.map(id => getTunnel(api, accountId, id)))).filter((t): t is RawTunnel => !!t)
  const curId = input.currentTunnelId?.toLowerCase() ?? null
  const current = !curId
    ? null
    : [sameName, ...dnsTargets].find(t => t?.id.toLowerCase() === curId) ?? await getTunnel(api, accountId, curId)
  // Ingress of the tunnel that will be used (when it is already decided and existing).
  const chosen = input.tunnel?.startsWith('reuse:') ? input.tunnel.slice(6) : !input.tunnel && current ? current.id : null
  const known = [sameName, ...dnsTargets, current].find(t => t && t.id === chosen) ?? null
  const config = known ? await getIngress(api, accountId, known.id) : null
  return { zone: { id: z.id, name: z.name, accountId, accountName: z.account?.name ?? '' }, hostname, records, sameName, dnsTargets, current, config }
}

function buildPlan(o: Observed, input: SetupInput): SetupPlan {
  const name = cleanTunnelName(input.tunnelName)
  const service = serviceFor(input.port)
  const choices: TunnelChoice[] = []
  const candidates = new Map<string, { t: RawTunnel, why: ChoiceReason[] }>()
  if (o.current) candidates.set(o.current.id, { t: o.current, why: ['current'] })
  if (o.sameName && candidates.has(o.sameName.id)) candidates.get(o.sameName.id)!.why.push('same-name')
  else if (o.sameName) candidates.set(o.sameName.id, { t: o.sameName, why: ['same-name'] })
  for (const t of o.dnsTargets) {
    const c = candidates.get(t.id)
    if (c) c.why.push('dns-target')
    else candidates.set(t.id, { t, why: ['dns-target'] })
  }
  // A new tunnel needs a free name.
  if (!o.sameName) choices.push({ value: 'create' })
  for (const { t, why } of candidates.values()) choices.push({ value: `reuse:${t.id}`, reuse: viewTunnel(t), why })

  const reuse = (c: TunnelChoice): SetupPlan['tunnel'] => {
    const r = c as { reuse: TunnelView, why: ChoiceReason[] }
    return { kind: 'reuse', tunnel: r.reuse, current: r.why.includes('current') }
  }
  let tunnel: SetupPlan['tunnel'] = null
  let autoChosen = false
  const needs: SetupPlan['needs'] = []
  if (input.tunnel && input.tunnel !== 'ask') {
    const c = choices.find(c => c.value === input.tunnel)
    if (!c) throw new CfError('bad-choice')
    tunnel = c.value === 'create' ? { kind: 'create', name } : reuse(c)
  } else if (!input.tunnel && o.current) {
    // Adding an address to the tunnel llama-web already runs: nothing to decide.
    tunnel = reuse(choices.find(c => c.value === `reuse:${o.current!.id}`)!)
    autoChosen = true
  } else if (choices.length === 1 && choices[0]!.value === 'create') {
    tunnel = { kind: 'create', name }
  } else {
    needs.push('tunnel')
  }

  const warnings: SetupPlan['warnings'] = []
  let ingress: SetupPlan['ingress'] = null
  let dns: DnsAction | null = null
  if (tunnel) {
    const m = mergeIngress(tunnel.kind === 'reuse' ? o.config : null, o.hostname, service)
    ingress = { change: m.change, others: m.others }
    // The current tunnel's connectors and other addresses are llama-web's own.
    if (tunnel.kind === 'reuse' && !tunnel.current) {
      if (tunnel.tunnel.connections > 0) warnings.push('tunnel-busy')
      if (m.others.length) warnings.push('other-hosts')
    }
    if (tunnel.kind === 'reuse' && tunnel.tunnel.localConfig) warnings.push('local-config')
    const targetId = tunnel.kind === 'reuse' ? tunnel.tunnel.id : null
    const others = o.records.filter(r => r.type !== 'CNAME')
    const cnames = o.records.filter(r => r.type === 'CNAME')
    if (others.length || cnames.length > 1) {
      dns = { kind: 'blocked', records: o.records }
    } else if (!cnames.length) {
      dns = { kind: 'create' }
    } else {
      const r = cnames[0]!
      if (targetId && r.tunnelId === targetId) {
        dns = r.proxied ? { kind: 'keep', record: r } : { kind: 'update', record: r, fromTunnel: targetId }
        if (!r.proxied && input.dns !== 'repoint') needs.push('dns')
      } else {
        const from = r.tunnelId ? ([...o.dnsTargets, o.sameName, o.current].find(t => t?.id === r.tunnelId)?.name ?? r.tunnelId) : null
        dns = { kind: 'update', record: r, fromTunnel: from }
        if (input.dns !== 'repoint') needs.push('dns')
      }
    }
  }
  const ready = !!tunnel && !!dns && dns.kind !== 'blocked' && needs.length === 0
  // Connector counts come and go; only what the steps act on is part of the fingerprint.
  const stable = (t: RawTunnel) => ({ id: t.id, name: t.name, local: viewTunnel(t).localConfig })
  const fingerprint = createHash('sha256').update(JSON.stringify({
    zone: o.zone, hostname: o.hostname, records: o.records, config: o.config,
    sameName: o.sameName && stable(o.sameName), dnsTargets: o.dnsTargets.map(stable), current: o.current && stable(o.current),
    in: { zoneId: input.zoneId, sub: o.hostname, name, port: input.port, tunnel: input.tunnel ?? '', dns: input.dns ?? '' },
  })).digest('hex').slice(0, 16)
  return {
    hostname: o.hostname,
    zone: { id: o.zone.id, name: o.zone.name },
    account: { id: o.zone.accountId, name: o.zone.accountName },
    service, tunnelName: name, tunnelChoices: choices, tunnel, autoChosen, ingress, dnsRecords: o.records, dns, needs, warnings, ready, fingerprint,
  }
}

/** Read the account and work out what setting up `input` would do. Changes nothing. */
export async function planSetup(api: CfClient, input: SetupInput): Promise<SetupPlan> {
  return buildPlan(await observe(api, input), input)
}

// ---------------------------------------------------------------------------------------
// Apply

export type StepId = 'tunnel' | 'ingress' | 'dns' | 'token' | 'save'
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StepView {
  id: StepId
  state: StepState
  /** Short non-secret note: tunnel name / id, rule, record. */
  note: string
  error: { code: CfErrorCode, detail: string } | null
}

export interface SetupJob {
  state: 'running' | 'failed' | 'done'
  hostname: string
  zoneName: string
  steps: StepView[]
  /** What this run created; an abandoned run can delete exactly these. */
  created: { tunnel: { id: string, name: string } | null, dnsRecordId: string | null }
  tunnelId: string | null
  startedAt: number
  finishedAt: number | null
}

export interface SetupHooks {
  /** Save the tunnel token and switch hosting on (secrets + settings). Must not log the token. */
  onSaved: (r: { tunnelToken: string, hostname: string }) => void | Promise<void>
  onChange?: (job: SetupJob | null) => void
  now?: () => number
}

/** Public, non-secret copy of a job. */
export const viewJob = (j: SetupJob | null): SetupJob | null => (j ? structuredClone(j) : null)

const STEPS: StepId[] = ['tunnel', 'ingress', 'dns', 'token', 'save']

/**
 * Holds the one setup run (in memory). `apply` re-reads the account, checks the fingerprint, and
 * runs the steps; `retry` continues a failed run from its failed step; `cleanup` deletes what a
 * failed run created; `dismiss` forgets a finished / failed run.
 */
export class CloudflareSetup {
  private job: SetupJob | null = null
  private plan: SetupPlan | null = null
  private tunnelToken: string | null = null
  private busy = false

  constructor(private hooks: SetupHooks) {}

  status(): SetupJob | null {
    return viewJob(this.job)
  }

  async apply(api: CfClient, input: SetupInput, fingerprint: string): Promise<SetupJob> {
    if (this.busy || this.job?.state === 'running') throw new CfError('busy')
    if (this.job?.state === 'failed') throw new CfError('busy', 'failed-job')
    this.busy = true
    try {
      const plan = await planSetup(api, input)
      if (plan.fingerprint !== fingerprint) throw new CfError('changed')
      if (plan.dns?.kind === 'blocked') throw new CfError('blocked')
      if (!plan.ready) throw new CfError('need-choice')
      const now = this.hooks.now?.() ?? Date.now()
      this.plan = plan
      this.tunnelToken = null
      this.job = {
        state: 'running', hostname: plan.hostname, zoneName: plan.zone.name,
        steps: STEPS.map(id => ({ id, state: 'pending', note: '', error: null })),
        created: { tunnel: null, dnsRecordId: null },
        tunnelId: plan.tunnel?.kind === 'reuse' ? plan.tunnel.tunnel.id : null,
        startedAt: now, finishedAt: null,
      }
    } finally {
      this.busy = false
    }
    return this.run(api)
  }

  async retry(api: CfClient): Promise<SetupJob> {
    if (this.busy || !this.job || this.job.state !== 'failed') throw new CfError(this.job ? 'busy' : 'no-job')
    for (const s of this.job.steps) if (s.state === 'failed') { s.state = 'pending'; s.error = null }
    this.job.state = 'running'
    this.job.finishedAt = null
    return this.run(api)
  }

  /** Delete the DNS record and tunnel this (failed) run created. Things it reused are left alone. */
  async cleanup(api: CfClient): Promise<SetupJob | null> {
    if (this.busy || !this.job || this.job.state !== 'failed') throw new CfError(this.job ? 'busy' : 'no-job')
    this.busy = true
    try {
      const { created } = this.job
      const plan = this.plan!
      if (created.dnsRecordId) {
        try {
          await api.call('DELETE', `/zones/${plan.zone.id}/dns_records/${created.dnsRecordId}`, undefined, 'dns')
        } catch (e) {
          if (!(e instanceof CfError && e.code === 'not-found')) throw e
        }
        created.dnsRecordId = null
      }
      if (created.tunnel) {
        try {
          await api.call('DELETE', `/accounts/${plan.account.id}/cfd_tunnel/${created.tunnel.id}`, undefined, 'tunnel')
        } catch (e) {
          if (!(e instanceof CfError && e.code === 'not-found')) throw e
        }
        created.tunnel = null
      }
      this.forget()
      return null
    } finally {
      this.busy = false
    }
  }

  dismiss(): void {
    if (this.busy || this.job?.state === 'running') throw new CfError('busy')
    this.forget()
  }

  private forget() {
    this.job = null
    this.plan = null
    this.tunnelToken = null
    this.hooks.onChange?.(null)
  }

  private async run(api: CfClient): Promise<SetupJob> {
    const job = this.job!
    this.busy = true
    try {
      for (const step of job.steps) {
        if (step.state === 'done' || step.state === 'skipped') continue
        step.state = 'running'
        this.hooks.onChange?.(viewJob(job)!)
        try {
          const r = await this.runStep(api, step.id)
          step.state = r.skipped ? 'skipped' : 'done'
          step.note = r.note
        } catch (e) {
          step.state = 'failed'
          step.error = e instanceof CfError ? { code: e.code, detail: e.detail } : { code: 'api', detail: 'internal' }
          job.state = 'failed'
          job.finishedAt = this.hooks.now?.() ?? Date.now()
          this.hooks.onChange?.(viewJob(job)!)
          return viewJob(job)!
        }
      }
      job.state = 'done'
      job.finishedAt = this.hooks.now?.() ?? Date.now()
      this.tunnelToken = null
      this.hooks.onChange?.(viewJob(job)!)
      return viewJob(job)!
    } finally {
      this.busy = false
    }
  }

  private async runStep(api: CfClient, id: StepId): Promise<{ note: string, skipped?: boolean }> {
    const job = this.job!
    const plan = this.plan!
    const acc = plan.account.id
    switch (id) {
      case 'tunnel': {
        if (plan.tunnel!.kind === 'reuse') {
          const t = await getTunnel(api, acc, plan.tunnel!.tunnel.id)
          if (!t) throw new CfError('changed', 'tunnel-gone')
          return { note: t.name, skipped: true }
        }
        // A retry after a lost response: a tunnel with our name may already be there.
        if (!job.tunnelId) {
          const existing = (await api.list<RawTunnel>(`/accounts/${acc}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(plan.tunnelName)}`, 'tunnel', 2))
            .find(t => t.name === plan.tunnelName)
          if (existing) throw new CfError('changed', 'tunnel-exists')
          const r = await api.call<RawTunnel & { token?: string }>('POST', `/accounts/${acc}/cfd_tunnel`, { name: plan.tunnelName, config_src: 'cloudflare' }, 'tunnel')
          if (!r.result?.id) throw new CfError('api', 'no tunnel id')
          job.tunnelId = r.result.id
          job.created.tunnel = { id: r.result.id, name: plan.tunnelName }
          if (typeof r.result.token === 'string' && r.result.token) this.tunnelToken = r.result.token
        }
        return { note: plan.tunnelName }
      }
      case 'ingress': {
        const current = plan.tunnel!.kind === 'reuse' ? await getIngress(api, acc, job.tunnelId!) : null
        const m = mergeIngress(current, plan.hostname, plan.service)
        await api.call('PUT', `/accounts/${acc}/cfd_tunnel/${job.tunnelId}/configurations`, { config: { ingress: m.rules } }, 'tunnel')
        return { note: `${plan.hostname} → ${plan.service}` }
      }
      case 'dns': {
        const target = cnameTarget(job.tunnelId!)
        const records = await api.list<{ id: string, type: string, content: string, proxied?: boolean }>(
          `/zones/${plan.zone.id}/dns_records?name=${encodeURIComponent(plan.hostname)}`, 'dns', 2)
        const want = { type: 'CNAME', name: plan.hostname, content: target, proxied: true, comment: 'llama-web tunnel' }
        const correct = records.find(r => r.type === 'CNAME' && r.content.toLowerCase().replace(/\.$/, '') === target && r.proxied)
        if (correct && records.length === 1) return { note: `CNAME → ${target}`, skipped: true }
        const planned = plan.dns!
        if (planned.kind === 'create') {
          if (records.length) throw new CfError('changed', 'dns-appeared')
          const r = await api.call<{ id: string }>('POST', `/zones/${plan.zone.id}/dns_records`, want, 'dns')
          job.created.dnsRecordId = r.result?.id ?? null
          return { note: `CNAME → ${target}` }
        }
        if (planned.kind === 'keep' || planned.kind === 'update') {
          const rec = records.find(r => r.id === planned.record.id)
          if (!rec || records.length !== 1 || rec.content !== planned.record.content) throw new CfError('changed', 'dns-changed')
          await api.call('PATCH', `/zones/${plan.zone.id}/dns_records/${rec.id}`, { content: target, proxied: true }, 'dns')
          return { note: `CNAME → ${target}` }
        }
        throw new CfError('blocked')
      }
      case 'token': {
        if (!this.tunnelToken) {
          const tok = await api.get<string>(`/accounts/${acc}/cfd_tunnel/${job.tunnelId}/token`, 'tunnel')
          if (typeof tok !== 'string' || !tok) throw new CfError('api', 'no token')
          this.tunnelToken = tok
        }
        return { note: '' }
      }
      case 'save': {
        await this.hooks.onSaved({ tunnelToken: this.tunnelToken!, hostname: plan.hostname })
        return { note: plan.hostname }
      }
    }
  }
}
