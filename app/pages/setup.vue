<script setup lang="ts">
// First-run guide: what the three steps are, then step one (model directories: choose a folder or
// paste a path, as many as needed). Skipping or finishing marks it done so it is not offered again.
import t from '~~/i18n/zh-CN'

const s = t.setup
const { state } = useLive()
const { doc, saving, load, save } = useSettings()
const { picking, pick } = usePickFolder()
const toast = useToast()

onMounted(load)

const path = ref('')
const found = ref<number | null>(null)
const scanning = ref(false)
const steps = [s.steps.dir, s.steps.enable, s.steps.start]

async function addDir(raw = path.value) {
  const value = raw.trim().replace(/^"(.*)"$/, '$1')
  if (!value) return
  const dirs = (doc.value?.modelDirs ?? []).map(d => ({ id: d.id, path: d.path, enabled: d.enabled, maxDepth: d.maxDepth }))
  const ok = await save('wizard-dir', { modelDirs: [...dirs, { path: value, enabled: true, maxDepth: 3 }] }, { quiet: true })
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

async function choose() {
  const picked = await pick()
  if (picked) await addDir(picked)
}

async function leave(to: string) {
  if (await save('wizard-done', { setupDone: true }, { quiet: true })) await navigateTo(to)
}

// A directory is configured: offer to finish.
const configured = computed(() => (doc.value?.modelDirs.length ?? 0) > 0 || state.value?.firstRun === false)
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="s.title" :subtitle="s.subtitle" />

    <ol class="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3 p-0">
      <li v-for="(x, i) in steps" :key="i" class="lw-card flex gap-3 px-4 py-3.5">
        <span class="lw-chip lw-chip-accent h-6 w-6 shrink-0 justify-center font-mono">{{ i + 1 }}</span>
        <div class="min-w-0">
          <p class="m-0 text-sm font-semibold">
            {{ x.title }}
          </p>
          <p class="m-0 mt-0.5 text-xs text-muted">
            {{ x.body }}
          </p>
        </div>
      </li>
    </ol>

    <AppCard :title="s.dir.title" :hint="s.dir.hint">
      <ul v-if="doc?.modelDirs.length" class="m-0 mb-3 list-none space-y-1 p-0">
        <li class="text-xs text-dimmed">
          {{ s.dir.added }}
        </li>
        <li v-for="d in doc.modelDirs" :key="d.id" class="break-all font-mono text-sm">
          {{ d.path }}
        </li>
      </ul>
      <div class="flex flex-wrap items-center gap-2">
        <UButton icon="i-lucide-folder-open" :loading="picking" :disabled="!doc || scanning" @click="choose">
          {{ picking ? s.dir.picking : s.dir.pick }}
        </UButton>
      </div>
      <form class="mt-3 flex flex-wrap gap-2" @submit.prevent="addDir()">
        <UInput v-model="path" class="min-w-64 flex-1 font-mono" :placeholder="t.settings.dirs.pathPlaceholder" :aria-label="s.dir.path" />
        <UButton type="submit" color="neutral" variant="outline" :disabled="!path.trim() || !doc" :loading="saving === 'wizard-dir' || scanning">
          {{ s.dir.add }}
        </UButton>
      </form>
      <p class="mt-2 text-xs text-muted">
        {{ s.dir.pathHint }}
      </p>
      <p v-if="found !== null" class="mt-3 text-sm" :class="found ? 'text-success' : 'text-warning'">
        {{ found ? fmt(s.dir.found, { count: found }) : s.dir.foundNone }}
      </p>
    </AppCard>

    <AppCard :title="t.layout.llamacpp">
      <p class="text-sm text-default">
        {{ runtimeText(state?.llamacpp.runtime) || t.status.runtime.idle }}
      </p>
    </AppCard>

    <div class="flex flex-wrap items-center gap-2">
      <UButton v-if="configured" icon="i-lucide-arrow-right" :loading="saving === 'wizard-done'" @click="leave('/models?tab=discover')">
        {{ s.finish }}
      </UButton>
      <UButton v-else color="neutral" variant="ghost" :loading="saving === 'wizard-done'" @click="leave('/')">
        {{ s.skip }}
      </UButton>
    </div>
  </div>
</template>
