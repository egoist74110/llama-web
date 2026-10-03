// What the first-start dialog offers: the same-directory vision (mmproj) and MTP (draft) files
// found by a fresh scan, the current choices and the recommended MTP multiplier.
import { MTP_DEFAULT_N, sameRef } from '../../../core/models-admin'
import { scanModelDirs } from '../../../core/scanner'
import { getContext } from '../../../service/context'
import { requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const { entries } = await scanModelDirs(getContext().getSettings().modelDirs)
  const main = entries.find(e => sameRef(e.ref, model.file))
  const pick = (refs: Array<{ dirId: string, rel: string }>) => refs.map((ref) => {
    const e = entries.find(x => sameRef(x.ref, ref))
    return { ref, fileName: e?.fileName ?? ref.rel, size: e?.size ?? 0 }
  })
  return {
    name: model.name,
    candidates: { mmproj: pick(main?.candidates.mmproj ?? []), draft: pick(main?.candidates.draft ?? []) },
    current: { mmproj: model.mmproj, draft: model.draft },
    mtpN: MTP_DEFAULT_N,
  }
})
