// The user accepted an experimental split mode for this build + devices + mode: { runtime, devices: ['CUDA0', 'CUDA1'], mode }.
// Only recorded; the next load that uses the combination still runs and, if it dies, is remembered as failed.
import { hasDeviceSelection } from '../../core/config'
import { parseSplitQuery } from '../../service/split-api'
import { getContext } from '../../service/context'

export default defineEventHandler(async (event) => {
  const ctx = getContext()
  if (!hasDeviceSelection(ctx.platform)) throw createError({ statusCode: 404, message: 'No device choice on this computer' })
  const body = await readBody<Record<string, unknown>>(event)
  const { runtime, devices, mode } = parseSplitQuery(body ?? {})
  const key = ctx.splitKey(runtime, devices, mode)
  if (!key) throw createError({ statusCode: 400, message: 'No llama.cpp build to confirm this on' })
  ctx.splitStats.confirm(key)
  return { ok: true }
})
