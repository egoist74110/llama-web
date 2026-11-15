<script setup lang="ts">
// The selected knowledge base: tabs for entries, source documents, trash, change log and usage guide (decision 69).
// The tab lives in the URL (?tab=), so it survives a reload and stays when another knowledge base is picked. Only the
// open tab is mounted: opening a tab (or another knowledge base) fetches it again, which is how writes made from
// outside are picked up.
import { t } from '../composables/useLocale'
import type { KbJobView, KbView } from '~~/server/core/kb/manager'

const TABS = ['entries', 'sources', 'trash', 'changes', 'guide'] as const
type Tab = typeof TABS[number]

const props = defineProps<{ kb: KbView, jobs: KbJobView[] }>()
const emit = defineEmits<{ changed: [] }>()

const route = useRoute()
const router = useRouter()
const tab = ref<Tab>(TABS.find(x => x === route.query.tab) ?? 'entries')
watch(tab, (v) => { void router.replace({ query: { ...route.query, tab: v } }) })

const tabs = computed(() => TABS.map(id => ({
  id,
  label: t.kb.page.tabs[id],
  count: id === 'entries' ? props.kb.entryCount : id === 'sources' ? props.kb.docCount : id === 'trash' ? props.kb.trashCount : null,
})))

const docsPanel = ref<{ reload: () => Promise<void> } | null>(null)
const entriesPanel = ref<{ reload: () => Promise<void> } | null>(null)
/** The live job state moved: refresh what the open tab shows from jobs (statuses of sources and entries). */
defineExpose({
  reload: async () => {
    await Promise.all([docsPanel.value?.reload(), entriesPanel.value?.reload()])
  },
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-[18px]">
    <div class="max-w-full overflow-x-auto pb-0.5 [scrollbar-width:none]">
      <div class="lw-seg" role="tablist">
        <button
          v-for="x in tabs"
          :key="x.id"
          type="button"
          role="tab"
          :aria-selected="tab === x.id"
          :class="{ on: tab === x.id }"
          @click="tab = x.id"
        >
          {{ x.label }}<span v-if="x.count" class="lw-num text-xs text-dimmed">{{ x.count }}</span>
        </button>
      </div>
    </div>

    <KbEntries v-if="tab === 'entries'" ref="entriesPanel" :key="`e-${kb.id}`" :kb="kb" @changed="emit('changed')" />
    <KbDocs v-else-if="tab === 'sources'" ref="docsPanel" :key="`s-${kb.id}`" :kb="kb" :jobs="jobs" @changed="emit('changed')" />
    <KbTrash v-else-if="tab === 'trash'" :key="`t-${kb.id}`" :kb="kb" @changed="emit('changed')" />
    <KbChanges v-else-if="tab === 'changes'" :key="`c-${kb.id}`" :kb="kb" @changed="emit('changed')" />
    <KbGuide v-else :key="`g-${kb.id}`" :kb="kb" />
  </div>
</template>
