// Native "choose a folder" dialog for the model directory pickers. A browser page cannot learn the
// full path of a folder, so the server (which runs on the user's desktop) opens the system dialog
// (Windows: FolderBrowserDialog through PowerShell; macOS: osascript `choose folder`).
// Pure module: only node:child_process.
import { spawn } from 'node:child_process'

/** True for a Host header that names this machine only (localhost, 127.x, [::1]), with or without a port. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '')
  return name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name)
}

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = $env:LLAMA_WEB_PICK_TITLE
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
`

export interface PickFolderOptions {
  title: string
  /** Give up (and close the dialog process) after this long. Default 10 minutes. */
  timeoutMs?: number
}

/** The command that opens the dialog on this platform, or null when there is none. The title travels as an argument or environment value, never inside script text. */
export function pickerCommand(platform: NodeJS.Platform, title: string): { cmd: string, args: string[], env: Record<string, string> } | null {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      env: { LLAMA_WEB_PICK_TITLE: title },
    }
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', '--', title],
      env: {},
    }
  }
  return null
}

/** Turn the dialog process result into a path: null = cancelled; throws on any other failure. */
export function parsePickResult(platform: NodeJS.Platform, code: number | null, out: string, err: string): string | null {
  if (platform === 'darwin') {
    // Cancelling "choose folder" exits 1 with "User canceled. (-128)" on stderr.
    if (code !== 0) {
      if (/\(-128\)|user canceled/i.test(err)) return null
      throw new Error(err.trim() || `exit ${code}`)
    }
    const p = out.trim()
    return p ? (p.length > 1 ? p.replace(/\/+$/, '') : p) : null
  }
  if (code !== 0) throw new Error(err.trim() || `exit ${code}`)
  return out.trim() || null
}

/** The chosen folder, or null when the dialog was cancelled. Windows and macOS; throws elsewhere. */
export function pickFolder(opts: PickFolderOptions): Promise<string | null> {
  const platform = process.platform
  const command = pickerCommand(platform, opts.title)
  if (!command) return Promise.reject(new Error('folder picker is only available on Windows and macOS'))
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d })
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 600_000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        resolve(parsePickResult(platform, code, out, err))
      } catch (e) {
        reject(e)
      }
    })
  })
}
