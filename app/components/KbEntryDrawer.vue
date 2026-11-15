<script setup lang="ts">
// Right-hand drawer for one entry: read it, edit it (or write a new one when `entryId` is null), look at its history,
// move it to the trash. Closing a draft with unsaved changes asks first.
import { t } from '../composables/useLocale'
import type { EntryView, TagCount } from '~~/server/core/kb/manager'
import { conflictOf } from '~/utils/kb'

type Mode = 'view' | 'edit' | 'history'

const props = defineProps<{ kbId: string, entryId: number | null, tagOptions: TagCount[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ changed: [] }>()

const e = t.kb.page.entry
const toast = useToast()

const mode = ref<Mode>('view')
const entry = ref<EntryView | null>(null)
const loadError = ref('')
const dirty = ref(false)
// Bumped on every start of editing, so the form takes the content as it is now.
const formKey = ref(0)
const discardOpen = ref(false)
const pending = ref<'close' | 'view'>('close')

const creating = computed(() => props.entryId === null)
const base = () => `/api/kb/${encodeURIComponent(props.kbId)}/entries`

let seq = 0
async function load() {
  const my = ++seq
  loadError.value = ''
  try {
    const r = await $fetch<EntryView>(`${base()}/${props.entryId}`)
    if (my === seq) entry.value = r
  } catch (err) {
    if (my !== seq) return
    loadError.value = messageOf(err)
    toast.add({ title: e.loadFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
  }
}

watch(() => [open.value, props.entryId] as const, ([isOpen]) => {
  if (!isOpen) return
  dirty.value = false
  discardOpen.value = false
  entry.value = null
  loadError.value = ''
  formKey.value++
  if (props.entryId === null) {
    mode.value = 'edit'
  } else {
    mode.value = 'view'
    void load()
  }
}, { immediate: true })

// ---- leaving a draft ----
function leave(to: 'close' | 'view') {
  if (mode.value === 'edit' && dirty.value) {
    pending.value = to
    discardOpen.value = true
    return
  }
  go(to)
}
function go(to: 'close' | 'view') {
  discardOpen.value = false
  dirty.value = false
  if (to === 'close' || creating.value) { open.value = false; return }
  // The draft may have met a newer version (409); show the entry as it is now, not as it was when editing began.
  mode.value = 'view'
  void load()
}
const guardedOpen = computed({
  get: () => open.value,
  set: (v: boolean) => { if (v) open.value = true; else leave('close') },
})

function startEdit() {
  formKey.value++
  dirty.value = false
  mode.value = 'edit'
}
function onSaved(r: EntryView) {
  emit('changed')
  dirty.value = false
  if (creating.value) { open.value = false; return }
  entry.value = r
  mode.value = 'view'
}
function onReverted(r: EntryView) {
  entry.value = r
  mode.value = 'view'
  emit('changed')
}
async function onStale() {
  await load()
  emit('changed')
}

// ---- move to the trash ----
const removeOpen = ref(false)
const removeBusy = ref(false)
async function remove() {
  const cur = entry.value
  if (!cur || removeBusy.value) return
  removeBusy.value = true
  try {
    await $fetch(`${base()}/${cur.id}`, { method: 'DELETE', query: { baseVersion: cur.version } })
    toast.add({ title: e.removed, color: 'success', icon: 'i-lucide-check' })
    removeOpen.value = false
    open.value = false
    emit('changed')
  } catch (err) {
    removeOpen.value = false
    if (conflictOf<EntryView>(err)) {
      toast.add({ title: e.reloaded, description: messageOf(err), color: 'warning', icon: 'i-lucide-circle-alert' })
      await load()
      emit('changed')
    } else {
      toast.add({ title: e.removeFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
    }
  } finally {
    removeBusy.value = false
  }
}

const headTitle = computed(() => (mode.value === 'history' ? t.kb.page.history.title : mode.value === 'edit' ? (creating.value ? e.newTitle : e.editTitle) : e.viewTitle))
const statusCls = (s: string) => ({ 'indexing': 'lw-st-loading', 'ready': 'lw-st-ready', 'failed': 'lw-st-failed', 'keyword-only': 'lw-st-stopped' }[s] ?? 'lw-st-stopped')
const statusText = (s: string) => (t.kb.page.docs.status as Record<string, string>)[s] ?? s
</script>

<template>
  <USlideover v-model:open="guardedOpen" :title="headTitle" :ui="{ content: 'w-full max-w-2xl' }">
    <template #body>
      <KbEntryForm
        v-if="mode === 'edit' && (creating || entry)"
        :key="formKey"
        v-model:dirty="dirty"
        :kb-id="kbId"
        :entry="entry"
        :tag-options="tagOptions"
        @saved="onSaved"
        @cancel="leave('view')"
      />

      <div v-else-if="!entry && !creating" class="flex flex-col gap-2">
        <p v-if="loadError" class="m-0 break-words text-sm text-error">
          {{ e.loadFailed }}<span class="ml-2 text-xs text-muted">{{ loadError }}</span>
        </p>
        <template v-else>
          <USkeleton class="h-6 w-2/3" />
          <USkeleton class="h-24 w-full" />
        </template>
      </div>

      <div v-else-if="entry && mode === 'history'" class="flex min-w-0 flex-col gap-4">
        <div>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-left" @click="mode = 'view'">
            {{ t.kb.page.history.back }}
          </UButton>
        </div>
        <p class="m-0 break-words text-sm font-semibold">
          {{ entry.title }}
        </p>
        <KbEntryHistory :kb-id="kbId" :entry="entry" @reverted="onReverted" @stale="onStale" />
      </div>

      <div v-else-if="entry" class="flex min-w-0 flex-col gap-4">
        <h3 class="m-0 break-words text-base font-semibold">
          {{ entry.title }}
        </h3>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-dimmed">
          <span class="lw-chip lw-num">{{ fmt(t.kb.page.entries.version, { n: entry.version }) }}</span>
          <span v-if="entry.status !== 'ready'" class="lw-st" :class="statusCls(entry.status)">{{ statusText(entry.status) }}</span>
          <span>{{ fmt(e.createdAt, { time: formatDateTime(entry.createdAt) }) }}</span>
          <span>{{ fmt(e.updatedAt, { time: formatDateTime(entry.updatedAt) }) }}</span>
        </div>
        <div v-if="entry.tags.length" class="flex flex-wrap gap-1.5">
          <span v-for="tag in entry.tags" :key="tag" class="lw-chip max-w-full"><span class="truncate">{{ tag }}</span></span>
        </div>
        <div class="whitespace-pre-wrap break-words rounded-[10px] bg-[var(--lw-sunken)] p-3 text-sm leading-relaxed">
          {{ entry.body }}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton size="sm" icon="i-lucide-pencil" @click="startEdit">
            {{ e.edit }}
          </UButton>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-history" @click="mode = 'history'">
            {{ e.history }}
          </UButton>
          <UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removeOpen = true">
            {{ e.remove }}
          </UButton>
        </div>
      </div>
    </template>

  </USlideover>

  <KbConfirm
    v-model:open="discardOpen"
    tone="neutral"
    :title="e.discardTitle"
    :body="e.discardBody"
    :confirm-label="e.discardConfirm"
    :cancel-label="e.keepEditing"
    @confirm="go(pending)"
  />
  <KbConfirm
    v-model:open="removeOpen"
    :title="fmt(e.removeTitle, { title: entry?.title ?? '' })"
    :body="e.removeBody"
    :confirm-label="e.removeConfirm"
    :cancel-label="e.cancel"
    :busy="removeBusy"
    @confirm="remove"
  />
</template>
