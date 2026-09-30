// Request preprocessing chain: steps run in order and may rewrite the parsed JSON body in place.
// Options are the global settings with per-profile overrides applied.
import type { ImagePreprocess, Profile, Settings } from '../config'
import { imageStep, type ImageReport } from './image'

export interface PreprocessOptions {
  image: ImagePreprocess
}

export interface PreprocessContext {
  options: PreprocessOptions
}

export interface StepResult<R> {
  changed: boolean
  reports: R[]
}

export interface PreprocessStep<R = unknown> {
  name: string
  run(body: unknown, ctx: PreprocessContext): Promise<StepResult<R>>
}

export interface PreprocessResult {
  changed: boolean
  /** Per-step reports, keyed by step name. */
  reports: { image?: ImageReport[] } & Record<string, unknown[] | undefined>
}

/** Global preprocess settings <- profile overrides. */
export function resolvePreprocessOptions(settings: Settings['preprocess'], profile?: Profile): PreprocessOptions {
  return { image: { ...settings.image, ...(profile?.preprocess?.image ?? {}) } }
}

export const DEFAULT_STEPS: PreprocessStep<any>[] = [imageStep]

export async function runPreprocess(body: unknown, ctx: PreprocessContext, steps: PreprocessStep<any>[] = DEFAULT_STEPS): Promise<PreprocessResult> {
  const result: PreprocessResult = { changed: false, reports: {} }
  for (const step of steps) {
    const r = await step.run(body, ctx)
    if (r.changed) result.changed = true
    if (r.reports.length) result.reports[step.name] = r.reports
  }
  return result
}
