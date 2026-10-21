<script setup lang="ts">
// Search test: ask the knowledge base(s) a question and show what comes back, with the mode that was actually used.
import { t } from '../composables/useLocale'
import type { KbView, SearchResponse } from '~~/server/core/kb/manager'
import { mergeTags, parseSimilarity } from '~/utils/kb'

const props = defineProps<{ kbs: KbView[], selectedId: string | null }>()

const s = t.kb.page.search
const toast = useToast()
const query = ref('')
const topK = ref('5')
const scope = ref<'current' | 'all'>('current')
const searching = ref(false)
const minSimilarity = ref('')
const pickedTags = ref<string[]>([])
const result = ref<SearchResponse | null>(null)

// "Current" needs a selection; without one the search covers every knowledge base.
const effective = computed(() => (scope.value === 'current' && props.selectedId ? 'current' : 'all'))
const scopes = computed(() => [
  { value: 'current' as const, label: s.scopeCurrent, off: !props.selectedId },
  { value: 'all' as const, label: s.scopeAll, off: false },
])

// Tags of what is searched: the selected knowledge base, or all of them.
const tagOptions = computed(() => mergeTags((effective.value === 'current' ? props.kbs.filter(k => k.id === props.selectedId) : props.kbs).map(k => k.tags ?? [])))
watch(tagOptions, (opts) => {
  const known = new Set(opts.map(o => o.tag))
  if (pickedTags.value.some(x => !known.has(x))) pickedTags.value = pickedTags.value.filter(x => known.has(x))
})
const similarity = computed(() => parseSimilarity(minSimilarity.value))

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

async function run() {
  const q = query.value.trim()
  if (!q || searching.value || !similarity.value.ok) return
  searching.value = true
  try {
    const k = Math.min(20, Math.max(1, Math.floor(Number(topK.value)) || 5))
    result.value = await $fetch<SearchResponse>('/api/kb/search', {
      method: 'POST',
      body: {
        query: q, topK: k,
        ...(effective.value === 'current' ? { kbIds: [props.selectedId] } : {}),
        ...(pickedTags.value.length ? { tags: pickedTags.value } : {}),
        ...(similarity.value.value !== null ? { minSimilarity: similarity.value.value } : {}),
      },
    })
  } catch (e) {
    result.value = null
    toast.add({ title: s.failed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    searching.value = false
  }
}

const reindexNames = computed(() => (result.value?.reindexKbIds ?? []).map(id => props.kbs.find(k => k.id === id)?.name ?? id).join(', '))
const showKb = computed(() => effective.value === 'all')
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <form class="flex flex-col gap-3" @submit.prevent="run">
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="query" class="min-w-0 flex-1 basis-60" icon="i-lucide-search" :placeholder="s.placeholder" :aria-label="s.query" />
        <UButton type="submit" size="md" icon="i-lucide-search" :loading="searching" :disabled="!query.trim() || !kbs.length || !similarity.ok">
          {{ s.run }}
        </UButton>
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="lw-seg" role="radiogroup" :aria-label="s.scope">
          <button v-for="x in scopes" :key="x.value" type="button" role="radio" :aria-checked="effective === x.value" :class="{ on: effective === x.value }" :disabled="x.off" @click="scope = x.value">
            {{ x.label }}
          </button>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted">{{ s.topK }}</span>
          <UInput v-model="topK" type="number" size="sm" class="w-20" min="1" max="20" />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted">{{ s.minSimilarity }}</span>
          <UInput v-model="minSimilarity" type="number" size="sm" class="w-28" min="0" max="1" step="0.05" :placeholder="s.minSimilarityPlaceholder" :color="similarity.ok ? undefined : 'error'" />
        </label>
      </div>
      <p v-if="!similarity.ok" role="alert" class="m-0 text-xs text-error">
        {{ s.minSimilarityBad }}
      </p>
      <div v-if="tagOptions.length" class="flex flex-col gap-1.5">
        <span class="text-xs text-muted">{{ s.tags }} · {{ s.tagsHint }}</span>
        <KbTagPicker v-model="pickedTags" :options="tagOptions" :label="s.tags" />
      </div>
    </form>

    <div v-if="result" class="mt-4 flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="lw-chip" :class="{ 'lw-chip-accent': result.mode === 'hybrid' }">{{ s.mode[result.mode] }}</span>
        <span class="lw-num text-xs text-dimmed">{{ result.hits.length }}</span>
      </div>
      <p v-if="result.reindexNeeded" class="m-0 text-xs text-warning">
        {{ fmt(s.reindexNotice, { names: reindexNames }) }}
      </p>
      <p v-if="result.vectorError" class="m-0 text-xs text-warning">
        {{ s.vectorError }}
      </p>
      <p v-if="!result.hits.length" class="m-0 text-sm text-muted">
        {{ s.none }}
      </p>
      <ol v-else class="m-0 flex list-none flex-col gap-2.5 p-0">
        <li v-for="h in result.hits" :key="`${h.kbId}:${h.chunkId}`" class="rounded-[10px] bg-elevated/60 px-3.5 py-3">
          <div class="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-dimmed">
            <span v-if="showKb" class="lw-chip">{{ h.kbName }}</span>
            <span class="break-all font-medium text-default">{{ h.docName }}</span>
            <span class="lw-num">{{ fmt(s.line, { n: h.startLine }) }}</span>
            <span class="lw-num font-mono">{{ fmt(s.score, { score: h.score.toFixed(4) }) }}</span>
            <span v-if="result.mode === 'hybrid' && h.mode === 'keyword'" class="lw-chip">{{ s.mode.keyword }}</span>
          </div>
          <p v-if="h.headingPath" class="m-0 mb-1 text-xs text-muted [overflow-wrap:anywhere]">
            {{ h.headingPath }}
          </p>
          <p class="m-0 whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere]">
            {{ h.text }}
          </p>
        </li>
      </ol>
    </div>
  </AppCard>
</template>
