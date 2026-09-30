<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { state } = useLive()
const tab = ref<'enabled' | 'discover'>('enabled')
const tabs = [
  { value: 'enabled' as const, label: t.models.tabs.enabled },
  { value: 'discover' as const, label: t.models.tabs.discover },
]
const list = computed(() => state.value?.models ?? [])
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="t.models.title" :subtitle="t.models.subtitle" />

    <div class="inline-flex gap-1 rounded-lg border border-default bg-elevated p-1" role="tablist">
      <button
        v-for="x in tabs"
        :key="x.value"
        type="button"
        role="tab"
        :aria-selected="tab === x.value"
        class="rounded-md px-3 py-1 text-sm transition-colors"
        :class="tab === x.value ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:text-highlighted'"
        @click="tab = x.value"
      >
        {{ x.label }}
        <span v-if="x.value === 'enabled' && list.length" class="ml-1 text-xs opacity-70">{{ list.length }}</span>
      </button>
    </div>

    <template v-if="tab === 'enabled'">
      <div v-if="!state" class="space-y-4">
        <USkeleton class="h-24 w-full" />
        <USkeleton class="h-24 w-full" />
      </div>
      <AppCard v-else-if="!list.length" :title="t.models.enabled.title" :hint="t.models.enabled.hint">
        <p class="text-sm text-highlighted">
          {{ t.models.enabled.empty }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t.models.enabled.emptyHint }}
        </p>
        <UButton class="mt-3" size="sm" @click="tab = 'discover'">
          {{ t.models.enabled.goDiscover }}
        </UButton>
      </AppCard>
      <div v-else class="space-y-4">
        <p class="text-xs text-muted">
          {{ t.models.enabled.hint }}
        </p>
        <ModelCard v-for="m in list" :key="m.id" :model="m" />
      </div>
    </template>

    <DiscoverPanel v-else />
  </div>
</template>
