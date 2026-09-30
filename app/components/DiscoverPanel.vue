<script setup lang="ts">
// Scan discovery: .gguf files in the model directories that are not enabled yet.
import t from '~~/i18n/zh-CN'
import type { ScanEntry, ScanWarning } from '~~/server/core/scanner'

type Entry = ScanEntry & { enabledAs: string | null }
interface ScanDoc { scannedAt: number, dirs: number, warnings: ScanWarning[], entries: Entry[] }

const { busy, enable } = useModelActions()
const toast = useToast()
// Kept across page visits so switching tabs does not rescan.
const scan = useState<ScanDoc | null>('scan-result', () => null)
const scanning = ref(false)

async function rescan() {
  if (scanning.value) return
  scanning.value = true
  try {
    scan.value = await $fetch<ScanDoc>('/api/scan', { method: 'POST', body: {} })
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.models.toast.scanFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    scanning.value = false
  }
}
onMounted(() => { if (!scan.value) void rescan() })

const models = computed(() => scan.value?.entries.filter(e => e.kind === 'model' || e.kind === 'invalid') ?? [])
const fresh = computed(() => models.value.filter(e => !e.enabledAs))
const helpers = computed(() => ({
  mmproj: scan.value?.entries.filter(e => e.kind === 'mmproj').length ?? 0,
  draft: scan.value?.entries.filter(e => e.kind === 'draft').length ?? 0,
}))
const dirLabel = (w: ScanWarning) => `${w.dirId}${w.rel ? `/${w.rel}` : ''}`
const scannedAt = computed(() => (scan.value ? formatClock(scan.value.scannedAt) : ''))

async function doEnable(e: Entry) {
  const r = await enable(e.ref) as { model: { id: string } } | null
  // Drop it from the list right away; the enabled list itself arrives through the live stream.
  if (r && scan.value) {
    scan.value = { ...scan.value, entries: scan.value.entries.map(x => (x === e ? { ...x, enabledAs: r.model.id } : x)) }
  }
}
</script>

<template>
  <AppCard :title="t.models.discover.title" :hint="t.models.discover.hint">
    <template #actions>
      <div class="flex shrink-0 items-center gap-3">
        <span v-if="scan" class="hidden text-xs text-muted sm:inline">{{ fmt(t.models.discover.scannedAt, { time: scannedAt }) }}</span>
        <UButton class="shrink-0 whitespace-nowrap" size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="scanning" @click="rescan">
          {{ scanning ? t.models.discover.scanning : t.models.discover.scan }}
        </UButton>
      </div>
    </template>

    <div v-if="!scan" class="space-y-3">
      <USkeleton class="h-16 w-full" />
      <USkeleton class="h-16 w-full" />
    </div>

    <template v-else>
      <ul v-if="scan.warnings.length" class="mb-3 space-y-0.5 text-xs text-warning">
        <li v-for="(w, i) in scan.warnings" :key="i">
          {{ fmt(t.models.discover.warnings[w.code], { dir: dirLabel(w) }) }}
        </li>
      </ul>

      <div v-if="!scan.dirs" class="py-4 text-center">
        <p class="text-sm text-highlighted">
          {{ t.models.discover.noDirs }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t.models.discover.noDirsHint }}
        </p>
      </div>
      <div v-else-if="!models.length" class="py-4 text-center">
        <p class="text-sm text-highlighted">
          {{ t.models.discover.nothing }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t.models.discover.nothingHint }}
        </p>
      </div>
      <p v-else-if="!fresh.length" class="py-2 text-sm text-muted">
        {{ t.models.discover.allEnabled }}
      </p>

      <ul v-if="fresh.length" class="divide-y divide-default">
        <li v-for="e in fresh" :key="e.ref.dirId + '/' + e.ref.rel" class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-highlighted">{{ e.fileName }}</span>
              <UBadge v-if="e.kind === 'invalid'" color="error" variant="subtle" size="sm">
                {{ t.models.discover.invalid }}
              </UBadge>
              <UBadge v-else-if="!e.complete" color="warning" variant="subtle" size="sm">
                {{ t.models.discover.incomplete }}
              </UBadge>
              <UBadge v-if="e.shards" color="neutral" variant="outline" size="sm">
                {{ fmt(t.models.discover.shards, { count: e.shards.length }) }}
              </UBadge>
              <UBadge v-if="e.meta?.hasChatTemplate" color="neutral" variant="outline" size="sm">
                {{ t.models.discover.template }}
              </UBadge>
            </div>
            <p class="break-all text-xs text-muted">
              {{ e.ref.dirId }}/{{ e.ref.rel }}
            </p>
            <dl v-if="e.meta" class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
              <div><dt class="mr-1 inline">{{ t.models.discover.meta.arch }} </dt><dd class="inline text-default">{{ e.meta.architecture ?? t.models.discover.unknown }}</dd></div>
              <div><dt class="mr-1 inline">{{ t.models.discover.meta.params }} </dt><dd class="inline text-default">{{ formatParams(e.meta.parameterCount) }}</dd></div>
              <div><dt class="mr-1 inline">{{ t.models.discover.meta.quant }} </dt><dd class="inline text-default">{{ e.meta.quantization ?? t.models.discover.unknown }}</dd></div>
              <div><dt class="mr-1 inline">{{ t.models.discover.meta.ctx }} </dt><dd class="inline text-default">{{ formatContext(e.meta.contextLength) }}</dd></div>
              <div><dt class="mr-1 inline">{{ t.models.discover.meta.size }} </dt><dd class="inline text-default">{{ formatBytes(e.size) }}</dd></div>
            </dl>
            <p v-if="e.kind === 'invalid'" class="text-xs text-error">
              {{ fmt(t.models.discover.invalidHint, { error: e.error ?? '' }) }}
            </p>
            <p v-else-if="!e.complete" class="text-xs text-warning">
              {{ t.models.discover.incompleteHint }}
            </p>
            <p v-else-if="e.candidates.mmproj.length || e.candidates.draft.length" class="text-xs text-muted">
              {{ fmt(t.models.discover.candidates, { mmproj: e.candidates.mmproj.length, draft: e.candidates.draft.length }) }}
            </p>
          </div>
          <UButton
            v-if="e.kind === 'model' && e.complete"
            size="sm"
            icon="i-lucide-plus"
            :loading="!!busy[`enable:${e.ref.dirId}/${e.ref.rel}`]"
            @click="doEnable(e)"
          >
            {{ t.models.discover.enable }}
          </UButton>
        </li>
      </ul>

      <p v-if="scan.dirs && (helpers.mmproj || helpers.draft)" class="mt-3 text-xs text-dimmed">
        {{ fmt(t.models.discover.helpers, helpers) }}
      </p>
    </template>
  </AppCard>
</template>
