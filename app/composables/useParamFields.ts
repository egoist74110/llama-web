// Presentation of the launch-parameter form. Keys and flags live in server/core/args.ts
// (PARAM_DEFS); labels and explanations are in i18n (models.edit.params). This file only says
// which control each one uses. The command itself is always built by the server.
import type { ParamKey } from '~~/server/core/args'

export interface ParamField {
  key: ParamKey
  kind: 'number' | 'select'
  options?: string[]
}

const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl']

export const PARAM_FIELDS: ParamField[] = [
  { key: 'ctxSize', kind: 'number' },
  { key: 'cacheTypeK', kind: 'select', options: CACHE_TYPES },
  { key: 'cacheTypeV', kind: 'select', options: CACHE_TYPES },
  { key: 'flashAttn', kind: 'select', options: ['on', 'off', 'auto'] },
  { key: 'gpuLayers', kind: 'number' },
  { key: 'batchSize', kind: 'number' },
  { key: 'ubatchSize', kind: 'number' },
  { key: 'parallel', kind: 'number' },
  { key: 'reasoning', kind: 'select', options: ['on', 'off', 'auto'] },
  { key: 'reasoningFormat', kind: 'select', options: ['auto', 'none', 'deepseek', 'deepseek-legacy'] },
  { key: 'reasoningBudget', kind: 'number' },
]
