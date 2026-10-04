import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The shell is Rust and cannot be loaded here; these guard the lifecycle contract that
// stops the launcher and the main window from being visible together on startup.
const source = readFileSync('src-tauri/src/main.rs', 'utf8').replace(/\r\n/g, '\n')

function body(name: string): string {
  const start = source.indexOf(`fn ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const next = source.indexOf('\nfn ', start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('desktop window lifecycle', () => {
  test('main window is built hidden', () => {
    expect(body('show_main')).toContain('.visible(false)')
  })

  test('main window is revealed only through reveal_main, which also hides the launcher', () => {
    const reveal = body('reveal_main')
    expect(reveal).toContain('main.show()')
    expect(reveal).toContain('launcher.hide()')
    expect(reveal.indexOf('main.show()')).toBeLessThan(reveal.indexOf('launcher.hide()'))
    expect(reveal).toContain('inner.quitting')
    expect(reveal).toContain('"ready"')
    const others = source.replace(reveal, '')
    expect(others).not.toMatch(/main\.show\(\)/)
    expect(others).not.toMatch(/launcher\.hide\(\)/)
  })

  test('page load and a bounded fallback both reveal the main window', () => {
    const shown = body('show_main')
    expect(shown).toContain('PageLoadEvent::Finished')
    expect(shown).toContain('reveal_main(&focus)')
    expect(shown).toContain('MAIN_REVEAL_TIMEOUT')
  })

  test('second launch raises only a visible main window, else the launcher', () => {
    expect(source).toMatch(/get_webview_window\("main"\)\s*\.filter\(\|w\| w\.is_visible\(\)/)
  })
})

describe('launcher visibility', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))

  test('launcher is created hidden', () => {
    const launcher = conf.app.windows.find((w: { label: string }) => w.label === 'launcher')
    expect(launcher.visible).toBe(false)
  })

  test('launcher is shown for first launch / recovery, and after a delay if startup is slow', () => {
    expect(source).toContain('LAUNCHER_DELAY')
    expect(body('show_launcher_if_waiting')).toContain('launcher.show()')
    expect(source).toMatch(/else if let Some\(launcher\) = app\.get_webview_window\("launcher"\)[\s\S]*?launcher\.show\(\)/)
  })

  test('failure and update flows still show the launcher', () => {
    expect(body('fail')).toContain('window.show()')
    expect(body('quit')).toContain('launcher.show()')
  })
})
