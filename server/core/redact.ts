// Keeps a saved upstream key out of anything an external upstream sends back (decision 56 ④): an upstream that
// echoes the Authorization header in an error message or a debug header must not hand the key to the client.
// Pure module. Only an exact occurrence of the key is replaced (whatever its length: a saved key is always masked);
// everything else passes through unchanged. An empty key means there is no credential.

export const REDACTED = '***'

const enc = new TextEncoder()

export function redactText(text: string, key: string): string {
  return key ? text.split(key).join(REDACTED) : text
}

export function redactHeaders(h: Headers, key: string): Headers {
  if (!key) return h
  const out = new Headers()
  h.forEach((v, k) => out.append(k, redactText(v, key)))
  return out
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Length of the longest suffix of `buf` that is a proper prefix of `needle` (a key that may continue in the next chunk). */
function partialTail(buf: Uint8Array, needle: Uint8Array): number {
  for (let n = Math.min(needle.length - 1, buf.length); n > 0; n--) {
    let same = true
    for (let j = 0; j < n; j++) if (buf[buf.length - n + j] !== needle[j]) { same = false; break }
    if (same) return n
  }
  return 0
}

/**
 * Chunk-by-chunk masking of `key` in a byte stream, also when the key is split across chunks. Only a tail that could
 * be the start of the key is held back until the next chunk, so ordinary streaming is not delayed.
 */
export class StreamRedactor {
  private readonly needle: Uint8Array
  private readonly mask = enc.encode(REDACTED)
  private carry: Uint8Array = new Uint8Array(0)
  readonly active: boolean

  constructor(key: string) {
    this.active = key.length > 0
    this.needle = enc.encode(key)
  }

  push(chunk: Uint8Array): Uint8Array {
    if (!this.active) return chunk
    const buf = new Uint8Array(this.carry.length + chunk.length)
    buf.set(this.carry, 0)
    buf.set(chunk, this.carry.length)
    const parts: Uint8Array[] = []
    let from = 0
    for (;;) {
      const at = indexOf(buf, this.needle, from)
      if (at < 0) break
      parts.push(buf.subarray(from, at), this.mask)
      from = at + this.needle.length
    }
    const rest = buf.subarray(from)
    const hold = partialTail(rest, this.needle)
    parts.push(rest.subarray(0, rest.length - hold))
    this.carry = rest.slice(rest.length - hold)
    return concat(parts)
  }

  /** The held-back tail at the end of the stream (it turned out not to be the key). */
  flush(): Uint8Array {
    const out = this.carry
    this.carry = new Uint8Array(0)
    return out
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
