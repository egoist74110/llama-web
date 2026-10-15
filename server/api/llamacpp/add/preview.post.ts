// Stage a llama.cpp build for adding: { kind: 'dir' | 'archive' | 'exe', path } or { kind: 'github', url, accel? }.
// This runs `llama-server --version` of the chosen build (time-limited), so the page must warn before calling it.
// Nothing is registered until /api/llamacpp/add/confirm.
import { t } from '../../../core/i18n'
import type { AddInput } from '../../../core/runtime-add'
import { getContext } from '../../../service/context'
import { runtimeError } from '../../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const b = await readBody<Record<string, unknown>>(event)
  const bad = () => createError({ statusCode: 400, message: t.llamacpp.runtimes.add['bad-source'] })
  let input: AddInput
  if ((b?.kind === 'dir' || b?.kind === 'archive' || b?.kind === 'exe') && typeof b.path === 'string' && b.path && b.path.length < 1024) input = { kind: b.kind, path: b.path }
  else if (b?.kind === 'github' && typeof b.url === 'string' && b.url.length < 512) {
    if (b.accel !== undefined && b.accel !== 'cuda' && b.accel !== 'cpu' && b.accel !== 'vulkan') throw bad()
    input = { kind: 'github', url: b.url, ...(b.accel ? { accel: b.accel } : {}) }
  } else throw bad()
  if (input.kind === 'archive' && b.cudartPath !== undefined) {
    if (typeof b.cudartPath !== 'string' || !b.cudartPath || b.cudartPath.length >= 1024) throw bad()
    input.cudartPath = b.cudartPath
  }
  if (input.kind === 'github' && typeof b.mirror === 'string') input.mirror = b.mirror
  try {
    const ctx = getContext()
    if (b?.remember === true) ctx.updateSettings(s => { s.network.downloadSource = 'auto' })
    return await ctx.runtimeAdd.preview(input)
  } catch (e) {
    runtimeError(e)
  }
})
