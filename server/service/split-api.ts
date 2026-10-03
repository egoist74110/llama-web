// Shared input check of /api/devices/split (query of the GET, body of the POST).
import { isExperimentalMode, MAX_GROUP } from '../core/gpu-group'
import { normalizeDevice } from '../core/args'
import { t } from '../core/i18n'

export function parseSplitQuery(raw: Record<string, unknown>): { runtime: string | null, devices: string[], mode: string } {
  const bad = () => createError({ statusCode: 400, message: t.models.errors.badRequest })
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : ''
  if (!isExperimentalMode(mode)) throw bad()
  const list = Array.isArray(raw.devices) ? raw.devices : typeof raw.devices === 'string' ? raw.devices.split(',') : []
  const devices: string[] = []
  for (const x of list) {
    const id = typeof x === 'string' ? normalizeDevice(x) : null
    if (!id || id === 'auto' || id === 'cpu' || devices.includes(id)) throw bad()
    devices.push(id)
  }
  if (devices.length < 2 || devices.length > MAX_GROUP) throw bad()
  const runtime = typeof raw.runtime === 'string' && raw.runtime.trim() ? raw.runtime.trim() : null
  return { runtime, devices, mode }
}
