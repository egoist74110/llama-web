// Move files to the system trash (Recycle Bin / Trash). Never falls back to permanent deletion:
// a file that cannot be moved is reported as failed. No shell is involved; paths travel as
// arguments or in an environment variable, never inside script text.
import { execFile } from 'node:child_process'

/** Run a program without a shell; resolves with stdout, rejects on a missing program, non-zero exit or timeout. */
export type TrashRun = (cmd: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<string>

const defaultRun: TrashRun = (cmd, args, timeoutMs, env) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8', env: { ...process.env, ...env } }, (err, stdout) => {
    if (err) reject(err)
    else resolve(stdout)
  })
})

export interface TrashResult {
  /** Absolute paths that could not be moved to the trash. */
  failed: string[]
}

const TIMEOUT_MS = 10 * 60_000

// AllDialogs: Windows asks before permanently deleting a file too big for the bin, instead of
// doing it silently. Failures are reported by index (stdout code pages garble non-ASCII paths).
const WIN_SCRIPT = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$paths = @(ConvertFrom-Json $env:LLAMA_WEB_TRASH)',
  'for ($i = 0; $i -lt $paths.Count; $i++) {',
  '  try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($paths[$i], "AllDialogs", "SendToRecycleBin", "ThrowException") }',
  '  catch { Write-Output "FAIL $i" }',
  '}',
].join('\n')

const MAC_SCRIPT = [
  'on run argv',
  '  set failed to {}',
  '  repeat with i from 1 to count of argv',
  '    try',
  '      tell application "Finder" to delete (POSIX file (item i of argv) as alias)',
  '    on error',
  '      set end of failed to i - 1',
  '    end try',
  '  end repeat',
  '  set AppleScript\'s text item delimiters to ","',
  '  return failed as text',
  'end run',
].join('\n')

function failedIndexes(out: string, platform: string): Set<number> {
  const idx = new Set<number>()
  const re = platform === 'win32' ? /FAIL (\d+)/g : /(\d+)/g
  for (const m of out.matchAll(re)) idx.add(Number(m[1]))
  return idx
}

export async function moveToTrash(paths: string[], opts: { platform?: NodeJS.Platform, run?: TrashRun } = {}): Promise<TrashResult> {
  if (!paths.length) return { failed: [] }
  const platform = opts.platform ?? process.platform
  const run = opts.run ?? defaultRun
  try {
    if (platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')], TIMEOUT_MS, { LLAMA_WEB_TRASH: JSON.stringify(paths) })
      const bad = failedIndexes(out, platform)
      return { failed: paths.filter((_, i) => bad.has(i)) }
    }
    if (platform === 'darwin') {
      const out = await run('osascript', ['-e', MAC_SCRIPT, ...paths], TIMEOUT_MS)
      const bad = failedIndexes(out, platform)
      return { failed: paths.filter((_, i) => bad.has(i)) }
    }
    const failed: string[] = []
    for (const p of paths) {
      try { await run('gio', ['trash', '--', p], TIMEOUT_MS) } catch { failed.push(p) }
    }
    return { failed }
  } catch {
    return { failed: [...paths] }
  }
}
