import { expect, test } from 'bun:test'
import { availableFromMeminfo, availableFromVmStat, sampleSystemMemory } from '../../server/core/memory-sample'

// `vm_stat` of a 16 GiB Apple silicon Mac (page size 16384) while a quarter of the memory was free or cache.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6428.
Pages active:                                 264449.
Pages inactive:                               262344.
Pages speculative:                              1171.
Pages throttled:                                   0.
Pages wired down:                             193784.
Pages purgeable:                                9044.
Pages occupied by compressor:                 286942.
`

test('macOS: free + speculative + inactive + purgeable pages, active pages left out', () => {
  const pages = 6428 + 1171 + 262344 + 9044
  expect(availableFromVmStat(VM_STAT)).toBeCloseTo((pages * 16384) / 1048576, 6)
  expect(availableFromVmStat(VM_STAT)).toBeGreaterThan(4000)
  // an Intel Mac reports 4096-byte pages
  expect(availableFromVmStat(VM_STAT.replace('16384', '4096'))).toBeCloseTo((pages * 4096) / 1048576, 6)
})

test('macOS: unreadable output is unknown, speculative / purgeable lines may be missing', () => {
  expect(availableFromVmStat('')).toBeNull()
  expect(availableFromVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 5.')).toBeNull()
  expect(availableFromVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 64.\nPages inactive: 64.\n')).toBeCloseTo(2, 6)
})

test('Linux: MemAvailable', () => {
  expect(availableFromMeminfo('MemTotal: 16000000 kB\nMemFree: 100 kB\nMemAvailable:    8388608 kB\n')).toBe(8192)
  expect(availableFromMeminfo('MemTotal: 1 kB')).toBeNull()
})

test('sampling picks the probe of the platform and falls back to unknown on any failure', async () => {
  const total = () => 16 * 1024 ** 3
  const mac = await sampleSystemMemory({ platform: 'darwin', run: async (cmd) => (cmd === 'vm_stat' ? VM_STAT : ''), total })
  expect(mac).toMatchObject({ totalMiB: 16384, source: 'vm_stat' })
  expect(mac.availableMiB).toBeGreaterThan(4000)
  const linux = await sampleSystemMemory({ platform: 'linux', readText: async () => 'MemAvailable: 1048576 kB', total })
  expect(linux).toEqual({ totalMiB: 16384, availableMiB: 1024, source: 'meminfo' })
  const win = await sampleSystemMemory({ platform: 'win32', free: () => 5 * 1024 ** 3, total })
  expect(win).toEqual({ totalMiB: 16384, availableMiB: 5120, source: 'os' })
  const broken = await sampleSystemMemory({ platform: 'darwin', run: async () => { throw new Error('boom') }, total })
  expect(broken).toEqual({ totalMiB: 16384, availableMiB: null, source: 'unavailable' })
  const garbled = await sampleSystemMemory({ platform: 'darwin', run: async () => 'nonsense', total })
  expect(garbled.availableMiB).toBeNull()
  const zero = await sampleSystemMemory({ platform: 'win32', free: () => 0, total })
  expect(zero.availableMiB).toBeNull()
})

test('the sample has no GPU wording', async () => {
  const s = await sampleSystemMemory({ platform: 'darwin', run: async () => VM_STAT, total: () => 16 * 1024 ** 3 })
  expect(JSON.stringify(s)).not.toMatch(/gpu|vram/i)
})
