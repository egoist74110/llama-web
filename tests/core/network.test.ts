import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { NetworkInterfaceInfo } from 'node:os'
import { detectLanAddress, selectLanAddress } from '../../server/core/network'

const ip = (address: string, internal = false, family = 'IPv4') =>
  ({ address, internal, family } as NetworkInterfaceInfo)
const interfaces = () => ({
  'vEthernet (Default Switch)': [ip('172.18.0.1')],
  Ethernet: [ip('192.168.1.20'), ip('2001:db8::20', false, 'IPv6')],
  WiFi: [ip('10.0.0.20')],
  Loopback: [ip('127.0.0.1', true)],
  Offline: [ip('169.254.1.20')],
})

test('LAN address prefers the default route over interface enumeration order', () => {
  expect(selectLanAddress(interfaces(), '10.0.0.20')).toBe('10.0.0.20')
  expect(selectLanAddress(interfaces(), '192.168.1.20')).toBe('192.168.1.20')
  expect(selectLanAddress(interfaces())).toBe('192.168.1.20')
  expect(selectLanAddress(interfaces(), '192.168.1.99')).toBe('192.168.1.20')
})

test('LAN address accepts routable non-private subnets and excludes unusable addresses', () => {
  expect(selectLanAddress({ Ethernet: [ip('198.51.100.20')] })).toBe('198.51.100.20')
  expect(selectLanAddress({ Loopback: [ip('127.0.0.1', true)], Offline: [ip('169.254.1.20')], V6: [ip('::1', true, 'IPv6')] })).toBeNull()
  expect(selectLanAddress({})).toBeNull()
})

class FakeSocket extends EventEmitter {
  closed = 0
  constructor(readonly mode: 'ready' | 'error' | 'throw' | 'pending' = 'ready') { super() }
  connect(_port: number, _host: string, ready: () => void) {
    if (this.mode === 'throw') throw new Error('connect failed')
    if (this.mode === 'error') this.emit('error', new Error('no route'))
    if (this.mode === 'ready') ready()
  }
  address() { return { address: '10.0.0.20' } }
  close() { this.closed++ }
}

test('route probe closes its socket on success, error and synchronous failure', async () => {
  for (const mode of ['ready', 'error', 'throw'] as const) {
    const socket = new FakeSocket(mode)
    const result = await detectLanAddress({ interfaces, socket: () => socket })
    expect(result).toBe(mode === 'ready' ? '10.0.0.20' : '192.168.1.20')
    expect(socket.closed).toBe(1)
  }
})

test('route probe closes on timeout and cancellation; pre-aborted probes open nothing', async () => {
  const socket = new FakeSocket('pending')
  expect(await detectLanAddress({ interfaces, socket: () => socket, timeoutMs: 1 })).toBe('192.168.1.20')
  expect(socket.closed).toBe(1)
  const controller = new AbortController()
  const cancelled = new FakeSocket('pending')
  const pending = detectLanAddress({ interfaces, socket: () => cancelled, signal: controller.signal })
  controller.abort()
  expect(await pending).toBe('192.168.1.20')
  expect(cancelled.closed).toBe(1)
  let opened = false
  await detectLanAddress({ interfaces, signal: controller.signal, socket: () => { opened = true; return new FakeSocket() } })
  expect(opened).toBe(false)
})
