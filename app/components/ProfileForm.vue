<script setup lang="ts">
// One profile: chat template, launch parameters (inherit / custom / omit), extra args, and the
// command preview built by the backend from the values currently on screen.
import t from '~~/i18n/zh-CN'
import type { LaunchDefaults, ParamKey, ParamOverrides } from '~~/server/core/args'
import type { Profile } from '~~/server/core/config'
import type { LaunchPreview } from '~~/server/core/launch'
import type { ParamField } from '~/composables/useParamFields'

type Mode = 'inherit' | 'custom' | 'omit'
interface Row { mode: Mode, value: string }
type FormState = { rows: Record<ParamKey, Row>, extraArgs: string, chatTemplate: string }

const props = defineProps<{
  modelId: string
  name: string
  profile: Profile
  defaults: LaunchDefaults
  templates: string[]
  /** This profile is loading / running: saving offers a restart. */
  running: boolean
  /** Only the visible profile talks to the server (previews). */
  active: boolean
  /** Unsaved file choices, so the preview matches what the drawer shows. */
  files: { file: unknown, mmproj: unknown, draft: unknown }
  busy: boolean
}>()
const emit = defineEmits<{ save: [form: object, restart: boolean], dirty: [boolean] }>()

const params = t.models.edit.params
const edit = t.models.edit

function fromProfile(p: Profile): FormState {
  const rows = {} as Record<ParamKey, Row>
  for (const f of PARAM_FIELDS) {
    const v = (p.overrides as Record<string, unknown>)[f.key]
    rows[f.key] = v === undefined ? { mode: 'inherit', value: '' }
      : v === null || v === '' ? { mode: 'omit', value: '' }
        : { mode: 'custom', value: String(v) }
  }
  return { rows, extraArgs: p.extraArgs ?? '', chatTemplate: p.chatTemplate ?? '' }
}

const state = reactive<FormState>(fromProfile(props.profile))
const savedKey = computed(() => JSON.stringify(props.profile))
const initial = ref(JSON.stringify(fromProfile(props.profile)))
// A save (or a hand edit of the file) changed the stored profile: start from it.
watch(savedKey, () => {
  const next = fromProfile(props.profile)
  Object.assign(state, next)
  initial.value = JSON.stringify(next)
})

const dirty = computed(() => JSON.stringify(state) !== initial.value)
watch(dirty, d => emit('dirty', d), { immediate: true })
function discard() {
  Object.assign(state, JSON.parse(initial.value) as FormState)
}

function inheritedText(key: ParamKey): string {
  const v = props.defaults[key]
  return v === null || v === undefined || v === '' ? t.models.edit.form.inheritedNone : fmt(t.models.edit.form.inheritedValue, { value: String(v) })
}

function setMode(key: ParamKey, mode: Mode) {
  const row = state.rows[key]
  // Switching to custom starts from the inherited value, which is what the user just saw.
  if (mode === 'custom' && !row.value) row.value = String(props.defaults[key] ?? '')
  row.mode = mode
}

const modeItems = [
  { label: t.models.edit.form.inherit, value: 'inherit' },
  { label: t.models.edit.form.custom, value: 'custom' },
  { label: t.models.edit.form.omit, value: 'omit' },
]

function selectItems(field: ParamField, current: string) {
  const items = [...(field.options ?? [])]
  if (current && !items.includes(current)) items.unshift(current)
  return items
}

const invalidKeys = computed(() => PARAM_FIELDS.filter((f) => {
  const row = state.rows[f.key]
  return f.kind === 'number' && row.mode === 'custom' && row.value.trim() !== '' && !Number.isFinite(Number(row.value))
}).map(f => f.key))

function toForm() {
  const overrides: Record<string, string | number | null> = {}
  for (const f of PARAM_FIELDS) {
    const row = state.rows[f.key]
    if (row.mode === 'inherit') continue
    const raw = row.value.trim()
    // A custom value left empty means there is nothing to pass.
    overrides[f.key] = row.mode === 'omit' || raw === '' ? null : f.kind === 'number' ? Number(raw) : raw
  }
  return { overrides: overrides as ParamOverrides, extraArgs: state.extraArgs, chatTemplate: state.chatTemplate || null }
}

const templateItems = computed(() => {
  const items = [{ label: t.models.edit.form.templateBuiltin, value: '' }, ...props.templates.map(n => ({ label: n, value: n }))]
  if (state.chatTemplate && !props.templates.includes(state.chatTemplate)) {
    items.push({ label: `${state.chatTemplate}${t.models.edit.preview.missing.chatTemplate}`, value: state.chatTemplate })
  }
  return items
})

// ---- Preview (server-built) ------------------------------------------------------------------
const preview = ref<LaunchPreview | null>(null)
const previewError = ref('')
const previewing = ref(false)
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

async function refreshPreview() {
  const mine = ++seq
  previewing.value = true
  try {
    const r = await $fetch<LaunchPreview>(`/api/models/${encodeURIComponent(props.modelId)}/preview`, {
      method: 'POST', body: { profile: props.name, form: toForm(), files: props.files },
    })
    if (mine === seq) { preview.value = r; previewError.value = '' }
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    if (mine === seq) previewError.value = err.data?.message ?? err.message ?? t.models.edit.preview.failed
  } finally {
    if (mine === seq) previewing.value = false
  }
}

