// Profile management for one model. Body: { op, ... }
//   create    { name }                          empty profile
//   duplicate { name, from }                    copy of `from`
//   rename    { from, to }
//   delete    { name }
//   save      { name, form, restart? }          form = { overrides, extraArgs, chatTemplate }
// Names travel in the body (not the URL) because they are free text, often Chinese.
// Setting the current profile is POST /api/models/:id/profile.
import {
  createProfile, deleteProfile, listTemplates, renameProfile, sanitizeForm, saveProfile,
} from '../../../core/models-admin'
import { hasDeviceSelection } from '../../../core/config'
import { scanModelDirs } from '../../../core/scanner'
import { t } from '../../../core/i18n'
import { selectableHere } from '../../../core/runtimes'
import { getContext } from '../../../service/context'
import { assertProfileFree, editError, requireModel, requireProfile, restartIfUp } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<Record<string, unknown>>(event)
  const ctx = getContext()
  const op = body?.op
  // A profile that is up, queued for loading or about to be restarted onto cannot be renamed or
  // removed: instances and queued loads are keyed by its name.
  const busy = (name: string) => assertProfileFree(model.id, name)
  try {
    switch (op) {
      case 'create':
      case 'duplicate': {
        let name = ''
        ctx.updateModels((doc) => {
          name = createProfile(doc, model.id, body.name, op === 'duplicate' ? requireProfile(model, body.from) : undefined)
        })
        return { ok: true, name }
      }
      case 'rename': {
        const from = requireProfile(model, body.from)
        busy(from)
        let to = ''
        ctx.updateModels((doc) => { to = renameProfile(doc, model.id, from, body.to) })
        return { ok: true, name: to }
      }
      case 'delete': {
        const name = requireProfile(model, body.name)
        busy(name)
        ctx.updateModels((doc) => { deleteProfile(doc, model.id, name) })
        return { ok: true }
      }
      case 'save': {
        const name = requireProfile(model, body.name)
        const form = sanitizeForm(body.form)
        const templates = listTemplates(ctx.dataDir)
        const env = ctx.runtimes.env()
        const entries = form.mtp ? (await scanModelDirs(ctx.getSettings().modelDirs)).entries : []
        ctx.updateModels((doc) => { saveProfile(doc, model.id, name, form, templates, r => selectableHere(r, env), () => hasDeviceSelection(ctx.platform), entries) })
        const restarted = body.restart === true && restartIfUp(model.id, name)
        return { ok: true, restarted }
      }
      default:
        throw createError({ statusCode: 400, message: t.models.errors.badRequest })
    }
  } catch (e) {
    editError(e)
  }
})
