<script setup lang="ts">
// 接入: external OpenAI-compatible upstreams (decision 56). The list comes from useLive() (state.connections, probed
// every few seconds on the server); writes go to /api/upstreams and the answer is picked up by the next snapshot.
import { t } from '../composables/useLocale'
import type { ConnectionView, ImageCompressMode } from '~~/server/core/upstreams'

const p = t.upstreams.page
const { state, serverNow } = useLive()
const toast = useToast()

const list = computed(() => state.value?.connections ?? [])
const holder = computed(() => state.value?.exclusiveHolder ?? null)

const busy = ref<Record<string, boolean>>({})
const editing = ref<ConnectionView | null>(null)
const editorOpen = ref(false)
const removing = ref<ConnectionView | null>(null)
const removeOpen = computed({
  get: () => removing.value !== null,
  set: (v: boolean) => { if (!v) removing.value = null },
})

const messageOf = (e: unknown) => {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const fail = (title: string, e: unknown) => toast.add({ title, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

async function run(key: string, fn: () => Promise<void>) {
  if (busy.value[key]) return
  busy.value = { ...busy.value, [key]: true }
  try {
    await fn()
  } finally {
    const { [key]: _done, ...rest } = busy.value
    busy.value = rest
  }
}

const url = (u: ConnectionView, action = '') => `/api/upstreams/${encodeURIComponent(u.id)}${action}`

// Shown at once; the next snapshot from the server replaces it.
const patched = reactive<Record<string, Partial<ConnectionView>>>({})
const rows = computed(() => list.value.map(u => ({ ...u, ...patched[u.id] }) as ConnectionView))
watch(list, () => { for (const k of Object.keys(patched)) delete patched[k] })

function change(u: ConnectionView, body: Partial<ConnectionView>) {
  return run(`edit:${u.id}`, async () => {
    patched[u.id] = { ...patched[u.id], ...body }
    try {
      await $fetch(url(u), { method: 'POST', body })
    } catch (e) {
      delete patched[u.id]
      fail(p.toggleFailed, e)
    }
  })
}

// A computed: the labels are read again when the interface language changes.
const compressModes = computed<Array<{ value: ImageCompressMode, label: string }>>(() => [
  { value: 'inherit', label: p.compress.inherit },
  { value: 'on', label: p.compress.on },
  { value: 'off', label: p.compress.off },
])

function test(u: ConnectionView) {
  return run(`test:${u.id}`, async () => {
    try {
      const r = await $fetch<{ test: { ok: boolean, message: string } }>(url(u, '/test'), { method: 'POST' })
      toast.add({ title: u.name, description: r.test.message, color: r.test.ok ? 'success' : 'error', icon: r.test.ok ? 'i-lucide-check' : 'i-lucide-circle-alert' })
    } catch (e) {
      fail(p.testFailed, e)
    }
  })
}

function openEditor(u: ConnectionView | null) {
  editing.value = u
  editorOpen.value = true
}

// A new upstream is tested right away so its model list shows without another click.
function onSaved(name: string, createdId: string | null, isNew: boolean) {
  toast.add({ title: fmt(isNew ? p.added : p.saved, { name }), color: 'success', icon: 'i-lucide-check' })
  if (isNew && createdId) {
    void $fetch(`/api/upstreams/${encodeURIComponent(createdId)}/test`, { method: 'POST' }).catch(() => {})
  }
}

// Manual start (decision 56 ⑩): confirm what will run, then follow `launch` in the live snapshot.
const starting = ref<ConnectionView | null>(null)
const startOpen = computed({
  get: () => starting.value !== null,
  set: (v: boolean) => { if (!v) starting.value = null },
})
const prevLaunch = new Map<string, string>()
watch(rows, (list) => {
  for (const u of list) {
    const was = prevLaunch.get(u.id)
    if (was === 'starting' && u.launch.state === 'idle' && u.up) toast.add({ title: fmt(p.start.done, { name: u.name }), color: 'success', icon: 'i-lucide-check' })
    prevLaunch.set(u.id, u.launch.state)
  }
})

function start() {
  const u = starting.value
  if (!u) return
  return run(`start:${u.id}`, async () => {
    try {
      await $fetch(url(u, '/start'), { method: 'POST' })
      starting.value = null
    } catch (e) {
      fail(p.start.startFailed, e)
    }
  })
}

function cancelStart(u: ConnectionView) {
  return run(`startcancel:${u.id}`, async () => {
    try {
      await $fetch(url(u, '/start-cancel'), { method: 'POST' })
    } catch (e) {
      fail(p.start.cancelFailed, e)
    }
  })
}

function stop(u: ConnectionView) {
  return run(`stop:${u.id}`, async () => {
    try {
      await $fetch(url(u, '/stop'), { method: 'POST' })
      toast.add({ title: fmt(p.start.stopped, { name: u.name }), color: 'success', icon: 'i-lucide-check' })
    } catch (e) {
      fail(p.start.stopFailed, e)
    }
  })
}

const canStart = (u: ConnectionView) => u.checkedAt !== null && !u.up
const waited = (u: ConnectionView) => (u.launch.state === 'starting' ? formatDuration(Math.max(0, serverNow.value - u.launch.since)) : '')
const launchFailure = (u: ConnectionView) => {
  const l = u.launch
  return l.state === 'failed' ? fmt(p.start.failed[l.code], { detail: l.detail }) : ''
}

function remove() {
  const u = removing.value
  if (!u) return
  return run(`remove:${u.id}`, async () => {
    try {
      await $fetch(url(u, '/remove'), { method: 'POST' })
      toast.add({ title: fmt(p.removed, { name: u.name }), color: 'success', icon: 'i-lucide-check' })
      removing.value = null
    } catch (e) {
      fail(p.removeFailed, e)
    }
  })
}

function status(u: ConnectionView) {
  if (u.checkedAt === null) return { cls: 'lw-st-loading', label: p.status.pending }
  return u.up ? { cls: 'lw-st-ready', label: p.status.up } : { cls: 'lw-st-failed', label: p.status.down }
}
const checkedText = (u: ConnectionView) => (u.checkedAt === null ? p.checkedNever : fmt(p.checked, { time: formatDuration(Math.max(0, serverNow.value - u.checkedAt)) }))
const testedText = (u: ConnectionView) => (u.testedAt ? fmt(p.tested, { time: new Date(u.testedAt).toLocaleString('zh-CN', { hour12: false }) }) : '')
const MAX_CHIPS = 8
const allModels = (u: ConnectionView) => [...new Set([...u.models, ...u.manualModels])]
const example = (u: ConnectionView) => `${u.name}-${allModels(u)[0] ?? 'model-id'}`
</script>

<template>
  <div class="flex flex-col gap-[18px]">
    <PageHeader :title="p.title" :subtitle="p.subtitle">
      <template #actions>
        <UButton icon="i-lucide-plus" @click="openEditor(null)">
          {{ p.add }}
        </UButton>
      </template>
    </PageHeader>

    <ExclusiveNotice :link="false" />

    <USkeleton v-if="!state" class="h-40 w-full" />
    <AppCard v-else-if="!rows.length" :title="p.empty" :hint="p.emptyHint">
      <UButton color="neutral" variant="outline" icon="i-lucide-plus" @click="openEditor(null)">
        {{ p.add }}
      </UButton>
    </AppCard>

    <AppCard v-for="u in rows" :key="u.id" :title="u.name" :hint="u.baseUrl">
      <template #actions>
        <span class="lw-st shrink-0" :class="status(u).cls">{{ status(u).label }}</span>
      </template>

      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
          <span class="lw-num">{{ allModels(u).length ? fmt(p.models, { n: allModels(u).length }) : p.modelsNone }}</span>
          <span>{{ checkedText(u) }}</span>
          <span v-if="testedText(u)">{{ testedText(u) }}</span>
          <a v-if="u.monitorUrl" :href="u.monitorUrl" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary" :title="p.monitorOpen">
            <UIcon name="i-lucide-external-link" class="size-3.5" />{{ p.monitor }}
          </a>
        </div>

        <div v-if="canStart(u) || u.launch.state !== 'idle' || (u.up && u.canStop)" class="flex flex-col gap-2 rounded-[10px] bg-[var(--lw-sunken)] px-3.5 py-3">
          <div v-if="u.launch.state === 'starting'" class="flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-2 text-[13px]">
              <UIcon name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin lw-dot-warn" />{{ fmt(p.start.waiting, { time: waited(u) }) }}
            </span>
            <UButton size="sm" color="neutral" variant="outline" :title="p.start.cancelHint" :loading="!!busy[`startcancel:${u.id}`]" @click="cancelStart(u)">
              {{ p.start.cancel }}
            </UButton>
          </div>
          <div v-else-if="u.up && u.canStop" class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted">{{ p.start.running }}</span>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-square" :title="p.start.stopHint" :loading="!!busy[`stop:${u.id}`]" @click="stop(u)">
              {{ p.start.stop }}
            </UButton>
          </div>
          <div v-else-if="u.startCommand" class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted">{{ p.start.hint }}</span>
            <UButton size="sm" icon="i-lucide-play" @click="starting = u">
              {{ p.start.button }}
            </UButton>
          </div>
          <div v-else class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted">{{ p.start.noCommand }}</span>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-terminal" @click="openEditor(u)">
              {{ p.start.setCommand }}
            </UButton>
          </div>
          <p v-if="launchFailure(u)" role="alert" class="m-0 text-xs text-error">
            {{ launchFailure(u) }}
          </p>
        </div>

        <p class="m-0 text-[13px] text-muted">
          {{ fmt(p.prefixHint, { name: u.name }) }}
          <span class="break-all font-mono text-xs text-dimmed">{{ fmt(p.prefixExample, { example: example(u) }) }}</span>
        </p>

        <div v-if="allModels(u).length" class="flex flex-wrap gap-1.5" :aria-label="p.modelsLabel">
          <span v-for="m in allModels(u).slice(0, MAX_CHIPS)" :key="m" class="lw-chip max-w-full break-all font-mono">{{ m }}</span>
          <span v-if="allModels(u).length > MAX_CHIPS" class="lw-chip">{{ fmt(p.modelsMore, { n: allModels(u).length - MAX_CHIPS }) }}</span>
        </div>

        <div class="flex flex-col gap-3 border-t border-default pt-3.5">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="m-0 text-[13px] font-medium">
                {{ p.local }}
              </p>
              <p class="m-0 mt-0.5 text-xs text-dimmed">
                {{ p.localHint }}
              </p>
            </div>
            <USwitch :model-value="u.local" :disabled="!!busy[`edit:${u.id}`]" :aria-label="p.local" @update:model-value="(v: boolean) => change(u, { local: v })" />
          </div>

          <div v-if="u.local" class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="m-0 text-[13px] font-medium">
                {{ p.exclusive }}
              </p>
              <p class="m-0 mt-0.5 text-xs text-dimmed">
                {{ p.exclusiveHint }}
              </p>
              <p v-if="holder === u.name" class="m-0 mt-1 text-xs lw-dot-warn">
                {{ p.exclusiveActive }}
              </p>
            </div>
            <USwitch :model-value="u.exclusive" :disabled="!!busy[`edit:${u.id}`]" :aria-label="p.exclusive" @update:model-value="(v: boolean) => change(u, { exclusive: v })" />
          </div>

          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div class="min-w-0">
              <p class="m-0 text-[13px] font-medium">
                {{ p.compress.label }}
              </p>
              <p class="m-0 mt-0.5 text-xs text-dimmed">
                {{ p.compressHint }}
              </p>
            </div>
            <div class="lw-seg" role="group" :aria-label="p.compress.label">
              <button
                v-for="m in compressModes"
                :key="m.value"
                type="button"
                :class="{ on: u.imageCompress === m.value }"
                :aria-pressed="u.imageCompress === m.value"
                :disabled="!!busy[`edit:${u.id}`]"
                @click="u.imageCompress !== m.value && change(u, { imageCompress: m.value })"
              >
                {{ m.label }}
              </button>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="m-0 text-[13px]">
              <span class="font-medium">{{ p.key.label }}</span>
              <span class="ml-2 text-xs" :class="u.hasKey ? 'text-success' : 'text-dimmed'">{{ u.hasKey ? p.key.saved : p.key.none }}</span>
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plug-zap" :loading="!!busy[`test:${u.id}`]" @click="test(u)">
                {{ p.test }}
              </UButton>
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-pencil" @click="openEditor(u)">
                {{ p.edit }}
              </UButton>
              <UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removing = u">
                {{ p.remove }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </AppCard>

    <UpstreamEditor v-model:open="editorOpen" :upstream="editing" @saved="onSaved" />

    <UModal v-model:open="startOpen" :title="starting ? fmt(p.start.confirmTitle, { name: starting.name }) : ''" :description="p.start.confirmBody">
      <template #body>
        <div v-if="starting" class="flex flex-col gap-2">
          <pre class="m-0 whitespace-pre-wrap break-all rounded-lg bg-[var(--lw-sunken)] p-3 font-mono text-xs">{{ starting.startCommand }}</pre>
          <p v-if="starting.startCwd" class="m-0 break-all text-xs text-muted">
            {{ fmt(p.start.confirmCwd, { cwd: starting.startCwd }) }}
          </p>
          <p v-if="starting.local && starting.exclusive" class="m-0 text-xs lw-dot-warn">
            {{ p.start.confirmExclusive }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="starting = null">
            {{ t.upstreams.form.cancel }}
          </UButton>
          <UButton icon="i-lucide-play" :loading="!!starting && !!busy[`start:${starting.id}`]" @click="start">
            {{ p.start.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="removeOpen" :title="removing ? fmt(t.upstreams.remove.title, { name: removing.name }) : ''" :description="removing ? fmt(t.upstreams.remove.body, { name: removing.name }) : ''">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">
            {{ t.upstreams.form.cancel }}
          </UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="!!removing && !!busy[`remove:${removing.id}`]" @click="remove">
            {{ t.upstreams.remove.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
