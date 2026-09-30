<script setup lang="ts">
// First-run wizard: make sure llama.cpp is coming, then either add a model directory or import
// the old swap-config.json. Skipping or finishing marks it done so it is not offered again.
import t from '~~/i18n/zh-CN'

const s = t.setup
const { state } = useLive()
const { doc, saving, load, save } = useSettings()
const toast = useToast()

onMounted(load)

const path = ref('')
const found = ref<number | null>(null)
const scanning = ref(false)

async function addDir() {
  const dirs = (doc.value?.modelDirs ?? []).map(d => ({ id: d.id, path: d.path, enabled: d.enabled, maxDepth: d.maxDepth }))
  const ok = await save('wizard-dir', { modelDirs: [...dirs, { path: path.value, enabled: true, maxDepth: 3 }] }, { quiet: true })
  if (!ok) return
  path.value = ''
  scanning.value = true
  try {
    const r = await $fetch<{ entries: Array<{ kind: string }> }>('/api/scan', { method: 'POST', body: {} })
    found.value = r.entries.filter(e => e.kind === 'model').length
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.models.toast.scanFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    scanning.value = false
  }
}

async function leave(to: string) {
  if (await save('wizard-done', { setupDone: true }, { quiet: true })) await navigateTo(to)
}

// Something is configured (a directory or imported models): offer to finish.
const configured = computed(() => state.value?.firstRun === false)
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="s.title" :subtitle="s.subtitle" />

    <AppCard :title="t.layout.llamacpp">
      <p class="text-sm text-default">
        {{ runtimeText(state?.llamacpp.runtime) || t.status.runtime.idle }}
      </p>
    </AppCard>

    <AppCard :title="s.dir.title" :hint="s.dir.hint">
      <form class="flex flex-wrap gap-2" @submit.prevent="addDir">
        <UInput v-model="path" class="min-w-64 flex-1 font-mono" :placeholder="t.settings.dirs.pathPlaceholder" :aria-label="s.dir.path" />
        <UButton type="submit" :disabled="!path.trim() || !doc" :loading="saving === 'wizard-dir' || scanning">
          {{ s.dir.add }}
        </UButton>
      </form>
      <p v-if="found !== null" class="mt-3 text-sm text-success">
        {{ fmt(s.dir.found, { count: found }) }}
      </p>
    </AppCard>

    <ImportCard />

    <div class="flex flex-wrap items-center gap-2">
      <UButton v-if="configured" icon="i-lucide-arrow-right" :loading="saving === 'wizard-done'" @click="leave('/models')">
        {{ s.finish }}
      </UButton>
      <UButton v-else color="neutral" variant="ghost" :loading="saving === 'wizard-done'" @click="leave('/')">
        {{ s.skip }}
      </UButton>
    </div>
  </div>
</template>
