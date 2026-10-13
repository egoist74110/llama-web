<script setup lang="ts">
// Getting-started guide with two paths: local models (model directory, llama.cpp, enable a model, start) or
// external APIs only (add a service, read its models, point the client here; no llama.cpp needed). Each step is
// ticked off by what is actually configured. Finishing or skipping marks the guide done: its menu entry and this page are gone.
import { t } from '../composables/useLocale'
import type { ConnectionView } from '~~/server/core/upstreams'
import { apiAddress } from '~/utils/overview'

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

// Which path is shown: the user's pick, else external APIs when only those are configured.
const connections = computed<ConnectionView[]>(() => state.value?.connections ?? [])
const picked = ref<'local' | 'gateway' | null>(null)
const mode = computed(() => picked.value ?? (connections.value.length && !modelCount.value ? 'gateway' : 'local'))
const modes = computed(() => [
  { value: 'local' as const, icon: 'i-lucide-cpu', label: s.mode.local, hint: s.mode.localHint },
  { value: 'gateway' as const, icon: 'i-lucide-plug', label: s.mode.gateway, hint: s.mode.gatewayHint },
])

const idsOf = (u: ConnectionView) => [...u.models, ...u.manualModels]
const gatewayModels = computed(() => connections.value.flatMap(u => idsOf(u).map(id => `${u.name}-${id}`)))
const gatewayDone = computed(() => [connections.value.length > 0, gatewayModels.value.length > 0, false])
const gatewayCurrent = computed(() => gatewayDone.value.findIndex(d => !d))
const apiUrl = computed(() => (import.meta.client ? apiAddress(window.location.origin, state.value?.network?.lanHost) : ''))

const editorOpen = ref(false)
const testing = ref<string | null>(null)

// Same as the Connections page: a new service is tested once right away, which fills its model list.
function onSaved(name: string, createdId: string | null, isNew: boolean) {
  toast.add({ title: fmt(isNew ? t.upstreams.page.added : t.upstreams.page.saved, { name }), color: 'success', icon: 'i-lucide-check' })
  if (isNew && createdId) void $fetch(`/api/upstreams/${encodeURIComponent(createdId)}/test`, { method: 'POST' }).catch(() => {})
}

async function testUpstream(u: ConnectionView) {
  if (testing.value) return
  testing.value = u.id
  try {
    const r = await $fetch<{ test: { ok: boolean, message: string } }>(`/api/upstreams/${encodeURIComponent(u.id)}/test`, { method: 'POST' })
    toast.add({ title: u.name, description: r.test.message, color: r.test.ok ? 'success' : 'error', icon: r.test.ok ? 'i-lucide-check' : 'i-lucide-circle-alert' })
  } catch (e) {
    errorToast(t.upstreams.page.testFailed, e)
  } finally {
    testing.value = null
  }
}

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

// A finished guide is not offered again (also when this page is opened by its address).
watch(() => state.value?.setupDone, (d) => { if (d) void navigateTo('/', { replace: true }) }, { immediate: true })
// Something is set up on the chosen path: the button finishes the guide instead of skipping it.
const progressed = computed(() => (mode.value === 'gateway' ? connections.value.length > 0 : modelCount.value > 0))

async function skip() {
  if (await save('wizard-done', { setupDone: true }, { quiet: true })) await navigateTo('/')
}
</script>

