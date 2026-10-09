// upstreams.json + secrets.json: one change in two files (decision 56 ⑧).
import { expect, test } from 'bun:test'
import { createUpstream, defaultUpstreams, saveUpstreamsAndKeys, UpstreamError, type UpstreamFiles, type UpstreamsDoc } from '../../server/core/upstreams'
import { defaultSecrets, type SecretsDoc } from '../../server/core/keys'

function files(opts: { failSecrets?: boolean, failRollback?: boolean } = {}) {
  let up: UpstreamsDoc = defaultUpstreams()
  createUpstream(up, { name: 'Strata', baseUrl: 'http://old.example/v1' }, { localNames: [], selfPorts: [] })
  const id = up.upstreams[0]!.id
  const secrets: SecretsDoc = defaultSecrets()
  secrets.upstreamKeys[id] = 'old-key'
  let upstreamWrites = 0
  const f: UpstreamFiles = {
    getUpstreams: () => up,
    updateUpstreams(fn) {
      upstreamWrites++
      if (opts.failRollback && upstreamWrites > 1) throw new Error('rollback EIO')
      const draft = structuredClone(up)
      up = fn(draft) ?? draft
      return up
    },
    updateSecrets(fn) {
      if (opts.failSecrets) throw new Error('secrets EIO')
      fn(secrets)
      return secrets
    },
  }
  return { f, id, up: () => up, secrets }
}

const edit = (id: string) => [
  (d: UpstreamsDoc) => { d.upstreams.find(u => u.id === id)!.baseUrl = 'http://new.example/v1' },
  (s: SecretsDoc) => { s.upstreamKeys[id] = 'new-key' },
] as const

test('both writes succeed: the new address and the new key', () => {
  const t = files()
  saveUpstreamsAndKeys(t.f, ...edit(t.id))
  expect(t.up().upstreams[0]!.baseUrl).toBe('http://new.example/v1')
  expect(t.secrets.upstreamKeys[t.id]).toBe('new-key')
})

test('the key write fails: the address goes back, the original error is thrown', () => {
  const t = files({ failSecrets: true })
  expect(() => saveUpstreamsAndKeys(t.f, ...edit(t.id))).toThrow('secrets EIO')
  expect(t.up().upstreams[0]!.baseUrl).toBe('http://old.example/v1')
  expect(t.secrets.upstreamKeys[t.id]).toBe('old-key')
})

test('the key write fails and so does the put-back: reported as rollback-failed, not swallowed', () => {
  const t = files({ failSecrets: true, failRollback: true })
  let err: unknown
  try { saveUpstreamsAndKeys(t.f, ...edit(t.id)) } catch (e) { err = e }
  expect(err).toBeInstanceOf(UpstreamError)
  expect((err as UpstreamError).code).toBe('rollback-failed')
  expect((err as UpstreamError).detail).toContain('secrets EIO')
  expect((err as UpstreamError).detail).toContain('rollback EIO')
})
