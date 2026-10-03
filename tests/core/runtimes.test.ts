import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listInstalled, versionsDir } from '../../server/core/llamacpp'
import type { RuntimeTarget } from '../../server/core/platform'
import {
  binaryRunsHere, channelsFor, customDir, normalizeRuntimes, parseRuntimeRef, refOfExe, resolveRuntimeRef, RuntimeRegistry, RuntimeResolveError,
  selectableHere, sniffBinary, type RuntimeEntry,
} from '../../server/core/runtimes'
import { elf, machoArm64, machoUniversal, machoX64, peArm64, peX64 } from '../fixtures/fake-binary'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-rts-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const win: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const mac: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }
const entry = (id: string, over: Partial<RuntimeEntry> = {}): RuntimeEntry => ({
  id, label: `build ${id}`, source: { kind: 'dir', from: 'X:\\src' }, os: 'win32', arch: 'x64', accel: 'cuda', tag: 'b500', addedAt: '2026-10-03T00:00:00Z', ...over,
})
const install = (target: RuntimeTarget, tag: string) => {
  const exe = target.os === 'win32' ? 'llama-server.exe' : 'llama-server'
  const dir = join(versionsDir(data), `${target.os}-${target.arch}-${target.acceleration}`, tag)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, exe), '')
  return join(dir, exe)
}
const addCustom = (e: RuntimeEntry) => {
  const exe = e.os === 'win32' ? 'llama-server.exe' : 'llama-server'
  mkdirSync(customDir(data, e.id), { recursive: true })
  writeFileSync(join(customDir(data, e.id), exe), '')
}

describe('references', () => {
  test('parse', () => {
    expect(parseRuntimeRef('cuda:b11146')).toEqual({ kind: 'official', accel: 'cuda', tag: 'b11146' })
    expect(parseRuntimeRef('metal:b9')).toEqual({ kind: 'official', accel: 'metal', tag: 'b9' })
    expect(parseRuntimeRef('custom:r1a2b3')).toEqual({ kind: 'custom', id: 'r1a2b3' })
    for (const bad of ['', 'cuda:', 'cuda:1234', 'vulkan:b1', 'custom:../x', 'custom:A', 'custom:', 'b123', null, 5, 'cuda:b1;rm']) expect(parseRuntimeRef(bad)).toBeNull()
  })
  test('channels per host', () => {
    expect(channelsFor({ os: 'win32', arch: 'x64' })).toEqual(['cuda', 'cpu'])
    expect(channelsFor({ os: 'darwin', arch: 'arm64' })).toEqual(['metal'])
    expect(channelsFor({ os: 'darwin', arch: 'x64' })).toEqual(['cpu'])
    expect(channelsFor({ os: 'linux', arch: 'x64' })).toEqual([])
  })
})

