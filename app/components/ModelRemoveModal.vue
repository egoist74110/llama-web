<script setup lang="ts">
// Confirm removing a model. By default only the configuration goes; the checkbox (bottom left)
// also moves the model / mmproj / draft files to the system trash. The server says which files
// that would be and which are kept because another model still uses them.
import { t } from '../composables/useLocale'

type PlanFile = { kind: 'model' | 'mmproj' | 'draft', rel: string, action: 'trash' | 'keep-shared' | 'missing', usedBy: string[] }
type Plan = { busy: boolean, unsafe: boolean, files: PlanFile[] }
type Result = { trashed: unknown[], keptShared: unknown[], failed: Array<{ rel: string }> }

const props = defineProps<{ modelId: string, name: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ removed: [] }>()

const s = t.models.remove
const toast = useToast()
const plan = ref<Plan | null>(null)
const planError = ref('')
const withFiles = ref(false)
const busy = ref(false)
const url = computed(() => `/api/models/${encodeURIComponent(props.modelId)}`)

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

watch(open, async (o) => {
  if (!o) return
  withFiles.value = false
  plan.value = null
  planError.value = ''
  try {
    plan.value = await $fetch<Plan>(`${url.value}/remove-plan`)
  } catch (e) {
    planError.value = messageOf(e)
  }
}, { immediate: true })

const group = (action: PlanFile['action']) => plan.value?.files.filter(f => f.action === action) ?? []
const canDeleteFiles = computed(() => !!plan.value && !plan.value.unsafe)
const blocked = computed(() => !plan.value || plan.value.busy)

async function confirm() {
  if (busy.value || blocked.value) return
  busy.value = true
  try {
    const r = await $fetch<Result>(`${url.value}/remove`, { method: 'POST', body: { deleteFiles: withFiles.value && canDeleteFiles.value } })
    const title = withFiles.value ? fmt(s.doneFiles, { name: props.name, count: String(r.trashed.length) }) : fmt(s.done, { name: props.name })
    const notes = []
    if (r.keptShared.length) notes.push(fmt(s.keptNote, { count: String(r.keptShared.length) }))
    if (r.failed.length) notes.push(fmt(s.failedNote, { files: r.failed.map(f => f.rel).join('、') }))
    toast.add({ title, description: notes.join(' ') || undefined, color: r.failed.length ? 'warning' : 'success', icon: 'i-lucide-check' })
    emit('removed')
    open.value = false
  } catch (e) {
    toast.add({ title: s.failed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="fmt(s.title, { name })" :description="s.body">
    <template #body>
      <p v-if="planError" class="text-sm text-error">
        {{ s.planFailed }}：{{ planError }}
      </p>
      <USkeleton v-else-if="!plan" class="h-12 w-full" />
      <div v-else class="space-y-3 text-sm">
        <p v-if="plan.busy" class="m-0 text-warning">
          {{ s.busy }}
        </p>
        <p v-else-if="plan.unsafe" class="m-0 text-warning">
          {{ s.unsafe }}
        </p>
        <template v-else-if="withFiles">
          <div v-if="group('trash').length" class="space-y-1">
            <p class="m-0 text-muted">
              {{ s.willTrash }}
            </p>
            <ul class="m-0 list-disc space-y-0.5 pl-5 font-mono text-xs break-all">
              <li v-for="f in group('trash')" :key="f.rel">
                [{{ s.kind[f.kind] }}] {{ f.rel }}
              </li>
            </ul>
          </div>
          <div v-if="group('keep-shared').length" class="space-y-1">
            <ul class="m-0 list-disc space-y-0.5 pl-5 text-xs break-all text-warning">
              <li v-for="f in group('keep-shared')" :key="f.rel">
                {{ fmt(s.keepShared, { by: f.usedBy.join('、') }) }}<span class="font-mono">[{{ s.kind[f.kind] }}] {{ f.rel }}</span>
              </li>
            </ul>
          </div>
          <p v-if="group('missing').length" class="m-0 text-xs text-dimmed">
            {{ s.missingFile }}{{ group('missing').map(f => f.rel).join('、') }}
          </p>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5">
          <UCheckbox v-model="withFiles" :label="s.deleteFiles" :disabled="!canDeleteFiles || busy" />
          <span class="pl-6 text-xs text-dimmed">{{ s.deleteFilesHint }}</span>
        </div>
        <div class="flex shrink-0 gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
            {{ s.cancel }}
          </UButton>
          <UButton size="sm" color="error" icon="i-lucide-trash-2" :disabled="blocked" :loading="busy" @click="confirm">
            {{ withFiles ? s.confirmFiles : s.confirm }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
