// Pure helpers for the memory estimate and the manual-start guard (decisions 41-44, 9-4): wording, tiers, breakdown rows
// and the reading of a refused start (HTTP 409). Bun-testable; the Mac gets no GPU / video-memory wording (decision 38).
import t from '../../i18n/zh-CN'
import { decidingPool, SYSTEM_POOL } from '../../server/core/admission'
import type { StateDoc } from '../../server/core/live'
import type { MemoryEstimate, Pool, Tier } from '../../server/core/memory-estimate'
import type { CheckIssue } from '../../server/core/model-check'

/** What POST /api/models/:id/check returns for one profile (the part the interface uses). */
export interface CheckDoc {
  tier: Tier
  estimate: MemoryEstimate | null
  issues: CheckIssue[]
  blocked: boolean
  /** Another instance of this model is online: the free memory no longer holds what it uses, so the answer is cautious. */
  online: boolean
  basis: 'measured' | 'formula'
  mlockDropped: boolean
}

const m = t.memory
const fill = (template: string, vars: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (x, k: string) => (k in vars ? String(vars[k]) : x))

/** `12.3 GB` (binary gigabytes, as the rest of the interface shows memory); under 1 GB in MiB so small numbers do not read as 0.0. */
export const gib = (miB: number | null | undefined): string => (miB === null || miB === undefined ? '?' : miB < 1024 ? `${Math.round(miB)} MiB` : `${(miB / 1024).toFixed(1)} GB`)

/** Class of the status pill of a tier. */
export function tierClass(tier: Tier): string {
  return tier === 'ok' ? 'lw-st-ready' : tier === 'risky' ? 'lw-st-loading' : tier === 'nofit' ? 'lw-st-failed' : 'lw-st-stopped'
}

/** Class of the bar of a tier (`lw-bar` + this). */
export function tierBar(tier: Tier): string {
  return tier === 'risky' ? 'warn' : tier === 'nofit' ? 'err' : tier === 'unknown' ? 'dim' : ''
}

/** Whether the memory the estimate talks about is a card's own (Windows with a GPU) or system / unified memory. */
export function usesVram(est: MemoryEstimate | null, isMac: boolean): boolean {
  return !isMac && !!est?.pools.some(p => p.kind === 'separate')
}

/** "显存" or "内存": the noun for the memory a launch is judged against; a Mac and a system pool never say video memory. */
export function memoryNoun(pool: string | null | undefined, isMac: boolean): string {
  return isMac || !pool || pool === SYSTEM_POOL || pool === 'host' ? m.noun.ram : m.noun.vram
}

export function estimateTitle(est: MemoryEstimate | null, isMac: boolean): string {
  return usesVram(est, isMac) ? m.titleVram : m.titleRam
}

/** Name of a pool in the breakdown: the card by its name, the host as system memory, a Mac's shared pool as memory. */
export function poolTitle(p: Pool, isMac: boolean): string {
  if (p.kind === 'separate') return fill(m.poolCard, { name: p.name || p.id })
  if (p.kind === 'host') return m.poolSystem
  return isMac ? m.poolUnified : m.poolSystem
}

export interface BreakdownRow { key: keyof typeof m.parts, label: string, miB: number }

/** The non-empty parts of a pool, biggest first, as rows. */
export function poolRows(p: Pool): BreakdownRow[] {
  const keys: Array<[keyof typeof m.parts, number]> = [
    ['weights', p.weightsMiB], ['kv', p.kvMiB], ['state', p.stateMiB], ['compute', p.computeMiB],
    ['mmproj', p.mmprojMiB], ['draft', p.draftMiB], ['fixed', p.fixedMiB],
  ]
  return keys.filter(([, v]) => v > 0.5).map(([key, miB]) => ({ key, label: m.parts[key], miB })).sort((a, b) => b.miB - a.miB)
}

/** The pool that decides the tier (worst tier, then highest share of its budget). */
export const mainPool = (est: MemoryEstimate | null): Pool | null => (est ? decidingPool(est) : null)

/** One-line summary of the deciding pool: how much is needed, how much is there, how much of it that is. */
export function summaryText(est: MemoryEstimate, isMac: boolean): string {
  const p = mainPool(est)
  if (!p) return ''
  const vars = { estimate: gib(p.totalMiB), available: gib(p.budgetMiB), percent: p.ratio === null ? '?' : Math.round(p.ratio * 100), noun: memoryNoun(p.kind === 'separate' ? p.id : SYSTEM_POOL, isMac) }
  return fill(p.budgetMiB === null ? m.summaryUnknown : m.summary, vars)
}

/** Share of the budget the bar fills (0..100); an unknown budget shows an empty bar. */
export function barPercent(p: Pool | null): number {
  if (!p) return 0
  // A budget of nothing with something to hold is full (the ratio is not a number then).
  if (p.ratio === null) return p.budgetMiB === 0 && p.totalMiB > 0 ? 100 : 0
  return Math.min(100, Math.round(p.ratio * 100))
}

