// Text helpers for the UI. All wording comes from i18n/zh-CN.ts.
import t from '~~/i18n/zh-CN'
import type { ActivityEvent, StateDoc } from '~~/server/core/live'

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
    case 'ready': return fmt(rt.ready, { tag: r.tag })
    case 'error': return fmt(rt.error, { code: r.code, detail: r.detail })
    case 'disabled': return rt.disabled
    default: return rt.idle
  }
}

export function eventText(e: ActivityEvent, modelName: (id: string) => string): string {
  if (e.kind === 'state') {
    const vars = { model: modelName(e.modelId), profile: e.profile, from: stateLabel(e.from), to: stateLabel(e.to) }
    return e.error ? fmt(t.events.stateError, { ...vars, reason: reasonText(e.error) }) : fmt(t.events.state, vars)
  }
  if (e.kind === 'drain-timeout') {
    return fmt(t.events.drainTimeout, { model: modelName(e.modelId), profile: e.profile, count: e.inflight })
  }
  const rt = t.events.runtime
  return fmt(rt[e.state], { tag: e.tag ?? '', code: e.code ?? '' })
}
