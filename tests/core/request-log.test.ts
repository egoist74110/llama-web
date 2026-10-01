import { describe, expect, test } from 'bun:test'
import { isLocalAddress, sourceOf, summarizeImages, summarizeParams, UsageTap } from '../../server/core/request-log'

const enc = new TextEncoder()

describe('source', () => {
  const own = () => new Set(['192.168.1.20', 'fe80::1'])
  test('loopback and this machine are local, other addresses are LAN', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '[::1]', 'localhost']) expect(isLocalAddress(ip, own)).toBe(true)
    expect(isLocalAddress('192.168.1.20', own)).toBe(true)
    expect(isLocalAddress('::ffff:192.168.1.20', own)).toBe(true)
    expect(isLocalAddress('fe80::1%12', own)).toBe(true)
    expect(isLocalAddress('192.168.1.99', own)).toBe(false)
    expect(isLocalAddress('2001:db8::5', own)).toBe(false)
  })

  test('a key name makes the request public; unknown address counts as local', () => {
    expect(sourceOf(undefined)).toEqual({ source: 'local', keyName: null })
    expect(sourceOf({ ip: null })).toEqual({ source: 'local', keyName: null })
    expect(sourceOf({ ip: '203.0.113.7' })).toEqual({ source: 'lan', keyName: null })
    expect(sourceOf({ ip: '127.0.0.1', keyName: 'phone' })).toEqual({ source: 'public', keyName: 'phone' })
  })
})

describe('summarizeParams', () => {
  test('keeps allow-listed scalars and counts messages / tools; drops everything else', () => {
    const p = summarizeParams({
      model: 'Alpha', temperature: 0.6, top_p: 0.9, max_tokens: 100, stream: true, seed: 5,
      reasoning_effort: 'low', stop: ['secret stop'], user: 'someone@example.com', logit_bias: { 1: 2 },
      messages: [{ role: 'user', content: 'hello secret' }, { role: 'assistant', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'long text' } }],
      prompt: 'private prompt', input: 'private input',
      response_format: { type: 'json_schema', json_schema: { name: 'private' } },
    })
    expect(p).toEqual({ temperature: 0.6, top_p: 0.9, max_tokens: 100, stream: true, seed: 5, reasoning_effort: 'low', messages: 2, tools: 1 })
    expect(JSON.stringify(p)).not.toContain('secret')
  })

  test('nested reasoning switches are flattened; long or odd strings are dropped', () => {
    const p = summarizeParams({
      thinking: { type: 'enabled', budget_tokens: 2048, note: 'a sentence with spaces that must not be stored' },
      reasoning: { effort: 'high' },
      chat_template_kwargs: { enable_thinking: false, system_hint: 'free text with spaces', 'bad key!': 1 },
      reasoning_format: 'x'.repeat(200),
    })
    expect(p).toEqual({
      'thinking.type': 'enabled', 'thinking.budget_tokens': 2048, 'reasoning.effort': 'high', 'chat_template_kwargs.enable_thinking': false,
    })
  })

  test('non-object bodies give an empty summary', () => {
    expect(summarizeParams(null)).toEqual({})
    expect(summarizeParams([1, 2])).toEqual({})
    expect(summarizeParams('text')).toEqual({})
  })
})

describe('summarizeImages', () => {
  const img = (w: number, h: number, bytes: number) => ({ width: w, height: h, bytes, format: 'png' })
  test('totals, compressed count and edges; null without images', () => {
    expect(summarizeImages(undefined)).toBeNull()
    expect(summarizeImages([])).toBeNull()
    const s = summarizeImages([
      { message: 0, part: 1, action: 'compressed', before: img(3000, 2000, 1000), after: img(896, 597, 100) },
      { message: 0, part: 2, action: 'kept', before: img(200, 100, 50) },
      { message: 1, part: 0, action: 'skipped', detail: 'not a base64 data URI' },
    ])
    expect(s).toEqual({ count: 3, beforeBytes: 1050, afterBytes: 150, compressed: 1, maxEdgeBefore: 3000, maxEdgeAfter: 896 })
  })
})

describe('UsageTap', () => {
  test('finds usage in a JSON body and in the last SSE chunks, split anywhere', () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(50_000) } }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } })
    const tap = new UsageTap()
    for (let i = 0; i < body.length; i += 777) tap.push(enc.encode(body.slice(i, i + 777)))
    expect(tap.result()).toEqual({ promptTokens: 12, completionTokens: 34 })

    const sse = new UsageTap()
    sse.push(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
    sse.push(enc.encode('data: {"usage":{"prompt_tokens":5,"comple'))
    sse.push(enc.encode('tion_tokens":6}}\n\ndata: [DONE]\n\n'))
    expect(sse.result()).toEqual({ promptTokens: 5, completionTokens: 6 })
  })

  test('embeddings have no completion tokens; nothing at all gives nulls; only a tail is kept', () => {
    const e = new UsageTap()
    e.push(enc.encode('{"data":[],"usage":{"prompt_tokens":9,"total_tokens":9}}'))
    expect(e.result()).toEqual({ promptTokens: 9, completionTokens: null })
    expect(new UsageTap().result()).toEqual({ promptTokens: null, completionTokens: null })

    const big = new UsageTap(1024)
    big.push(enc.encode('{"usage":{"prompt_tokens":1,"completion_tokens":1}}'))
    for (let i = 0; i < 200; i++) big.push(enc.encode('x'.repeat(100)))
    expect(big.result()).toEqual({ promptTokens: null, completionTokens: null }) // far from the end: not found, not an error
  })

  test('text that merely mentions the field is not mistaken for usage', () => {
    const t = new UsageTap()
    t.push(enc.encode('{"choices":[{"message":{"content":"the \\"prompt_tokens\\": 99 field"}}]}'))
    expect(t.result().promptTokens).toBeNull()
  })
})
