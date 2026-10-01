<script setup lang="ts">
// Log page: model output / events / requests. "Live" shows what the shared stream (useLive)
// holds in memory; picking a file shows its end as saved under data/logs (survives restarts).
import t from '~~/i18n/zh-CN'
import type { ActivityEvent } from '~~/server/core/live'
import type { LogFileInfo, LogRead } from '~~/server/core/logs'
import type { RequestRecord } from '~~/server/core/request-log'

type Tab = 'model' | 'events' | 'requests'
const LIVE = '__live__'

const { state, events, requests, logLines, serverNow } = useLive()
const toast = useToast()

const tab = ref<Tab>('model')
const tabs: Array<{ value: Tab, label: string }> = [
  { value: 'model', label: t.logs.tabs.model },
  { value: 'events', label: t.logs.tabs.events },
  { value: 'requests', label: t.logs.tabs.requests },
]
const model = ref(EMPTY_SELECT_VALUE) // sentinel = all models
const range = ref(LIVE)
const search = ref('')
const paused = ref(false)

const modelName = (id: string) => state.value?.models.find(m => m.id === id)?.name ?? id

// ---------------------------------------------------------------------------------------
// File listing and file content

interface ListingDoc {
  models: Array<{ model: string, name: string, files: LogFileInfo[] }>
  events: LogFileInfo[]
  requests: LogFileInfo[]
}
const listing = ref<ListingDoc | null>(null)
async function loadListing() {
  try {
    listing.value = await $fetch<ListingDoc>('/api/logs')
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.logs.file.listFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  }
}
onMounted(loadListing)

const modelItems = computed(() => withEmptyOption(t.logs.filters.allModels, [
  ...new Map([
    ...(state.value?.models ?? []).map(m => [m.id, m.name] as const),
    ...(listing.value?.models ?? []).map(m => [m.model, m.name] as const),
  ]).entries(),
].map(([value, label]) => ({ value, label }))))

const fileLabel = (name: string, size: number) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})-(\d{2})-(\d{2}))?(?:-(\d+))?\.(?:log|jsonl)$/.exec(name)
  const base = m ? `${m[1]}${m[2] ? ` ${m[2]}:${m[3]}:${m[4]}` : ''}${m[5] ? ` (${m[5]})` : ''}` : name
  return `${base} · ${formatBytes(size)}`
}

// Day files hold every model's events / requests; model output files belong to one model.
const files = computed(() => {
  const l = listing.value
  if (!l) return []
  if (tab.value === 'model') {
    const id = fromSelectValue(model.value)
    return id ? l.models.find(m => m.model === id)?.files ?? [] : []
  }
  return tab.value === 'events' ? l.events : l.requests
})
const rangeItems = computed(() => [
  { value: LIVE, label: t.logs.filters.live },
  ...files.value.map(f => ({ value: f.name, label: fileLabel(f.name, f.size) })),
])
// Model output files are listed per model, so a model has to be chosen first.
const needsModel = computed(() => tab.value === 'model' && !fromSelectValue(model.value))

watch([tab, model], () => {
  // A file belongs to a tab (and, for model output, to a model).
  if (range.value !== LIVE && !files.value.some(f => f.name === range.value)) range.value = LIVE
})
watch(tab, () => { void loadListing() })

const file = ref<LogRead | null>(null)
const fileLoading = ref(false)
let fileSeq = 0
watch([range, tab, model], async () => {
  file.value = null
  if (range.value === LIVE) return
  const seq = ++fileSeq
  fileLoading.value = true
  try {
    const r = await $fetch<LogRead>('/api/logs/file', {
      query: { kind: tab.value, name: range.value, model: tab.value === 'model' ? fromSelectValue(model.value) : undefined },
    })
    if (seq === fileSeq) file.value = r
  } catch (e) {
    if (seq !== fileSeq) return
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.logs.file.loadFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
    range.value = LIVE
  } finally {
    if (seq === fileSeq) fileLoading.value = false
  }
})

// ---------------------------------------------------------------------------------------
// Rows

interface TextRow { key: string, at: number | null, tag: string, text: string, error?: boolean }

function parseJsonl<T>(lines: string[]): T[] {
  const out: T[] = []
  for (const l of lines) {
    try { out.push(JSON.parse(l) as T) } catch { /* a torn last line */ }
  }
  return out
}

