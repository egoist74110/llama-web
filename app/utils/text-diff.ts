// Line diff for the knowledge base history view (decision 69). Pure, no Nitro / DOM.

export type DiffOp = 'same' | 'add' | 'del'
export interface DiffRow { op: DiffOp, text: string }
/** A folded run of unchanged lines, or one row. */
export type FoldedRow = DiffRow | { op: 'fold', rows: DiffRow[] }

/** Above this many cells (lines of a x lines of b, after the common head and tail are cut) the LCS is skipped. */
export const MAX_DIFF_CELLS = 4_000_000

/** Text -> lines; CRLF counts as LF; the empty text has no lines. */
const linesOf = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'))

/**
 * Line-by-line diff of two texts (LCS). Removed lines come before the added ones of the same change.
 * When the part that differs is too big for the LCS table it degrades to "all removed, then all added".
 */
export function diffLines(a: string, b: string): DiffRow[] {
  const x = linesOf(a)
  const y = linesOf(b)
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const midA = x.slice(head, x.length - tail)
  const midB = y.slice(head, y.length - tail)

  const out: DiffRow[] = []
  for (let i = 0; i < head; i++) out.push({ op: 'same', text: x[i]! })
  for (const row of diffMiddle(midA, midB)) out.push(row)
  for (let i = x.length - tail; i < x.length; i++) out.push({ op: 'same', text: x[i]! })
  return out
}

function diffMiddle(a: string[], b: string[]): DiffRow[] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) {
    return [...a.map((text): DiffRow => ({ op: 'del', text })), ...b.map((text): DiffRow => ({ op: 'add', text }))]
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..], in one flat array.
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }
  const out: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i]! }); i++; j++ }
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push({ op: 'del', text: a[i++]! })
    else out.push({ op: 'add', text: b[j++]! })
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! })
  while (j < m) out.push({ op: 'add', text: b[j++]! })
  return out
}

/**
 * Fold runs of unchanged lines longer than 2 x `context`: `context` lines stay next to a change, the rest of the
 * run becomes one `fold` item (expandable in the view). Without any change a long text folds as a whole.
 */
export function foldSame(rows: readonly DiffRow[], context = 3): FoldedRow[] {
  const out: FoldedRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.op !== 'same') { out.push(rows[i]!); i++; continue }
    let end = i
    while (end < rows.length && rows[end]!.op === 'same') end++
    const run = rows.slice(i, end)
    if (run.length <= 2 * context) {
      out.push(...run)
    } else {
      const before = i > 0 ? context : 0
      const after = end < rows.length ? context : 0
      out.push(...run.slice(0, before))
      out.push({ op: 'fold', rows: run.slice(before, run.length - after) })
      out.push(...run.slice(run.length - after))
    }
    i = end
  }
  return out
}
