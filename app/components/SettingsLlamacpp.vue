<script setup lang="ts">
// llama.cpp versions of this computer: update status, builds grouped by channel (official and hand-added),
// switch the current one with confirmation, add a build, delete one (with its own confirmation).
// A Mac has one channel and nothing about GPUs (decision 38); the flags come from usePlatformUi().
import { t } from '../composables/useLocale'
import { profileLabel } from '~/utils/profile-label'
import type { RuntimeRow } from '~~/server/core/runtime-manager'

const s = t.llamacpp
const m = s.manage
const { state, events } = useLive()
const { ask, busy } = useLlamacpp()
const ui = usePlatformUi()
const toast = useToast()
const { doc, rev, rows, load } = useRuntimeDoc()

onMounted(load)
// The live snapshot says when versions or the update status change; a switch on the other channel bumps `rev`.
watch(() => [
  rev.value, state.value?.llamacpp.current,
  state.value?.llamacpp.versions.map(v => `${v.tag}${v.inUse ? '*' : ''}`).join(','),
  state.value?.llamacpp.runtime.state,
  JSON.stringify(state.value?.llamacpp.secondary),
].join('|'), () => { void load() })

const status = computed(() => state.value?.llamacpp.runtime)
const keep = computed(() => doc.value?.keepVersions ?? 2)
const autoOff = computed(() => doc.value?.autoUpdate === false)

// ---- Channels --------------------------------------------------------------------------------
const channels = computed(() => (ui.value.hasCpuChannel ? ['cuda', 'cpu'] : [...new Set(rows.value.map(r => r.accel))]))
const groups = computed(() => {
  const list = channels.value.length ? channels.value : ['']
  return groupByChannel(rows.value, list)
})
const secondary = computed(() => doc.value?.secondary ?? null)
const tagNumber = (tag: string) => Number(/^b(\d+)$/.exec(tag)?.[1] ?? 0)
const currentOf = (accel: string) => rows.value.find(r => r.accel === accel && r.kind === 'official' && r.current)
const isRollback = (r: RuntimeRow) => {
  const cur = currentOf(r.accel)
  return !!cur && tagNumber(r.tag) < tagNumber(cur.tag)
}
const channelTitle = (accel: string) => accelLabel(accel, ui.value.isMac)
const downloading = computed(() => secondary.value?.status.state === 'working')
function availableFor(r: RuntimeRow): string | null {
  if (!r.current || r.kind !== 'official') return null
  const c = r.accel === secondary.value?.accel ? secondary.value.check : doc.value?.check
  return c?.state === 'checked' && c.available ? c.tag : null
}
const needsDownload = (r: RuntimeRow) => !!availableFor(r) && !rows.value.some(v => v.kind === 'official' && v.accel === r.accel && v.tag === availableFor(r))

function useRow(r: RuntimeRow) {
  ask(r.tag, secondary.value && r.accel === secondary.value.accel ? r.accel : undefined)
}

