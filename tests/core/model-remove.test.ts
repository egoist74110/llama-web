import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelConfig, ModelsDoc } from '../../server/core/config'
import { ModelOps } from '../../server/core/model-ops'
import { planRemove, removeModel, RemoveError, type RemoveDeps } from '../../server/core/model-remove'
import { Scheduler } from '../../server/core/scheduler'
import { moveToTrash } from '../../server/core/trash'
import type { FileRef, ModelDir } from '../../server/core/types'

let root = ''
let outside = ''
let dirs: ModelDir[] = []

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'lw-remove-'))
  root = join(base, 'models')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  dirs = [{ id: 'main', path: root, enabled: true, maxDepth: 4 }]
})
afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }) })

const ref = (rel: string): FileRef => ({ dirId: 'main', rel })
const touch = (rel: string) => {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, 'x')
  return abs
}
function model(id: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id.toUpperCase(), backend: 'llama-server', file: ref(`${id}/${id}.gguf`), mmproj: null, draft: null,
    activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' } }, ...over,
  }
}
const docOf = (...models: ModelConfig[]): ModelsDoc => ({ version: 1, models })

/** A fake trash that really deletes (so tests can check the disk) and records what it was asked. */
function setup(doc: ModelsDoc, over: Partial<RemoveDeps> & { trashFails?: string[], busy?: boolean } = {}) {
  const calls: string[][] = []
  const deps: RemoveDeps = {
    ops: { forget: async (id) => { if (over.busy) { const { ModelBusyError } = await import('../../server/core/model-ops'); throw new ModelBusyError(id) } } },
    getModels: () => doc,
    updateModels: (fn) => { fn(doc) },
    dirs: () => dirs,
    trash: async (paths) => {
      calls.push(paths)
      const failed = paths.filter(p => over.trashFails?.some(s => p.endsWith(s)))
      for (const p of paths) if (!failed.includes(p)) rmSync(p)
      return { failed }
    },
    ...over,
  }
  return { deps, calls, doc }
}

