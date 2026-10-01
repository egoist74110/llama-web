import { expect, test } from 'bun:test'
import {
  buildLaunchArgs, canonicalFlag, cmdProgramMayExpand, DEFAULT_LAUNCH_DEFAULTS, formatCmdCommand, formatCommand, groupArgs,
  mergeParams, quoteCmdArg, splitArgs, type BuildInput, type LaunchDefaults,
} from '../../server/core/args'

const defaults = (over: Partial<LaunchDefaults> = {}): LaunchDefaults => ({ ...DEFAULT_LAUNCH_DEFAULTS, extraArgs: '', ...over })

const build = (over: Partial<BuildInput> = {}) =>
  buildLaunchArgs({
    paths: { model: 'X:\\models\\m.gguf' },
    defaults: defaults(),
    host: '127.0.0.1',
    port: 7100,
    ...over,
  })

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

test('splitArgs handles quotes, empty args, and Windows paths', () => {
  expect(splitArgs('--a 1   --b')).toEqual(['--a', '1', '--b'])
  expect(splitArgs('--t "C:\\My Dir\\t.jinja" -x')).toEqual(['--t', 'C:\\My Dir\\t.jinja', '-x'])
  expect(splitArgs("--n 'a b' \"\"")).toEqual(['--n', 'a b', ''])
  expect(splitArgs('--s "say \\"hi\\""')).toEqual(['--s', 'say "hi"'])
  expect(splitArgs('a"b c"d')).toEqual(['ab cd'])
  expect(splitArgs('   ')).toEqual([])
})

test('splitArgs rejects unterminated quotes', () => {
  expect(() => splitArgs('--a "oops')).toThrow('Unterminated')
  expect(() => splitArgs("--a 'oops")).toThrow('Unterminated')
})

test('groupArgs attaches values to flags and treats negative numbers as values', () => {
  expect(groupArgs(splitArgs('--reasoning-budget -1 --jinja --lora-scaled f.gguf 0.5')).map(g => g.tokens)).toEqual([
    ['--reasoning-budget', '-1'], ['--jinja'], ['--lora-scaled', 'f.gguf', '0.5'],
  ])
  const g = groupArgs(['--ctx-size=4096'])[0]!
  expect(g.flag).toBe('--ctx-size')
  expect(g.canon).toBe('--ctx-size')
  expect(canonicalFlag('-c')).toBe('--ctx-size')
})

test('mergeParams: inherit vs custom, and null clears', () => {
  const merged = mergeParams(defaults({ ctxSize: 1000, cacheTypeK: 'q4_0' }), { ctxSize: 2000 }, { ctxSize: undefined, cacheTypeK: null, flashAttn: '' })
  expect(merged.ctxSize).toBe(2000)
  expect(merged.cacheTypeK).toBeNull()
  expect(merged.flashAttn).toBeNull()
  expect(merged.gpuLayers).toBe(999)
})

test('layer order: defaults < model < profile', () => {
  const r = build({
    model: { overrides: { ctxSize: 8000, parallel: 2 } },
    profile: { overrides: { ctxSize: 32768 } },
  })
  expect(after(r.args, '--ctx-size')).toBe('32768')
  expect(after(r.args, '--parallel')).toBe('2')
  expect(r.effective.ctxSize).toBe(32768)
})

test('assembles files, form flags, extra args, then host/port last', () => {
  const r = build({
    paths: { model: 'M', mmproj: 'P', draft: 'D', chatTemplate: 'T' },
    defaults: defaults({ extraArgs: '--jinja --slots' }),
    profile: { extraArgs: '--spec-type draft-mtp' },
  })
  expect(r.ok).toBe(true)
  expect(r.warnings).toEqual([])
  expect(r.args.slice(0, 8)).toEqual(['--model', 'M', '--mmproj', 'P', '--model-draft', 'D', '--chat-template-file', 'T'])
  expect(r.args.slice(-4)).toEqual(['--host', '127.0.0.1', '--port', '7100'])
  const tail = r.args.slice(r.args.indexOf('--jinja'), -4)
  expect(tail).toEqual(['--jinja', '--slots', '--spec-type', 'draft-mtp'])
  expect(after(r.args, '--reasoning-budget')).toBe('-1')
})

