import { describe, expect, test } from 'bun:test'
import type { ModelConfig, ModelsDoc } from '../../server/core/config'
import { isLoopbackHost } from '../../server/core/folder-picker'
import { describeModels } from '../../server/core/live'
import { applyFirstSetup, planEnable, ProfileError, stripMtpArgs, type FirstSetup } from '../../server/core/models-admin'
import type { ScanEntry } from '../../server/core/scanner'

const ref = (rel: string) => ({ dirId: 'main', rel })
const entry = (rel: string, kind: ScanEntry['kind'] = 'model'): ScanEntry => ({
  kind, ref: ref(rel), fileName: rel.split('/').pop()!, size: 1, shards: null, complete: true, meta: null, error: null,
  candidates: { mmproj: [], draft: [] },
})
const entries = [entry('q/m.gguf'), entry('q/mmproj-F16.gguf', 'mmproj'), entry('q/m-mtp.gguf', 'draft'), entry('q/other.gguf')]

function fresh(): ModelsDoc {
  const doc: ModelsDoc = { version: 1, models: [] }
  doc.models.push(planEnable(entries[0], doc))
  return doc
}
const answers = (over: Partial<FirstSetup> = {}): FirstSetup => ({ thinking: true, mmproj: null, mtp: false, mtpMode: 'builtin', draft: null, mtpN: 3, ...over })
const profile = (doc: ModelsDoc) => doc.models[0]!.profiles['默认']!

describe('first-start answers', () => {
  test('a model enabled from a scan starts unconfirmed and shows up as needing setup', () => {
    const doc = fresh()
    expect(doc.models[0]!.confirmed).toBe(false)
    expect(describeModels(doc)[0]!.needsSetup).toBe(true)
    expect(describeModels({ version: 1, models: [{ ...doc.models[0]!, confirmed: undefined } as ModelConfig] })[0]!.needsSetup).toBe(false)
  })

  test('thinking on / off, vision and MTP with a separate file are stored on the model and profile', () => {
    const doc = fresh()
    applyFirstSetup(doc, doc.models[0]!.id, answers({ thinking: false, mmproj: ref('q/mmproj-F16.gguf'), mtp: true, mtpMode: 'file', draft: ref('q/m-mtp.gguf'), mtpN: 4 }), entries)
    const m = doc.models[0]!
    expect(m.confirmed).toBe(true)
    expect(m.mmproj).toEqual(ref('q/mmproj-F16.gguf'))
    expect(m.draft).toEqual(ref('q/m-mtp.gguf'))
    expect(profile(doc).overrides.reasoning).toBe('off')
    expect(profile(doc).extraArgs).toBe('--spec-type draft-mtp --spec-draft-n-max 4')
    expect(describeModels(doc)[0]!.needsSetup).toBe(false)
  })

  test('thinking on is unlimited; built-in MTP needs no file; answering again does not duplicate flags', () => {
    const doc = fresh()
    profile(doc).extraArgs = '--jinja --spec-type draft-mtp --spec-draft-n-max 2 --props'
    applyFirstSetup(doc, doc.models[0]!.id, answers({ mtp: true, mtpN: 3 }), entries)
    expect(profile(doc).overrides).toMatchObject({ reasoning: 'on', reasoningBudget: -1 })
    expect(doc.models[0]!.draft).toBeNull()
    expect(profile(doc).extraArgs).toBe('--jinja --props --spec-type draft-mtp --spec-draft-n-max 3')
  })

  test('MTP off removes the flags and the draft file', () => {
    const doc = fresh()
    doc.models[0]!.draft = ref('q/m-mtp.gguf')
    profile(doc).extraArgs = '--spec-type draft-mtp --spec-draft-n-max 3 --jinja'
    applyFirstSetup(doc, doc.models[0]!.id, answers({ mtp: false, draft: ref('q/m-mtp.gguf') }), entries)
    expect(doc.models[0]!.draft).toBeNull()
    expect(profile(doc).extraArgs).toBe('--jinja')
  })

  test('refuses a bad multiplier or a file of the wrong kind, changing nothing', () => {
    const doc = fresh()
    const code = (a: FirstSetup) => { try { applyFirstSetup(doc, doc.models[0]!.id, a, entries) } catch (e) { return (e as { code?: string }).code } return 'none' }
    expect(code(answers({ mtpN: 0 }))).toBe('bad-setup')
    expect(code(answers({ mtpN: 2.5 }))).toBe('bad-setup')
    expect(code(answers({ mmproj: ref('q/other.gguf') }))).toBe('wrong-kind')
    expect(code(answers({ mmproj: ref('q/nope.gguf') }))).toBe('file-not-found')
    expect(doc.models[0]!.confirmed).toBe(false)
    expect(doc.models[0]!.mmproj).toBeNull()
    expect(ProfileError).toBeDefined()
  })

  test('stripMtpArgs keeps other arguments, quoted values and --flag=value forms', () => {
    expect(stripMtpArgs('--jinja --spec-type=draft-mtp -fit off --chat-template-file "C:\a b\t.jinja"')).toBe('--jinja -fit off --chat-template-file "C:\a b\t.jinja"')
    expect(stripMtpArgs('')).toBe('')
  })
})

describe('folder picker guard', () => {
  test('only loopback host names pass', () => {
    for (const h of ['localhost', 'localhost:5001', '127.0.0.1:5001', '[::1]:5001', 'LOCALHOST']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['192.168.1.5:5001', 'example.com', '127.0.0.1.evil.com', 'localhost.evil.com', '', null, undefined]) expect(isLoopbackHost(h)).toBe(false)
  })
})
