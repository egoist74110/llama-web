// A request that does not fit (decision 42): 503 `insufficient_memory` with the numbers, for plain and streaming
// requests alike, and the record of the request says why without any conversation content.
import { afterEach, expect, test } from 'bun:test'
import { defaultSettings, type ModelConfig, type ModelsDoc } from '../../server/core/config'
import { createProxy, noRoomText } from '../../server/core/proxy'
import type { RequestRecord } from '../../server/core/request-log'
import { SchedulerError, type NoRoomDetail, type Target } from '../../server/core/scheduler'

const model: ModelConfig = {
  id: 'm1', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null,
  activeProfile: '默认', profiles: { 默认: { overrides: {}, extraArgs: '' } },
}
const MODELS: ModelsDoc = { version: 1, models: [model] }

const closers: Array<() => void> = []
afterEach(() => { for (const c of closers.splice(0)) c() })

function setup(detail: NoRoomDetail) {
  const records: RequestRecord[] = []
  const proxy = createProxy({
    scheduler: {
      acquire: (target: Target) => Promise.reject(new SchedulerError('no-room', target, detail)),
      snapshot: () => ({ models: [], queue: [] }),
      stateOf: () => 'stopped',
    },
    getModels: () => MODELS, getSettings: () => defaultSettings(), heartbeatMs: 10,
    onRequest: r => records.push(r),
  })
  const front = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => proxy.handleV1(req) })
  closers.push(() => front.stop(true))
  const post = (body: unknown) => fetch(`http://127.0.0.1:${front.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { post, records }
}

const memory: NoRoomDetail = { reason: 'memory', estimateMiB: 20480, availableMiB: 8192, pool: 'CUDA0' }

test('503 insufficient_memory with the estimate and the free memory', async () => {
  const { post, records } = setup(memory)
  const res = await post({ model: 'Alpha', messages: [{ role: 'user', content: 'secret words' }] })
  expect(res.status).toBe(503)
  const body = await res.json() as { error: { code: string, message: string, type: string } }
  expect(body.error.code).toBe('insufficient_memory')
  expect(body.error.type).toBe('server_error')
  expect(body.error.message).toContain('20.0 GB')
  expect(body.error.message).toContain('8.0 GB')
  expect(body.error.message).toContain('Alpha')
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ status: 503, outcome: 'error', error: 'insufficient_memory', modelId: 'm1' })
  expect(JSON.stringify(records[0])).not.toContain('secret words')
})

test('a streaming request gets the same error as its last event', async () => {
  const { post, records } = setup(memory)
  const res = await post({ model: 'Alpha', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const text = await res.text()
  expect(text).toContain('insufficient_memory')
  expect(records[0]).toMatchObject({ outcome: 'error', error: 'insufficient_memory' })
})

test('texts for the online limit, unreadable memory and the watchdog', () => {
  expect(noRoomText({ reason: 'limit', estimateMiB: null, availableMiB: null, pool: null, limit: 2 }, 'Alpha')).toContain('2 个')
  expect(noRoomText({ reason: 'unknown', estimateMiB: null, availableMiB: null, pool: null }, 'Alpha')).toContain('读不到')
  expect(noRoomText({ reason: 'watchdog', estimateMiB: null, availableMiB: 100, pool: 'system' }, 'Alpha')).toContain('保护机制')
})