function schedule() {
  clearTimeout(timer)
  if (!props.active || invalidKeys.value.length) return
  timer = setTimeout(refreshPreview, 250)
}
watch([() => JSON.stringify(state), () => JSON.stringify(props.files), () => props.active, () => props.templates.join('\n')], schedule, { immediate: true })
onBeforeUnmount(() => { clearTimeout(timer); seq++ })

const toast = useToast()
async function copy() {
  if (!preview.value) return
  try {
    await navigator.clipboard.writeText(preview.value.command)
    toast.add({ title: t.models.edit.preview.copied, color: 'success', icon: 'i-lucide-check' })
  } catch {
    toast.add({ title: t.models.edit.preview.copyFailed, color: 'error', icon: 'i-lucide-circle-alert' })
  }
}

function warningText(w: LaunchPreview['warnings'][number]): string {
  const template = (t.models.edit.preview.warnings as Record<string, string>)[w.code] ?? w.code
  return fmt(template, {
    flag: w.flag ?? '', detail: w.detail ?? '',
    layer: w.layer ? t.models.edit.preview.layers[w.layer] : '',
  })
}

const globalExtra = computed(() => props.defaults.extraArgs?.trim())
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-1.5">
      <h4 class="text-sm font-medium text-highlighted">
        {{ edit.form.template }}
      </h4>
      <USelect v-model="state.chatTemplate" :items="templateItems" class="w-full sm:w-80" :aria-label="edit.form.template" />
      <p class="text-xs text-muted">
        {{ edit.form.templateHint }}
      </p>
    </div>

    <div>
      <h4 class="text-sm font-medium text-highlighted">
        {{ edit.form.title }}
      </h4>
      <p class="text-xs text-muted">
        {{ edit.form.hint }}
      </p>
      <div class="mt-1 divide-y divide-default">
        <div v-for="f in PARAM_FIELDS" :key="f.key" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div class="min-w-0 flex-1 basis-56">
            <p class="text-sm text-default">
              {{ params[f.key].label }}
            </p>
            <p class="text-xs text-muted">
              {{ params[f.key].hint }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <USelect
              :model-value="state.rows[f.key].mode"
              :items="modeItems"
              size="sm"
              class="w-24"
              :aria-label="params[f.key].label"
              @update:model-value="(m: string) => setMode(f.key, m as Mode)"
            />
            <template v-if="state.rows[f.key].mode === 'custom'">
              <USelect
                v-if="f.kind === 'select'"
                v-model="state.rows[f.key].value"
                :items="selectItems(f, state.rows[f.key].value)"
                size="sm"
                class="w-36"
              />
              <UInput
                v-else
                :model-value="state.rows[f.key].value"
                type="number"
                size="sm"
                class="w-36"
                :color="invalidKeys.includes(f.key) ? 'error' : undefined"
                @update:model-value="(v: string | number | undefined) => { state.rows[f.key].value = v == null ? '' : String(v) }"
              />
            </template>
            <span v-else-if="state.rows[f.key].mode === 'inherit'" class="w-36 text-xs text-muted">{{ inheritedText(f.key) }}</span>
            <span v-else class="w-36 text-xs text-muted">{{ edit.form.omit }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="space-y-1.5">
      <h4 class="text-sm font-medium text-highlighted">
        {{ edit.form.extraArgs }}
      </h4>
      <UTextarea
        v-model="state.extraArgs"
        :rows="3"
        autoresize
        class="w-full"
        :ui="{ base: 'font-mono text-xs' }"
        :placeholder="edit.form.extraArgsPlaceholder"
        :aria-label="edit.form.extraArgs"
      />
      <p class="text-xs text-muted">
        {{ edit.form.extraArgsHint }}
      </p>
      <p v-if="globalExtra" class="break-all text-xs text-dimmed">
        {{ fmt(edit.form.globalExtra, { args: globalExtra }) }}
      </p>
    </div>

    <div class="space-y-1.5">
      <div class="flex items-center justify-between gap-3">
        <h4 class="text-sm font-medium text-highlighted">
          {{ edit.preview.title }}
        </h4>
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-copy" :disabled="!preview || !!invalidKeys.length" @click="copy">
          {{ edit.preview.copy }}
        </UButton>
      </div>
      <pre
        class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-default bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-default"
        :class="previewing ? 'opacity-60' : ''"
      >{{ preview?.command ?? edit.preview.loading }}</pre>
      <p class="text-xs text-muted">
        {{ edit.preview.hint }}
      </p>
      <p v-if="previewError" class="text-xs text-error">
        {{ previewError }}
      </p>
      <ul v-if="preview" class="space-y-0.5 text-xs">
        <li v-if="!preview.ok" class="text-error">
          {{ edit.preview.invalid }}
        </li>
        <li v-for="m in preview.missing" :key="m" class="text-warning">
          {{ edit.preview.missing[m] }}
        </li>
        <li v-for="(w, i) in preview.warnings" :key="i" :class="w.severity === 'error' ? 'text-error' : 'text-warning'">
          {{ warningText(w) }}
        </li>
      </ul>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-t border-default pt-4">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || !!invalidKeys.length" :loading="busy" @click="emit('save', toForm(), false)">
        {{ edit.form.save }}
      </UButton>
      <UButton
        v-if="running"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-cw"
        :disabled="!dirty || !!invalidKeys.length"
        :loading="busy"
        @click="emit('save', toForm(), true)"
      >
        {{ edit.form.saveRestart }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="discard">
        {{ edit.form.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ edit.form.dirty }}</span>
      <span v-else-if="running" class="text-xs text-muted">{{ edit.form.runningNote }}</span>
    </div>
  </div>
</template>
