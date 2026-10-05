<script setup lang="ts">
// One profile: chat template, launch parameters (inherit / custom / omit), extra args, and the
// command preview built by the backend from the values currently on screen.
import t from '~~/i18n/zh-CN'
import type { LaunchDefaults, ParamKey, ParamOverrides } from '~~/server/core/args'
import type { Profile } from '~~/server/core/config'
import type { LaunchPreview } from '~~/server/core/launch'
import type { ParamField } from '~/composables/useParamFields'
import { MTP_DEFAULT_N, mtpValid, readMtp, type MtpInput } from '~~/server/core/mtp'
import type { FileRef } from '~~/server/core/types'
import { displayThinkingLimit, thinkingBudget, validThinkingLimit } from '~~/server/core/thinking-limit'
import { saveNeedsConfirm, type CheckDoc } from '~/utils/memory-check'

type Mode = 'inherit' | 'custom' | 'omit'
interface Row { mode: Mode, value: string }
type FormState = { rows: Record<ParamKey, Row>, extraArgs: string, chatTemplate: string, runtime: string, gpu: GpuForm, mtp: MtpInput, thinkingLimit: string | number }

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
  /** The model's own build / device choice (this profile's choice wins over it; empty = follow the global one). */
  modelRuntime?: string
  modelDevice?: string
  draft: FileRef | null
  mtpCandidates: Array<{ ref: FileRef, fileName: string, size: number }>
}>()
const emit = defineEmits<{ save: [form: object, restart: boolean], dirty: [boolean] }>()

const edit = t.models.edit
const rd = edit.rd
const ui = usePlatformUi()
const { doc: runtimeDoc, rows: runtimeRows, load: loadRuntimes } = useRuntimeDoc()
const devices = useDevices()