test('cleared params and missing files are omitted', () => {
  const r = build({ profile: { overrides: { cacheTypeK: null, reasoning: '' } } })
  expect(r.args).not.toContain('--cache-type-k')
  expect(r.args).not.toContain('--reasoning')
  expect(r.args).not.toContain('--mmproj')
})

test('extra args override form-managed flags (incl. aliases) with a warning', () => {
  const r = build({ profile: { overrides: { ctxSize: 4096 }, extraArgs: '-c 8192 -ngl 10' } })
  expect(r.args.filter(a => a === '--ctx-size')).toEqual([])
  expect(r.args.filter(a => a === '--n-gpu-layers')).toEqual([])
  expect(after(r.args, '-c')).toBe('8192')
  expect(after(r.args, '-ngl')).toBe('10')
  const flags = r.warnings.filter(w => w.code === 'extra-overrides-form').map(w => w.flag).sort()
  expect(flags).toEqual(['--ctx-size', '--n-gpu-layers'])
  expect(r.ok).toBe(true)
})

test('extra args can replace file-managed flags', () => {
  const r = build({ profile: { extraArgs: '--chat-template-file "C:\\t.jinja"' }, paths: { model: 'M', chatTemplate: 'T' } })
  expect(r.args.filter(a => a === '--chat-template-file').length).toBe(1)
  expect(after(r.args, '--chat-template-file')).toBe('C:\\t.jinja')
  expect(r.warnings.some(w => w.code === 'extra-overrides-form' && w.flag === '--chat-template-file')).toBe(true)
})

test('later extra layer replaces an earlier one without warning; repeatable flags accumulate', () => {
  const r = build({
    defaults: defaults({ extraArgs: '--threads 4 --lora a.gguf' }),
    profile: { extraArgs: '-t 8 --lora b.gguf' },
  })
  expect(r.warnings).toEqual([])
  expect(r.args.join(' ')).toContain('-t 8')
  expect(r.args).not.toContain('--threads')
  expect(r.args.filter(a => a === '--lora').length).toBe(2)
})

test('duplicates inside one extra-args text warn once and the last wins', () => {
  const r = build({ profile: { extraArgs: '--threads 2 --threads 4 --threads 6' } })
  const dups = r.warnings.filter(w => w.code === 'duplicate-in-layer')
  expect(dups).toEqual([{ code: 'duplicate-in-layer', severity: 'warning', flag: '--threads', layer: 'profile' }])
  expect(r.args.filter(a => a === '--threads')).toEqual(['--threads'])
  expect(after(r.args, '--threads')).toBe('6')
})

test('--host and --port from extra args are removed; ours are used', () => {
  const r = build({ profile: { extraArgs: '--host 0.0.0.0 --port=9999 --slots' }, port: 7123 })
  expect(r.args.filter(a => a === '--host')).toEqual(['--host'])
  expect(after(r.args, '--host')).toBe('127.0.0.1')
  expect(after(r.args, '--port')).toBe('7123')
  expect(r.args.join(' ')).not.toContain('9999')
  expect(r.args).toContain('--slots')
  expect(r.warnings.filter(w => w.code === 'reserved-flag-removed').map(w => w.flag).sort()).toEqual(['--host', '--port'])
})

test('unterminated quote in extra args is an error and blocks launch', () => {
  const r = build({ profile: { extraArgs: '--foo "bar' } })
  expect(r.ok).toBe(false)
  expect(r.warnings).toEqual([{ code: 'extra-syntax-error', severity: 'error', layer: 'profile', detail: expect.stringContaining('Unterminated') }])
})

