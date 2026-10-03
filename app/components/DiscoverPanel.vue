<script setup lang="ts">
// Scan discovery: .gguf files in the model directories that are not enabled yet.
import t from '~~/i18n/zh-CN'
import type { ScanEntry, ScanWarning } from '~~/server/core/scanner'

type Entry = ScanEntry & { enabledAs: string | null }
interface ScanDoc { scannedAt: number, dirs: number, warnings: ScanWarning[], entries: Entry[] }

const props = defineProps<{ filter?: string }>()
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
const fresh = computed(() => models.value.filter(e => !e.enabledAs && (!props.filter || `${e.fileName} ${e.ref.dirId}/${e.ref.rel}`.toLowerCase().includes(props.filter))))
const freshAll = computed(() => models.value.filter(e => !e.enabledAs))
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
  <div class="flex flex-col gap-2.5">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p class="m-0 min-w-0 flex-1 basis-64 text-xs text-dimmed">
        {{ t.models.discover.hint }}
        <span v-if="scan">{{ fmt(t.models.discover.scannedAt, { time: scannedAt }) }}</span>
      </p>
      <UButton class="shrink-0 whitespace-nowrap" size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="scanning" @click="rescan">
        {{ scanning ? t.models.discover.scanning : t.models.discover.scan }}
      </UButton>
    </div>

    <div v-if="!scan" class="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-3.5">
      <USkeleton class="h-32 w-full rounded-[14px]" />
      <USkeleton class="h-32 w-full rounded-[14px]" />
    </div>

    <template v-else>
      <ul v-if="scan.warnings.length" class="m-0 list-none space-y-0.5 p-0 text-xs text-warning">
        <li v-for="(w, i) in scan.warnings" :key="i">
          {{ fmt(t.models.discover.warnings[w.code], { dir: dirLabel(w) }) }}
        </li>
      </ul>

      <section v-if="!scan.dirs" class="lw-card px-5 py-6 text-center">
        <p class="m-0 text-sm font-medium">
          {{ t.models.discover.noDirs }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t.models.discover.noDirsHint }}
        </p>
      </section>
      <section v-else-if="!models.length" class="lw-card px-5 py-6 text-center">
        <p class="m-0 text-sm font-medium">
          {{ t.models.discover.nothing }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t.models.discover.nothingHint }}
        </p>
      </section>
      <p v-else-if="!freshAll.length" class="py-2 text-sm text-muted">
        {{ t.models.discover.allEnabled }}
      </p>
      <p v-else-if="!fresh.length" class="py-6 text-center text-sm text-muted">
        {{ t.models.filter.none }}
      </p>

      <div v-if="fresh.length" class="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-3.5">
        <section v-for="e in fresh" :key="e.ref.dirId + '/' + e.ref.rel" class="lw-card flex flex-col gap-3 px-[18px] py-4">
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="break-words text-sm font-semibold [overflow-wrap:anywhere]">{{ e.fileName }}</span>
              <span v-if="e.kind === 'invalid'" class="lw-st lw-st-failed">{{ t.models.discover.invalid }}</span>
              <span v-else-if="!e.complete" class="lw-st lw-st-loading">{{ t.models.discover.incomplete }}</span>
              <span v-if="e.shards" class="lw-chip">{{ fmt(t.models.discover.shards, { count: e.shards.length }) }}</span>
              <span v-if="e.meta?.hasChatTemplate" class="lw-chip">{{ t.models.discover.template }}</span>
            </div>
            <span class="font-mono text-xs text-dimmed [overflow-wrap:anywhere]">{{ e.ref.dirId }}/{{ e.ref.rel }}</span>
          </div>
          <dl v-if="e.meta" class="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div><dt class="text-dimmed">{{ t.models.discover.meta.arch }} · {{ t.models.discover.meta.params }}</dt><dd class="m-0 font-mono">{{ e.meta.architecture ?? t.models.discover.unknown }} · {{ formatParams(e.meta.parameterCount) }}</dd></div>
            <div><dt class="text-dimmed">{{ t.models.discover.meta.quant }} · {{ t.models.discover.meta.size }}</dt><dd class="m-0 font-mono">{{ e.meta.quantization ?? t.models.discover.unknown }} · {{ formatBytes(e.size) }}</dd></div>
            <div><dt class="text-dimmed">{{ t.models.discover.meta.ctx }}</dt><dd class="m-0 font-mono">{{ formatContext(e.meta.contextLength) }}</dd></div>
          </dl>
          <p v-if="e.kind === 'invalid'" class="m-0 text-xs text-error">
            {{ fmt(t.models.discover.invalidHint, { error: e.error ?? '' }) }}
          </p>
          <p v-else-if="!e.complete" class="m-0 text-xs text-warning">
            {{ t.models.discover.incompleteHint }}
          </p>
          <p v-else-if="e.candidates.mmproj.length || e.candidates.draft.length" class="m-0 text-xs text-muted">
            {{ fmt(t.models.discover.candidates, { mmproj: e.candidates.mmproj.length, draft: e.candidates.draft.length }) }}
          </p>
          <div v-if="e.kind === 'model' && e.complete" class="flex justify-end">
            <UButton
              size="sm"
              icon="i-lucide-plus"
              :loading="!!busy[`enable:${e.ref.dirId}/${e.ref.rel}`]"
              @click="doEnable(e)"
            >
              {{ t.models.discover.enable }}
            </UButton>
          </div>
        </section>
      </div>

      <p v-if="scan.dirs && (helpers.mmproj || helpers.draft)" class="m-0 text-xs text-dimmed">
        {{ fmt(t.models.discover.helpers, helpers) }}
      </p>
    </template>
  </div>
</template>
