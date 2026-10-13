// Minimal byte-level multipart/form-data handling for /v1 routing: read the `model` text field and,
// for external upstreams, rewrite it. Every other part (headers and body) is copied byte for byte;
// nothing is decoded beyond the part headers, so file contents are never parsed or logged.

const CRLF = new Uint8Array([13, 10])
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Boundary of a multipart/form-data content type, or null when it is not one. */
export function multipartBoundary(contentType: string): string | null {
  const [type, ...params] = contentType.split(';')
  if (type?.trim().toLowerCase() !== 'multipart/form-data') return null
  for (const p of params) {
    const m = /^\s*boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))\s*$/i.exec(p)
    if (m) {
      const b = m[1] ?? m[2]!
      return b.length >= 1 && b.length <= 70 ? b : null
    }
  }
  return null
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]
  const last = hay.length - needle.length
  outer: for (let i = hay.indexOf(first!, from); i !== -1 && i <= last; i = hay.indexOf(first!, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

export interface MultipartPart {
  /** Raw part header block (without the blank line). */
  head: Uint8Array
  body: Uint8Array
  /** `name` of the Content-Disposition header, when there is one. */
  name: string | null
  /** True when the part carries a filename (a file, not a text field). */
  file: boolean
}

function dispositionOf(head: string): { name: string | null, file: boolean } {
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    if (i < 0 || line.slice(0, i).trim().toLowerCase() !== 'content-disposition') continue
    const v = line.slice(i + 1)
    const name = /;\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/i.exec(v)
    return {
      name: name ? (name[1] ?? name[2]!).replace(/\\(.)/g, '$1') : null,
      file: /;\s*filename\*?\s*=/i.test(v),
    }
  }
  return { name: null, file: false }
}

/** The parts of a multipart body, or null when it is malformed (no closing delimiter, a part without headers). */
export function parseMultipart(raw: Uint8Array, boundary: string): MultipartPart[] | null {
  const dash = enc.encode(`--${boundary}`)
  const delim = enc.encode(`\r\n--${boundary}`)
  // The first delimiter may start the body or follow a preamble.
  let pos: number
  if (indexOf(raw.subarray(0, dash.length), dash, 0) === 0) pos = dash.length
  else {
    const at = indexOf(raw, delim, 0)
    if (at < 0) return null
    pos = at + delim.length
  }
  const parts: MultipartPart[] = []
  for (;;) {
    if (raw[pos] === 45 && raw[pos + 1] === 45) return parts // closing `--`
    // Transport padding (spaces / tabs) before the line break is allowed.
    while (raw[pos] === 32 || raw[pos] === 9) pos++
    if (raw[pos] !== 13 || raw[pos + 1] !== 10) return null
    pos += 2
    const next = indexOf(raw, delim, pos)
    if (next < 0) return null
    const part = raw.subarray(pos, next)
    const split = indexOf(part, enc.encode('\r\n\r\n'), 0)
    let head: Uint8Array
    let body: Uint8Array
    if (split >= 0) { head = part.subarray(0, split); body = part.subarray(split + 4) }
    else if (part.length >= 2 && part[0] === 13 && part[1] === 10) { head = part.subarray(0, 0); body = part.subarray(2) }
    else return null
    parts.push({ head, body, ...dispositionOf(dec.decode(head)) })
    pos = next + delim.length
  }
}

/** Value of the text field `name` (the first one), or undefined. */
export function multipartField(parts: MultipartPart[], name: string): string | undefined {
  const p = parts.find(x => x.name === name && !x.file)
  return p ? dec.decode(p.body) : undefined
}

function newBoundary(parts: MultipartPart[]): string {
  for (;;) {
    const b = `----llama-web-${crypto.randomUUID().replace(/-/g, '')}`
    const needle = enc.encode(b)
    if (parts.every(p => indexOf(p.head, needle, 0) < 0 && indexOf(p.body, needle, 0) < 0)) return b
  }
}

/**
 * The body again with the text field `name` set to `value` (every other part copied byte for byte), under a new boundary.
 * Returns the bytes and the content type to send with them.
 */
export function rewriteMultipartField(parts: MultipartPart[], name: string, value: string): { body: Uint8Array<ArrayBuffer>, contentType: string } {
  const boundary = newBoundary(parts)
  const dash = enc.encode(`--${boundary}`)
  const target = parts.findIndex(x => x.name === name && !x.file)
  const chunks: Uint8Array[] = []
  parts.forEach((p, i) => {
    chunks.push(dash, CRLF)
    if (p.head.length) chunks.push(p.head, CRLF)
    chunks.push(CRLF, i === target ? enc.encode(value) : p.body, CRLF)
  })
  chunks.push(dash, enc.encode('--'), CRLF)
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const body = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { body.set(c, off); off += c.byteLength }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}
