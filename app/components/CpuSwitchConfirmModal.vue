<script setup lang="ts">
import { t } from '../composables/useLocale'
import { fmt } from '../composables/useFormat'

const props = defineProps<{
  modelId: string
  profile?: string
  modelName?: string
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ switched: [] }>()

const f = t.failure
const toast = useToast()
const { doc, rows, load: loadRuntimes } = useRuntimeDoc()

const busy = ref(false)
const error = ref('')
const needDownload = ref(false)

onMounted(async () => {
  if (!doc.value) await loadRuntimes()
})

const noCpuBuild = computed(() => needDownload.value || (!!doc.value && !rows.value.some(r => r.accel === 'cpu' && r.kind === 'official')))

const title = computed(() => noCpuBuild.value ? f.cpuDownloadFirstTitle : f.cpuSwitchConfirmTitle)
const body = computed(() => noCpuBuild.value
  ? f.cpuDownloadFirstBody
  : fmt(f.cpuSwitchConfirmBody, { name: props.modelName || props.modelId }))
const confirmLabel = computed(() => noCpuBuild.value ? f.cpuDownloadFirstButton : f.cpuSwitchConfirmButton)

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

async function onConfirm() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (noCpuBuild.value) {
      await $fetch('/api/llamacpp/download', { method: 'POST', body: { channel: 'cpu' } })
      toast.add({ title: f.cpuDownloadStarted, color: 'info', icon: 'i-lucide-download' })
      needDownload.value = false
      await loadRuntimes()
      open.value = false
      return
    }
    const res = await $fetch<{ deviceCleared: boolean }>(`/api/models/${encodeURIComponent(props.modelId)}/use-cpu`, {
      method: 'POST',
      body: { profile: props.profile, restart: true },
    })
    toast.add({
      title: f.cpuSwitched,
      description: res.deviceCleared ? f.cpuDeviceCleared : undefined,
      color: 'success',
      icon: 'i-lucide-check',
    })
    open.value = false
    emit('switched')
  } catch (e) {
    const err = e as { data?: { code?: string, data?: { code?: string } }, statusCode?: number }
    if (err?.data?.code === 'no-cpu-build' || err?.data?.data?.code === 'no-cpu-build') needDownload.value = true
    else error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="body">
    <template #body>
      <p v-if="error" class="text-sm text-error" role="alert">
        {{ error }}
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" :disabled="busy" @click="open = false">
          {{ t.common.cancel }}
        </UButton>
        <UButton size="sm" :loading="busy" @click="onConfirm">
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
