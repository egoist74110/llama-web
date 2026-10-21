// Tags of knowledge chunks (decision 65 ⑭). Pure helpers shared by the chunker (tag lines in a document), the search
// core and the binding / request validation.

/** A single tag is cut to this many characters. */
export const MAX_TAG_LEN = 64
/** Tags taken from one tag line. */
export const MAX_TAGS_PER_LINE = 20
/** Tags accepted in one filter (a search, a binding, a request). */
export const MAX_FILTER_TAGS = 50

/** A tag and the number of chunks that carry it. */
export interface TagCount {
  tag: string
  count: number
}

const TAG_LINE = /^[ \t]*\[tag:([^\]\r\n]*)\][ \t]*$/i

/**
 * Tags of a tag line (`[tag:a,b]`, the whole line), or null when `line` is not one. `[]` = the line clears the tags
 * (`[tag:]` or only empty values). Values split at `,` and `，`, are trimmed, deduplicated and kept in order.
 */
export function parseTagLine(line: string): string[] | null {
  const m = TAG_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
  if (!m) return null
  return dedupeTags(m[1]!.split(/[,，]/), MAX_TAGS_PER_LINE)
}

/** Trim, drop empty values, cut each to MAX_TAG_LEN, remove duplicates (first one wins) and keep at most `max`. */
export function dedupeTags(values: Iterable<string>, max: number): string[] {
  const out: string[] = []
  for (const v of values) {
    const tag = v.trim().slice(0, MAX_TAG_LEN)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/** A filter out of anything: only the strings of an array count; the result is clean (see `dedupeTags`). */
export function cleanTags(raw: unknown): string[] {
  return Array.isArray(raw) ? dedupeTags(raw.filter((x): x is string => typeof x === 'string'), MAX_FILTER_TAGS) : []
}

/** Similarity threshold out of anything: a finite number is clamped to 0..1, everything else means "off" (null). */
export function cleanSimilarity(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null
}
