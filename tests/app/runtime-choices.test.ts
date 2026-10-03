import { expect, test } from 'bun:test'
import type { DevicesView } from '../../server/core/devices'
import type { RuntimeRow } from '../../server/core/runtime-manager'
import { platformUi } from '../../app/utils/platform-ui'
import { accelLabel, deviceItems, deviceUsedText, groupByChannel, runtimeItems, runtimeRowLabel } from '../../app/utils/runtime-choices'
import { EMPTY_SELECT_VALUE } from '../../app/utils/select-empty'

const row = (over: Partial<RuntimeRow>): RuntimeRow => ({
  ref: 'cuda:b100', kind: 'official', accel: 'cuda', tag: 'b100', label: 'b100', current: false, inUse: false, latestOfficial: false, deletable: true, ...over,
})

const gpuView: DevicesView = {
  applicable: true, runtime: null, source: 'list-devices',
  gpus: [{ id: 'CUDA0', name: 'Test GPU', totalMiB: 24576, freeMiB: 20480 }],
  cpu: { logicalCores: 16, sockets: 1, numaNodes: 1, multi: false },
}

test('platform flags: a Mac has no GPU interface, Windows has GPU and the CPU channel', () => {
  expect(platformUi('darwin')).toMatchObject({ known: true, isMac: true, hasGpu: false, hasCpuChannel: false, canPickFolder: false })
  expect(platformUi('win32')).toMatchObject({ known: true, isMac: false, hasGpu: true, hasCpuChannel: true, canPickFolder: true })
  // Before the first snapshot nothing platform-specific shows.
  expect(platformUi(undefined)).toMatchObject({ known: false, hasGpu: false, hasCpuChannel: false })
})

test('a Mac never gets acceleration wording in build names', () => {
  expect(accelLabel('metal', true)).toBe('')
  expect(accelLabel('cpu', true)).toBe('')
  expect(runtimeRowLabel(row({ accel: 'metal', ref: 'metal:b100' }), true)).toBe('b100')
  expect(runtimeRowLabel(row({}), false)).toContain('CUDA')
  expect(runtimeRowLabel(row({ kind: 'custom', label: 'my build', tag: 'b7', accel: 'cuda', ref: 'custom:r1' }), true)).toBe('my build (b7)')
  // A name that already carries the number is not repeated.
  expect(runtimeRowLabel(row({ kind: 'custom', label: 'b11146 · CUDA', tag: 'b11146', accel: 'cuda', ref: 'custom:r2' }), true)).toBe('b11146 · CUDA')
})

test('build items start with "follow" and keep a missing stored reference selectable', () => {
  const items = runtimeItems([row({}), row({ ref: 'cpu:b100', accel: 'cpu' })], 'cuda:b1', false)
  expect(items[0]!.value).toBe(EMPTY_SELECT_VALUE)
  expect(items.map(i => i.value)).toEqual([EMPTY_SELECT_VALUE, 'cuda:b100', 'cpu:b100', 'cuda:b1'])
  expect(items.at(-1)!.label).toContain('cuda:b1')
})

test('device items list auto, each GPU with its memory, CPU, and a stored device that is gone', () => {
  const items = deviceItems(gpuView, 'CUDA3')
  expect(items.map(i => i.value)).toEqual([EMPTY_SELECT_VALUE, 'auto', 'CUDA0', 'cpu', 'CUDA3'])
  expect(items[2]!.label).toContain('Test GPU')
  expect(items[2]!.label).toContain('20.0 GiB')
  // No list yet (loading / failed): auto and CPU stay available.
  expect(deviceItems(null, '').map(i => i.value)).toEqual([EMPTY_SELECT_VALUE, 'auto', 'cpu'])
})

test('device text and channel grouping', () => {
  expect(deviceUsedText('auto')).toContain('自动')
  expect(deviceUsedText('CUDA0')).toContain('CUDA0')
  const g = groupByChannel([row({}), row({ ref: 'cpu:b100', accel: 'cpu' })], ['cuda', 'cpu', 'metal'])
  expect(g.map(x => [x.accel, x.rows.length])).toEqual([['cuda', 1], ['cpu', 1], ['metal', 0]])
})
