<script setup lang="ts">
// Global default launch parameters: one value per form field (no inherit here, this is the root).
// Windows keeps two sets, one for GPU builds and one for CPU builds (decision 36); the build a model
// finally uses picks which set applies. A Mac has a single set and no device choice (decision 38).
import t from '~~/i18n/zh-CN'
import type { GpuChoice } from '~~/server/core/gpu-group'
import type { ParamField } from '~/composables/useParamFields'
import { displayThinkingLimit, thinkingBudget, validThinkingLimit } from '~~/server/core/thinking-limit'

type Key = 'defaults' | 'defaultsCpu'
// `limit` is the thinking-limit shortcut (0 = unlimited); it writes `values.reasoningBudget` (-1 = unlimited) when valid.
type FormState = { values: Record<string, string>, gpu: GpuForm, extraArgs: string, limit: string }

const s = t.settings.defaults
const { doc, saving, save } = useSettings()
const ui = usePlatformUi()
const toast = useToast()
const devices = useDevices()
const retuneOpen = ref(false)

const emptyState = (): FormState => ({ values: {}, gpu: emptyGpuForm(), extraArgs: '', limit: '0' })
function from(d: Record<string, unknown>): FormState {
  const values: Record<string, string> = {}
  for (const f of ALL_FIELDS) values[f.key] = d[f.key] === null || d[f.key] === undefined ? '' : String(d[f.key])
  // An explicit "auto" and no choice mean the same at the root.
  const gpu = gpuFormFrom({ ...d, device: typeof d.device === 'string' && d.device !== 'auto' ? d.device : '' } as GpuChoice)
  return { values, gpu, extraArgs: String(d.extraArgs ?? ''), limit: String(displayThinkingLimit(values.reasoningBudget === '' ? null : values.reasoningBudget)) }
}

const which = ref<Key>('defaults')
const states = reactive<Record<Key, FormState>>({ defaults: emptyState(), defaultsCpu: emptyState() })
const initials = reactive<Record<Key, string>>({ defaults: '', defaultsCpu: '' })

function reset(key: Key) {
  Object.assign(states[key], from((doc.value?.[key] ?? {}) as Record<string, unknown>))
  initials[key] = JSON.stringify(states[key])
}
watch(() => JSON.stringify(doc.value?.defaults), () => reset('defaults'), { immediate: true })
watch(() => JSON.stringify(doc.value?.defaultsCpu), () => reset('defaultsCpu'), { immediate: true })

// Only Windows has the second set; the server leaves it out on a Mac.
const tabs = computed<Array<{ value: Key, label: string }>>(() => (ui.value.hasCpuChannel && doc.value?.defaultsCpu
  ? [{ value: 'defaults', label: s.gpuTab }, { value: 'defaultsCpu', label: s.cpuTab }]
  : []))
watch(tabs, (list) => { if (!list.some(x => x.value === which.value)) which.value = 'defaults' })

const state = computed(() => states[which.value])
const dirtyOf = (key: Key) => JSON.stringify(states[key]) !== initials[key]
const dirty = computed(() => dirtyOf(which.value))
const invalidKeys = computed(() => ALL_FIELDS.filter(f => f.kind === 'number' && state.value.values[f.key]!.trim() !== '' && !Number.isFinite(Number(state.value.values[f.key]))).map(f => f.key))

// The device only exists for GPU builds on Windows.
const showDevice = computed(() => ui.value.hasGpu && which.value === 'defaults')
// The platform arrives with the first live snapshot, which can be after this card is mounted.
watch(() => ui.value.hasGpu, (has) => { if (has) void devices.load('') }, { immediate: true })
const gpuInvalid = computed(() => showDevice.value && !ratioValid(state.value.gpu))

const blocks = [
  { id: 'common', fields: COMMON_FIELDS },
  { id: 'more', fields: MORE_FIELDS },
  { id: 'cpu', fields: CPU_FIELDS },
]
const advancedOpen = computed(() => CPU_FIELDS.some(f => state.value.values[f.key] !== ''))
const thinkingEnabled = computed(() => state.value.values.reasoning === 'on')
const limitInvalid = computed(() => state.value.limit === '' || !validThinkingLimit(Number(state.value.limit)))
const limitValue = computed<string>({
  get: () => state.value.limit,
  set: (v) => {
    state.value.limit = String(v)
    if (v !== '' && validThinkingLimit(Number(v))) state.value.values.reasoningBudget = String(thinkingBudget(Number(v)))
  },
})

function selectItems(f: ParamField, current: string) {
  const items = withEmptyOption(s.empty, (f.options ?? []).map(o => ({ label: o, value: o })))
  if (current && !(f.options ?? []).includes(current)) items.push({ label: current, value: current })
  return items
}

