<script setup lang="ts">
// Daily checks always run; automatic runtime installation is opt-in.
import { t } from '../composables/useLocale'
import type { LlamacppDoc } from '~~/server/core/updater'

const s = t.llamacpp.update
const emit = defineEmits<{ changed: [] }>()
const { state } = useLive()
const toast = useToast()
const doc = ref<LlamacppDoc | null>(null)
const busy = ref(false)
const check = computed(() => doc.value?.check)
const working = computed(() => state.value?.llamacpp.runtime.state === 'working' || state.value?.llamacpp.secondary?.runtime.state === 'working')
const installed = computed(() => {
  const c = check.value
  return c?.state === 'checked' && doc.value?.versions.some(v => v.tag === c.tag)
})

async function load() {
  try { doc.value = await $fetch<LlamacppDoc>('/api/llamacpp') } catch { /* Actions report errors. */ }
}
onMounted(load)
watch(() => state.value?.llamacpp.runtime, load)
watch(() => state.value?.llamacpp.secondary, load)

async function act(action: 'check' | 'prefs' | 'download', autoUpdate?: boolean) {
  if (busy.value || (action !== 'prefs' && working.value)) return
  busy.value = true
  try {
    if (action === 'prefs') {
      await $fetch('/api/settings', { method: 'POST', body: { llamacpp: { autoUpdate } } })
    } else {
      await $fetch(`/api/llamacpp/${action}`, { method: 'POST', body: {} })
    }
    await load()
    emit('changed')
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: s.failed, description: err.data?.message ?? err.message, color: 'error' })
  } finally { busy.value = false }
}
</script>

<template>
  <div v-if="doc" class="mb-4 space-y-2 border-b border-default pb-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <USwitch :model-value="doc.autoUpdate" :disabled="busy" :aria-label="s.autoUpdate" @update:model-value="act('prefs', $event)" />
        <span class="text-sm text-default">{{ s.autoUpdate }}</span>
      </div>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="busy" :disabled="working" @click="act('check')">
        {{ s.check }}
      </UButton>
    </div>
    <p class="text-xs text-muted">{{ s.hint }}</p>
    <div v-if="check?.state === 'checked'" class="flex flex-wrap items-center gap-2 text-sm">
      <span>{{ fmt(check.available ? s.available : s.latest, { tag: check.tag }) }}</span>
      <ULink :to="check.url" target="_blank" class="text-xs text-primary">{{ s.release }}</ULink>
      <UButton v-if="check.available && !installed" size="xs" :disabled="busy || working" icon="i-lucide-download" @click="act('download')">{{ s.download }}</UButton>
      <span v-else-if="check.available" class="text-xs text-muted">{{ s.installed }}</span>
    </div>
    <UButton v-else-if="!doc.versions.length && check?.state !== 'checking'" size="xs" :disabled="busy || working" icon="i-lucide-download" @click="act('download')">{{ s.download }}</UButton>
    <p v-if="check?.state === 'error'" class="text-xs text-error">{{ fmt(s.error, { reason: appUpdateErrorText(check.code) }) }}</p>
  </div>
</template>
