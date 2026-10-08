<script setup lang="ts">
// One offered llama-web release: title, date, release notes and the download / install actions
// (desktop) or a link to the release page (source version). Used by the prompt and the settings card.
import { t } from '../composables/useLocale'

const props = defineProps<{ compact?: boolean }>()
const s = t.appUpdate
const { view, release, busy, confirming, download, cancel, skip } = useAppUpdate()
const blocks = computed(() => notesBlocks(release.value?.notes ?? ''))
const dl = computed(() => {
  const d = view.value?.download
  return d && d.state !== 'none' && d.version === release.value?.version ? d : null
})
const percent = computed(() => (dl.value?.state === 'downloading' && dl.value.total ? Math.min(100, Math.round(dl.value.received / dl.value.total * 100)) : null))
const progressText = computed(() => {
  const d = dl.value
  if (d?.state !== 'downloading') return ''
  return d.total
    ? fmt(s.downloading, { received: formatBytes(d.received), total: formatBytes(d.total) })
    : fmt(s.downloadingUnknown, { received: formatBytes(d.received) })
})
const date = computed(() => (release.value?.publishedAt ? new Date(release.value.publishedAt).toLocaleDateString('zh-CN') : ''))
const skipped = computed(() => !!release.value && view.value?.skipped === release.value.version)
</script>

<template>
  <div v-if="release && view" class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-medium text-highlighted">{{ release.name || release.version }}</span>
      <UBadge v-if="release.prerelease" color="warning" variant="subtle" size="sm">
        {{ s.prerelease }}
      </UBadge>
      <span v-if="date" class="text-xs text-muted">{{ fmt(s.published, { date }) }}</span>
      <ULink v-if="release.url" :to="release.url" target="_blank" class="text-xs text-primary">
        {{ s.releasePage }}
      </ULink>
    </div>

    <div class="overflow-y-auto rounded-lg border border-default bg-default px-4 py-3" :class="props.compact ? 'max-h-48' : 'max-h-80'">
      <p class="mb-2 text-xs font-medium text-muted">
        {{ s.notesTitle }}
      </p>
      <p v-if="!blocks.length" class="text-sm text-muted">
        {{ s.notesEmpty }}
      </p>
      <template v-for="(b, i) in blocks" :key="i">
        <p v-if="b.kind === 'heading'" class="mt-2 text-sm font-semibold text-highlighted first:mt-0">
          {{ b.text }}
        </p>
        <p v-else-if="b.kind === 'item'" class="flex gap-2 text-sm text-default">
          <span class="text-muted">•</span><span class="min-w-0 break-words">{{ b.text }}</span>
        </p>
        <p v-else class="text-sm text-default">
          {{ b.text }}
        </p>
      </template>
    </div>

    <p v-if="skipped" class="text-xs text-muted">
      {{ s.skippedNote }}
    </p>

    <template v-if="view.canInstall">
      <div v-if="dl?.state === 'downloading'" class="space-y-1">
        <UProgress :model-value="percent" size="sm" />
        <p class="text-xs tabular-nums text-muted">
          {{ progressText }}
        </p>
      </div>
      <p v-else-if="dl?.state === 'ready'" class="text-xs text-success">
        {{ s.ready }}
      </p>
      <p v-else-if="dl?.state === 'installing'" class="text-xs text-muted">
        {{ s.installing }}
      </p>
      <p v-else-if="dl?.state === 'error'" class="text-xs text-error">
        {{ fmt(s.downloadFailed, { reason: appUpdateErrorText(dl.code) }) }}
      </p>
    </template>
    <p v-else class="text-xs text-muted">
      {{ s.sourceHint }}
    </p>

    <div class="flex flex-wrap justify-end gap-2">
      <UButton
        v-if="!skipped"
        size="sm"
        color="neutral"
        variant="ghost"
        :disabled="!!busy || dl?.state === 'installing'"
        @click="skip(release.version)"
      >
        {{ s.skip }}
      </UButton>
      <UButton v-else size="sm" color="neutral" variant="ghost" :disabled="!!busy" @click="skip(null)">
        {{ s.unskip }}
      </UButton>
      <template v-if="view.canInstall">
        <UButton v-if="dl?.state === 'downloading'" size="sm" color="neutral" variant="outline" icon="i-lucide-x" @click="cancel">
          {{ s.cancel }}
        </UButton>
        <UButton v-else-if="dl?.state === 'ready'" size="sm" icon="i-lucide-download" @click="confirming = true">
          {{ s.install }}
        </UButton>
        <UButton
          v-else-if="dl?.state !== 'installing'"
          size="sm"
          icon="i-lucide-download"
          :loading="busy === 'download'"
          @click="download"
        >
          {{ dl?.state === 'error' ? s.retry : s.updateNow }}
        </UButton>
      </template>
      <UButton v-else-if="release.url" size="sm" icon="i-lucide-external-link" :to="release.url" target="_blank">
        {{ s.sourceDownload }}
      </UButton>
    </div>
  </div>
</template>
