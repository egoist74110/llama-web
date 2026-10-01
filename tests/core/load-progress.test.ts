import { describe, expect, test } from 'bun:test'
import { LoadProgress } from '../../server/core/load-progress'

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
