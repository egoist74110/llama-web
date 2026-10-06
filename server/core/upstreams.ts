// External upstreams (decision 56): other OpenAI-compatible services llama-web forwards to. Pure module (no
// Nitro). The list lives in data/upstreams.json; the upstream API keys live in data/secrets.json
// (`upstreamKeys`, by upstream id) and never appear in a view, a log or an event.
import { randomBytes } from 'node:crypto'
import { ArgsSyntaxError, splitArgs } from './args'
import type { LaunchState } from './upstream-launcher'

export type ImageCompressMode = 'inherit' | 'on' | 'off'

export interface Upstream {
  id: string
  /** Also the model prefix: clients call `<name>-<upstream model id>`. */
  name: string
  /** Includes the `/v1` part, no trailing slash. */
  baseUrl: string
  /** Link to the upstream's own monitor page (only opened by the user); '' = none. */
  monitorUrl: string
  imageCompress: ImageCompressMode
  /** Runs on this machine (shares its GPU / memory). Default true. */
  local: boolean
  /** While it runs, llama-web's own llama-servers are unloaded and none may load (default true; only used when `local`). */
  exclusive: boolean
  /**
   * How to start the service by hand when it is not up (decision 56 ⑩): one command line, split into an argument array
   * (never run through a shell); '' = none. Only the management API sets it.
   */
  startCommand: string
  /** Working directory of the start command; '' = llama-web's own. */
  startCwd: string
  /** Model ids from the last successful connection test. */
  models: string[]
  /** Model ids typed in by hand (for upstreams without `/v1/models`). */
  manualModels: string[]
  /** ISO time of the last connection test; '' = never. */
  testedAt: string
}

export interface UpstreamsDoc {
  version: number
  upstreams: Upstream[]
}

export const UPSTREAMS_VERSION = 1
export const MAX_UPSTREAMS = 20
export const MAX_NAME_LENGTH = 24
export const MAX_MODELS = 500

export function defaultUpstreams(): UpstreamsDoc {
  return { version: UPSTREAMS_VERSION, upstreams: [] }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

export type UpstreamErrorCode =
  | 'bad-key'
  | 'bad-name' | 'name-taken' | 'name-local-conflict' | 'bad-url' | 'url-self' | 'bad-monitor-url'
  | 'bad-model' | 'not-found' | 'too-many' | 'bad-mode' | 'bad-start-command' | 'bad-start-cwd'

export class UpstreamError extends Error {
  constructor(public code: UpstreamErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'UpstreamError'
  }
}

/** Prefix of a client-visible model name. No `-` (the prefix ends at the first one), no colon, no spaces. */
export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH || /[-:/\\\s\u0000-\u001f\u007f]/.test(name)) throw new UpstreamError('bad-name')
  return name
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.localhost')
}

/**
 * `http(s)://host[:port]/path`, no credentials / query / hash; trailing slashes removed. `selfPorts` are the ports
 * llama-web itself listens on: an upstream pointing there would forward to ourselves in a loop.
 */
export function cleanBaseUrl(raw: unknown, selfPorts: readonly number[] = []): string {
  if (typeof raw !== 'string') throw new UpstreamError('bad-url')
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new UpstreamError('bad-url') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UpstreamError('bad-url')
  if (u.username || u.password || u.search || u.hash) throw new UpstreamError('bad-url')
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if ((isLoopbackHost(u.hostname) || u.hostname === '0.0.0.0') && selfPorts.includes(port)) throw new UpstreamError('url-self')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** Monitor link: any http(s) URL, or ''. */
export function cleanMonitorUrl(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw new UpstreamError('bad-monitor-url')
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new UpstreamError('bad-monitor-url') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UpstreamError('bad-monitor-url')
  if (u.username || u.password) throw new UpstreamError('bad-monitor-url')
  return u.toString()
}

export const MAX_START_COMMAND = 2000

/** A start command line: at least one token once split (quotes understood), no control characters. '' = none. */
export function cleanStartCommand(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new UpstreamError('bad-start-command')
  const text = raw.trim()
  if (!text) return ''
  if (text.length > MAX_START_COMMAND || /[\u0000-\u001f\u007f]/.test(text)) throw new UpstreamError('bad-start-command')
  try {
    if (splitArgs(text).length === 0) throw new UpstreamError('bad-start-command')
  } catch (e) {
    if (e instanceof ArgsSyntaxError) throw new UpstreamError('bad-start-command', e.message)
    throw e
  }
  return text
}

export function cleanStartCwd(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new UpstreamError('bad-start-cwd')
  const text = raw.trim()
  if (text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) throw new UpstreamError('bad-start-cwd')
  return text
}

export function cleanModelIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new UpstreamError('bad-model')
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') throw new UpstreamError('bad-model')
    const id = v.trim()
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new UpstreamError('bad-model')
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > MAX_MODELS) throw new UpstreamError('bad-model')
  return out
}

