// Enforce "thinking off": when a profile's effective --reasoning is off, a request cannot turn thinking
// back on through `chat_template_kwargs.enable_thinking` (llama-server lets the request win over the flag).
import { groupArgs, mergeParams, splitArgs } from './args'
import { defaultsFor, type ModelConfig, type Settings } from './config'

type ProfileLike = NonNullable<ModelConfig['profiles'][string]>

/** The effective `--reasoning` value of a profile ("on" / "off" / "auto" / null = not passed). */
export function effectiveReasoning(settings: Settings, profile: ProfileLike): string | null {
  const defaults = defaultsFor(settings, { os: process.platform }, 'cuda')
  let value = mergeParams(defaults, profile.overrides).reasoning
  // Extra args replace the form value; later layers win.
  for (const text of [defaults.extraArgs, profile.extraArgs]) {
    if (!text?.trim()) continue
    try {
      for (const g of groupArgs(splitArgs(text))) {
        if (g.canon === '--reasoning') value = g.tokens[1] ?? value
      }
    } catch { /* syntax errors are reported by the launch plan */ }
  }
  return value === null ? null : String(value).trim().toLowerCase()
}

/** Force `enable_thinking` to false in the parsed request body. Returns true when the body changed. */
export function forceThinkingOff(json: any): boolean {
  const kwargs = json?.chat_template_kwargs
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return false
  if (!('enable_thinking' in kwargs) || kwargs.enable_thinking === false) return false
  kwargs.enable_thinking = false
  return true
}
