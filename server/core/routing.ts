// Request routing (plan「核心行为规则 · 请求路由」): resolve the `model` field of a request to a
// target (model + profile), list client-visible model names, and detect images in a body.
import { DEFAULT_PROFILE, type ModelConfig, type ModelsDoc, type Profile } from './config'
import type { ModelSnapshot, Target } from './scheduler'

export type RouteError =
  | { code: 'model-not-found', name: string }
  | { code: 'profile-not-found', model: string, profile: string }
  | { code: 'no-model' }

export type RouteResult =
  | { ok: true, target: Target, model: ModelConfig, profile: Profile }
  | ({ ok: false } & RouteError)

/** Find a model by client name, then by id, then by case-insensitive name. */
export function findModel(models: ModelConfig[], name: string): ModelConfig | undefined {
  return models.find(m => m.name === name)
    ?? models.find(m => m.id === name)
    ?? models.find(m => m.name.toLowerCase() === name.toLowerCase())
}

function withProfile(model: ModelConfig, profile: string): RouteResult {
  const p = model.profiles[profile]
  if (!p) return { ok: false, code: 'profile-not-found', model: model.name, profile }
  return { ok: true, target: { modelId: model.id, profile }, model, profile: p }
}

/** The most recently used of these (a never-used one counts as oldest; later in the list wins a tie). */
function latestUsed(list: ModelSnapshot[]): ModelSnapshot | undefined {
  let best: ModelSnapshot | undefined
  for (const s of list) if (!best || (s.lastUsedAt ?? -1) >= (best.lastUsedAt ?? -1)) best = s
  return best
}

/**
 * Resolve a request's `model` field.
 * - `name` → that model's current profile. A whole-string match wins, so names that
 *   contain `:` keep working.
 * - `name:profile` → split at the last `:`.
 * - missing / empty → the running model: with several online (multi-load) the one used most recently, then the one
 *   loaded most recently; ready ones first, then one being loaded.
 */
export function resolveTarget(doc: ModelsDoc, field: unknown, running: ModelSnapshot[] = []): RouteResult {
  if (typeof field !== 'string' || field.trim() === '') {
    const cur = latestUsed(running.filter(s => s.state === 'ready')) ?? running.find(s => s.state === 'loading')
    const model = cur && doc.models.find(m => m.id === cur.modelId)
    if (!cur || !model) return { ok: false, code: 'no-model' }
    return withProfile(model, cur.profile)
  }
  const name = field.trim()
  const whole = findModel(doc.models, name)
  if (whole) return withProfile(whole, whole.activeProfile)
  const i = name.lastIndexOf(':')
  if (i > 0 && i < name.length - 1) {
    const model = findModel(doc.models, name.slice(0, i))
    if (model) return withProfile(model, name.slice(i + 1))
  }
  return { ok: false, code: 'model-not-found', name }
}

/**
 * Names served by GET /v1/models: every base name, then each custom `name:profile`.
 * The built-in default profile stays callable but is omitted from discovery. A combined
 * name equal to an earlier one (a model literally named `x:y`) is left out, since
 * resolveTarget would route it to that earlier model.
 */
export function listModelNames(doc: ModelsDoc): string[] {
  const out = new Set<string>()
  for (const m of doc.models) out.add(m.name)
  for (const m of doc.models) for (const p of Object.keys(m.profiles)) {
    if (p !== DEFAULT_PROFILE) out.add(`${m.name}:${p}`)
  }
  return [...out]
}

/** True when an OpenAI-style body carries image input. */
export function hasImages(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const messages = (body as any).messages
  if (!Array.isArray(messages)) return false
  return messages.some(m => Array.isArray(m?.content)
    && m.content.some((part: any) => part?.type === 'image_url' || part?.type === 'input_image'))
}