describe('platform isolation by file header', () => {
  test('PE / Mach-O / ELF are recognised with their architecture', () => {
    expect(sniffBinary(peX64())).toEqual({ os: 'win32', archs: ['x64'] })
    expect(sniffBinary(peArm64())).toEqual({ os: 'win32', archs: ['arm64'] })
    expect(sniffBinary(machoArm64())).toEqual({ os: 'darwin', archs: ['arm64'] })
    expect(sniffBinary(machoX64())).toEqual({ os: 'darwin', archs: ['x64'] })
    expect(sniffBinary(machoUniversal([0x01000007, 0x0100000c]))).toEqual({ os: 'darwin', archs: ['x64', 'arm64'] })
    expect(sniffBinary(elf(0x3e))).toEqual({ os: 'linux', archs: ['x64'] })
  })
  test('a Java class (cafebabe), a script and an empty file are not executables', () => {
    const javaClass = Buffer.alloc(64)
    javaClass.writeUInt32BE(0xcafebabe, 0)
    javaClass.writeUInt32BE(0x00000034, 4)
    expect(sniffBinary(javaClass)).toBeNull()
    expect(sniffBinary(Buffer.from('#!/bin/sh\necho hi\n'))).toBeNull()
    expect(sniffBinary(Buffer.alloc(0))).toBeNull()
  })
  test('Windows rejects Mach-O, Mac rejects PE and the other architecture', () => {
    expect(binaryRunsHere(sniffBinary(peX64())!, win)).toBe(true)
    expect(binaryRunsHere(sniffBinary(machoArm64())!, win)).toBe(false)
    expect(binaryRunsHere(sniffBinary(peX64())!, mac)).toBe(false)
    expect(binaryRunsHere(sniffBinary(machoX64())!, mac)).toBe(false) // no Rosetta
    expect(binaryRunsHere(sniffBinary(machoUniversal([0x01000007, 0x0100000c]))!, mac)).toBe(true)
  })
  test('selectableHere: other-platform entries and channels cannot be chosen', () => {
    const entries = [entry('r1'), entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' })]
    expect(selectableHere('custom:r1', { target: win, entries })).toBe(true)
    expect(selectableHere('custom:r2', { target: win, entries })).toBe(false)
    expect(selectableHere('custom:r2', { target: mac, entries })).toBe(true)
    expect(selectableHere('cuda:b1', { target: mac, entries })).toBe(false)
    expect(selectableHere('metal:b1', { target: win, entries })).toBe(false)
    expect(selectableHere('custom:nope', { target: win, entries })).toBe(false)
  })
})

describe('registry file', () => {
  test('round trip, and a hand edit with a bad id / platform / accel is dropped', () => {
    const reg = new RuntimeRegistry(data)
    reg.add(entry('r1'))
    expect(new RuntimeRegistry(data).list().map(e => e.id)).toEqual(['r1'])
    const doc = normalizeRuntimes({ version: 1, entries: [entry('r1'), entry('../evil'), entry('r1'), entry('r3', { os: 'plan9' as never }), entry('r4', { accel: 'vulkan' as never }), entry('r5')] })
    expect(doc.entries.map(e => e.id)).toEqual(['r1', 'r5'])
  })
  test('corrupt file: moved aside, newest readable backup restored', () => {
    const reg = new RuntimeRegistry(data)
    reg.add(entry('r1'))
    reg.add(entry('r2')) // the second write backs up the first state
    reg.close()
    writeFileSync(join(data, 'runtimes.json'), '{ not json')
    const again = new RuntimeRegistry(data)
    expect(again.recovered?.fromBackup).toMatch(/^runtimes\./)
    expect(again.list().length).toBeGreaterThan(0)
    expect(readdirSync(data).some(n => n.startsWith('runtimes.json.bad-'))).toBe(true)
  })
  test('corrupt file without backups: empty registry, file kept as .bad', () => {
    writeFileSync(join(data, 'runtimes.json'), '[]')
    const reg = new RuntimeRegistry(data)
    expect(reg.list()).toEqual([])
    expect(reg.recovered?.fromBackup).toBeNull()
    reg.add(entry('r1'))
    expect(reg.list().length).toBe(1)
  })
  test('a file from a newer llama-web is left alone and adding is refused', () => {
    writeFileSync(join(data, 'runtimes.json'), JSON.stringify({ version: 99, entries: [] }))
    const reg = new RuntimeRegistry(data)
    expect(reg.unavailable).toContain('newer')
    expect(() => reg.add(entry('r1'))).toThrow()
    expect(JSON.parse(readFileSync(join(data, 'runtimes.json'), 'utf8')).version).toBe(99)
  })
  test('a broken hand edit while running keeps the last good list', () => {
    const reg = new RuntimeRegistry(data)
    reg.add(entry('r1'))
    writeFileSync(join(data, 'runtimes.json'), '{ broken')
    expect(reg.list().map(e => e.id)).toEqual(['r1'])
  })
})

describe('resolveRuntimeRef', () => {
  const env = (target = win, entries: RuntimeEntry[] = []) => ({ dataDir: data, target, entries })

  test('official reference of an installed version', () => {
    const exe = install(win, 'b200')
    install(win, 'b300')
    expect(resolveRuntimeRef('cuda:b200', env())).toEqual({ ref: 'cuda:b200', exe, label: 'b200', fallback: null })
  })
  test('the CPU channel resolves independently of the global CUDA channel', () => {
    install(win, 'b300')
    const cpu = install({ ...win, acceleration: 'cpu' }, 'b250')
    expect(resolveRuntimeRef('cpu:b250', env()).exe).toBe(cpu)
  })
  test('missing version -> newest official of the same channel, with the reason', () => {
    install(win, 'b200')
    install(win, 'b300')
    install({ ...win, acceleration: 'cpu' }, 'b150')
    const r = resolveRuntimeRef('cuda:b100', env())
    expect(r.ref).toBe('cuda:b300')
    expect(r.fallback).toEqual({ from: 'cuda:b100', reason: 'missing', to: 'cuda:b300' })
    expect(resolveRuntimeRef('cpu:b1', env()).fallback).toEqual({ from: 'cpu:b1', reason: 'missing', to: 'cpu:b150' })
  })
  test('invalid reference text falls back to the global channel', () => {
    install(win, 'b300')
    expect(resolveRuntimeRef('nonsense', env()).fallback).toEqual({ from: 'nonsense', reason: 'invalid', to: 'cuda:b300' })
  })
  test('reference to another platform (Mac channel on Windows) is "other-platform", never launched', () => {
    install(win, 'b300')
    const r = resolveRuntimeRef('metal:b9', env())
    expect(r.fallback?.reason).toBe('other-platform')
    expect(r.exe).toContain('b300')
  })
  test('custom entry: used when present; missing entry / missing exe / other platform fall back', () => {
    install(win, 'b300')
    const here = entry('r1')
    addCustom(here)
    const elsewhere = entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' })
    const gone = entry('r3') // registered, files deleted by hand
    const e = env(win, [here, elsewhere, gone])
    expect(resolveRuntimeRef('custom:r1', e)).toMatchObject({ ref: 'custom:r1', label: 'build r1', fallback: null })
    expect(resolveRuntimeRef('custom:r1', e).exe).toBe(join(customDir(data, 'r1'), 'llama-server.exe'))
    expect(resolveRuntimeRef('custom:r2', e).fallback?.reason).toBe('other-platform')
    expect(resolveRuntimeRef('custom:r3', e).fallback?.reason).toBe('missing')
    expect(resolveRuntimeRef('custom:zzz', e).fallback?.reason).toBe('missing')
  })
  test('the channel has no official build at all: the only failure', () => {
    expect(() => resolveRuntimeRef('cuda:b1', env())).toThrow(RuntimeResolveError)
    expect(() => resolveRuntimeRef('custom:r9', env())).toThrow(RuntimeResolveError)
  })
  test('Mac: a Windows entry in the registry is hidden and falls back', () => {
    const exe = install(mac, 'b400')
    const winEntry = entry('r1')
    addCustom(winEntry)
    const r = resolveRuntimeRef('custom:r1', env(mac, [winEntry]))
    expect(r.exe).toBe(exe)
    expect(r.fallback?.reason).toBe('other-platform')
  })
})

describe('refOfExe', () => {
  test('official target directories, the old flat layout and custom builds', () => {
    const base = versionsDir(data)
    expect(refOfExe(data, join(base, 'win32-x64-cuda', 'b5', 'llama-server.exe'), 'win32')).toBe('cuda:b5')
    expect(refOfExe(data, join(base, 'win32-x64-cpu', 'b6', 'llama-server.exe'), 'win32')).toBe('cpu:b6')
    expect(refOfExe(data, join(base, 'b7', 'llama-server.exe'), 'win32')).toBe('cuda:b7')
    expect(refOfExe(data, join(base, 'custom', 'r1', 'llama-server.exe'), 'win32')).toBe('custom:r1')
    expect(refOfExe(data, join(base, 'custom', '.stage-1', 'out', 'llama-server.exe'), 'win32')).toBeNull()
    expect(refOfExe(data, 'C:\\tools\\llama-server.exe', 'win32')).toBeNull()
  })
})

test('hand-added builds are not official versions (never listed, never pruned)', () => {
  addCustom(entry('r1'))
  install(win, 'b300')
  expect(listInstalled(data, 'win32', win)).toEqual(['b300'])
  expect(existsSync(customDir(data, 'r1'))).toBe(true)
})
