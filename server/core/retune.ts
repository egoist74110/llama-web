// "Recommend again for this machine" (decision 54, existing installs). Pure module: reuses the
// first-run tiers (`tunedDefaults`) and only ever reports or applies changes to the global
// launch defaults. Per-model / per-profile overrides are never touched. Nothing here writes a
// file; the caller persists the draft it passes in.
import { quoteArg, splitArgs } from './args'
import { hasCpuChannel, tunedDefaults, type Settings, type TuneInput } from './config'

export type RetuneScope = 'defaults' | 'defaultsCpu'
export type RetuneField = 'ctxSize' | 'batchSize' | 'ubatchSize' | 'extraArgs'

export interface RetuneItem {
  /** `<scope>.<field>`; stable, the client sends back the ones it ticked. */
  id: string
  scope: RetuneScope
  field: RetuneField
  from: string | number | null
  to: string | number
}

export interface RetunePlan {
  /** False when the hardware could not be sized (nothing recommended; extra-args cleanup still listed). */
  detected: boolean
  items: RetuneItem[]
}

const NUMERIC: RetuneField[] = ['ctxSize', 'batchSize', 'ubatchSize']
/** Flags old built-in defaults carried that current llama-server enables by default or the app does not use. */
export const LEGACY_FLAGS = ['--jinja', '--props', '--slots', '-cb']

/** The extra arguments without the legacy flags (other tokens kept, re-quoted); null when there is nothing to remove or the text cannot be parsed. */
export function withoutLegacyFlags(extraArgs: string): string | null {
  let tokens: string[]
  try { tokens = splitArgs(extraArgs) } catch { return null }
  const kept = tokens.filter(x => !LEGACY_FLAGS.includes(x))
  return kept.length === tokens.length ? null : kept.map(quoteArg).join(' ')
}

export function planRetune(settings: Settings, info: TuneInput, host: { os: NodeJS.Platform }): RetunePlan {
  const tuned = tunedDefaults(info)
  const scopes: RetuneScope[] = hasCpuChannel(host) ? ['defaults', 'defaultsCpu'] : ['defaults']
  const items: RetuneItem[] = []
  for (const scope of scopes) {
    const current = settings[scope]
    const rec = tuned[scope]
    for (const field of NUMERIC) {
      const to = rec?.[field]
      if (typeof to !== 'number' || current[field] === to) continue
      items.push({ id: `${scope}.${field}`, scope, field, from: current[field] as number | null, to })
    }
    const cleaned = withoutLegacyFlags(current.extraArgs ?? '')
    if (cleaned !== null) items.push({ id: `${scope}.extraArgs`, scope, field: 'extraArgs', from: current.extraArgs, to: cleaned })
  }
  return { detected: !!(tuned.defaults || tuned.defaultsCpu), items }
}

/**
 * Apply the ticked items to the draft. The plan is recomputed here (the hardware may have been
 * detected again since the preview); ids that are no longer in it are ignored. Returns how many
 * items were written.
 */
export function applyRetune(draft: Settings, info: TuneInput, host: { os: NodeJS.Platform }, ids: readonly string[]): number {
  const pick = new Set(ids)
  const chosen = planRetune(draft, info, host).items.filter(i => pick.has(i.id))
  for (const i of chosen) (draft[i.scope] as unknown as Record<string, unknown>)[i.field] = i.to
  if (chosen.length) draft.setup.tuned = true
  return chosen.length
}
