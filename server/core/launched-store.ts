// What the upstream launcher started, kept across restarts of llama-web (decision 66): `data/run/upstreams-launched.json`.
// A run-state file like pids.json (atomic write, a torn file reads as empty), but a different one: residue cleanup
// ignores these processes, they are the user's services. An entry only authorizes a kill together with a matching
// identity (pid + executable + start time), so a reused pid is never ended.
import { existsSync, readFileSync } from 'node:fs'
import type { ProcessIdentity } from './process-identity'
import { writeFileAtomic } from './store'

export interface Ident extends ProcessIdentity { pid: number }

export interface LaunchedEntry {
  /** Upstream id. */
  upstream: string
  /** The process the start command created (a launcher script may be gone already). */
  root: Ident | null
  /** The process that listened on the upstream's port once the service was up. */
  listener: Ident | null
  /** Epoch ms. */
  startedAt: number
}

export interface LaunchedStore {
  load(): LaunchedEntry[]
  save(entries: LaunchedEntry[]): void
}

interface LaunchedFile { version: 1, entries: LaunchedEntry[] }

function cleanIdent(v: unknown): Ident | null {
  const x = v as Partial<Ident> | null
  if (!x || !Number.isInteger(x.pid) || x.pid! <= 0 || typeof x.exe !== 'string' || !x.exe || typeof x.birth !== 'string' || !x.birth) return null
  return { pid: x.pid!, exe: x.exe, birth: x.birth, ...(Number.isInteger(x.pgid) ? { pgid: x.pgid } : {}) }
}

export function fileLaunchedStore(file: string): LaunchedStore {
  return {
    load() {
      if (!existsSync(file)) return []
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as Partial<LaunchedFile>
        if (doc?.version !== 1 || !Array.isArray(doc.entries)) return []
        return doc.entries
          .filter(e => e && typeof e.upstream === 'string' && e.upstream)
          .map(e => ({ upstream: e.upstream, root: cleanIdent(e.root), listener: cleanIdent(e.listener), startedAt: Number.isFinite(e.startedAt) ? e.startedAt : 0 }))
      } catch {
        // A torn or hand-mangled run file is not worth failing over; the services just stop being remembered.
        return []
      }
    },
    save(entries) {
      const doc: LaunchedFile = { version: 1, entries }
      writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n')
    },
  }
}