function fromProfile(p: Profile): FormState {
  const rows = {} as Record<ParamKey, Row>
  for (const f of ALL_FIELDS) {
    const v = (p.overrides as Record<string, unknown>)[f.key]
    rows[f.key] = v === undefined ? { mode: 'inherit', value: '' }
      : v === null || v === '' ? { mode: 'omit', value: '' }
        : { mode: 'custom', value: String(v) }
  }
  return { rows, extraArgs: p.extraArgs ?? '', chatTemplate: p.chatTemplate ?? '', runtime: p.runtime ?? '', gpu: gpuFormFrom(p), mtp: readMtp(p.extraArgs ?? '', props.draft), thinkingLimit: displayThinkingLimit(p.overrides.reasoningBudget) }
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
// A shared draft save updates untouched MTP controls without discarding other unsaved edits.
watch(() => JSON.stringify(props.draft), () => {
  const baseline = JSON.parse(initial.value) as FormState
  if (JSON.stringify(state.mtp) === JSON.stringify(baseline.mtp)) {
    state.mtp = readMtp(props.profile.extraArgs ?? '', props.draft)
    baseline.mtp = state.mtp
    initial.value = JSON.stringify(baseline)
  }
})
const mtpDirty = computed(() => JSON.stringify(state.mtp) !== JSON.stringify((JSON.parse(initial.value) as FormState).mtp))
const mtpAnswer = computed<MtpInput>(() => ({ ...state.mtp, n: state.mtp.enabled ? state.mtp.n : MTP_DEFAULT_N, draft: state.mtp.enabled && state.mtp.mode === 'file' ? state.mtp.draft : null }))
const mtpInvalid = computed(() => mtpDirty.value && (!mtpValid(mtpAnswer.value) || (state.mtp.enabled && state.mtp.mode === 'file'
  && !props.mtpCandidates.some(c => c.ref.dirId === state.mtp.draft?.dirId && c.ref.rel === state.mtp.draft?.rel))))

const dirty = computed(() => JSON.stringify(state) !== initial.value)
const thinkingEnabled = computed(() => (state.rows.reasoning.mode === 'custom' ? state.rows.reasoning.value
  : state.rows.reasoning.mode === 'inherit' ? props.defaults.reasoning : null) === 'on')
const budgetDirty = computed(() => JSON.stringify(state.rows.reasoningBudget) !== JSON.stringify((JSON.parse(initial.value) as FormState).rows.reasoningBudget)
  || state.thinkingLimit !== (JSON.parse(initial.value) as FormState).thinkingLimit)
const limitValue = computed<string | number>({
  get: () => state.rows.reasoningBudget.mode === 'custom' ? state.thinkingLimit
    : displayThinkingLimit(state.rows.reasoningBudget.mode === 'inherit' ? props.defaults.reasoningBudget : null),
  set: (v) => {
    state.thinkingLimit = v
    state.rows.reasoningBudget.value = v !== '' && validThinkingLimit(Number(v)) ? String(thinkingBudget(Number(v))) : String(v)
  },
})
const limitInvalid = computed(() => budgetDirty.value && state.rows.reasoningBudget.mode === 'custom'
  && (limitValue.value === '' || !validThinkingLimit(Number(limitValue.value))))
const legacyBudgetZero = computed(() => (state.rows.reasoningBudget.mode === 'custom' ? state.rows.reasoningBudget.value
  : state.rows.reasoningBudget.mode === 'inherit' ? String(props.defaults.reasoningBudget) : '') === '0')
watch(dirty, d => emit('dirty', d), { immediate: true })
function discard() {
  Object.assign(state, JSON.parse(initial.value) as FormState)
}

function inheritedText(key: ParamKey): string {
  const raw = props.defaults[key]
  const v = key === 'reasoningBudget' && raw != null && raw !== '' ? displayThinkingLimit(raw) : raw
  return v === null || v === undefined || v === '' ? t.models.edit.form.inheritedNone : fmt(t.models.edit.form.inheritedValue, { value: String(v) })
}

function setMode(key: ParamKey, mode: Mode) {
  const row = state.rows[key]
  if (key === 'reasoningBudget' && mode === 'custom' && row.mode !== 'custom') {
    if (!row.value) row.value = String(thinkingBudget(Number(displayThinkingLimit(props.defaults.reasoningBudget))))
    state.thinkingLimit = displayThinkingLimit(row.value)
  }
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

const invalidKeys = computed(() => ALL_FIELDS.filter((f) => {
  const row = state.rows[f.key]
  return f.kind === 'number' && row.mode === 'custom' && row.value.trim() !== '' && !Number.isFinite(Number(row.value))
}).map(f => f.key))
// A ratio that does not match the chosen GPUs cannot be saved.
const gpuInvalid = computed(() => ui.value.hasGpu && !ratioValid(state.gpu))

function toForm() {
  const overrides: Record<string, string | number | null> = {}
  for (const f of ALL_FIELDS) {
    const row = state.rows[f.key]
    if (row.mode === 'inherit') continue
    const raw = row.value.trim()
    // A custom value left empty means there is nothing to pass.
    overrides[f.key] = row.mode === 'omit' || raw === '' ? null : f.kind === 'number' ? Number(raw) : raw
  }
  return {
    overrides: overrides as ParamOverrides,
    extraArgs: state.extraArgs,
    chatTemplate: state.chatTemplate || null,
    runtime: state.runtime || null,
    ...(mtpDirty.value ? { mtp: mtpAnswer.value } : {}),
    ...(budgetDirty.value && state.rows.reasoningBudget.mode === 'custom' && !limitInvalid.value ? { thinkingLimit: Number(limitValue.value) } : {}),
    // A Mac has no device choice: the fields are never sent there.
    ...(ui.value.hasGpu ? gpuBody(state.gpu) : {}),
  }
}

const templateItems = computed(() => {
  const items = withEmptyOption(t.models.edit.form.templateBuiltin, props.templates.map(n => ({ label: n, value: n })))
  if (state.chatTemplate && !props.templates.includes(state.chatTemplate)) {
    items.push({ label: `${state.chatTemplate}${t.models.edit.preview.missing.chatTemplate}`, value: state.chatTemplate })
  }
  return items
})

// ---- Build and device ------------------------------------------------------------------------
onMounted(() => { if (!runtimeDoc.value) void loadRuntimes() })
const rowOf = (ref: string) => runtimeRows.value.find(r => r.ref === ref)
const inheritRuntimeLabel = computed(() => {
  const ref = props.modelRuntime ?? ''
  const label = ref ? (rowOf(ref) ? runtimeRowLabel(rowOf(ref)!, ui.value.isMac) : ref) : (runtimeDoc.value?.current ?? '')
  return label ? fmt(rd.inheritRuntimeOf, { label }) : rd.inherit
})
const runtimeChoices = computed(() => runtimeItems(runtimeRows.value, state.runtime, ui.value.isMac, inheritRuntimeLabel.value))
// The device list belongs to the build that will run: this profile's, else the model's, else the global one.
const effectiveRuntime = computed(() => state.runtime || props.modelRuntime || '')
watch([effectiveRuntime, () => props.active, () => ui.value.hasGpu], () => {
  if (props.active && ui.value.hasGpu) void devices.load(effectiveRuntime.value)
}, { immediate: true })
const deviceNote = computed(() => (devices.failedOf(effectiveRuntime.value) ? rd.listFailed : devices.viewOf(effectiveRuntime.value)?.source === 'nvidia-smi' ? rd.listFromSmi : ''))
const cpuMulti = computed(() => !!devices.viewOf(effectiveRuntime.value)?.cpu.multi)
const advancedOpen = computed(() => cpuMulti.value || CPU_FIELDS.some(f => state.rows[f.key].mode !== 'inherit'))
const moreOpen = computed(() => MORE_FIELDS.some(f => state.rows[f.key].mode !== 'inherit'))
// Page order: the few common settings and MTP first, then chat template and build / device, then the rest.
const blocks = {
  common: { id: 'common', fields: COMMON_FIELDS },
  more: { id: 'more', fields: MORE_FIELDS },
  cpu: { id: 'cpu', fields: CPU_FIELDS },
}
type Step = { id: string, fields: ParamField[] }
// Steps without parameter rows carry an empty field list.
const step = (id: string): Step => ({ id, fields: [] })
const layout: Step[] = [step('common-head'), blocks.common, step('mtp'), step('template'), step('runtime'), blocks.more, blocks.cpu]

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

// ---- Memory estimate and parameter findings (same debounce, same values on screen) ------------
const check = ref<CheckDoc | null>(null)
const checkError = ref('')
const checking = ref(false)
let checkSeq = 0

async function refreshCheck() {
  const mine = ++checkSeq
  checking.value = true
  try {
    const r = await $fetch<CheckDoc>(`/api/models/${encodeURIComponent(props.modelId)}/check`, {
      method: 'POST', body: { profile: props.name, form: toForm(), files: props.files },
    })
    if (mine === checkSeq) { check.value = r; checkError.value = '' }
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    if (mine === checkSeq) { check.value = null; checkError.value = err.data?.message ?? err.message ?? t.memory.failed }
  } finally {
    if (mine === checkSeq) checking.value = false
  }
}

function schedule() {
  clearTimeout(timer)
  if (!props.active || invalidKeys.value.length || gpuInvalid.value || mtpInvalid.value || limitInvalid.value) return
  timer = setTimeout(() => { void refreshPreview(); void refreshCheck() }, 250)
}
watch([() => JSON.stringify(state), () => JSON.stringify(props.files), () => props.active, () => props.templates.join('\n')], schedule, { immediate: true })
onBeforeUnmount(() => { clearTimeout(timer); seq++; checkSeq++ })

// A risky / not fitting estimate asks before the save goes out (never refuses it); the answer is read again right now.
const risk = ref<{ restart: boolean } | null>(null)
const riskOpen = computed({ get: () => !!risk.value, set: (v) => { if (!v) risk.value = null } })
async function trySave(restart: boolean) {
  clearTimeout(timer)
  await refreshCheck()
  if (saveNeedsConfirm(check.value)) risk.value = { restart }
  else emit('save', toForm(), restart)
}
function confirmSave() {
  const r = risk.value
  risk.value = null
  if (r) emit('save', toForm(), r.restart)
}

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
    <template v-for="b in layout" :key="b.id">
      <div v-if="b.id === 'common-head'">
        <h4 class="text-sm font-medium text-highlighted">
          {{ edit.form.commonTitle }}
        </h4>
        <p class="text-xs text-muted">
          {{ edit.form.commonHint }} {{ edit.form.hint }}
        </p>
      </div>
      <div v-else-if="b.id === 'mtp'" class="space-y-2">
        <MtpChoice v-model="state.mtp" :candidates="mtpCandidates" :id-prefix="`profile-${name}`" />
        <p class="m-0 text-xs text-muted">{{ t.models.firstStart.mtp.sharedHint }}</p>
        <p class="m-0 text-xs text-muted">{{ t.models.firstStart.mtp.extraHint }}</p>
      </div>
      <div v-else-if="b.id === 'template'" class="space-y-1.5">
        <h4 class="text-sm font-medium text-highlighted">
          {{ edit.form.template }}
        </h4>
        <USelect
          :model-value="toSelectValue(state.chatTemplate)"
          :items="templateItems"
          class="w-full sm:w-80"
          :aria-label="edit.form.template"
          @update:model-value="(v: unknown) => { state.chatTemplate = fromSelectValue(v) }"
        />
        <p class="text-xs text-muted">
          {{ edit.form.templateHint }}
        </p>
      </div>
      <div v-else-if="b.id === 'runtime'" class="space-y-3">
        <div class="space-y-1.5">
          <h4 class="text-sm font-medium text-highlighted">
            {{ rd.runtime }}
          </h4>
          <USelect
            :model-value="toSelectValue(state.runtime)"
            :items="runtimeChoices"
            class="w-full sm:w-80"
            :aria-label="rd.runtime"
            @update:model-value="(v: unknown) => { state.runtime = fromSelectValue(v) }"
          />
          <p class="text-xs text-muted">
            {{ rd.runtimeHint }}
          </p>
        </div>
        <DeviceChoice
          v-if="ui.hasGpu"
          v-model="state.gpu"
          :view="devices.viewOf(effectiveRuntime)"
          :runtime="effectiveRuntime"
          :inherit-label="rd.inherit"
          :label="rd.device"
          :hint="rd.deviceHint"
          :note="deviceNote"
          id-prefix="profile"
        />
      </div>
      <div v-else>
        <component :is="b.id === 'common' ? 'div' : 'details'" :open="b.id === 'cpu' ? advancedOpen || undefined : b.id === 'more' ? moreOpen || undefined : undefined" :class="b.id === 'common' ? 'mt-1' : 'border-t border-default'">
          <summary v-if="b.id !== 'common'" class="cursor-pointer select-none py-3 text-sm font-medium text-highlighted">
            {{ b.id === 'cpu' ? rd.advanced : edit.form.moreTitle }}
            <span class="block text-xs font-normal text-muted">{{ b.id === 'cpu' ? rd.advancedHint : edit.form.moreHint }}</span>
          </summary>
          <div class="divide-y divide-default">
            <div v-for="f in b.fields" :key="f.key" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div class="min-w-0 flex-1 basis-56">
                <p class="text-sm text-default">
                  {{ paramText(f.key, ui.isMac).label }}
                </p>
                <p class="text-xs text-muted">
                  {{ paramText(f.key, ui.isMac).hint }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <USelect
                  :model-value="state.rows[f.key].mode"
                  :items="modeItems"
                  size="sm"
                  class="w-24"
                  :aria-label="paramText(f.key, ui.isMac).label"
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
                    :type="f.kind === 'number' ? 'number' : 'text'"
                    size="sm"
                    class="w-36"
                    :color="invalidKeys.includes(f.key) ? 'error' : undefined"
                    @update:model-value="(v: string | number | undefined) => { state.rows[f.key].value = v == null ? '' : String(v) }"
                  />
                </template>
                <span v-else-if="state.rows[f.key].mode === 'inherit'" class="w-36 text-xs text-muted">{{ inheritedText(f.key) }}</span>
                <span v-else class="w-36 text-xs text-muted">{{ edit.form.omit }}</span>
              </div>
              <ThinkingLimit v-if="f.key === 'reasoning'" v-model="limitValue" :enabled="thinkingEnabled" :id-prefix="`profile-${name}`"
                :disabled="state.rows.reasoningBudget.mode !== 'custom'" :legacy-disabled="legacyBudgetZero">
                <USelect :model-value="state.rows.reasoningBudget.mode" :items="modeItems" size="sm" class="w-24"
                  :aria-label="t.models.thinkingLimit.source" @update:model-value="(m: string) => setMode('reasoningBudget', m as Mode)" />
                <p v-if="state.rows.reasoningBudget.mode === 'inherit'" class="m-0 text-xs text-muted">{{ inheritedText('reasoningBudget') }}</p>
                <p v-else-if="state.rows.reasoningBudget.mode === 'omit'" class="m-0 text-xs text-muted">{{ edit.form.omit }}</p>
              </ThinkingLimit>
              <p v-if="f.key === 'reasoning' && !thinkingEnabled && limitInvalid" class="w-full text-xs text-error">{{ t.models.thinkingLimit.hiddenInvalid }}</p>
            </div>
          </div>
        </component>
      </div>
    </template>

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

    <MemoryEstimate :check="check" :loading="checking" :error="checkError" />

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
        {{ preview?.shell === 'posix' ? edit.preview.posixHint : edit.preview.hint }}
      </p>
      <p v-if="previewError" class="text-xs text-error">
        {{ previewError }}
      </p>
      <p v-if="preview" class="m-0 text-xs text-muted">
        {{ fmt(rd.runtimeBuild, { label: preview.runtime.label }) }}
        <span v-if="preview.runtime.fallback" class="text-warning">{{ fmt(rd.runtimeFallback, { from: preview.runtime.fallback.from }) }}</span>
        <template v-if="ui.hasGpu"> · {{ deviceUsedText(preview.device) }}</template>
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
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || !!invalidKeys.length || gpuInvalid || mtpInvalid || limitInvalid" :loading="busy" @click="trySave(false)">
        {{ edit.form.save }}
      </UButton>
      <UButton
        v-if="running"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-cw"
        :disabled="!dirty || !!invalidKeys.length || gpuInvalid || mtpInvalid || limitInvalid"
        :loading="busy"
        @click="trySave(true)"
      >
        {{ edit.form.saveRestart }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="discard">
        {{ edit.form.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ edit.form.dirty }}</span>
      <span v-else-if="running" class="text-xs text-muted">{{ edit.form.runningNote }}</span>
    </div>
    <SaveRiskModal v-model:open="riskOpen" :check="check" :restart="risk?.restart ?? false" @confirm="confirmSave" />
  </div>
</template>
