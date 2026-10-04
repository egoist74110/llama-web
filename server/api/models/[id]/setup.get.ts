// What the first-start dialog offers: the same-directory vision (mmproj) and MTP (draft) files
// found by a fresh scan, the current choices and the recommended MTP multiplier.
import { MTP_DEFAULT_N, sameRef } from '../../../core/models-admin'
import { previewLaunch } from '../../../core/launch'
import { scanModelDirs } from '../../../core/scanner'
import { getContext } from '../../../service/context'
import { requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const ctx = getContext()
  const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
  const profile = model.profiles[model.activeProfile]!
  const preview = previewLaunch({
    dataDir: ctx.dataDir, settings: ctx.getSettings(), model, host: ctx.runner.host,
    target: ctx.runtimeTarget, runtimeEnv: ctx.runtimes.env(), form: { ...profile, chatTemplate: profile.chatTemplate ?? null },
  })
  const main = entries.find(e => sameRef(e.ref, model.file))
  const pick = (refs: Array<{ dirId: string, rel: string }>) => refs.map((ref) => {
    const e = entries.find(x => sameRef(x.ref, ref))
    return { ref, fileName: e?.fileName ?? ref.rel, size: e?.size ?? 0 }
  })
  return {
    name: model.name,
    candidates: { mmproj: pick(main?.candidates.mmproj ?? []), draft: pick((main?.candidates.draft ?? []).filter(ref => entries.some(e => sameRef(e.ref, ref) && e.complete))) },
    current: { mmproj: model.mmproj, draft: model.draft, ctxSize: preview.effective.ctxSize },
    mtpN: MTP_DEFAULT_N,
  }
})
