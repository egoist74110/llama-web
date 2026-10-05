// Text helpers for the UI. All wording comes from i18n/zh-CN.ts.
import t from '~~/i18n/zh-CN'
import type { ActivityEvent, StateDoc } from '~~/server/core/live'
import type { RequestRecord } from '~~/server/core/request-log'
import { noRoomReasonTemplate, poolText } from '../utils/memory-check'

export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

export type StateName = keyof typeof t.status.states

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return fmt(t.duration.s, { n: total })
  if (total < 3600) return fmt(t.duration.m, { n: Math.floor(total / 60), s: total % 60 })
  return fmt(t.duration.h, { n: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) })
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Memory in MiB as MiB / GiB text. */
export function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`
}

export function stateLabel(s: string): string {
  return t.status.states[s as StateName] ?? s
}

/** Load error code from the scheduler -> short Chinese reason; unknown texts are shown as-is. */
export function reasonText(code: string | null): string {
  if (!code) return ''
  return (t.loadError as Record<string, string>)[code] ?? code
}

export function runtimeText(r: StateDoc['llamacpp']['runtime'] | undefined): string {
  if (!r) return ''
  const rt = t.status.runtime
  switch (r.state) {
    case 'working': return fmt(rt.working[r.step], { detail: r.detail })
    case 'ready': {
      const vars = { tag: r.tag, from: r.from ?? '', latest: r.latest ?? '' }
      if (r.note === 'updated') return fmt(r.from ? rt.notes.updated : rt.notes.updatedFirst, vars)
      return r.note ? fmt(rt.notes[r.note], vars) : fmt(rt.ready, vars)
    }
    case 'error': return fmt(r.using ? rt.errorUsing : rt.error, { code: (rt.errors as Record<string, string>)[r.code] ?? r.code, detail: r.detail, using: r.using ?? '' })
    case 'disabled': return rt.disabled
    default: return rt.idle
  }
}

/** Chinese reason for a tunnel error code (`detail` is appended after a colon when present). */
export function tunnelErrorText(code: string, detail = ''): string {
  const codes = t.tunnel.codes as Record<string, string>
  return fmt(codes[code] ?? code, { detail: detail ? `：${detail}` : '' })
}

/** Chinese reason for a one-click setup error (same wording as the server's HTTP errors). */
export function cfErrorText(code: string, detail = ''): string {
  const errors = t.cloudflare.errors as Record<string, string>
  if (code === 'forbidden') {
    const perm = (t.cloudflare.permissions as Record<string, string>)[detail]
    return perm ? fmt(errors['forbidden-perm']!, { perm }) : errors.forbidden!
  }
  const specific = code === 'changed' ? errors[`changed-${detail}`] : undefined
  if (specific) return specific
  return fmt(errors[code] ?? code, { detail: detail ? `（${detail}）` : '' })
}

const gibText = (miB: number | null) => (miB === null ? '?' : `${(miB / 1024).toFixed(1)} GB`)

/** `isMac`: a Mac never reads GPU / video-memory wording (decision 38). */
export function eventText(e: ActivityEvent, modelName: (id: string) => string, isMac = false): string {
  if (e.kind === 'state') {
    const vars = { model: modelName(e.modelId), profile: e.profile, from: stateLabel(e.from), to: stateLabel(e.to) }
    return e.error ? fmt(t.events.stateError, { ...vars, reason: reasonText(e.error) }) : fmt(t.events.state, vars)
  }
  if (e.kind === 'drain-timeout') {
    return fmt(t.events.drainTimeout, { model: modelName(e.modelId), profile: e.profile, count: e.inflight })
  }
  if (e.kind === 'tunnel') {
    return e.state === 'connected' ? t.events.tunnel.connected : fmt(t.events.tunnel.error, { reason: tunnelErrorText(e.code ?? '') })
  }
  if (e.kind === 'runtime-fallback') {
    return fmt(t.events.runtimeFallback[e.reason], { model: modelName(e.modelId), profile: e.profile, from: e.from, to: e.to })
  }
  if (e.kind === 'no-room') {
    const key = e.manual ? 'manual' : 'request'
    const template = noRoomReasonTemplate(e.reason, isMac)
    return fmt(t.events.noRoom[key], { model: modelName(e.modelId), profile: e.profile, reason: fmt(template, { estimate: gibText(e.estimateMiB), available: gibText(e.availableMiB) }) })
  }
  if (e.kind === 'make-room') {
    return fmt(t.events.makeRoom, { model: modelName(e.modelId), profile: e.profile, victim: modelName(e.victimModelId), victimProfile: e.victimProfile })
  }
  if (e.kind === 'watchdog') {
    const vars = { model: e.modelId ? modelName(e.modelId) : '', profile: e.profile ?? '', pool: poolText(e.pool, isMac), percent: Math.round(e.freePercent) }
    return fmt(e.state === 'stopped' ? t.events.watchdog.stopped : t.events.watchdog.blocked, vars)
  }
  if (e.kind === 'vram-deviation') {
    return fmt(t.events.vramDeviation, { model: modelName(e.modelId), profile: e.profile, percent: Math.round(e.deviation * 100) })
  }
  const rt = t.events.runtime
  const vars = { tag: e.tag ?? '', code: (t.status.runtime.errors as Record<string, string>)[e.code ?? ''] ?? e.code ?? '', from: e.from ?? '' }
  if (e.state === 'ready' && e.note === 'updated') return fmt(e.from ? rt.updated : rt.updatedFirst, vars)
  if (e.state === 'ready' && e.note === 'switched') return fmt(rt.switched, vars)
  if (e.state === 'error' && e.tag) return fmt(rt.errorUsing, vars)
  return fmt(rt[e.state], vars)
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** 27_000_000_000 -> `27B`, 350_000_000 -> `350M`. */
export function formatParams(n: number | null | undefined): string {
  if (!n) return t.models.discover.unknown
  if (n >= 1e9) return `${+(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  return `${Math.round(n / 1e6)}M`
}

/** 262144 -> `256K`; other values are shown as-is. */
export function formatContext(n: number | null | undefined): string {
  if (!n) return t.models.discover.unknown
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : String(n)
}

export function requestSourceText(r: Pick<RequestRecord, 'source' | 'keyName'>): string {
  const label = t.logs.requests.source[r.source]
  return r.keyName ? `${label} · ${r.keyName}` : label
}

/** `{count} images, 2.1 MB -> 180 KB, longest edge 3000 -> 896px`. */
export function requestImagesText(i: RequestRecord['images']): string {
  if (!i) return ''
  const vars = { count: i.count, before: formatBytes(i.beforeBytes), after: formatBytes(i.afterBytes), edgeBefore: i.maxEdgeBefore, edgeAfter: i.maxEdgeAfter }
  return fmt(i.compressed ? t.logs.requests.images : t.logs.requests.imagesKept, vars)
}

export function requestParamsText(p: RequestRecord['params']): string {
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ')
}

export function requestTokensText(r: Pick<RequestRecord, 'promptTokens' | 'completionTokens'>): string {
  if (r.promptTokens === null && r.completionTokens === null) return ''
  return `${r.promptTokens ?? '-'} → ${r.completionTokens ?? '-'}`
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** 1234 -> `1,234`; used for token and request counts. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}
