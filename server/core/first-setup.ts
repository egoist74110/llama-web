// Synchronous first-start saves. Validate all answers before writing either document;
// if models.json cannot be saved, restore only the global context fields we changed.
import { hasCpuChannel, type ModelsDoc, type Settings } from './config'
import type { ParamValue } from './args'
import { applyFirstSetup, type FirstSetup } from './models-admin'
import type { ScanEntry } from './scanner'
import { writePair } from './write-pair'

export interface FirstSetupStore {
  getModels(): ModelsDoc
  updateModels(fn: (draft: ModelsDoc) => void): ModelsDoc
  updateSettings(fn: (draft: Settings) => void): Settings
}

export function saveFirstSetup(store: FirstSetupStore, modelId: string, input: FirstSetup, entries: ScanEntry[], host: { os: NodeJS.Platform }) {
  applyFirstSetup(structuredClone(store.getModels()), modelId, input, entries)
  let saved!: ModelsDoc
  const saveModel = () => { saved = store.updateModels(doc => { applyFirstSetup(doc, modelId, input, entries) }) }
  if (!input.setGlobalContext) {
    saveModel()
  } else {
    let previous!: { gpu: ParamValue, cpu: ParamValue }
    writePair(
      () => { store.updateSettings(s => {
        previous = { gpu: s.defaults.ctxSize, cpu: s.defaultsCpu.ctxSize }
        s.defaults.ctxSize = input.ctxSize!
        if (hasCpuChannel(host)) s.defaultsCpu.ctxSize = input.ctxSize!
      }) },
      saveModel,
      () => { store.updateSettings(s => {
        s.defaults.ctxSize = previous.gpu
        if (hasCpuChannel(host)) s.defaultsCpu.ctxSize = previous.cpu
      }) },
    )
  }
  return saved.models.find(m => m.id === modelId)!
}
