import { expect, test } from 'bun:test'
import t from '../../i18n/zh-CN'
import { dirPathPlaceholder, failureAdvice, loadErrorText, paramText } from '../../app/utils/platform-text'

// Decision 38: nothing a Mac user can see may mention a GPU, video memory, Metal or a drive letter.
const FORBIDDEN = /GPU|显存|显卡|Metal|CUDA|NVIDIA|VRAM|[A-Z]:\\/i

// Literal llama-server flags (--n-gpu-layers) are command text, not wording.
const prose = (s: string) => s.replace(/--[a-z][a-z-]*/g, '')

const mac = t.platform.mac
function strings(o: unknown): string[] {
  return typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []
}

test('every Mac wording is free of GPU / drive-letter text', () => {
  for (const s of strings(mac)) expect(prose(s)).not.toMatch(FORBIDDEN)
})

test('every launch parameter shown on a Mac is free of GPU wording; Windows keeps its own', () => {
  type Key = keyof typeof t.models.edit.params
  for (const key of Object.keys(t.models.edit.params) as Key[]) {
    const m = paramText(key, true)
    expect(prose(`${m.label} ${m.hint}`)).not.toMatch(FORBIDDEN)
  }
  expect(paramText('gpuLayers', true).label).toBe(mac.params.gpuLayers.label)
  expect(paramText('gpuLayers', false).label).toBe(t.models.edit.params.gpuLayers.label)
  // A parameter without an override is the same everywhere.
  expect(paramText('batchSize', true)).toEqual(paramText('batchSize', false))
})

test('out-of-memory reason and advice differ per platform, other reasons do not', () => {
  expect(loadErrorText('oom', true)).toBe(mac.loadError.oom)
  expect(loadErrorText('oom', false)).toBe(t.loadError.oom)
  expect(failureAdvice('oom', true)).not.toMatch(FORBIDDEN)
  expect(failureAdvice('crashed', true)).not.toMatch(FORBIDDEN)
  expect(failureAdvice('oom', false)).toBe(t.failure.advice.oom)
  expect(failureAdvice('port-in-use', true)).toBe(failureAdvice('port-in-use', false))
  expect(failureAdvice('nope', true)).toBe(t.failure.advice.unknown)
  expect(loadErrorText(null, true)).toBe('')
})

test('path placeholder per platform', () => {
  expect(dirPathPlaceholder(true)).toBe(mac.pathPlaceholder)
  expect(dirPathPlaceholder(false)).toBe(t.settings.dirs.pathPlaceholder)
})
