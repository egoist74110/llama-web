// Failure diagnosis: turns a load failure / crash (cause + the last output lines of the
// process) into a stable `kind` the UI maps to a Chinese explanation and advice.
// Pure module; patterns match llama.cpp / ggml output (see tests/core/errors.test.ts).
import { LaunchConfigError } from './launch'
import { LoadError } from './runner'
import { ModelCrashError } from './scheduler'
import { blamesSplitMode, SplitModeLoadError } from './split-stats'

/** Keys of i18n `loadError` / `failure` that a diagnosis can produce. */
export type FailureKind =
  // From the output of the process
  | 'oom' // not enough GPU / host memory
  | 'cuda-error' // CUDA runtime error other than out-of-memory
  | 'dll-missing' // the process could not start: a DLL (CUDA runtime etc.) is missing
  | 'file-missing' // model / mmproj / draft file cannot be opened
  | 'unknown-arg' // llama-server rejected an argument
  | 'mmproj-mismatch' // mmproj does not fit the model
  | 'unsupported-arch' // llama.cpp does not know the model architecture
  | 'bad-model' // the model file is broken / not a GGUF
  | 'port-in-use'
  | 'device-missing' // the chosen device is not on the build's device list (also found before the process starts)
  | 'split-mode-unsupported' // the build's help does not list the chosen split mode (found before the process starts)
  | 'split-mode-failed' // a row / tensor group died while loading for no reason that points elsewhere (decision 45)
  // From the cause
  | 'no-port' | 'spawn-failed' | 'register-failed' | 'exited' | 'timeout' | 'aborted' | 'crashed'
  | 'model-missing' | 'profile-missing' | 'no-runtime' | 'bad-args' | 'unknown'

export interface FailureDoc {
  kind: FailureKind
  /** Cause code before the output was looked at (`exited`, `timeout`, `crashed`, ...). */
  code: string
  exitCode: number | null
  /** Last output lines of the process (empty when it never started). */
  tail: string[]
}

/** Output pattern -> kind. Order matters: the first matching rule wins. */
const OUTPUT_RULES: Array<[FailureKind, RegExp]> = [
  // "out of memory" alone also appears in harmless text: it needs a GPU / allocator word on the same line.
  ['oom', /(?:cuda|cublas|vulkan|hip|metal|ggml|alloc|device)\w*[^\n]*out of memory|out of memory[^\n]*(?:cuda|vulkan|device)|cudaMalloc failed|failed to allocate (?:CUDA|Vulkan|\S+ )?(?:buffer|memory)|unable to allocate .*buffer|ggml_backend_\w*alloc_buffer: allocating .* failed|failed to allocate .*compute buffer|CUDA_ERROR_OUT_OF_MEMORY|ErrorOutOfDeviceMemory|std::bad_alloc|not enough memory|kIOGPUCommandBufferCallbackErrorOutOfMemory|ggml_metal\w*[^\n]*(?:failed to allocate|insufficient memory)|Insufficient Memory \(/i],
  ['port-in-use', /couldn't bind HTTP server socket|address already in use|only one usage of each socket address/i],
  // llama-server: `error while handling argument "--device": invalid device: CUDA7` (checked on b11146); before unknown-arg, which would also match.
  ['device-missing', /invalid device: \S+/i],
  ['unknown-arg', /error: invalid argument|invalid argument:|unknown argument|error while handling argument|unrecognized (?:option|argument)/i],
  ['mmproj-mismatch', /mmproj.*(?:mismatch|incompatible|not compatible|does not match|failed)|(?:failed to load|unable to load) (?:mmproj|multimodal|vision)|clip_init: failed|clip_model_load: .*(?:failed|error)|unknown projector type|mtmd_init_from_file: error/i],
  ['unsupported-arch', /unknown model architecture|unsupported (?:model )?architecture/i],
  ['file-missing', /failed to open GGUF file|failed to open .*\.gguf|no such file or directory|cannot open (?:file|model)|system cannot find the (?:file|path)|file not found/i],
  ['cuda-error', /CUDA error|no CUDA-capable device|CUDA driver version is insufficient|cudaGetDeviceCount failed|ggml_cuda_init: failed/i],
  // Only llama.cpp's own failure lines; a bare "failed to load model" elsewhere proves nothing.
  ['bad-model', /invalid magic|(?:llama_model_load|common_init_from_params|load_model): (?:error loading model|failed to load model)|model is corrupted|tensor .* data is not within the file bounds/i],
]

const INFO_LINE = /^\d+\.\d+\.\d+\.\d+ [ID] /

// STATUS_DLL_NOT_FOUND / STATUS_ENTRYPOINT_NOT_FOUND: Windows could not start the program.
const DLL_EXIT_CODES = new Set([0xC0000135, 0xC0000139, -1073741515, -1073741511])

function causeOf(cause: unknown): { code: string, exitCode: number | null, tail: string[] } {
  if (cause instanceof LoadError) return { code: cause.code, exitCode: cause.exitCode, tail: cause.tail }
  if (cause instanceof ModelCrashError) return { code: 'crashed', exitCode: cause.exitCode, tail: cause.tail }
  if (cause instanceof LaunchConfigError) return { code: cause.code, exitCode: null, tail: [] }
  return { code: 'unknown', exitCode: null, tail: [] }
}

/** Kind for a failure given its cause code, exit code and the last output lines. */
export function classify(code: string, exitCode: number | null, tail: readonly string[]): FailureKind {
  // The reasons below mean the process never ran, so its output says nothing.
  if (code !== 'no-port' && code !== 'spawn-failed' && code !== 'register-failed' && code !== 'aborted') {
    // Lines llama-server tags Info / Debug are progress chatter, not the cause.
    const text = tail.filter(l => !INFO_LINE.test(l)).join('\n')
    for (const [kind, re] of OUTPUT_RULES) if (re.test(text)) return kind
    if (exitCode !== null && DLL_EXIT_CODES.has(exitCode)) return 'dll-missing'
  }
  return (code in CODE_KINDS ? code : 'unknown') as FailureKind
}

const CODE_KINDS: Record<string, true> = {
  'no-port': true, 'spawn-failed': true, 'register-failed': true, 'exited': true, 'timeout': true,
  'aborted': true, 'crashed': true, 'model-missing': true, 'profile-missing': true,
  'file-missing': true, 'no-runtime': true, 'bad-args': true, 'device-missing': true, 'split-mode-unsupported': true, 'unknown': true,
}

/** Absolute paths in an output line -> `<dir>/file`: the card is readable from the LAN, local folders should not be. */
export function redactPaths(line: string): string {
  return line
    // Quoted paths may contain spaces.
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"]*?([^\\/'"]+)\1/g, '$1<dir>/$2$1')
    .replace(/[A-Za-z]:[\\/](?:[^\\/\s'"]+[\\/])*([^\\/\s'"]+)/g, '<dir>/$1')
    .replace(/(?<![\w.:/])\/(?:[^/\s'"]+\/)+([^/\s'"]+)/g, '<dir>/$1')
}

/** Diagnose the `error` of a failed / crashed instance (or a rejected load). Null when there is none. */
export function diagnose(cause: unknown): FailureDoc | null {
  if (!cause) return null
  if (cause instanceof SplitModeLoadError) {
    const d = diagnose(cause.inner)
    return d && blamesSplitMode(d.kind) ? { ...d, kind: 'split-mode-failed' } : d
  }
  const c = causeOf(cause)
  return { kind: classify(c.code, c.exitCode, c.tail), code: c.code, exitCode: c.exitCode, tail: c.tail.slice(-30).map(redactPaths) }
}
