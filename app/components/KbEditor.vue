<script setup lang="ts">
// Create or edit a knowledge base: name, description and the chunk settings (they only apply to documents added later).
import { t } from '../composables/useLocale'
import type { KbView } from '~~/server/core/kb/manager'
import { KB_DEFAULT_CHUNK_OVERLAP, KB_DEFAULT_CHUNK_SIZE } from '~/utils/kb'

const props = defineProps<{ kb: KbView | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [kb: KbView, created: boolean] }>()

const s = t.kb.page.form
const toast = useToast()
const form = reactive({ name: '', description: '', chunkSize: String(KB_DEFAULT_CHUNK_SIZE), chunkOverlap: String(KB_DEFAULT_CHUNK_OVERLAP) })
const saving = ref(false)

watch(open, (o) => {
  if (!o) return
  const k = props.kb
  Object.assign(form, {
    name: k?.name ?? '',
    description: k?.description ?? '',
    chunkSize: String(k?.chunkSize ?? KB_DEFAULT_CHUNK_SIZE),
    chunkOverlap: String(k?.chunkOverlap ?? KB_DEFAULT_CHUNK_OVERLAP),
  })
})

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN)
const canSave = computed(() => !!form.name.trim() && Number.isFinite(num(form.chunkSize)) && Number.isFinite(num(form.chunkOverlap)))

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const body = { name: form.name.trim(), description: form.description.trim(), chunkSize: num(form.chunkSize), chunkOverlap: num(form.chunkOverlap) }
    const created = !props.kb
    const kb = created
      ? await $fetch<KbView>('/api/kb', { method: 'POST', body })
      : await $fetch<KbView>(`/api/kb/${encodeURIComponent(props.kb!.id)}`, { method: 'PATCH', body })
    toast.add({ title: created ? fmt(s.created, { name: kb.name }) : s.saved, color: 'success', icon: 'i-lucide-check' })
    emit('saved', kb, created)
    open.value = false
  } catch (e) {
    toast.add({ title: s.saveFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="kb ? s.editTitle : s.createTitle">
    <template #body>
      <form class="flex flex-col gap-3.5" @submit.prevent="save">
        <label class="flex flex-col gap-1">
          <span class="text-sm">{{ s.name }}</span>
          <UInput v-model="form.name" class="w-full" :placeholder="s.namePlaceholder" maxlength="80" autofocus />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm">{{ s.description }}</span>
          <UTextarea v-model="form.description" class="w-full" :rows="2" maxlength="500" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-sm">{{ s.chunkSize }}</span>
            <UInput v-model="form.chunkSize" type="number" class="w-full" />
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-sm">{{ s.chunkOverlap }}</span>
            <UInput v-model="form.chunkOverlap" type="number" class="w-full" />
          </label>
        </div>
        <p class="m-0 text-xs text-muted">
          {{ fmt(s.chunkHint, { size: KB_DEFAULT_CHUNK_SIZE, overlap: KB_DEFAULT_CHUNK_OVERLAP }) }}
        </p>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" :disabled="!canSave" :loading="saving" @click="save">
          {{ kb ? s.save : s.create }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
