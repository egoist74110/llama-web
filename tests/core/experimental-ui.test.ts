import { describe, expect, test } from 'bun:test'
import {
  channelHeaderTitle,
  choicePromptReasonText,
  extractRuntimeFromTail,
  isExperimentalAccel,
} from '../../app/utils/experimental-backend'
import { runtimeRowLabel } from '../../app/utils/runtime-choices'
import { setLocale } from '../../server/core/i18n'

describe('experimental-backend pure utils', () => {
  test('isExperimentalAccel detects vulkan, sycl, and rocm', () => {
    expect(isExperimentalAccel('vulkan')).toBe(true)
    expect(isExperimentalAccel('sycl')).toBe(true)
    expect(isExperimentalAccel('rocm')).toBe(true)
    expect(isExperimentalAccel('cuda')).toBe(false)
    expect(isExperimentalAccel('cpu')).toBe(false)
    expect(isExperimentalAccel('metal')).toBe(false)
    expect(isExperimentalAccel('')).toBe(false)
    expect(isExperimentalAccel(null)).toBe(false)
    expect(isExperimentalAccel(undefined)).toBe(false)
  })

  test('channelHeaderTitle shows special title only on non-Mac vulkan', () => {
    setLocale('zh-CN')
    expect(channelHeaderTitle('vulkan', true)).toBe('')
    expect(channelHeaderTitle('cuda', true)).toBe('')
    expect(channelHeaderTitle('vulkan', false)).toBe('Vulkan（实验性，Intel / AMD / 老 N 卡）')
    expect(channelHeaderTitle('cuda', false)).toBe('NVIDIA（CUDA）版')
    expect(channelHeaderTitle('cpu', false)).toBe('CPU 版')
  })

  test('choicePromptReasonText maps known reasons to text', () => {
    setLocale('zh-CN')
    expect(choicePromptReasonText('nvidia-missing')).toContain('没有检测到 NVIDIA')
    expect(choicePromptReasonText('nvidia-failed')).toContain('nvidia-smi')
    expect(choicePromptReasonText('cuda-unusable')).toContain('算力')
    expect(choicePromptReasonText(null)).toBe('')
    expect(choicePromptReasonText(undefined)).toBe('')
  })

  test('extractRuntimeFromTail extracts metadata when present', () => {
    const tailWithMeta = [
      'some log line',
      '# llama-web runtime: {"runtime":{"ref":"vulkan:b1234","label":"b1234","accel":"vulkan","tag":"b1234"},"profile":"默认"}',
      'server started',
    ]
    expect(extractRuntimeFromTail(tailWithMeta)).toEqual({ accel: 'vulkan', ref: 'vulkan:b1234' })

    const tailWithout = ['just some normal', 'log lines']
    expect(extractRuntimeFromTail(tailWithout)).toBeNull()
    expect(extractRuntimeFromTail([])).toBeNull()
    expect(extractRuntimeFromTail(null)).toBeNull()
  })

  test('runtimeRowLabel adds experimental badge text in non-Mac string contexts', () => {
    setLocale('zh-CN')
    const vulkanRow = { kind: 'official' as const, label: 'b1234', tag: 'b1234', accel: 'vulkan' }
    const cudaRow = { kind: 'official' as const, label: 'b1234', tag: 'b1234', accel: 'cuda' }

    expect(runtimeRowLabel(vulkanRow, false)).toContain('实验性')
    expect(runtimeRowLabel(vulkanRow, false)).toContain('Vulkan')
    expect(runtimeRowLabel(cudaRow, false)).not.toContain('实验性')
    expect(runtimeRowLabel(cudaRow, false)).toContain('CUDA')

    // Mac shows no acceleration label at all
    expect(runtimeRowLabel(vulkanRow, true)).toBe('b1234')
  })
})
