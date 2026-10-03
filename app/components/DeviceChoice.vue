<script setup lang="ts">
// One device choice: the single-device select, and below it the "use several GPUs" switch (off by default,
// decision 45). With the switch on the select becomes a GPU checklist (at least one), a split mode, an optional
// ratio and, for row, a main GPU. Row / tensor are experimental: choosing one asks for a confirmation the first
// time for this build + devices + mode, and a combination that failed before is flagged.
// Used by the global defaults, the model box and the profile form; nothing renders on a Mac (callers check hasGpu).
import t from '~~/i18n/zh-CN'
import type { DevicesView } from '~~/server/core/devices'

const form = defineModel<GpuForm>({ required: true })
const props = defineProps<{
  view: DevicesView | null
  /** Build the device list belongs to ('' = the global version); part of the experimental-mode record. */
  runtime: string
  /** Label of the "follow the upper layer" option; null = this is the root (empty means automatic). */
  inheritLabel: string | null
  label: string
  hint: string
  note?: string
  /** Where the control is used, only for the aria labels. */
  idPrefix: string
}>()

const rd = t.models.edit.rd
const g = rd.gpu
const toast = useToast()

const single = computed(() => {
  const items = deviceItems(props.view, form.value.device, props.inheritLabel ?? rd.deviceAuto)
  return props.inheritLabel === null ? items.filter(i => i.value !== 'auto') : items
})
const gpus = computed(() => props.view?.gpus ?? [])
const knownIds = computed(() => new Set(gpus.value.map(x => x.id)))
const listed = computed(() => props.view !== null && props.view.source !== 'unavailable')
const tooFew = computed(() => form.value.multi && listed.value && gpus.value.length < 2)

function setMulti(on: boolean) { form.value = toggleMulti(form.value, on, props.view) }
function setDevice(id: string, on: boolean) {
  if (!on && form.value.devices.length === 1 && form.value.devices[0] === id) {
    toast.add({ title: g.lastOne, color: 'warning', icon: 'i-lucide-info' })
    return
  }
  form.value = toggleDevice(form.value, id, on, props.view)
}

// ---- split mode -------------------------------------------------------------------------------
const MODES = ['layer', 'row', 'tensor'] as const
const supported = computed(() => props.view?.splitModes ?? null)
const modeItems = computed<Array<{ label: string, value: string, disabled: boolean }>>(() => MODES.map((m) => {
  const off = supported.value !== null && !supported.value.includes(m)
  return { label: g.modes[m] + (off ? g.modeUnsupported : ''), value: m, disabled: off }
}))
const mode = computed(() => form.value.splitMode || 'layer')

interface SplitStatus { confirmed: boolean, failed: { at: number, kind: string } | null }
const status = ref<SplitStatus | null>(null)
let statusSeq = 0
const experimental = computed(() => experimentalChosen(form.value))
// Look the combination up whenever it changes (a failed one is flagged, a confirmed one needs nothing).
watch(() => [experimental.value, props.runtime, form.value.devices.join(','), mode.value] as const, async ([exp, runtime, devices, m]) => {
  const mine = ++statusSeq
  status.value = null
  if (!exp) return
  try {
    const r = await $fetch<SplitStatus>('/api/devices/split', { query: { runtime: runtime || undefined, devices, mode: m } })
    if (mine === statusSeq) status.value = r
  } catch { /* unknown: the server warns at launch */ }
}, { immediate: true })

// Confirmation before an experimental mode is kept.
const asking = ref<'row' | 'tensor' | null>(null)
let before = ''
function pickMode(m: string) {
  if (m === form.value.splitMode) return
  if (m === 'row' || m === 'tensor') {
    before = form.value.splitMode
    form.value = { ...form.value, splitMode: m }
    void ask(m)
  } else {
    form.value = { ...form.value, splitMode: m }
  }
}
async function ask(m: 'row' | 'tensor') {
  try {
    const r = await $fetch<SplitStatus>('/api/devices/split', { query: { runtime: props.runtime || undefined, devices: form.value.devices.join(','), mode: m } })
    if (r.confirmed) return
  } catch { /* ask anyway */ }
  asking.value = m
}
async function accept() {
  const m = asking.value
  if (!m) return
  try {
    await $fetch('/api/devices/split', { method: 'POST', body: { runtime: props.runtime || undefined, devices: form.value.devices, mode: m } })
    asking.value = null
    status.value = { confirmed: true, failed: status.value?.failed ?? null }
  } catch {
    toast.add({ title: g.confirmFailed, color: 'error', icon: 'i-lucide-circle-alert' })
    decline()
  }
}
function decline() {
  asking.value = null
  form.value = { ...form.value, splitMode: before }
}
const modalOpen = computed({ get: () => asking.value !== null, set: (v: boolean) => { if (!v && asking.value) decline() } })

// ---- ratio and main GPU -----------------------------------------------------------------------
const ratio = computed(() => ratioHint(form.value, props.view))
const ratioBad = computed(() => !ratioValid(form.value))
const mainItems = computed(() => withEmptyOption(g.mainGpuNone, form.value.devices.map((id, i) => ({ label: `${i} · ${id}`, value: String(i) }))))
</script>

