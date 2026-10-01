import { describe, expect, test } from 'bun:test'
import { LoadProgress, trackWeightLoad } from '../../server/core/load-progress'

describe('LoadProgress', () => {
  test('milestones move forward and never back', () => {
    const p = new LoadProgress()
    expect(p.line('some unrelated line')).toBeNull()
    expect(p.line('llama_model_loader: loaded meta data with 40 key-value pairs and 579 tensors from X:\\models\\a.gguf')).toBe(6)
    expect(p.line('load_tensors: offloaded 65/65 layers to GPU')).toBe(10)
    expect(p.line('llama_context: n_ctx = 8192')).toBe(91)
    expect(p.line('llama_model_loader: loaded meta data with 40 key-value pairs')).toBeNull() // older milestone repeats
    expect(p.value).toBe(91)
  })

  test('the dot line grows without a newline: each dot is a percent of the weight loading', () => {
    const p = new LoadProgress()
    expect(p.partial('..')).toBeNull() // too short to be the loader's dots
    const a = p.partial('.'.repeat(10))!
    const b = p.partial('.'.repeat(50))!
    const c = p.partial('.'.repeat(100))!
    expect(a).toBeGreaterThan(12)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(c).toBeLessThanOrEqual(90)
    // The finished dot line arrives as a normal line; nothing changes.
    expect(p.line('.'.repeat(100))).toBeNull()
  })

  test('text that merely contains dots is not progress', () => {
    const p = new LoadProgress()
    expect(p.partial('loading...')).toBeNull()
    expect(p.line('a.b.c')).toBeNull()
  })

  test('never reaches 100 by itself (the state change to ready does that)', () => {
    const p = new LoadProgress()
    p.line('main: model loaded')
    expect(p.value).toBe(99)
  })
})

describe('LoadProgress with a recent llama-server (almost silent while loading)', () => {
  test('its real milestones: loading model -> threadpool init -> slots -> model loaded', () => {
    const p = new LoadProgress()
    expect(p.line("0.01.326.191 I srv    load_model: loading model 'X:\models\a.gguf'")).toBe(3)
    expect(p.line('0.04.416.141 I cmn          init: llama threadpool init, n_threads = 12')).toBe(92)
    expect(p.line("0.04.493.418 I common_speculative_init_result: creating MTP draft context against the target model 'a.gguf'")).toBe(94)
    expect(p.line('0.04.500.713 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192')).toBe(97)
    expect(p.line('0.04.531.818 I srv  llama_server: model loaded')).toBe(99)
  })

  test('GPU memory growth against the weight size moves the bar (max 90, never back)', () => {
    const p = new LoadProgress()
    p.line("load_model: loading model 'a.gguf'")
    const a = p.estimate(2000, 2000, 16000)!
    const b = p.estimate(4000, 8000, 16000)!
    const c = p.estimate(6000, 40000, 16000)! // growth larger than the files (KV cache etc.)
    expect(a).toBeGreaterThan(10)
    expect(b).toBeGreaterThan(a)
    expect(c).toBe(90)
    expect(p.estimate(7000, 100, 16000)).toBeNull() // memory freed by someone else: no step back
    expect(p.value).toBe(90)
  })

  test('without GPU numbers a time curve is used; milestones are not held back by it', () => {
    const p = new LoadProgress()
    const a = p.estimate(5000, null, 16000)!
    const b = p.estimate(30000, null, 16000)!
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThanOrEqual(90)
    expect(p.estimate(5000, null, 0)).toBeNull() // time never runs backwards either
    expect(p.line('llama threadpool init')).toBe(92)
  })
})

describe('trackWeightLoad lifecycle (review CR-004)', () => {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  const setup = (usedMiB: () => Promise<number | null>) => {
    const reports: Array<number | null> = []
    const stop = trackWeightLoad({
      files: ['a'], sizeOf: () => 1000 * 1048576, progress: new LoadProgress(), intervalMs: 5, usedMiB,
      report: p => reports.push(p),
    })
    return { stop, reports }
  }

  test('a slow sample never overlaps the next one', async () => {
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const { stop } = setup(async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await wait(40)
      inFlight--
      return 100 + calls * 10
    })
    await wait(150)
    stop()
    expect(maxInFlight).toBe(1)
    expect(calls).toBeGreaterThan(1)
  })

  test('after stop nothing is reported, not even by a sample that was still running', async () => {
    let n = 0
    const { stop, reports } = setup(async () => { await wait(30); return 100 + 50 * n++ })
    await wait(80)
    stop()
    const seen = reports.length
    await wait(120)
    expect(reports.length).toBe(seen)
  })

  test('no GPU numbers: the time curve reports; a throwing sampler is survived', async () => {
    const a = setup(async () => null)
    await wait(40)
    a.stop()
    expect(a.reports.some(p => typeof p === 'number')).toBe(true)
    const b = setup(async () => { throw new Error('smi gone') })
    await wait(40)
    b.stop()
    expect(b.reports.length).toBeGreaterThan(0)
  })
})
