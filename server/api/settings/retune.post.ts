// Apply the ticked items of the retune preview: { ids: string[] }. Only those global defaults are
// written (atomic save with backup through the settings store); an empty or unknown selection changes nothing.
import { applyRetune } from '../../core/retune'
import { SettingsError } from '../../core/settings-admin'
import { getContext } from '../../service/context'
import { describeSettings, settingsError } from '../../service/settings-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ids: unknown = body?.ids
  const ctx = getContext()
  try {
    if (!Array.isArray(ids) || ids.length > 32 || ids.some(x => typeof x !== 'string')) throw new SettingsError('bad-request')
    const info = await ctx.getSystem()
    let applied = 0
    if (ids.length) ctx.updateSettings((draft) => { applied = applyRetune(draft, info, ctx.platform, ids as string[]) })
    return { applied, settings: describeSettings() }
  } catch (e) {
    settingsError(e)
  }
})
