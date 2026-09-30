// GGUF header reader. Reads only the key/value section and tensor infos, never tensor data.
import { open, stat } from 'node:fs/promises'

export class GgufError extends Error {
  constructor(public code: 'not-gguf' | 'unsupported' | 'truncated' | 'corrupt', message: string) {
    super(message)
    this.name = 'GgufError'
  }
}

export interface GgufMeta {
  version: number
  fileSize: number
  /** general.architecture, e.g. `llama`, `qwen3`, `clip` (mmproj). */
  architecture: string | null
  name: string | null
  /** general.type (`model`, `mmproj`, ...) when present. */
  type: string | null
  sizeLabel: string | null
  /** Total parameters: general.parameter_count, else the sum of tensor element counts. */
  parameterCount: number | null
  /** True when parameterCount was summed from this file's tensors (partial for shards). */
  parameterCountFromTensors: boolean
  /** Quantisation name, e.g. `Q4_K_M` (from general.file_type, else the dominant tensor type). */
  quantization: string | null
  fileType: number | null
  /** `<arch>.context_length`. */
  contextLength: number | null
  /** Whether tokenizer.chat_template is embedded. */
  hasChatTemplate: boolean
  tensorCount: number
  /** split.count / split.no (zero-based) for sharded files. */
  splitCount: number | null
  splitNo: number | null
}

const MAGIC = 0x46554747 // "GGUF" little-endian
const CHUNK = 1 << 20
const MAX_KEY_LEN = 65535
const MAX_KEEP_STRING = 1 << 20
const MAX_ENTRIES = 5_000_000

// llama_ftype (general.file_type)
const FILE_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
  36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4_MOE',
}

// ggml_type (tensor type)
const TENSOR_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S',
  22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4',
}

// GGUF value types
const T_U8 = 0, T_I8 = 1, T_U16 = 2, T_I16 = 3, T_U32 = 4, T_I32 = 5, T_F32 = 6,
  T_BOOL = 7, T_STRING = 8, T_ARRAY = 9, T_U64 = 10, T_I64 = 11, T_F64 = 12

const FIXED_SIZE: Record<number, number> = {
  [T_U8]: 1, [T_I8]: 1, [T_BOOL]: 1, [T_U16]: 2, [T_I16]: 2,
  [T_U32]: 4, [T_I32]: 4, [T_F32]: 4, [T_U64]: 8, [T_I64]: 8, [T_F64]: 8,
}

/** Sequential reader over a file handle with a sliding buffer. */
class Reader {
  private buf = Buffer.alloc(0)
  private bufStart = 0
  pos = 0

  constructor(private fh: Awaited<ReturnType<typeof open>>, readonly size: number) {}

  private async ensure(n: number) {
    if (this.pos + n > this.size) throw new GgufError('truncated', 'Unexpected end of file')
    const off = this.pos - this.bufStart
    if (off >= 0 && off + n <= this.buf.length) return off
    const want = Math.min(Math.max(n, CHUNK), this.size - this.pos)
    const buf = Buffer.alloc(want)
    const { bytesRead } = await this.fh.read(buf, 0, want, this.pos)
    if (bytesRead < n) throw new GgufError('truncated', 'Unexpected end of file')
    this.buf = buf.subarray(0, bytesRead)
    this.bufStart = this.pos
    return 0
  }

  async u8() { const o = await this.ensure(1); this.pos += 1; return this.buf[o]! }
  async u16() { const o = await this.ensure(2); this.pos += 2; return this.buf.readUInt16LE(o) }
  async i16() { const o = await this.ensure(2); this.pos += 2; return this.buf.readInt16LE(o) }
  async u32() { const o = await this.ensure(4); this.pos += 4; return this.buf.readUInt32LE(o) }
  async i32() { const o = await this.ensure(4); this.pos += 4; return this.buf.readInt32LE(o) }
  async f32() { const o = await this.ensure(4); this.pos += 4; return this.buf.readFloatLE(o) }
  async f64() { const o = await this.ensure(8); this.pos += 8; return this.buf.readDoubleLE(o) }
  async i64() {
    const o = await this.ensure(8); this.pos += 8
    return Number(this.buf.readBigInt64LE(o))
  }
  async u64() {
    const o = await this.ensure(8); this.pos += 8
    const v = this.buf.readBigUInt64LE(o)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufError('corrupt', 'Integer out of range')
    return Number(v)
  }

  skip(n: number) {
    if (this.pos + n > this.size) throw new GgufError('truncated', 'Unexpected end of file')
    this.pos += n
  }

  /** Returns the string, or null (skipped) when longer than maxKeep. */
  async string(maxKeep: number): Promise<string | null> {
    const len = await this.u64()
    if (len > this.size - this.pos) throw new GgufError('corrupt', 'String length exceeds file size')
    if (len > maxKeep) { this.skip(len); return null }
    const o = await this.ensure(len)
    this.pos += len
    return this.buf.toString('utf8', o, o + len)
  }
}

