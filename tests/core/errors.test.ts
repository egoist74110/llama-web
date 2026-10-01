import { describe, expect, test } from 'bun:test'
import { classify, diagnose } from '../../server/core/errors'
import { LaunchConfigError } from '../../server/core/launch'
import { LoadError } from '../../server/core/runner'
import { ModelCrashError } from '../../server/core/scheduler'

const exited = (...lines: string[]) => new LoadError('exited', 'Exited with code 1', 1, lines)

describe('classify: llama-server output', () => {
  const cases: Array<[string, string[]]> = [
    ['oom', ['ggml_backend_cuda_buffer_type_alloc_buffer: allocating 20480.00 MiB on device 0: cudaMalloc failed: out of memory']],
    ['oom', ['llama_kv_cache_init: failed to allocate buffer for kv cache']],
    ['oom', ['ggml_vulkan: Device memory allocation of size 123 failed.', 'vk::Device::allocateMemory: ErrorOutOfDeviceMemory']],
    ['oom', ['terminate called after throwing an instance of \'std::bad_alloc\'']],
    ['file-missing', ['gguf_init_from_file: failed to open GGUF file \'X:\\models\\a.gguf\' (No such file or directory)']],
    ['unknown-arg', ['error: invalid argument: --no-such-flag']],
    ['unknown-arg', ['error while handling argument "--ctx-size": stoi']],
    ['mmproj-mismatch', ['clip_init: failed to load model \'mm.gguf\': load_hparams: unknown projector type']],
    ['mmproj-mismatch', ['mtmd_init_from_file: error: mmproj does not match the text model']],
    ['unsupported-arch', ['llama_model_load: error loading model architecture: unknown model architecture: \'foo\'']],
    ['port-in-use', ['couldn\'t bind HTTP server socket, hostname: 127.0.0.1, port: 7100']],
    ['cuda-error', ['CUDA error: no kernel image is available for execution on the device']],
    ['bad-model', ['gguf_init_from_file_impl: invalid magic characters: \'\\x00\\x00\\x00\\x00\'']],
  ]
  for (const [kind, lines] of cases) {
    test(`${kind}: ${lines[0]!.slice(0, 48)}`, () => {
      expect(classify('exited', 1, lines)).toBe(kind as never)
    })
  }

  test('OOM wins over the generic "failed to load model" that follows it', () => {
    expect(classify('exited', 1, [
      'cudaMalloc failed: out of memory',
      'llama_model_load: error loading model: unable to allocate CUDA0 buffer',
      'common_init_from_params: failed to load model \'a.gguf\'',
    ])).toBe('oom')
  })

  test('unrecognised output keeps the cause code', () => {
    expect(classify('exited', 1, ['something odd'])).toBe('exited')
    expect(classify('timeout', null, ['load_tensors: loading...'])).toBe('timeout')
    expect(classify('crashed', 3, [])).toBe('crashed')
  })

  test('a timeout whose output shows an OOM is reported as OOM', () => {
    expect(classify('timeout', null, ['cudaMalloc failed: out of memory'])).toBe('oom')
  })

  test('missing DLL exit code', () => {
    expect(classify('exited', 0xC0000135, [])).toBe('dll-missing')
    expect(classify('exited', -1073741515, [])).toBe('dll-missing')
  })

  test('causes where the process never ran ignore stale output', () => {
    expect(classify('no-port', null, ['out of memory'])).toBe('no-port')
    expect(classify('aborted', null, ['out of memory'])).toBe('aborted')
  })
})

describe('diagnose', () => {
  test('LoadError keeps code, exit code and the last 30 lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    lines.push('cudaMalloc failed: out of memory')
    const d = diagnose(new LoadError('exited', 'x', 1, lines))!
    expect(d.kind).toBe('oom')
    expect(d.code).toBe('exited')
    expect(d.exitCode).toBe(1)
    expect(d.tail).toHaveLength(30)
    expect(d.tail.at(-1)).toBe('cudaMalloc failed: out of memory')
  })

  test('crash: exit code and tail come from the crash error', () => {
    const d = diagnose(new ModelCrashError({ code: 3, signal: null }, ['CUDA error: an illegal memory access was encountered']))!
    expect(d).toMatchObject({ kind: 'cuda-error', code: 'crashed', exitCode: 3 })
  })

  test('launch config errors map to their own kind', () => {
    expect(diagnose(new LaunchConfigError('file-missing', 'x'))).toMatchObject({ kind: 'file-missing', tail: [] })
    expect(diagnose(new LaunchConfigError('no-runtime', 'x'))!.kind).toBe('no-runtime')
  })

  test('nothing / unknown values', () => {
    expect(diagnose(null)).toBeNull()
    expect(diagnose(new Error('boom'))!.kind).toBe('unknown')
  })
})
