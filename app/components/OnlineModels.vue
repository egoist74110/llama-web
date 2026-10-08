<script setup lang="ts">
// Every model that is online (decision 41, 9-4): state, speed and the memory it takes, with a stop button. Shown on the
// overview once more than one is up; the hero card above keeps the one that matters most.
import { t } from '../composables/useLocale'
import { profileLabel } from '~/utils/profile-label'
import { gib } from '~/utils/memory-check'

const o = t.overview.online
const { state, metrics } = useLive()
const { busy, stop } = useModelActions()
const checks = useMemoryChecks()

const rows = computed(() => rankInstances(state.value, metrics.value).map((x) => {
  const check = checks.get(x.model.id, x.inst.profile)
  return { ...x, speed: instanceSpeed(metrics.value, x.model.id, x.inst.profile), check }
}))
const pillCls = (s: string) => (s === 'ready' ? 'lw-st-ready' : s === 'failed' || s === 'crashed' ? 'lw-st-failed' : 'lw-st-loading')
const num = (n: number | null) => (n === null ? '–' : n.toLocaleString('zh-CN', { maximumFractionDigits: 1, minimumFractionDigits: 1 }))
</script>

<template>
  <section class="lw-card flex min-w-0 flex-col">
    <header class="flex items-center justify-between gap-2 px-[18px] pb-1.5 pt-3.5">
      <h3 class="m-0 text-sm font-semibold">{{ o.title }}</h3>
      <span class="lw-num text-xs text-dimmed">{{ fmt(o.count, { n: rows.length }) }}</span>
    </header>
    <ul class="m-0 flex list-none flex-col p-0">
      <li v-for="r in rows" :key="`${r.model.id}:${r.inst.profile}`" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-default px-[18px] py-3 first:border-t-0">
        <div class="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="truncate text-sm font-semibold">{{ r.model.name }}</span>
            <span class="lw-st" :class="pillCls(r.inst.state)">{{ stateLabel(r.inst.state) }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-xs text-dimmed">
            <span>{{ fmt(t.overview.hero.profile, { name: profileLabel(r.inst.profile) }) }}</span>
            <span v-if="r.inst.state === 'loading'" class="lw-num">· {{ r.inst.progress === null ? t.overview.hero.progressUnknown : fmt(t.overview.progress, { n: r.inst.progress }) }}</span>
            <span v-if="r.inst.inflight" class="lw-num">· {{ fmt(o.inflight, { count: r.inst.inflight }) }}</span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-1">
          <div class="lw-num flex items-baseline gap-1">
            <span class="font-mono text-lg font-medium" :class="r.speed.phase === 'generating' ? 'text-[var(--lw-accent-ink)]' : 'text-muted'">{{ r.inst.state === 'ready' || r.inst.state === 'draining' ? num(r.speed.generation) : '–' }}</span>
            <span class="text-xs text-dimmed">{{ r.speed.phase === 'generating' ? t.layout.serving.generating : r.speed.generation === null ? o.speedNone : t.layout.serving.last }}</span>
          </div>
          <span v-if="r.check?.estimate" class="lw-chip lw-num" :title="fmt(t.memory.cardTitle, { profile: profileLabel(r.inst.profile) })">
            {{ fmt(r.check.basis === 'measured' ? t.memory.chip.measured : t.memory.chip.estimated, { n: gib(r.check.estimate.total.totalMiB) }) }}
          </span>
          <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-square" :loading="!!busy[`stop:${r.model.id}`]" :disabled="r.inst.state === 'unloading'" @click="stop(r.model.id)">
            {{ o.stop }}
          </UButton>
        </div>
      </li>
    </ul>
  </section>
</template>
