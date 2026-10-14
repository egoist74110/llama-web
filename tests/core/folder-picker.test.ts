import { describe, expect, test } from 'bun:test'
import { filePickerCommand, parsePickResult, pickerCommand } from '../../server/core/folder-picker'

describe('filePickerCommand', () => {
  const opts = { title: 'x" & (do shell script "echo hi") & "', programsLabel: 'Programs', allFilesLabel: 'All files' }

  test('Windows uses an OpenFileDialog at home, an env filter, UTF-8 output and a TopMost owner', () => {
    const c = filePickerCommand('win32', opts)!
    expect(c.cmd).toBe('powershell.exe')
    expect(c.args).toContain('-STA')
    expect(c.env).toEqual({ LLAMA_WEB_PICK_TITLE: opts.title, LLAMA_WEB_PICK_FILTER: 'Programs (*.exe)|*.exe|All files (*.*)|*.*' })
    const script = Buffer.from(c.args.at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain('System.Windows.Forms.OpenFileDialog')
    expect(script).toContain("$dlg.InitialDirectory = [Environment]::GetFolderPath('UserProfile')")
    expect(script).toContain('$dlg.Title = $env:LLAMA_WEB_PICK_TITLE')
    expect(script).toContain('$dlg.Filter = $env:LLAMA_WEB_PICK_FILTER')
    expect(script).toContain('TopMost = $true')
    expect(script).toContain('[System.Text.Encoding]::UTF8')
    expect(script).toContain('[Console]::Out.Write($dlg.FileName)')
    expect(script).toContain('$dlg.Dispose()')
    expect(script).toContain('$owner.Dispose()')
    expect(script).not.toContain(opts.title)
    expect(script).not.toContain(opts.programsLabel)
  })

  test('macOS chooses a file at home with the prompt in argv; unsupported platforms return null', () => {
    const c = filePickerCommand('darwin', opts)!
    expect(c.cmd).toBe('osascript')
    expect(c.args).toContain('POSIX path of (choose file with prompt (item 1 of argv) default location (path to home folder))')
    expect(c.args.slice(-2)).toEqual(['--', opts.title])
    expect(c.args.filter(a => a !== opts.title).join(' ')).not.toContain('do shell script')
    expect(filePickerCommand('linux', opts)).toBeNull()
  })

  test('shared result parser returns file paths and parses cancellation on both platforms', () => {
    expect(parsePickResult('darwin', 0, '/Volumes/build/renamed-server\n', '')).toBe('/Volumes/build/renamed-server')
    expect(parsePickResult('win32', 0, 'X:\\build\\llama-kvmem-server.exe\r\n', '')).toBe('X:\\build\\llama-kvmem-server.exe')
    expect(parsePickResult('darwin', 1, '', 'execution error: User canceled. (-128)')).toBeNull()
    expect(parsePickResult('win32', 0, '', '')).toBeNull()
  })
})

test('pick-file endpoint refuses non-loopback pages before opening a dialog', async () => {
  const globals = globalThis as Record<string, unknown>
  const bindings = {
    defineEventHandler: (handler: unknown) => handler,
    getRequestHeader: (event: { host?: string }) => event.host,
    createError: (info: { message: string, statusCode: number }) => Object.assign(new Error(info.message), info),
  }
  const previous = Object.keys(bindings).map(name => [name, globals[name]] as const)
  Object.assign(globals, bindings)
  try {
    const route = (await import('../../server/api/fs/pick-file.post')).default
    for (const host of ['example.com', '192.168.1.10', undefined]) {
      await expect(route({ host } as never)).rejects.toMatchObject({ statusCode: 403 })
    }
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete globals[name]; else globals[name] = value }
  }
})

describe('pickerCommand', () => {
  test('Windows: PowerShell with the title in the environment, not in the script', () => {
    const c = pickerCommand('win32', 'My "models"')!
    expect(c.cmd).toBe('powershell.exe')
    expect(c.env).toEqual({ LLAMA_WEB_PICK_TITLE: 'My "models"' })
    expect(Buffer.from(c.args.at(-1)!, 'base64').toString('utf16le')).not.toContain('My "models"')
  })

  test('macOS: osascript gets the title as an argument, never spliced into the script', () => {
    const title = 'x" & (do shell script "echo hi") & "'
    const c = pickerCommand('darwin', title)!
    expect(c.cmd).toBe('osascript')
    expect(c.args.slice(-2)).toEqual(['--', title])
    expect(c.args.filter(a => a !== title).join(' ')).not.toContain('do shell script')
    expect(c.args).toContain('POSIX path of (choose folder with prompt (item 1 of argv))')
  })

  test('other systems have no dialog', () => {
    expect(pickerCommand('linux', 't')).toBeNull()
  })
})

describe('parsePickResult', () => {
  test('macOS: strips the trailing slash and the newline', () => {
    expect(parsePickResult('darwin', 0, '/Volumes/models/\n', '')).toBe('/Volumes/models')
    expect(parsePickResult('darwin', 0, '/\n', '')).toBe('/')
    expect(parsePickResult('darwin', 0, '\n', '')).toBeNull()
  })

  test('macOS: cancelling is null, other failures throw', () => {
    expect(parsePickResult('darwin', 1, '', '0:57: execution error: User canceled. (-128)\n')).toBeNull()
    expect(() => parsePickResult('darwin', 1, '', 'osascript: not allowed assistive access')).toThrow('not allowed')
    expect(() => parsePickResult('darwin', 1, '', '')).toThrow('exit 1')
  })

  test('Windows: empty output is cancel, non-zero exit throws', () => {
    expect(parsePickResult('win32', 0, 'X:\\models\r\n', '')).toBe('X:\\models')
    expect(parsePickResult('win32', 0, '', '')).toBeNull()
    expect(() => parsePickResult('win32', 1, '', 'boom')).toThrow('boom')
  })
})
