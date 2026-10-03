// Native "choose a folder" dialog for the model directory pickers. A browser page cannot learn the
// full path of a folder, so the server (which runs on the user's desktop) opens the Windows dialog.
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

/** The chosen folder, or null when the dialog was cancelled. Windows only; throws elsewhere. */
export function pickFolder(opts: PickFolderOptions): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.reject(new Error('folder picker is only available on Windows'))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      env: { ...process.env, LLAMA_WEB_PICK_TITLE: opts.title },
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
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`))
      resolve(out.trim() || null)
    })
  })
}
