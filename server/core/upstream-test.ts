// Connection test of an external upstream (decision 56): `GET <baseUrl>/models` with the upstream's key. Pure module.
import { parseModelList, type Upstream } from './upstreams'

export type TestResult =
  | { ok: true, models: string[] }
  | { ok: false, code: 'unauthorized' | 'status' | 'unreachable', status?: number, detail?: string }

export async function testConnection(u: Pick<Upstream, 'baseUrl'>, key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<TestResult> {
  let res: Response
  try {
    res = await fetchImpl(`${u.baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
  } catch (e) {
    return { ok: false, code: 'unreachable', detail: String((e as Error)?.message ?? e) }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', status: res.status }
  if (!res.ok) return { ok: false, code: 'status', status: res.status }
  let body: unknown = null
  try { body = await res.json() } catch { /* an answer without a model list */ }
  return { ok: true, models: parseModelList(body) }
}
