<script setup lang="ts">
// Entries of the selected knowledge base (decision 69): search, tag filter, paging, open / create in a drawer.
// Nothing here polls: writes from outside (agents) are not pushed, so the refresh button and every tab or
// knowledge base switch fetch again.
import { t } from '../composables/useLocale'
import type { EntryListItem, KbView, TagCount } from '~~/server/core/kb/manager'
import { fromSelectValue, toSelectValue, withEmptyOption } from '~/utils/select-empty'

const props = defineProps<{ kb: KbView }>()
const emit = defineEmits<{ changed: [] }>()

const s = t.kb.page.entries
const d = t.kb.page.docs
const TAGS_SHOWN = 5
const PAGE = 50
const toast = useToast()

const items = ref<EntryListItem[] | null>(null)
const total = ref(0)
const tags = ref<TagCount[]>([])
const q = ref('')
const tag = ref('')
const loadingMore = ref(false)
const refreshing = ref(false)

let seq = 0
async function load(reset = true) {
  const my = ++seq
  const offset = reset ? 0 : (items.value?.length ?? 0)
  if (reset) refreshing.value = true
  else loadingMore.value = true
  try {
    const r = await $fetch<{ total: number, items: EntryListItem[], tags: TagCount[] }>(`/api/kb/${encodeURIComponent(props.kb.id)}/entries`, {
      query: { q: q.value.trim() || undefined, tag: tag.value || undefined, offset, limit: PAGE },
    })
    if (my !== seq) return
    total.value = r.total
    tags.value = r.tags
    if (reset || !items.value) items.value = r.items
    else {
      const have = new Set(items.value.map(x => x.id))
      items.value = [...items.value, ...r.items.filter(x => !have.has(x.id))]
    }
  } catch (e) {
    if (my === seq) toast.add({ title: s.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    if (my === seq) { refreshing.value = false; loadingMore.value = false }
  }
}
defineExpose({ reload: () => load(true) })

watch(() => props.kb.id, () => {
  q.value = ''
  tag.value = ''
  items.value = null
  tags.value = []
  void load(true)
}, { immediate: true })

// Typing waits 300 ms; Enter and the tag filter go at once.
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(() => { void load(true) }, 300)
})
onBeforeUnmount(() => clearTimeout(timer))
function searchNow() {
  clearTimeout(timer)
  void load(true)
}
const tagItems = computed(() => withEmptyOption(s.allTags, tags.value.map(x => ({ label: `${x.tag} (${x.count})`, value: x.tag }))))
function onTag(v: unknown) {
  tag.value = fromSelectValue(v)
  void load(true)
}
const filtered = computed(() => !!q.value.trim() || !!tag.value)

// ---- drawer ----
const drawerOpen = ref(false)
const drawerId = ref<number | null>(null)
function openEntry(id: number) { drawerId.value = id; drawerOpen.value = true }
function openNew() { drawerId.value = null; drawerOpen.value = true }
function onChanged() {
  void load(true)
  emit('changed')
}

const statusCls = (st: string) => ({ 'indexing': 'lw-st-loading', 'ready': 'lw-st-ready', 'failed': 'lw-st-failed', 'keyword-only': 'lw-st-stopped' }[st] ?? 'lw-st-stopped')
const statusText = (st: string) => (d.status as Record<string, string>)[st] ?? st
</script>

<template>
  <AppCard :title="fmt(s.titleOf, { name: kb.name })" :hint="s.hint">
    <div class="flex flex-wrap items-center gap-2">
      <UInput v-model="q" class="min-w-0 flex-1 basis-48" size="sm" icon="i-lucide-search" autocomplete="off" :placeholder="s.search" :aria-label="s.search" @keydown.enter="searchNow" />
      <USelect v-if="tags.length || tag" :model-value="toSelectValue(tag)" :items="tagItems" size="sm" class="min-w-0 basis-40" :aria-label="s.tagFilter" @update:model-value="onTag" />
      <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :aria-label="s.refresh" :title="s.refresh" @click="load(true)" />
      <UButton size="sm" icon="i-lucide-plus" @click="openNew">
        {{ s.create }}
      </UButton>
    </div>

    <div class="mt-4">
      <div v-if="!items" class="flex flex-col gap-2">
        <USkeleton class="h-16 w-full" />
        <USkeleton class="h-16 w-full" />
      </div>
      <div v-else-if="!items.length" class="flex flex-col items-start gap-3">
        <p class="m-0 text-sm text-muted">
          {{ filtered ? s.noMatch : s.empty }}
        </p>
        <UButton v-if="!filtered" size="sm" color="neutral" variant="outline" icon="i-lucide-plus" @click="openNew">
          {{ s.create }}
        </UButton>
      </div>
      <template v-else>
        <ul class="m-0 flex list-none flex-col divide-y divide-default p-0">
          <li v-for="it in items" :key="it.id">
            <button type="button" class="flex w-full min-w-0 cursor-pointer flex-col gap-1.5 border-0 bg-transparent px-1 py-3 text-left hover:bg-elevated/50" :title="s.open" @click="openEntry(it.id)">
              <span class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span class="min-w-0 flex-1 basis-40 break-words text-sm font-medium">{{ it.title }}</span>
                <span v-if="it.status !== 'ready'" class="lw-st" :class="statusCls(it.status)">{{ statusText(it.status) }}</span>
              </span>
              <span v-if="it.preview" class="line-clamp-2 break-words text-[13px] text-muted">{{ it.preview }}</span>
              <span v-if="it.tags.length" class="flex flex-wrap items-center gap-1">
                <span v-for="x in it.tags.slice(0, TAGS_SHOWN)" :key="x" class="lw-chip max-w-full"><span class="truncate">{{ x }}</span></span>
                <span v-if="it.tags.length > TAGS_SHOWN" class="lw-chip">{{ fmt(s.tagsMore, { n: it.tags.length - TAGS_SHOWN }) }}</span>
              </span>
              <span class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dimmed">
                <span class="lw-num">{{ fmt(s.version, { n: it.version }) }}</span>
                <span>{{ fmt(s.updated, { time: formatDateTime(it.updatedAt) }) }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <span class="lw-num text-xs text-dimmed">{{ fmt(s.shown, { n: items.length, total }) }}</span>
          <UButton v-if="items.length < total" size="xs" color="neutral" variant="outline" :loading="loadingMore" @click="load(false)">
            {{ s.more }}
          </UButton>
        </div>
      </template>
    </div>

    <KbEntryDrawer v-model:open="drawerOpen" :kb-id="kb.id" :entry-id="drawerId" :tag-options="tags" @changed="onChanged" />
  </AppCard>
</template>
