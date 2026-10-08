<script setup lang="ts">
// Overview hero (decision 30): the instance that matters most right now. Ready: name, file,
// tags, big generation speed and the last ~40 s curve. Loading: progress. Failed: the failure
// card. Nothing running: an empty state. Other live instances are listed underneath.
import { t } from '../composables/useLocale'
import { profileLabel } from '~/utils/profile-label'
import type { LaunchPreview } from '~~/server/core/launch'

const { state, metrics, serverNow } = useLive()
const ui = usePlatformUi()
const { trend } = useSpeedTrend()
const { busy, stop } = useModelActions()
const h = t.overview.hero

const ranked = computed(() => rankInstances(state.value, metrics.value))
const top = computed(() => ranked.value[0] ?? null)
const kind = computed(() => {
  const s = top.value?.inst.state
  if (!s) return 'empty'
  if (s === 'ready' || s === 'draining') return 'ready'
  if (s === 'failed' || s === 'crashed') return 'failed'
  return 'loading'
})

const since = computed(() => {
  const i = top.value?.inst
  if (!i || i.since === null) return ''
  const time = formatDuration(serverNow.value - i.since)
  return i.state === 'ready' ? fmt(h.uptime, { time }) : fmt(t.overview.since, { state: stateLabel(i.state), time })
})

// Context size as the launcher would pass it (same builder as the edit form's preview).
// Fetched once per model + profile; not live data, so no polling.
const ctxCache = useState<Record<string, number | null>>('overview-ctx', () => ({}))
const topKey = computed(() => (top.value ? `${top.value.model.id}\u0000${top.value.inst.profile}` : ''))
watch(topKey, async (key) => {
  const x = top.value
  if (!key || !x || key in ctxCache.value) return
  try {
    const p = await $fetch<LaunchPreview>(`/api/models/${encodeURIComponent(x.model.id)}/preview`, { method: 'POST', body: { profile: x.inst.profile } })
    ctxCache.value = { ...ctxCache.value, [key]: ctxNumber(p.effective.ctxSize) }
  } catch {
    ctxCache.value = { ...ctxCache.value, [key]: null }
  }
}, { immediate: true })

const tags = computed(() => {
  const x = top.value
  if (!x) return []
  const out: Array<{ text: string, mono?: boolean, accent?: boolean }> = [{ text: fmt(h.profile, { name: profileLabel(x.inst.profile) }) }]
  const ctx = ctxCache.value[topKey.value]
  if (ctx) out.push({ text: fmt(h.ctx, { n: ctx }), mono: true })
  const quant = quantFromFile(x.model.files.model)
  if (quant) out.push({ text: quant, mono: true })
  if (x.model.files.mmproj) out.push({ text: h.vision, accent: true })
  if (x.model.files.draft) out.push({ text: h.draft })
  return out
})

const speed = computed(() => (top.value ? instanceSpeed(metrics.value, top.value.model.id, top.value.inst.profile) : null))
const speedLabel = computed(() => {
  const s = speed.value
  if (!s) return ''
  if (s.phase === 'generating') return h.generating
  if (s.phase === 'prompt') return h.promptPhase
  return s.generation === null ? h.idleNone : h.idleLast
})
const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '–' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }))

const series = computed(() => trend.value.get(topKey.value) ?? [])
const line = computed(() => sparkPoints(series.value))
const area = computed(() => sparkArea(line.value))

const stopping = computed(() => !!(top.value && busy.value[`stop:${top.value.model.id}`]))
const pillCls = (s: string) => (s === 'ready' ? 'lw-st-ready' : s === 'failed' || s === 'crashed' ? 'lw-st-failed' : 'lw-st-loading')
</script>

