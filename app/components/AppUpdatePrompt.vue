<script setup lang="ts">
// Only user-requested release details and manual install confirmation open this dialog.
import t from '~~/i18n/zh-CN'

const s = t.appUpdate
const { view, release, open, confirming, busy, install } = useAppUpdate()
const installing = computed(() => view.value?.download.state === 'installing')
const dialogOpen = computed({
  get: () => open.value || confirming.value,
  set: (v: boolean) => {
    if (!v) {
      open.value = false
      confirming.value = false
    }
  },
})
const title = computed(() => {
  if (!release.value) return ''
  return fmt(confirming.value ? s.confirmTitle : s.available, { version: release.value.version })
})
</script>

<template>
  <div>
    <UModal v-model:open="dialogOpen" :title="title" :description="confirming ? s.confirmBody : undefined" :dismissible="!installing">
      <template v-if="!confirming || installing" #body>
        <p v-if="confirming" class="text-sm text-muted">
          {{ s.installing }}
        </p>
        <AppUpdatePanel v-else />
      </template>
      <template v-if="confirming" #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" :disabled="installing" @click="confirming = false">
            {{ s.later }}
          </UButton>
          <UButton size="sm" icon="i-lucide-download" :loading="busy === 'install' || installing" @click="install">
            {{ s.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