const inFile = computed(() => range.value !== LIVE)
const wantModel = computed(() => fromSelectValue(model.value))

const modelRows = computed<TextRow[]>(() => {
  if (inFile.value) {
    return (file.value?.lines ?? []).map((text, i) => ({ key: String(i), at: null, tag: '', text }))
  }
  return logLines.value
    .filter(l => !wantModel.value || l.modelId === wantModel.value)
    .map(l => ({ key: String(l.id), at: l.at, tag: wantModel.value ? '' : `${modelName(l.modelId)}:${l.profile}`, text: l.text }))
})

const eventRows = computed<TextRow[]>(() => {
  const list: ActivityEvent[] = inFile.value ? parseJsonl<ActivityEvent>(file.value?.lines ?? []) : [...events.value].reverse()
  return list
    .filter(e => !wantModel.value || e.kind === 'runtime' || e.modelId === wantModel.value)
    .map((e, i) => ({ key: inFile.value ? String(i) : String(e.id), at: e.at, tag: '', text: eventText(e, modelName), error: e.kind === 'state' && !!e.error }))
})

const requestRows = computed<RequestRecord[]>(() => {
  const list = inFile.value ? parseJsonl<RequestRecord>(file.value?.lines ?? []) : [...requests.value].reverse()
  return list.filter(r => !wantModel.value || r.modelId === wantModel.value)
})
const requestKey = (r: RequestRecord, i: number) => (inFile.value ? `${r.at}-${i}` : String(r.id))
const requestText = (r: RequestRecord) => [
  formatClock(r.at), requestSourceText(r), r.modelName ?? '', r.profile ?? '', r.path, r.status, r.error ?? '',
  requestTokensText(r), requestImagesText(r.images), requestParamsText(r.params),
].join(' ')

const needle = computed(() => search.value.trim().toLowerCase())
const rowText = (r: TextRow) => `${r.at === null ? '' : formatClock(r.at)} ${r.tag} ${r.text}`.toLowerCase()
const textRows = computed(() => {
  const rows = tab.value === 'model' ? modelRows.value : eventRows.value
  return needle.value ? rows.filter(r => rowText(r).includes(needle.value)) : rows
})
const reqRows = computed(() => (needle.value ? requestRows.value.filter(r => requestText(r).toLowerCase().includes(needle.value)) : requestRows.value))

// Pause freezes what is on screen; new lines keep being recorded and show up on resume.
const frozenText = shallowRef<TextRow[] | null>(null)
const frozenReq = shallowRef<RequestRecord[] | null>(null)
function togglePause() {
  paused.value = !paused.value
  frozenText.value = paused.value ? textRows.value : null
  frozenReq.value = paused.value ? reqRows.value : null
}
watch([tab, range, model, search], () => { if (paused.value) togglePause() })
const shownText = computed(() => frozenText.value ?? textRows.value)
const shownReq = computed(() => frozenReq.value ?? reqRows.value)
const shownCount = computed(() => (tab.value === 'requests' ? shownReq.value.length : shownText.value.length))

// ---------------------------------------------------------------------------------------
// Scrolling: follow the end unless the reader scrolled up.

const box = ref<HTMLElement | null>(null)
let stick = true
const onScroll = () => {
  const el = box.value
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 32
}
watch([shownCount, tab, range], async () => {
  if (!stick && range.value === LIVE) return
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}, { flush: 'post' })
watch([tab, range, model], () => { stick = true })

