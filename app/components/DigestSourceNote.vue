<script setup lang="ts">
// Small muted note shown next to a download / check status when its SHA-256 came from a mirror
// because the official GitHub metadata could not be read (decision 63). Nothing for GitHub.
import { t } from '../composables/useLocale'

defineProps<{ source?: string | null }>()
</script>

<template>
  <span v-if="source === 'mirror'" class="inline-flex items-center gap-1 text-xs text-muted">
    <UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
    {{ t.mirror.digestFromMirror }}
  </span>
</template>
