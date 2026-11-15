<script setup lang="ts">
// Create or edit one entry (decision 69). An edit sends the `baseVersion` it opened with; when somebody else changed
// the entry meanwhile the server answers 409 with the current entry, and the draft stays so nothing typed is lost.
import { t } from '../composables/useLocale'
import type { EntryView, TagCount } from '~~/server/core/kb/manager'
import { addTagsFromInput, conflictOf, KB_MAX_ENTRY_BODY, KB_MAX_ENTRY_TAGS, KB_MAX_ENTRY_TITLE, sameTags } from '~/utils/kb'

const props = defineProps<{ kbId: string, entry: EntryView | null, tagOptions: TagCount[] }>()
const emit = defineEmits<{ saved: [entry: EntryView], cancel: [] }>()
/** True while the draft differs from what was loaded: the drawer asks before closing. */
const dirty = defineModel<boolean>('dirty', { default: false })

const e = t.kb.page.entry
const toast = useToast()
const uid = useId()

const title = ref(props.entry?.title ?? '')
const body = ref(props.entry?.body ?? '')
const tags = ref<string[]>([...(props.entry?.tags ?? [])])
const original = ref({ title: title.value, body: body.value, tags: [...tags.value] })
const baseVersion = ref(props.entry?.version ?? 0)
const conflict = ref<EntryView | null>(null)
const showCompare = ref(false)
const saving = ref(false)

const changed = computed(() => title.value !== original.value.title || body.value !== original.value.body || !sameTags(tags.value, original.value.tags))
watchEffect(() => { dirty.value = changed.value })

const titleLen = computed(() => title.value.trim().length)
const titleOver = computed(() => titleLen.value > KB_MAX_ENTRY_TITLE)
const bodyOver = computed(() => body.value.length > KB_MAX_ENTRY_BODY)
const valid = computed(() => titleLen.value > 0 && !titleOver.value && body.value.trim() !== '' && !bodyOver.value)
const canSave = computed(() => valid.value && !saving.value && (!props.entry || changed.value))

// ---- tags ----
const tagInput = ref('')
const tagsFull = ref(false)
function commitTags(text = tagInput.value) {
  const r = addTagsFromInput(tags.value, text, KB_MAX_ENTRY_TAGS)
  tags.value = r.tags
  tagsFull.value = r.full
  tagInput.value = ''
}
function onTagInput(v: string | number) {
  const s = String(v)
  if (/[,，]/.test(s)) commitTags(s)
  else { tagInput.value = s; tagsFull.value = false }
}
function onTagEnter(ev: KeyboardEvent) {
  if (ev.isComposing) return
  ev.preventDefault()
  commitTags()
}
const removeTag = (tag: string) => { tags.value = tags.value.filter(x => x !== tag); tagsFull.value = false }
const suggestions = computed(() => props.tagOptions.filter(o => !tags.value.includes(o.tag)).slice(0, 12))
const addSuggestion = (tag: string) => commitTags(tag)

