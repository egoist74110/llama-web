import { expect, test } from 'bun:test'
import type { MetricsDoc, StateDoc, StateInstance } from '../../server/core/live'
import { ctxNumber, instanceSpeed, pushTrend, quantFromFile, rankInstances, sparkArea, sparkPoints } from '../../app/utils/overview'

const inst = (profile: string, state: StateInstance['state']): StateInstance =>
  ({ profile, state, inflight: 0, error: null, failure: null, since: null, progress: null })

function doc(models: Array<{ id: string, instances: StateInstance[] }>): StateDoc {
  return {
    now: 0,
    models: models.map(m => ({
      id: m.id, name: m.id, activeProfile: 'default', profiles: ['default'], hasMmproj: false,
      files: { model: `d/${m.id}.gguf`, mmproj: null, draft: null }, missing: [], instances: m.instances,
    })),
    queue: [],
    llamacpp: { current: '', runtime: { state: 'idle' }, versions: [], rollback: null },
    tunnel: { status: { state: 'off', reason: 'disabled' }, cloudflared: null, hostnames: null },
    cloudflare: null,
    cloudflareRev: null,
    firstRun: false,
  } as StateDoc
}

const metrics = (active: MetricsDoc['speed']['active'], last: MetricsDoc['speed']['last'] = []): MetricsDoc =>
  ({ speed: { active, last }, gpu: { available: false, gpus: [] } })

test('rankInstances puts the generating instance first, then ready, loading and failed ones', () => {
  const s = doc([
    { id: 'a', instances: [inst('default', 'failed')] },
    { id: 'b', instances: [inst('default', 'loading')] },
    { id: 'c', instances: [inst('default', 'ready'), inst('long', 'ready')] },
  ])
  expect(rankInstances(s, null).map(x => `${x.model.id}:${x.inst.profile}`)).toEqual(['c:default', 'c:long', 'b:default', 'a:default'])
  const m = metrics([{ requestId: 1, modelId: 'c', profile: 'long', phase: 'generating', tokensPerSec: 40, tokens: 9 }])
  expect(rankInstances(s, m)[0]!.inst.profile).toBe('long')
  expect(rankInstances(null, m)).toEqual([])
})

test('instanceSpeed: live while generating, last request otherwise', () => {
  const last = [{ modelId: 'c', profile: 'default', at: 1, promptPerSec: 1800, generationPerSec: 41.9, estimated: false }]
  expect(instanceSpeed(metrics([], last), 'c', 'default')).toEqual({ phase: 'idle', generation: 41.9, prompt: 1800, estimated: false })
  expect(instanceSpeed(metrics([{ requestId: 1, modelId: 'c', profile: 'default', phase: 'generating', tokensPerSec: 43.2, tokens: 5 }], last), 'c', 'default'))
    .toEqual({ phase: 'generating', generation: 43.2, prompt: 1800, estimated: true })
  expect(instanceSpeed(metrics([{ requestId: 1, modelId: 'c', profile: 'default', phase: 'prompt', tokensPerSec: null, tokens: 0 }], last), 'c', 'default').phase).toBe('prompt')
  expect(instanceSpeed(null, 'c', 'default')).toEqual({ phase: 'idle', generation: null, prompt: null, estimated: false })
})

test('pushTrend keeps a fixed window per instance and drops instances that are gone', () => {
  let t = new Map<string, number[]>()
  for (let i = 1; i <= 5; i++) t = pushTrend(t, [{ key: 'a', value: i }, { key: 'b', value: -1 }], 3)
  expect(t.get('a')).toEqual([3, 4, 5])
  expect(t.get('b')).toEqual([0, 0, 0])
  t = pushTrend(t, [{ key: 'b', value: Number.NaN }], 3)
  expect([...t.keys()]).toEqual(['b'])
  expect(t.get('b')).toEqual([0, 0, 0])
})

test('sparkPoints is right-aligned and scaled to the series maximum', () => {
  expect(sparkPoints([5])).toBe('')
  const pts = sparkPoints([0, 10], 100, 50, 3).split(' ')
  expect(pts).toEqual(['50,46', '100,9.5'])
  // All zeros: a flat line on the bottom padding, no division by zero.
  expect(sparkPoints([0, 0], 100, 50, 2)).toBe('0,46 100,46')
  expect(sparkArea('50,46 100,9.5', 50)).toBe('50,50 50,46 100,9.5 100,50')
  expect(sparkArea('')).toBe('')
})

test('quantFromFile reads common quantisation names and ignores the rest', () => {
  expect(quantFromFile('models/Qwen3-32B-Q4_K_M.gguf')).toBe('Q4_K_M')
  expect(quantFromFile('X:\\models\\gemma-3-27b-it-IQ3_XXS.gguf')).toBe('IQ3_XXS')
  expect(quantFromFile('dir/model.Q8_0.gguf')).toBe('Q8_0')
  expect(quantFromFile('dir/Llama-3.3-70B-Q6_K-00001-of-00003.gguf')).toBe('Q6_K')
  expect(quantFromFile('dir/phi-4-bf16.gguf')).toBe('BF16')
  expect(quantFromFile('dir/gpt-oss-20b-MXFP4.gguf')).toBe('MXFP4')
  expect(quantFromFile('dir/Qwen3-32B.gguf')).toBeNull()
  expect(quantFromFile('dir/Qwen2.5-Coder-7B.gguf')).toBeNull()
})

test('ctxNumber accepts plain positive integers only', () => {
  expect(ctxNumber(32768)).toBe(32768)
  expect(ctxNumber(' 8192 ')).toBe(8192)
  expect(ctxNumber('0')).toBeNull()
  expect(ctxNumber('32k')).toBeNull()
  expect(ctxNumber(null)).toBeNull()
})
