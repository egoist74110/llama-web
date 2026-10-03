import { describe, expect, test } from 'bun:test'
import {
  describeDevices, DeviceProbe, deviceMissing, devicesFromNvidia, parseListDevices, probeDevices, type DeviceList,
} from '../../server/core/devices'
import type { RunCmd } from '../../server/core/system'

// Output of `llama-server --list-devices` as printed by b11146 on one RTX 5090 (stdout only; the log goes to stderr).
const REAL = 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 5090 (32579 MiB, 30991 MiB free)\n'
const TWO = 'Available devices:\r\n  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)\r\n  CUDA1: NVIDIA GeForce RTX 3060 (12288 MiB, 11800 MiB free)\r\n'

describe('parseListDevices', () => {
  test('one card, the real output', () => {
    expect(parseListDevices(REAL)).toEqual([{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 5090', totalMiB: 32579, freeMiB: 30991 }])
  })
  test('two cards with CRLF line ends', () => {
    expect(parseListDevices(TWO).map(d => [d.id, d.totalMiB, d.freeMiB])).toEqual([['CUDA0', 24564, 23000], ['CUDA1', 12288, 11800]])
  })
  test('other backends keep their own id; names with colons and parentheses survive', () => {
    const d = parseListDevices('Available devices:\n  Vulkan0: AMD Radeon (TM) Graphics: RDNA3 (8192 MiB, 8000 MiB free)\n')
    expect(d).toEqual([{ id: 'Vulkan0', name: 'AMD Radeon (TM) Graphics: RDNA3', totalMiB: 8192, freeMiB: 8000 }])
  })
  test('heading, empty list and log noise give no device', () => {
    expect(parseListDevices('Available devices:\n')).toEqual([])
    expect(parseListDevices('ggml_cuda_init: found 1 CUDA devices:\nsome: line (not a device)\n')).toEqual([])
    expect(parseListDevices('')).toEqual([])
  })
})

describe('probeDevices', () => {
  test('runs --list-devices with the timeout and parses stdout', async () => {
    const calls: unknown[][] = []
    const run: RunCmd = async (cmd, args, timeout) => { calls.push([cmd, args, timeout]); return REAL }
    const r = await probeDevices('X:\llama-server.exe', run, 5000)
    expect(calls).toEqual([['X:\llama-server.exe', ['--list-devices'], 5000]])
    expect(r.source).toBe('list-devices')
    expect(r.gpus).toHaveLength(1)
  })
  test('a build with no GPU lists nothing and that is an answer, not a failure', async () => {
    const r = await probeDevices('x', async () => 'Available devices:\n')
    expect(r).toEqual({ source: 'list-devices', gpus: [] })
  })
  test('a failing, timing-out or unreadable program is unavailable', async () => {
    expect((await probeDevices('x', async () => { throw new Error('ETIMEDOUT') })).source).toBe('unavailable')
    expect((await probeDevices('x', async () => 'garbage')).source).toBe('unavailable')
  })
})

describe('DeviceProbe cache', () => {
  test('keeps an answer per executable for the ttl, refresh asks again, failures are not kept', async () => {
    let n = 0, fail = false, t = 0
    const probe = new DeviceProbe(async () => { n++; if (fail) throw new Error('x'); return REAL }, 1000, () => t)
    await probe.list('a'); await probe.list('a'); await probe.list('b')
    expect(n).toBe(2)
    t = 999; await probe.list('a')
    expect(n).toBe(2)
    t = 1001; await probe.list('a')
    expect(n).toBe(3)
    await probe.list('a', { refresh: true })
    expect(n).toBe(4)
    fail = true
    expect((await probe.list('c')).source).toBe('unavailable')
    fail = false
    expect((await probe.list('c')).source).toBe('list-devices')
    expect(n).toBe(6)
  })
  test('two callers at once share one run', async () => {
    let n = 0
    const probe = new DeviceProbe(async () => { n++; await Bun.sleep(10); return REAL })
    await Promise.all([probe.list('a'), probe.list('a')])
    expect(n).toBe(1)
  })
})

describe('deviceMissing', () => {
  const list = (source: DeviceList['source']): DeviceList => ({ source, gpus: parseListDevices(TWO) })
  test('an id the build does not list is missing', () => {
    expect(deviceMissing('CUDA7', list('list-devices'))).toBe(true)
    expect(deviceMissing('CUDA1', list('list-devices'))).toBe(false)
  })
  test('auto and cpu are never missing; a guess or failed probe never rejects', () => {
    expect(deviceMissing('auto', { source: 'list-devices', gpus: [] })).toBe(false)
    expect(deviceMissing('cpu', { source: 'list-devices', gpus: [] })).toBe(false)
    expect(deviceMissing('CUDA7', list('nvidia-smi'))).toBe(false)
    expect(deviceMissing('CUDA7', { source: 'unavailable', gpus: [] })).toBe(false)
  })
  test('a CPU build lists no GPU, so a GPU choice is missing there', () => {
    expect(deviceMissing('CUDA0', { source: 'list-devices', gpus: [] })).toBe(true)
  })
})

describe('describeDevices', () => {
  const cpu = { logicalCores: 24, sockets: 1, numaNodes: 1 }
  const nv = [{ index: 0, name: 'NVIDIA GeForce RTX 5090', memoryMiB: 32607, computeCap: 12 }]
  test('uses the build list when it answered', () => {
    const v = describeDevices('cuda:b1', parseList(REAL), cpu, nv)
    expect(v).toMatchObject({ applicable: true, runtime: 'cuda:b1', source: 'list-devices', cpu: { multi: false } })
    expect(v.gpus[0]).toMatchObject({ id: 'CUDA0', freeMiB: 30991 })
  })
  test('falls back to the nvidia-smi order when the build could not be run', () => {
    const v = describeDevices(null, { source: 'unavailable', gpus: [] }, cpu, nv)
    expect(v.source).toBe('nvidia-smi')
    expect(v.gpus).toEqual([{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 5090', totalMiB: 32607, freeMiB: null }])
    expect(devicesFromNvidia(nv)).toEqual(v.gpus)
  })
  test('no answer and no NVIDIA card: unavailable, no devices', () => {
    expect(describeDevices(null, { source: 'unavailable', gpus: [] }, cpu, [])).toMatchObject({ source: 'unavailable', gpus: [] })
  })
  test('several sockets or NUMA nodes mark the CPU as multi (fake data: no such machine to test on)', () => {
    expect(describeDevices(null, parseList(REAL), { logicalCores: 128, sockets: 2, numaNodes: 2 }, nv).cpu.multi).toBe(true)
    expect(describeDevices(null, parseList(REAL), { logicalCores: 64, sockets: 1, numaNodes: 4 }, nv).cpu.multi).toBe(true)
    expect(describeDevices(null, parseList(REAL), { logicalCores: 8, sockets: null, numaNodes: null }, nv).cpu.multi).toBe(false)
  })
})

function parseList(text: string): DeviceList {
  return { source: 'list-devices', gpus: parseListDevices(text) }
}
