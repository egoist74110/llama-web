// What is known about a row / tensor group on one build (decision 45): `?runtime=<ref>&devices=CUDA0,CUDA1&mode=tensor`
// answers { confirmed, failed }. The interface asks before it lets the user keep an experimental mode.
import { hasDeviceSelection } from '../../core/config'
import { parseSplitQuery } from '../../service/split-api'
import { getContext } from '../../service/context'

export default defineEventHandler((event) => {
  const ctx = getContext()
  if (!hasDeviceSelection(ctx.platform)) throw createError({ statusCode: 404, message: 'No device choice on this computer' })
  const { runtime, devices, mode } = parseSplitQuery(getQuery(event))
  const key = ctx.splitKey(runtime, devices, mode)
  const record = key ? ctx.splitStats.get(key) : undefined
  return { confirmed: record?.confirmedAt !== undefined, failed: record?.failed ?? null }
})
