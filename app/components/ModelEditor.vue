<script setup lang="ts">
// Edit drawer for one model: files (main / mmproj / draft), profile management, and a
// ProfileForm per profile (all kept mounted so unsaved edits survive switching profiles).
import t from '~~/i18n/zh-CN'
import type { LaunchDefaults } from '~~/server/core/args'
import type { ModelConfig } from '~~/server/core/config'
import type { ScanEntry } from '~~/server/core/scanner'
import type { FileRef } from '~~/server/core/types'

const props = defineProps<{ modelId: string }>()
const open = defineModel<boolean>('open', { default: false })

type Detail = { model: ModelConfig, defaults: LaunchDefaults, templates: string[], up: string[], inUse: string[] }
type ScanDoc = { entries: Array<ScanEntry & { enabledAs: string | null }> }

const edit = t.models.edit
const toast = useToast()
const { busy, saveFiles, profileOp } = useModelActions()

const detail = ref<Detail | null>(null)
const scan = ref<ScanDoc | null>(null)
const scanFailed = ref(false)
const loadError = ref('')
const selected = ref('')
type EditTab = 'files' | 'profiles' | 'params'
const editTab = ref<EditTab>('files')
const editTabs: Array<{ value: EditTab, label: string }> = [
  { value: 'files', label: edit.tabs.files },
  { value: 'profiles', label: edit.tabs.profiles },
  { value: 'params', label: edit.tabs.params },
]

const url = computed(() => `/api/models/${encodeURIComponent(props.modelId)}`)

async function loadDetail(select?: string) {
  try {
    detail.value = await $fetch<Detail>(url.value)
    loadError.value = ''
    const names = Object.keys(detail.value.model.profiles)
    selected.value = select && names.includes(select) ? select
      : names.includes(selected.value) ? selected.value : detail.value.model.activeProfile
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    loadError.value = err.data?.message ?? err.message ?? edit.loadFailed
  }
}

async function loadScan() {
  scanFailed.value = false
  try {
    scan.value = await $fetch<ScanDoc>('/api/scan', { method: 'POST', body: {} })
  } catch {
    scanFailed.value = true
  }
}

watch(open, (o) => {
  if (!o) return
  detail.value = null
  scan.value = null
  selected.value = ''
  editTab.value = 'files'
  void loadDetail()
  void loadScan()
}, { immediate: true })

// Keep "which profiles are up" fresh while the drawer is open (live state changes).
const { state: live } = useLive()
// Queued loads count too: a profile a request is waiting for cannot be renamed or deleted.
watch(() => [
  live.value?.models.find(m => m.id === props.modelId)?.instances.map(i => `${i.profile}:${i.state}`).join(','),
  live.value?.queue.filter(q => q.modelId === props.modelId).map(q => q.profile).join(','),
].join('|'), () => {
  if (open.value && detail.value) void loadDetail()
})

const model = computed(() => detail.value?.model ?? null)
const profileNames = computed(() => Object.keys(model.value?.profiles ?? {}))
const isUp = (name: string) => !!detail.value?.up.includes(name)
const isInUse = (name: string) => isUp(name) || !!detail.value?.inUse.includes(name)
const anyUp = computed(() => !!detail.value?.up.length)

// ---- Files -----------------------------------------------------------------------------------
const refKey = (r: FileRef | null) => (r ? JSON.stringify([r.dirId, r.rel]) : '')
const fromKey = (k: string): FileRef | null => {
  if (!k) return null
  const [dirId, rel] = JSON.parse(k) as [string, string]
  return { dirId, rel }
}
const picked = reactive({ file: '', mmproj: '', draft: '' })
function resetPicked() {
  if (!model.value) return
  picked.file = refKey(model.value.file)
  picked.mmproj = refKey(model.value.mmproj)
  picked.draft = refKey(model.value.draft)
}
const savedFiles = computed(() => (model.value ? JSON.stringify([model.value.file, model.value.mmproj, model.value.draft]) : ''))
// Re-seed from the stored model only when the stored files change (not on every reload).
watch(savedFiles, resetPicked, { immediate: true })

