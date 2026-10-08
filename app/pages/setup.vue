<script setup lang="ts">
// Getting-started guide: four steps (model directory, llama.cpp, enable a model, start), each ticked
// off by what is actually configured. The menu entry disappears once a model has been added.
import { t } from '../composables/useLocale'

const s = t.setup
const { state } = useLive()
const { doc, saving, load, save } = useSettings()
const { picking, pick } = usePickFolder()
const ui = usePlatformUi()
const toast = useToast()

onMounted(load)

const path = ref('')
const found = ref<number | null>(null)
const scanning = ref(false)
const downloading = ref(false)

const dirCount = computed(() => doc.value?.modelDirs.length ?? 0)
const modelCount = computed(() => state.value?.models.length ?? 0)
const runtimeTag = computed(() => state.value?.llamacpp.current || '')
const runtimeStatus = computed(() => state.value?.llamacpp.runtime)
const runtimeBusy = computed(() => downloading.value || runtimeStatus.value?.state === 'working')
const pathHint = computed(() => (ui.value.isMac ? t.platform.mac.setupPathHint : s.dir.pathHint))

const done = computed(() => [
  dirCount.value > 0 || modelCount.value > 0,
  !!runtimeTag.value,
  modelCount.value > 0,
  false,
])
// The first unfinished step is the one to act on.
const current = computed(() => done.value.findIndex(d => !d))

function errorToast(title: string, e: unknown) {
  const err = e as { data?: { message?: string }, message?: string }
  toast.add({ title, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
}

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
    errorToast(t.models.toast.scanFailed, e)
  } finally {
    scanning.value = false
  }
}

async function choose() {
  const picked = await pick()
  if (picked) await addDir(picked)
}

async function download() {
  if (runtimeBusy.value) return
  downloading.value = true
  try {
    await $fetch('/api/llamacpp/download', { method: 'POST', body: {} })
  } catch (e) {
    errorToast(s.runtime.failed, e)
  } finally {
    downloading.value = false
  }
}

async function skip() {
  if (await save('wizard-done', { setupDone: true }, { quiet: true })) await navigateTo('/')
}
</script>

<template>
  <div class="mx-auto max-w-[760px] space-y-5">
    <PageHeader :title="s.title" :subtitle="s.subtitle" />

    <ol class="m-0 list-none space-y-3 p-0">
      <!-- 1 · model directory -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': current === 0 }">
        <span class="lw-step-badge" :class="{ 'is-done': done[0] }">
          <UIcon v-if="done[0]" name="i-lucide-check" class="size-4" />
          <template v-else>1</template>
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.dir.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.dir.hint }}
          </p>
          <ul v-if="doc?.modelDirs.length" class="m-0 mt-3 list-none space-y-1 p-0">
            <li class="text-xs text-dimmed">
              {{ s.dir.added }}
            </li>
            <li v-for="d in doc.modelDirs" :key="d.id" class="break-all font-mono text-sm">
              {{ d.path }}
            </li>
          </ul>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <UButton icon="i-lucide-folder-open" :loading="picking" :disabled="!doc || scanning" @click="choose">
              {{ picking ? s.dir.picking : s.dir.pick }}
            </UButton>
          </div>
          <form class="mt-2.5 flex flex-wrap gap-2" @submit.prevent="addDir()">
            <UInput v-model="path" class="min-w-56 flex-1 font-mono" :placeholder="dirPathPlaceholder(ui.isMac)" :aria-label="s.dir.path" />
            <UButton type="submit" color="neutral" variant="outline" :disabled="!path.trim() || !doc" :loading="saving === 'wizard-dir' || scanning">
              {{ s.dir.add }}
            </UButton>
          </form>
          <p class="m-0 mt-2 text-xs text-muted">
            {{ pathHint }}
          </p>
          <p v-if="found !== null" class="m-0 mt-2 text-sm" :class="found ? 'text-success' : 'text-warning'">
            {{ found ? fmt(s.dir.found, { count: found }) : s.dir.foundNone }}
          </p>
        </div>
      </li>

      <!-- 2 · llama.cpp -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': current === 1 }">
        <span class="lw-step-badge" :class="{ 'is-done': done[1] }">
          <UIcon v-if="done[1]" name="i-lucide-check" class="size-4" />
          <template v-else>2</template>
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.runtime.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.runtime.hint }}
          </p>
          <p v-if="runtimeTag" class="m-0 mt-3 text-sm text-success">
            {{ fmt(s.runtime.installed, { tag: runtimeTag }) }}
          </p>
          <template v-else>
            <p class="m-0 mt-3 text-sm text-default">
              {{ runtimeBusy ? runtimeText(runtimeStatus) : s.runtime.missing }}
            </p>
            <UButton class="mt-2.5" icon="i-lucide-download" :loading="runtimeBusy" :disabled="runtimeBusy" @click="download">
              {{ runtimeBusy ? s.runtime.downloading : s.runtime.download }}
            </UButton>
          </template>
        </div>
      </li>

      <!-- 3 · enable a model -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': current === 2 }">
        <span class="lw-step-badge" :class="{ 'is-done': done[2] }">
          <UIcon v-if="done[2]" name="i-lucide-check" class="size-4" />
          <template v-else>3</template>
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.enable.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.enable.hint }}
          </p>
          <p v-if="modelCount" class="m-0 mt-3 text-sm text-success">
            {{ fmt(s.enable.enabled, { count: modelCount }) }}
          </p>
          <template v-else>
            <p v-if="!done[0]" class="m-0 mt-3 text-sm text-dimmed">
              {{ s.enable.needDir }}
            </p>
            <UButton v-else class="mt-2.5" icon="i-lucide-arrow-right" to="/models?tab=discover">
              {{ s.enable.go }}
            </UButton>
          </template>
        </div>
      </li>

      <!-- 4 · start -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': current === 3 }">
        <span class="lw-step-badge">4</span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.start.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.start.hint }}
          </p>
          <UButton v-if="modelCount" class="mt-2.5" icon="i-lucide-play" to="/models">
            {{ t.nav.models }}
          </UButton>
        </div>
      </li>
    </ol>

    <div v-if="!modelCount" class="mt-5 flex flex-wrap items-center gap-3">
      <UButton color="neutral" variant="outline" :loading="saving === 'wizard-done'" @click="skip">
        {{ s.skip }}
      </UButton>
      <span class="text-xs text-dimmed">{{ s.skipHint }}</span>
    </div>
  </div>
</template>

<style scoped>
.lw-step-badge {
  display: inline-flex; height: 28px; width: 28px; flex-shrink: 0; align-items: center; justify-content: center;
  border-radius: 999px; font-size: 13px; font-weight: 600; font-family: var(--font-mono, monospace);
  background: var(--lw-accent-soft); color: var(--lw-accent-ink);
}
.lw-step-badge.is-done { background: var(--lw-accent); color: #fff; }
.lw-step-current { border-color: var(--lw-accent); }
</style>
