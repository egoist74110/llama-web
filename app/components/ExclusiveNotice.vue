<script setup lang="ts">
// One line for "an external service is holding the machine" (decision 56 ⑨): local models are unloaded and cannot start.
import { t } from '../composables/useLocale'

withDefaults(defineProps<{ link?: boolean }>(), { link: true })
const { state } = useLive()
const holder = computed(() => state.value?.exclusiveHolder ?? null)
const n = t.upstreams.page.notice
</script>

<template>
  <div v-if="holder" role="status" class="lw-card flex flex-wrap items-start gap-3 border-[var(--lw-warn)] px-5 py-3.5">
    <UIcon name="i-lucide-lock" class="mt-0.5 size-4 shrink-0 lw-dot-warn" />
    <div class="min-w-0 flex-1">
      <p class="m-0 text-[13px] font-medium">
        {{ fmt(n.title, { holder }) }}
      </p>
      <p class="m-0 mt-0.5 text-xs text-muted">
        {{ n.body }}
      </p>
    </div>
    <UButton v-if="link" size="sm" color="neutral" variant="outline" to="/connections">
      {{ n.link }}
    </UButton>
  </div>
</template>
