<script setup lang="ts">
// The model's own llama.cpp build and device (a profile's own choice wins over these; empty follows the
// global default). Saved separately from the profile forms. The device choice does not exist on a Mac.
import t from '~~/i18n/zh-CN'
import type { GpuChoice } from '~~/server/core/gpu-group'

const props = defineProps<{
  modelId: string
  runtime: string | null | undefined
  /** The model's stored device fields (device / devices / splitMode / tensorSplit / mainGpu). */
  gpu: GpuChoice
  /** Some profile of this model is running: saving offers a restart. */
  running: boolean
}>()
const emit = defineEmits<{ saved: [] }>()

const rd = t.models.edit.rd
const ui = usePlatformUi()
const toast = useToast()
const devices = useDevices()
const { rows, load } = useRuntimeDoc()

const runtime = ref(props.runtime ?? '')
const gpu = ref(gpuFormFrom(props.gpu))
const saving = ref(false)
const gpuKey = computed(() => JSON.stringify(gpuBody(gpuFormFrom(props.gpu))))
watch(() => [props.runtime, gpuKey.value], () => {
  runtime.value = props.runtime ?? ''
  gpu.value = gpuFormFrom(props.gpu)
})

onMounted(() => { void load() })
watch([runtime, () => ui.value.hasGpu], () => { if (ui.value.hasGpu) void devices.load(runtime.value) }, { immediate: true })

const runtimeChoices = computed(() => runtimeItems(rows.value, runtime.value, ui.value.isMac, rd.inheritGlobal))
const deviceNote = computed(() => (devices.failedOf(runtime.value) ? rd.listFailed : devices.viewOf(runtime.value)?.source === 'nvidia-smi' ? rd.listFromSmi : ''))

const runtimeChanged = computed(() => runtime.value !== (props.runtime ?? ''))
const deviceChanged = computed(() => ui.value.hasGpu && JSON.stringify(gpuBody(gpu.value)) !== gpuKey.value)
const gpuInvalid = computed(() => ui.value.hasGpu && !ratioValid(gpu.value))
const dirty = computed(() => runtimeChanged.value || deviceChanged.value)

async function save(restart: boolean) {
  if (!dirty.value || saving.value) return
  saving.value = true
  const base = `/api/models/${encodeURIComponent(props.modelId)}`
  try {
    // The restart request rides on the last call so the model is restarted once, with both choices in place.
    if (runtimeChanged.value) await $fetch(`${base}/runtime`, { method: 'POST', body: { runtime: runtime.value || null, restart: restart && !deviceChanged.value } })
    if (deviceChanged.value) await $fetch(`${base}/device`, { method: 'POST', body: { ...gpuBody(gpu.value), restart } })
    toast.add({ title: restart ? rd.savedRestarting : rd.saved, color: 'success', icon: 'i-lucide-check' })
    emit('saved')
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.models.toast.editFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-3 rounded-[10px] border border-default px-3.5 py-3">
    <div>
      <h4 class="m-0 text-sm font-medium text-highlighted">
        {{ ui.hasGpu ? rd.modelTitle : rd.modelTitleBuild }}
      </h4>
      <p class="m-0 text-xs text-muted">
        {{ rd.modelHint }}
      </p>
    </div>
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-muted">{{ rd.runtime }}</label>
      <USelect
        :model-value="toSelectValue(runtime)"
        :items="runtimeChoices"
        class="w-full"
        :aria-label="rd.runtime"
        @update:model-value="(v: unknown) => { runtime = fromSelectValue(v) }"
      />
    </div>
    <DeviceChoice
      v-if="ui.hasGpu"
      v-model="gpu"
      :view="devices.viewOf(runtime)"
      :runtime="runtime"
      :inherit-label="rd.inheritGlobal"
      :label="rd.device"
      :hint="rd.deviceHint"
      :note="deviceNote"
      id-prefix="model"
    />
    <div class="flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || gpuInvalid" :loading="saving" @click="save(false)">
        {{ rd.save }}
      </UButton>
      <UButton v-if="running" size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-cw" :disabled="!dirty || gpuInvalid" :loading="saving" @click="save(true)">
        {{ rd.saveRestart }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.models.edit.form.dirty }}</span>
    </div>
  </div>
</template>
