// Dev-mode bridge (nuxt dev does not use server/entry.ts): turn an h3 event into a Request
// whose signal aborts when the client disconnects, so leases are released like in production.
import { getRequestURL, getRequestWebStream, type H3Event } from 'h3'

export function toAbortableRequest(event: H3Event): Request {
  const ac = new AbortController()
  const res = event.node.res
  res.once('close', () => { if (!res.writableFinished) ac.abort(new Error('client disconnected')) })
  // `duplex` is required by Node/undici for streamed request bodies (not in every lib's RequestInit).
  const init: RequestInit & { duplex: 'half' } = {
    method: event.method,
    headers: event.headers,
    body: getRequestWebStream(event),
    signal: ac.signal,
    duplex: 'half',
  }
  return new Request(getRequestURL(event), init)
}
