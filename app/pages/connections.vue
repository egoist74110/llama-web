<script setup lang="ts">
// 接入: external OpenAI-compatible upstreams (decision 56). The list comes from useLive() (state.connections, probed
// every few seconds on the server); writes go to /api/upstreams and the answer is picked up by the next snapshot.
import t from '~~/i18n/zh-CN'
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

const compressModes: Array<{ value: ImageCompressMode, label: string }> = [
  { value: 'inherit', label: p.compress.inherit },
  { value: 'on', label: p.compress.on },
  { value: 'off', label: p.compress.off },
]

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
