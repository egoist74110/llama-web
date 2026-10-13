// Windows only: start a process outside the Job Object the desktop shell puts llama-web in (decision 60). The shell's job
// ends every process in it when the shell exits (src-tauri/src/job.rs); a service the user wants kept running must not
// be in it. Node / Bun spawn cannot ask for CREATE_BREAKAWAY_FROM_JOB (libuv leaves it out on purpose), so this calls
// CreateProcessW through bun:ffi. Still an argument array: it is quoted into one command line by the same rules the C
// runtime uses to split it back (as libuv does), and never goes through a shell.
//
// Everything that touches the native API is behind loadWinSpawn(): off Windows, under Node (nuxt dev), or when the
// library cannot be loaded, spawnOutsideJob() is simply not available and the caller uses the normal spawn.

/** One argument, quoted for CommandLineToArgvW / the MSVC runtime (libuv's quote_cmd_arg). */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[ \t"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue }
    // Backslashes are literal unless they precede a quote: then each one is doubled and the quote escaped.
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

export function windowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteWindowsArg).join(' ')
}

const CREATE_NEW_PROCESS_GROUP = 0x0000_0200
const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000
/** A console program gets a hidden console of its own (valid stdout / stderr, no window, not tied to ours). */
const CREATE_NO_WINDOW = 0x0800_0000
const STILL_ACTIVE = 259
const STARTUPINFOW_SIZE = 104 // x64
const PROCESS_INFORMATION_SIZE = 24 // x64

export const BREAKAWAY_FLAGS = CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW

export interface OutsideJobProcess {
  pid: number
  /** Exit code once the process has ended, null while it runs. Closes the handle after the first non-null answer. */
  exitCode(): number | null
}

type Kernel32 = {
  CreateProcessW(...a: unknown[]): number
  GetExitCodeProcess(h: unknown, out: unknown): number
  CloseHandle(h: unknown): number
}

let native: { k32: Kernel32, ptr: (b: ArrayBufferView) => unknown } | null = null

/** Load kernel32 through bun:ffi once (Windows + Bun only). Never throws; false = not available. */
export async function loadWinSpawn(): Promise<boolean> {
  if (native) return true
  if (process.platform !== 'win32' || !process.versions.bun) return false
  try {
    const name = 'bun:ffi' // a variable, so the bundler leaves the import alone
    const ffi: any = await import(name)
    const { FFIType: T } = ffi
    const lib = ffi.dlopen('kernel32.dll', {
      CreateProcessW: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
      GetExitCodeProcess: { args: [T.ptr, T.ptr], returns: T.i32 },
      CloseHandle: { args: [T.ptr], returns: T.i32 },
    })
    native = { k32: lib.symbols as Kernel32, ptr: ffi.ptr }
    return true
  } catch {
    return false
  }
}

export function winSpawnAvailable(): boolean {
  return native !== null
}

const wide = (s: string) => Buffer.from(`${s}\0`, 'utf16le')

/**
 * Start `file args` in `cwd` outside the job, with llama-web's environment. `file` must be a full path (the caller
 * resolves it the way spawn would). Throws when the process could not be created, e.g. the job does not allow breakaway.
 */
export function spawnOutsideJob(file: string, args: readonly string[], cwd: string | undefined): OutsideJobProcess {
  if (!native) throw new Error('native spawn not loaded')
  const { k32, ptr } = native
  const app = wide(file)
  const cmd = wide(windowsCommandLine(file, args)) // CreateProcessW may write into this buffer: it is ours
  const dir = cwd ? wide(cwd) : null
  const si = Buffer.alloc(STARTUPINFOW_SIZE)
  si.writeUInt32LE(STARTUPINFOW_SIZE, 0)
  const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE)
  const ok = k32.CreateProcessW(ptr(app), ptr(cmd), null, null, 0, BREAKAWAY_FLAGS, null, dir ? ptr(dir) : null, ptr(si), ptr(pi))
  if (!ok) throw new Error('CreateProcessW failed')
  const hProcess = Number(pi.readBigUInt64LE(0))
  const hThread = Number(pi.readBigUInt64LE(8))
  const pid = pi.readUInt32LE(16)
  k32.CloseHandle(hThread)
  let closed = false
  let code: number | null = null
  const out = Buffer.alloc(4)
  return {
    pid,
    exitCode() {
      if (closed) return code
      if (!k32.GetExitCodeProcess(hProcess, ptr(out))) return null
      const c = out.readUInt32LE(0)
      if (c === STILL_ACTIVE) return null
      code = c
      closed = true
      k32.CloseHandle(hProcess)
      return code
    },
  }
}
