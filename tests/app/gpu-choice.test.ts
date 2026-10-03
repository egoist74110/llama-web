import { describe, expect, test } from 'bun:test'
import type { DevicesView } from '../../server/core/devices'
import { emptyGpuForm, experimentalChosen, gpuBody, gpuFormFrom, largestGpuId, ratioHint, ratioValid, toggleDevice, toggleMulti } from '../../app/utils/gpu-choice'

const view = (gpus: Array<[string, number]>): DevicesView => ({
  applicable: true, runtime: null, source: 'list-devices', splitModes: ['layer', 'row', 'tensor'],
  gpus: gpus.map(([id, totalMiB]) => ({ id, name: id, totalMiB, freeMiB: totalMiB })),
  cpu: { logicalCores: 8, sockets: 1, numaNodes: 1, multi: false },
})
const v2 = view([['CUDA0', 24576], ['CUDA1', 32768]])

describe('gpu choice form', () => {
  test('the switch is off for a single or empty choice and on for a stored group', () => {
    expect(gpuFormFrom(null)).toEqual(emptyGpuForm())
    expect(gpuFormFrom({ device: 'CUDA1' })).toMatchObject({ multi: false, device: 'CUDA1' })
    const g = gpuFormFrom({ devices: ['CUDA0', 'CUDA1'], splitMode: 'row', tensorSplit: '1,1', mainGpu: '0' })
    expect(g).toMatchObject({ multi: true, device: '', devices: ['CUDA0', 'CUDA1'], splitMode: 'row', tensorSplit: '1,1', mainGpu: '0' })
  })
  test('the body always carries all five fields, so switching back clears the group', () => {
    expect(gpuBody({ ...emptyGpuForm(), device: 'CUDA0' })).toEqual({ device: 'CUDA0', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' })
    expect(gpuBody({ device: 'x', multi: true, devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: ' 3,1 ', mainGpu: '' }))
      .toEqual({ device: '', devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '3,1', mainGpu: '' })
  })
  test('turning the switch on starts from one GPU, off returns to one device (never nothing)', () => {
    expect(largestGpuId(v2)).toBe('CUDA1')
    expect(toggleMulti(emptyGpuForm(), true, v2)).toMatchObject({ multi: true, devices: ['CUDA1'] })
    expect(toggleMulti({ ...emptyGpuForm(), device: 'CUDA0' }, true, v2).devices).toEqual(['CUDA0'])
    expect(toggleMulti({ ...emptyGpuForm(), device: 'cpu' }, true, v2).devices).toEqual(['CUDA1'])
    const on = { ...emptyGpuForm(), multi: true, devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor' }
    expect(toggleMulti(on, false, v2)).toEqual({ ...emptyGpuForm(), device: 'CUDA0' })
    expect(toggleMulti(emptyGpuForm(), true, null).devices).toEqual([])
  })
  test('the last GPU cannot be unchecked; order follows the list; the ratio is cleared when the group changes', () => {
    let f = toggleMulti(emptyGpuForm(), true, v2)
    expect(toggleDevice(f, 'CUDA1', false, v2)).toBe(f)
    f = { ...toggleDevice(f, 'CUDA0', true, v2), tensorSplit: '1,1' }
    expect(f.devices).toEqual(['CUDA0', 'CUDA1'])
    const g = toggleDevice(f, 'CUDA0', false, v2)
    expect(g.devices).toEqual(['CUDA1'])
    expect(g.tensorSplit).toBe('')
  })
  test('ratio hint from memory and ratio validation', () => {
    const f = { ...emptyGpuForm(), multi: true, devices: ['CUDA0', 'CUDA1'] }
    expect(ratioHint(f, v2)).toEqual({ placeholder: '24,32', shares: 'CUDA0 43%，CUDA1 57%' })
    expect(ratioHint({ ...f, devices: ['CUDA0', 'CUDA9'] }, v2)).toEqual({ placeholder: '', shares: '' })
    expect(ratioValid({ ...f, tensorSplit: '' })).toBe(true)
    expect(ratioValid({ ...f, tensorSplit: '3, 1' })).toBe(true)
    for (const bad of ['3', '3,1,1', 'a,b', '0,0']) expect(ratioValid({ ...f, tensorSplit: bad })).toBe(false)
    expect(ratioValid({ ...emptyGpuForm(), tensorSplit: 'junk' })).toBe(true)
  })
  test('experimental modes are only flagged for a real group', () => {
    const f = { ...emptyGpuForm(), multi: true, devices: ['CUDA0', 'CUDA1'] }
    expect(experimentalChosen({ ...f, splitMode: 'tensor' })).toBe(true)
    expect(experimentalChosen({ ...f, splitMode: 'row' })).toBe(true)
    expect(experimentalChosen({ ...f, splitMode: 'layer' })).toBe(false)
    expect(experimentalChosen({ ...f, splitMode: '' })).toBe(false)
    expect(experimentalChosen({ ...f, devices: ['CUDA0'], splitMode: 'tensor' })).toBe(false)
  })
})
