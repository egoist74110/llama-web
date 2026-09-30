// Save one or more sections of the settings: { modelDirs?, defaults?, image?, server?, setupDone? }.
// The whole patch is validated first; nothing is written when any section is invalid.
import { applySettingsPatch } from '../../core/settings-admin'
import { getContext } from '../../service/context'
import { describeSettings, settingsError } from '../../service/settings-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    ctx.updateSettings(draft => applySettingsPatch(draft, body, ctx.getModels()))
  } catch (e) {
    settingsError(e)
  }
  return describeSettings()
})
