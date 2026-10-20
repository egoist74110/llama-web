// Knowledge base text handling (decision 65 ③ ④): decoding, chunking, tokenizing and FTS query escaping. Pure functions.
import { describe, expect, test } from 'bun:test'
import { decodeText } from '../../server/core/kb/text'
import { chunkText } from '../../server/core/kb/chunk'
import { ftsMatch, indexText, tokenize } from '../../server/core/kb/tokenize'
import { fuseRrf } from '../../server/core/kb/search'
import { KbError } from '../../server/core/kb/errors'

const bytes = (...n: number[]) => new Uint8Array(n)

describe('decoding', () => {
  test('UTF-8 with and without BOM, CRLF normalised', () => {
    const plain = new TextEncoder().encode('你好\r\n世界\r第三行')
    expect(decodeText(plain)).toEqual({ text: '你好\n世界\n第三行', encoding: 'utf-8' })
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain])
    expect(decodeText(bom).text).toBe('你好\n世界\n第三行')
  })

  test('UTF-16 by BOM, both byte orders', () => {
    const le = bytes(0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59) // 你好
    const be = bytes(0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d)
    expect(decodeText(le)).toEqual({ text: '你好', encoding: 'utf-16le' })
    expect(decodeText(be)).toEqual({ text: '你好', encoding: 'utf-16be' })
  })

  test('GB18030 when the bytes are not valid UTF-8', () => {
    // 中文 in GBK / GB18030
    expect(decodeText(bytes(0xd6, 0xd0, 0xce, 0xc4))).toEqual({ text: '中文', encoding: 'gb18030' })
    // with latin text around it
    expect(decodeText(bytes(0x41, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x42)).text).toBe('A 你好\nB')
  })

  test('binary data is refused', () => {
    expect(() => decodeText(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x01))).toThrow(KbError)
  })
})

describe('chunker', () => {
  const para = (i: number) => `第${i}段：这是一段用来测试分块的中文文字，长度不长。`

  test('every chunk is an exact slice of the text and carries its 1-based start line', () => {
    const text = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n')
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 200, overlap: 40 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(text.slice(c.startChar, c.endChar)).toBe(c.text)
      expect(c.text.length).toBeLessThanOrEqual(200)
      const line = text.slice(0, c.startChar).split('\n').length
      expect(c.startLine).toBe(line)
    }
    expect(chunks.map(c => c.ord)).toEqual(chunks.map((_, i) => i))
    expect(chunks[0]!.startLine).toBe(1)
  })

  test('small paragraphs are merged and neighbouring chunks overlap by whole paragraphs', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n')
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 100, overlap: 40 })
    expect(chunks[0]!.text).toContain('第0段')
    expect(chunks[0]!.text).toContain('第1段') // merged
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!
      const cur = chunks[i]!
      expect(cur.startChar).toBeLessThan(prev.endChar) // overlap
      expect(cur.startChar).toBeGreaterThan(prev.startChar) // and progress
    }
    // everything is covered
    const covered = new Set<number>()
    for (const c of chunks) for (let p = c.startChar; p < c.endChar; p++) covered.add(p)
    for (let p = 0; p < text.length; p++) if (text[p] !== '\n') expect(covered.has(p)).toBe(true)
  })

  test('a paragraph without blank lines is split at sentence ends', () => {
    const sentence = '这是一句比较完整的中文句子，用来测试按句切分。'
    const text = Array.from({ length: 20 }, () => sentence).join('')
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 100, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(100)
      expect(c.text.endsWith('。')).toBe(true)
    }
    expect(chunks.map(c => c.text).join('')).toBe(text)
  })

  test('single-newline Chinese text (no blank lines) still splits by line', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}行的内容在这里`).join('\n')
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 100, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[1]!.startLine).toBeGreaterThan(1)
    for (const c of chunks) expect(text.slice(c.startChar, c.endChar)).toBe(c.text)
  })

  test('a sentence longer than the chunk is cut hard with the overlap shared', () => {
    const text = 'x'.repeat(1000)
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 300, overlap: 50 })
    expect(chunks.map(c => [c.startChar, c.endChar])).toEqual([[0, 300], [250, 550], [500, 800], [750, 1000]])
  })

  test('a hard cut does not split a surrogate pair', () => {
    const text = '𠀀'.repeat(400) // 800 UTF-16 units, no sentence end
    const chunks = chunkText(text, { kind: 'txt', chunkSize: 301, overlap: 10 })
    for (const c of chunks) {
      expect(c.text.length % 2).toBe(0)
      expect(c.text).toBe(text.slice(c.startChar, c.endChar))
    }
  })

  test('markdown: heading path, sections never share a chunk, fenced # is not a heading', () => {
    const md = [
      '前言文字。', '', '# 总览', '总览的内容。', '', '## 安装', '安装步骤一。', '', '```sh', '# not a heading', '```', '',
      '## 使用', '使用说明。', '', '# 附录', '附录内容。',
    ].join('\n')
    const chunks = chunkText(md, { kind: 'md', chunkSize: 500, overlap: 50 })
    expect(chunks.map(c => c.headingPath)).toEqual(['', '总览', '总览 > 安装', '总览 > 使用', '附录'])
    const install = chunks[2]!
    expect(install.text).toContain('# not a heading')
    expect(install.text.startsWith('## 安装')).toBe(true)
    expect(md.slice(install.startChar, install.endChar)).toBe(install.text)
    expect(install.startLine).toBe(6)
    expect(chunks[4]!.text).toContain('附录内容')
  })

  test('empty and blank text give no chunks', () => {
    expect(chunkText('', { kind: 'txt', chunkSize: 100, overlap: 10 })).toEqual([])
    expect(chunkText('\n\n  \n', { kind: 'md', chunkSize: 100, overlap: 10 })).toEqual([])
  })
})

