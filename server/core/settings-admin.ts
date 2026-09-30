// Validation for edits made on the settings page. Pure module (no Nitro): takes the current
// settings plus an untrusted patch from the client and either applies it to the draft or throws
// SettingsError. Sections are independent; a missing section is left alone.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ArgsSyntaxError, PARAM_DEFS, splitArgs, type LaunchDefaults, type ParamValue } from './args'
import type { ModelsDoc, Settings } from './config'
import type { ModelDir } from './types'

export type SettingsErrorCode =
  | 'bad-request' | 'dir-path' | 'dir-duplicate' | 'dir-depth' | 'dir-in-use' | 'dir-limit'
  | 'bad-param' | 'bad-extra-args' | 'bad-image' | 'bad-port' | 'bad-port-range' | 'bad-timeout'

export class SettingsError extends Error {
  constructor(public code: SettingsErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SettingsError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null
}

const MAX_DIRS = 32
export const MAX_DEPTH = 10

/** Stable form of a directory path for duplicate detection (case-insensitive on Windows). */
export function dirKey(path: string): string {
  const p = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function cleanPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new SettingsError('dir-path')
  const p = raw.trim().replace(/^"(.*)"$/, '$1').trim()
  if (!p || p.length > 500 || /[\u0000-\u001f]/.test(p) || !isAbsolute(p)) throw new SettingsError('dir-path', raw.trim())
  return p
}

function nextDirId(used: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `dir-${n}`
    if (!used.has(id)) return id
  }
}

/** Model references that point into a directory, as model names. */
function modelsUsingDir(models: ModelsDoc, dirId: string): string[] {
  return models.models
    .filter(m => [m.file, m.mmproj, m.draft].some(f => f?.dirId === dirId))
    .map(m => m.name)
}

/**
 * Replace the model directory list. Existing ids are kept (models reference them, plan 13b);
 * entries with an unknown or missing id are new and get a fresh id. A directory that enabled
 * models still use cannot be removed (disable it, or change its path, instead).
 */
export function applyModelDirs(draft: Settings, raw: unknown, models: ModelsDoc): void {
  if (!Array.isArray(raw) || raw.length > MAX_DIRS) throw new SettingsError(Array.isArray(raw) ? 'dir-limit' : 'bad-request')
  const known = new Map(draft.modelDirs.map(d => [d.id, d]))
  const used = new Set<string>(known.keys())
  const seen = new Set<string>()
  const keep = new Set<string>()
  const next: ModelDir[] = []
  for (const item of raw) {
    if (!isObj(item)) throw new SettingsError('bad-request')
    const path = cleanPath(item.path)
    const maxDepth = int(item.maxDepth, 0, MAX_DEPTH)
    if (maxDepth === null) throw new SettingsError('dir-depth', path)
    if (typeof item.enabled !== 'boolean') throw new SettingsError('bad-request')
    const key = dirKey(path)
    if (seen.has(key)) throw new SettingsError('dir-duplicate', path)
    seen.add(key)
    let id = typeof item.id === 'string' && known.has(item.id) && !keep.has(item.id) ? item.id : ''
    if (!id) {
      id = nextDirId(used)
      used.add(id)
    }
    keep.add(id)
    next.push({ id, path, enabled: item.enabled, maxDepth })
  }
  for (const d of draft.modelDirs) {
    if (keep.has(d.id)) continue
    const users = modelsUsingDir(models, d.id)
    if (users.length) throw new SettingsError('dir-in-use', `${d.path}: ${users.join(', ')}`)
  }
  draft.modelDirs = next
}

/** Global default launch parameters. Missing keys keep their value; `''` / null mean "do not pass". */
export function applyDefaults(draft: Settings, raw: unknown): void {
  if (!isObj(raw)) throw new SettingsError('bad-request')
  const next: Record<string, ParamValue | string> = { ...draft.defaults }
  for (const d of PARAM_DEFS) {
    const v = raw[d.key]
    if (v === undefined) continue
    if (v === null || v === '') next[d.key] = null
    else if (typeof v === 'number' && Number.isFinite(v)) next[d.key] = v
    else if (typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v)) next[d.key] = v.trim()
    else throw new SettingsError('bad-param', d.key)
  }
  if (raw.extraArgs !== undefined) {
    if (typeof raw.extraArgs !== 'string' || raw.extraArgs.length > 10_000) throw new SettingsError('bad-extra-args')
    try {
      splitArgs(raw.extraArgs)
    } catch (e) {
      if (e instanceof ArgsSyntaxError) throw new SettingsError('bad-extra-args', e.message)
      throw e
    }
    next.extraArgs = raw.extraArgs
  }
  draft.defaults = next as unknown as LaunchDefaults
}

const IMAGE_FORMATS = ['jpeg', 'png', 'webp']

