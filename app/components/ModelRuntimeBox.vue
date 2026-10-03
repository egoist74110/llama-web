<script setup lang="ts">
// The model's own llama.cpp build and device (a profile's own choice wins over these; empty follows the
// global default). Saved separately from the profile forms. The device choice does not exist on a Mac.
import t from '~~/i18n/zh-CN'

const props = defineProps<{
  modelId: string
  runtime: string | null | undefined
  device: string | null | undefined
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
const device = ref(props.device ?? '')
const saving = ref(false)
watch(() => [props.runtime, props.device], () => {
  runtime.value = props.runtime ?? ''
  device.value = props.device ?? ''
})

onMounted(() => { void load() })
watch([runtime, () => ui.value.hasGpu], () => { if (ui.value.hasGpu) void devices.load(runtime.value) }, { immediate: true })

const runtimeChoices = computed(() => runtimeItems(rows.value, runtime.value, ui.value.isMac, rd.inheritGlobal))
const deviceChoices = computed(() => deviceItems(devices.viewOf(runtime.value), device.value, rd.inheritGlobal))
const deviceNote = computed(() => (devices.failedOf(runtime.value) ? rd.listFailed : devices.viewOf(runtime.value)?.source === 'nvidia-smi' ? rd.listFromSmi : ''))

const runtimeChanged = computed(() => runtime.value !== (props.runtime ?? ''))
const deviceChanged = computed(() => ui.value.hasGpu && device.value !== (props.device ?? ''))
const dirty = computed(() => runtimeChanged.value || deviceChanged.value)

async function save(restart: boolean) {
  if (!dirty.value || saving.value) return
  saving.value = true
  const base = `/api/models/${encodeURIComponent(props.modelId)}`
  try {
    // The restart request rides on the last call so the model is restarted once, with both choices in place.
    if (runtimeChanged.value) await $fetch(`${base}/runtime`, { method: 'POST', body: { runtime: runtime.value || null, restart: restart && !deviceChanged.value } })
    if (deviceChanged.value) await $fetch(`${base}/device`, { method: 'POST', body: { device: device.value || null, restart } })
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
    <div v-if="ui.hasGpu" class="space-y-1.5">
      <label class="text-xs font-medium text-muted">{{ rd.device }}</label>
      <USelect
        :model-value="toSelectValue(device)"
        :items="deviceChoices"
        class="w-full"
        :aria-label="rd.device"
        @update:model-value="(v: unknown) => { device = fromSelectValue(v) }"
      />
      <p v-if="deviceNote" class="m-0 text-xs text-warning">
        {{ deviceNote }}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty" :loading="saving" @click="save(false)">
        {{ rd.save }}
      </UButton>
      <UButton v-if="running" size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-cw" :disabled="!dirty" :loading="saving" @click="save(true)">
        {{ rd.saveRestart }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.models.edit.form.dirty }}</span>
    </div>
  </div>
</template>
