// Start counter of this data directory: run/boot.json holds how many times llama-web started here. A
// process takes the next number as its boot, so boots are ordered by start order and not by the clock
// (settings versions are compared as (boot, rev); see app/composables/useLocale.ts). One process owns the
// data directory at a time (the data lock), so read-increment-write needs no further locking.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './store'

const VERSION = 1

/**
 * Read the last boot number, add one, write it back and return it - but only once the write has succeeded.
 * A number that is not on disk could be handed out again by the next start, so it is never published:
 * when the write fails this returns null (and warns), pages treat that process's copies as unversioned
 * (applied, never remembered) and the next start counts on from the old file.
 *
 * The order never depends on the clock. A missing, damaged or unknown-version file is treated alike: the
 * count starts again from 1. Boundary: pages that were open before such a reset hold a higher boot and
 * reject the new process's lower one, so they need a refresh.
 */
export function nextBootSeq(dataDir: string, warn: (msg: string) => void = m => console.error('[llama-web]', m)): number | null {
  const file = join(dataDir, 'run', 'boot.json')
  let next = 1
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown, seq?: unknown }
    if (doc.version !== VERSION || typeof doc.seq !== 'number' || !Number.isSafeInteger(doc.seq) || doc.seq < 0) throw new Error('unexpected content')
    next = doc.seq + 1
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`cannot use ${file} (${(e as Error).message}); counting starts again from 1, open pages need a refresh`)
  }
  try {
    writeFileAtomic(file, JSON.stringify({ version: VERSION, seq: next }))
  } catch (e) {
    warn(`cannot write ${file}: ${(e as Error).message}; settings versions are not ordered during this run`)
    return null
  }
  return next
}
