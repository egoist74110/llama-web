<script setup lang="ts">
// Usage guide of the selected knowledge base (decision 69): the text external agents and the chat tools read before
// they write. Default = follows the interface language; custom = the user's own text. The `rev` of the effective text
// is what a writer has to send back, so a changed guide makes them read it again.
import { t } from '../composables/useLocale'
import type { GuideView, KbView } from '~~/server/core/kb/manager'
import { KB_MAX_GUIDE } from '~/utils/kb'

const props = defineProps<{ kb: KbView }>()

const s = t.kb.page.guide
const toast = useToast()

const guide = ref<GuideView | null>(null)
const text = ref('')
const baseline = ref('')
const saving = ref(false)
const loadError = ref('')

let seq = 0
async function load() {
  const my = ++seq
  try {
    const r = await $fetch<GuideView>(`/api/kb/${encodeURIComponent(props.kb.id)}/guide`)
    if (my !== seq) return
    guide.value = r
    // A default guide is shown in full as the starting point of an edit.
    text.value = r.isDefault ? r.guide : r.custom
    baseline.value = text.value
    loadError.value = ''
  } catch (e) {
    if (my === seq) loadError.value = messageOf(e)
  }
}
watch(() => props.kb.id, () => { guide.value = null; void load() }, { immediate: true })

const dirty = computed(() => text.value !== baseline.value)
const over = computed(() => text.value.length > KB_MAX_GUIDE)
const canSave = computed(() => dirty.value && !over.value && text.value.trim() !== '' && !saving.value)

async function patch(value: string): Promise<boolean> {
  try {
    await $fetch(`/api/kb/${encodeURIComponent(props.kb.id)}`, { method: 'PATCH', body: { guide: value } })
    await load()
    return true
  } catch (e) {
    toast.add({ title: value === '' ? s.resetFailed : s.saveFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    return false
  }
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    // Text identical to the default is kept as "default", so it keeps following the interface language.
    if (await patch(text.value === t.kb.defaultGuide ? '' : text.value)) toast.add({ title: s.saved, color: 'success', icon: 'i-lucide-check' })
  } finally {
    saving.value = false
  }
}

const resetOpen = ref(false)
const resetBusy = ref(false)
async function reset() {
  if (resetBusy.value) return
  resetBusy.value = true
  try {
    if (await patch('')) {
      toast.add({ title: s.resetDone, color: 'success', icon: 'i-lucide-check' })
      resetOpen.value = false
    }
  } finally {
    resetBusy.value = false
  }
}
</script>

<template>
  <AppCard :title="fmt(s.titleOf, { name: kb.name })" :hint="s.intro">
    <p v-if="loadError" class="m-0 break-words text-sm text-error">
      {{ t.kb.page.guide.loadFailed }}<span class="ml-2 text-xs text-muted">{{ loadError }}</span>
    </p>
    <div v-else-if="!guide" class="flex flex-col gap-2">
      <USkeleton class="h-6 w-1/2" />
      <USkeleton class="h-32 w-full" />
    </div>
    <div v-else class="flex min-w-0 flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="lw-chip" :class="{ 'lw-chip-accent': !guide.isDefault }">{{ guide.isDefault ? s.isDefault : s.isCustom }}</span>
        <span class="lw-num font-mono text-xs text-dimmed">{{ fmt(s.rev, { rev: guide.rev }) }}</span>
      </div>
      <p class="m-0 text-xs text-muted">
        {{ s.revHint }}
      </p>
      <p class="m-0 text-xs text-muted">
        {{ s.langHint }}
      </p>

      <div class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-2">
          <label for="kb-guide-text" class="text-[13px] font-medium">{{ s.text }}</label>
          <span class="lw-num text-xs" :class="over ? 'text-error' : 'text-dimmed'">{{ fmt(s.count, { n: text.length, max: KB_MAX_GUIDE }) }}</span>
        </div>
        <UTextarea id="kb-guide-text" v-model="text" class="w-full" autoresize :rows="10" :maxrows="30" :color="over ? 'error' : undefined" />
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <UButton size="sm" icon="i-lucide-save" :loading="saving" :disabled="!canSave" @click="save">
          {{ s.save }}
        </UButton>
        <span v-if="dirty" class="text-xs text-warning">{{ s.unsaved }}</span>
        <UButton v-if="!guide.isDefault" class="ml-auto" size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" @click="resetOpen = true">
          {{ s.reset }}
        </UButton>
      </div>
    </div>

    <KbConfirm
      v-model:open="resetOpen"
      tone="neutral"
      :title="s.resetTitle"
      :body="s.resetBody"
      :confirm-label="s.resetConfirm"
      :cancel-label="t.kb.page.remove.cancel"
      :busy="resetBusy"
      @confirm="reset"
    />
  </AppCard>
</template>