describe('tokenizer', () => {
  test('CJK runs become overlapping bigrams, a lone character stays single', () => {
    expect(tokenize('你好世界')).toEqual(['你好', '好世', '世界'])
    expect(tokenize('好')).toEqual(['好'])
    expect(tokenize('你好，世界')).toEqual(['你好', '世界']) // punctuation breaks the run
  })

  test('latin and digits become lowercase words; scripts mix', () => {
    expect(tokenize('Hello, World-2024 v1.2')).toEqual(['hello', 'world', '2024', 'v1', '2'])
    expect(tokenize('用Bun运行llama.cpp')).toEqual(['用', 'bun', '运行', 'llama', 'cpp'])
    expect(indexText('AI 模型')).toBe('ai 模型')
  })

  test('FTS query: tokens quoted and OR-ed; operators in the input are inert', () => {
    expect(ftsMatch('你好世界')).toBe('"你好" OR "好世" OR "世界"')
    expect(ftsMatch('   ')).toBeNull()
    expect(ftsMatch('!!! ...')).toBeNull()
    for (const evil of ['"quoted" AND NOT', 'foo*', 'NEAR(a b)', '(a OR b)', 'col:value', 'a" OR "b', '-x ^y', "it's"]) {
      const m = ftsMatch(evil)!
      expect(m).toBeTruthy()
      // every term is a double-quoted token of letters and digits only
      for (const term of m.split(' OR ')) expect(term).toMatch(/^"[\p{L}\p{N}\p{M}]+"$/u)
    }
  })

  test('same tokens at index and query time (a CJK substring matches)', () => {
    const doc = new Set(tokenize('向量引擎负责把文字变成向量'))
    for (const t of tokenize('文字变成')) expect(doc.has(t)).toBe(true)
  })
})

describe('rank fusion', () => {
  test('reciprocal rank fusion with k = 60', () => {
    const r = fuseRrf([['a', 'b', 'c'], ['b', 'd']])
    expect(r.map(x => x.key)).toEqual(['b', 'a', 'd', 'c'])
    expect(r[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 10)
    expect(r[1]!.score).toBeCloseTo(1 / 61, 10)
    expect(fuseRrf([])).toEqual([])
  })
})