test('invalid port is an error', () => {
  expect(build({ port: 0 }).ok).toBe(false)
  expect(build({ port: 70000 }).ok).toBe(false)
  expect(build({ port: 7100.5 }).ok).toBe(false)
})

test('formatCommand quotes only when needed and round-trips through splitArgs', () => {
  const exe = 'C:\\Program Files\\llama\\llama-server.exe'
  const r = build({ paths: { model: 'X:\\my models\\m 1.gguf' }, profile: { extraArgs: '--override-kv "a=str:b c"' } })
  const cmd = formatCommand(exe, r.args)
  expect(cmd.startsWith('"C:\\Program Files\\llama\\llama-server.exe" --model "X:\\my models\\m 1.gguf"')).toBe(true)
  expect(splitArgs(cmd)).toEqual([exe, ...r.args])
})

test('quoteCmdArg: plain stays plain, spaces are quoted, cmd metacharacters get ^ (real cmd.exe check in tests/platform)', () => {
  expect(quoteCmdArg('X:\\models\\m.gguf')).toBe('X:\\models\\m.gguf')
  expect(quoteCmdArg('X:\\my models\\m 1.gguf')).toBe('"X:\\my models\\m 1.gguf"')
  expect(quoteCmdArg('')).toBe('""')
  expect(quoteCmdArg('X:\\models\\A&B.gguf')).toBe('X:\\models\\A^&B.gguf')
  expect(quoteCmdArg('100%')).toBe('100^%')
  expect(quoteCmdArg('X:\\a b\\A&B (1).gguf')).toBe('^"X:\\a b\\A^&B ^(1^).gguf^"')
  expect(quoteCmdArg('{"a":1}')).toBe('^"{\\^"a\\^":1}^"')
  expect(quoteCmdArg('trail space\\')).toBe('"trail space\\\\"')
  expect(quoteCmdArg('X:\\models\\A(1).gguf')).toBe('X:\\models\\A^(1^).gguf')
  expect(quoteCmdArg(')')).toBe('^)')
  expect(quoteCmdArg('a;b,c=d')).toBe('a;b,c=d')
  expect(formatCmdCommand('C:\\Program Files\\llama\\llama-server.exe', ['--model', 'X:\\m.gguf']))
    .toBe('"C:\\Program Files\\llama\\llama-server.exe" --model X:\\m.gguf')
  // The program path is always plain-quoted when unusual (^-escaped quotes do not group it for cmd).
  expect(formatCmdCommand('X:\\a b&c (x)\\llama-server.exe', [])).toBe('"X:\\a b&c (x)\\llama-server.exe"')
  // Without whitespace every special (% included) gets a ^ instead.
  expect(formatCmdCommand('X:\\semi;co\\llama-server.exe', [])).toBe('X:\\semi^;co\\llama-server.exe')
  expect(formatCmdCommand('X:\\p%V%x\\llama-server.exe', [])).toBe('X:\\p^%V^%x\\llama-server.exe')
  expect(formatCmdCommand('X:\\plain\\llama-server.exe', [])).toBe('X:\\plain\\llama-server.exe')
  // Whitespace plus a %NAME% pair cannot be written safely for cmd: flagged for the preview.
  expect(cmdProgramMayExpand('X:\\a b %V%\\llama-server.exe')).toBe(true)
  expect(cmdProgramMayExpand('X:\\a b 100%\\llama-server.exe')).toBe(false)
  expect(cmdProgramMayExpand('X:\\p%V%x\\llama-server.exe')).toBe(false)
})

test('default defaults match the plan and produce a sane command', () => {
  const r = buildLaunchArgs({
    paths: { model: 'M' }, defaults: DEFAULT_LAUNCH_DEFAULTS, host: '127.0.0.1', port: 7100,
  })
  expect(r.ok).toBe(true)
  expect(r.warnings).toEqual([])
  expect(after(r.args, '--ctx-size')).toBe('262144')
  expect(after(r.args, '--flash-attn')).toBe('on')
  expect(r.args).toContain('--jinja')
})
