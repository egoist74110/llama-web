<script setup lang="ts">
// "Recommend again for this machine": shows old -> recommended for the global launch defaults,
// one checkbox per item. Opening only reads; confirming writes just the ticked items, closing writes nothing.
import t from '~~/i18n/zh-CN'
import type { RetuneItem, RetunePlan } from '~~/server/core/retune'

const open = defineModel<boolean>('open', { default: false })

const s = t.settings.defaults.retune
const { doc } = useSettings()
const ui = usePlatformUi()
const toast = useToast()
const plan = ref<RetunePlan | null>(null)
const loadError = ref('')
const ticked = ref<string[]>([])
const busy = ref(false)

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

watch(open, async (o) => {
  if (!o) return
  plan.value = null
  loadError.value = ''
  try {
    plan.value = await $fetch<RetunePlan>('/api/settings/retune')
    ticked.value = plan.value.items.map(i => i.id)
  } catch (e) {
    loadError.value = messageOf(e)
  }
}, { immediate: true })

const groups = computed(() => {
  const items = plan.value?.items ?? []
  const label = (scope: string) => (!ui.value.hasCpuChannel ? s.macGroup : scope === 'defaults' ? s.gpuGroup : s.cpuGroup)
  return (['defaults', 'defaultsCpu'] as const)
    .map(scope => ({ scope, label: label(scope), items: items.filter(i => i.scope === scope) }))
    .filter(g => g.items.length)
})

const show = (v: RetuneItem['from'], extra = false) => (v === null || v === '' ? (extra ? s.empty : s.unset) : String(v))

async function confirm() {
  if (busy.value || !ticked.value.length) return
  busy.value = true
  try {
    const r = await $fetch<{ applied: number, settings: typeof doc.value }>('/api/settings/retune', { method: 'POST', body: { ids: ticked.value } })
    doc.value = r.settings
    toast.add({ title: fmt(s.applied, { count: r.applied }), color: 'success', icon: 'i-lucide-check' })
    open.value = false
  } catch (e) {
    toast.add({ title: s.failed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="s.title" :description="s.body">
    <template #body>
      <p v-if="loadError" class="m-0 text-sm text-error">
        {{ s.loadFailed }}{{ loadError }}
      </p>
      <USkeleton v-else-if="!plan" class="h-12 w-full" />
      <div v-else class="space-y-4 text-sm">
        <p v-if="!plan.items.length" class="m-0 text-muted">
          {{ plan.detected ? s.none : s.undetected }}
        </p>
        <section v-for="g in groups" :key="g.scope" class="space-y-2">
          <h4 class="m-0 text-sm font-medium text-highlighted">
            {{ g.label }}
          </h4>
          <label v-for="i in g.items" :key="i.id" class="flex items-start gap-2">
            <UCheckbox v-model="ticked" :value="i.id" class="mt-0.5" :aria-label="`${g.label} ${s[i.field]}`" />
            <span class="min-w-0 flex-1">
              <span class="text-default">{{ s[i.field] }}</span>
              <span class="block break-all font-mono text-xs text-muted">{{ show(i.from, i.field === 'extraArgs') }} → {{ show(i.to, i.field === 'extraArgs') }}</span>
              <span v-if="i.field === 'extraArgs'" class="block text-xs text-muted">{{ s.extraArgsNote }}</span>
            </span>
          </label>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="outline" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton :disabled="!ticked.length || !plan?.items.length" :loading="busy" @click="confirm">
          {{ s.apply }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
