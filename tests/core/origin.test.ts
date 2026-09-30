import { expect, test } from 'bun:test'
import { checkAdminRequest } from '../../server/core/origin'

const req = (method: string, headers: Record<string, string>) => checkAdminRequest({ method, headers: new Headers(headers) })
const json = { 'content-type': 'application/json', 'content-length': '20' }

test('same-origin page writes are allowed', () => {
  expect(req('POST', { ...json, host: '192.168.1.5:5001', origin: 'http://192.168.1.5:5001', 'sec-fetch-site': 'same-origin' })).toBeNull()
  expect(req('POST', { ...json, host: 'LOCALHOST:5001', origin: 'http://localhost:5001' })).toBeNull()
})

test('clients without Origin / Sec-Fetch-Site (curl, scripts) are allowed', () => {
  expect(req('POST', { ...json, host: '127.0.0.1:5001' })).toBeNull()
  expect(req('POST', { ...json, host: '127.0.0.1:5001', 'sec-fetch-site': 'none' })).toBeNull()
})

test('cross-origin writes are refused, JSON or form', () => {
  expect(req('POST', { ...json, host: '127.0.0.1:5001', origin: 'https://example.com' })).toBe('cross-origin')
  expect(req('POST', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '9', host: '127.0.0.1:5001', origin: 'https://example.com', 'sec-fetch-site': 'cross-site' })).toBe('cross-origin')
  expect(req('POST', { ...json, host: '127.0.0.1:5001', 'sec-fetch-site': 'same-site' })).toBe('cross-origin')
  expect(req('POST', { ...json, host: '127.0.0.1:5001', origin: 'null' })).toBe('cross-origin')
  expect(req('DELETE', { host: '127.0.0.1:5001', origin: 'http://127.0.0.1:9999' })).toBe('cross-origin')
})

test('write bodies must be JSON even without Origin', () => {
  expect(req('POST', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '9', host: '127.0.0.1:5001' })).toBe('json-required')
  expect(req('POST', { 'content-type': 'text/plain', 'transfer-encoding': 'chunked', host: '127.0.0.1:5001' })).toBe('json-required')
  expect(req('POST', { 'content-type': 'application/json; charset=utf-8', 'content-length': '2', host: '127.0.0.1:5001' })).toBeNull()
  expect(req('POST', { host: '127.0.0.1:5001', 'content-length': '0' })).toBeNull()
})

test('reads are never blocked', () => {
  expect(req('GET', { host: '127.0.0.1:5001', origin: 'https://example.com', 'sec-fetch-site': 'cross-site' })).toBeNull()
})
