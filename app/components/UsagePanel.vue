<script setup lang="ts">
// Usage tab of the log page (decision 40): daily token bars and totals by model / source / key.
// Data comes from GET /api/usage (aggregates only; no conversation content).
import t from '~~/i18n/zh-CN'
import type { UsageGroup, UsageGroupBy, UsageReport } from '~~/server/core/usage'

const toast = useToast()
const RANGES = [7, 14, 30] as const
const days = ref<number>(30)
const groupBy = ref<UsageGroupBy>('model')
const report = ref<UsageReport | null>(null)
const loading = ref(false)

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const query = computed(() => {
  const now = new Date()
  return { from: stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days.value - 1))), to: stamp(now) }
})

let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  try {
    const r = await $fetch<UsageReport>('/api/usage', { query: query.value })
    if (mine === seq) report.value = r
  } catch (e) {
    if (mine !== seq) return
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.usage.loadFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    if (mine === seq) loading.value = false
  }
}
onMounted(load)
watch(days, load)

const csvHref = computed(() => {
  const q = new URLSearchParams({ ...query.value, format: 'csv', groupBy: groupBy.value })
  return `/api/usage?${q.toString()}`
})

const total = computed(() => report.value?.total)
const tokens = (c: { promptTokens: number, completionTokens: number }) => c.promptTokens + c.completionTokens
const avgMs = (c: { requests: number, durationMs: number }) => (c.requests ? Math.round(c.durationMs / c.requests) : 0)
const failed = (c: { error: number, aborted: number }) => c.error + c.aborted

const bars = computed(() => {
  const list = report.value?.daily ?? []
  const max = Math.max(1, ...list.map(tokens))
  return list.map(d => ({
    day: d.day,
    label: d.day.slice(5),
    promptPct: (d.promptTokens / max) * 100,
    completionPct: (d.completionTokens / max) * 100,
    tip: fmt(t.usage.chart.tip, { day: d.day, prompt: formatCount(d.promptTokens), completion: formatCount(d.completionTokens), requests: formatCount(d.requests) }),
  }))
})
const hasData = computed(() => (total.value?.requests ?? 0) > 0)

