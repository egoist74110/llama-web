<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { state } = useLive()
const route = useRoute()
const tab = ref<'enabled' | 'discover'>(route.query.tab === 'discover' ? 'discover' : 'enabled')
const tabs = [
  { value: 'enabled' as const, label: t.models.tabs.enabled },
  { value: 'discover' as const, label: t.models.tabs.discover },
]
const list = computed(() => state.value?.models ?? [])
const filter = ref('')
const needle = computed(() => filter.value.trim().toLowerCase())
const toast = useToast()
const discover = ref<{ rescan: () => Promise<{ entries: Array<{ kind: string, enabledAs: string | null }> } | null> } | null>(null)
const discoverEl = ref<HTMLElement | null>(null)

// A folder was just added: show the scan tab, scan it, tell how many models it holds.
async function onDirAdded() {
  tab.value = 'discover'
  await nextTick()
  discoverEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Joins the scan the panel starts on mount (when it holds no result yet) instead of repeating it.
  const doc = await discover.value?.rescan()
  const n = doc ? doc.entries.filter(e => e.kind === 'model' && !e.enabledAs).length : null
  if (n !== null) toast.add({ title: n ? fmt(t.models.addDir.found, { n }) : t.models.addDir.foundNone, color: n ? 'success' : 'warning', icon: n ? 'i-lucide-check' : 'i-lucide-circle-alert' })
}
const shown = computed(() => (needle.value ? list.value.filter(m => m.name.toLowerCase().includes(needle.value) || m.files.model.toLowerCase().includes(needle.value)) : list.value))
</script>

<template>
  <div class="flex flex-col gap-[18px]">
    <PageHeader :title="t.models.title" :subtitle="t.models.enabled.hint" />

    <div class="flex flex-wrap items-center justify-between gap-2.5">
      <div class="lw-seg" role="tablist">
        <button
          v-for="x in tabs"
          :key="x.value"
          type="button"
          role="tab"
          :aria-selected="tab === x.value"
          :class="{ on: tab === x.value }"
          @click="tab = x.value"
        >
          {{ x.label }}
          <span v-if="x.value === 'enabled' && list.length" class="lw-num text-[11px] text-dimmed">{{ list.length }}</span>
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ModelAddDir @added="onDirAdded" />
        <UInput
          v-model="filter"
          class="w-[min(280px,100%)]"
          icon="i-lucide-search"
          :placeholder="t.models.filter.placeholder"
          :aria-label="t.models.filter.label"
        />
      </div>
    </div>

    <template v-if="tab === 'enabled'">
      <div v-if="!state" class="flex flex-col gap-3.5">
        <USkeleton class="h-24 w-full rounded-[14px]" />
        <USkeleton class="h-24 w-full rounded-[14px]" />
      </div>
      <section v-else-if="!list.length" class="lw-card px-5 py-[18px]">
        <h2 class="m-0 text-[15px] font-semibold">
          {{ t.models.enabled.empty }}
        </h2>
        <p class="mt-1 text-[13px] text-muted">
          {{ t.models.enabled.emptyHint }}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <ModelAddDir @added="onDirAdded" />
          <UButton size="sm" color="neutral" variant="outline" @click="tab = 'discover'">
            {{ t.models.enabled.goDiscover }}
          </UButton>
        </div>
      </section>
      <p v-else-if="!shown.length" class="py-6 text-center text-sm text-muted">
        {{ t.models.filter.none }}
      </p>
      <section v-else class="lw-card overflow-hidden">
        <ModelCard v-for="m in shown" :key="m.id" :model="m" />
      </section>
    </template>

    <div v-else ref="discoverEl" class="scroll-mt-4">
      <DiscoverPanel ref="discover" :filter="needle" />
    </div>
  </div>
</template>
