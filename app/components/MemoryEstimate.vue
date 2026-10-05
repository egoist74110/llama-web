<script setup lang="ts">
// The estimate bar of the edit drawer (decisions 42, 43): tier, how much is needed against how much is free, the breakdown
// per memory pool, what the estimate could not model, and the parameter findings of the same check.
import t from '~~/i18n/zh-CN'
import {
  barPercent, estimateTitle, issueText, mainPool, noteTexts, poolRows, poolTitle, summaryText, tierBar, tierClass,
  type CheckDoc,
} from '~/utils/memory-check'

const props = defineProps<{ check: CheckDoc | null, loading: boolean, error: string }>()
const m = t.memory
const ui = usePlatformUi()
const isMac = computed(() => ui.value.isMac)

const est = computed(() => props.check?.estimate ?? null)
const pool = computed(() => mainPool(est.value))
const issues = computed(() => props.check?.issues ?? [])
const notes = computed(() => (est.value ? noteTexts(est.value, isMac.value) : []))
</script>

<template>
  <div class="space-y-2.5" :class="loading ? 'opacity-70' : ''">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h4 class="text-sm font-medium text-highlighted">
        {{ estimateTitle(est, isMac) }}
      </h4>
      <span v-if="check && est" class="lw-st" :class="tierClass(check.tier)" :title="m.tierHint[check.tier]">{{ m.tier[check.tier] }}</span>
    </div>

    <p v-if="error" class="m-0 text-xs text-error">
      {{ error }}
    </p>
    <p v-else-if="!check" class="m-0 text-xs text-muted">
      {{ loading ? m.loading : m.failed }}
    </p>

    <template v-else-if="est && pool">
      <div class="lw-bar" :class="tierBar(check.tier)" role="img" :aria-label="summaryText(est, isMac)">
        <span :style="{ width: `${barPercent(pool)}%` }" />
      </div>
      <p class="m-0 text-xs text-default">
        {{ summaryText(est, isMac) }}
      </p>
      <p class="m-0 text-xs text-muted">
        {{ m.tierHint[check.tier] }}
      </p>
      <p class="m-0 text-xs text-dimmed">
        {{ check.basis === 'measured' ? m.measured : m.formula }}<template v-if="check.online"> · {{ m.onlineNote }}</template>
      </p>
      <p v-if="check.mlockDropped" class="m-0 text-xs text-warning">
        {{ m.mlockDropped }}
      </p>

      <details class="group rounded-[10px] border border-default bg-muted px-3 py-2">
        <summary class="cursor-pointer text-xs font-medium text-muted">
          {{ m.details }}
        </summary>
        <div class="mt-2 space-y-3">
          <div v-for="p in est.pools" :key="`${p.kind}:${p.id}`" class="space-y-1">
            <div class="flex flex-wrap items-center justify-between gap-x-3 text-xs">
              <span class="min-w-0 truncate font-medium text-default">{{ poolTitle(p, isMac) }}</span>
              <span class="lw-num text-dimmed">{{ p.budgetMiB === null ? '' : fmt(m.budget, { n: formatMiB(p.budgetMiB) }) }}</span>
            </div>
            <dl class="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs">
              <template v-for="r in poolRows(p)" :key="r.key">
                <dt class="text-muted">{{ r.label }}</dt>
                <dd class="lw-num m-0 text-right font-mono">{{ formatMiB(r.miB) }}</dd>
              </template>
              <dt class="font-medium text-default">{{ m.total }}</dt>
              <dd class="lw-num m-0 text-right font-mono font-medium">{{ formatMiB(p.totalMiB) }}</dd>
            </dl>
          </div>
          <ul v-if="notes.length" class="m-0 list-disc space-y-0.5 pl-4 text-xs text-dimmed">
            <li v-for="n in notes" :key="n">{{ n }}</li>
          </ul>
        </div>
      </details>
    </template>

    <p v-else-if="check" class="m-0 text-xs text-muted">
      {{ m.unavailable }}
    </p>

    <div v-if="check" class="space-y-1">
      <h5 class="m-0 text-xs font-medium text-muted">
        {{ m.issuesTitle }}
      </h5>
      <p v-if="!issues.length" class="m-0 text-xs text-dimmed">
        {{ m.issuesNone }}
      </p>
      <ul v-else class="m-0 list-none space-y-1 p-0 text-xs">
        <li v-for="(i, n) in issues" :key="n" class="flex items-start gap-1.5" :class="i.severity === 'error' ? 'text-error' : 'text-warning'">
          <UIcon :name="i.severity === 'error' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'" class="mt-0.5 size-3.5 shrink-0" />
          <span class="min-w-0 break-words">{{ issueText(i, isMac) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
