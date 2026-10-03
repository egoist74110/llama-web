<script setup lang="ts">
// About and updates of llama-web itself: version, manual check, the offered release (notes +
// actions, see AppUpdatePanel) and the automatic install switch. State from the live snapshot.
import t from '~~/i18n/zh-CN'

const s = t.appUpdate
const { view, release, busy, check, setAutoUpdate } = useAppUpdate()
const time = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false })
const status = computed(() => {
  const c = view.value?.check
  if (!c || c.state === 'idle') return s.never
  if (c.state === 'checking') return s.checking
  if (c.state === 'latest') return fmt(s.latest, { time: time(c.at) })
  if (c.state === 'error') return fmt(s.error, { reason: appUpdateErrorText(c.code), time: time(c.at) })
  return fmt(s.available, { version: c.release.version })
})
const isPre = computed(() => (view.value?.current ?? '').includes('-'))
const working = computed(() => view.value?.download.state === 'downloading' || view.value?.download.state === 'installing')
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div v-if="view" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-muted">{{ s.current }}</span>
          <span class="font-mono text-highlighted">v{{ view.current }}</span>
          <ULink v-if="release" to="#app-update" class="text-xs text-primary">{{ fmt(s.inlineAvailable, { version: release.version }) }}</ULink>
          <UBadge v-if="isPre" color="warning" variant="subtle" size="sm">
            {{ s.prerelease }}
          </UBadge>
          <ULink :to="view.releasesUrl" target="_blank" class="text-xs text-primary">
            {{ s.allReleases }}
          </ULink>
        </div>
      </div>
      <p class="text-sm" :class="view.check.state === 'error' ? 'text-error' : view.check.state === 'available' ? 'text-primary' : 'text-muted'">
        {{ status }}
      </p>
      <AppUpdatePanel v-if="release" id="app-update" compact />
      <div class="flex flex-wrap items-start justify-between gap-4 border-t border-default pt-3">
        <div>
          <p class="text-sm text-default">
            {{ s.autoUpdate }}
          </p>
          <p class="text-xs text-muted">
            {{ s.autoUpdateHint }}
          </p>
        </div>
        <div class="flex items-center gap-3">
          <USwitch :model-value="view.autoUpdate" :disabled="busy === 'prefs' || busy === 'install'" :aria-label="s.autoUpdate" @update:model-value="setAutoUpdate" />
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="busy === 'check' || view.check.state === 'checking'" :disabled="working" @click="check">{{ s.check }}</UButton>
        </div>
      </div>
    </div>
    <USkeleton v-else class="h-20 w-full" />
  </AppCard>
</template>