<template>
  <div class="mx-auto max-w-[760px] space-y-5">
    <PageHeader :title="s.title" :subtitle="s.subtitle" />

    <div class="grid gap-3 sm:grid-cols-2" role="radiogroup" :aria-label="s.mode.label">
      <button
        v-for="m in modes" :key="m.value" type="button" role="radio" :aria-checked="mode === m.value"
        class="lw-card lw-mode flex gap-3 px-4 py-3.5 text-left" :class="{ 'is-on': mode === m.value }"
        @click="picked = m.value"
      >
        <UIcon :name="m.icon" class="mt-0.5 size-5 shrink-0" :class="mode === m.value ? 'text-[var(--lw-accent-ink)]' : 'text-muted'" />
        <span class="min-w-0">
          <span class="block text-[15px] font-semibold">{{ m.label }}</span>
          <span class="mt-1 block text-xs text-muted">{{ m.hint }}</span>
        </span>
      </button>
    </div>

    <ol v-if="mode === 'gateway'" class="m-0 list-none space-y-3 p-0">
      <!-- 1 · add a service -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': gatewayCurrent === 0 }">
        <span class="lw-step-badge" :class="{ 'is-done': gatewayDone[0] }">
          <UIcon v-if="gatewayDone[0]" name="i-lucide-check" class="size-4" />
          <template v-else>1</template>
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.gateway.add.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.gateway.add.hint }}
          </p>
          <p v-if="connections.length" class="m-0 mt-3 text-sm text-success">
            {{ fmt(s.gateway.add.added, { names: connections.map(u => u.name).join(', ') }) }}
          </p>
          <UButton class="mt-2.5" icon="i-lucide-plus" :color="connections.length ? 'neutral' : 'primary'" :variant="connections.length ? 'outline' : 'solid'" @click="editorOpen = true">
            {{ s.gateway.add.go }}
          </UButton>
        </div>
      </li>

      <!-- 2 · read its models -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': gatewayCurrent === 1 }">
        <span class="lw-step-badge" :class="{ 'is-done': gatewayDone[1] }">
          <UIcon v-if="gatewayDone[1]" name="i-lucide-check" class="size-4" />
          <template v-else>2</template>
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.gateway.models.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.gateway.models.hint }}
          </p>
          <p v-if="!connections.length" class="m-0 mt-3 text-sm text-dimmed">
            {{ s.gateway.models.needAdd }}
          </p>
          <template v-else>
            <p v-if="gatewayModels.length" class="m-0 mt-3 text-sm text-success">
              {{ fmt(s.gateway.models.ready, { count: gatewayModels.length }) }}
            </p>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <UButton
                v-for="u in connections" :key="u.id" color="neutral" variant="outline" icon="i-lucide-plug-zap"
                :loading="testing === u.id" :disabled="!!testing" @click="testUpstream(u)"
              >
                {{ t.upstreams.page.test }} · {{ u.name }}
              </UButton>
              <UButton color="neutral" variant="ghost" icon="i-lucide-arrow-right" to="/connections">
                {{ s.gateway.models.go }}
              </UButton>
            </div>
          </template>
        </div>
      </li>

      <!-- 3 · point the client here -->
      <li class="lw-card flex gap-4 px-5 py-[18px]" :class="{ 'lw-step-current': gatewayCurrent === 2 }">
        <span class="lw-step-badge">3</span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-[15px] font-semibold">
            {{ s.gateway.client.title }}
          </h2>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ s.gateway.client.hint }}
          </p>
          <dl class="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt class="text-muted">
              {{ s.gateway.client.baseUrl }}
            </dt>
            <dd class="m-0 break-all font-mono">
              {{ apiUrl }}
            </dd>
            <dt class="text-muted">
              {{ s.gateway.client.model }}
            </dt>
            <dd class="m-0 break-all font-mono">
              {{ gatewayModels[0] ?? s.gateway.client.modelExample }}
            </dd>
            <dt class="text-muted">
              {{ s.gateway.client.key }}
            </dt>
            <dd class="m-0">
              {{ s.gateway.client.keyValue }}
            </dd>
          </dl>
        </div>
      </li>
    </ol>

    <ol v-else class="m-0 list-none space-y-3 p-0">
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

    <div class="mt-5 flex flex-wrap items-center gap-3">
      <UButton
        :color="progressed ? 'primary' : 'neutral'" :variant="progressed ? 'solid' : 'outline'"
        :loading="saving === 'wizard-done'" @click="skip"
      >
        {{ progressed ? s.finish : s.skip }}
      </UButton>
      <span class="text-xs text-dimmed">{{ progressed ? s.finishHint : s.skipHint }}</span>
    </div>

    <UpstreamEditor v-model:open="editorOpen" :upstream="null" @saved="onSaved" />
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
.lw-mode { cursor: pointer; transition: border-color .15s; }
.lw-mode:hover { border-color: var(--lw-border-strong); }
.lw-mode.is-on { border-color: var(--lw-accent); }
</style>
