<script setup lang="ts">
// A manual start the server did not simply allow (decisions 41, 42): "risky" / "unknown" can be started anyway after
// reading the numbers; "does not fit" and "limit reached" only offer to stop the other models first (there is no forced
// start). Layout-owned so it outlives the card that asked.
import t from '~~/i18n/zh-CN'
import { guardView } from '~/utils/memory-check'

const s = t.models.guard
const { pending, close } = useStartGuard()
const { state } = useLive()
const { busy, start, retry, stop } = useModelActions()
const toast = useToast()
const ui = usePlatformUi()

// Keep the last content while the leave transition runs.
const shown = ref(pending.value)
watch(pending, (p) => { if (p) shown.value = p })
const open = computed({ get: () => !!pending.value, set: (v) => { if (!v) close() } })
const view = computed(() => (shown.value ? guardView(shown.value.guard, shown.value.name, ui.value.isMac) : null))

// Models other than the one asked for that take memory right now (the states the server counts as online).
const others = computed(() => (state.value?.models ?? [])
  .filter(m => m.id !== shown.value?.modelId && m.instances.some(i => ['loading', 'ready', 'draining', 'unloading'].includes(i.state)))
  .map(m => m.id))
const stopping = computed(() => others.value.some(id => busy.value[`stop:${id}`]))
const starting = computed(() => !!shown.value && !!(busy.value[`start:${shown.value.modelId}`] || busy.value[`retry:${shown.value.modelId}`]))

async function confirm() {
  const p = pending.value
  if (!p) return
  close()
  await (p.action === 'retry' ? retry : start)(p.modelId, p.profile, true)
}

async function stopOthers() {
  const ids = [...others.value]
  close()
  const done = await Promise.all(ids.map(id => stop(id)))
  if (done.every(r => r !== null)) toast.add({ title: s.stopped, color: 'success', icon: 'i-lucide-check' })
}
</script>

<template>
  <UModal v-model:open="open" :title="view?.title ?? ''" :description="view?.body ?? ''">
    <template #close="{ ui: modalUi }">
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" :class="modalUi.close()" :aria-label="s.cancel" />
    </template>
    <template #body>
      <div v-if="view" class="space-y-2">
        <p v-if="view.detail" class="m-0 flex items-start gap-2 text-sm font-medium" :class="shown?.guard.reason === 'nofit' ? 'text-error' : 'text-warning'">
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
          {{ view.detail }}
        </p>
        <p v-if="view.stopOthers && !others.length" class="m-0 text-xs text-muted">{{ s.noOthers }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="close()">{{ s.cancel }}</UButton>
        <UButton v-if="view?.stopOthers" size="sm" color="neutral" variant="outline" icon="i-lucide-square" :disabled="!others.length" :loading="stopping" @click="stopOthers">{{ s.stopOthers }}</UButton>
        <UButton v-if="view?.confirm" size="sm" icon="i-lucide-play" :loading="starting" @click="confirm">{{ s.confirm }}</UButton>
      </div>
    </template>
  </UModal>
</template>