function restore() {
  Object.assign(state.value, from((which.value === 'defaults' ? doc.value?.builtinDefaults : doc.value?.builtinDefaultsCpu ?? {}) as Record<string, unknown>))
  toast.add({ title: s.restored, color: 'neutral', icon: 'i-lucide-info' })
}

async function submit() {
  const key = which.value
  const st = states[key]
  const defaults: Record<string, string | number | null> = { extraArgs: st.extraArgs }
  for (const f of ALL_FIELDS) {
    const raw = st.values[f.key]!.trim()
    defaults[f.key] = raw === '' ? null : f.kind === 'number' ? Number(raw) : raw
  }
  if (showDevice.value) Object.assign(defaults, gpuBody(st.gpu))
  await save(key, { [key]: defaults })
}
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div v-if="tabs.length" class="mb-3 flex flex-col gap-1.5">
      <div class="lw-seg self-start" role="tablist" :aria-label="s.tabsLabel">
        <button
          v-for="x in tabs"
          :key="x.value"
          type="button"
          role="tab"
          :aria-selected="which === x.value"
          :class="{ on: which === x.value }"
          @click="which = x.value"
        >
          {{ x.label }}<span v-if="dirtyOf(x.value)" class="text-warning"> *</span>
        </button>
      </div>
      <p class="m-0 text-xs text-muted">
        {{ which === 'defaults' ? s.gpuHint : s.cpuHint }}
      </p>
    </div>

    <div>
      <div v-if="showDevice" class="border-b border-default pb-3">
        <DeviceChoice
          v-model="state.gpu"
          :view="devices.viewOf('')"
          runtime=""
          :inherit-label="null"
          :label="s.device"
          :hint="s.deviceHint"
          id-prefix="defaults"
        />
      </div>

      <template v-for="b in blocks" :key="b.id">
        <div v-if="b.id === 'common'" class="pt-3">
          <h4 class="text-sm font-medium text-highlighted">
            {{ s.commonTitle }}
          </h4>
          <p class="text-xs text-muted">
            {{ s.commonHint }}
          </p>
        </div>
      <component :is="b.id === 'common' ? 'div' : 'details'" :open="b.id === 'cpu' ? advancedOpen || undefined : undefined" :class="b.id === 'common' ? '' : 'border-t border-default'">
          <summary v-if="b.id !== 'common'" class="cursor-pointer select-none py-3 text-sm font-medium text-highlighted">
            {{ b.id === 'cpu' ? s.advanced : s.moreTitle }}
            <span class="block text-xs font-normal text-muted">{{ b.id === 'cpu' ? s.advancedHint : s.moreHint }}</span>
          </summary>
          <div class="divide-y divide-default">
            <div v-for="f in b.fields" :key="f.key" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3" :class="{ 'first:pt-0': b.id === 'common' && !showDevice }">
              <div class="min-w-0 flex-1 basis-56">
                <p class="text-sm text-default">
                  {{ paramText(f.key, ui.isMac).label }}
                </p>
                <p class="text-xs text-muted">
                  {{ paramText(f.key, ui.isMac).hint }}
                </p>
              </div>
              <USelect v-if="f.kind === 'select'" :model-value="toSelectValue(state.values[f.key])" :items="selectItems(f, state.values[f.key]!)" size="sm" class="w-40" :aria-label="paramText(f.key, ui.isMac).label" @update:model-value="(v: unknown) => { state.values[f.key] = fromSelectValue(v) }" />
              <UInput
                v-else
                :model-value="state.values[f.key]"
                :type="f.kind === 'number' ? 'number' : 'text'"
                size="sm"
                class="w-40"
                :placeholder="s.empty"
                :color="invalidKeys.includes(f.key) ? 'error' : undefined"
                :aria-label="paramText(f.key, ui.isMac).label"
                @update:model-value="(v: string | number | undefined) => { state.values[f.key] = v == null ? '' : String(v) }"
              />
              <ThinkingLimit v-if="f.key === 'reasoning'" v-model="limitValue" :enabled="thinkingEnabled" id-prefix="defaults" />
              <p v-if="f.key === 'reasoning' && !thinkingEnabled && limitInvalid" class="w-full text-xs text-error">{{ t.models.thinkingLimit.hiddenInvalid }}</p>
            </div>
          </div>
        </component>
        <p v-if="b.id === 'common'" class="m-0 pb-3 text-xs text-muted">
          {{ s.mtpNote }}
        </p>
      </template>
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
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || !!invalidKeys.length || gpuInvalid || limitInvalid" :loading="saving === which" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" @click="restore">
        {{ s.restore }}
      </UButton>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-cpu" :disabled="dirtyOf('defaults') || dirtyOf('defaultsCpu')" @click="retuneOpen = true">
        {{ s.retune.button }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset(which)">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>
    <SettingsRetuneModal v-model:open="retuneOpen" />
  </AppCard>
</template>
