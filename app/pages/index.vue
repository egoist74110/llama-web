<script setup lang="ts">
// Overview dashboard (decision 30): hero card, four stat tiles, recent events and requests.
// Everything comes from useLive(); local API addresses use the server's LAN host.
import t from '~~/i18n/zh-CN'
import type { ActivityEvent } from '~~/server/core/live'
import { modelsOnCard } from '~/utils/memory-check'
import { apiAddress } from '~/utils/overview'

const { state, events, requests, metrics } = useLive()
// The memory checks of the models that are online: the list below the hero and the model names on each GPU card.
const checks = useMemoryChecks()
checks.followOnline()
const toast = useToast()
const o = t.overview
const tl = o.tiles

const apiUrl = computed(() => (import.meta.client ? apiAddress(window.location.origin, state.value?.network?.lanHost) : ''))
const copied = ref(false)
async function copyApi() {
  try {
    await navigator.clipboard.writeText(apiUrl.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
    toast.add({ title: o.api.copied, color: 'success', icon: 'i-lucide-check' })
  } catch {
    toast.add({ title: o.api.copyFailed, color: 'error', icon: 'i-lucide-circle-alert' })
  }
}

const modelName = (id: string) => state.value?.models.find(m => m.id === id)?.name ?? id

// --- tiles ------------------------------------------------------------------------------
const ui = usePlatformUi()
const gpus = computed(() => (metrics.value?.gpu.available ? metrics.value.gpu.gpus : []))
const gb = (mib: number) => (mib / 1024).toFixed(1)
const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0)

// Names of the online models on one card (the check names the card each of them draws memory from).
const onCard = (index: number) => modelsOnCard(state.value, (id, profile) => checks.get(id, profile)?.estimate, index)
const online = computed(() => rankInstances(state.value, metrics.value).length)

const inflight = computed(() => (state.value?.models ?? []).reduce((n, m) => n + m.instances.reduce((k, i) => k + i.inflight, 0), 0))
const queued = computed(() => (state.value?.queue ?? []).reduce((n, q) => n + q.waiting, 0))
const queuedNames = computed(() => (state.value?.queue ?? []).filter(q => q.waiting > 0).map(q => modelName(q.modelId)).join('、'))

const runtime = computed(() => state.value?.llamacpp.runtime)
const runtimeChip = computed(() => {
  const r = runtime.value
  if (!r) return ''
  if (r.state === 'ready') return tl.runtime[r.note ?? 'ready']
  return tl.runtime[r.state]
})

const tunnel = computed(() => state.value?.tunnel.status)
const tunnelPill = computed(() => {
  const s = tunnel.value?.state ?? 'off'
  const cls = s === 'connected' ? 'lw-st-ready' : s === 'error' ? 'lw-st-failed' : s === 'off' ? 'lw-st-stopped' : 'lw-st-loading'
  return { cls, label: tl.tunnel[s] }
})
// Same rule as publicAddresses(): a quick tunnel only has the address cloudflared printed.
const publicQuick = computed(() => state.value?.tunnel.mode === 'quick')
const publicUrl = computed(() => {
  const info = state.value?.tunnel
  const host = publicQuick.value ? info?.quickHost : info?.hostnames?.[0]
  return host ? `https://${host}/v1` : ''
})

// --- recent -----------------------------------------------------------------------------
const recentEvents = computed(() => events.value.slice(0, 6))
function eventDot(e: ActivityEvent): string {
  if (e.kind === 'state') return e.error || e.to === 'crashed' || e.to === 'failed' ? 'lw-dot-err' : e.to === 'ready' ? 'lw-dot-ok' : 'lw-dot-dim'
  if (e.kind === 'drain-timeout' || e.kind === 'runtime-fallback' || e.kind === 'make-room' || e.kind === 'vram-deviation') return 'lw-dot-warn'
  if (e.kind === 'no-room') return 'lw-dot-err'
  if (e.kind === 'watchdog') return e.state === 'stopped' ? 'lw-dot-err' : 'lw-dot-warn'
  if (e.kind === 'tunnel') return e.state === 'connected' ? 'lw-dot-ok' : 'lw-dot-err'
  if (e.state === 'error') return 'lw-dot-err'
  return e.state === 'ready' && e.note === 'updated' ? 'lw-dot-acc' : 'lw-dot-dim'
}
const recentRequests = computed(() => requests.value.slice(0, 5))
const tokens = (n: number | null) => (n === null ? '–' : n.toLocaleString('zh-CN'))
</script>