<template>
  <div class="space-y-1.5">
    <h4 class="text-sm font-medium text-highlighted">
      {{ label }}
    </h4>

    <USelect
      v-if="!form.multi"
      :model-value="toSelectValue(form.device)"
      :items="single"
      class="w-full sm:w-80"
      :aria-label="label"
      @update:model-value="(v: unknown) => { form = { ...form, device: fromSelectValue(v) } }"
    />
    <div v-else class="space-y-1 rounded-lg border border-default px-3 py-2">
      <p class="m-0 text-xs font-medium text-muted">
        {{ g.devices }}
      </p>
      <label v-for="d in gpus" :key="d.id" class="flex cursor-pointer items-center gap-2 text-sm text-default">
        <UCheckbox
          :model-value="form.devices.includes(d.id)"
          :aria-label="`${idPrefix} ${d.id}`"
          @update:model-value="(v: boolean | 'indeterminate') => setDevice(d.id, v === true)"
        />
        <span class="min-w-0 break-all">{{ gpuLabel(d) }}</span>
      </label>
      <label v-for="id in form.devices.filter(x => !knownIds.has(x))" :key="id" class="flex cursor-pointer items-center gap-2 text-sm text-warning">
        <UCheckbox :model-value="true" :aria-label="`${idPrefix} ${id}`" @update:model-value="(v: boolean | 'indeterminate') => setDevice(id, v === true)" />
        <span class="break-all">{{ fmt(rd.deviceMissing, { value: id }) }}</span>
      </label>
      <p class="m-0 text-xs text-muted">
        {{ g.devicesHint }}
      </p>
      <p v-if="tooFew" class="m-0 text-xs text-warning">
        {{ fmt(g.multiNeedTwo, { count: gpus.length }) }}
      </p>
    </div>

    <p class="text-xs text-muted">
      {{ hint }}
    </p>
    <p v-if="note" class="text-xs text-warning">
      {{ note }}
    </p>

    <label class="flex cursor-pointer items-center gap-2 pt-1 text-sm text-default">
      <USwitch :model-value="form.multi" :aria-label="`${idPrefix} ${g.multi}`" @update:model-value="(v: boolean) => setMulti(v)" />
      {{ g.multi }}
    </label>
    <p v-if="!form.multi" class="text-xs text-muted">
      {{ g.multiHint }}
    </p>

    <div v-if="form.multi" class="space-y-3 pt-1">
      <div class="space-y-1.5">
        <h5 class="m-0 text-xs font-medium text-muted">
          {{ g.splitMode }}
        </h5>
        <USelect
          :model-value="mode"
          :items="modeItems"
          class="w-full sm:w-80"
          :aria-label="`${idPrefix} ${g.splitMode}`"
          @update:model-value="(v: unknown) => pickMode(String(v))"
        />
        <p class="text-xs text-muted">
          {{ g.modeHint[mode as 'layer' | 'row' | 'tensor'] }}
        </p>
        <p v-if="experimental && status?.failed" class="text-xs text-warning">
          {{ fmt(g.failedBefore, { kind: reasonText(status.failed.kind) }) }}
        </p>
        <p v-else-if="experimental && status?.confirmed" class="text-xs text-muted">
          {{ g.confirmed }}
        </p>
      </div>

      <div class="space-y-1.5">
        <h5 class="m-0 text-xs font-medium text-muted">
          {{ g.tensorSplit }}
        </h5>
        <UInput
          :model-value="form.tensorSplit"
          class="w-full sm:w-80"
          :placeholder="ratio.placeholder"
          :color="ratioBad ? 'error' : undefined"
          :aria-label="`${idPrefix} ${g.tensorSplit}`"
          @update:model-value="(v: string | number | undefined) => { form = { ...form, tensorSplit: v == null ? '' : String(v) } }"
        />
        <p class="text-xs text-muted">
          {{ g.tensorSplitHint }}
          <template v-if="ratio.shares">
            {{ fmt(g.tensorSplitShares, { shares: ratio.shares }) }}
          </template>
        </p>
        <p v-if="ratioBad" class="text-xs text-error">
          {{ g.tensorSplitBad }}
        </p>
      </div>

      <div v-if="mode === 'row'" class="space-y-1.5">
        <h5 class="m-0 text-xs font-medium text-muted">
          {{ g.mainGpu }}
        </h5>
        <USelect
          :model-value="toSelectValue(form.mainGpu)"
          :items="mainItems"
          class="w-full sm:w-80"
          :aria-label="`${idPrefix} ${g.mainGpu}`"
          @update:model-value="(v: unknown) => { form = { ...form, mainGpu: fromSelectValue(v) } }"
        />
        <p class="text-xs text-muted">
          {{ g.mainGpuHint }}
        </p>
      </div>
    </div>

    <UModal v-model:open="modalOpen" :title="fmt(g.confirmTitle, { mode: asking ?? '' })" :description="fmt(g.confirmBody, { mode: asking ?? '' })">
      <template #body>
        <ul class="m-0 list-disc space-y-1 pl-5 text-sm text-default">
          <li v-for="n in g.confirmNotes" :key="n">
            {{ n }}
          </li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="outline" @click="decline">
            {{ g.confirmCancel }}
          </UButton>
          <UButton @click="accept">
            {{ g.confirmOk }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