describe('removeModel', () => {
  test('without the checkbox only the configuration goes; no file is touched, trash is never called', async () => {
    const abs = touch('a/a.gguf')
    const { deps, calls, doc } = setup(docOf(model('a', { file: ref('a/a.gguf') }), model('b')))
    const r = await removeModel(deps, 'a', false)
    expect(doc.models.map(m => m.id)).toEqual(['b'])
    expect(existsSync(abs)).toBe(true)
    expect(calls).toEqual([])
    expect(r.trashed).toEqual([])
  })

  test('with the checkbox the model, mmproj and draft files are trashed', async () => {
    const m = touch('a/a.gguf'); const mm = touch('a/mmproj-a.gguf'); const dr = touch('a/a-mtp.gguf')
    const { deps, doc } = setup(docOf(model('a', { file: ref('a/a.gguf'), mmproj: ref('a/mmproj-a.gguf'), draft: ref('a/a-mtp.gguf') })))
    const r = await removeModel(deps, 'a', true)
    expect(doc.models).toEqual([])
    expect([m, mm, dr].some(existsSync)).toBe(false)
    expect(r.trashed.map(f => f.rel).sort()).toEqual(['a/a-mtp.gguf', 'a/a.gguf', 'a/mmproj-a.gguf'])
  })

  test('shared mmproj / draft used by another model is kept and reported; own files still go', async () => {
    const own = touch('a/a.gguf'); const shared = touch('s/mmproj.gguf'); const draft = touch('s/draft.gguf')
    const { deps, doc } = setup(docOf(
      model('a', { file: ref('a/a.gguf'), mmproj: ref('s/mmproj.gguf'), draft: ref('s/draft.gguf') }),
      model('b', { mmproj: ref('s/mmproj.gguf') }),
      model('c', { draft: ref('s/draft.gguf') }),
    ))
    const r = await removeModel(deps, 'a', true)
    expect(existsSync(own)).toBe(false)
    expect(existsSync(shared)).toBe(true)
    expect(existsSync(draft)).toBe(true)
    expect(r.keptShared.map(k => [k.ref.rel, k.usedBy])).toEqual([['s/mmproj.gguf', ['B']], ['s/draft.gguf', ['C']]])
    expect(doc.models.map(m => m.id)).toEqual(['b', 'c'])
  })

  test('a sharded model: every shard is trashed, other shard sets in the folder are not', async () => {
    const shards = [1, 2, 3].map(i => touch(`big/Q-0000${i}-of-00003.gguf`))
    const other = touch('big/Other-00001-of-00002.gguf')
    const same = touch('big/Q-00001-of-00002.gguf') // same prefix, different total: another set
    const { deps } = setup(docOf(model('q', { file: ref('big/Q-00001-of-00003.gguf') })))
    const r = await removeModel(deps, 'q', true)
    expect(shards.some(existsSync)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(same)).toBe(true)
    expect(r.trashed).toHaveLength(3)
  })

  test('a running, loading or queued model is refused and nothing changes', async () => {
    const abs = touch('a/a.gguf')
    const { deps, calls, doc } = setup(docOf(model('a', { file: ref('a/a.gguf') })), { busy: true })
    await expect(removeModel(deps, 'a', true)).rejects.toMatchObject({ code: 'in-use' })
    await expect(removeModel(deps, 'a', false)).rejects.toMatchObject({ code: 'in-use' })
    expect(doc.models).toHaveLength(1)
    expect(existsSync(abs)).toBe(true)
    expect(calls).toEqual([])
  })

  test('a file outside every registered directory refuses the whole file removal before touching anything', async () => {
    const own = touch('a/a.gguf')
    const stray = join(outside, 'x.gguf'); writeFileSync(stray, 'x')
    for (const bad of [{ dirId: 'gone', rel: 'x.gguf' }, ref('../outside/x.gguf')]) {
      const { deps, calls, doc } = setup(docOf(model('a', { file: ref('a/a.gguf'), mmproj: bad })))
      await expect(removeModel(deps, 'a', true)).rejects.toMatchObject({ code: 'outside-dir' })
      expect(doc.models).toHaveLength(1)
      expect(calls).toEqual([])
      expect(existsSync(own)).toBe(true)
      expect(existsSync(stray)).toBe(true)
    }
  })

  test('a symlinked folder that leads outside the model directory is refused', async () => {
    writeFileSync(join(outside, 'x.gguf'), 'x')
    symlinkSync(outside, join(root, 'link'))
    const { deps, calls, doc } = setup(docOf(model('a', { file: ref('link/x.gguf') })))
    await expect(removeModel(deps, 'a', true)).rejects.toMatchObject({ code: 'outside-dir' })
    expect(calls).toEqual([])
    expect(existsSync(join(outside, 'x.gguf'))).toBe(true)
    expect(doc.models).toHaveLength(1)
    // ...but dropping only the configuration still works.
    await removeModel(deps, 'a', false)
    expect(doc.models).toHaveLength(0)
    expect(existsSync(join(outside, 'x.gguf'))).toBe(true)
  })

  test('only .gguf files are ever planned', () => {
    touch('a/a.txt')
    expect(() => planRemove(docOf(model('a', { file: ref('a/a.txt') })), dirs, 'a')).toThrow(RemoveError)
  })

  test('main file that cannot be trashed keeps the configuration; a helper failure does not block', async () => {
    touch('a/a.gguf'); touch('a/mm.gguf')
    const one = setup(docOf(model('a', { file: ref('a/a.gguf') })), { trashFails: ['a.gguf'] })
    await expect(removeModel(one.deps, 'a', true)).rejects.toMatchObject({ code: 'trash-failed' })
    expect(one.doc.models).toHaveLength(1)

    const two = setup(docOf(model('a', { file: ref('a/a.gguf'), mmproj: ref('a/mm.gguf') })), { trashFails: ['mm.gguf'] })
    const r = await removeModel(two.deps, 'a', true)
    expect(two.doc.models).toHaveLength(0)
    expect(r.failed.map(f => f.rel)).toEqual(['a/mm.gguf'])
  })

  test('files already gone are reported as missing and do not fail the removal', async () => {
    const { deps, doc } = setup(docOf(model('a', { file: ref('a/a.gguf') })))
    const r = await removeModel(deps, 'a', true)
    expect(r.missing.map(f => f.rel)).toEqual(['a/a.gguf'])
    expect(doc.models).toHaveLength(0)
  })

  test('unknown model', async () => {
    const { deps } = setup(docOf())
    await expect(removeModel(deps, 'zzz', false)).rejects.toMatchObject({ code: 'model-not-found' })
  })
})