function cleanMode(raw: unknown): ImageCompressMode {
  if (raw === undefined || raw === null) return 'inherit'
  if (raw === 'inherit' || raw === 'on' || raw === 'off') return raw
  throw new UpstreamError('bad-mode')
}

/** Validate a (possibly hand-edited) upstreams.json. Throws on a wrong shape. */
export function normalizeUpstreams(doc: UpstreamsDoc): UpstreamsDoc {
  if (!isObj(doc)) throw new Error('upstreams must be an object')
  if (doc.upstreams === undefined) doc.upstreams = []
  if (!Array.isArray(doc.upstreams)) throw new Error('"upstreams" must be an array')
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const u of doc.upstreams) {
    if (!isObj(u) || typeof u.id !== 'string' || !u.id) throw new Error('every upstream needs a string "id"')
    if (ids.has(u.id)) throw new Error(`duplicate upstream id "${u.id}"`)
    ids.add(u.id)
    try {
      u.name = cleanName(u.name)
      u.baseUrl = cleanBaseUrl(u.baseUrl)
      u.monitorUrl = cleanMonitorUrl(u.monitorUrl)
      u.imageCompress = cleanMode(u.imageCompress)
      u.models = cleanModelIds(u.models)
      u.manualModels = cleanModelIds(u.manualModels)
      u.startCommand = cleanStartCommand(u.startCommand)
      u.startCwd = cleanStartCwd(u.startCwd)
    } catch (e) {
      throw new Error(`upstream "${u.id}": ${(e as Error).message}`)
    }
    if (names.has(u.name.toLowerCase())) throw new Error(`duplicate upstream name "${u.name}"`)
    names.add(u.name.toLowerCase())
    u.local = u.local !== false
    u.exclusive = u.exclusive !== false
    if (typeof u.testedAt !== 'string') u.testedAt = ''
  }
  return doc
}

/** Client-visible name of one upstream model. */
export const clientName = (u: Pick<Upstream, 'name'>, modelId: string): string => `${u.name}-${modelId}`

/** Every model of an upstream (tested ones first, then hand-typed ones), without duplicates. */
export function modelIdsOf(u: Pick<Upstream, 'models' | 'manualModels'>): string[] {
  return [...new Set([...u.models, ...u.manualModels])]
}

/** Names `GET /v1/models` adds for the upstreams. */
export function listExternalNames(doc: UpstreamsDoc): string[] {
  return doc.upstreams.flatMap(u => modelIdsOf(u).map(id => clientName(u, id)))
}

export interface ExternalRoute {
  upstream: Upstream
  /** The id the upstream itself uses (the prefix removed). */
  modelId: string
  /** The name the client used. */
  name: string
}

/**
 * `<prefix>-<id>` -> the upstream and its own model id. Any id after the prefix is accepted (the upstream decides
 * whether it exists); the prefix is compared without regard to case.
 */
export function findExternal(doc: UpstreamsDoc | null | undefined, field: unknown): ExternalRoute | null {
  if (!doc || typeof field !== 'string') return null
  const name = field.trim()
  const i = name.indexOf('-')
  if (i <= 0 || i === name.length - 1) return null
  const prefix = name.slice(0, i).toLowerCase()
  const upstream = doc.upstreams.find(u => u.name.toLowerCase() === prefix)
  return upstream ? { upstream, modelId: name.slice(i + 1), name } : null
}

/** A local model name that an upstream prefix would shadow (`Prefix-...`); used when saving an upstream. */
export function localConflict(prefix: string, localNames: readonly string[]): string | null {
  const p = `${prefix.toLowerCase()}-`
  return localNames.find(n => n.toLowerCase().startsWith(p)) ?? null
}

/** The upstream prefix a new local model name would be shadowed by (`Prefix-...`, case-insensitive), or null. */
export function upstreamPrefixClash(modelName: string, prefixes: readonly string[]): string | null {
  const n = modelName.toLowerCase()
  return prefixes.find(p => n.startsWith(`${p.toLowerCase()}-`)) ?? null
}

// ---------------------------------------------------------------------------------------
// Edits (on a draft of the document)

export interface UpstreamForm {
  name?: unknown
  baseUrl?: unknown
  monitorUrl?: unknown
  imageCompress?: unknown
  local?: unknown
  exclusive?: unknown
  manualModels?: unknown
  startCommand?: unknown
  startCwd?: unknown
}

/**
 * Ports llama-web itself answers on. The public port counts only while the public entry is really listening: switched on
 * but failed to bind (another engine owns :8080) it is not ours, and an upstream there is legitimate.
 */
export function selfPortsOf(serverPort: number, bootPort: number, publicEntry: { state: string, port?: number }): number[] {
  return [serverPort, bootPort, ...(publicEntry.state === 'listening' && publicEntry.port ? [publicEntry.port] : [])]
}

export interface EditContext {
  localNames: readonly string[]
  selfPorts: readonly number[]
  rand?: (n: number) => Buffer
}