async function readScalar(r: Reader, type: number): Promise<unknown> {
  switch (type) {
    case T_U8: return r.u8()
    case T_I8: { const v = await r.u8(); return v > 127 ? v - 256 : v }
    case T_U16: return r.u16()
    case T_I16: return r.i16()
    case T_U32: return r.u32()
    case T_I32: return r.i32()
    case T_F32: return r.f32()
    case T_BOOL: return (await r.u8()) !== 0
    case T_STRING: return r.string(MAX_KEEP_STRING)
    case T_U64: return r.u64()
    case T_I64: return r.i64()
    case T_F64: return r.f64()
    default: throw new GgufError('corrupt', `Unknown value type ${type}`)
  }
}

async function skipValue(r: Reader, type: number): Promise<void> {
  const fixed = FIXED_SIZE[type]
  if (fixed !== undefined) return r.skip(fixed)
  if (type === T_STRING) { await r.string(0); return }
  if (type === T_ARRAY) {
    const elem = await r.u32()
    const len = await r.u64()
    const elemFixed = FIXED_SIZE[elem]
    if (elemFixed !== undefined) return r.skip(elemFixed * len)
    if (len > MAX_ENTRIES * 100) throw new GgufError('corrupt', 'Array too large')
    for (let i = 0; i < len; i++) await skipValue(r, elem)
    return
  }
  throw new GgufError('corrupt', `Unknown value type ${type}`)
}

function wanted(key: string): boolean {
  return key.startsWith('general.') || key.startsWith('split.') || key.endsWith('.context_length')
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function readGgufMeta(file: string): Promise<GgufMeta> {
  const fileSize = (await stat(file)).size
  const fh = await open(file, 'r')
  try {
    const r = new Reader(fh, fileSize)
    if (fileSize < 24) throw new GgufError(fileSize < 4 ? 'not-gguf' : 'truncated', 'File too small for a GGUF header')
    if ((await r.u32()) !== MAGIC) throw new GgufError('not-gguf', 'Missing GGUF magic')
    const version = await r.u32()
    if (version < 2 || version > 3) {
      const swapped = ((version & 0xff) << 24 | (version & 0xff00) << 8 | (version >>> 8) & 0xff00 | version >>> 24) >>> 0
      throw new GgufError('unsupported', swapped === 2 || swapped === 3
        ? 'Big-endian GGUF is not supported'
        : `Unsupported GGUF version ${version}`)
    }
    const tensorCount = await r.u64()
    const kvCount = await r.u64()
    if (tensorCount > MAX_ENTRIES || kvCount > MAX_ENTRIES) throw new GgufError('corrupt', 'Implausible header counts')

    const kv = new Map<string, unknown>()
    let hasChatTemplate = false
    for (let i = 0; i < kvCount; i++) {
      const key = await r.string(MAX_KEY_LEN)
      if (key === null) throw new GgufError('corrupt', 'Key too long')
      const type = await r.u32()
      if (key === 'tokenizer.chat_template') hasChatTemplate = true
      if (wanted(key) && type !== T_ARRAY) kv.set(key, await readScalar(r, type))
      else await skipValue(r, type)
    }

    let tensorParams = 0
    const byType = new Map<number, number>()
    for (let i = 0; i < tensorCount; i++) {
      await r.string(0)
      const nDims = await r.u32()
      if (nDims > 8) throw new GgufError('corrupt', 'Implausible tensor rank')
      let elems = 1
      for (let d = 0; d < nDims; d++) elems *= await r.u64()
      const ttype = await r.u32()
      r.skip(8) // data offset
      tensorParams += elems
      byType.set(ttype, (byType.get(ttype) ?? 0) + elems)
    }

    const architecture = str(kv.get('general.architecture'))
    const fileType = num(kv.get('general.file_type'))
    const declared = num(kv.get('general.parameter_count'))

    let quantization: string | null = fileType !== null ? FILE_TYPES[fileType] ?? null : null
    if (!quantization && byType.size > 0) {
      let best = -1, bestElems = -1
      for (const [t, n] of byType) if (n > bestElems) { best = t; bestElems = n }
      quantization = TENSOR_TYPES[best] ?? null
    }

    return {
      version,
      fileSize,
      architecture,
      name: str(kv.get('general.name')),
      type: str(kv.get('general.type')),
      sizeLabel: str(kv.get('general.size_label')),
      parameterCount: declared ?? (tensorCount > 0 ? tensorParams : null),
      parameterCountFromTensors: declared === null && tensorCount > 0,
      quantization,
      fileType,
      contextLength: architecture ? num(kv.get(`${architecture}.context_length`)) : null,
      hasChatTemplate,
      tensorCount,
      splitCount: num(kv.get('split.count')),
      splitNo: num(kv.get('split.no')),
    }
  } finally {
    await fh.close()
  }
}