<template>
  <div class="flex flex-col gap-[22px]">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.01em]">{{ o.title }}</h1>
        <p class="mt-1 text-[13px] text-muted">{{ o.subtitle }}</p>
      </div>
      <div v-if="apiUrl" class="flex min-w-0 items-center gap-2 rounded-[10px] border border-default bg-elevated py-1 pl-3 pr-1">
        <span class="text-xs text-dimmed">{{ o.api.label }}</span>
        <span class="select-all truncate font-mono text-[13px]">{{ apiUrl }}</span>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="o.api.copy"
          @click="copyApi"
        />
      </div>
    </header>

    <div v-if="!state" class="flex flex-col gap-3.5">
      <USkeleton class="h-48 w-full rounded-[14px]" />
      <USkeleton class="h-28 w-full rounded-[14px]" />
    </div>

    <template v-else>
      <OverviewHero />
      <OnlineModels v-if="online > 1" />

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3.5">
        <section v-if="ui.hasGpu && gpus.length" class="lw-card flex flex-col gap-2.5 px-[18px] py-4">
          <div class="flex justify-between gap-2 text-xs text-dimmed">
            <span>{{ tl.vram }}</span>
            <span class="truncate" :title="gpus.map(g => g.name).join('\n')">{{ gpus.length === 1 ? gpus[0]!.name : fmt(tl.gpuCount, { n: gpus.length }) }}</span>
          </div>
          <div v-for="g in gpus" :key="g.index" class="flex flex-col gap-2">
            <div class="lw-num flex items-baseline gap-1">
              <span class="font-mono text-[22px] font-medium" :class="{ '!text-base': gpus.length > 1 }">{{ gb(g.usedMiB) }}</span>
              <span class="text-[13px] text-dimmed">/ {{ gb(g.totalMiB) }} GB</span>
            </div>
            <div class="lw-bar"><span :style="{ width: `${pct(g.usedMiB, g.totalMiB)}%` }" /></div>
            <div v-if="g.utilization !== null" class="lw-num text-xs text-dimmed">{{ fmt(o.gpu.util, { n: g.utilization }) }}</div>
            <div v-if="gpus.length > 1 || onCard(g.index).length" class="min-h-[1em] truncate text-xs text-muted" :title="onCard(g.index).join('、')">{{ onCard(g.index).length ? fmt(t.overview.online.onCard, { names: onCard(g.index).join('、') }) : '' }}</div>
          </div>
        </section>

        <section class="lw-card flex flex-col gap-2.5 px-[18px] py-4">
          <div class="text-xs text-dimmed">{{ tl.requests }}</div>
          <div class="flex gap-[22px]">
            <div>
              <div class="lw-num font-mono text-[22px] font-medium">{{ inflight }}</div>
              <div class="text-xs text-dimmed">{{ tl.inflight }}</div>
            </div>
            <div>
              <div class="lw-num font-mono text-[22px] font-medium">{{ queued }}</div>
              <div class="text-xs text-dimmed">{{ tl.queued }}</div>
            </div>
          </div>
          <div v-if="queuedNames" class="truncate text-xs text-muted" :title="queuedNames">{{ fmt(tl.queuedModels, { names: queuedNames }) }}</div>
        </section>

        <section class="lw-card flex flex-col gap-2.5 px-[18px] py-4">
          <div class="text-xs text-dimmed">{{ tl.llamacpp }}</div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-[22px] font-medium">{{ state.llamacpp.current || t.layout.llamacppNone }}</span>
            <NuxtLink v-if="state.llamacpp.check?.state === 'checked' && state.llamacpp.check.available" to="/settings#s-llama" class="text-xs text-primary">{{ fmt(t.llamacpp.update.available, { tag: state.llamacpp.check.tag }) }}</NuxtLink>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span v-if="runtimeChip" class="lw-chip" :title="runtimeText(runtime)">{{ runtimeChip }}</span>
          </div>
        </section>

        <section class="lw-card flex flex-col gap-2.5 px-[18px] py-4">
          <div class="text-xs text-dimmed">{{ tl.publicAccess }}</div>
          <div><span class="lw-st" :class="tunnelPill.cls">{{ tunnelPill.label }}</span></div>
          <div v-if="publicQuick" class="text-xs text-dimmed">{{ tl.quickMode }}</div>
          <div v-if="publicUrl" class="truncate font-mono text-xs text-muted" :title="publicUrl">{{ publicUrl }}</div>
          <NuxtLink v-else-if="tunnel?.state === 'off'" to="/settings" class="text-xs text-muted hover:text-default">{{ tl.setup }}</NuxtLink>
          <div v-else class="text-xs text-dimmed">{{ publicQuick ? tl.noHostQuick : tl.noHost }}</div>
        </section>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-3.5">
        <section class="lw-card flex min-w-0 flex-col">
          <header class="flex items-center justify-between px-[18px] pb-2.5 pt-3.5">
            <h3 class="m-0 text-sm font-semibold">{{ o.recent.events }}</h3>
            <UButton size="xs" color="neutral" variant="ghost" to="/logs?tab=events">{{ o.recent.all }}</UButton>
          </header>
          <p v-if="!recentEvents.length" class="px-[18px] pb-4 text-[13px] text-muted">{{ o.recent.noEvents }}</p>
          <ol v-else class="m-0 flex list-none flex-col px-[18px] pb-3.5">
            <li v-for="e in recentEvents" :key="e.id" class="grid grid-cols-[14px_1fr_auto] items-start gap-2.5 py-[7px]">
              <span class="mt-1.5 size-2 rounded-full bg-current" :class="eventDot(e)" />
              <span class="min-w-0 break-words text-[13px]">{{ eventText(e, modelName, ui.isMac) }}</span>
              <time class="lw-num font-mono text-xs text-dimmed">{{ formatClock(e.at) }}</time>
            </li>
          </ol>
        </section>

        <section class="lw-card flex min-w-0 flex-col">
          <header class="flex items-center justify-between px-[18px] pb-1 pt-3.5">
            <h3 class="m-0 text-sm font-semibold">{{ o.recent.requests }}</h3>
            <UButton size="xs" color="neutral" variant="ghost" to="/logs?tab=requests">{{ o.recent.all }}</UButton>
          </header>
          <p v-if="!recentRequests.length" class="px-[18px] pb-4 pt-2.5 text-[13px] text-muted">{{ o.recent.noRequests }}</p>
          <div v-else class="overflow-x-auto px-1.5 pb-2">
            <table class="lw-tbl">
              <thead>
                <tr>
                  <th>{{ o.recent.columns.time }}</th>
                  <th>{{ o.recent.columns.source }}</th>
                  <th>{{ o.recent.columns.model }}</th>
                  <th class="!text-right">{{ o.recent.columns.tokens }}</th>
                  <th class="!text-right">{{ o.recent.columns.duration }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in recentRequests" :key="r.id">
                  <td class="font-mono text-dimmed">
                    <span class="mr-1.5 inline-block size-1.5 rounded-full bg-current align-middle" :class="r.outcome === 'ok' ? 'lw-dot-ok' : r.outcome === 'error' ? 'lw-dot-err' : 'lw-dot-warn'" :title="t.logs.requests.outcome[r.outcome]" />{{ formatClock(r.at) }}
                  </td>
                  <td><span class="lw-chip" :class="{ 'lw-chip-accent': r.source === 'public' }">{{ requestSourceText(r) }}</span></td>
                  <td class="max-w-[180px] truncate">{{ r.modelName ?? '–' }}</td>
                  <td class="text-right font-mono">{{ tokens(r.promptTokens) }} / {{ tokens(r.completionTokens) }}</td>
                  <td class="text-right font-mono">{{ formatMs(r.durationMs) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
