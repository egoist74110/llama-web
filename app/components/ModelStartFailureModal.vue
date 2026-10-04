<script setup lang="ts">
// Layout-owned so a failed first setup survives the originating dialog/card unmounting.
import t from '~~/i18n/zh-CN'
import { modelStartNoticeView } from '~/utils/model-start-notice'

const s = t.models.startFailure
const feedback = useModelStartFeedback()
feedback.follow()
const { notice } = feedback
const ui = usePlatformUi()
// Keep the last explanation visible while the modal's leave transition runs.
const display = ref(notice.value)
watch(notice, (n) => { if (n) display.value = n })
const open = computed({ get: () => !!notice.value, set: (v) => { if (!v) feedback.dismiss() } })
const view = computed(() => display.value ? modelStartNoticeView(display.value, ui.value.isMac) : null)
const title = computed(() => display.value?.name ? fmt(s.title, { name: display.value.name }) : s.genericTitle)
const editTarget = ref<{ modelId: string, profile?: string } | null>(null)
const editing = ref(false)

async function recover() {
  const n = notice.value
  const v = view.value
  if (!n || !v) return
  if (v.recovery.to) {
    feedback.dismiss()
    await navigateTo(v.recovery.to)
  } else if (n.modelId) {
    editTarget.value = { modelId: n.modelId, profile: n.profile }
    feedback.dismiss()
    editing.value = true
  }
}

async function logs() {
  if (!view.value) return
  const to = view.value.logTo
  feedback.dismiss()
  await navigateTo(to)
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="s.description">
    <template #close="{ ui: modalUi }">
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" :class="modalUi.close()" :aria-label="s.close" />
    </template>
    <template #body>
      <div v-if="display && view" class="space-y-3">
        <p class="m-0 flex items-start gap-2 text-sm font-semibold text-error">
          <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0" />
          {{ view.reason }}
        </p>
        <p v-if="display.profile" class="m-0 text-xs text-muted">{{ fmt(s.profile, { profile: display.profile }) }}</p>
        <p class="m-0 text-sm text-default">{{ view.advice }}</p>
        <p v-if="display.message" class="m-0 whitespace-pre-wrap break-all rounded-lg bg-elevated px-3 py-2 text-xs text-muted">{{ display.message }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="feedback.dismiss()">{{ s.close }}</UButton>
        <UButton v-if="view && view.recovery.to !== view.logTo" size="sm" color="neutral" variant="outline" @click="logs">{{ s.logs }}</UButton>
        <UButton v-if="view" size="sm" @click="recover">{{ view.recovery.label }}</UButton>
      </div>
    </template>
  </UModal>
  <ModelEditor v-if="editTarget" :key="`${editTarget.modelId}:${editTarget.profile}`" v-model:open="editing" :model-id="editTarget.modelId" :initial-profile="editTarget.profile" initial-tab="params" />
</template>