/** Chinese text of one finding of the check. */
export function issueText(i: CheckIssue, isMac: boolean): string {
  const base = t.models.check.issues as Record<string, string>
  const mac = t.platform.mac.issues as Record<string, string>
  return fill((isMac ? mac[i.code] : undefined) ?? base[i.code] ?? i.code, i.detail ?? {})
}

/** Notes about what the estimate could not model; the ones about a card's memory are left out where there is none. */
export function noteTexts(est: MemoryEstimate, isMac: boolean): string[] {
  const texts = m.notes as Record<string, string>
  const gpuOnly = new Set(['unverified-separate-memory', 'unverified-multi-device', 'split-mode-unmodelled'])
  return est.notes.filter(n => !(isMac && gpuOnly.has(n))).map(n => texts[n] ?? n)
}

/** Whether saving should stop to ask: the estimate says risky or does not fit (decision 43; unknown asks nothing). */
export const saveNeedsConfirm = (c: Pick<CheckDoc, 'tier' | 'estimate'> | null): boolean => !!c?.estimate && (c.tier === 'risky' || c.tier === 'nofit')

/** A manual start the server did not allow (HTTP 409, see server/service/admission.ts). */
export interface StartGuard {
  reason: 'limit' | 'nofit' | 'risky' | 'unknown'
  limit: number | null
  estimateMiB: number | null
  availableMiB: number | null
  pool: string | null
}

/** Read the refusal of a start out of a failed request; null when the error is something else. */
export function readStartGuard(error: unknown): StartGuard | null {
  const e = error as { statusCode?: number, status?: number, data?: { statusCode?: number, data?: Record<string, unknown> } }
  const status = e?.statusCode ?? e?.status ?? e?.data?.statusCode
  const d = e?.data?.data
  if (status !== 409 || !d || typeof d.reason !== 'string' || !['limit', 'nofit', 'risky', 'unknown'].includes(d.reason)) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    reason: d.reason as StartGuard['reason'],
    limit: n(d.limit), estimateMiB: n(d.estimateMiB), availableMiB: n(d.availableMiB), pool: typeof d.pool === 'string' ? d.pool : null,
  }
}

export interface GuardView { title: string, body: string, detail: string | null, confirm: boolean, stopOthers: boolean }

/** What the guard dialog says and offers: risky / unknown can be confirmed, nofit / limit only stop the others first. */
export function guardView(g: StartGuard, name: string, isMac: boolean): GuardView {
  const s = t.models.guard
  const noun = memoryNoun(g.pool, isMac)
  const vars = { name, limit: g.limit ?? '', noun, estimate: gib(g.estimateMiB), available: gib(g.availableMiB) }
  const detail = g.estimateMiB !== null ? fill(s.numbers, vars) : null
  return {
    title: fill(s.title[g.reason], vars),
    body: fill(s.body[g.reason], vars),
    detail,
    confirm: g.reason === 'risky' || g.reason === 'unknown',
    stopOthers: g.reason === 'nofit' || g.reason === 'limit',
  }
}

/** The save-time confirm: what it says for a risky / not fitting estimate. */
export function saveRiskView(est: MemoryEstimate, tier: Tier, isMac: boolean): { title: string, body: string, summary: string } {
  const s = t.models.edit.risk
  const p = mainPool(est)
  const noun = memoryNoun(p ? (p.kind === 'separate' ? p.id : SYSTEM_POOL) : null, isMac)
  return { title: tier === 'nofit' ? s.titleNofit : s.titleRisky, body: fill(tier === 'nofit' ? s.bodyNofit : s.bodyRisky, { noun }), summary: summaryText(est, isMac) }
}

/** States in which an instance holds memory and answers (or soon will). */
export const ONLINE_STATES = ['loading', 'ready', 'draining']

/** Signature of what is online: when it changes the free memory did too. */
export function onlineSignature(state: StateDoc | null): string {
  return (state?.models ?? []).flatMap(x => x.instances.filter(i => ONLINE_STATES.includes(i.state)).map(i => `${x.id}:${i.profile}:${i.state}`)).sort().join('|')
}

/** Name of a memory pool in an event: a card keeps its id, the system pool is named for the platform. */
export function poolText(pool: string, isMac: boolean): string {
  return pool === SYSTEM_POOL || pool === 'host' ? (isMac ? t.platform.mac.poolSystem : m.poolSystem) : pool
}

/** Reason of a refused load in an event; a Mac never reads video memory. */
export function noRoomReasonTemplate(reason: keyof typeof t.events.noRoomReason, isMac: boolean): string {
  return isMac && reason === 'unknown' ? t.platform.mac.noRoomUnknown : t.events.noRoomReason[reason]
}

/** Names of the online models that draw memory from one card (`CUDA<index>`), by what their check says. */
export function modelsOnCard(state: StateDoc | null, estimateOf: (modelId: string, profile: string) => MemoryEstimate | null | undefined, index: number): string[] {
  const names: string[] = []
  for (const x of state?.models ?? []) {
    for (const i of x.instances) {
      if (!ONLINE_STATES.includes(i.state)) continue
      const on = estimateOf(x.id, i.profile)?.pools.some(p => p.kind === 'separate' && p.id === `CUDA${index}`)
      if (on && !names.includes(x.name)) names.push(x.name)
    }
  }
  return names
}
