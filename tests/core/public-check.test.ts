import { describe, expect, test } from 'bun:test'
import { checkAddress, checkAddresses, publicAddresses } from '../../server/core/public-check'

type Init = RequestInit | undefined
const respond = (status: number, body = '') => async () => new Response(body, { status })
const fail = (e: object) => async () => { throw Object.assign(new Error((e as { message?: string }).message ?? 'x'), e) }

describe('publicAddresses', () => {
  const own = (domain: string) => ({ tunnelMode: 'token' as const, domain })
  const quick = (domain: string) => ({ tunnelMode: 'quick' as const, domain })
  const t = (hostnames: string[] | null, quickHost: string | null = null) => ({ hostnames, quickHost })

  test('own tunnel: saved domain first, then the tunnel host names; no duplicates or blanks', () => {
    expect(publicAddresses(own('llm.example.com'), t(['b.example.net', 'LLM.example.com']))).toEqual(['llm.example.com', 'b.example.net'])
    expect(publicAddresses(own(''), t(null))).toEqual([])
    expect(publicAddresses(own(''), t(['a.example.com']))).toEqual(['a.example.com'])
    // A quick address left in the status does not count for the own tunnel.
    expect(publicAddresses(own('llm.example.com'), t(null, 'a-b-c.trycloudflare.com'))).toEqual(['llm.example.com'])
  })

  test('quick tunnel: only the address the running process printed, never the saved domain', () => {
    expect(publicAddresses(quick('llm.example.com'), t(['b.example.net'], 'A-b-c.trycloudflare.com'))).toEqual(['a-b-c.trycloudflare.com'])
    // Not printed yet (or the process ended): nothing to show or check.
    expect(publicAddresses(quick('llm.example.com'), t(['b.example.net'], null))).toEqual([])
  })
})

describe('checkAddress', () => {
  test('requests https://host/v1/models without any credential and without following redirects', async () => {
    const seen: Array<{ url: string, init: Init }> = []
    await checkAddress('llm.example.com', { fetch: async (url, init) => { seen.push({ url, init }); return new Response('', { status: 401 }) } })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://llm.example.com/v1/models')
    expect(seen[0]!.init?.redirect).toBe('manual')
    const headers = new Headers(seen[0]!.init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  test('401 is reachable; 530 / 1033, 502, 404 and others are told apart', async () => {
    const code = async (f: Parameters<typeof checkAddress>[1]['fetch']) => (await checkAddress('a.example.com', { fetch: f })).code
    expect(await code(respond(401))).toBe('ok')
    expect(await code(respond(530))).toBe('tunnel-down')
    expect(await code(respond(403, 'error code: 1033'))).toBe('tunnel-down')
    expect(await code(respond(502))).toBe('origin')
    expect(await code(respond(504))).toBe('origin')
    expect(await code(respond(404))).toBe('no-route')
    expect(await code(respond(200))).toBe('unexpected')
    const r = await checkAddress('a.example.com', { fetch: respond(530) })
    expect(r).toMatchObject({ host: 'a.example.com', status: 530, detail: '530' })
  })

  test('network failures: timeout, DNS, other', async () => {
    const one = (f: Parameters<typeof checkAddress>[1]['fetch']) => checkAddress('a.example.com', { fetch: f })
    expect((await one(fail({ name: 'TimeoutError' }))).code).toBe('timeout')
    expect((await one(fail({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND a.example.com' }))).code).toBe('dns')
    const resolves = async () => [{ address: '192.0.2.1' }]
    const other = await checkAddress('a.example.com', { fetch: fail({ code: 'ECONNRESET', message: 'reset' }), lookup: resolves })
    expect(other).toMatchObject({ code: 'network', status: null, detail: 'ECONNRESET' })
    // Bun reports an unknown name as ConnectionRefused: the lookup tells it apart.
    const noName = await checkAddress('a.example.com', { fetch: fail({ code: 'ConnectionRefused', message: 'Unable to connect' }), lookup: async () => { throw new Error('ENOTFOUND') } })
    expect(noName.code).toBe('dns')
  })

  test('a slow answer times out', async () => {
    const hang = (_: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))
    })
    const r = await checkAddress('a.example.com', { fetch: hang, timeoutMs: 30 })
    expect(r.code).toBe('timeout')
  })

  test('checkAddresses checks each host', async () => {
    const r = await checkAddresses(['a.example.com', 'b.example.com'], {
      fetch: async url => new Response('', { status: url.includes('//a.') ? 401 : 530 }),
    })
    expect(r.map(x => [x.host, x.code])).toEqual([['a.example.com', 'ok'], ['b.example.com', 'tunnel-down']])
  })
})
