// System bsdtar (Windows/macOS), bounded and cancelled as one installation operation.
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, win32 } from 'node:path'
import { killTree } from './runner'
import { RuntimeError, type NetOptions } from './llamacpp'

export interface ArchiveOptions extends NetOptions {
  extractTimeoutMs?: number
  /** Budget for the whole destination tree (bytes / entries), counting what is already in it. */
  maxBytes?: number
  maxEntries?: number
  /** Free bytes on the destination volume; the listed expanded size must fit. */
  freeBytes?: number | null
}
export function safeArchivePath(name: string): boolean {
  const p = name.replace(/\\/g, '/')
  return !!p && !/[\x00-\x1f\x7f:]/.test(p) && !isAbsolute(p) && !win32.isAbsolute(p)
    && !p.split('/').some(s => s === '..')
}
/** Validate before extraction; no absolute paths, traversal, devices, or escaping links. */
export function validateArchive(names: string, verbose: string): void {
  for (const n of names.trim().split(/\r?\n/)) {
    if (!safeArchivePath(n)) throw new RuntimeError('extract-failed', 'Unsafe archive path')
  }
  for (const line of verbose.trim().split(/\r?\n/)) {
    if (!/^[-dlh]/.test(line)) throw new RuntimeError('extract-failed', 'Unsupported archive entry')
    if (/^[lh]/.test(line)) {
      const target = line.split(line[0] === 'l' ? ' -> ' : ' link to ')[1]
      if (!target || !safeArchivePath(target)) throw new RuntimeError('extract-failed', 'Unsafe archive link')
    }
  }
}
/** Also reject existing links in the destination before an overlay (e.g. cudart). */
export function checkExtractedTree(dir: string, allowLinks = true): void {
  const base = realpathSync(dir)
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n), st = lstatSync(f)
      if (st.isSymbolicLink()) {
        const rel = relative(base, realpathSync(f))
        if (!allowLinks || rel.startsWith('..') || isAbsolute(rel)) throw new RuntimeError('extract-failed', 'Unsafe extracted link')
      } else if (st.isDirectory()) walk(f)
      else if (!st.isFile()) throw new RuntimeError('extract-failed', 'Unsupported extracted entry')
    }
  }
  walk(dir)
}

export async function archiveCommand(cmd: string, args: string[], opts: ArchiveOptions = {}): Promise<string> {
  if (opts.signal?.aborted) throw new RuntimeError('extract-failed', 'Extraction cancelled')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false })
    let out = '', err = '', failure: Error | undefined, stopping = false
    let termination: Promise<unknown> = Promise.resolve()
    const stop = (reason: string) => {
      failure ??= new RuntimeError('extract-failed', reason)
      if (!stopping) {
        stopping = true
        if (child.pid) termination = killTree(child.pid).catch(() => {}).finally(() => { child.kill('SIGKILL') })
      }
    }
    const onAbort = () => stop('Extraction cancelled')
    const timer = setTimeout(() => stop('Extraction timed out'), opts.extractTimeoutMs ?? 120_000)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const done = () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort) }
    child.stdout.on('data', d => { if (out.length <= 4_000_000) out += d; if (out.length > 4_000_000) stop('Archive listing too large') })
    child.stderr.on('data', d => { err = (err + d).slice(-2000) })
    child.on('error', e => { done(); reject(new RuntimeError('extract-failed', `Cannot run ${cmd}`, e.message)) })
    // Wait for process close before the caller removes its work directory.
    child.on('close', async code => {
      await termination
      done()
      if (failure) reject(failure)
      else if (code !== 0) reject(new RuntimeError('extract-failed', `Extract failed (${code})`, err))
      else resolve(out)
    })
  })
}
/** Expanded size and entry count announced by a `tar -tv` listing (sizes it cannot parse count as 0). */
export function listingTotals(verbose: string): { bytes: number, entries: number } {
  let bytes = 0, entries = 0
  for (const line of verbose.trim().split(/\r?\n/)) {
    if (!line) continue
    entries++
    if (line[0] === '-') bytes += Number(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(line)?.[1] ?? 0)
  }
  return { bytes, entries }
}
/** Size and entry count of what is on disk under `dir`; stops walking once a budget is passed. */
function treeUsage(dir: string, maxBytes: number, maxEntries: number): { bytes: number, entries: number } {
  let bytes = 0, entries = 0
  const walk = (d: string): boolean => {
    let names: string[]
    try { names = readdirSync(d) } catch { return false }
    for (const n of names) {
      const f = join(d, n)
      let st
      try { st = lstatSync(f) } catch { continue }
      entries++
      if (st.isDirectory()) { if (walk(f)) return true }
      else if (st.isFile()) bytes += st.size
      if (bytes > maxBytes || entries > maxEntries) return true
    }
    return false
  }
  walk(dir)
  return { bytes, entries }
}
const tooLarge = (detail?: string) => new RuntimeError('extract-too-large', 'The archive expands beyond the allowed size', detail)

export async function extractArchive(file: string, dest: string, opts: ArchiveOptions = {}): Promise<void> {
  if (!/\.(zip|tar\.gz|tgz)$/i.test(file)) throw new RuntimeError('extract-failed', 'Unsupported archive format')
  mkdirSync(dest, { recursive: true })
  checkExtractedTree(dest, false)
  const cmd = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  const names = await archiveCommand(cmd, ['-tf', file], opts)
  const types = await archiveCommand(cmd, ['-tvf', file], opts)
  validateArchive(names, types)

  const maxBytes = opts.maxBytes ?? Infinity, maxEntries = opts.maxEntries ?? Infinity
  const announced = listingTotals(types)
  const have = treeUsage(dest, maxBytes, maxEntries)
  if (announced.bytes + have.bytes > maxBytes || announced.entries + have.entries > maxEntries) throw tooLarge()
  if (opts.freeBytes != null && announced.bytes > opts.freeBytes) throw tooLarge(`space:${announced.bytes}`)

  // The listing is only what the archive claims: also watch what is really written and stop at the budget.
  const ac = new AbortController()
  const onOuter = () => ac.abort()
  opts.signal?.addEventListener('abort', onOuter, { once: true })
  let exceeded = false
  const timer = setInterval(() => {
    const u = treeUsage(dest, maxBytes, maxEntries)
    if (u.bytes > maxBytes || u.entries > maxEntries) { exceeded = true; ac.abort() }
  }, 100)
  try {
    await archiveCommand(cmd, ['-xf', file, '-C', dest], { ...opts, signal: ac.signal })
  } catch (e) {
    if (exceeded) throw tooLarge()
    throw e
  } finally {
    clearInterval(timer)
    opts.signal?.removeEventListener('abort', onOuter)
  }
  if (exceeded) throw tooLarge()
  checkExtractedTree(dest)
}
