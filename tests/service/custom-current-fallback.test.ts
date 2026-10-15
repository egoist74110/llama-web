import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultSettings } from '../../server/core/config'
import { versionsDir } from '../../server/core/llamacpp'

// Exercise the real event/log wiring, stopping before any process or GPU can be used.
test.skipIf(process.platform !== 'darwin')('a missing custom global emits the existing fallback event and keeps the saved setting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-global-fallback-'))
  const key = Symbol.for('llama-web.context'), globals = globalThis as Record<symbol, unknown>
  const previous = globals[key], env = process.env.LLAMA_WEB_DATA
  let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
  try {
    const settings = defaultSettings()
    settings.setup = { done: true, tuned: true }
    settings.llamacpp.current = 'custom:missing'
    settings.network.proxy.mode = 'off'
    const modelDir = join(dir, 'models'); mkdirSync(modelDir)
    settings.modelDirs = [{ id: 'd', path: modelDir, enabled: true, maxDepth: 0 }]
    writeFileSync(join(modelDir, 'model.gguf'), 'GGUF')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [{ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'model.gguf' }, mmproj: null, draft: null, activeProfile: 'p', profiles: { p: { overrides: {}, extraArgs: '' } } }] }))
    const official = join(versionsDir(dir), `darwin-${process.arch}-${process.arch === 'arm64' ? 'metal' : 'cpu'}`, 'b1234')
    mkdirSync(official, { recursive: true }); writeFileSync(join(official, 'llama-server'), 'not executable')
    process.env.LLAMA_WEB_DATA = dir; delete globals[key]
    ctx = (await import('../../server/service/context')).getContext()
    Object.assign(ctx.outbound, { direct: async () => { throw new Error('offline test') } })
    let started = ''
    ctx.runner.start = async spec => { started = spec.exe; throw new Error('test stops before process start') }
    await expect(ctx.scheduler.acquire({ modelId: 'm', profile: 'p' })).rejects.toThrow()
    expect(started).toBe(join(official, 'llama-server'))
    expect(ctx.live.recent()).toContainEqual(expect.objectContaining({ kind: 'runtime-fallback', modelId: 'm', from: 'custom:missing', to: `${process.arch === 'arm64' ? 'metal' : 'cpu'}:b1234`, reason: 'missing' }))
    expect(ctx.getSettings().llamacpp.current).toBe('custom:missing')
  } finally {
    await ctx?.shutdown()
    if (env === undefined) delete process.env.LLAMA_WEB_DATA; else process.env.LLAMA_WEB_DATA = env
    if (previous === undefined) delete globals[key]; else globals[key] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
