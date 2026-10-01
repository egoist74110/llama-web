<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { state, events, metrics, serverNow } = useLive()

const modelName = (id: string) => state.value?.models.find(m => m.id === id)?.name ?? id
const running = computed(() => (state.value?.models ?? []).flatMap(m =>
  m.instances.map(inst => ({ key: `${m.id}:${inst.profile}`, model: m, inst })),
))
const elapsed = (since: number | null) => (since === null ? '' : formatDuration(serverNow.value - since))
const gpus = computed(() => (metrics.value?.gpu.available ? metrics.value.gpu.gpus : []))
const num = (n: number | null) => (n === null ? '-' : n.toFixed(1))
/** One-line speed text of an instance: live while generating, otherwise the last finished request. */
function speedText(modelId: string, profile: string): string {
  const sp = t.overview.speed
  const m = metrics.value?.speed
  if (!m) return ''
  const live = m.active.filter(a => a.modelId === modelId && a.profile === profile)
  const gen = live.find(a => a.phase === 'generating')
  if (gen) return gen.tokensPerSec === null ? sp.generatingWarm : fmt(sp.generating, { n: num(gen.tokensPerSec) })
  if (live.length) return sp.prompt
  const last = m.last.find(l => l.modelId === modelId && l.profile === profile)
  if (!last) return ''
  const vars = { prompt: num(last.promptPerSec), gen: num(last.generationPerSec) }
  const text = last.promptPerSec !== null && last.generationPerSec !== null
    ? fmt(sp.last, vars)
    : last.generationPerSec !== null ? fmt(sp.lastGen, vars) : fmt(sp.lastPrompt, vars)
  return last.estimated ? text + sp.estimated : text
}
const isGenerating = (modelId: string, profile: string) =>
  !!metrics.value?.speed.active.some(a => a.modelId === modelId && a.profile === profile)
const hints: Record<string, string> = {
  loading: t.overview.loadingHint,
  draining: t.overview.drainingHint,
  failed: t.overview.failedHint,
}
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="t.overview.title" :subtitle="t.overview.subtitle" />

    <div v-if="!state" class="space-y-4">
      <USkeleton class="h-28 w-full" />
      <USkeleton class="h-20 w-full" />
    </div>

    <template v-else>
      <AppCard :title="t.overview.current.title" :hint="running.length ? undefined : t.overview.current.hint">
        <ul v-if="running.length" class="divide-y divide-default">
          <li v-for="r in running" :key="r.key" class="space-y-2 py-3 first:pt-0 last:pb-0">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StateDot :state="r.inst.state" />
              <span class="text-base font-medium text-highlighted">{{ r.model.name }}</span>
              <UBadge color="neutral" variant="outline" size="sm">
                {{ t.overview.profile }} {{ r.inst.profile }}
              </UBadge>
              <StateBadge :state="r.inst.state" />
              <span v-if="r.inst.since !== null" class="text-xs text-muted">
                {{ fmt(t.overview.since, { state: stateLabel(r.inst.state), time: elapsed(r.inst.since) }) }}
              </span>
              <span v-if="r.inst.inflight" class="text-xs text-muted">{{ fmt(t.overview.inflight, { count: r.inst.inflight }) }}</span>
            </div>
            <template v-if="r.inst.state === 'loading'">
              <UProgress size="xs" :model-value="r.inst.progress ?? undefined" />
              <p v-if="r.inst.progress !== null" class="text-xs tabular-nums text-muted">
                {{ fmt(t.overview.progress, { n: r.inst.progress }) }}
              </p>
            </template>
            <p
              v-if="r.inst.state === 'ready' && speedText(r.model.id, r.inst.profile)"
              class="text-sm tabular-nums"
              :class="isGenerating(r.model.id, r.inst.profile) ? 'text-primary' : 'text-muted'"
            >
              {{ speedText(r.model.id, r.inst.profile) }}
            </p>
            <p v-if="hints[r.inst.state]" class="text-xs text-muted">
              {{ hints[r.inst.state] }}
            </p>
            <p v-if="r.inst.error" class="text-sm text-error">
              {{ reasonText(r.inst.error) }}
            </p>
          </li>
        </ul>
        <template v-else>
          <p class="text-sm text-highlighted">
            {{ state.models.length ? t.overview.empty : t.overview.noModels }}
          </p>
          <p class="mt-1 text-sm text-muted">
            {{ state.models.length ? fmt(t.overview.emptyHint, { count: state.models.length }) : t.overview.noModelsHint }}
          </p>
        </template>
      </AppCard>

      <AppCard v-if="gpus.length" :title="t.overview.gpu.title" :hint="t.overview.gpu.hint">
        <ul class="space-y-3">
          <li v-for="g in gpus" :key="g.index" class="space-y-1.5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span class="min-w-0 truncate text-highlighted">{{ g.name }}</span>
              <span class="tabular-nums text-muted">
                {{ fmt(t.overview.gpu.used, { used: formatMiB(g.usedMiB), total: formatMiB(g.totalMiB) }) }}
                <template v-if="g.utilization !== null"> · {{ fmt(t.overview.gpu.util, { n: g.utilization }) }}</template>
              </span>
            </div>
            <UProgress size="sm" :model-value="Math.round(g.usedMiB / g.totalMiB * 100)" />
          </li>
        </ul>
      </AppCard>

      <div class="grid gap-5 md:grid-cols-2">
        <AppCard :title="t.overview.queue.title" :hint="t.overview.queue.hint">
          <p v-if="!state.queue.length" class="text-sm text-muted">
            {{ t.overview.queue.empty }}
          </p>
          <ul v-else class="space-y-2">
            <li v-for="q in state.queue" :key="q.modelId + q.profile" class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-medium text-highlighted">{{ modelName(q.modelId) }}</span>
              <UBadge color="neutral" variant="outline" size="sm">
                {{ q.profile }}
              </UBadge>
              <UBadge :color="q.started ? 'warning' : 'neutral'" variant="subtle" size="sm">
                {{ q.started ? t.overview.queue.started : t.overview.queue.waiting }}
              </UBadge>
              <span v-if="q.waiting" class="text-xs text-muted">{{ fmt(t.overview.queue.requests, { count: q.waiting }) }}</span>
            </li>
          </ul>
        </AppCard>

        <AppCard :title="t.overview.llamacpp.title" :hint="t.overview.llamacpp.hint">
          <dl class="text-sm">
            <div class="flex gap-2">
              <dt class="text-muted">
                {{ t.overview.llamacpp.current }}
              </dt>
              <dd class="text-highlighted">
                {{ state.llamacpp.current || t.layout.llamacppNone }}
              </dd>
            </div>
          </dl>
          <p class="mt-1 text-sm text-muted">
            {{ runtimeText(state.llamacpp.runtime) }}
          </p>
        </AppCard>
      </div>

      <AppCard :title="t.overview.events.title" :hint="t.overview.events.hint">
        <p v-if="!events.length" class="text-sm text-muted">
          {{ t.overview.events.empty }}
        </p>
        <ul v-else class="max-h-96 space-y-1.5 overflow-y-auto">
          <li v-for="e in events" :key="e.id" class="flex gap-3 text-sm">
            <time class="shrink-0 text-xs tabular-nums text-dimmed">{{ formatClock(e.at) }}</time>
            <span class="min-w-0 break-words" :class="e.kind === 'state' && e.error ? 'text-error' : 'text-default'">{{ eventText(e, modelName) }}</span>
          </li>
        </ul>
      </AppCard>
    </template>
  </div>
</template>
