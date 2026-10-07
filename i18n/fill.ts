// Complete a locale dictionary from a fallback dictionary (decision 18). Pure module: the result is a
// plain object graph with real arrays, built once when the module loads - not looked up at call time.
//
// - the fallback decides which keys exist; a key the patch invents is dropped (the parity test reports it);
// - a missing, undefined or wrong-typed patch value falls back to the fallback value;
// - arrays are merged entry by index, so a half-translated list keeps Chinese for the entries it does
//   not have yet and keeps the length of the fallback.
import type { Messages } from './messages'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function mergeValue(fallback: unknown, patch: unknown): unknown {
  if (typeof fallback === 'string') return typeof patch === 'string' ? patch : fallback
  if (Array.isArray(fallback)) {
    const items: unknown[] = Array.isArray(patch) ? patch : []
    return fallback.map((item, index) => mergeValue(item, items[index]))
  }
  if (isRecord(fallback)) {
    const source: Record<string, unknown> = isRecord(patch) ? patch : {}
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(fallback)) out[key] = mergeValue(fallback[key], source[key])
    return out
  }
  return fallback
}

/**
 * `fallback` is a complete dictionary, `patch` may cover only part of it. Every object and array of
 * the result is newly built, so a locale never shares a mutable branch with `zh-CN`.
 */
export function deepMergeWithFallback<T>(fallback: T, patch: unknown): T {
  return mergeValue(fallback, patch) as T
}
