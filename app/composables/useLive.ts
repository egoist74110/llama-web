// One shared live connection to /api/stream for the whole app: the latest state snapshot,
// the recent activity list and the connection status. Pages read from here and never
// poll. EventSource reconnects by itself; a dropped connection is shown in the top bar.
import type { ActivityEvent, LogLine, MetricsDoc, StateDoc } from '~~/server/core/live'
import type { RequestRecord } from '~~/server/core/request-log'

const MAX_EVENTS = 50
const MAX_REQUESTS = 200
const MAX_LOG_LINES = 3000

const state = shallowRef<StateDoc | null>(null)
const events = shallowRef<ActivityEvent[]>([]) // newest first
const requests = shallowRef<RequestRecord[]>([]) // newest first
const logLines = shallowRef<LogLine[]>([]) // oldest first
const metrics = shallowRef<MetricsDoc | null>(null)
const connected = ref(false)
// Ticks every second so elapsed-time texts stay fresh without any server traffic.
const now = ref(Date.now())
// Server clock minus local clock at the last snapshot (both are this machine, but be safe).
const skew = ref(0)

let source: EventSource | null = null
let ticker: ReturnType<typeof setInterval> | undefined

function parse<T>(e: MessageEvent): T | null {
  try { return JSON.parse(e.data) as T } catch { return null }
}

function connect() {
  if (import.meta.server || source) return
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  source = new EventSource('/api/stream')
  source.onopen = () => { connected.value = true }
  source.onerror = () => { connected.value = false }
  source.addEventListener('snapshot', (e) => {
    const s = parse<StateDoc>(e as MessageEvent)
    if (!s) return
    state.value = s
    skew.value = s.now - Date.now()
    connected.value = true
  })
  source.addEventListener('metrics', (e) => {
    const m = parse<MetricsDoc>(e as MessageEvent)
    if (m) metrics.value = m
  })
  source.addEventListener('history', (e) => {
    const h = parse<ActivityEvent[]>(e as MessageEvent)
    if (h) events.value = [...h].reverse().slice(0, MAX_EVENTS)
  })
  source.addEventListener('activity', (e) => {
    const a = parse<ActivityEvent>(e as MessageEvent)
    if (a) events.value = [a, ...events.value.filter(x => x.id !== a.id)].slice(0, MAX_EVENTS)
  })
  source.addEventListener('request-history', (e) => {
    const h = parse<RequestRecord[]>(e as MessageEvent)
    if (h) requests.value = [...h].reverse().slice(0, MAX_REQUESTS)
  })
  source.addEventListener('request', (e) => {
    const r = parse<RequestRecord>(e as MessageEvent)
    if (r) requests.value = [r, ...requests.value.filter(x => x.id !== r.id)].slice(0, MAX_REQUESTS)
  })
  // Reconnects resend the history; ids keep increasing, so merge by id instead of appending twice.
  source.addEventListener('log-history', (e) => {
    const h = parse<LogLine[]>(e as MessageEvent)
    if (h) logLines.value = h.slice(-MAX_LOG_LINES)
  })
  source.addEventListener('log', (e) => {
    const lines = parse<LogLine[]>(e as MessageEvent)
    if (!lines?.length) return
    const last = logLines.value.at(-1)?.id ?? 0
    const fresh = lines.filter(l => l.id > last)
    if (fresh.length) logLines.value = [...logLines.value, ...fresh].slice(-MAX_LOG_LINES)
  })
}

function disconnect() {
  source?.close()
  source = null
  clearInterval(ticker)
  connected.value = false
}

export function useLive() {
  /** Server-time "now" in ms. */
  const serverNow = computed(() => now.value + skew.value)
  return { state, events, requests, logLines, metrics, connected, serverNow, connect, disconnect }
}
