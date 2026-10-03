<script setup lang="ts">
// Mounted once in the layout: a slim banner while a newer llama-web is available (and not
// skipped), the release dialog (opens by itself once per version and visit, or from the
// banner), and the install confirmation (asked from here or from the settings card).
import t from '~~/i18n/zh-CN'

const s = t.appUpdate
const { view, release, open, confirming, busy, install } = useAppUpdate()
const offered = computed(() => (release.value && view.value?.skipped !== release.value.version ? release.value : null))
const installing = computed(() => view.value?.download.state === 'installing')
const shown = useState<string | null>('app-update-shown', () => null)
// Banner closed for this visit (the dialog and the settings card still offer the update).
const hidden = useState<string | null>('app-update-banner-hidden', () => null)
watch(() => offered.value?.version, (v) => {
  if (v && shown.value !== v) {
    shown.value = v
    open.value = true
  }
}, { immediate: true })
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
    <div v-if="offered && hidden !== offered.version" class="lw-card flex flex-wrap items-center gap-3 py-2.5 pl-4 pr-3">
      <span class="lw-chip lw-chip-accent">{{ s.chip }}</span>
      <span class="min-w-[200px] flex-1 text-[13px]">{{ fmt(s.banner, { version: offered.version }) }}</span>
      <UButton size="sm" color="neutral" variant="outline" @click="open = true">
        {{ s.view }}
      </UButton>
      <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t.layout.dismiss" @click="hidden = offered.version" />
    </div>

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
