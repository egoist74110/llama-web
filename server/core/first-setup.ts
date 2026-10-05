// Synchronous first-start saves. Validate all answers before writing either document;
// if models.json cannot be saved, restore only the global context fields we changed.
import { hasCpuChannel, type ModelsDoc, type Settings } from './config'
import type { ParamValue } from './args'
import { applyFirstSetup, type FirstSetup } from './models-admin'
import type { ScanEntry } from './scanner'
import { thinkingBudget } from './thinking-limit'
import { writePair } from './write-pair'

export interface FirstSetupStore {
  getModels(): ModelsDoc
  updateModels(fn: (draft: ModelsDoc) => void): ModelsDoc
  updateSettings(fn: (draft: Settings) => void): Settings
}

type GlobalKey = 'ctxSize' | 'reasoning' | 'reasoningBudget'

/** The global defaults the answers ask to change (context, thinking switch, thinking limit). */
function globalChanges(input: FirstSetup): Partial<Record<GlobalKey, ParamValue>> {
  const out: Partial<Record<GlobalKey, ParamValue>> = {}
  if (input.setGlobalContext) out.ctxSize = input.ctxSize!
  if (input.setGlobalThinking) out.reasoning = input.thinking ? 'on' : 'off'
  if (input.setGlobalThinkingLimit) out.reasoningBudget = thinkingBudget(input.thinkingLimit!)
  return out
}

export function saveFirstSetup(store: FirstSetupStore, modelId: string, input: FirstSetup, entries: ScanEntry[], host: { os: NodeJS.Platform }) {
  applyFirstSetup(structuredClone(store.getModels()), modelId, input, entries)
  let saved!: ModelsDoc
  const saveModel = () => { saved = store.updateModels(doc => { applyFirstSetup(doc, modelId, input, entries) }) }
  const changes = globalChanges(input)
  const keys = Object.keys(changes) as GlobalKey[]
  if (!keys.length) {
    saveModel()
  } else {
    let previous!: { gpu: Partial<Record<GlobalKey, ParamValue>>, cpu: Partial<Record<GlobalKey, ParamValue>> }
    writePair(
      () => { store.updateSettings(s => {
        previous = { gpu: {}, cpu: {} }
        for (const k of keys) {
          previous.gpu[k] = s.defaults[k]
          previous.cpu[k] = s.defaultsCpu[k]
          s.defaults[k] = changes[k]!
          if (hasCpuChannel(host)) s.defaultsCpu[k] = changes[k]!
        }
      }) },
      saveModel,
      () => { store.updateSettings(s => {
        for (const k of keys) {
          s.defaults[k] = previous.gpu[k]!
          if (hasCpuChannel(host)) s.defaultsCpu[k] = previous.cpu[k]!
        }
      }) },
    )
  }
  return saved.models.find(m => m.id === modelId)!
}