<template>
  <section class="lw-card grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-x-9 gap-y-6 px-6 py-[22px]">
    <!-- Ready / draining -->
    <template v-if="top && kind === 'ready'">
      <div class="flex min-w-0 flex-col gap-3.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <span class="lw-st" :class="pillCls(top.inst.state)">{{ stateLabel(top.inst.state) }}</span>
          <span class="lw-num text-xs text-dimmed">
            {{ since }}<template v-if="since"> · </template>{{ fmt(h.inflight, { count: top.inst.inflight }) }}
          </span>
        </div>
        <div class="min-w-0">
          <h2 class="m-0 truncate text-[28px] font-semibold tracking-[-0.02em]">{{ top.model.name }}</h2>
          <p class="mt-1.5 truncate font-mono text-xs text-dimmed" :title="top.model.files.model">{{ top.model.files.model }}</p>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="tag in tags" :key="tag.text" class="lw-chip" :class="{ 'font-mono': tag.mono, 'lw-chip-accent': tag.accent }">{{ tag.text }}</span>
        </div>
        <p v-if="top.inst.state === 'draining'" class="text-xs text-muted">{{ t.overview.drainingHint }}</p>
        <div class="mt-1 flex flex-wrap gap-2">
          <UButton color="neutral" variant="outline" icon="i-lucide-square" :loading="stopping" @click="stop(top.model.id)">
            {{ stopping ? h.stopping : h.stop }}
          </UButton>
          <UButton color="neutral" variant="outline" :to="`/logs?model=${encodeURIComponent(top.model.id)}`">
            {{ h.viewOutput }}
          </UButton>
        </div>
      </div>
      <div class="flex min-w-0 flex-col justify-between gap-2.5">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div class="text-xs text-dimmed">{{ speedLabel }}</div>
            <div class="flex items-baseline gap-1.5">
              <span class="lw-num font-mono text-5xl font-medium leading-[1.05] tracking-[-0.03em] text-[var(--lw-accent-ink)]">{{ num(speed?.generation) }}</span>
              <span class="text-sm text-muted">{{ h.tokensPerSec }}</span>
            </div>
          </div>
          <div class="text-right">
            <div class="text-xs text-dimmed">{{ h.promptSpeed }}</div>
            <div class="lw-num font-mono text-lg">
              {{ num(speed?.prompt, 0) }} <span class="text-xs text-dimmed">t/s</span>
            </div>
          </div>
        </div>
        <svg viewBox="0 0 320 64" preserveAspectRatio="none" class="block h-[72px] w-full" role="img" :aria-label="h.trend">
          <line x1="0" y1="63.5" x2="320" y2="63.5" stroke="var(--lw-border)" stroke-width="1" vector-effect="non-scaling-stroke" />
          <polygon v-if="area" :points="area" fill="var(--lw-accent-soft)" />
          <polyline v-if="line" :points="line" fill="none" stroke="var(--lw-accent)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="flex justify-between text-[11px] text-dimmed">
          <span>{{ h.trendStart }}</span><span>{{ h.trendEnd }}</span>
        </div>
      </div>
    </template>

    <!-- Loading / unloading -->
    <div v-else-if="top && kind === 'loading'" class="col-span-full flex flex-col gap-3.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <span class="lw-st lw-st-loading">{{ stateLabel(top.inst.state) }}</span>
        <span class="text-xs text-dimmed">{{ top.inst.state === 'loading' ? h.loadingNote : since }}</span>
      </div>
      <h2 class="m-0 text-[28px] font-semibold tracking-[-0.02em]">{{ top.model.name }}</h2>
      <template v-if="top.inst.state === 'loading'">
        <div class="lw-bar warn !h-2">
          <span :style="{ width: `${top.inst.progress ?? 0}%` }" />
        </div>
        <div class="lw-num text-[13px] text-muted">
          {{ top.inst.progress === null ? h.progressUnknown : fmt(t.overview.progress, { n: top.inst.progress }) }}
        </div>
      </template>
      <p v-else class="text-[13px] text-muted">{{ since }}</p>
    </div>

    <!-- Failed / crashed -->
    <div v-else-if="top && kind === 'failed'" class="col-span-full flex flex-col gap-3.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <span class="lw-st lw-st-failed">{{ stateLabel(top.inst.state) }}</span>
        <span class="text-xs text-dimmed">{{ since }}</span>
      </div>
      <h2 class="m-0 text-[28px] font-semibold tracking-[-0.02em]">{{ top.model.name }}</h2>
      <FailureCard
        v-if="top.inst.failure"
        :model-id="top.model.id"
        :profile="top.inst.profile"
        :state="top.inst.state"
        :failure="top.inst.failure"
        retry-button
      />
      <template v-else>
        <p v-if="top.inst.error" class="text-sm text-error">{{ loadErrorText(top.inst.error, ui.isMac) }}</p>
        <p class="text-xs text-muted">{{ t.overview.failedHint }}</p>
      </template>
    </div>

    <!-- Nothing running -->
    <div v-else-if="state" class="col-span-full flex flex-col gap-2 py-3.5">
      <h2 class="m-0 text-xl font-semibold">{{ state.models.length ? t.overview.empty : t.overview.noModels }}</h2>
      <p class="m-0 text-[13px] text-muted">
        {{ state.models.length ? fmt(t.overview.emptyHint, { count: state.models.length }) : t.overview.noModelsHint }}
      </p>
      <div class="mt-1.5">
        <UButton color="neutral" variant="outline" to="/models">{{ h.goModels }}</UButton>
      </div>
    </div>

  </section>
</template>
