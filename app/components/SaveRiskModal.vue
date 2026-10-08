<script setup lang="ts">
// Confirm before saving a profile whose memory estimate is risky or does not fit (decision 43). Saving is never refused
// for the estimate: the free memory changes, so the user decides; the breakdown shows what the launch would take.
import { t } from '../composables/useLocale'
import { mainPool, poolRows, poolTitle, saveRiskView, type CheckDoc } from '~/utils/memory-check'

const props = defineProps<{ check: CheckDoc | null, restart: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()
const s = t.models.edit.risk
const ui = usePlatformUi()
const isMac = computed(() => ui.value.isMac)

// Keep the last content while the leave transition runs.
const shown = ref(props.check)
watch(() => props.check, (c) => { if (c) shown.value = c })
const est = computed(() => shown.value?.estimate ?? null)
const view = computed(() => (est.value && shown.value ? saveRiskView(est.value, shown.value.tier, isMac.value) : null))
const pool = computed(() => mainPool(est.value))
const rows = computed(() => (pool.value ? poolRows(pool.value) : []))
</script>

<template>
  <UModal v-model:open="open" :title="view?.title ?? ''" :description="view?.body ?? ''">
    <template #close="{ ui: modalUi }">
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" :class="modalUi.close()" :aria-label="s.cancel" />
    </template>
    <template #body>
      <div v-if="view && pool" class="space-y-3">
        <p class="m-0 flex items-start gap-2 text-sm font-medium" :class="shown?.tier === 'nofit' ? 'text-error' : 'text-warning'">
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
          {{ view.summary }}
        </p>
        <div class="rounded-[10px] border border-default bg-muted px-3 py-2.5">
          <p class="m-0 mb-1.5 text-xs font-medium text-muted">{{ s.details }} · {{ poolTitle(pool, isMac) }}</p>
          <dl class="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs">
            <template v-for="r in rows" :key="r.key">
              <dt class="text-muted">{{ r.label }}</dt>
              <dd class="lw-num m-0 text-right font-mono">{{ formatMiB(r.miB) }}</dd>
            </template>
            <dt class="font-medium text-default">{{ t.memory.total }}</dt>
            <dd class="lw-num m-0 text-right font-mono font-medium">{{ formatMiB(pool.totalMiB) }}</dd>
          </dl>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">{{ s.cancel }}</UButton>
        <UButton size="sm" @click="emit('confirm')">{{ restart ? s.saveRestart : s.save }}</UButton>
      </div>
    </template>
  </UModal>
</template>
