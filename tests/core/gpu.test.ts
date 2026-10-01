import { describe, expect, test } from 'bun:test'
import { GpuSampler, parseNvidiaSmi } from '../../server/core/gpu'

const OUT = '0, NVIDIA GeForce RTX 4090, 1234, 24564, 7\n1, NVIDIA RTX A6000, 40000, 49140, 100\n'

describe('parseNvidiaSmi', () => {
  test('parses one line per GPU', () => {
    expect(parseNvidiaSmi(OUT)).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 4090', usedMiB: 1234, totalMiB: 24564, utilization: 7 },
      { index: 1, name: 'NVIDIA RTX A6000', usedMiB: 40000, totalMiB: 49140, utilization: 100 },
    ])
  })

  test('tolerates CRLF, blank lines, [N/A] utilisation and garbage', () => {
    const got = parseNvidiaSmi('0, Name, 10, 20, [N/A]\r\n\r\nnot a gpu line\r\nNVIDIA-SMI has failed\r\n')
    expect(got).toEqual([{ index: 0, name: 'Name', usedMiB: 10, totalMiB: 20, utilization: null }])
    expect(parseNvidiaSmi('')).toEqual([])
    expect(parseNvidiaSmi('0, X, [N/A], [N/A], 0')).toEqual([])
  })
})

describe('GpuSampler', () => {
  test('sample() publishes the GPUs and notifies only on change', async () => {
    let out = OUT
    let changes = 0
    const s = new GpuSampler({ run: async () => out, onChange: () => { changes++ } })
    expect(s.value.available).toBe(false)
    await s.sample()
    expect(s.value.available).toBe(true)
    expect(s.value.gpus).toHaveLength(2)
    await s.sample()
    expect(changes).toBe(1)
    out = '0, G, 1, 2, 3'
    await s.sample()
    expect(changes).toBe(2)
  })

  test('no nvidia-smi: unavailable (the UI hides the bar), and it recovers when it appears', async () => {
    let fail = true
    const s = new GpuSampler({ run: async () => { if (fail) throw new Error('ENOENT'); return OUT } })
    await s.sample()
    expect(s.value).toEqual({ available: false, gpus: [] })
    fail = false
    await s.sample()
    expect(s.value.available).toBe(true)
  })

  test('the loop samples on a timer, pauses while nobody is connected, and stops', async () => {
    let runs = 0
    let watching = false
    const s = new GpuSampler({ intervalMs: 5, active: () => watching, run: async () => { runs++; return OUT } })
    s.start()
    await new Promise(r => setTimeout(r, 40))
    expect(runs).toBe(0)
    watching = true
    await new Promise(r => setTimeout(r, 60))
    expect(runs).toBeGreaterThan(2)
    s.stop()
    const n = runs
    await new Promise(r => setTimeout(r, 40))
    expect(runs).toBe(n)
  })

  test('overlapping samples are skipped', async () => {
    let runs = 0
    let release!: () => void
    const s = new GpuSampler({ run: () => { runs++; return new Promise<string>((r) => { release = () => r(OUT) }) } })
    const a = s.sample()
    await s.sample()
    release()
    await a
    expect(runs).toBe(1)
  })
})
