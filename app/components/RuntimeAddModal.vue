<script setup lang="ts">
// "Add version" dialog: pick a source (folder / archive / GitHub address), stage it, show what was
// found, and register it only after the user confirms. Staging runs the chosen llama-server
// (`--version`), so a warning comes first. Closing the dialog throws the staged copy away.
import { t } from '../composables/useLocale'
import type { AddPreview } from '~~/server/core/runtime-add'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [] }>()

const s = t.llamacpp.manage.addDialog
const ui = usePlatformUi()
const toast = useToast()
const { pick, picking } = usePickFolder()

type Kind = 'dir' | 'archive' | 'github'
type Step = 'source' | 'confirm' | 'previewing' | 'preview' | 'adding'

const kind = ref<Kind>('dir')
const dirPath = ref('')
const archivePath = ref('')
const url = ref('')
const accel = ref('auto')
const step = ref<Step>('source')
const stage = ref<AddPreview | null>(null)
const label = ref('')
const acceptUnverified = ref(false)
const error = ref('')
let cancelledByUser = false

// A computed: the labels are read again when the interface language changes.
const kinds = computed<Array<{ value: Kind, label: string }>>(() => [
  { value: 'dir', label: s.kinds.dir },
  { value: 'archive', label: s.kinds.archive },
  { value: 'github', label: s.kinds.github },
])
const accelItems = computed(() => [
  { label: s.accelAuto, value: 'auto' },
  { label: accelLabel('cuda', false), value: 'cuda' },
  { label: accelLabel('cpu', false), value: 'cpu' },
])

const source = computed(() => (kind.value === 'dir' ? dirPath.value : kind.value === 'archive' ? archivePath.value : url.value).trim())
const kindValue = computed(() => (stage.value ? accelLabel(stage.value.accel, ui.value.isMac) : ''))

function reset() {
  kind.value = 'dir'
  dirPath.value = archivePath.value = url.value = ''
  accel.value = 'auto'
  step.value = 'source'
  stage.value = null
  label.value = ''
  acceptUnverified.value = false
  error.value = ''
  cancelledByUser = false
}

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

async function choose() {
  const p = await pick()
  if (p) dirPath.value = p
}

async function runPreview() {
  error.value = ''
  cancelledByUser = false
  step.value = 'previewing'
  const body: Record<string, unknown> = kind.value === 'github'
    ? { kind: 'github', url: source.value, ...(ui.value.hasCpuChannel && accel.value !== 'auto' ? { accel: accel.value } : {}) }
    : { kind: kind.value, path: source.value }
  try {
    const r = await $fetch<AddPreview>('/api/llamacpp/add/preview', { method: 'POST', body })
    // The dialog was closed while this was running: the server already dropped it on cancel.
    if (!open.value) return
    stage.value = r
    label.value = r.suggestedLabel
    step.value = 'preview'
  } catch (e) {
    if (cancelledByUser || !open.value) return
    error.value = messageOf(e)
    step.value = 'source'
  }
}

/** Stop a preview that is still running (the server aborts the copy / download / `--version`). */
async function stopPreview() {
  cancelledByUser = true
  step.value = 'source'
  await $fetch('/api/llamacpp/add/cancel', { method: 'POST', body: {} }).catch(() => {})
}

async function confirm() {
  const st = stage.value
  if (!st || step.value === 'adding') return
  error.value = ''
  step.value = 'adding'
  try {
    await $fetch('/api/llamacpp/add/confirm', {
      method: 'POST',
      body: { stageId: st.stageId, label: label.value.trim() || undefined, acceptUnverified: acceptUnverified.value },
    })
    toast.add({ title: fmt(t.llamacpp.manage.added, { name: label.value.trim() || st.tag || st.suggestedLabel }), color: 'success', icon: 'i-lucide-check' })
    stage.value = null
    open.value = false
    emit('added')
  } catch (e) {
    error.value = messageOf(e)
    // An expired preview cannot be confirmed any more: start over from the source.
    if ((e as { statusCode?: number }).statusCode === 409 && !st.needsDigestConfirm) {
      stage.value = null
      step.value = 'source'
    } else step.value = 'preview'
  }
}

async function discard() {
  const st = stage.value
  const running = step.value === 'previewing'
  stage.value = null
  if (st || running) await $fetch('/api/llamacpp/add/cancel', { method: 'POST', body: st ? { stageId: st.stageId } : {} }).catch(() => {})
}

watch(open, (o) => {
  if (o) reset()
  else void discard()
})

const canConfirm = computed(() => !!stage.value && (!stage.value.needsDigestConfirm || acceptUnverified.value))
const warningText = (code: string) => (s.warnings as Record<string, string>)[code] ?? code
</script>

