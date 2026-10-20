<script setup lang="ts">
// 知识库: knowledge bases, their documents (upload in the browser) and a search test (decision 65).
// The list is fetched from /api/kb; useLive() only tells when something changed: a job (import / re-index) that starts,
// moves on or ends, or the embedding engine switching, triggers one re-fetch. Nothing here polls.
import { t } from '../composables/useLocale'
import type { KbView, KbJobView } from '~~/server/core/kb/manager'
import { jobsKey, KB_SOFT_CHUNK_LIMIT } from '~/utils/kb'

const p = t.kb.page
const { state } = useLive()
const toast = useToast()

const bases = ref<KbView[] | null>(null)
const selectedId = ref<string | null>(null)
const selected = computed(() => bases.value?.find(b => b.id === selectedId.value) ?? null)
const jobs = computed<KbJobView[]>(() => state.value?.kb?.jobs ?? [])
const engineOff = computed(() => !!state.value && !state.value.embedding?.enabled)

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

let seq = 0
async function load() {
  const my = ++seq
  try {
    const r = await $fetch<{ bases: KbView[] }>('/api/kb')
    if (my !== seq) return
    bases.value = r.bases
    if (!r.bases.some(b => b.id === selectedId.value)) selectedId.value = r.bases[0]?.id ?? null
  } catch (e) {
    if (my === seq) toast.add({ title: p.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  }
}
onMounted(() => load())

const docsPanel = ref<{ reload: () => Promise<void> } | null>(null)
// The one live-driven refresh: job identity (not progress) or the engine changed.
watch(() => `${jobsKey(jobs.value)}#${state.value?.embedding?.enabled ? state.value.embedding.name : ''}`, () => {
  if (!bases.value) return
  void load()
  void docsPanel.value?.reload()
})

// ---- create / edit ----
const editorOpen = ref(false)
const editing = ref<KbView | null>(null)
function openCreate() { editing.value = null; editorOpen.value = true }
function openEdit(kb: KbView) { editing.value = kb; editorOpen.value = true }
async function onSaved(kb: KbView, created: boolean) {
  if (created) selectedId.value = kb.id
  await load()
}

// ---- reindex ----
const reindexing = ref<Record<string, boolean>>({})
async function reindex(kb: KbView) {
  if (reindexing.value[kb.id]) return
  reindexing.value = { ...reindexing.value, [kb.id]: true }
  try {
    await $fetch(`/api/kb/${encodeURIComponent(kb.id)}/reindex`, { method: 'POST' })
    toast.add({ title: fmt(p.flags.reindexStarted, { name: kb.name }), color: 'success', icon: 'i-lucide-check' })
    await load()
  } catch (e) {
    toast.add({ title: p.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    const { [kb.id]: _done, ...rest } = reindexing.value
    reindexing.value = rest
  }
}

// ---- delete ----
const removing = ref<KbView | null>(null)
const removeOpen = computed({ get: () => removing.value !== null, set: (v: boolean) => { if (!v) removing.value = null } })
const removeBusy = ref(false)
async function confirmRemove() {
  const kb = removing.value
  if (!kb || removeBusy.value) return
  removeBusy.value = true
  try {
    await $fetch(`/api/kb/${encodeURIComponent(kb.id)}`, { method: 'DELETE' })
    toast.add({ title: fmt(p.remove.done, { name: kb.name }), color: 'success', icon: 'i-lucide-check' })
    removing.value = null
    await load()
  } catch (e) {
    toast.add({ title: p.remove.failed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    removeBusy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-[18px]">
    <PageHeader :title="p.title" :subtitle="p.subtitle">
      <template #actions>
        <UButton icon="i-lucide-plus" @click="openCreate">
          {{ p.list.create }}
        </UButton>
      </template>
    </PageHeader>

    <div v-if="engineOff" class="lw-card flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
      <UIcon name="i-lucide-info" class="size-4 shrink-0 text-warning" />
      <span class="min-w-0 flex-1 basis-60">{{ p.engineOff }}</span>
      <NuxtLink to="/models?tab=embedding" class="text-primary">
        {{ p.engineOffLink }}
      </NuxtLink>
    </div>

    <AppCard :title="p.list.title">
      <div v-if="!bases" class="flex flex-col gap-2">
        <USkeleton class="h-14 w-full" />
        <USkeleton class="h-14 w-full" />
      </div>
      <div v-else-if="!bases.length">
        <p class="m-0 text-sm">
          {{ p.list.empty }}
        </p>
        <p class="mb-0 mt-1 text-[13px] text-muted">
          {{ p.list.emptyHint }}
        </p>
      </div>
      <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
        <li
          v-for="kb in bases"
          :key="kb.id"
          class="rounded-[12px] border px-3.5 py-3 transition-colors"
          :class="kb.id === selectedId ? 'border-primary/60 bg-primary/5' : 'border-default'"
        >
          <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
            <button type="button" class="min-w-0 flex-1 basis-56 cursor-pointer border-0 bg-transparent p-0 text-left" :aria-pressed="kb.id === selectedId" :title="p.list.select" @click="selectedId = kb.id">
              <span class="block break-words text-sm font-semibold">{{ kb.name }}</span>
              <span class="mt-0.5 block break-words text-xs text-muted">{{ kb.description || p.list.noDescription }}</span>
              <span class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dimmed">
                <span class="lw-num">{{ fmt(p.list.docs, { n: kb.docCount }) }}</span>
                <span class="lw-num">{{ fmt(p.list.chunks, { n: kb.chunkCount }) }}</span>
                <span v-if="kb.busy" class="lw-st lw-st-loading">{{ p.flags.busy }}</span>
              </span>
            </button>
            <div class="flex shrink-0 flex-wrap items-center gap-1">
              <UButton v-if="kb.reindexNeeded" size="xs" color="warning" variant="soft" icon="i-lucide-refresh-cw" :loading="!!reindexing[kb.id]" :disabled="kb.busy" @click="reindex(kb)">
                {{ p.flags.reindex }}
              </UButton>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="p.form.edit" :title="p.form.edit" @click="openEdit(kb)" />
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="p.remove.button" :title="p.remove.button" @click="removing = kb" />
            </div>
          </div>
          <p v-if="kb.reindexNeeded" class="m-0 mt-2 text-xs text-warning">
            <span class="font-medium">{{ p.flags.reindexNeeded }}</span> · {{ p.flags.reindexHint }}
          </p>
          <p v-if="kb.oversize" class="m-0 mt-1.5 text-xs text-warning">
            {{ fmt(p.flags.oversize, { n: KB_SOFT_CHUNK_LIMIT.toLocaleString() }) }}
          </p>
        </li>
      </ul>
    </AppCard>

    <KbDocs v-if="selected" ref="docsPanel" :key="selected.id" :kb="selected" :jobs="jobs" @changed="load" />
    <AppCard v-else-if="bases?.length" :title="p.docs.title">
      <p class="m-0 text-sm text-muted">
        {{ p.docs.pick }}
      </p>
    </AppCard>

    <KbSearch :kbs="bases ?? []" :selected-id="selectedId" />

    <KbEditor v-model:open="editorOpen" :kb="editing" @saved="onSaved" />
    <KbConfirm
      v-model:open="removeOpen"
      :title="fmt(p.remove.title, { name: removing?.name ?? '' })"
      :body="p.remove.body"
      :confirm-label="p.remove.confirm"
      :cancel-label="p.remove.cancel"
      :busy="removeBusy"
      @confirm="confirmRemove"
    />
  </div>
</template>