// ---- save ----
async function save() {
  if (!canSave.value) return
  commitTags()
  saving.value = true
  const base = `/api/kb/${encodeURIComponent(props.kbId)}/entries`
  try {
    const payload = { title: title.value.trim(), body: body.value, tags: tags.value }
    const r = props.entry
      ? await $fetch<EntryView>(`${base}/${props.entry.id}`, { method: 'PATCH', body: { baseVersion: baseVersion.value, ...payload } })
      : await $fetch<EntryView>(base, { method: 'POST', body: payload })
    toast.add({ title: props.entry ? fmt(e.saved, { version: r.version }) : fmt(e.created, { title: r.title }), color: 'success', icon: 'i-lucide-check' })
    original.value = { title: title.value, body: body.value, tags: [...tags.value] }
    emit('saved', r)
  } catch (err) {
    const current = conflictOf<EntryView>(err)
    if (current) {
      conflict.value = current
      showCompare.value = false
    } else {
      toast.add({ title: e.saveFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
    }
  } finally {
    saving.value = false
  }
}

// ---- version conflict ----
function loadLatest() {
  const c = conflict.value
  if (!c) return
  title.value = c.title
  body.value = c.body
  tags.value = [...c.tags]
  original.value = { title: c.title, body: c.body, tags: [...c.tags] }
  baseVersion.value = c.version
  conflict.value = null
}
function keepMine() {
  const c = conflict.value
  if (!c) return
  original.value = { title: c.title, body: c.body, tags: [...c.tags] }
  baseVersion.value = c.version
  conflict.value = null
}
const draft = computed(() => ({ title: title.value, body: body.value, tags: tags.value }))
</script>

<template>
  <form class="flex min-w-0 flex-col gap-4" @submit.prevent="save">
    <div v-if="conflict" role="alert" class="flex min-w-0 flex-col gap-2 rounded-[10px] border border-warning/40 bg-warning/10 p-3 text-[13px]">
      <p class="m-0 font-medium">
        {{ fmt(e.conflict, { version: conflict.version, time: formatDateTime(conflict.updatedAt) }) }}
      </p>
      <p class="m-0 text-xs text-muted">
        {{ e.conflictHint }}
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-download" @click="loadLatest">
          {{ e.loadLatest }}
        </UButton>
        <UButton size="xs" color="warning" variant="soft" icon="i-lucide-save" @click="keepMine">
          {{ e.keepMine }}
        </UButton>
      </div>
      <div>
        <UButton size="xs" color="neutral" variant="link" :icon="showCompare ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" @click="showCompare = !showCompare">
          {{ showCompare ? e.compareHide : e.compare }}
        </UButton>
        <div v-if="showCompare" class="mt-2 rounded-md bg-default p-2">
          <KbDiff :a="conflict" :b="draft" />
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <label :for="`${uid}-title`" class="text-[13px] font-medium">{{ e.title }}</label>
        <span class="lw-num text-xs" :class="titleOver ? 'text-error' : 'text-dimmed'">{{ fmt(e.count, { n: titleLen, max: KB_MAX_ENTRY_TITLE }) }}</span>
      </div>
      <UInput :id="`${uid}-title`" v-model="title" class="w-full" autocomplete="off" :placeholder="e.titlePlaceholder" :color="titleOver ? 'error' : undefined" />
    </div>

    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <label :for="`${uid}-body`" class="text-[13px] font-medium">{{ e.body }}</label>
        <span class="lw-num text-xs" :class="bodyOver ? 'text-error' : 'text-dimmed'">{{ fmt(e.count, { n: body.length, max: KB_MAX_ENTRY_BODY }) }}</span>
      </div>
      <UTextarea :id="`${uid}-body`" v-model="body" class="w-full" autoresize :rows="8" :maxrows="24" :placeholder="e.bodyPlaceholder" :color="bodyOver ? 'error' : undefined" />
    </div>

    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <label :for="`${uid}-tag`" class="text-[13px] font-medium">{{ e.tags }}</label>
        <span class="lw-num text-xs text-dimmed">{{ fmt(e.count, { n: tags.length, max: KB_MAX_ENTRY_TAGS }) }}</span>
      </div>
      <div v-if="tags.length" class="flex flex-wrap gap-1.5">
        <span v-for="tag in tags" :key="tag" class="lw-chip max-w-full">
          <span class="truncate">{{ tag }}</span>
          <button type="button" class="inline-flex cursor-pointer items-center border-0 bg-transparent p-0 text-dimmed hover:text-default" :aria-label="fmt(e.tagRemove, { tag })" @click="removeTag(tag)">
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </span>
      </div>
      <UInput
        :id="`${uid}-tag`"
        :model-value="tagInput"
        class="w-full"
        autocomplete="off"
        :placeholder="e.tagPlaceholder"
        :disabled="tags.length >= KB_MAX_ENTRY_TAGS"
        @update:model-value="onTagInput"
        @keydown.enter="onTagEnter"
        @blur="commitTags()"
      />
      <p v-if="tagsFull || tags.length >= KB_MAX_ENTRY_TAGS" class="m-0 text-xs text-warning">
        {{ fmt(e.tagsFull, { max: KB_MAX_ENTRY_TAGS }) }}
      </p>
      <div v-if="suggestions.length && tags.length < KB_MAX_ENTRY_TAGS" class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-dimmed">{{ e.tagsExisting }}</span>
        <button v-for="o in suggestions" :key="o.tag" type="button" class="lw-chip max-w-full cursor-pointer" @click="addSuggestion(o.tag)">
          <span class="truncate">{{ o.tag }}</span>
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      <span v-if="changed" class="mr-auto text-xs text-warning">{{ e.unsaved }}</span>
      <UButton type="button" size="sm" color="neutral" variant="ghost" :disabled="saving" @click="emit('cancel')">
        {{ e.cancel }}
      </UButton>
      <UButton type="submit" size="sm" icon="i-lucide-save" :loading="saving" :disabled="!canSave">
        {{ entry ? e.save : e.create }}
      </UButton>
    </div>
  </form>
</template>
