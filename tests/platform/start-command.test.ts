// start.command is the macOS counterpart of start.bat: a bash script that must keep LF line
// endings (a CR after the shebang makes macOS report "bad interpreter") and the same behaviour.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const raw = readFileSync(join(root, 'start.command'), 'utf8')

test('start.command is a bash script with LF line endings', () => {
  expect(raw.startsWith('#!/bin/bash\n')).toBe(true)
  expect(raw).not.toContain('\r')
  expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toMatch(/^\*\.command text eol=lf$/m)
})

test('start.command delegates to the shared launcher with its arguments', () => {
  expect(raw).toContain('bun scripts/launch.ts "$@"')
})

test('start.command works from Finder: own directory, a PATH that finds bun, and a pause on errors', () => {
  expect(raw).toContain('cd "$(dirname "$0")"')
  expect(raw).toContain('$HOME/.bun/bin')
  expect(raw).toMatch(/command -v bun/)
  expect(raw).toContain('read -r -p')
})

test('start.command and start.bat share scripts/launch.ts', () => {
  const bat = readFileSync(join(root, 'start.bat'), 'utf8')
  expect(bat).toContain('scripts\\launch.ts')
  const launcher = readFileSync(join(root, 'scripts', 'launch.ts'), 'utf8')
  for (const step of ['bun', 'install', 'build', 'index.mjs']) expect(launcher).toContain(step)
})

test('the launcher runs the desktop shell by default and only the service for "web"', () => {
  const launcher = readFileSync(join(root, 'scripts', 'launch.ts'), 'utf8')
  expect(launcher).toContain("args.includes('web')")
  expect(launcher).toContain("'desktop/prepare.ts', '--dev'")
  expect(launcher).toContain('llama-web-desktop')
})