const groupTabs: Array<{ value: UsageGroupBy, label: string }> = [
  { value: 'model', label: t.usage.groups.model },
  { value: 'source', label: t.usage.groups.source },
  { value: 'key', label: t.usage.groups.key },
  { value: 'profile', label: t.usage.groups.profile },
]
function groupLabel(g: UsageGroup): string {
  if (groupBy.value === 'source') return t.logs.requests.source[g.key as keyof typeof t.logs.requests.source] ?? g.key
  if (g.key) return g.label || g.key
  return groupBy.value === 'model' ? t.usage.names.unknownModel : groupBy.value === 'key' ? t.usage.names.noKey : t.usage.names.noProfile
}
const rows = computed(() => report.value?.by[groupBy.value] ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2.5">
      <div class="lw-seg" role="tablist" :aria-label="t.usage.range.label">
        <button v-for="n in RANGES" :key="n" type="button" role="tab" :aria-selected="days === n" :class="{ on: days === n }" @click="days = n">
          {{ n === 7 ? t.usage.range.d7 : n === 14 ? t.usage.range.d14 : t.usage.range.d30 }}
        </button>
      </div>
      <span class="flex-1" />
      <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :aria-label="t.usage.refresh" :title="t.usage.refresh" :loading="loading" @click="load" />
      <UButton color="neutral" variant="outline" icon="i-lucide-download" :href="csvHref" download>
        {{ t.usage.export }}
      </UButton>
    </div>

    <p class="m-0 text-xs text-dimmed">
      {{ fmt(t.usage.note, { days: 30 }) }}
    </p>

    <p v-if="!hasData && !loading" class="lw-card m-0 px-4 py-8 text-center text-sm text-muted">
      {{ t.usage.empty }}
    </p>

    <template v-else-if="total">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div class="lw-card px-4 py-3">
          <div class="text-xs text-dimmed">
            {{ t.usage.cards.requests }}
          </div>
          <div class="lw-num text-xl font-semibold">
            {{ formatCount(total.requests) }}
          </div>
        </div>
        <div class="lw-card px-4 py-3">
          <div class="text-xs text-dimmed">
            {{ t.usage.cards.prompt }} token
          </div>
          <div class="lw-num text-xl font-semibold">
            {{ formatCount(total.promptTokens) }}
          </div>
        </div>
        <div class="lw-card px-4 py-3">
          <div class="text-xs text-dimmed">
            {{ t.usage.cards.completion }} token
          </div>
          <div class="lw-num text-xl font-semibold">
            {{ formatCount(total.completionTokens) }}
          </div>
        </div>
        <div class="lw-card px-4 py-3">
          <div class="text-xs text-dimmed">
            {{ t.usage.cards.failed }}
          </div>
          <div class="lw-num text-xl font-semibold">
            {{ formatCount(failed(total)) }}
          </div>
        </div>
        <div class="lw-card px-4 py-3">
          <div class="text-xs text-dimmed">
            {{ t.usage.cards.avg }}
          </div>
          <div class="lw-num text-xl font-semibold">
            {{ formatMs(avgMs(total)) }}
          </div>
        </div>
      </div>

      <AppCard :title="t.usage.chart.title">
        <template #actions>
          <span class="inline-flex items-center gap-3 text-xs text-dimmed">
            <span class="inline-flex items-center gap-1"><i class="inline-block size-2 rounded-sm" style="background: var(--lw-accent)" />{{ t.usage.chart.prompt }}</span>
            <span class="inline-flex items-center gap-1"><i class="inline-block size-2 rounded-sm" style="background: var(--lw-accent); opacity: .45" />{{ t.usage.chart.completion }}</span>
          </span>
        </template>
        <div class="flex h-40 items-end gap-[3px]" role="img" :aria-label="t.usage.chart.title">
          <div v-for="b in bars" :key="b.day" class="flex h-full min-w-0 flex-1 flex-col justify-end" :title="b.tip">
            <div class="rounded-t-sm" :style="{ height: `${b.completionPct}%`, background: 'var(--lw-accent)', opacity: 0.45 }" />
            <div :style="{ height: `${b.promptPct}%`, background: 'var(--lw-accent)' }" />
          </div>
        </div>
        <div class="lw-num mt-1.5 flex justify-between text-[11px] text-dimmed">
          <span>{{ bars[0]?.label }}</span>
          <span>{{ bars.at(-1)?.label }}</span>
        </div>
      </AppCard>

      <section class="lw-card overflow-hidden">
        <div class="flex items-center justify-between gap-3 border-b border-default px-4 py-2.5">
          <div class="lw-seg" role="tablist">
            <button v-for="g in groupTabs" :key="g.value" type="button" role="tab" :aria-selected="groupBy === g.value" :class="{ on: groupBy === g.value }" @click="groupBy = g.value">
              {{ g.label }}
            </button>
          </div>
        </div>
        <div class="overflow-auto">
          <table class="lw-tbl min-w-[40rem]">
            <thead>
              <tr>
                <th v-for="(label, k) in t.usage.columns" :key="k">
                  {{ label }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in rows" :key="g.key" class="lw-rowh">
                <td class="font-medium">
                  {{ groupLabel(g) }}
                </td>
                <td>{{ formatCount(g.requests) }}</td>
                <td>{{ formatCount(g.ok) }}</td>
                <td :class="failed(g) ? 'text-warning' : ''">
                  {{ formatCount(failed(g)) }}
                </td>
                <td>{{ formatCount(g.promptTokens) }}</td>
                <td>{{ formatCount(g.completionTokens) }}</td>
                <td class="font-mono">
                  {{ formatMs(avgMs(g)) }}
                </td>
                <td>{{ formatCount(g.images) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
