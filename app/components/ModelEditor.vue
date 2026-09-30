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

type Detail = { model: ModelConfig, defaults: LaunchDefaults, templates: string[], up: string[] }
type ScanDoc = { entries: Array<ScanEntry & { enabledAs: string | null }> }

const edit = t.models.edit
const toast = useToast()
const { busy, saveFiles, profileOp } = useModelActions()

const detail = ref<Detail | null>(null)
const scan = ref<ScanDoc | null>(null)
const scanFailed = ref(false)
const loadError = ref('')
const selected = ref('')

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
  void loadDetail()
  void loadScan()
}, { immediate: true })

// Keep "which profiles are up" fresh while the drawer is open (live state changes).
const { state: live } = useLive()
watch(() => live.value?.models.find(m => m.id === props.modelId)?.instances.map(i => `${i.profile}:${i.state}`).join(','), () => {
  if (open.value && detail.value) void loadDetail()
})

const model = computed(() => detail.value?.model ?? null)
const profileNames = computed(() => Object.keys(model.value?.profiles ?? {}))
const isUp = (name: string) => !!detail.value?.up.includes(name)
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
  return kind === 'file' ? items : [{ label: edit.files.none, value: '' }, ...items]
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
    :ui="{ content: 'w-full max-w-2xl', body: 'space-y-4' }"
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
        <AppCard :title="edit.files.title" :hint="edit.files.hint">
          <p v-if="!scan && !scanFailed" class="mb-2 text-xs text-muted">
            {{ edit.files.scanning }}
          </p>
          <p v-if="scanFailed" class="mb-2 text-xs text-warning">
            {{ edit.files.scanFailed }}
          </p>
          <div class="space-y-3">
            <div v-for="row in fileRows" :key="row.kind" class="space-y-1">
              <label class="text-sm text-default">{{ row.label }}</label>
              <USelect v-model="picked[row.kind]" :items="itemsFor[row.kind]" class="w-full" :aria-label="row.label" />
            </div>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-2">
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
        </AppCard>

        <AppCard :title="edit.profiles.title" :hint="edit.profiles.hint">
          <div class="flex flex-wrap items-center gap-2">
            <USelect
              v-model="selected"
              :items="profileNames.map(n => ({ label: `${n}${n === model!.activeProfile ? `（${edit.profiles.isCurrent}）` : ''}${dirty[n] ? ' *' : ''}`, value: n }))"
              size="sm"
              class="w-44"
              :aria-label="edit.profiles.title"
            />
            <UBadge v-if="isUp(selected)" color="success" variant="subtle" size="sm">
              {{ edit.profiles.running }}
            </UBadge>
            <UButton v-if="selected !== model.activeProfile" size="sm" color="neutral" variant="outline" icon="i-lucide-check" @click="setCurrent">
              {{ edit.profiles.setCurrent }}
            </UButton>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-plus" @click="startOp('create')">
              {{ edit.profiles.create }}
            </UButton>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-copy" @click="startOp('duplicate')">
              {{ edit.profiles.duplicate }}
            </UButton>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-pencil" :disabled="isUp(selected)" :title="isUp(selected) ? edit.profiles.inUse : ''" @click="startOp('rename')">
              {{ edit.profiles.rename }}
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              icon="i-lucide-trash-2"
              :disabled="isUp(selected) || profileNames.length <= 1"
              :title="profileNames.length <= 1 ? edit.profiles.lastOne : isUp(selected) ? edit.profiles.inUse : ''"
              @click="pending = { kind: 'remove' }"
            >
              {{ edit.profiles.remove }}
            </UButton>
          </div>

          <div v-if="pending" class="mt-3 rounded-lg border border-default bg-muted px-3 py-3">
            <p class="text-sm font-medium text-highlighted">
              {{ pendingTitle }}
            </p>
            <p v-if="pending.kind === 'remove'" class="mt-0.5 text-xs text-muted">
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

          <div class="mt-4 border-t border-default pt-4">
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
              :active="open && name === selected"
              :files="previewFiles"
              :busy="opBusy"
              @dirty="(d: boolean) => { dirty[name] = d }"
              @save="(form: object, restart: boolean) => saveForm(name, form, restart)"
            />
          </div>
        </AppCard>
      </template>
    </template>
  </USlideover>
</template>
