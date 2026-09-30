// Builds tiny fake GGUF files (header only, no tensor data) for tests.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type KvValue =
  | { t: 'u32', v: number }
  | { t: 'u64', v: number }
  | { t: 'f32', v: number }
  | { t: 'bool', v: boolean }
  | { t: 'str', v: string }
  | { t: 'strarr', v: string[] }
  | { t: 'u32arr', v: number[] }

export interface FakeGguf {
  version?: number
  kvs?: Array<[string, KvValue]>
  /** [dims, ggml type] */
  tensors?: Array<{ dims: number[], type: number }>
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const str = (s: string) => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u64(d.length), d]) }

function value(kv: KvValue): Buffer {
  switch (kv.t) {
    case 'u32': return Buffer.concat([u32(4), u32(kv.v)])
    case 'u64': return Buffer.concat([u32(10), u64(kv.v)])
    case 'f32': { const b = Buffer.alloc(4); b.writeFloatLE(kv.v); return Buffer.concat([u32(6), b]) }
    case 'bool': return Buffer.concat([u32(7), Buffer.from([kv.v ? 1 : 0])])
    case 'str': return Buffer.concat([u32(8), str(kv.v)])
    case 'strarr': return Buffer.concat([u32(9), u32(8), u64(kv.v.length), ...kv.v.map(str)])
    case 'u32arr': return Buffer.concat([u32(9), u32(4), u64(kv.v.length), ...kv.v.map(u32)])
  }
}

export function buildGguf(spec: FakeGguf = {}): Buffer {
  const kvs = spec.kvs ?? []
  const tensors = spec.tensors ?? []
  const parts: Buffer[] = [
    Buffer.from('GGUF'), u32(spec.version ?? 3), u64(tensors.length), u64(kvs.length),
  ]
  for (const [k, v] of kvs) parts.push(str(k), value(v))
  tensors.forEach((t, i) => {
    parts.push(str(`t${i}`), u32(t.dims.length), ...t.dims.map(u64), u32(t.type), u64(0))
  })
  return Buffer.concat(parts)
}

export function writeGguf(file: string, spec: FakeGguf = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buildGguf(spec))
}

/** A typical text-model spec. */
export function modelSpec(over: { arch?: string, name?: string, fileType?: number, ctx?: number, template?: boolean, params?: number | null } = {}): FakeGguf {
  const arch = over.arch ?? 'llama'
  const kvs: Array<[string, KvValue]> = [
    ['general.architecture', { t: 'str', v: arch }],
    ['general.name', { t: 'str', v: over.name ?? 'Fake Model' }],
    ['general.file_type', { t: 'u32', v: over.fileType ?? 15 }],
    [`${arch}.context_length`, { t: 'u32', v: over.ctx ?? 8192 }],
    ['tokenizer.ggml.tokens', { t: 'strarr', v: ['a', 'b', 'c'] }],
  ]
  if (over.template) kvs.push(['tokenizer.chat_template', { t: 'str', v: '{{ messages }}' }])
  if (over.params !== null && over.params !== undefined) kvs.push(['general.parameter_count', { t: 'u64', v: over.params }])
  return { kvs, tensors: [{ dims: [4, 8], type: 12 }, { dims: [16], type: 0 }] }
}

export function mmprojSpec(): FakeGguf {
  return {
    kvs: [
      ['general.architecture', { t: 'str', v: 'clip' }],
      ['general.type', { t: 'str', v: 'mmproj' }],
    ],
    tensors: [{ dims: [2, 2], type: 1 }],
  }
}
