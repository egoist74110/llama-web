// Stage 11 (decision 18): compare the English dictionary with the Chinese source of truth.
//
// Warn-only while the translation is in progress (this is work package 11-1): the gaps are printed
// and the test passes. When the three translation batches are done, set TRANSLATION_DONE to true
// (work package 11-4) and the same findings become failures. What has already been written in
// English is checked hard either way.
import { describe, expect, test } from 'bun:test'
import zh from '../../i18n/zh-CN'
import { enSkeleton } from '../../i18n/en'
import { dictionaries } from '../../i18n/messages'

/** False while stage 11 is translating: report the gaps instead of failing on them. */
const TRANSLATION_DONE = false

/** CJK ideographs, Japanese kana, Korean hangul and the full-width punctuation written with them. */
const CJK = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/

interface Leaf {
  kind: 'string' | 'array'
  /** 1 for a string, the number of entries for an array. */
  length: number
  text: string
}

/** Every string leaf and every array leaf of a dictionary, keyed by its key path. */
function leaves(node: unknown, path: string, out: Map<string, Leaf>): Map<string, Leaf> {
  if (typeof node === 'string') out.set(path, { kind: 'string', length: 1, text: node })
  else if (Array.isArray(node)) out.set(path, { kind: 'array', length: node.length, text: node.join('\n') })
  else if (node && typeof node === 'object') {
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

  test('the gaps are reported, and only become failures once the three translation batches are done', () => {
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