export function applyImagePreprocess(draft: Settings, raw: unknown): void {
  if (!isObj(raw)) throw new SettingsError('bad-request')
  const cur = draft.preprocess.image
  const enabled = raw.enabled === undefined ? cur.enabled : raw.enabled
  const maxEdge = raw.maxEdge === undefined ? cur.maxEdge : int(raw.maxEdge, 64, 8192)
  const quality = raw.quality === undefined ? cur.quality : int(raw.quality, 1, 100)
  const format = raw.format === undefined ? cur.format : raw.format
  if (typeof enabled !== 'boolean') throw new SettingsError('bad-image', 'enabled')
  if (maxEdge === null) throw new SettingsError('bad-image', 'maxEdge')
  if (quality === null) throw new SettingsError('bad-image', 'quality')
  if (typeof format !== 'string' || !IMAGE_FORMATS.includes(format)) throw new SettingsError('bad-image', 'format')
  draft.preprocess.image = { enabled, maxEdge, quality, format: format as typeof cur.format }
}

export interface PortsPatch {
  port?: unknown
  portRange?: unknown
  loadTimeoutSec?: unknown
  drainTimeoutSec?: unknown
}

/**
 * Listening port, llama-server port range and timeouts. The online limit (`maxLoaded`) is
 * deliberately not editable (plan decision 9).
 */
export function applyServer(draft: Settings, raw: unknown): void {
  if (!isObj(raw)) throw new SettingsError('bad-request')
  const p = raw as PortsPatch
  const port = p.port === undefined ? draft.server.port : int(p.port, 1024, 65535)
  if (port === null) throw new SettingsError('bad-port')
  if (port === draft.public.port) throw new SettingsError('bad-port', String(port))
  let range = draft.scheduler.portRange
  if (p.portRange !== undefined) {
    const r = p.portRange
    const from = Array.isArray(r) && r.length === 2 ? int(r[0], 1024, 65535) : null
    const to = Array.isArray(r) && r.length === 2 ? int(r[1], 1024, 65535) : null
    if (from === null || to === null || from > to) throw new SettingsError('bad-port-range')
    range = [from, to]
  }
  if (port >= range[0] && port <= range[1]) throw new SettingsError('bad-port-range', String(port))
  if (draft.public.port >= range[0] && draft.public.port <= range[1]) throw new SettingsError('bad-port-range', String(draft.public.port))
  const load = p.loadTimeoutSec === undefined ? draft.scheduler.loadTimeoutSec : int(p.loadTimeoutSec, 10, 7200)
  const drain = p.drainTimeoutSec === undefined ? draft.scheduler.drainTimeoutSec : int(p.drainTimeoutSec, 5, 7200)
  if (load === null) throw new SettingsError('bad-timeout', 'loadTimeoutSec')
  if (drain === null) throw new SettingsError('bad-timeout', 'drainTimeoutSec')
  draft.server.port = port
  draft.scheduler.portRange = range
  draft.scheduler.loadTimeoutSec = load
  draft.scheduler.drainTimeoutSec = drain
}

export interface SettingsPatch {
  modelDirs?: unknown
  defaults?: unknown
  image?: unknown
  server?: unknown
  /** Marks the first-run wizard as finished (or skipped). */
  setupDone?: unknown
}

const SECTIONS = ['modelDirs', 'defaults', 'image', 'server', 'setupDone']

/** Apply every section present in the patch; validation of any section failing aborts the whole patch. */
export function applySettingsPatch(draft: Settings, patch: unknown, models: ModelsDoc): void {
  if (!isObj(patch) || !SECTIONS.some(k => patch[k] !== undefined)) throw new SettingsError('bad-request')
  const p = patch as SettingsPatch
  if (p.modelDirs !== undefined) applyModelDirs(draft, p.modelDirs, models)
  if (p.defaults !== undefined) applyDefaults(draft, p.defaults)
  if (p.image !== undefined) applyImagePreprocess(draft, p.image)
  if (p.server !== undefined) applyServer(draft, p.server)
  if (p.setupDone !== undefined) {
    if (typeof p.setupDone !== 'boolean') throw new SettingsError('bad-request')
    draft.setup.done = p.setupDone
  }
}

/** What GET /api/settings returns (and the settings page edits). */
export interface SettingsDoc {
  modelDirs: Array<ModelDir & DirStatus>
  defaults: LaunchDefaults
  builtinDefaults: LaunchDefaults
  image: Settings['preprocess']['image']
  server: { port: number, portRange: [number, number], loadTimeoutSec: number, drainTimeoutSec: number, maxLoaded: number }
  setupDone: boolean
  /** The saved port differs from the one this process is listening on. */
  restartRequired: boolean
  /** Port this process is listening on. */
  bootPort: number
}

export interface DirStatus {
  exists: boolean
}

/** Whether a model directory is currently readable (a moved / unmounted disk shows up here). */
export function dirStatus(dir: ModelDir): DirStatus {
  try {
    return { exists: existsSync(dir.path) && statSync(dir.path).isDirectory() }
  } catch {
    return { exists: false }
  }
}

/** The first-run wizard is offered while nothing is configured and it has not been dismissed. */
export function isFirstRun(settings: Settings, models: ModelsDoc): boolean {
  return !settings.setup.done && settings.modelDirs.length === 0 && models.models.length === 0
}