async function downloadChannel(accel: string) {
  try {
    await $fetch('/api/llamacpp/download', { method: 'POST', body: { channel: accel } })
    await load()
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: s.actionFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  }
}
// The secondary download reports its progress through the document; poll it only while it runs.
let poll: ReturnType<typeof setInterval> | undefined
watch(downloading, (d) => {
  clearInterval(poll)
  if (d) poll = setInterval(() => { void load() }, 2000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(poll))

// ---- Add / delete ----------------------------------------------------------------------------
const addOpen = ref(false)
const removing = ref<RuntimeRow | null>(null)
const rowName = (r: RuntimeRow) => runtimeRowLabel(r, ui.value.isMac)
const removeWhy = (r: RuntimeRow) => (r.latestOfficial ? m.removeLatestWhy : r.inUse ? m.removeInUseWhy : '')

// ---- Fallback notice -------------------------------------------------------------------------
type Fallback = Extract<NonNullable<typeof events.value>[number], { kind: 'runtime-fallback' }>
const dismissed = ref(new Set<number>())
const fallbacks = computed(() => events.value
  .filter((e): e is Fallback => e.kind === 'runtime-fallback' && !dismissed.value.has(e.id))
  .slice(0, 3))
const modelName = (id: string) => state.value?.models.find(x => x.id === id)?.name ?? id
const fallbackLine = (e: Fallback) => fmt(m.fallbackLine, { model: modelName(e.modelId), profile: profileLabel(e.profile), from: e.from, to: e.to })
function dismissFallbacks() {
  dismissed.value = new Set([...dismissed.value, ...fallbacks.value.map(e => e.id)])
}
</script>

<template>
  <AppCard :title="s.title" :hint="fmt(s.hint, { n: keep })">
    <LlamacppUpdateControls @changed="load" />
    <template #actions>
      <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-plus" class="whitespace-nowrap" @click="addOpen = true">
        {{ m.add }}
      </UButton>
    </template>

    <div v-if="doc" class="space-y-3">
      <div v-if="fallbacks.length" class="rounded-[10px] border border-[var(--lw-warn,var(--ui-warning))] bg-muted px-3.5 py-3" role="status">
        <div class="flex items-start justify-between gap-3">
          <p class="flex items-center gap-2 text-sm font-medium text-highlighted">
            <UIcon name="i-lucide-triangle-alert" class="shrink-0 text-warning" />
            {{ m.fallbackTitle }}
          </p>
          <UButton size="xs" color="neutral" variant="ghost" @click="dismissFallbacks">
            {{ m.fallbackDismiss }}
          </UButton>
        </div>
        <ul class="mt-1.5 list-none space-y-0.5 p-0 text-xs text-default">
          <li v-for="e in fallbacks" :key="e.id" class="break-all">
            {{ fallbackLine(e) }}
          </li>
        </ul>
        <p class="mt-1.5 text-xs text-muted">
          {{ m.fallbackNote }}
        </p>
      </div>

      <p v-if="ui.hasGpu" class="text-xs text-muted">
        {{ t.platform.runtimeHint }}
      </p>
      <p class="text-sm">
        <span class="text-muted">{{ s.status }}</span>
        <span class="ml-2 text-default">{{ runtimeText(status) }}</span>
      </p>
      <p v-if="autoOff" class="text-xs text-muted">
        {{ s.autoOff }}
      </p>

      <section v-for="g in groups" :key="g.accel" class="space-y-1">
        <h3 v-if="ui.hasCpuChannel" class="text-xs font-semibold text-muted">
          {{ channelTitle(g.accel) }}
        </h3>
        <div v-if="!g.rows.length" class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
          <p class="text-sm text-muted">
            {{ g.accel ? fmt(m.channelEmpty, { channel: channelTitle(g.accel) }) : s.empty }}
          </p>
          <template v-if="secondary && g.accel === secondary.accel">
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-download" :loading="downloading" :disabled="downloading" @click="downloadChannel(g.accel)">
              {{ downloading ? fmt(m.channelDownloading, { channel: channelTitle(g.accel) }) : fmt(m.channelDownload, { channel: channelTitle(g.accel) }) }}
            </UButton>
            <span v-if="secondary.status.state !== 'idle'" class="text-xs text-muted">{{ runtimeText(secondary.status) }}</span>
          </template>
        </div>
        <ul v-else class="list-none p-0">
          <li v-for="r in g.rows" :key="r.ref" class="lw-row flex flex-wrap items-center gap-x-3 gap-y-2 py-[11px]">
            <span class="lw-radio" :class="{ on: r.current }" />
            <span class="min-w-0 break-all font-mono text-[13px]">{{ runtimeBaseName(r) }}</span>
            <span v-if="r.current" class="lw-chip lw-chip-accent">{{ s.current }}</span>
            <span v-if="availableFor(r)" class="text-xs text-primary">{{ fmt(s.update.available, { tag: availableFor(r)! }) }}</span>
            <span v-if="r.latestOfficial && !r.current" class="lw-chip">{{ m.latestOfficial }}</span>
            <span v-if="r.kind === 'custom'" class="lw-chip">{{ m.custom }}</span>
            <span v-if="r.inUse" class="lw-st lw-st-ready">{{ s.inUse }}</span>
            <span class="flex-1" />
            <UButton v-if="needsDownload(r)" size="xs" icon="i-lucide-download" :disabled="status?.state === 'working' || downloading" @click="downloadChannel(r.accel)">{{ s.update.download }}</UButton>
            <UButton
              v-if="r.kind === 'official' && !r.current"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-history"
              :disabled="busy"
              @click="useRow(r)"
            >
              {{ isRollback(r) ? s.rollback : s.use }}
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="!r.deletable"
              :title="removeWhy(r)"
              :aria-label="`${m.remove} ${rowName(r)}`"
              @click="removing = r"
            >
              {{ m.remove }}
            </UButton>
          </li>
        </ul>
      </section>

      <p v-if="rows.length" class="text-xs text-muted">
        {{ m.removeNote }}
      </p>
      <p v-if="rows.length > 1" class="text-xs text-muted">
        {{ s.note }}
      </p>
      <p v-if="doc.runtimes?.hiddenOtherPlatform" class="text-xs text-muted">
        {{ fmt(m.hiddenOther, { n: doc.runtimes.hiddenOtherPlatform }) }}
      </p>
    </div>
    <USkeleton v-else class="h-20 w-full" />

    <RuntimeAddModal v-model:open="addOpen" @added="load" />
    <RuntimeDeleteModal :row="removing" @close="removing = null" @done="load" />
  </AppCard>
</template>
