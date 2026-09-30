<script setup lang="ts">
// Global default launch parameters: one value per form field (no inherit here, this is the root).
import t from '~~/i18n/zh-CN'
import type { ParamField } from '~/composables/useParamFields'

const s = t.settings.defaults
const params = t.models.edit.params
const { doc, saving, save } = useSettings()
const toast = useToast()

type FormState = { values: Record<string, string>, extraArgs: string }

function from(d: Record<string, unknown>): FormState {
  const values: Record<string, string> = {}
  for (const f of PARAM_FIELDS) values[f.key] = d[f.key] === null || d[f.key] === undefined ? '' : String(d[f.key])
  return { values, extraArgs: String(d.extraArgs ?? '') }
}

const state = reactive<FormState>({ values: {}, extraArgs: '' })
const initial = ref('')
function reset() {
  Object.assign(state, from((doc.value?.defaults ?? {}) as Record<string, unknown>))
  initial.value = JSON.stringify(state)
}
watch(() => JSON.stringify(doc.value?.defaults), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== initial.value)
const invalidKeys = computed(() => PARAM_FIELDS.filter(f => f.kind === 'number' && state.values[f.key]!.trim() !== '' && !Number.isFinite(Number(state.values[f.key]))).map(f => f.key))

function selectItems(f: ParamField, current: string) {
  const items = [{ label: s.empty, value: '' }, ...(f.options ?? []).map(o => ({ label: o, value: o }))]
  if (current && !(f.options ?? []).includes(current)) items.push({ label: current, value: current })
  return items
}

function restore() {
  Object.assign(state, from((doc.value?.builtinDefaults ?? {}) as Record<string, unknown>))
  toast.add({ title: s.restored, color: 'neutral', icon: 'i-lucide-info' })
}

async function submit() {
  const defaults: Record<string, string | number | null> = { extraArgs: state.extraArgs }
  for (const f of PARAM_FIELDS) {
    const raw = state.values[f.key]!.trim()
    defaults[f.key] = raw === '' ? null : f.kind === 'number' ? Number(raw) : raw
  }
  await save('defaults', { defaults })
}
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="divide-y divide-default">
      <div v-for="f in PARAM_FIELDS" :key="f.key" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ params[f.key].label }}
          </p>
          <p class="text-xs text-muted">
            {{ params[f.key].hint }}
          </p>
        </div>
        <USelect v-if="f.kind === 'select'" v-model="state.values[f.key]" :items="selectItems(f, state.values[f.key]!)" size="sm" class="w-40" :aria-label="params[f.key].label" />
        <UInput
          v-else
          :model-value="state.values[f.key]"
          type="number"
          size="sm"
          class="w-40"
          :placeholder="s.empty"
          :color="invalidKeys.includes(f.key) ? 'error' : undefined"
          :aria-label="params[f.key].label"
          @update:model-value="(v: string | number | undefined) => { state.values[f.key] = v == null ? '' : String(v) }"
        />
      </div>
    </div>
    <div class="mt-2 space-y-1.5 border-t border-default pt-4">
      <h4 class="text-sm font-medium text-highlighted">
        {{ s.extraArgs }}
      </h4>
      <UTextarea v-model="state.extraArgs" :rows="3" autoresize class="w-full" :ui="{ base: 'font-mono text-xs' }" :aria-label="s.extraArgs" />
      <p class="text-xs text-muted">
        {{ s.extraArgsHint }}
      </p>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || !!invalidKeys.length" :loading="saving === 'defaults'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" @click="restore">
        {{ s.restore }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>
  </AppCard>
</template>
