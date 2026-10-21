<script setup lang="ts">
// Documents of the selected knowledge base, plus the upload area. Progress comes from the live `kb` jobs the page passes
// in; the page re-fetches the list (reload) when a job starts, moves on or ends, so nothing here polls.
import { t } from '../composables/useLocale'
import type { DocView, KbJobView, KbView } from '~~/server/core/kb/manager'
import { checkKbFile, fileToBase64, KB_ACCEPT } from '~/utils/kb'

type Doc = DocView & { error: string | null }
interface UploadItem { id: number, kbId: string, kbName: string, name: string, size: number, state: 'waiting' | 'reading' | 'uploading' | 'done' | 'error', message: string }

const props = defineProps<{ kb: KbView, jobs: KbJobView[] }>()
const emit = defineEmits<{ changed: [] }>()

const d = t.kb.page.docs
const u = t.kb.page.upload
const f = t.kb.page.flags
const TAGS_SHOWN = 5
const toast = useToast()

const docs = ref<Doc[] | null>(null)
let seq = 0

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

async function reload() {
  const my = ++seq
  const id = props.kb.id
  try {
    const r = await $fetch<{ docs: Doc[] }>(`/api/kb/${encodeURIComponent(id)}/docs`)
    if (my === seq) docs.value = r.docs
  } catch (e) {
    if (my === seq) toast.add({ title: t.kb.page.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  }
}
watch(() => props.kb.id, () => { docs.value = null; void reload() }, { immediate: true })
defineExpose({ reload })

// Live job of a document (import) and of the whole knowledge base (re-index).
const jobOf = (docId: number) => props.jobs.find(j => j.kbId === props.kb.id && j.docId === docId)
const reindexJob = computed(() => props.jobs.find(j => j.kbId === props.kb.id && j.kind === 'reindex'))

function progressOf(doc: Doc): { done: number, total: number } | null {
  const j = jobOf(doc.id) ?? reindexJob.value
  if (j?.state === 'running') return { done: j.done, total: j.total }
  return doc.progress
}
const queued = (doc: Doc) => {
  const j = jobOf(doc.id) ?? reindexJob.value
  return doc.status === 'indexing' && j?.state === 'queued'
}
const statusCls = (s: string) => ({ 'indexing': 'lw-st-loading', 'ready': 'lw-st-ready', 'failed': 'lw-st-failed', 'keyword-only': 'lw-st-stopped' }[s] ?? 'lw-st-stopped')
const statusText = (s: string) => (d.status as Record<string, string>)[s] ?? s

// ---- upload ----
const items = ref<UploadItem[]>([])
const queue: Array<{ item: UploadItem, file: File }> = []
let pumping = false
let nextId = 1
const dragging = ref(false)
const picker = ref<HTMLInputElement | null>(null)

function patch(id: number, p: Partial<UploadItem>) {
  items.value = items.value.map(x => (x.id === id ? { ...x, ...p } : x))
}

function addFiles(files: File[]) {
  for (const file of files) {
    const bad = checkKbFile(file.name, file.size)
    const item: UploadItem = { id: nextId++, kbId: props.kb.id, kbName: props.kb.name, name: file.name, size: file.size, state: bad ? 'error' : 'waiting', message: bad === 'too-large' ? u.tooLarge : bad === 'unsupported' ? u.unsupported : '' }
    items.value = [...items.value, item]
    if (!bad) queue.push({ item, file })
  }
  if (!pumping) void pump()
}

async function pump() {
  pumping = true
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { item, file } = next
      try {
        patch(item.id, { state: 'reading' })
        const contentBase64 = await fileToBase64(file)
        patch(item.id, { state: 'uploading' })
        await $fetch(`/api/kb/${encodeURIComponent(item.kbId)}/docs`, { method: 'POST', body: { name: file.name, contentBase64, mtime: file.lastModified } })
        patch(item.id, { state: 'done', message: '' })
        if (item.kbId === props.kb.id) void reload()
        emit('changed')
      } catch (e) {
        const fromServer = (e as { data?: { message?: string } })?.data?.message
        patch(item.id, { state: 'error', message: fromServer ?? (e instanceof DOMException ? u.readFailed : messageOf(e)) })
      }
    }
  } finally {
    pumping = false
  }
}

function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}
function onDrop(ev: DragEvent) {
  dragging.value = false
  addFiles(Array.from(ev.dataTransfer?.files ?? []))
}
function onLeave(ev: DragEvent) {
  const to = ev.relatedTarget as Node | null
  if (!to || !(ev.currentTarget as Node).contains(to)) dragging.value = false
}
const clearable = computed(() => items.value.some(x => x.state === 'done' || x.state === 'error'))
const clearItems = () => { items.value = items.value.filter(x => x.state !== 'done' && x.state !== 'error') }
const itemText = (x: UploadItem) => ({ waiting: '…', reading: u.reading, uploading: u.uploading, done: u.done, error: u.failed }[x.state])

