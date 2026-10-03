// Addresses advertised to local clients. A UDP connect asks the OS which interface its
// default route uses; no datagram is sent and no remote service needs to answer.
import { createSocket } from 'node:dgram'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>
const VIRTUAL = /loopback|vethernet|docker|vmware|virtualbox|tailscale|\b(?:tun|tap|utun|wg)\d*\b/i

export function selectLanAddress(interfaces: Interfaces, preferred?: string | null): string | null {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? []).filter(a => !a.internal && a.family === 'IPv4'
      && !a.address.startsWith('127.') && !a.address.startsWith('169.254.') && a.address !== '0.0.0.0')
      .map(a => ({ address: a.address, virtual: VIRTUAL.test(name) })))
  const physical = candidates.filter(a => !a.virtual)
  const usable = physical.length ? physical : candidates
  return usable.find(a => a.address === preferred)?.address ?? usable[0]?.address ?? null
}

export const getLanAddress = (preferred?: string | null): string | null => selectLanAddress(networkInterfaces(), preferred)

interface RouteSocket {
  once(event: 'error', listener: () => void): unknown
  connect(port: number, host: string, ready: () => void): unknown
  address(): { address: string }
  close(): unknown
}

export function detectLanAddress(opts: {
  signal?: AbortSignal
  interfaces?: () => Interfaces
  socket?: () => RouteSocket
  timeoutMs?: number
} = {}): Promise<string | null> {
  const interfaces = opts.interfaces ?? networkInterfaces
  if (opts.signal?.aborted) return Promise.resolve(selectLanAddress(interfaces()))
  return new Promise(resolve => {
    let socket: RouteSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (preferred?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try { socket?.close() } catch { /* may not have bound before connect failed */ }
      resolve(selectLanAddress(interfaces(), preferred))
    }
    const onAbort = () => finish()
    try {
      socket = (opts.socket ?? (() => createSocket('udp4')))()
      socket.once('error', () => finish())
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(), opts.timeoutMs ?? 1000)
      if (opts.signal?.aborted) return finish()
      socket.connect(9, '192.0.2.1', () => {
        if (done) return
        try { finish(socket!.address().address) } catch { finish() }
      })
    } catch { finish() }
  })
}