const modelDirOf = computed(() => {
  const f = model.value?.file
  return f ? `${f.dirId}/${f.rel.slice(0, Math.max(0, f.rel.lastIndexOf('/')))}` : ''
})
const dirOfRef = (r: FileRef) => `${r.dirId}/${r.rel.slice(0, Math.max(0, r.rel.lastIndexOf('/')))}`

function fileItems(kind: 'file' | 'mmproj' | 'draft') {
  const want = kind === 'file' ? 'model' : kind
  const current = model.value?.[kind] ?? null
  const all = scan.value?.entries ?? []
  const list = all.filter(e => e.kind === want && (kind !== 'file' || (e.complete && (!e.enabledAs || e.enabledAs === props.modelId))))
  // With the picked main file as reference, helpers next to it come first (offered, never chosen for you).
  const refDir = picked.file ? dirOfRef(fromKey(picked.file)!) : modelDirOf.value
  const near = (e: ScanEntry) => kind !== 'file' && dirOfRef(e.ref) === refDir
  list.sort((a, b) => Number(near(b)) - Number(near(a)) || a.ref.dirId.localeCompare(b.ref.dirId) || a.ref.rel.localeCompare(b.ref.rel))
  const items = list.map(e => ({ label: `${e.ref.dirId}/${e.ref.rel}${near(e) ? ` · ${edit.files.sameDir}` : ''}`, value: refKey(e.ref) }))
  if (current && !items.some(i => i.value === refKey(current))) {
    items.unshift({ label: `${current.dirId}/${current.rel}${edit.files.missing}`, value: refKey(current) })
  }
  return kind === 'file' ? items : withEmptyOption(edit.files.none, items)
}
const fileRows = [
  { kind: 'file' as const, label: edit.files.model },
  { kind: 'mmproj' as const, label: edit.files.mmproj },
  { kind: 'draft' as const, label: edit.files.draft },
]
const itemsFor = computed(() => ({ file: fileItems('file'), mmproj: fileItems('mmproj'), draft: fileItems('draft') }))
const filesDirty = computed(() => !!model.value && (
  picked.file !== refKey(model.value.file) || picked.mmproj !== refKey(model.value.mmproj) || picked.draft !== refKey(model.value.draft)
))

async function doSaveFiles(restart: boolean) {
  if (!model.value) return
  const cur = model.value
  const body: Record<string, unknown> = { restart }
  if (picked.file !== refKey(cur.file)) body.file = fromKey(picked.file)
  if (picked.mmproj !== refKey(cur.mmproj)) body.mmproj = fromKey(picked.mmproj)
  if (picked.draft !== refKey(cur.draft)) body.draft = fromKey(picked.draft)
  const r = await saveFiles(props.modelId, body)
  if (!r) return
  toast.add({ title: r.restarted ? edit.files.savedRestarting : edit.files.saved, color: 'success', icon: 'i-lucide-check' })
  await loadDetail()
}

// Unsaved choices go into the previews.
const previewFiles = computed(() => ({
  file: fromKey(picked.file) ?? undefined,
  mmproj: picked.mmproj ? fromKey(picked.mmproj) : null,
  draft: picked.draft ? fromKey(picked.draft) : null,
}))

// ---- Profiles --------------------------------------------------------------------------------
type Pending = { kind: 'create' | 'duplicate' | 'rename', name: string } | { kind: 'remove' } | null
const pending = ref<Pending>(null)
const dirty = reactive<Record<string, boolean>>({})
const anyDirty = computed(() => Object.values(dirty).some(Boolean))

function startOp(kind: 'create' | 'duplicate' | 'rename') {
  const name = kind === 'rename' ? selected.value : kind === 'duplicate' ? `${selected.value}-${edit.profiles.copySuffix}` : ''
  pending.value = { kind, name }
}

async function confirmOp() {
  const p = pending.value
  if (!p) return
  let r: { name?: string } | null = null
  if (p.kind === 'create') r = await profileOp(props.modelId, { op: 'create', name: p.name })
  else if (p.kind === 'duplicate') r = await profileOp(props.modelId, { op: 'duplicate', name: p.name, from: selected.value })
  else if (p.kind === 'rename') r = await profileOp(props.modelId, { op: 'rename', from: selected.value, to: p.name })
  else r = await profileOp(props.modelId, { op: 'delete', name: selected.value })
  if (!r) return
  pending.value = null
  await loadDetail(p.kind === 'remove' ? undefined : r.name)
}

