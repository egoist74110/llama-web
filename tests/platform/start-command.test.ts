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

test('start.command builds when asked or when there is no build, then runs the built server', () => {
  expect(raw).toContain('[ "$1" = "build" ] || [ ! -f ".output/server/index.mjs" ]')
  expect(raw).toContain('bun run build')
  expect(raw).toContain('bun ".output/server/index.mjs"')
})

test('start.command works from Finder: own directory, a PATH that finds bun, and a pause on errors', () => {
  expect(raw).toContain('cd "$(dirname "$0")"')
  expect(raw).toContain('$HOME/.bun/bin')
  expect(raw).toMatch(/command -v bun/)
  expect(raw).toContain('read -r -p')
})

test('start.command has the same entry points as start.bat', () => {
  const bat = readFileSync(join(root, 'start.bat'), 'utf8')
  for (const step of ['bun install', 'bun run build', 'index.mjs']) {
    expect(bat).toContain(step)
    expect(raw).toContain(step)
  }
})
