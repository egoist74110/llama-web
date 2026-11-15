<script setup lang="ts">
// Version history of one entry: the list, a comparison of any two versions, and "revert to this version" (which makes
// a new version; nothing is deleted). Reverting sends the version that was read as `baseVersion`.
import { t } from '../composables/useLocale'
import type { EntryView } from '~~/server/core/kb/manager'
import type { VersionRow } from '~~/server/core/kb/kb-db'
import { actorLabel, conflictOf } from '~/utils/kb'
import { fromSelectValue } from '~/utils/select-empty'

type Row = Omit<VersionRow, 'body'> & { bodyLength: number }

const props = defineProps<{ kbId: string, entry: EntryView }>()
const emit = defineEmits<{ reverted: [entry: EntryView], stale: [] }>()

const h = t.kb.page.history
const toast = useToast()

const rows = ref<Row[] | null>(null)
const loadError = ref('')
const left = ref<number | null>(null)
const right = ref<number | null>(null)
const bodies = ref<Record<number, VersionRow>>({})
const loading = ref(false)

const base = () => `/api/kb/${encodeURIComponent(props.kbId)}/entries/${props.entry.id}`
const opText = (op: string) => (t.kb.page.ops as Record<string, string>)[op] ?? op

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  try {
    const r = await $fetch<{ versions: Row[] }>(`${base()}/versions`)
    if (my !== seq) return
    rows.value = r.versions
    loadError.value = ''
    bodies.value = {}
    // Default: the version before the current one against the current one.
    right.value = r.versions.some(v => v.version === props.entry.version) ? props.entry.version : (r.versions[0]?.version ?? null)
    left.value = r.versions.find(v => v.version !== right.value)?.version ?? null
  } catch (e) {
    if (my === seq) loadError.value = messageOf(e)
  } finally {
    if (my === seq) loading.value = false
  }
}
// Reload when the entry changed under us (a revert, or an edit by someone else).
watch(() => [props.entry.id, props.entry.version], () => { void load() }, { immediate: true })

