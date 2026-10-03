// Devices a model can run on, from `llama-server --list-devices` of one llama.cpp build:
// `?runtime=<ref>` (empty = the global version), `?refresh=1` asks the build again.
// A Mac answers `{ applicable: false }` (decision 38: nothing about devices exists there).
import { getContext } from '../service/context'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  return getContext().getDevices({ runtime: typeof q.runtime === 'string' ? q.runtime : null, refresh: q.refresh === '1' })
})
