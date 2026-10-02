<script setup lang="ts">
// llama.cpp versions: update status, installed versions (current / in use), switch with confirmation.
// Everything comes from the live snapshot; switching goes through useLlamacpp().
import t from '~~/i18n/zh-CN'
import type { LlamacppDoc } from '~~/server/core/updater'

const s = t.llamacpp
const { state } = useLive()
const { ask, busy } = useLlamacpp()

const info = computed(() => state.value?.llamacpp ?? null)
// Update settings (only change by hand-editing settings.json) come from the version API once.
const cfg = ref<Pick<LlamacppDoc, 'autoUpdate' | 'keepVersions'> | null>(null)
onMounted(async () => {
  try { cfg.value = await $fetch<LlamacppDoc>('/api/llamacpp') } catch { /* hint falls back to the default */ }
})
const keep = computed(() => cfg.value?.keepVersions ?? 2)
const autoOff = computed(() => cfg.value?.autoUpdate === false)
const currentIndex = computed(() => info.value?.versions.findIndex(v => v.current) ?? -1)
</script>

<template>
  <AppCard :title="s.title" :hint="fmt(s.hint, { n: keep })">
    <div v-if="info" class="space-y-3">
      <p class="text-xs text-muted">{{ t.platform.runtimeHint }}</p>
      <p v-if="state?.platform?.os === 'darwin'" class="text-xs text-muted">{{ t.overview.gpu.macHint }}</p>
      <p class="text-sm">
        <span class="text-muted">{{ s.status }}</span>
        <span class="ml-2 text-default">{{ runtimeText(info.runtime) }}</span>
      </p>
      <p v-if="autoOff" class="text-xs text-muted">
        {{ s.autoOff }}
      </p>
      <p v-if="!info.versions.length" class="text-sm text-muted">
        {{ s.empty }}
      </p>
      <ul v-else class="divide-y divide-default rounded-lg border border-default">
        <li v-for="(v, i) in info.versions" :key="v.tag" class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-mono text-highlighted">{{ v.tag }}</span>
            <UBadge v-if="v.current" color="primary" variant="subtle" size="sm">
              {{ s.current }}
            </UBadge>
            <UBadge v-if="i === 0 && !v.current" color="neutral" variant="subtle" size="sm">
              {{ s.newest }}
            </UBadge>
            <UBadge v-if="v.inUse" color="success" variant="subtle" size="sm">
              {{ s.inUse }}
            </UBadge>
          </div>
          <UButton
            v-if="!v.current"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-history"
            :disabled="busy"
            @click="ask(v.tag)"
          >
            {{ currentIndex >= 0 && i > currentIndex ? s.rollback : s.use }}
          </UButton>
        </li>
      </ul>
      <p v-if="info.versions.length > 1" class="text-xs text-muted">
        {{ s.note }}
      </p>
    </div>
    <USkeleton v-else class="h-20 w-full" />
  </AppCard>
</template>