function checkName(draft: UpstreamsDoc, name: string, exceptId: string | null, ctx: EditContext) {
  if (draft.upstreams.some(u => u.id !== exceptId && u.name.toLowerCase() === name.toLowerCase())) throw new UpstreamError('name-taken', name)
  const clash = localConflict(name, ctx.localNames)
  if (clash) throw new UpstreamError('name-local-conflict', clash)
}

export function createUpstream(draft: UpstreamsDoc, form: UpstreamForm, ctx: EditContext): Upstream {
  if (draft.upstreams.length >= MAX_UPSTREAMS) throw new UpstreamError('too-many')
  const name = cleanName(form.name)
  checkName(draft, name, null, ctx)
  const ids = new Set(draft.upstreams.map(u => u.id))
  const rand = ctx.rand ?? randomBytes
  let id: string
  do id = `u-${rand(4).toString('hex')}`
  while (ids.has(id))
  const u: Upstream = {
    id, name, baseUrl: cleanBaseUrl(form.baseUrl, ctx.selfPorts), monitorUrl: cleanMonitorUrl(form.monitorUrl),
    imageCompress: cleanMode(form.imageCompress), local: form.local !== false, exclusive: form.exclusive !== false,
    startCommand: cleanStartCommand(form.startCommand), startCwd: cleanStartCwd(form.startCwd),
    models: [], manualModels: cleanModelIds(form.manualModels), testedAt: '',
  }
  draft.upstreams.push(u)
  return u
}

/** Fields that are present in `form` replace the old ones; a changed address drops the tested model list. */
export function updateUpstream(draft: UpstreamsDoc, id: unknown, form: UpstreamForm, ctx: EditContext): Upstream {
  const u = draft.upstreams.find(x => x.id === id)
  if (!u) throw new UpstreamError('not-found')
  if (form.name !== undefined) {
    const name = cleanName(form.name)
    checkName(draft, name, u.id, ctx)
    u.name = name
  }
  if (form.baseUrl !== undefined) {
    const url = cleanBaseUrl(form.baseUrl, ctx.selfPorts)
    if (url !== u.baseUrl) { u.baseUrl = url; u.models = []; u.testedAt = '' }
  }
  if (form.monitorUrl !== undefined) u.monitorUrl = cleanMonitorUrl(form.monitorUrl)
  if (form.imageCompress !== undefined) u.imageCompress = cleanMode(form.imageCompress)
  if (form.local !== undefined) u.local = form.local === true
  if (form.exclusive !== undefined) u.exclusive = form.exclusive === true
  if (form.manualModels !== undefined) u.manualModels = cleanModelIds(form.manualModels)
  if (form.startCommand !== undefined) u.startCommand = cleanStartCommand(form.startCommand)
  if (form.startCwd !== undefined) u.startCwd = cleanStartCwd(form.startCwd)
  return u
}

export function removeUpstream(draft: UpstreamsDoc, id: unknown): Upstream {
  const i = draft.upstreams.findIndex(x => x.id === id)
  if (i < 0) throw new UpstreamError('not-found')
  return draft.upstreams.splice(i, 1)[0]!
}

/** Store the model ids a connection test found. */
export function recordTest(draft: UpstreamsDoc, id: string, models: string[], now = new Date()): void {
  const u = draft.upstreams.find(x => x.id === id)
  if (!u) throw new UpstreamError('not-found')
  // The upstream's own ids are taken as they are; ones that could not be saved (control characters, too long) are left out.
  u.models = models.filter(m => m.trim() && m.length <= 200 && !/[\u0000-\u001f\u007f]/.test(m)).slice(0, MAX_MODELS)
  u.testedAt = now.toISOString()
}

// ---------------------------------------------------------------------------------------
// Views and the upstream's own model list

/** An upstream as list responses show it: the key itself never, only whether one is saved. */
export interface UpstreamView extends Upstream {
  hasKey: boolean
}

/** An upstream with what the health probe last saw (the live snapshot carries these). */
export interface ConnectionView extends UpstreamView {
  up: boolean
  /** Epoch ms of the last probe; null = none yet. */
  checkedAt: number | null
  /** The manual start (decision 56 ⑩). */
  launch: LaunchState
}

export function viewUpstreams(doc: UpstreamsDoc, keys: Record<string, string>): UpstreamView[] {
  return doc.upstreams.map(u => ({ ...u, models: [...u.models], manualModels: [...u.manualModels], hasKey: !!keys[u.id] }))
}

/** Model ids out of an OpenAI-style `/models` answer; anything else is an empty list. */
export function parseModelList(body: unknown): string[] {
  const data = isObj(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
  const ids: string[] = []
  for (const m of data) {
    const id = typeof m === 'string' ? m : isObj(m) && typeof m.id === 'string' ? m.id : null
    if (id && id.trim() && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, MAX_MODELS)
}
