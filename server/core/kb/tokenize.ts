// Pre-tokenizer for the FTS5 index (decision 65 ④). SQLite's unicode61 tokenizer cannot split Chinese, so the text is
// tokenized here and stored space-joined: a run of CJK characters becomes overlapping character bigrams (a single
// character when the run has length one), latin letters and digits become lowercase words. The same function is used
// for indexing and for queries.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD = /[\p{L}\p{N}\p{M}]/u

export function tokenize(text: string): string[] {
  const out: string[] = []
  let word = ''
  let run: string[] = []
  const flushWord = () => {
    if (word) out.push(word.toLowerCase())
    word = ''
  }
  const flushRun = () => {
    if (run.length === 1) out.push(run[0]!)
    else for (let i = 0; i + 1 < run.length; i++) out.push(run[i]! + run[i + 1]!)
    run = []
  }
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord()
      run.push(ch)
    } else if (WORD.test(ch)) {
      flushRun()
      word += ch
    } else {
      flushWord()
      flushRun()
    }
  }
  flushWord()
  flushRun()
  return out
}

/** The text stored in the FTS table. */
export const indexText = (text: string): string => tokenize(text).join(' ')

const MAX_QUERY_TOKENS = 64

/**
 * An FTS5 MATCH expression for a user query: the distinct tokens, each in double quotes (so no FTS operator or
 * column filter in the input is ever interpreted), joined with OR. null when the query has no token.
 */
export function ftsMatch(query: string): string | null {
  const tokens = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TOKENS)
  if (!tokens.length) return null
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}
