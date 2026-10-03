import { describe, expect, test } from 'bun:test'
import { parsePickResult, pickerCommand } from '../../server/core/folder-picker'

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
