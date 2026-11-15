// Knowledge base page helpers (decision 65). Pure and free of Nitro / Node, so bun test can run them.
// The numbers below mirror server/core/kb/{manager,registry}.ts; tests/app/kb-page.test.ts keeps them in step.

/** Same limit as the server's MAX_UPLOAD_BYTES. The JSON body (base64) is about 4/3 of it. */
export const KB_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const KB_EXTENSIONS = ['.txt', '.md', '.markdown'] as const
export const KB_ACCEPT = KB_EXTENSIONS.join(',')
export const KB_DEFAULT_CHUNK_SIZE = 500
export const KB_DEFAULT_CHUNK_OVERLAP = 80
export const KB_SOFT_CHUNK_LIMIT = 50_000

/** Why a file cannot be uploaded, or null when it can. */
export function checkKbFile(name: string, size: number): 'unsupported' | 'too-large' | null {
  const ext = /\.[^./\\]+$/.exec(name)?.[0]?.toLowerCase() ?? ''
  if (!(KB_EXTENSIONS as readonly string[]).includes(ext)) return 'unsupported'
  if (size > KB_MAX_UPLOAD_BYTES) return 'too-large'
  return null
}

/**
 * Base64 of a file without building one giant binary string: FileReader encodes it natively
 * (`data:...;base64,<payload>`), so nothing here can overflow the call stack on a 50 MB file.
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const url = String(reader.result ?? '')
      const i = url.indexOf(',')
      resolve(i >= 0 ? url.slice(i + 1) : '')
    }
    reader.readAsDataURL(file)
  })
}

/** Identity of the running jobs without their progress: it changes when a job starts, ends or moves on. */
export function jobsKey(jobs: ReadonlyArray<{ kind: string, kbId: string, docId: number | null, state: string }>): string {
  return jobs.map(j => `${j.kind}:${j.kbId}:${j.docId ?? ''}:${j.state}`).join('|')
}

/** A knowledge binding that cannot be saved: on, choosing named knowledge bases, but none picked. */
export function bindingIncomplete(b: { enabled: boolean, all: boolean, kbs: readonly string[] }): boolean {
  return b.enabled && !b.all && b.kbs.length === 0
}

/** A similarity floor typed into an input: '' = off (null); a number from 0 to 1 is valid; anything else is not. */
export function parseSimilarity(text: string | number | null | undefined): { ok: boolean, value: number | null } {
  const s = String(text ?? '').trim()
  if (!s) return { ok: true, value: null }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? { ok: true, value: n } : { ok: false, value: null }
}

/** Tags of several knowledge bases merged (counts added), sorted by tag; `keep` tags are listed even when no base has them. */
export function mergeTags(lists: ReadonlyArray<ReadonlyArray<{ tag: string, count: number }>>, keep: readonly string[] = []): Array<{ tag: string, count: number }> {
  const sum = new Map<string, number>()
  for (const list of lists) for (const x of list) sum.set(x.tag, (sum.get(x.tag) ?? 0) + x.count)
  for (const tag of keep) if (!sum.has(tag)) sum.set(tag, 0)
  return [...sum].map(([tag, count]) => ({ tag, count })).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

// ---- entries (decision 69); mirrors server/core/kb/{manager,tags}.ts, kept in step by tests/app/kb-page.test.ts ----

export const KB_MAX_ENTRY_TITLE = 200
export const KB_MAX_ENTRY_BODY = 20_000
export const KB_MAX_ENTRY_TAGS = 20
export const KB_MAX_TAG_LEN = 64
/** Same limit as the server's guide text. */
export const KB_MAX_GUIDE = 20_000

/** Wording for `actorLabel` (`t.kb.page.actor`): `key` holds `{name}`. */
export interface ActorLabels { admin: string, local: string, key: string }

/** Who wrote a change: `admin`, `local`, `key:<name>` read as words; anything else as it is. */
export function actorLabel(actor: string, labels: ActorLabels): string {
  if (actor === 'admin') return labels.admin
  if (actor === 'local') return labels.local
  if (actor.startsWith('key:')) return labels.key.replace('{name}', actor.slice(4))
  return actor
}

/**
 * Add the tags typed into a tag input (split at `,` `，` and line breaks) to `current`: trimmed, cut to
 * KB_MAX_TAG_LEN, no duplicates, at most KB_MAX_ENTRY_TAGS. `full` = something was left out because of the limit.
 */
export function addTagsFromInput(current: readonly string[], input: string, max = KB_MAX_ENTRY_TAGS): { tags: string[], full: boolean } {
  const tags = [...current]
  let full = false
  for (const raw of input.split(/[,，\r\n]/)) {
    const tag = raw.trim().slice(0, KB_MAX_TAG_LEN)
    if (!tag || tags.includes(tag)) continue
    if (tags.length >= max) { full = true; continue }
    tags.push(tag)
  }
  return { tags, full }
}

/** Tags in `to` that are not in `from` (added) and the other way round (removed). */
export function diffTags(from: readonly string[], to: readonly string[]): { added: string[], removed: string[] } {
  return { added: to.filter(x => !from.includes(x)), removed: from.filter(x => !to.includes(x)) }
}

/** Whether two tag lists hold the same tags in the same order. */
export const sameTags = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The current entry a PATCH / revert answered with after a stale `baseVersion` (HTTP 409): the server puts
 * `{ code: 'version_conflict', current }` in the error's `data`, which `$fetch` nests one level in its body.
 */
export function conflictOf<T>(e: unknown): T | null {
  const body = (e as { data?: { data?: unknown } & Record<string, unknown> } | null)?.data
  for (const d of [body?.data, body]) {
    const x = d as { code?: unknown, current?: T } | undefined
    if (x && x.code === 'version_conflict' && x.current) return x.current
  }
  return null
}
