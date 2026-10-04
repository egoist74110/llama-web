// MTP form values translate to the existing profile args and model-level draft reference.
import { splitArgs } from './args'
import type { FileRef } from './types'

export const MTP_DEFAULT_N = 3
export const MTP_MAX_N = 16
export type MtpMode = 'builtin' | 'file'
export interface MtpInput { enabled: boolean, mode: MtpMode | null, n: number, draft: FileRef | null }

const FLAGS = new Set(['--spec-type', '--spec-draft-n-max', '--model-draft', '-md'])
const flagOf = (token: string) => token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=')) : token

/** Remove only the current profile's MTP controls; other arguments keep their values. */
export function stripMtpArgs(extra: string): string {
  let tokens: string[]
  try { tokens = splitArgs(extra) } catch { return extra }
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!FLAGS.has(flagOf(token))) { out.push(token); continue }
    if (flagOf(token) === token && tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith('-')) i++
  }
  return out.map(a => /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ')
}

/** Read saved choices, never infer model support from scanned candidates. */
export function readMtp(extra: string, draft: FileRef | null): MtpInput {
  const values: Record<string, string> = {}
  try {
    const tokens = splitArgs(extra)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!, flag = flagOf(token)
      if (!FLAGS.has(flag)) continue
      values[flag] = flag !== token ? token.slice(token.indexOf('=') + 1) : tokens[++i] ?? ''
    }
  } catch { /* Preserve malformed legacy text until the user edits it. */ }
  const enabled = values['--spec-type'] === 'draft-mtp'
  return { enabled, mode: enabled ? (draft || values['--model-draft'] || values['-md'] ? 'file' : 'builtin') : null,
    n: values['--spec-draft-n-max'] === undefined ? MTP_DEFAULT_N : Number(values['--spec-draft-n-max']), draft }
}

export function mtpValid(input: MtpInput): boolean {
  if (typeof input.enabled !== 'boolean') return false
  if (!Number.isInteger(input.n) || input.n < 1 || input.n > MTP_MAX_N) return false
  if (!input.enabled) return true
  if (input.mode !== 'builtin' && input.mode !== 'file') return false
  return input.mode === 'builtin' ? input.draft === null
    : !!input.draft && typeof input.draft.dirId === 'string' && typeof input.draft.rel === 'string'
}

export function mtpExtraArgs(extra: string, input: MtpInput): string {
  const rest = stripMtpArgs(extra)
  return input.enabled ? [rest, `--spec-type draft-mtp --spec-draft-n-max ${input.n}`].filter(Boolean).join(' ') : rest
}

export const fileDirectory = (ref: FileRef) => ref.rel.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
export const sameDirectory = (a: FileRef, b: FileRef) => a.dirId === b.dirId && fileDirectory(a) === fileDirectory(b)