const isEmpty = computed(() => (tab.value === 'requests' ? !requestRows.value.length : !(tab.value === 'model' ? modelRows.value : eventRows.value).length))
const emptyText = computed(() => (needle.value && !isEmpty.value ? t.logs.empty.noMatch : t.logs.empty[tab.value]))
const durationAgo = (at: number) => formatDuration(serverNow.value - at)
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="t.logs.title" :subtitle="t.logs.subtitle" />

    <div class="inline-flex gap-1 rounded-lg border border-default bg-elevated p-1" role="tablist">
      <button
        v-for="x in tabs"
        :key="x.value"
        type="button"
        role="tab"
        :aria-selected="tab === x.value"
        class="rounded-md px-3 py-1 text-sm transition-colors"
        :class="tab === x.value ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:text-highlighted'"
        @click="tab = x.value"
      >
        {{ x.label }}
      </button>
    </div>

    <AppCard :title="t.logs.tabs[tab]" :hint="tab === 'requests' ? t.logs.requests.noContentNote : undefined">
      <template #actions>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <USelect v-model="model" :items="modelItems" size="sm" class="w-40" :aria-label="t.logs.filters.model" />
          <USelect v-model="range" :items="rangeItems" size="sm" class="w-52" :aria-label="t.logs.filters.range" />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :aria-label="t.logs.filters.refresh" :title="t.logs.filters.refresh" @click="loadListing" />
        </div>
      </template>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <UInput v-model="search" size="sm" class="min-w-48 flex-1" icon="i-lucide-search" :placeholder="t.logs.filters.searchPlaceholder" :aria-label="t.logs.filters.search" />
        <UButton
          v-if="!inFile"
          size="sm"
          color="neutral"
          variant="outline"
          :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
          @click="togglePause"
        >
          {{ paused ? t.logs.filters.resume : t.logs.filters.pause }}
        </UButton>
      </div>
      <p v-if="paused" class="mb-2 text-xs text-warning">
        {{ t.logs.filters.pausedHint }}
      </p>
      <p v-if="needsModel" class="mb-2 text-xs text-muted">
        {{ t.logs.filters.historyNeedsModel }}
      </p>
      <p v-if="inFile && file?.truncated" class="mb-2 text-xs text-muted">
        {{ t.logs.file.truncated }}
      </p>

      <p v-if="fileLoading" class="py-6 text-center text-sm text-muted">
        {{ t.logs.file.loading }}
      </p>
      <p v-else-if="isEmpty || !shownCount" class="py-6 text-center text-sm text-muted">
        {{ emptyText }}
      </p>

      <div v-else ref="box" class="max-h-[60vh] overflow-auto rounded-md border border-default bg-default" @scroll="onScroll">
        <ul v-if="tab !== 'requests'" class="p-2 font-mono text-xs leading-5">
          <li v-for="r in shownText" :key="r.key" class="flex gap-2 whitespace-pre-wrap break-all" :class="r.error ? 'text-error' : 'text-default'">
            <time v-if="r.at !== null" class="shrink-0 tabular-nums text-dimmed" :title="durationAgo(r.at)">{{ formatClock(r.at) }}</time>
            <span v-if="r.tag" class="shrink-0 text-muted">{{ r.tag }}</span>
            <span class="min-w-0">{{ r.text }}</span>
          </li>
        </ul>

        <table v-else class="w-full min-w-[56rem] text-left text-xs">
          <thead class="sticky top-0 bg-elevated text-muted">
            <tr>
              <th v-for="(label, k) in t.logs.requests.columns" :key="k" class="whitespace-nowrap px-3 py-2 font-medium">
                {{ label }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="(r, i) in shownReq" :key="requestKey(r, i)" class="align-top">
              <td class="whitespace-nowrap px-3 py-1.5 tabular-nums text-dimmed">
                {{ formatClock(r.at) }}
              </td>
              <td class="whitespace-nowrap px-3 py-1.5">
                {{ requestSourceText(r) }}
              </td>
              <td class="px-3 py-1.5">
                <span class="text-highlighted">{{ r.modelName ?? '—' }}</span>
                <span v-if="r.profile" class="text-muted"> · {{ r.profile }}</span>
                <span v-if="r.stream" class="ml-1 text-dimmed">{{ t.logs.requests.stream }}</span>
              </td>
              <td class="whitespace-nowrap px-3 py-1.5" :class="r.outcome === 'ok' ? 'text-default' : r.outcome === 'error' ? 'text-error' : 'text-warning'">
                {{ r.status }} {{ t.logs.requests.outcome[r.outcome] }}<span v-if="r.error" class="text-dimmed"> · {{ r.error }}</span>
              </td>
              <td class="whitespace-nowrap px-3 py-1.5 tabular-nums">
                {{ formatMs(r.durationMs) }}
              </td>
              <td class="whitespace-nowrap px-3 py-1.5 tabular-nums">
                {{ requestTokensText(r) }}
              </td>
              <td class="px-3 py-1.5">
                {{ requestImagesText(r.images) }}
              </td>
              <td class="break-all px-3 py-1.5 font-mono text-dimmed">
                {{ requestParamsText(r.params) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AppCard>
  </div>
</template>
