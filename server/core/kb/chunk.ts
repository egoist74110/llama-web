// Chunking (decision 65 ③). Pure: decoded text in, chunks out. Every chunk is an exact slice of the text
// (`text === source.slice(startChar, endChar)`) so a hit can always point back at its place in the file.
//
// - Paragraphs are separated by blank lines. Markdown headings (outside code fences) also start a new section and the
//   chunks of a section carry its heading path ("A > B"); a chunk never crosses a section.
// - Neighbouring small paragraphs are merged up to `chunkSize` characters.
// - A paragraph longer than `chunkSize` is split at sentence ends (。！？!? and line breaks); a sentence that is still
//   longer is cut hard, with `overlap` characters shared between the pieces.
// - Between chunks of the same section the last whole units (paragraphs or sentences) that fit in `overlap` characters
//   are repeated at the start of the next chunk.

export interface Chunk {
  ord: number
  text: string
  /** Offsets into the decoded text (end exclusive). */
  startChar: number
  endChar: number
  /** 1-based line of startChar. */
  startLine: number
  headingPath: string
}

export interface ChunkOptions {
  kind: 'txt' | 'md'
  chunkSize: number
  overlap: number
}

interface Range { s: number, e: number }
interface Unit extends Range { solo?: boolean }
interface Section { headingPath: string, paras: Range[] }

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const FENCE = /^ {0,3}(```|~~~)/
const SENTENCE_END = '。！？!?；;'
const CLOSERS = '”’」』）)"\''

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

function sections(text: string, kind: 'txt' | 'md'): Section[] {
  const out: Section[] = [{ headingPath: '', paras: [] }]
  const stack: Array<{ level: number, title: string }> = []
  let para: Range | null = null
  let inFence = false
  const endPara = () => {
    if (para) out[out.length - 1]!.paras.push(para)
    para = null
  }
  let pos = 0
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos)
    if (nl < 0) nl = text.length
    const line = text.slice(pos, nl)
    const trimmed = line.trim()
    if (kind === 'md' && FENCE.test(line)) inFence = !inFence
    const heading = kind === 'md' && !inFence && !FENCE.test(line) ? HEADING.exec(line) : null
    if (!trimmed) {
      endPara()
    } else if (heading) {
      endPara()
      const level = heading[1]!.length
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop()
      stack.push({ level, title: heading[2]!.trim() })
      const last = out[out.length - 1]!
      const sec: Section = last.paras.length === 0 && last.headingPath === '' ? last : { headingPath: '', paras: [] }
      if (sec !== last) out.push(sec)
      sec.headingPath = stack.map(h => h.title).filter(Boolean).join(' > ')
      const lead = line.length - line.trimStart().length
      sec.paras.push({ s: pos + lead, e: pos + lead + trimmed.length })
    } else {
      const lead = line.length - line.trimStart().length
      const s = pos + lead
      const e = pos + lead + trimmed.length
      para = para ? { s: para.s, e } : { s, e }
    }
    if (nl >= text.length) break
    pos = nl + 1
  }
  endPara()
  return out.filter(s => s.paras.length)
}

/** Sentence ranges of `r` (trimmed). */
function sentences(text: string, r: Range): Range[] {
  const out: Range[] = []
  let start = r.s
  const push = (end: number) => {
    let s = start
    let e = end
    while (s < e && /\s/.test(text[s]!)) s++
    while (e > s && /\s/.test(text[e - 1]!)) e--
    if (e > s) out.push({ s, e })
  }
  for (let i = r.s; i < r.e; i++) {
    const c = text[i]!
    if (c === '\n') {
      push(i)
      start = i + 1
    } else if (SENTENCE_END.includes(c) || (c === '.' && (i + 1 >= r.e || /\s/.test(text[i + 1]!)))) {
      let j = i + 1
      while (j < r.e && (SENTENCE_END.includes(text[j]!) || CLOSERS.includes(text[j]!))) j++
      push(j)
      start = j
      i = j - 1
    }
  }
  push(r.e)
  return out
}

/** A range longer than `size` cut into pieces of at most `size` characters sharing `overlap` characters. */
function hardCut(text: string, r: Range, size: number, overlap: number): Unit[] {
  const out: Unit[] = []
  let i = r.s
  for (;;) {
    let s = i
    if (s > r.s && isLow(text.charCodeAt(s))) s++
    let e = Math.min(i + size, r.e)
    if (e < r.e && isHigh(text.charCodeAt(e - 1))) e--
    out.push({ s, e, solo: true })
    if (e >= r.e) break
    i = Math.max(e - overlap, i + 1)
  }
  return out
}

function unitsOf(text: string, paras: Range[], size: number, overlap: number): Unit[] {
  const units: Unit[] = []
  for (const p of paras) {
    if (p.e - p.s <= size) {
      units.push(p)
      continue
    }
    for (const s of sentences(text, p)) {
      if (s.e - s.s <= size) units.push(s)
      else units.push(...hardCut(text, s, size, overlap))
    }
  }
  return units
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const size = Math.max(1, Math.floor(opts.chunkSize))
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlap), size - 1))
  const lineStarts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1)
  const lineOf = (pos: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const chunks: Chunk[] = []
  for (const sec of sections(text, opts.kind)) {
    const emit = (s: number, e: number) => {
      chunks.push({ ord: chunks.length, text: text.slice(s, e), startChar: s, endChar: e, startLine: lineOf(s), headingPath: sec.headingPath })
    }
    let cur: Unit[] = []
    let fresh = 0
    const emitCur = () => emit(cur[0]!.s, cur[cur.length - 1]!.e)
    const carry = () => {
      const last = cur[cur.length - 1]!
      let from = cur.length
      // Never the first unit: every chunk must move forward.
      while (from > 1 && last.e - cur[from - 1]!.s <= overlap) from--
      return cur.slice(from)
    }
    for (const u of unitsOf(text, sec.paras, size, overlap)) {
      if (u.solo) {
        if (fresh > 0) emitCur()
        cur = []
        fresh = 0
        emit(u.s, u.e)
        continue
      }
      while (cur.length && u.e - cur[0]!.s > size) {
        if (fresh > 0) {
          emitCur()
          cur = carry()
          fresh = 0
        } else cur.shift()
      }
      cur.push(u)
      fresh++
    }
    if (fresh > 0) emitCur()
  }
  return chunks
}