// ---- remove ----
const removing = ref<Doc | null>(null)
const removeOpen = computed({ get: () => removing.value !== null, set: (v: boolean) => { if (!v) removing.value = null } })
const removeBusy = ref(false)
async function confirmRemove() {
  const doc = removing.value
  if (!doc || removeBusy.value) return
  removeBusy.value = true
  try {
    await $fetch(`/api/kb/${encodeURIComponent(props.kb.id)}/docs/${doc.id}`, { method: 'DELETE' })
    toast.add({ title: fmt(d.removed, { name: doc.name }), color: 'success', icon: 'i-lucide-check' })
    removing.value = null
    void reload()
    emit('changed')
  } catch (e) {
    toast.add({ title: d.removeFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    removeBusy.value = false
  }
}
</script>

<template>
  <AppCard :title="fmt(d.titleOf, { name: kb.name })">
    <!-- Upload -->
    <div
      class="flex flex-col items-center gap-2 rounded-[12px] border border-dashed px-4 py-5 text-center transition-colors"
      :class="dragging ? 'border-primary bg-primary/5' : 'border-default bg-elevated/40'"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave="onLeave"
      @drop.prevent="onDrop"
    >
      <UIcon name="i-lucide-file-up" class="size-6 text-dimmed" />
      <p class="m-0 text-sm">
        {{ dragging ? u.dropActive : u.drop }}
      </p>
      <p class="m-0 text-xs text-muted">
        {{ u.hint }}
      </p>
      <UButton size="sm" icon="i-lucide-upload" @click="picker?.click()">
        {{ u.button }}
      </UButton>
      <input ref="picker" type="file" multiple class="hidden" :accept="KB_ACCEPT" :aria-label="u.button" @change="onPick">
    </div>

    <ul v-if="items.length" class="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
      <li v-for="x in items" :key="x.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <UIcon :name="x.state === 'done' ? 'i-lucide-check' : x.state === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-loader-circle'" class="size-3.5 shrink-0 translate-y-0.5" :class="[x.state === 'done' ? 'text-success' : x.state === 'error' ? 'text-error' : 'text-dimmed animate-spin']" />
        <span class="min-w-0 break-all font-medium">{{ x.name }}</span>
        <span class="lw-num text-xs text-dimmed">{{ formatBytes(x.size) }}</span>
        <span v-if="x.kbId !== kb.id" class="text-xs text-dimmed">→ {{ x.kbName }}</span>
        <span class="text-xs" :class="x.state === 'error' ? 'text-error' : 'text-muted'">{{ itemText(x) }}</span>
        <span v-if="x.message" class="basis-full pl-5 text-xs text-error">{{ x.message }}</span>
      </li>
    </ul>
    <div v-if="clearable" class="mt-1.5">
      <UButton size="xs" color="neutral" variant="ghost" @click="clearItems">
        {{ u.clear }}
      </UButton>
    </div>

    <!-- Re-index progress of the whole knowledge base -->
    <div v-if="reindexJob" class="mt-4 flex flex-col gap-1">
      <span class="text-xs text-muted">{{ reindexJob.state === 'queued' ? d.queued : fmt(f.reindexing, { done: reindexJob.done, total: reindexJob.total }) }}</span>
      <UProgress :model-value="reindexJob.done" :max="Math.max(1, reindexJob.total)" size="xs" />
    </div>

    <!-- Documents -->
    <div class="mt-4">
      <div v-if="!docs" class="flex flex-col gap-2">
        <USkeleton class="h-10 w-full" />
        <USkeleton class="h-10 w-full" />
      </div>
      <p v-else-if="!docs.length" class="m-0 text-sm text-muted">
        {{ d.empty }}
      </p>
      <ul v-else class="m-0 flex list-none flex-col divide-y divide-default p-0">
        <li v-for="doc in docs" :key="doc.id" class="flex flex-col gap-1.5 py-2.5">
          <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span class="min-w-0 flex-1 basis-40 break-all text-sm font-medium">{{ doc.name }}</span>
            <span class="lw-st" :class="statusCls(doc.status)">{{ statusText(doc.status) }}</span>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="d.remove" :title="d.remove" @click="removing = doc" />
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dimmed">
            <span class="lw-num">{{ formatBytes(doc.size) }}</span>
            <span class="lw-num">{{ fmt(d.chunks, { n: doc.chunkCount }) }}</span>
            <span class="lw-num">{{ fmt(d.vectors, { done: doc.vectorCount, total: doc.chunkCount }) }}</span>
            <span v-if="!doc.hasRaw" class="text-muted">{{ d.noRaw }}</span>
          </div>
          <div v-if="doc.tags.length" class="flex flex-wrap items-center gap-1">
            <span v-for="tag in doc.tags.slice(0, TAGS_SHOWN)" :key="tag" class="lw-chip max-w-full"><span class="truncate">{{ tag }}</span></span>
            <span v-if="doc.tags.length > TAGS_SHOWN" class="lw-chip">{{ fmt(d.tagsMore, { n: doc.tags.length - TAGS_SHOWN }) }}</span>
          </div>
          <template v-if="doc.status === 'indexing'">
            <span v-if="queued(doc)" class="text-xs text-muted">{{ d.queued }}</span>
            <template v-else-if="progressOf(doc)">
              <UProgress :model-value="progressOf(doc)!.done" :max="Math.max(1, progressOf(doc)!.total)" size="xs" />
              <span class="lw-num text-xs text-muted">{{ fmt(d.indexing, progressOf(doc)!) }}</span>
            </template>
          </template>
          <p v-if="doc.error && doc.status !== 'ready'" class="m-0 text-xs break-words" :class="doc.status === 'failed' ? 'text-error' : 'text-warning'">
            {{ doc.error }}
          </p>
        </li>
      </ul>
    </div>

    <KbConfirm
      v-model:open="removeOpen"
      :title="fmt(d.removeTitle, { name: removing?.name ?? '' })"
      :body="d.removeBody"
      :confirm-label="d.removeConfirm"
      :cancel-label="t.kb.page.remove.cancel"
      :busy="removeBusy"
      @confirm="confirmRemove"
    />
  </AppCard>
</template>