<template>
  <UModal v-model:open="open" :title="step === 'preview' || step === 'adding' ? s.previewTitle : s.title" :description="step === 'confirm' ? '' : s.description" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div v-if="step === 'source'" class="space-y-4">
        <div class="lw-seg" role="tablist" :aria-label="s.sourceLabel">
          <button
            v-for="k in kinds"
            :key="k.value"
            type="button"
            role="tab"
            :aria-selected="kind === k.value"
            :class="{ on: kind === k.value }"
            @click="kind = k.value"
          >
            {{ k.label }}
          </button>
        </div>

        <div v-if="kind === 'dir'" class="space-y-1.5">
          <label class="text-xs font-medium text-muted">{{ s.dirLabel }}</label>
          <div class="flex flex-wrap gap-2">
            <UInput v-model="dirPath" class="min-w-0 flex-1 basis-60" :placeholder="ui.isMac ? t.platform.mac.dirPlaceholder : s.dirPlaceholder" :aria-label="s.dirLabel" :ui="{ base: 'font-mono text-xs' }" />
            <UButton v-if="ui.canPickFolder" size="sm" color="neutral" variant="outline" icon="i-lucide-folder-open" :loading="picking" @click="choose">
              {{ s.pick }}
            </UButton>
          </div>
          <p class="text-xs text-dimmed">
            {{ s.dirHint }}
          </p>
        </div>

        <div v-else-if="kind === 'archive'" class="space-y-1.5">
          <label class="text-xs font-medium text-muted">{{ s.archiveLabel }}</label>
          <UInput v-model="archivePath" class="w-full" :placeholder="ui.isMac ? t.platform.mac.archivePlaceholder : s.archivePlaceholder" :aria-label="s.archiveLabel" :ui="{ base: 'font-mono text-xs' }" />
          <p class="text-xs text-dimmed">
            {{ s.archiveHint }}
          </p>
        </div>

        <div v-else class="space-y-3">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted">{{ s.githubLabel }}</label>
            <UInput v-model="url" class="w-full" :placeholder="s.githubPlaceholder" :aria-label="s.githubLabel" :ui="{ base: 'font-mono text-xs' }" />
            <p class="text-xs text-dimmed">
              {{ s.githubHint }}
            </p>
          </div>
          <div v-if="ui.hasCpuChannel" class="flex flex-wrap items-center gap-2">
            <span class="text-xs font-medium text-muted">{{ s.accelLabel }}</span>
            <USelect v-model="accel" :items="accelItems" size="sm" class="w-44" :aria-label="s.accelLabel" />
          </div>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">
          {{ error }}
        </p>
      </div>

      <div v-else-if="step === 'confirm'" class="space-y-2 rounded-[10px] border border-default bg-muted px-4 py-3">
        <p class="flex items-center gap-2 text-sm font-medium text-highlighted">
          <UIcon name="i-lucide-triangle-alert" class="text-warning" />
          {{ s.runTitle }}
        </p>
        <p class="text-sm text-muted">
          {{ s.runBody }}
        </p>
        <p class="break-all font-mono text-xs text-dimmed">
          {{ source }}
        </p>
      </div>

      <div v-else-if="step === 'previewing'" class="flex items-start gap-3 py-2">
        <UIcon name="i-lucide-loader-circle" class="mt-0.5 shrink-0 animate-spin text-muted" />
        <p class="text-sm text-muted">
          {{ s.previewing }}
        </p>
      </div>

      <div v-else-if="stage" class="space-y-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-muted">
            {{ s.from }}
          </dt>
          <dd class="min-w-0 break-all font-mono text-xs">
            {{ stage.source }}
          </dd>
          <dt class="text-muted">
            {{ s.size }}
          </dt>
          <dd class="m-0">
            {{ fmt(s.sizeValue, { size: formatBytes(stage.bytes), files: stage.files }) }}
          </dd>
          <template v-if="kindValue">
            <dt class="text-muted">
              {{ s.kind }}
            </dt>
            <dd class="m-0">
              {{ kindValue }}
            </dd>
          </template>
          <dt class="text-muted">
            {{ s.version }}
          </dt>
          <dd class="min-w-0 break-all font-mono text-xs">
            {{ stage.version || s.unknownTag }}
          </dd>
        </dl>

        <div v-if="stage.digests.length" class="space-y-1.5">
          <p class="text-xs font-medium text-muted">
            {{ s.digest }}
          </p>
          <div v-for="d in stage.digests" :key="d.name" class="rounded-lg border border-default bg-muted px-3 py-2">
            <p class="break-all text-xs text-default">
              {{ d.name }}
            </p>
            <p class="break-all font-mono text-[11px] text-muted">
              {{ d.sha256 }}
            </p>
            <p class="text-xs" :class="d.verified ? 'text-success' : 'text-warning'">
              {{ d.verified ? s.digestVerified : s.digestUnverified }}
            </p>
          </div>
        </div>

        <ul v-if="stage.warnings.length" class="list-none space-y-1 p-0 text-xs text-warning">
          <li v-for="w in stage.warnings" :key="w">
            {{ warningText(w) }}
          </li>
        </ul>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted" for="runtime-add-label">{{ s.label }}</label>
          <UInput id="runtime-add-label" v-model="label" class="w-full" maxlength="60" />
        </div>

        <label v-if="stage.needsDigestConfirm" class="flex cursor-pointer items-start gap-2 text-sm">
          <input v-model="acceptUnverified" type="checkbox" class="mt-1">
          <span>{{ s.digestConfirm }}</span>
        </label>

        <p v-if="error" class="text-sm text-error" role="alert">
          {{ error }}
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <template v-if="step === 'source'">
          <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
            {{ t.llamacpp.manage.cancel }}
          </UButton>
          <UButton size="sm" icon="i-lucide-search" :disabled="!source" @click="step = 'confirm'">
            {{ s.preview }}
          </UButton>
        </template>
        <template v-else-if="step === 'confirm'">
          <UButton size="sm" color="neutral" variant="ghost" @click="step = 'source'">
            {{ s.back }}
          </UButton>
          <UButton size="sm" icon="i-lucide-play" @click="runPreview">
            {{ s.runConfirm }}
          </UButton>
        </template>
        <template v-else-if="step === 'previewing'">
          <UButton size="sm" color="neutral" variant="outline" @click="stopPreview">
            {{ s.stopPreview }}
          </UButton>
        </template>
        <template v-else>
          <UButton size="sm" color="neutral" variant="ghost" :disabled="step === 'adding'" @click="open = false">
            {{ t.llamacpp.manage.cancel }}
          </UButton>
          <UButton size="sm" icon="i-lucide-plus" :disabled="!canConfirm" :loading="step === 'adding'" @click="confirm">
            {{ step === 'adding' ? s.adding : s.confirm }}
          </UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>
