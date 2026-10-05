import { expect, test } from 'bun:test'
import { errorMessage, parseSse, readDelta, renderMarkdown } from '../../app/utils/chat'

test('SSE: complete events are returned, the unfinished tail is kept for the next chunk', () => {
  const a = parseSse('data: {"a":1}\n\ndata: {"b"')
  expect(a).toEqual({ data: ['{"a":1}'], rest: 'data: {"b"' })
  const b = parseSse(a.rest + ':2}\r\n\r\ndata: [DONE]\r\n\r\n')
  expect(b.data).toEqual(['{"b":2}', '[DONE]'])
  expect(b.rest).toBe('')
  expect(parseSse(': keep-alive\n\n').data).toEqual([])
})

test('stream payloads: content, reasoning, timings, done; garbage adds nothing', () => {
  expect(readDelta('{"choices":[{"delta":{"content":"hi"}}]}').content).toBe('hi')
  expect(readDelta('{"choices":[{"delta":{"reasoning_content":"hm"}}]}').reasoning).toBe('hm')
  expect(readDelta('{"choices":[],"timings":{"predicted_n":12,"predicted_per_second":30.5}}').stats).toEqual({ tokens: 12, perSec: 30.5 })
  expect(readDelta('[DONE]').done).toBe(true)
  expect(readDelta('not json')).toEqual({ content: '', reasoning: '', done: false, stats: null })
})

test('error bodies', () => {
  expect(errorMessage('{"error":{"message":"模型没有运行"}}', 'x')).toBe('模型没有运行')
  expect(errorMessage('<html>', 'fallback')).toBe('fallback')
})

test('markdown: structure', () => {
  expect(renderMarkdown('# T\n\nhello **b** and *i* `c`')).toBe('<h3>T</h3><p>hello <strong>b</strong> and <em>i</em> <code>c</code></p>')
  expect(renderMarkdown('- a\n- b\n\n1. x\n2. y')).toBe('<ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>')
  expect(renderMarkdown('```js\nif (a < b) {}\n```')).toBe('<pre><code>if (a &lt; b) {}</code></pre>')
  expect(renderMarkdown('```\nunfinished')).toBe('<pre><code>unfinished</code></pre>')
  expect(renderMarkdown('l1\nl2')).toBe('<p>l1<br>l2</p>')
  expect(renderMarkdown('> q')).toBe('<blockquote>q</blockquote>')
  expect(renderMarkdown('a\n---\nb')).toBe('<p>a</p><hr><p>b</p>')
  expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
})

test('markdown: model output can never inject HTML or scripts', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<script')
  expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a')
  expect(renderMarkdown('[ok](https://example.com/a?b=1&c="2")')).toContain('href="https://example.com/a?b=1&amp;c=&quot;2&quot;"')
  expect(renderMarkdown('`<b>`')).toBe('<p><code>&lt;b&gt;</code></p>')
  expect(renderMarkdown('```\n<script>x</script>\n```')).not.toContain('<script>')
})

import { dataUrlBytes, imageLimit, MAX_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES, newMessage, streamChat, titleFrom, toRequestMessages, type ChatSession } from '../../app/utils/chat'
import { memoryBackend } from '../../app/utils/chat-db'

test('image limits and title', () => {
  expect(dataUrlBytes('data:image/png;base64,QUJD')).toBe(3)
  expect(dataUrlBytes('data:image/png;base64,QQ==')).toBe(1)
  expect(imageLimit(MAX_IMAGE_BYTES + 1, 0)).toBe('single')
  expect(imageLimit(1024, MAX_SESSION_IMAGE_BYTES)).toBe('total')
  expect(imageLimit(1024, 0)).toBeNull()
  expect(titleFrom('  hello\n world ', 'x')).toBe('hello world')
  expect(titleFrom('a'.repeat(40), 'x')).toBe(`${'a'.repeat(24)}…`)
  expect(titleFrom('   ', '新对话')).toBe('新对话')
})

test('request messages: images become image_url parts, failed replies are dropped', () => {
  const u = newMessage('user', 'look', ['data:image/png;base64,QQ=='])
  const a = newMessage('assistant', 'ok')
  const bad = newMessage('assistant', '')
  bad.error = 'boom'
  const u2 = newMessage('user', 'again')
  expect(toRequestMessages([u, a, bad, u2])).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
  ])
})

const sse = (chunks: string[], status = 200) => (async () => new Response(
  new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() } }), { status },
)) as unknown as typeof fetch

test('streamChat: deltas arrive across split chunks, timings are returned', async () => {
  const got: string[] = []
  const r = await streamChat(sse([
    'data: {"choices":[{"delta":{"reasoning_content":"th"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"hi"}}]}\n\ndata: {"choices":[],"timings":{"predicted_n":2,"predicted_per_second":9}}\n\ndata: [DONE]\n\n',
  ]), { model: 'm', messages: [] }, new AbortController().signal, d => got.push(`${d.reasoning}|${d.content}`), s => `HTTP ${s}`)
  expect(got.filter(x => x !== '|')).toEqual(['th|', '|hi'])
  expect(r.stats).toEqual({ tokens: 2, perSec: 9 })
})

test('streamChat: server error text is surfaced, fallback otherwise', async () => {
  const fail = (body: string, status: number) => (async () => new Response(body, { status })) as unknown as typeof fetch
  const sig = new AbortController().signal
  await expect(streamChat(fail('{"error":{"message":"没有图片能力"}}', 400), { model: 'm', messages: [] }, sig, () => {}, s => `HTTP ${s}`)).rejects.toThrow('没有图片能力')
  await expect(streamChat(fail('<html>', 502), { model: 'm', messages: [] }, sig, () => {}, s => `HTTP ${s}`)).rejects.toThrow('HTTP 502')
})

test('streamChat: abort stops the stream', async () => {
  const ac = new AbortController()
  const hang = (async (_u: unknown, init: RequestInit) => new Response(new ReadableStream({
    start(c) { init.signal!.addEventListener('abort', () => c.error(new DOMException('x', 'AbortError'))) },
  }))) as unknown as typeof fetch
  const p = streamChat(hang, { model: 'm', messages: [] }, ac.signal, () => {}, s => `${s}`)
  ac.abort()
  await expect(p).rejects.toThrow()
})

test('memory backend stores copies', async () => {
  const b = memoryBackend()
  const s: ChatSession = { id: '1', title: 't', model: 'm', renamed: false, createdAt: 1, updatedAt: 1, messages: [] }
  await b.put(s)
  s.title = 'changed'
  expect((await b.all())[0]!.title).toBe('t')
  await b.remove('1')
  expect(await b.all()).toEqual([])
})