async function setCurrent() {
  if (!model.value) return
  const r = await $fetch(`${url.value}/profile`, { method: 'POST', body: { profile: selected.value } }).catch((e) => {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: t.models.toast.profileFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
    return null
  })
  if (r) await loadDetail()
}

async function saveForm(name: string, form: object, restart: boolean) {
  const r = await profileOp(props.modelId, { op: 'save', name, form, restart })
  if (!r) return
  toast.add({ title: fmt(r.restarted ? edit.form.savedRestarting : edit.form.saved, { name }), color: 'success', icon: 'i-lucide-check' })
  await loadDetail()
}

watch(selected, () => { pending.value = null })
const opBusy = computed(() => !!busy.value[`profiles:${props.modelId}`])
const pendingTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'remove') return fmt(edit.profiles.removeTitle, { name: selected.value })
  if (p.kind === 'create') return edit.profiles.createTitle
  return fmt(p.kind === 'duplicate' ? edit.profiles.duplicateTitle : edit.profiles.renameTitle, { name: selected.value })
})
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="fmt(edit.title, { name: model?.name ?? '' })"
    :description="edit.subtitle"
    :ui="{ content: 'w-full max-w-xl', body: 'space-y-4' }"
  >
    <template #body>
      <p v-if="loadError" class="text-sm text-error">
        {{ edit.loadFailed }}：{{ loadError }}
      </p>
      <div v-else-if="!detail || !model" class="space-y-3">
        <USkeleton class="h-24 w-full" />
        <USkeleton class="h-48 w-full" />
      </div>

      <template v-else>
        <div class="lw-seg" role="tablist" :aria-label="edit.open">
          <button
            v-for="x in editTabs"
            :key="x.value"
            type="button"
            role="tab"
            :aria-selected="editTab === x.value"
            :class="{ on: editTab === x.value }"
            @click="editTab = x.value"
          >
            {{ x.label }}
            <span v-if="x.value === 'files' && filesDirty" class="text-warning">*</span>
            <span v-if="x.value === 'params' && anyDirty" class="text-warning">*</span>
          </button>
        </div>

        <div v-show="editTab === 'files'" class="flex flex-col gap-4">
          <p class="m-0 text-xs text-dimmed">
            {{ edit.files.hint }}
          </p>
          <p v-if="!scan && !scanFailed" class="m-0 text-xs text-muted">
            {{ edit.files.scanning }}
          </p>
          <p v-if="scanFailed" class="m-0 text-xs text-warning">
            {{ edit.files.scanFailed }}
          </p>
          <div class="space-y-4">
            <div v-for="row in fileRows" :key="row.kind" class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-muted">{{ row.label }}</label>
              <USelect
                :model-value="toSelectValue(picked[row.kind])"
                :items="itemsFor[row.kind]"
                class="w-full font-mono"
                :aria-label="row.label"
                @update:model-value="(v: unknown) => { picked[row.kind] = fromSelectValue(v) }"
              />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <UButton size="sm" icon="i-lucide-save" :disabled="!filesDirty" :loading="!!busy[`files:${modelId}`]" @click="doSaveFiles(false)">
              {{ edit.files.save }}
            </UButton>
            <UButton
              v-if="anyUp"
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-cw"
              :disabled="!filesDirty"
              :loading="!!busy[`files:${modelId}`]"
              @click="doSaveFiles(true)"
            >
              {{ edit.form.saveRestart }}
            </UButton>
            <span v-if="filesDirty" class="text-xs text-warning">{{ edit.form.dirty }}</span>
          </div>
        </div>

        <div v-show="editTab === 'profiles'" class="flex flex-col gap-3">
          <p class="m-0 text-xs text-dimmed">
            {{ edit.profiles.hint }}
          </p>
          <ul class="m-0 flex list-none flex-col gap-2.5 p-0" role="radiogroup" :aria-label="edit.profiles.title">
            <li
              v-for="n in profileNames"
              :key="n"
              class="lw-card flex cursor-pointer items-center gap-2.5 px-3.5 py-3 !shadow-none"
              role="radio"
              tabindex="0"
              :aria-checked="selected === n"
              :class="selected === n ? '!border-[var(--lw-accent)]' : ''"
              @click="selected = n"
              @keydown.enter.prevent="selected = n"
              @keydown.space.prevent="selected = n"
            >
              <span class="lw-radio" :class="{ on: selected === n }" />
              <span class="flex-1 font-medium">{{ n }}{{ dirty[n] ? ' *' : '' }}</span>
              <span v-if="n === model.activeProfile" class="lw-chip lw-chip-accent">{{ edit.profiles.isCurrent }}</span>
              <span v-if="isUp(n)" class="lw-st lw-st-ready">{{ edit.profiles.running }}</span>
            </li>
          </ul>
          <div class="flex flex-wrap items-center gap-2">
            <UButton v-if="selected !== model.activeProfile" size="sm" color="neutral" variant="outline" icon="i-lucide-check" @click="setCurrent">
              {{ edit.profiles.setCurrent }}
            </UButton>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-plus" @click="startOp('create')">
              {{ edit.profiles.create }}
            </UButton>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-copy" @click="startOp('duplicate')">
              {{ edit.profiles.duplicate }}
            </UButton>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-pencil" :disabled="isInUse(selected)" :title="isInUse(selected) ? edit.profiles.inUse : ''" @click="startOp('rename')">
              {{ edit.profiles.rename }}
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              icon="i-lucide-trash-2"
              :disabled="isInUse(selected) || profileNames.length <= 1"
              :title="profileNames.length <= 1 ? edit.profiles.lastOne : isInUse(selected) ? edit.profiles.inUse : ''"
              @click="pending = { kind: 'remove' }"
            >
              {{ edit.profiles.remove }}
            </UButton>
          </div>

          <div v-if="pending" class="rounded-[10px] border border-default bg-muted px-3.5 py-3">
            <p class="m-0 text-sm font-medium">
              {{ pendingTitle }}
            </p>
            <p v-if="pending.kind === 'remove'" class="m-0 mt-0.5 text-xs text-muted">
              {{ edit.profiles.removeBody }}
            </p>
            <form class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="confirmOp">
              <UInput v-if="pending.kind !== 'remove'" v-model="pending.name" size="sm" class="w-48" :placeholder="edit.profiles.namePlaceholder" autofocus />
              <UButton type="submit" size="sm" :color="pending.kind === 'remove' ? 'error' : 'primary'" :loading="opBusy">
                {{ pending.kind === 'remove' ? edit.profiles.removeConfirm : edit.profiles.confirm }}
              </UButton>
              <UButton size="sm" color="neutral" variant="ghost" @click="pending = null">
                {{ edit.profiles.cancel }}
              </UButton>
            </form>
          </div>
        </div>

        <!-- All profile forms stay mounted so unsaved edits survive switching profiles / tabs. -->
        <div v-show="editTab === 'params'" class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-dimmed">{{ edit.paramsFor }}</span>
            <USelect
              v-model="selected"
              :items="profileNames.map(n => ({ label: `${n}${n === model!.activeProfile ? `（${edit.profiles.isCurrent}）` : ''}${dirty[n] ? ' *' : ''}`, value: n }))"
              size="sm"
              class="w-48"
              :aria-label="edit.paramsFor"
            />
            <span v-if="isUp(selected)" class="lw-st lw-st-ready">{{ edit.profiles.running }}</span>
          </div>
          <ProfileForm
            v-for="name in profileNames"
            v-show="name === selected"
            :key="name"
            :model-id="modelId"
            :name="name"
            :profile="model.profiles[name]!"
            :defaults="detail.defaults"
            :templates="detail.templates"
            :running="isUp(name)"
            :active="open && editTab === 'params' && name === selected"
            :files="previewFiles"
            :busy="opBusy"
            @dirty="(d: boolean) => { dirty[name] = d }"
            @save="(form: object, restart: boolean) => saveForm(name, form, restart)"
          />
        </div>
      </template>
    </template>
  </USlideover>
</template>