describe('ModelOps.forget', () => {
  const sched = (queue: Array<{ modelId: string, profile: string }>, models: Array<{ modelId: string, profile: string, state: string }> = []) => ({
    snapshot: () => ({ models, queue }),
    start: async () => {}, stop: async () => {}, retry: async () => {}, cancelManual: () => false,
  }) as unknown as ConstructorParameters<typeof ModelOps>[0]

  test('refuses while the model is loading, ready, winding down or queued; never stops it', async () => {
    for (const state of ['loading', 'ready', 'draining', 'unloading']) {
      const ops = new ModelOps(sched([], [{ modelId: 'a', profile: 'default', state }]))
      await expect(ops.forget('a')).rejects.toMatchObject({ name: 'ModelBusyError' })
    }
    await expect(new ModelOps(sched([{ modelId: 'a', profile: 'default' }])).forget('a')).rejects.toMatchObject({ name: 'ModelBusyError' })
  })

  test('allows a stopped or failed model and another model being busy', async () => {
    await new ModelOps(sched([], [{ modelId: 'a', profile: 'default', state: 'failed' }])).forget('a')
    await new ModelOps(sched([], [{ modelId: 'b', profile: 'default', state: 'ready' }])).forget('a')
  })

  test('works with the real scheduler', async () => {
    const real = new Scheduler({ maxLoaded: 1, drainTimeoutMs: 100, launch: async () => { throw new Error('unused') } })
    await new ModelOps(real).forget('a')
  })
})

describe('moveToTrash', () => {
  test('Windows: paths travel in the environment, failures come back by index', async () => {
    const seen: { args: string[], env?: Record<string, string> }[] = []
    const r = await moveToTrash(['C:\\m\\a.gguf', 'C:\\m\\b 中文.gguf'], {
      platform: 'win32',
      run: async (_c, args, _t, env) => { seen.push({ args, env }); return 'FAIL 1\r\n' },
    })
    expect(r.failed).toEqual(['C:\\m\\b 中文.gguf'])
    expect(JSON.parse(seen[0]!.env!.LLAMA_WEB_TRASH!)).toEqual(['C:\\m\\a.gguf', 'C:\\m\\b 中文.gguf'])
    expect(seen[0]!.args.join(' ')).not.toContain('a.gguf')
  })

  test('macOS: paths are separate arguments (no script interpolation); failed indexes map back', async () => {
    let args: string[] = []
    const r = await moveToTrash(['/m/a "q".gguf', '/m/b.gguf'], { platform: 'darwin', run: async (_c, a) => { args = a; return '0\n' } })
    expect(args.slice(-2)).toEqual(['/m/a "q".gguf', '/m/b.gguf'])
    expect(args[1]).not.toContain('/m/')
    expect(r.failed).toEqual(['/m/a "q".gguf'])
  })

  test('a failing command marks everything failed and never deletes permanently', async () => {
    const r = await moveToTrash(['/m/a.gguf'], { platform: 'darwin', run: async () => { throw new Error('boom') } })
    expect(r.failed).toEqual(['/m/a.gguf'])
  })
})
