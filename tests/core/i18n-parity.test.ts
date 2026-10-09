// Stage 11 (decision 18): compare the English dictionary with the Chinese source of truth.
//
// Hard failure since work package 11-4: the three translation batches are done, so every finding
// below (a missing key, an invented key, a shape or placeholder mismatch, CJK left in English, an
// empty string) fails the test. The findings are still printed, so a failure says what is wrong.
import { describe, expect, test } from 'bun:test'
import zh from '../../i18n/zh-CN'
import { enSkeleton } from '../../i18n/en'
import { dictionaries } from '../../i18n/messages'

/** The three translation batches are done (11-2 to 11-3): the gaps are failures, not warnings. */
const TRANSLATION_DONE = true

/** CJK ideographs, Japanese kana, Korean hangul and the full-width punctuation written with them. */
const CJK = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/

interface Leaf {
  kind: 'string' | 'array'
  /** 1 for a string, the number of entries for an array. */
  length: number
  text: string
}

/** The text inside an array entry: its own text, plus the text of everything nested in it. */
function collect(node: unknown, into: string[]): void {
  if (typeof node === 'string') into.push(node)
  else if (Array.isArray(node)) for (const entry of node) collect(entry, into)
  else if (node && typeof node === 'object') for (const key of Object.keys(node)) collect(node[key], into)
}

/**
 * Every string leaf and every array leaf of a dictionary, keyed by its key path. An array stays one
 * leaf - its entry count is its shape - but its entries are walked as well, so a field written
 * inside an array entry (`tunnel.guide.steps[0].title`) is checked like any other key: the field
 * names, the placeholders, CJK left in English and empty strings all apply to it.
 */
function leaves(node: unknown, path: string, out: Map<string, Leaf>): Map<string, Leaf> {
  if (typeof node === 'string') out.set(path, { kind: 'string', length: 1, text: node })
  else if (Array.isArray(node)) {
    const nested: string[] = []
    collect(node, nested)
    out.set(path, { kind: 'array', length: node.length, text: nested.join('\n') })
    // The array is still one leaf (its entry count is its shape), but every entry is walked too:
    // a field written inside an array entry is a key of its own and is checked like any other key.
    node.forEach((entry, i) => leaves(entry, `${path}[${i}]`, out))
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) leaves(node[key], path ? `${path}.${key}` : key, out)
  }
  return out
}

/** The `{name}`-style placeholders of a text, in a stable order (same rule as `fmt()`). */
const placeholders = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',')

const zhLeaves = leaves(zh, '', new Map<string, Leaf>())
const enLeaves = leaves(enSkeleton, '', new Map<string, Leaf>())
const resolvedLeaves = leaves(dictionaries.en, '', new Map<string, Leaf>())

const missing: string[] = []
const invented: string[] = []
const shapeProblems: string[] = []
const placeholderProblems: string[] = []
const cjkProblems: string[] = []
const emptyProblems: string[] = []

for (const path of zhLeaves.keys()) if (!enLeaves.has(path)) missing.push(path)
for (const [path, leaf] of enLeaves) {
  const source = zhLeaves.get(path)
  if (!source) {
    invented.push(path)
    continue
  }
  if (leaf.kind !== source.kind || leaf.length !== source.length) shapeProblems.push(`${path}: ${leaf.kind} of ${leaf.length}, expected ${source.kind} of ${source.length}`)
  if (placeholders(leaf.text) !== placeholders(source.text)) placeholderProblems.push(`${path}: "{${placeholders(leaf.text)}}" instead of "{${placeholders(source.text)}}"`)
  if (CJK.test(leaf.text)) cjkProblems.push(path)
  if (!leaf.text.trim()) emptyProblems.push(path)
}

describe('i18n parity (zh-CN vs en)', () => {
  test('the resolved English dictionary has exactly the Chinese keys in the same shape', () => {
    expect([...resolvedLeaves.keys()].sort()).toEqual([...zhLeaves.keys()].sort())
    for (const [path, leaf] of resolvedLeaves) {
      const source = zhLeaves.get(path)!
      expect([leaf.kind, leaf.length]).toEqual([source.kind, source.length])
    }
  })

  test('what has been written in English so far is valid: no invented key, no empty string, no CJK, same placeholders', () => {
    expect(invented).toEqual([])
    expect(shapeProblems).toEqual([])
    expect(placeholderProblems).toEqual([])
    expect(cjkProblems).toEqual([])
    expect(emptyProblems).toEqual([])
  })

  test('the whole Chinese dictionary is translated: the gaps are reported and fail the test', () => {
    const done = zhLeaves.size - missing.length
    const notes = [
      `en covers ${done} / ${zhLeaves.size} Chinese keys`,
      missing.length ? `missing ${missing.length}, first: ${missing.slice(0, 4).join(', ')}` : 'complete',
      invented.length ? `invented: ${invented.join(', ')}` : '',
      shapeProblems.length ? `shape: ${shapeProblems.join('; ')}` : '',
      placeholderProblems.length ? `placeholders: ${placeholderProblems.join('; ')}` : '',
      cjkProblems.length ? `CJK left in en: ${cjkProblems.join('; ')}` : '',
      emptyProblems.length ? `empty: ${emptyProblems.join('; ')}` : '',
    ].filter(Boolean)
    console.warn(`i18n parity: ${notes.join(' | ')}`)
    if (!TRANSLATION_DONE) return
    expect(missing).toEqual([])
    expect(invented).toEqual([])
    expect(shapeProblems).toEqual([])
    expect(placeholderProblems).toEqual([])
    expect(cjkProblems).toEqual([])
    expect(emptyProblems).toEqual([])
  })
})
