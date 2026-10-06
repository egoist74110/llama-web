// Connection test of an external upstream: what it sends and how each answer is told apart.
import { expect, test } from 'bun:test'
import { testConnection } from '../../server/core/upstream-test'

const u = { baseUrl: 'http://x/v1' }
const fake = (res: () => Response | Promise<Response>, seen: Array<{ url: string, auth: string | null }> = []) =>
  (async (url: any, init: any) => { seen.push({ url: String(url), auth: init.headers.authorization ?? null }); return res() }) as unknown as typeof fetch

test('a listed answer gives the model ids; the key goes in the Authorization header', async () => {
  const seen: Array<{ url: string, auth: string | null }> = []
  const r = await testConnection(u, 'sk-up', fake(() => Response.json({ data: [{ id: 'a' }, { id: 'b' }] }), seen))
  expect(r).toEqual({ ok: true, models: ['a', 'b'] })
  expect(seen).toEqual([{ url: 'http://x/v1/models', auth: 'Bearer sk-up' }])
  await testConnection(u, '', fake(() => Response.json({}), seen))
  expect(seen[1]!.auth).toBeNull()
})

test('an answer that is not a list is still a working connection with no models', async () => {
  expect(await testConnection(u, '', fake(() => new Response('<html>', { status: 200 })))).toEqual({ ok: true, models: [] })
})

test('401 / 403, other statuses and network failures are told apart', async () => {
  expect(await testConnection(u, 'k', fake(() => new Response('', { status: 401 })))).toEqual({ ok: false, code: 'unauthorized', status: 401 })
  expect(await testConnection(u, 'k', fake(() => new Response('', { status: 403 })))).toMatchObject({ code: 'unauthorized' })
  expect(await testConnection(u, 'k', fake(() => new Response('', { status: 404 })))).toEqual({ ok: false, code: 'status', status: 404 })
  const r = await testConnection(u, 'sk-up', (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch)
  expect(r).toMatchObject({ ok: false, code: 'unreachable', detail: 'connect ECONNREFUSED' })
})
