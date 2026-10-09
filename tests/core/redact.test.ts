// Masking of a saved upstream key in what an external upstream sends back (decision 56 ④).
import { expect, test } from 'bun:test'
import { redactHeaders, redactText, StreamRedactor } from '../../server/core/redact'

const KEY = 'fake-upstream-key-123'
const dec = new TextDecoder()
const enc = new TextEncoder()

function run(chunks: string[], key = KEY): string {
  const r = new StreamRedactor(key)
  let out = ''
  for (const c of chunks) out += dec.decode(r.push(enc.encode(c)))
  return out + dec.decode(r.flush())
}

test('text and headers: the key is masked, everything else stays', () => {
  expect(redactText(`bad key ${KEY}!`, KEY)).toBe('bad key ***!')
  const h = redactHeaders(new Headers({ 'x-debug': `auth=${KEY}`, 'x-other': 'fine' }), KEY)
  expect(h.get('x-debug')).toBe('auth=***')
  expect(h.get('x-other')).toBe('fine')
})

test('a key of any length is masked, an empty key means no credential', () => {
  for (const key of ['a', 'abc', 'abcde', 'abcdef', 'ключ-密钥']) {
    expect(redactText(`x ${key} y`, key)).toBe('x *** y')
    if (/^[\x20-\x7e]+$/.test(key)) expect(redactHeaders(new Headers({ 'x-echo': key }), key).get('x-echo')).toBe('***') // header values are ASCII
    expect(run([`x ${key} y`], key)).toBe('x *** y')
  }
  expect(run(['ab', 'c ab', 'c'], 'abc')).toBe('*** ***')
  expect(redactText('abc abc', '')).toBe('abc abc')
  expect(run(['abc abc'], '')).toBe('abc abc')
})

test('stream: whole, repeated and split-across-chunks occurrences are all masked', () => {
  expect(run([`{"error":"${KEY}"}`])).toBe('{"error":"***"}')
  expect(run([`${KEY} and ${KEY}`])).toBe('*** and ***')
  expect(run(['data: fake-upstre', 'am-key-', '123\n\n'])).toBe('data: ***\n\n')
  expect(run(['x', KEY.slice(0, 5), KEY.slice(5, 11), KEY.slice(11)])).toBe('x***')
})

test('stream: a tail that only looks like the start of the key is not lost', () => {
  expect(run(['hello fake-up', 'stairs'])).toBe('hello fake-upstairs')
  expect(run(['ends with fake-up'])).toBe('ends with fake-up')
})

test('stream: ordinary chunks are passed at once (nothing is held back)', () => {
  const r = new StreamRedactor(KEY)
  expect(dec.decode(r.push(enc.encode('data: {"x":1}\n\n')))).toBe('data: {"x":1}\n\n')
  expect(r.flush().length).toBe(0)
})