async function body(v: number | null): Promise<VersionRow | null> {
  if (v === null) return null
  if (bodies.value[v]) return bodies.value[v]!
  try {
    const r = await $fetch<VersionRow>(`${base()}/versions/${v}`)
    bodies.value = { ...bodies.value, [v]: r }
    return r
  } catch (e) {
    toast.add({ title: h.loadFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    return null
  }
}
// Fetch the two compared versions whenever the pick changes.
const fetching = ref(false)
watch([left, right, rows], async () => {
  fetching.value = true
  try {
    await Promise.all([body(left.value), body(right.value)])
  } finally {
    fetching.value = false
  }
}, { immediate: true })

const sideA = computed(() => (left.value === null ? null : bodies.value[left.value] ?? null))
const sideB = computed(() => (right.value === null ? null : bodies.value[right.value] ?? null))

const items = computed(() => (rows.value ?? []).map(v => ({ label: `v${v.version} · ${opText(v.op)}`, value: String(v.version) })))
const setLeft = (v: unknown) => { const n = Number(fromSelectValue(v)); left.value = Number.isInteger(n) ? n : null }
const setRight = (v: unknown) => { const n = Number(fromSelectValue(v)); right.value = Number.isInteger(n) ? n : null }

// A delete leaves a version that can be viewed but not reverted to; neither can the current version.
const canRevert = (v: Row) => v.version !== props.entry.version && v.op !== 'delete'

// ---- revert ----
const reverting = ref<Row | null>(null)
const revertOpen = computed({ get: () => reverting.value !== null, set: (v: boolean) => { if (!v) reverting.value = null } })
const revertBusy = ref(false)
async function revert() {
  const v = reverting.value
  if (!v || revertBusy.value) return
  revertBusy.value = true
  try {
    const r = await $fetch<EntryView>(`${base()}/revert`, { method: 'POST', body: { baseVersion: props.entry.version, toVersion: v.version } })
    toast.add({ title: fmt(h.reverted, { version: r.version }), color: 'success', icon: 'i-lucide-check' })
    reverting.value = null
    emit('reverted', r)
  } catch (e) {
    reverting.value = null
    if (conflictOf<EntryView>(e)) {
      toast.add({ title: h.stale, color: 'warning', icon: 'i-lucide-circle-alert' })
      emit('stale')
    } else {
      toast.add({ title: h.revertFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    }
  } finally {
    revertBusy.value = false
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <p v-if="loadError" class="m-0 break-words text-sm text-error">
      {{ h.loadFailed }}<span class="ml-2 text-xs text-muted">{{ loadError }}</span>
    </p>
    <div v-else-if="!rows" class="flex flex-col gap-2">
      <USkeleton class="h-12 w-full" />
      <USkeleton class="h-12 w-full" />
    </div>
    <template v-else>
      <ul class="m-0 flex list-none flex-col divide-y divide-default rounded-[10px] border border-default p-0">
        <li v-for="v in rows" :key="v.version" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2" :class="v.version === left ? 'bg-primary/5' : ''">
          <button type="button" class="flex min-w-0 flex-1 basis-48 cursor-pointer flex-col gap-0.5 border-0 bg-transparent p-0 text-left" :aria-pressed="v.version === left" @click="left = v.version">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="lw-num text-sm font-semibold">v{{ v.version }}</span>
              <span class="lw-chip">{{ opText(v.op) }}</span>
              <span v-if="v.version === entry.version" class="lw-chip lw-chip-accent">{{ h.current }}</span>
              <span class="text-xs text-dimmed">{{ fmt(h.chars, { n: v.bodyLength }) }}</span>
            </span>
            <span class="break-words text-[13px]">{{ v.title }}</span>
            <span class="break-words text-xs text-dimmed">{{ actorLabel(v.actor, t.kb.page.actor) }} · {{ formatDateTime(v.at) }}</span>
          </button>
          <UButton v-if="canRevert(v)" size="xs" color="neutral" variant="soft" icon="i-lucide-undo-2" @click="reverting = v">
            {{ h.revert }}
          </UButton>
        </li>
      </ul>

      <div class="flex min-w-0 flex-col gap-3">
        <p v-if="left === null || right === null" class="m-0 text-sm text-muted">
          {{ h.pick }}
        </p>
        <template v-else>
          <div class="flex flex-wrap items-center gap-2">
            <USelect :model-value="String(left)" :items="items" size="sm" class="min-w-0 flex-1 basis-32" :aria-label="h.left" @update:model-value="setLeft" />
            <span class="text-dimmed">→</span>
            <USelect :model-value="String(right)" :items="items" size="sm" class="min-w-0 flex-1 basis-32" :aria-label="h.right" @update:model-value="setRight" />
          </div>
          <p v-if="rows.find(v => v.version === left)?.op === 'delete' || rows.find(v => v.version === right)?.op === 'delete'" class="m-0 text-xs text-muted">
            {{ h.deleteVersion }}
          </p>
          <p v-if="left === right" class="m-0 text-sm text-muted">
            {{ h.same }}
          </p>
          <USkeleton v-else-if="!sideA || !sideB" class="h-24 w-full" />
          <template v-else>
            <p class="m-0 text-[13px] font-medium">
              {{ fmt(h.compareTitle, { from: left, to: right }) }}
            </p>
            <KbDiff :a="sideA" :b="sideB" />
          </template>
        </template>
      </div>
    </template>

    <KbConfirm
      v-model:open="revertOpen"
      tone="neutral"
      :title="reverting ? fmt(h.revertTitle, { version: reverting.version }) : ''"
      :body="reverting ? fmt(h.revertBody, { version: reverting.version, next: entry.version + 1 }) : ''"
      :confirm-label="h.revertConfirm"
      :cancel-label="t.kb.page.entry.cancel"
      :busy="revertBusy"
      @confirm="revert"
    />
  </div>
</template>
