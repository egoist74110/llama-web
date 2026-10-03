// Command preview for the edit form: { profile, form?, files? }. Built by the same argument
// builder the launcher uses; `form` / `files` are the (possibly unsaved) values on screen.
import type { ModelConfig } from '../../../core/config'
import { t } from '../../../core/i18n'
import { previewLaunch } from '../../../core/launch'
import { listTemplates, ProfileError, sanitizeForm } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { editError, requireModel, requireProfile } from '../../../service/models-api'

const refOrNull = (v: unknown, fallback: ModelConfig['file'] | null) => {
  if (v === undefined) return fallback
  if (v === null) return null
  const r = v as { dirId?: unknown, rel?: unknown }
  if (typeof r.dirId !== 'string' || typeof r.rel !== 'string') throw createError({ statusCode: 400, message: t.models.errors.badRequest })
  return { dirId: r.dirId, rel: r.rel }
}

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown, form?: unknown, files?: Record<string, unknown> }>(event)
  const name = requireProfile(model, body?.profile)
  const saved = model.profiles[name]!
  const ctx = getContext()
  try {
    const form = body?.form === undefined
      ? { overrides: saved.overrides, extraArgs: saved.extraArgs, chatTemplate: saved.chatTemplate ?? null, runtime: saved.runtime ?? null }
      : sanitizeForm(body.form)
    const files = body?.files ?? {}
    const shown: ModelConfig = {
      ...model,
      file: refOrNull(files.file, model.file)!,
      mmproj: refOrNull(files.mmproj, model.mmproj),
      draft: refOrNull(files.draft, model.draft),
    }
    return previewLaunch({
      dataDir: ctx.dataDir, settings: ctx.getSettings(), model: shown, host: ctx.runner.host, target: ctx.runtimeTarget, runtimeEnv: ctx.runtimes.env(),
      form: { ...form, runtime: form.runtime === undefined ? saved.runtime ?? null : form.runtime },
    })
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
})
