<script setup lang="ts">
// Trash of the selected knowledge base: deleted entries and sources wait here. Restore at once, or delete for good
// (confirmed; an entry takes its whole history with it).
import { t } from '../composables/useLocale'
import type { KbView, TrashItem } from '~~/server/core/kb/manager'

const props = defineProps<{ kb: KbView }>()
const emit = defineEmits<{ changed: [] }>()

const s = t.kb.page.trash
const toast = useToast()

const items = ref<TrashItem[] | null>(null)
const refreshing = ref(false)
const busy = ref<Record<number, boolean>>({})
const base = () => `/api/kb/${encodeURIComponent(props.kb.id)}/trash`

let seq = 0
async function load() {
  const my = ++seq
  refreshing.value = true
  try {
    const r = await $fetch<{ items: TrashItem[] }>(base())
    if (my === seq) items.value = r.items
  } catch (e) {
    if (my === seq) toast.add({ title: s.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    if (my === seq) refreshing.value = false
  }
}
watch(() => props.kb.id, () => { items.value = null; void load() }, { immediate: true })
defineExpose({ reload: load })

async function run(id: number, fn: () => Promise<void>) {
  if (busy.value[id]) return
  busy.value = { ...busy.value, [id]: true }
  try {
    await fn()
  } finally {
    const { [id]: _done, ...rest } = busy.value
    busy.value = rest
  }
}

const restore = (it: TrashItem) => run(it.id, async () => {
  try {
    await $fetch(`${base()}/${it.id}/restore`, { method: 'POST' })
    toast.add({ title: fmt(s.restored, { name: it.name }), color: 'success', icon: 'i-lucide-check' })
    await load()
    emit('changed')
  } catch (e) {
    toast.add({ title: s.restoreFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  }
})

const purging = ref<TrashItem | null>(null)
const purgeOpen = computed({ get: () => purging.value !== null, set: (v: boolean) => { if (!v) purging.value = null } })
const purgeBusy = computed(() => !!purging.value && !!busy.value[purging.value.id])
const purge = () => {
  const it = purging.value
  if (!it) return Promise.resolve()
  return run(it.id, async () => {
    try {
      await $fetch(`${base()}/${it.id}`, { method: 'DELETE' })
      toast.add({ title: fmt(s.purged, { name: it.name }), color: 'success', icon: 'i-lucide-check' })
      purging.value = null
      await load()
      emit('changed')
    } catch (e) {
      toast.add({ title: s.purgeFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    }
  })
}
</script>

<template>
  <AppCard :title="fmt(s.titleOf, { name: kb.name })" :hint="s.intro">
    <template #actions>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :aria-label="s.refresh" :title="s.refresh" @click="load" />
    </template>

    <div v-if="!items" class="flex flex-col gap-2">
      <USkeleton class="h-12 w-full" />
      <USkeleton class="h-12 w-full" />
    </div>
    <p v-else-if="!items.length" class="m-0 text-sm text-muted">
      {{ s.empty }}
    </p>
    <ul v-else class="m-0 flex list-none flex-col divide-y divide-default p-0">
      <li v-for="it in items" :key="it.id" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
        <div class="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="lw-chip" :class="{ 'lw-chip-accent': it.kind === 'entry' }">{{ s.kind[it.kind] }}</span>
            <span class="min-w-0 break-all text-sm font-medium">{{ it.name }}</span>
          </span>
          <span class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dimmed">
            <span>{{ fmt(s.deletedAt, { time: formatDateTime(it.deletedAt) }) }}</span>
            <span v-if="it.kind === 'source'" class="lw-num">{{ formatBytes(it.size) }}</span>
            <span v-if="it.version !== null" class="lw-num">{{ fmt(s.version, { n: it.version }) }}</span>
          </span>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-1">
          <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-undo-2" :loading="!!busy[it.id] && !purging" @click="restore(it)">
            {{ s.restore }}
          </UButton>
          <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :disabled="!!busy[it.id]" @click="purging = it">
            {{ s.purge }}
          </UButton>
        </div>
      </li>
    </ul>

    <KbConfirm
      v-model:open="purgeOpen"
      :title="fmt(s.purgeTitle, { name: purging?.name ?? '' })"
      :body="s.purgeBody"
      :confirm-label="s.purgeConfirm"
      :cancel-label="t.kb.page.remove.cancel"
      :busy="purgeBusy"
      @confirm="purge"
    />
  </AppCard>
</template>
