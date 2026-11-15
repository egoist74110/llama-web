<script setup lang="ts">
// Change log of the selected knowledge base, newest first. Writes by external agents are not pushed, so there is a
// refresh button; older rows load by `before=<last id>`.
import { t } from '../composables/useLocale'
import type { KbView } from '~~/server/core/kb/manager'
import type { ChangeRow } from '~~/server/core/kb/kb-db'
import { actorLabel } from '~/utils/kb'

const props = defineProps<{ kb: KbView }>()
const emit = defineEmits<{ changed: [] }>()

const s = t.kb.page.changes
const LIMIT = 100
const toast = useToast()

const rows = ref<ChangeRow[] | null>(null)
const more = ref(false)
const refreshing = ref(false)
const loadingMore = ref(false)

let seq = 0
async function load(reset = true) {
  const my = ++seq
  if (reset) refreshing.value = true
  else loadingMore.value = true
  try {
    const before = reset ? undefined : rows.value?.at(-1)?.id
    const r = await $fetch<{ changes: ChangeRow[] }>(`/api/kb/${encodeURIComponent(props.kb.id)}/changes`, { query: { limit: LIMIT, before } })
    if (my !== seq) return
    rows.value = reset || !rows.value ? r.changes : [...rows.value, ...r.changes]
    more.value = r.changes.length >= LIMIT
  } catch (e) {
    if (my === seq) toast.add({ title: s.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    if (my === seq) { refreshing.value = false; loadingMore.value = false }
  }
}
watch(() => props.kb.id, () => { rows.value = null; more.value = false; void load(true) }, { immediate: true })
defineExpose({ reload: () => load(true) })

/** Entry rows say what was done; for a source delete / restore / purge the object is named in the words. */
function opText(r: ChangeRow): string {
  if (r.kind === 'source' && (r.op === 'delete' || r.op === 'restore' || r.op === 'purge')) return t.kb.page.sourceOps[r.op]
  return t.kb.page.ops[r.op]
}
// An entry that was deleted for good cannot be opened any more.
const openable = (r: ChangeRow) => r.kind === 'entry' && r.op !== 'purge'

const drawerOpen = ref(false)
const drawerId = ref<number | null>(null)
function openEntry(r: ChangeRow) {
  drawerId.value = r.docId
  drawerOpen.value = true
}
function onChanged() {
  void load(true)
  emit('changed')
}
</script>

<template>
  <AppCard :title="fmt(s.titleOf, { name: kb.name })" :hint="s.hint">
    <template #actions>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :aria-label="s.refresh" :title="s.refresh" @click="load(true)" />
    </template>

    <div v-if="!rows" class="flex flex-col gap-2">
      <USkeleton class="h-10 w-full" />
      <USkeleton class="h-10 w-full" />
    </div>
    <p v-else-if="!rows.length" class="m-0 text-sm text-muted">
      {{ s.empty }}
    </p>
    <template v-else>
      <ul class="m-0 flex list-none flex-col divide-y divide-default p-0">
        <li v-for="r in rows" :key="r.id" class="flex min-w-0 flex-col gap-1 py-2.5">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="lw-chip">{{ opText(r) }}</span>
            <span class="lw-chip">{{ s.kind[r.kind] }}</span>
            <span v-if="r.version !== null" class="lw-num text-xs text-dimmed">{{ fmt(t.kb.page.entries.version, { n: r.version }) }}</span>
            <button v-if="openable(r)" type="button" class="min-w-0 max-w-full cursor-pointer break-words border-0 bg-transparent p-0 text-left text-sm font-medium text-primary hover:underline" :title="s.open" @click="openEntry(r)">
              {{ r.name }}
            </button>
            <span v-else class="min-w-0 break-all text-sm font-medium">{{ r.name }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dimmed">
            <span>{{ formatDateTime(r.at) }}</span>
            <span class="break-words">{{ actorLabel(r.actor, t.kb.page.actor) }}</span>
          </div>
        </li>
      </ul>
      <div v-if="more" class="mt-3">
        <UButton size="xs" color="neutral" variant="outline" :loading="loadingMore" @click="load(false)">
          {{ s.more }}
        </UButton>
      </div>
    </template>

    <KbEntryDrawer v-model:open="drawerOpen" :kb-id="kb.id" :entry-id="drawerId" :tag-options="[]" @changed="onChanged" />
  </AppCard>
</template>
