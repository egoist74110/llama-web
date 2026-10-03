<script setup lang="ts">
// Confirm deleting a build: shows what the server says would happen (models that chose it fall back
// to "follow", the current version moves) before anything is removed.
import t from '~~/i18n/zh-CN'
import type { DeletePlan, RuntimeRow } from '~~/server/core/runtime-manager'

const props = defineProps<{ row: RuntimeRow | null }>()
const emit = defineEmits<{ close: [], done: [] }>()

const s = t.llamacpp.manage
const ui = usePlatformUi()
const { state } = useLive()
const toast = useToast()

const plan = ref<DeletePlan | null>(null)
const planError = ref('')
const busy = ref(false)
const open = computed({
  get: () => !!props.row,
  set: (v: boolean) => { if (!v) emit('close') },
})
const name = computed(() => (props.row ? runtimeRowLabel(props.row, ui.value.isMac) : ''))

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

watch(() => props.row?.ref, async (ref) => {
  plan.value = null
  planError.value = ''
  if (!ref) return
  try {
    const r = await $fetch<DeletePlan>('/api/llamacpp/delete-plan', { query: { ref } })
    if (props.row?.ref === ref) plan.value = r
  } catch (e) {
    if (props.row?.ref === ref) planError.value = messageOf(e)
  }
}, { immediate: true })

const modelName = (id: string) => state.value?.models.find(m => m.id === id)?.name ?? id
const affectedText = (a: DeletePlan['affected'][number]) => (a.profile === null
  ? fmt(s.removeModelOwn, { model: modelName(a.modelId) })
  : fmt(s.removeProfileOwn, { model: modelName(a.modelId), profile: a.profile }))
const blockedText = computed(() => (plan.value?.blocked === 'latest-official' ? s.removeLatestWhy : plan.value?.blocked === 'in-use' ? s.removeInUseWhy : ''))

async function confirm() {
  const row = props.row
  if (!row || busy.value || !plan.value || plan.value.blocked) return
  busy.value = true
  try {
    await $fetch(`/api/llamacpp/${encodeURIComponent(row.ref)}`, { method: 'DELETE', query: { confirm: '1' } })
    toast.add({ title: fmt(s.removed, { name: name.value }), color: 'success', icon: 'i-lucide-check' })
    emit('done')
    emit('close')
  } catch (e) {
    toast.add({ title: s.removeFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="fmt(s.removeTitle, { name })" :description="s.removeBody">
    <template #body>
      <p v-if="planError" class="text-sm text-error">
        {{ planError }}
      </p>
      <USkeleton v-else-if="!plan" class="h-12 w-full" />
      <div v-else class="space-y-3 text-sm">
        <p v-if="blockedText" class="text-warning">
          {{ blockedText }}
        </p>
        <template v-else>
          <p v-if="plan.isCurrent && plan.becomesCurrent" class="text-muted">
            {{ fmt(s.removeIsCurrent, { next: plan.becomesCurrent }) }}
          </p>
          <div v-if="plan.affected.length" class="space-y-1">
            <p class="text-muted">
              {{ s.removeAffected }}
            </p>
            <ul class="list-disc space-y-0.5 pl-5 text-default">
              <li v-for="(a, i) in plan.affected" :key="i">
                {{ affectedText(a) }}
              </li>
            </ul>
          </div>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" color="error" icon="i-lucide-trash-2" :disabled="!plan || !!plan.blocked" :loading="busy" @click="confirm">
          {{ s.removeConfirm }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
